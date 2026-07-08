description: Fixed a helper that lists all known sync peers — it was reconstructing each peer's ID with the wrong decoding, which would have returned corrupted IDs the moment anything started using it.
files:
  - packages/quereus-sync/src/metadata/peer-state.ts   # getAllPeers (~104)
  - packages/quereus-sync/src/metadata/keys.ts          # parsePeerStateKey (new), buildPeerStateKey/buildPeerSentStateKey now use site.ts helpers
  - packages/quereus-sync/src/clock/site.ts             # canonical base64url helpers (now the single source for keys.ts)
  - packages/quereus-sync/test/metadata/peer-state.spec.ts  # new
----

## What was wrong (original bug)

`PeerStateStore.getAllPeers()` iterated the `ps:` key range
(`SYNC_KEY_PREFIX.PEER_STATE`) and reconstructed each peer's 16-byte `SiteId`
by treating the key suffix as **hex**. But the keys are written as
**base64url** (`ps:{siteId_base64url}`, 22 chars), not hex (32 chars). Parsing
base64url two chars at a time as hex produced `NaN` / garbage for every
reconstructed id. Dormant because `getAllPeers()` has no callers anywhere in
the codebase yet.

## Fix (as landed in implement + adjusted in review)

- `getAllPeers()` now decodes the key suffix via the inverse of the base64url
  encoder instead of the broken hex loop.
- **Review change:** rather than add a *new* third copy of base64url decode
  logic (the implement stage added `base64UrlToSiteId` to `keys.ts`),
  `keys.ts` now reuses the canonical, already-tested `siteIdToBase64` /
  `siteIdFromBase64` from `clock/site.ts`. Removed the duplicated
  `siteIdToBase64Url` + `base64UrlToSiteId` + `BASE64URL_CHARS` from
  `keys.ts`.
- Added `parsePeerStateKey(key): SiteId | null` to `keys.ts` (matching the
  existing `parseColumnVersionKey`/`parseTombstoneKey`/etc. pattern) so the
  `ps:`/`pt:` key format stays owned by `keys.ts`. `getAllPeers` calls it and
  throws (rather than silently skipping, per the "don't eat exceptions" house
  rule) if a key in the `ps:` range fails to parse.

Storage format is unchanged — keys are byte-identical to before, since
`siteIdToBase64` produces the same 22-char output as the removed
`siteIdToBase64Url`.

## Review findings

Reviewed the implement diff (commit `9eea20c8`) with fresh eyes, then the
handoff, then every touched file plus `clock/site.ts` and `clock/hlc.ts`.

**Checked:**

- **Correctness of the encode/decode round-trip** — hand-traced the trailing
  16th byte (the ragged group: 22-char encode → 2 trailing chars → 1 byte
  decode) for both the implement-stage `base64UrlToSiteId` and `site.ts`'s
  `siteIdFromBase64`; both correctly invert the encoder. Verified byte-for-byte
  in tests.
- **Scan-range bounds** — `getAllPeers` scans `gte='ps:'`, `lt='ps;'`
  (last-byte+1). Confirmed all `ps:`-prefixed keys fall inside and `pt:` keys
  (0x74 > 0x73) fall outside; added a regression test that a `pt:` sent-watermark
  entry does not leak into `getAllPeers`.
- **Error handling** — malformed key in the `ps:` range now throws instead of
  yielding a corrupt/garbage id.
- **DRY (main finding)** — see below.
- **Docs** — `keys.ts` header prefix legend already documented `ps:`/`pt:`
  correctly; the only stale doc was the inline `{siteId_hex}` comment, fixed in
  implement. No `docs/` file describes `getAllPeers` specifically.
- **Tests** — expanded from 2 cases to 6: `ps:` round-trip, `pt:` round-trip,
  null on wrong-prefix key, null on malformed-length suffix, end-to-end
  two-peer enumeration, and `pt:`-does-not-leak.

**Found & fixed inline (minor):**

- The implement stage introduced a **third** copy of base64url logic
  (`base64UrlToSiteId` in `keys.ts`) alongside the pre-existing private
  `siteIdToBase64Url` there — both duplicating `clock/site.ts`'s exported,
  tested pair. The "inlined to avoid an import cycle" comment justifying the
  duplication is **false**: `clock/site.ts` imports nothing (leaf module), so
  importing its values into `keys.ts` cannot create a cycle. Collapsed
  `keys.ts` onto `site.ts` and deleted the duplicates.

**Found & filed as a ticket (major-ish, out of this ticket's touched files):**

- `clock/hlc.ts` carries a *fourth* copy (`siteIdToBase64Local` /
  `siteIdFromBase64Local`) with the same stale "avoid circular import"
  comment. Consolidating it means editing `hlc.ts`, which this ticket's diff
  never touched, so filed `backlog/debt-consolidate-hlc-base64url` rather than
  expanding scope. `site.ts` + `keys.ts` are now consolidated; `hlc.ts` is the
  last holdout.

**Tripwire (noted, not filed):**

- `deletePeerState` (peer-state.ts ~122) already carries a `NOTE:` that it
  deletes only the received watermark (`ps:`), leaving the sent watermark
  (`pt:`) orphaned. Still accurate, still inert (no full-peer-removal caller);
  left as-is.
- The `pt:` prefix has no enumeration helper at all. Not a defect — it simply
  doesn't exist yet. If a peer-GC feature ever needs to sweep `pt:`,
  `parsePeerStateKey` already handles both prefixes, so a `getAllSentPeers`
  would be a thin addition.

**Empty categories:** No security, resource-cleanup, or concurrency findings —
this is a pure key-decode helper with no I/O ownership, locking, or untrusted
input beyond keys the same module wrote.

## Verification

- `yarn workspace @quereus/sync typecheck` — clean.
- `yarn workspace @quereus/sync build` — clean.
- `yarn workspace @quereus/sync test` — **442 passing, 0 failing** (was 438;
  +4 net new peer-state cases). The `[Sync] Error …` lines in output are
  deliberate fault-injection from unrelated sync-manager tests, not failures.
- `yarn workspace @quereus/sync lint` — `No lint configured` (this package has
  the intentional no-op; only `packages/quereus` has a real lint, and it
  typechecks its own tests, not this package's).
