description: Fixed a helper that lists all known sync peers — it was reconstructing each peer's ID with the wrong decoding, which would have returned corrupted IDs the moment anything started using it.
files:
  - packages/quereus-sync/src/metadata/peer-state.ts   # getAllPeers (~104)
  - packages/quereus-sync/src/metadata/keys.ts          # base64UrlToSiteId (new, ~112), buildPeerStateKey
  - packages/quereus-sync/test/metadata/peer-state.spec.ts  # new
----

## What was wrong

`PeerStateStore.getAllPeers()` iterated the `ps:` key range (`SYNC_KEY_PREFIX.PEER_STATE`)
and reconstructed each peer's 16-byte `SiteId` by treating the key suffix as
**hex**. But `buildPeerStateKey` (keys.ts) writes the site id as **base64url**
(`ps:{siteId_base64url}`, ~22 chars via `siteIdToBase64Url`), not hex (32
chars). Parsing base64url two chars at a time as hex produced `NaN` for any
non-hex character and mis-mapped everything else — every reconstructed
`siteId` was garbage. Dormant because `getAllPeers()` had no callers anywhere
in the codebase.

## Fix

Added `base64UrlToSiteId(encoded: string): SiteId` to `keys.ts`, right next to
the existing `siteIdToBase64Url` (which stays private/inlined there to avoid
an import cycle, per its existing comment — did not consolidate with the
separate, functionally-identical `toBase64Url`/`fromBase64Url` pair already
in `clock/site.ts`; see "Noted, not touched" below). It's a standard
byte-oriented base64 decode (4 chars → 3 bytes, with a 2-or-3-char trailing
group emitting 1-or-2 bytes) — the exact inverse of the encode loop.

`getAllPeers()` now does:
```ts
const keyStr = new TextDecoder().decode(entry.key);
const siteId = base64UrlToSiteId(keyStr.slice(3));  // Skip "ps:"
```
instead of the hex-parsing loop. Stale comment (`ps:{siteId_hex}`) corrected
to `ps:{siteId_base64url}`.

## Testing

New `packages/quereus-sync/test/metadata/peer-state.spec.ts`:
- `buildPeerStateKey(id)` → strip `ps:` → `base64UrlToSiteId` → equals `id`
  (byte-for-byte, via `siteIdEquals`), for a random `generateSiteId()`.
- End-to-end: `PeerStateStore.setPeerState` for two distinct site ids against
  an `InMemoryKVStore`, then `getAllPeers()` and confirm both site ids come
  back exactly (not corrupted, not swapped).

Full package suite run: `yarn workspace @quereus/sync test` (mocha) —
**438 passing, 0 failing** (2 of those are the new tests; ran the new spec
file alone too, both green). `yarn build` and `yarn typecheck` both clean.

## Known gaps / left for reviewer

- Only `getAllPeers()` (the `ps:` received-watermark prefix) was fixed and
  tested. The sibling `pt:` prefix (`buildPeerSentStateKey` / sent
  watermark, added by `sync-client-persist-last-sent-hlc`) still has **no**
  enumeration helper at all — not broken, just doesn't exist yet. Left as-is;
  the ticket scope was the existing `getAllPeers` bug, not adding new
  coverage for `pt:`.
- `deletePeerState`'s existing `NOTE:` (peer-state.ts ~129) about `pt:` being
  orphaned on peer removal is unchanged — still a tripwire, not touched by
  this fix.
- Noted, not touched: `clock/site.ts` already has a byte-for-byte-identical
  base64url encode/decode pair (`toBase64Url`/`fromBase64Url`,
  `siteIdToBase64`/`siteIdFromBase64`) alongside the one this ticket added to
  `keys.ts`. The ticket's own instructions said to add the decode next to
  `keys.ts`'s existing (deliberately duplicated, per its own
  import-cycle comment) `siteIdToBase64Url`, so did that rather than
  consolidating on `clock/site.ts`'s version — flagging the duplication here
  in case a reviewer wants it collapsed later.
