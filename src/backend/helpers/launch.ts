import { createDecipheriv } from "node:crypto"

// ============================================================
// 錯誤型別（對應 LaunchDataError enum，訊息文字照 #[error(...)] 對齊）
// ============================================================

export class LaunchDataError extends Error {}

export class EmptyError extends LaunchDataError {
  constructor() {
    super("launch data is empty")
  }
}

export class BadSelectorError extends LaunchDataError {
  constructor(public readonly ch: string) {
    super(
      `launch data does not start with a hex digit, got ${JSON.stringify(ch)}`
    )
  }
}

export class UnmappableCharError extends LaunchDataError {
  constructor(
    public readonly ch: string,
    public readonly tableIndex: number
  ) {
    super(
      `launch data contains ${JSON.stringify(ch)}, which is absent from substitution table ${tableIndex}`
    )
  }
}

export class TooShortError extends LaunchDataError {
  constructor(
    public readonly offset: number,
    public readonly len: number
  ) {
    super(
      `launch data is too short to hold a key at offset ${offset} (have ${len} characters)`
    )
  }
}

export class DecryptError extends LaunchDataError {
  constructor(cause: string) {
    super(`DES decryption of launch data failed: ${cause}`)
  }
}

export class MissingTicketError extends LaunchDataError {
  constructor() {
    super(
      "decrypted launch data carries neither a LaunchTicket nor a ppppp payload"
    )
  }
}

export class MalformedTicketError extends LaunchDataError {
  constructor(public readonly ticket: string) {
    super("LaunchTicket field is present but empty")
  }
}

// ============================================================
// 常數
// ============================================================

// KEY_LEN 未在你貼的片段中出現，但從先前 decrypt_otp_payload 的
// "8-char key + hex ciphertext" 結構一致推得：DES key 固定 8 bytes。
// 若原始碼裡 KEY_LEN 不是 8，請告知實際值。
const KEY_LEN = 8

export const TABLES: readonly string[] = [
  "bac987d65e432f10",
  "3bc4d5e6f2a79108",
  "cdbeaf9012456378",
  "4e6fb81a3c5d7092",
  "bdef1246789ac530",
  "5f82cb4093e71d6a",
  "df1468ace0357b92",
  "b50c61a4f93e82d7",
]

// ============================================================
// decrypt_hex：對應之前聊過的 DES-ECB / no padding / trim \0
// （decode_with 跟 decrypt_otp_payload 共用同一套底層解密邏輯）
// ============================================================

function decryptHex(cipherHex: string, key: string): string {
  let cipherBuf: Buffer
  try {
    cipherBuf = Buffer.from(cipherHex, "hex")
  } catch (e) {
    throw new DecryptError(`invalid hex: ${String(e)}`)
  }

  // hex 字串長度必須是偶數，且解出來的 bytes 必須是 8 的倍數（DES block size）
  if (
    cipherHex.length % 2 !== 0 ||
    cipherBuf.length % 8 !== 0 ||
    cipherBuf.length === 0
  ) {
    throw new DecryptError(
      `ciphertext length ${cipherBuf.length} is not a nonzero multiple of the DES block size`
    )
  }

  try {
    const decipher = createDecipheriv(
      "des-ecb",
      Buffer.from(key, "ascii"),
      null
    )
    decipher.setAutoPadding(false)
    const plain = Buffer.concat([decipher.update(cipherBuf), decipher.final()])
    // 等價於 Rust trim_matches('\0')：只去頭尾的 NUL
    return plain.toString("utf8").replace(/^\0+|\0+$/g, "")
  } catch (e) {
    throw new DecryptError(String(e instanceof Error ? e.message : e))
  }
}

// ============================================================
// decode_with
// ============================================================

function decodeWith(
  body: string,
  selector: number,
  tableIndex: number
): string {
  const table = TABLES[tableIndex]
  const chars = Array.from(body)

  let normalized = ""
  for (const c of chars) {
    const idx = table.indexOf(c)
    if (idx === -1) {
      throw new UnmappableCharError(c, tableIndex)
    }
    // idx < 16 一定能轉成單一 hex digit（對應 char::from_digit(idx, 16)）
    normalized += idx.toString(16)
  }

  const offset = selector + 1
  if (normalized.length < offset + KEY_LEN) {
    throw new TooShortError(offset, normalized.length)
  }

  const key = normalized.slice(offset, offset + KEY_LEN)
  const cipherHex =
    normalized.slice(0, offset) + normalized.slice(offset + KEY_LEN)

  const plaintext = decryptHex(cipherHex, key)
  return plaintext.replace(/^\0+|\0+$/g, "")
}

// ============================================================
// decode（頂層，含 8-table 嘗試邏輯）
// ============================================================

function decode(data: string): string {
  const chars = Array.from(data)

  const selectorChar = chars[0]
  if (selectorChar === undefined) {
    throw new EmptyError()
  }

  const selector = parseInt(selectorChar, 16)
  if (Number.isNaN(selector)) {
    throw new BadSelectorError(selectorChar)
  }

  const rest = chars.slice(1).join("")

  const order: number[] = [selector % 4, selector % TABLES.length]
  for (let i = 0; i < TABLES.length; i++) {
    order.push(i)
  }

  const tried: number[] = []
  let firstError: LaunchDataError | undefined

  for (const tableIndex of order) {
    if (tried.includes(tableIndex)) {
      continue
    }
    tried.push(tableIndex)

    let plaintext: string
    try {
      plaintext = decodeWith(rest, selector, tableIndex)
    } catch (e) {
      if (firstError === undefined && e instanceof LaunchDataError) {
        firstError = e
      }
      continue
    }

    if (plaintext.includes("LaunchTicket=") || plaintext.includes("ppppp=")) {
      console.debug(
        `launch data table: selector=${selector}, table=${tableIndex}`
      )
      return plaintext
    }
    // 解出東西但不是我們要的 payload -> 當作 wrong table，繼續下一個
  }

  throw firstError ?? new MissingTicketError()
}

// ============================================================
// parse_fields
// ============================================================

function parseFields(plaintext: string): Array<[string, string]> {
  const firstSegment = plaintext.split(";")[0] ?? ""
  return firstSegment
    .split("&")
    .filter((segment) => segment.length > 0)
    .map((pair): [string, string] | null => {
      const idx = pair.indexOf("=")
      if (idx === -1) return null
      return [pair.slice(0, idx), pair.slice(idx + 1)]
    })
    .filter((p): p is [string, string] => p !== null)
}

// ============================================================
// LaunchPayload / LegacyOtpParams
// ============================================================

export interface LegacyOtpParams {
  ppppp: string
  serviceCode: string
  serviceRegion: string
  serviceAccount: string
  createTime: string
}

export type LaunchPayload =
  | { kind: "ticket"; ticket: string }
  | { kind: "legacy"; params: LegacyOtpParams }

// ============================================================
// decode_launch_data
// ============================================================

export function decodeLaunchData(data: string): LaunchPayload {
  const plaintext = decode(data)
  const fields = parseFields(plaintext)

  const field = (name: string): string | undefined =>
    fields.find(([k]) => k === name)?.[1]

  const ticket = field("LaunchTicket")
  if (ticket !== undefined) {
    if (ticket.length === 0) {
      throw new MalformedTicketError(ticket)
    }
    return { kind: "ticket", ticket }
  }

  const ppppp = field("ppppp")
  const serviceCode = field("ServiceCode")
  const serviceRegion = field("ServiceRegion")
  const serviceAccount = field("ServiceAccount")
  const createTime = field("CreateTime")

  if (
    ppppp !== undefined &&
    serviceCode !== undefined &&
    serviceRegion !== undefined &&
    serviceAccount !== undefined &&
    createTime !== undefined
  ) {
    return {
      kind: "legacy",
      params: { ppppp, serviceCode, serviceRegion, serviceAccount, createTime },
    }
  }

  throw new MissingTicketError()
}
