// From Rust: `resolve_client_integrity`
//
// Resolution order (see the four-layer note this mirrors in ggm-client.js):
//   1. what the user pinned
//   2/3. the locally installed GGM vs. what we published — whichever
//        names the newer build
//   4. the compiled-in / bundled fallback
//
// `names_a_newer_build` below is now the real Rust implementation,
// translated 1:1 — the earlier version of this file had a stand-in
// because that function wasn't in the snippet I'd been given yet.

import { ClientIntegrity } from "../classes/ClientIntegrity"
import { GgmHotfix, PublishedValues } from "../classes/GgmHotfix"

/**
 * From Rust: `names_a_newer_build`
 *
 * Compares two dot-separated version strings segment by segment,
 * left to right, and reports whether `candidate` is newer than
 * `current`. Each segment is parsed as a non-negative integer; a
 * segment that fails to parse (empty, non-numeric) is treated as `0`,
 * matching Rust's `.parse().unwrap_or(0)`. Missing trailing segments on
 * the shorter side are likewise treated as `0`.
 */
function namesANewerBuild(candidate: string, current: string): boolean {
  /** From Rust: the inner `fn parts` closure. */
  function parts(v: string): number[] {
    return v.split(".").map((p) => {
      const trimmed = p.trim()
      // Non-negative-integer parse, mirroring Rust's `u64` parse: any
      // failure (empty string, non-digits, negative sign, etc.) falls
      // back to 0 rather than propagating an error.
      if (!/^\d+$/.test(trimmed)) return 0
      const n = Number.parseInt(trimmed, 10)
      return Number.isNaN(n) ? 0 : n
    })
  }

  const a = parts(candidate)
  const b = parts(current)
  const width = Math.max(a.length, b.length)

  for (let i = 0; i < width; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) {
      return x > y
    }
  }
  return false
}

/**
 * From Rust: `resolve_client_integrity`
 *
 * Never throws: every branch below ends in a usable `ClientIntegrity`,
 * down to `ClientIntegrity.fallback()` if nothing else is available.
 */
export async function resolveClientIntegrity(): Promise<ClientIntegrity> {
  // 1. What the user pinned. An explicit choice outranks everything,
  //    including a newer published pair.
  //
  //    Rust runs `ggm_hotfix::pinned` via `spawn_blocking` because it's
  //    synchronous file I/O off the async runtime's thread. Node has no
  //    such distinction — its fs calls are already non-blocking to the
  //    event loop — so this just awaits `GgmHotfix.pinned()` directly.
  const pinnedValues: PublishedValues | undefined = await GgmHotfix.pinned()
  if (pinnedValues !== undefined) {
    return ClientIntegrity.fromPublished(pinnedValues)
  }

  // 2 and 3. The GGM installed here, and what we published — whichever
  //    describes the newer build.
  //
  //    GGM updates itself, but only when it runs, and the people this
  //    app exists for are precisely the ones who never run it: they
  //    launch from here, not from the official site. An install that
  //    has sat untouched since Gamania last shipped reports what it was
  //    then, and those are the values beanfun stops accepting — so
  //    preferring it unconditionally would make the stalest machines
  //    the only ones the hotfix lever could never reach.
  //
  //    Preferring the published pair unconditionally trades that for
  //    the opposite hazard: a bad publish takes down users whose own
  //    install was fine. Comparing versions avoids both. A tie goes to
  //    the installed file, which is this machine's own truth rather
  //    than a claim about it.
  let local: ClientIntegrity | undefined
  try {
    local = await ClientIntegrity.resolveLocal()
  } catch (error) {
    console.warn(`client-integrity resolve task failed (error=${error})`)
    local = undefined
  }
  const publishedValues: PublishedValues | undefined =
    await GgmHotfix.published()

  if (local !== undefined && publishedValues !== undefined) {
    if (namesANewerBuild(publishedValues.cv, local.cv)) {
      console.info(
        `published client-integrity is newer than the installed GGM (local=${local.cv}, published=${publishedValues.cv})`
      )
      return ClientIntegrity.fromPublished(publishedValues)
    }
    return local
  }

  if (local !== undefined) {
    return local
  }

  if (publishedValues !== undefined) {
    return ClientIntegrity.fromPublished(publishedValues)
  }

  // 4. What we shipped with.
  return ClientIntegrity.fallback()
}
