description: |
  On a store-backed table wrapped in the transaction-isolation layer, an "insert … on conflict
  do update/nothing" whose key is written in a different form than it is stored (e.g. the text
  '1' into an integer key holding 1) wrongly threw away the existing row and kept the
  just-inserted one. Fixed by coercing the incoming row to the declared column types before the
  isolation layer probes for a conflict — but only for that probing, not for the actual write
  (see "Deviation from the ticket plan" below).
files:
  - packages/quereus-isolation/src/isolated-table.ts                # update() — coerceRow + coercedValues, fix site
  - packages/quereus-store/src/common/store-table.ts                # coerceRow (~:857) — reference mirrored
  - packages/quereus/src/vtab/memory/layer/manager.ts                # performInsert/performUpdate (~:706, :894) — overlay's OWN unconditional coercion; this is why the write must stay un-coerced
  - packages/quereus/src/types/json-type.ts                          # JSON_TYPE.parse (~:24) — non-idempotent for scalar-string JSON values; root cause of the deviation
  - packages/quereus/test/logic/47.4-upsert-conflict-target-affinity.sqllogic  # repro, now runs in both modes
  - packages/quereus/test/logic/03.6-type-system.sqllogic            # JSON-column insert/error case that caught the double-coercion regression during implementation
  - packages/quereus/test/logic.spec.ts                              # MEMORY_ONLY_FILES entry removed (~:45, now gone)
---

# Fix landed: isolation overlay coerces the incoming row before probing for an ON CONFLICT match

## What changed

`IsolatedTable.update()` (`packages/quereus-isolation/src/isolated-table.ts`) previously extracted
the primary key and ran all merged-view conflict detection (`checkMergedPKConflict`,
`checkMergedUniqueConstraints`, the `getOverlayRow`/`getUnderlyingRow` PK probes) against the
**raw, un-coerced** `args.values`. That let a proposed key in a different storage class than the
stored key (e.g. TEXT `'1'` into an `integer primary key` holding `1`) miss the existing row during
probing — the layer reported "no conflict", staged the proposed row instead of updating the
existing one, and the existing row was lost at commit.

Fix: added a private `coerceRow()` (mirrors `StoreTable.coerceRow`) and a `coercedValues` local,
computed once per `update()` call via `validateAndParse` against the declared column logical
types. `coercedValues` now feeds every detection site: PK extraction (`pk`, `newPK`, `targetPK`
fallback), `checkMergedPKConflict`, `checkMergedUniqueConstraints`'s `newRow` argument, and the
`keysEqual` comparisons that decide whether an UPDATE is relocating its PK.

## Deviation from the ticket plan — do not also coerce the overlay write

The ticket's plan said to coerce "everywhere below … and the overlay write" and asserted
`validateAndParse` is idempotent so double-coercion is a harmless no-op. **That assertion is false
for `JSON_TYPE`** (`packages/quereus/src/types/json-type.ts:24`): a JSON-string *scalar* like the
SQL literal `'"hello"'` parses on first pass to the native JS string `hello` (unquoted); re-running
`parse` on that already-native string tries `JSON.parse("hello")`, which is not valid JSON syntax
(it lacks its own quotes) and throws `Cannot convert 'hello' to JSON: invalid JSON syntax`.

The overlay (a memory-module `MemoryTable`) always re-coerces every cell on its own
insert/update **unconditionally** — it does not consult `args.preCoerced` the way `StoreTable`
does. So if `IsolatedTable.update()` had also passed the coerced row into `overlay.update()`
(as the ticket's snippet showed), every JSON-column write through the isolation layer would be
coerced twice and any JSON-string-scalar value would throw. This was caught by
`03.6-type-system.sqllogic`'s JSON-validation block failing under `yarn test:store` during
implementation (it inserts `'"hello"'` into a `JSON` column) — **not by the ticket's own 47.4
repro**, which never happens to hit a JSON column.

The implemented fix keeps this asymmetric: `coercedValues` is used only where the code makes a
*decision* (PK/UC matching), while every `overlayRow = [...(values ?? []), 0]` / `[...values, 0]`
write-content construction still uses the original **raw** `values` — the overlay's own
unconditional coercion is the sole place each cell actually gets parsed for storage, exactly as
before this fix. `oldKeyValues` is untouched either way (already coerced PK values from a stored
row, per the original ticket).

## Test coverage / how to validate

- `47.4-upsert-conflict-target-affinity.sqllogic` — the ticket's repro, now enabled in BOTH memory
  and store mode (`MEMORY_ONLY_FILES` entry removed from `logic.spec.ts`). Covers all three
  variants: PK DO UPDATE, PK DO NOTHING, non-PK UNIQUE DO UPDATE.
- `03.6-type-system.sqllogic` — pre-existing JSON validation coverage; exercises the
  double-coercion hazard this fix must avoid (inserts a JSON-string scalar, and separately expects
  a `Type conversion failed` error for malformed JSON — both must still behave correctly under the
  isolation/store path).
- `yarn test` (memory mode): 6879 passing, 9 pending — clean.
- `yarn test:store` (LevelDB/store mode): 6874 passing, 14 pending, 0 failing — clean. (Prior to
  the write-path fix described above, this run had exactly 1 failure: the JSON case in
  `03.6-type-system.sqllogic`.)
- `yarn lint` (`@quereus/quereus` real lint, includes `tsc -p tsconfig.test.json --noEmit`): clean,
  no output.
- `yarn workspace @quereus/isolation build` and `yarn workspace @quereus/quereus build`: both clean.

## Known gaps / things the reviewer should look at

- No new *unit* test was added directly against `IsolatedTable.coerceRow` or the
  `coercedValues`/raw-`values` split — coverage is entirely through the `.sqllogic` logic-test
  harness (47.4 in store mode, 03.6 in store mode). If a reviewer wants tighter regression
  protection against a future "let's just coerce the write too" regression, a store-mode test
  inserting a JSON-string-scalar value through an `ON CONFLICT` path (so it goes through
  `checkMergedUniqueConstraints`/`checkMergedPKConflict`) combined with a JSON column would pin
  this down more directly than 03.6 alone does (03.6 doesn't currently exercise the isolation
  layer's ON CONFLICT arms for a JSON column).
- Pre-existing unused-parameter TS diagnostics (`tombstoneIndex` unused in
  `checkMergedPKConflict`/`findUnderlyingUniqueConflict`, and `_exhaustive` in
  `resolveScanIndex`'s switch) were observed in the IDE during implementation. These predate this
  change (only their line numbers shifted from the new code inserted above them) and `yarn lint`
  passes clean, so they are not TS build/lint errors — left alone as out of scope for this ticket.
- Did not touch `packages/quereus-store/src/common/store-table.ts` or
  `packages/quereus/src/vtab/memory/layer/manager.ts` — both were reference-only per the ticket.

## Review findings

(none yet — this section is for the review stage to fill in)
