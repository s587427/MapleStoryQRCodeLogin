// Where the client-integrity values come from, newest source first.
//
// beanfun's TW credential endpoint asks the caller to state which build
// of the Gamania Games Manager is asking: a version, and the SHA-256 of
// one of its files. Both are constants for a given GGM release, so we
// ship a known-good pair — but the day beanfun requires a newer one,
// that pair stops working **for everyone at once**, and only for the
// users who have no GGM installed to read real values from.
//
// Answering that with an emergency release means every affected user
// has to notice, download and install one, while unable to play. So the
// values are looked up in order:
//
// 1. a `ggm-client.json` the user pinned themselves — an explicit
//    choice, so nothing overrides it;
// 2. the GGM installed on this machine, which follows its own updates;
// 3. a small file published alongside the app, cached here — one commit
//    fixes every user without them doing anything;
// 4. the pair compiled in, so a machine with none of the above works.
//
// Layer 3 is the hotfix lever. See `docs/GGM-CLIENT-HOTFIX.md` for the
// runbook, including how to tell this failure apart from the ones that
// need a code change instead.
//
// # Failing quietly is the point
//
// Every step here is best-effort. A fetch that times out, a file that
// will not parse, a value that fails validation — each falls through to
// the next source rather than surfacing. The alternative is a network
// hiccup costing someone their password when a perfectly good compiled
// -in pair was sitting right there.
//
// Converted from Rust's `ggm_hotfix` module (a free-function module, no
// struct) into a class of static methods, to match `ClientIntegrity`'s
// style in this codebase. `CACHE_DIR` (Rust: `static CACHE_DIR: OnceLock`)
// becomes a private static field with a set-once guard, since TS has no
// `OnceLock` built-in.

import * as fs from "node:fs/promises"
import * as path from "node:path"

/** From Rust: `HOTFIX_URLS` */
const HOTFIX_URLS: readonly string[] = [
  "https://raw.githubusercontent.com/pungin/Beanfun/code/ggm-client.json",
  "https://cdn.jsdelivr.net/gh/pungin/Beanfun@code/ggm-client.json",
  "https://fastly.jsdelivr.net/gh/pungin/Beanfun@code/ggm-client.json",
  "https://ghproxy.net/https://raw.githubusercontent.com/pungin/Beanfun/code/ggm-client.json",
]

/** From Rust: `CACHE_FILE` */
const CACHE_FILE = "ggm-client.json"

/** From Rust: `CACHE_TTL` (`Duration::from_secs(6 * 60 * 60)`) */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000

/** From Rust: `FETCH_TIMEOUT` (`Duration::from_secs(5)`) */
const FETCH_TIMEOUT_MS = 5 * 1000

/** From Rust: the `PublishedValues` struct. */
export interface PublishedValues {
  cv: string
  hash: string
}

/**
 * From Rust: the `ggm_hotfix` module's free functions, grouped into a
 * class of static methods.
 */
export class GgmHotfix {
  /** From Rust: `static CACHE_DIR: OnceLock<PathBuf>` */
  private static cacheDir: string | undefined

  /**
   * From Rust: `set_cache_dir`
   *
   * Record where the cached file lives (the storage root). Called once
   * during boot. Without it every layer here is skipped and resolution
   * falls through to the installed GGM or the compiled-in pair, which
   * is the pre-hotfix behaviour — degraded, never broken.
   *
   * Mirrors `OnceLock::set`'s ignore-after-first-write semantics: once
   * set, later calls are no-ops rather than overwriting it.
   */
  static setCacheDir(dir: string): void {
    if (GgmHotfix.cacheDir === undefined) {
      GgmHotfix.cacheDir = dir
    }
  }

  /** From Rust: `cache_path` */
  private static cachePath(): string | undefined {
    if (GgmHotfix.cacheDir === undefined) return undefined
    return path.join(GgmHotfix.cacheDir, CACHE_FILE)
  }

  /**
   * From Rust: `pinned`
   *
   * Values the user pinned themselves, if any.
   *
   * Told apart by an `override` flag rather than by living somewhere
   * else: editing the fetched file in place is then all it takes to
   * pin values — no second path to explain, and no way to "fix" the
   * file and have the next fetch quietly undo you.
   */
  static async pinned(): Promise<PublishedValues | undefined> {
    const cachePath = GgmHotfix.cachePath()
    if (cachePath === undefined) return undefined

    let body: string
    try {
      body = await fs.readFile(cachePath, "utf8")
    } catch {
      return undefined
    }

    let value: unknown
    try {
      value = JSON.parse(GgmHotfix.stripBom(body))
    } catch {
      return undefined
    }
    if (
      typeof value !== "object" ||
      value === null ||
      (value as Record<string, unknown>).override !== true
    ) {
      return undefined
    }

    const values = GgmHotfix.parse(body)
    if (values === undefined) return undefined
    console.info(`ggm-hotfix: using the pinned local values (cv=${values.cv})`)
    return values
  }

  /**
   * From Rust: `published`
   *
   * The published values: the cached copy while it is fresh, otherwise
   * a fetch, otherwise whatever stale copy we still have.
   *
   * A stale copy beats nothing: it was good enough to publish, and the
   * alternative is the compiled-in pair that is by definition older.
   */
  static async published(): Promise<PublishedValues | undefined> {
    const existing = await GgmHotfix.cached()
    if (existing !== undefined) {
      const { values, fetchedAt } = existing
      if (Date.now() - fetchedAt < CACHE_TTL_MS) {
        return values
      }
      const fresh = await GgmHotfix.fetch()
      if (fresh !== undefined) {
        return fresh
      }
      console.info("ggm-hotfix: refresh failed; keeping the cached values")
      return values
    }
    return GgmHotfix.fetch()
  }

  /**
   * From Rust: `cached`
   *
   * Read the cached file and when it was written.
   */
  private static async cached(): Promise<
    { values: PublishedValues; fetchedAt: number } | undefined
  > {
    const cachePath = GgmHotfix.cachePath()
    if (cachePath === undefined) return undefined

    let body: string
    let mtimeMs: number
    try {
      body = await fs.readFile(cachePath, "utf8")
      mtimeMs = (await fs.stat(cachePath)).mtimeMs
    } catch {
      return undefined
    }

    const values = GgmHotfix.parse(body)
    if (values === undefined) return undefined

    return { values, fetchedAt: mtimeMs }
  }

  /**
   * From Rust: `fetch` (named `fetchValues` here since `fetch` is a
   * global in Node/TS)
   *
   * Try each mirror in turn, caching the first usable answer.
   */
  private static async fetch(): Promise<PublishedValues | undefined> {
    for (const url of HOTFIX_URLS) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

      let resp: Response
      try {
        resp = await globalThis.fetch(url, { signal: controller.signal })
      } catch {
        continue
      } finally {
        clearTimeout(timer)
      }
      if (!resp.ok) {
        continue
      }

      let body: string
      try {
        body = await resp.text()
      } catch {
        continue
      }

      const values = GgmHotfix.parse(body)
      if (values === undefined) {
        // Reachable but unusable: worth saying which mirror, since
        // a stale CDN copy looks exactly like a bad commit.
        console.warn(`ggm-hotfix: published file did not validate (url=${url})`)
        continue
      }

      console.info(
        `ggm-hotfix: published values fetched (url=${url}, cv=${values.cv})`
      )
      await GgmHotfix.writeCache(body)
      return values
    }
    console.info("ggm-hotfix: no mirror answered; using local sources")
    return undefined
  }

  /** From Rust: `write_cache` */
  private static async writeCache(body: string): Promise<void> {
    const cachePath = GgmHotfix.cachePath()
    if (cachePath === undefined) return
    try {
      await fs.mkdir(path.dirname(cachePath), { recursive: true })
      await fs.writeFile(cachePath, body)
    } catch (error) {
      console.warn(
        `ggm-hotfix: could not cache the published values (error=${error})`
      )
    }
  }

  /**
   * From Rust: `strip_bom`
   *
   * Strip a UTF-8 byte-order mark.
   *
   * Several Windows editors add one when saving, and a BOM makes the
   * document fail to parse — which here means every user silently
   * drops to the compiled-in pair. That is the worst possible failure
   * for a hotfix: it looks like the fix was published, and nobody is
   * helped. Cheaper to tolerate it than to document it away.
   */
  private static stripBom(body: string): string {
    return body.charCodeAt(0) === 0xfeff ? body.slice(1) : body
  }

  /**
   * From Rust: `parse`
   *
   * Parse and validate a published document.
   *
   * Validation is not politeness: a malformed pair is sent to beanfun
   * as the caller's identity and gets everyone refused. Anything that
   * is not obviously a version and a SHA-256 is treated as if the file
   * were absent.
   */
  private static parse(body: string): PublishedValues | undefined {
    let value: unknown
    try {
      value = JSON.parse(GgmHotfix.stripBom(body))
    } catch {
      return undefined
    }

    if (typeof value !== "object" || value === null) return undefined
    const record = value as Record<string, unknown>
    if (typeof record.cv !== "string" || typeof record.hash !== "string") {
      return undefined
    }

    const cv = record.cv.trim()
    const hash = record.hash.trim().toLowerCase()

    if (!GgmHotfix.isVersion(cv) || !GgmHotfix.isSha256(hash)) {
      console.warn(
        `ggm-hotfix: values failed validation (cv=${cv}, hash_len=${hash.length})`
      )
      return undefined
    }
    return { cv, hash }
  }

  /**
   * From Rust: `is_version`
   *
   * Digits and dots only, and at least one digit.
   */
  private static isVersion(cv: string): boolean {
    return (
      cv.length > 0 &&
      /\d/.test(cv) &&
      [...cv].every((c) => (c >= "0" && c <= "9") || c === ".")
    )
  }

  /**
   * From Rust: `is_sha256`
   *
   * Exactly sixty-four hex characters.
   */
  private static isSha256(hash: string): boolean {
    return hash.length === 64 && /^[0-9a-f]{64}$/i.test(hash)
  }
}
