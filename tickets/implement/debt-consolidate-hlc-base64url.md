description: The sync clock module still carries its own private copy of base64 encode/decode logic that already exists (and is tested) in a shared module next door; fold it onto the shared one so there is a single implementation.
files:
  - packages/quereus-sync/src/clock/hlc.ts        # siteIdToBase64Local (~243), siteIdFromBase64Local (~261), BASE64URL_CHARS (~238)
  - packages/quereus-sync/src/clock/site.ts        # canonical toBase64Url/fromBase64Url + siteIdToBase64/siteIdFromBase64
difficulty: easy
----

## Background

Site ids (16-byte replica identifiers) are serialized to base64url in a few
places. The canonical, exported, unit-tested implementation lives in
`clock/site.ts` (`toBase64Url`/`fromBase64Url` and the site-id wrappers
`siteIdToBase64`/`siteIdFromBase64`).

`clock/hlc.ts` re-implements the same thing privately as
`siteIdToBase64Local` / `siteIdFromBase64Local` (with its own copy of the
`BASE64URL_CHARS` alphabet). The code is byte-for-byte equivalent to the
`site.ts` version — encode loop identical, decode builds the same reverse
lookup table, and `siteIdFromBase64Local` throws on the same `length !== 22`
guard as `siteIdFromBase64`.

Both local helpers carry a comment claiming they are inlined "to avoid a
circular import". **That rationale is stale/false today:** `clock/site.ts`
imports nothing (it is a leaf module), and `hlc.ts` already imports
`type SiteId` from `site.js`. Importing the base64 *values* from `site.js`
into `hlc.ts` cannot create a cycle.

The sibling duplicate in `metadata/keys.ts` was already collapsed onto
`site.ts` during the `debt-peer-state-getallpeers-key-decode` review — this
ticket finishes the job for `hlc.ts` so `site.ts` is the single source.

## Expected outcome

- `hlc.ts` imports `siteIdToBase64` / `siteIdFromBase64` (or the raw
  `toBase64Url` / `fromBase64Url`) from `./site.js` and deletes
  `siteIdToBase64Local`, `siteIdFromBase64Local`, and the local
  `BASE64URL_CHARS`.
- Call sites (`hlc.ts` ~148, ~220, ~232) use the shared functions. Behavior
  must be identical — the HLC string/JSON round-trip tests should stay green
  with no assertion changes.
- Confirm the "avoid circular import" comments are gone (they were the only
  justification for the duplication, and they are wrong).

## Notes

- No perf regression: both the local and shared decoders rebuild the reverse
  lookup table on every call, and the encoders are identical. If HLC
  serialization ever shows up as hot, hoisting the lookup table to a
  module-level constant in `site.ts` would benefit every caller at once — but
  that is a separate optimization, not part of this consolidation.
