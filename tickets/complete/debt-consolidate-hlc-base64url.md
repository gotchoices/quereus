description: Removed a duplicate base64-encoding implementation from the sync clock module so there's now a single shared version.
files:
  - packages/quereus-sync/src/clock/hlc.ts        # imports siteIdToBase64/siteIdFromBase64 from ./site.js
  - packages/quereus-sync/src/clock/site.ts       # canonical toBase64Url/fromBase64Url + siteIdToBase64/siteIdFromBase64
  - packages/quereus-sync/test/clock/hlc.spec.ts  # added deterministicTxnId + bad-length siteId coverage (review pass)
----

## What changed

`hlc.ts` previously carried a private copy of base64url encode/decode
(`siteIdToBase64Local`, `siteIdFromBase64Local`, a local `BASE64URL_CHARS`
alphabet), justified by a stale comment claiming it avoided a circular import
with `site.ts`. That rationale was false: `site.ts` imports nothing, and
`hlc.ts` already imported `type SiteId` from it.

- `hlc.ts` now imports `siteIdToBase64` / `siteIdFromBase64` from `./site.js`.
- Deleted the two local helpers, the duplicate alphabet constant, and the
  stale comments (net -48 lines).
- Three call sites updated: `deterministicTxnId`, `hlcToJson`, `hlcFromJson`.

`site.ts` is now the single source of truth for site-id base64url
serialization inside `@quereus/sync`, finishing the consolidation that
`debt-peer-state-getallpeers-key-decode` started in `metadata/keys.ts`.

## Review findings

### Correctness — behavior equivalence verified, no defects

Compared the deleted local helpers against `site.ts` line by line:

- **Encode**: `siteIdToBase64Local` and `toBase64Url` are character-for-character
  the same loop (same alphabet string, same shift/mask sequence, same partial-triplet
  guards). Identical output for all inputs.
- **Decode**: the local version hard-coded `new Uint8Array(16)` and guarded writes
  with `writePos < 16`. The shared `fromBase64Url` computes `outputLen =
  floor(len * 3 / 4)` and guards with `writePos < outputLen`. For the only reachable
  input length these paths see — 22 chars, enforced by the `length !== 22` guard that
  `siteIdFromBase64` applies *before* delegating — `outputLen` is exactly 16. Same
  buffer size, same guard, same bytes. The length guard survived the move, so the
  error message and throw site are unchanged too.
- Both versions are equally lenient about invalid characters (`?? 0`). No behavior
  change either way; not a regression introduced here.
- Import cycle re-checked: `site.ts` has zero imports, so promoting `hlc.ts`'s
  `import type` to a value import cannot create one. Build confirms.
- The deleted helpers were never exported, so nothing outside `hlc.ts` could have
  referenced them. Grep confirms no dangling references anywhere in the repo.

### Test coverage — gap found and closed inline (minor)

Existing `test/clock/hlc.spec.ts` round-tripped `hlcToJson`/`hlcFromJson` and
asserted the 22-char base64url shape, but two of the three changed call sites were
untested:

- `deterministicTxnId` had **no direct test at all** — it was only exercised
  indirectly through sync-manager specs, which never assert on the encoded siteId
  segment. Added two tests: one pinning the exact `wallTime:counter:base64(siteId)`
  format against `siteIdToBase64`, one asserting `opSeq` does not affect the id
  (the property the function exists for).
- The decode **error path** (`length !== 22`) was untested through `hlcFromJson`.
  Added a test asserting the throw. This is the one place the shared and local
  implementations could have diverged, so it deserves a pin.

Suite now 446 passing (was 443), 0 failing.

### Tripwire recorded, not ticketed

`@quereus/quereus`'s `src/util/hash.ts` has a byte-identical `toBase64Url`, and
`quereus-sync` does depend on that package — so this is a *cross-package* duplicate
that survives the intra-package consolidation. Hoisting it would mean adding
`util/hash.ts` to the engine's public API surface for ~20 lines, which is not worth
it today. Parked as a `NOTE:` comment above `toBase64Url` in `site.ts` saying to
promote rather than copy if a third copy appears or the two ever need to agree on a
change. No ticket filed.

### Nothing found in these categories

- **Docs**: `packages/quereus-sync` has only a `README.md` and it never mentions
  base64 or site-id encoding; no `docs/` dir in the package. Nothing to update.
- **Resource cleanup / error handling / performance**: not applicable — the change
  deletes code and rebinds three calls; it allocates nothing, opens nothing, and
  the shared decode does the same reverse-lookup-table build per call that the local
  one did. Not a regression, and 22-char decode is not on any hot path worth
  memoizing.
- **Type safety**: `import { type SiteId, ... }` is the correct inline-type form;
  no `any` introduced. `yarn lint` (real eslint + `tsc -p tsconfig.test.json` on
  `packages/quereus`, no-op elsewhere) passes clean.

## Validation

- `yarn build` in `packages/quereus-sync`: clean.
- `yarn test` in `packages/quereus-sync`: **446 passing, 0 failing.**
- `yarn workspaces foreach -A run lint` from root: passes.
- No pre-existing failures encountered.
