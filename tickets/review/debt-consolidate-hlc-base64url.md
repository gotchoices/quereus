description: Removed a duplicate base64-encoding implementation from the sync clock module so there's now a single shared version.
files:
  - packages/quereus-sync/src/clock/hlc.ts        # now imports siteIdToBase64/siteIdFromBase64 from ./site.js
  - packages/quereus-sync/src/clock/site.ts        # unchanged; canonical toBase64Url/fromBase64Url + siteIdToBase64/siteIdFromBase64
----

## What changed

`hlc.ts` previously carried its own private base64url encode/decode
(`siteIdToBase64Local`, `siteIdFromBase64Local`, and a local
`BASE64URL_CHARS` alphabet), justified by a stale comment claiming it avoided
a circular import with `site.ts`. That rationale was false: `site.ts` is a
leaf module (no imports), and `hlc.ts` already imported `type SiteId` from
`site.js`.

- `hlc.ts` now imports `siteIdToBase64` / `siteIdFromBase64` from `./site.js`
  instead of defining local copies.
- Deleted `siteIdToBase64Local`, `siteIdFromBase64Local`, the local
  `BASE64URL_CHARS` constant, and the stale "avoid circular import" comments.
- Three call sites updated: `deterministicTxnId` (was ~148), `hlcToJson` (was
  ~220), `hlcFromJson` (was ~232) — now call the shared `site.ts` functions.
  No behavior change; the shared implementation is byte-for-byte identical to
  the deleted local one (same encode loop, same reverse-lookup decode, same
  `length !== 22` guard).

This finishes the consolidation started by the `debt-peer-state-getallpeers-key-decode`
ticket, which already collapsed the same duplicate in `metadata/keys.ts` onto
`site.ts`. `site.ts` is now the single source of truth for site-id
base64url serialization across the package.

## Validation performed

- `yarn build` in `packages/quereus-sync`: clean, no type errors.
- `yarn test` in `packages/quereus-sync`: full suite green, 443 passing, 0
  failing. Includes `test/clock/hlc.spec.ts` (HLC string/JSON round-trip,
  unchanged assertions) plus `transaction-commit.spec.ts`,
  `echo-loop-quiescence.spec.ts`, `change-grouping.spec.ts` — all of which
  exercise `hlcToJson`/`hlcFromJson`/`deterministicTxnId` indirectly.
- Confirmed via grep no remaining reference to `siteIdToBase64Local`,
  `siteIdFromBase64Local`, or a second `BASE64URL_CHARS` definition in
  `hlc.ts`.

## Suggested review focus

- Purely mechanical dedup — diff is a net -48 lines in `hlc.ts`, no new
  logic. Reviewer should mainly confirm the three call-site substitutions
  are correct and that no other file still reaches for the deleted local
  helpers (they were never exported, so this is a closed set).
- No new tests were added since behavior is unchanged and existing coverage
  already round-trips `hlcToJson`/`hlcFromJson` and `deterministicTxnId`
  through the base64 path.
