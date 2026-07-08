description: A helper that lists all known sync peers reconstructs each peer's ID using the wrong decoding, so it would return corrupted IDs the moment anything starts using it.
files:
  - packages/quereus-sync/src/metadata/peer-state.ts   # getAllPeers (~104): slices "ps:" then parses hex
  - packages/quereus-sync/src/metadata/keys.ts          # buildPeerStateKey writes base64url, not hex
difficulty: easy
----

## Problem

`PeerStateStore.getAllPeers()` iterates the `ps:` key range and tries to
reconstruct each peer's `SiteId` from the key suffix:

```ts
const keyStr = new TextDecoder().decode(entry.key);
const hex = keyStr.slice(3);           // Skip "ps:"
const siteId = new Uint8Array(16);
for (let i = 0; i < 16; i++) {
  siteId[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);   // <-- treats suffix as hex
}
```

But the keys are **not** hex-encoded. `buildPeerStateKey` (keys.ts) encodes the
16-byte site id as **base64url** (`ps:{siteId_base64url}`, ~22 chars), not hex
(32 chars). Parsing base64url two chars at a time as hex yields `NaN` for any
non-hex character and mis-maps the rest, so every reconstructed `siteId` is
garbage. The comment on the loop (`// Extract site ID from key: ps:{siteId_hex}`)
is also stale — it says hex, the writer uses base64url.

## Why it's dormant (debt, not an active bug)

`getAllPeers()` has **no callers** in the codebase today (only its own
definition). So nothing currently observes the corrupted output. This became
visible during review of the sent-watermark work (`sync-client-persist-last-sent-hlc`),
which added a sibling `pt:` prefix; the same store never enumerates `pt:` either.

## Expected behavior

`getAllPeers()` should decode the key suffix with the **inverse of
`buildPeerStateKey`'s base64url encoding**, returning the exact 16-byte
`SiteId` that was stored. Whoever picks this up should decode via a shared
base64url helper rather than re-inlining a second encoder (the encode side was
already factored into `siteIdToBase64Url` in keys.ts — add the matching decode
there and use it here). A round-trip test (`buildPeerStateKey(id)` →
`getAllPeers` yields back `id`) should guard it.

If/when peer garbage-collection is added, this helper is the natural place to
also enumerate/clean the `pt:` (sent-watermark) keys — see the `NOTE:` in
`peer-state.ts` `deletePeerState`.
