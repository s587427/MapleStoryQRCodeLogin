// Client-integrity triple (`CV` / `Hash` / `arch`) that beanfun's TW OTP
// endpoint has required since Gamania Games Manager (GGM) 1.5.x.
//
// Converted from the Rust module documented for issue #368. See that
// module's doc comment for the full background (BuildOtpUrl contract, the
// CV/Hash/arch table, why this is deliberately all-or-nothing and
// deliberately uncached). Kept here only where it affects a specific
// function below.
//
// Two pieces of the original are Windows-native APIs with no Node.js
// built-in equivalent — flagged inline where they appear:
//   - reading a PE file's Win32 version resource (`file_version`)
//   - reading HKCR from the registry (`ggm_dir_from_protocol_handler`)
//
// Dependencies this file assumes you add:
//   npm install winreg
//   npm install -D @types/winreg

import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { promisify } from "node:util"
import Registry from "winreg"
import { PublishedValues } from "./GgmHotfix"

// `PublishedValues` (Rust: `crate::services::beanfun::ggm_hotfix::PublishedValues`)
// is defined by the `ggm_hotfix` module, not this one — Rust's
// `from_published` takes it by reference from there.

const execFileAsync = promisify(execFile)

/** From Rust: `GGM_DLL_NAME` */
const GGM_DLL_NAME = "GGMWebStart.dll"

/** From Rust: `FALLBACK_CV` */
const FALLBACK_CV = "1.5.0.2"

/** From Rust: `FALLBACK_HASH` */
const FALLBACK_HASH =
  "dfd568a69d87abcd8f4a93d1a4481ebb57712d1d28ab0b6fc018fcf140101e06"

/**
 * From Rust: `ARCH` (the `#[cfg(target_pointer_width = "64")]` constant).
 *
 * The Rust version reflects the *compiled binary's* pointer width. Node
 * has no build-time equivalent, so this reads `process.arch` of the
 * running process instead — the closest analog to GGM's own
 * `Environment.Is64BitProcess`.
 */
const ARCH: "x64" | "x86" = process.arch === "x64" ? "x64" : "x86"

/**
 * From Rust: `struct ClientIntegrity` + its `impl` block.
 *
 * The `CV` / `Hash` / `arch` triple appended to the TW OTP request.
 * Values are stored raw (un-encoded); percent-encoding is the URL
 * builder's job so this type stays a plain description of the client.
 */
export class ClientIntegrity {
  constructor(
    /** GGM assembly version, e.g. `"1.5.0.2"`. */
    public readonly cv: string,
    /** Lowercase-hex SHA-256 of `GGMWebStart.dll`. */
    public readonly hash: string,
    /** `"x64"` or `"x86"`. */
    public readonly arch: "x64" | "x86"
  ) {}

  /** From Rust: `ClientIntegrity::fallback` */
  static fallback(): ClientIntegrity {
    return new ClientIntegrity(FALLBACK_CV, FALLBACK_HASH, ARCH)
  }

  /**
   * From Rust: `ClientIntegrity::resolve`
   *
   * Describe the locally installed GGM, falling back to the bundled
   * constants when it cannot be found or fully inspected. Never throws:
   * the OTP request needs *some* triple, and a stale-but-plausible one
   * gives the server a chance to accept where an absent one is
   * guaranteed to be rejected.
   */
  static async resolve(): Promise<ClientIntegrity> {
    const found = await ClientIntegrity.resolveLocal()
    if (found !== undefined) {
      return found
    }
    console.debug(
      `no inspectable ${GGM_DLL_NAME}; using bundled client-integrity constants`
    )
    return ClientIntegrity.fallback()
  }

  /**
   * From Rust: `ClientIntegrity::resolve_local`
   *
   * The installed GGM's values, or `undefined` when there is no GGM to
   * read. Split out from `resolve` so the caller can try the published
   * values in between rather than dropping straight to the compiled-in
   * pair.
   */
  static async resolveLocal(): Promise<ClientIntegrity | undefined> {
    const dllPath = await locateGgmDll()
    if (dllPath === undefined) return undefined
    return ClientIntegrity.fromGgmDll(dllPath)
  }

  /**
   * From Rust: `ClientIntegrity::from_published`
   *
   * Build the triple from a `CV` / `Hash` pair someone published or
   * pinned. `arch` is never published: it describes the binary asking,
   * which is this build, not whatever machine produced the values.
   */
  static fromPublished(values: PublishedValues): ClientIntegrity {
    return new ClientIntegrity(values.cv, values.hash, ARCH)
  }

  /**
   * From Rust: `ClientIntegrity::from_ggm_dll`
   *
   * Build the triple from a specific `GGMWebStart.dll`. `undefined`
   * when the file cannot be hashed *or* its version cannot be read, so
   * callers never assemble a half-local pair.
   */
  private static async fromGgmDll(
    filePath: string
  ): Promise<ClientIntegrity | undefined> {
    const hash = await sha256LowerHex(filePath)
    if (hash === undefined) return undefined
    const cv = await fileVersion(filePath)
    if (cv === undefined) return undefined
    console.debug(
      `resolved client integrity from local GGM (cv=${cv}, path=${filePath})`
    )
    return new ClientIntegrity(cv, hash, ARCH)
  }
}

/**
 * From Rust: `sha256_lower_hex`
 *
 * Hash `filePath` into the lowercase-hex form GGM produces with
 * `b.ToString("x2")`.
 */
async function sha256LowerHex(filePath: string): Promise<string | undefined> {
  try {
    const bytes = await fs.readFile(filePath)
    return createHash("sha256").update(bytes).digest("hex")
  } catch {
    return undefined
  }
}

/**
 * From Rust: `locate_ggm_dll`
 *
 * Locate the installed `GGMWebStart.dll`, if any.
 */
async function locateGgmDll(): Promise<string | undefined> {
  for (const dir of await ggmDirectories()) {
    const candidate = path.join(dir, GGM_DLL_NAME)
    try {
      const stat = await fs.stat(candidate)
      if (stat.isFile()) return candidate
    } catch {
      // not there — try the next candidate
    }
  }
  return undefined
}

/**
 * From Rust: `ggm_directories` (both the `#[cfg(target_os = "windows")]`
 * and the non-Windows fallback variant, merged into one runtime check
 * since TS has no compile-time `cfg` equivalent).
 *
 * Candidate GGM install directories, most authoritative first.
 */
async function ggmDirectories(): Promise<string[]> {
  if (process.platform !== "win32") {
    // GGM is a Windows-only product; every non-Windows host takes the
    // bundled-constant path.
    return []
  }

  const dirs: string[] = []

  const fromHandler = await ggmDirFromProtocolHandler()
  if (fromHandler !== undefined) {
    dirs.push(fromHandler)
  }

  // The installer's default location, per architecture-specific
  // Program Files root. Covers a registry that has been cleaned up (or
  // a hand-copied install) while the files are still in place.
  for (const envVar of ["ProgramFiles", "ProgramFiles(x86)"]) {
    const root = process.env[envVar]
    if (root) {
      dirs.push(path.join(root, "gamania Games", "gamania Games Manager"))
    }
  }

  return dirs
}

/**
 * From Rust: `ggm_dir_from_protocol_handler`
 *
 * Read the directory of the executable registered for `gamaniagames://`.
 *
 * The GGM installer writes
 * `HKCR\gamaniagames\shell\open\command` = `"<dir>\GGMWebStart.exe" "%1"`,
 * which tracks the real install location even when the user chose a
 * non-default path.
 *
 * NOTE: no Node.js built-in reads the registry. This uses the `winreg`
 * npm package as the closest equivalent to Rust's `winreg` crate call.
 */
async function ggmDirFromProtocolHandler(): Promise<string | undefined> {
  const key = new Registry({
    hive: Registry.HKCR,
    key: "\\gamaniagames\\shell\\open\\command",
  })

  const command: string | undefined = await new Promise((resolve) => {
    key.values(
      (err: Error | null, items: { name: string; value: string }[]) => {
        if (err) {
          resolve(undefined)
          return
        }
        // The default value of a registry key is named "" (empty string).
        const defaultValue = items.find((item) => item.name === "")
        resolve(defaultValue?.value)
      }
    )
  })

  if (command === undefined) return undefined

  const exe = handlerExecutable(command)
  if (exe === undefined) return undefined
  return path.dirname(exe)
}

/**
 * From Rust: `handler_executable`
 *
 * Extract just the executable path from a registry handler command line.
 *
 * Handles both the quoted form the GGM installer writes
 * (`"C:\…\GGMWebStart.exe" "%1"`) and a bare unquoted path. Deliberately
 * stops at the executable: we only want its directory, never an argument
 * vector, so there is no `%1` substitution to perform.
 */
function handlerExecutable(command: string): string | undefined {
  const trimmed = command.trim()

  let exe: string | undefined
  if (trimmed.startsWith('"')) {
    const rest = trimmed.slice(1)
    const closingQuote = rest.indexOf('"')
    exe = closingQuote === -1 ? undefined : rest.slice(0, closingQuote)
  } else {
    exe = trimmed.split(/\s+/)[0]
  }

  return exe && exe.length > 0 ? exe : undefined
}

/**
 * From Rust: `file_version` (both the `#[cfg(target_os = "windows")]`
 * implementation using `GetFileVersionInfoW`/`VerQueryValueW`, and the
 * non-Windows stub that returns `None`).
 *
 * Read the file's `FileVersion` as `a.b.c.d`.
 *
 * GGM sends its **assembly** version, which the original Rust code notes
 * is usually identical to the Win32 `FileVersion` resource for every
 * shipped GGM build observed so far. Node has no built-in API for
 * reading a PE version resource (the `windows`/`VS_FIXEDFILEINFO` calls
 * in the Rust version), so this shells out to PowerShell's
 * `Get-Item … .VersionInfo.FileVersion`, which reads the same resource.
 * If you'd rather avoid shelling out, an npm package like
 * `win-version-info` wraps the same Win32 API directly — let me know if
 * you want that swapped in instead.
 */
async function fileVersion(filePath: string): Promise<string | undefined> {
  if (process.platform !== "win32") {
    return undefined
  }
  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-Item -LiteralPath '${filePath.replace(/'/g, "''")}').VersionInfo.FileVersion`,
    ])
    const version = stdout.trim()
    return version.length > 0 ? version : undefined
  } catch {
    return undefined
  }
}
