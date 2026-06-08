---
description: Store-mode UNIQUE-constraint enforcement now honors `UniqueConstraintSchema.predicate` so partial-UNIQUE indexes (`CREATE UNIQUE INDEX ... WHERE ...`) treat rows outside the partial scope as not participating in uniqueness. Required fixes in both `StoreTable` (own check + `uniqueColumnsChanged`) and `IsolatedTable` (merged-view check).
files:
  packages/quereus/src/index.ts
  packages/quereus-store/src/common/store-table.ts
  packages/quereus-isolation/src/isolated-table.ts
  packages/quereus/test/logic/10.5.1-partial-indexes.sqllogic
  docs/design-isolation-layer.md
---

## What landed

Implementation mirrors `MemoryTableManager.checkSingleUniqueConstraint` /
`uniqueColumnsChanged` (`packages/quereus/src/vtab/memory/layer/manager.ts:705-799`):

- **Public exports** (`packages/quereus/src/index.ts`): `compilePredicate`,
  `CompiledPredicate`, and `UniqueConstraintSchema` re-exported so store-side
  packages can compile partial-index predicates.
- **`StoreTable`** (`packages/quereus-store/src/common/store-table.ts`):
  WeakMap<UC, CompiledPredicate> cache, `compileFor(uc)` helper, predicate-aware
  short-circuit in `checkUniqueConstraints` (out-of-scope newRow → skip UC),
  predicate-aware candidate filter in `findUniqueConflict`, and
  `uniqueColumnsChanged` extended to consider `compiled.referencedColumns`
  so a same-PK UPDATE that transitions a row across the predicate scope still
  re-runs the UNIQUE check.
- **`IsolatedTable`** (`packages/quereus-isolation/src/isolated-table.ts`):
  same pattern applied to the merged-view check
  (`checkMergedUniqueConstraints` + `findMergedUniqueConflict`). Required for
  the store-mode test path because `createIsolatedStoreModule` wraps the
  `StoreTable` and runs its own merged-view UNIQUE check before delegating.

## Review findings

### Correctness and SPP

- **Three-valued predicate logic.** Both layers use `predicate.evaluate(row) !== true`,
  so SQL `false` and `null` are both treated as out-of-scope. Matches
  `vtab/memory/utils/predicate.ts` semantics and SQLite partial-index behavior. ✓
- **NULL-in-constrained-column fast-path.** Preserved (predates this work) and
  runs *before* the predicate check. Correct: a NULL in any covered column means
  the UC doesn't apply regardless of partial scope. ✓
- **WeakMap key stability.** Verified by tracing UC construction paths
  (`SchemaManager.addIndexToTableSchema:1250`,
  `StoreModule.createIndex:308-358`): every CREATE INDEX produces a fresh
  `UniqueConstraintSchema` object literal in a `Object.freeze`'d
  `uniqueConstraints` array. No path mutates an existing UC in place. The cache
  key is therefore stable across writes for the lifetime of the constraint and
  GC-eligible after the schema swap. ✓
- **`tableSchema!` non-null assertion in `compileFor`.** Both call sites read
  `schema.uniqueConstraints` immediately before invoking `compileFor`, so the
  schema is guaranteed non-null at that point. ✓
- **REPLACE / IGNORE through the new path.** Traced manually: REPLACE on a
  partial-UNIQUE collision correctly identifies the in-scope conflicting row,
  deletes it (StoreTable) or writes a tombstone (IsolatedTable), and proceeds.
  IGNORE returns ok-with-undefined-row before mutation. Out-of-scope newRows
  short-circuit before any scan and so never trigger eviction. ✓
- **Update transitioning a row into scope where another in-scope row holds
  the value.** Traced: e.g., starting with `{1: active/A, 2: inactive/A}` and
  running `update t set status='active' where id=2`, `uniqueColumnsChanged`
  returns true (status is in `referencedColumns`), `checkUniqueConstraints`
  re-runs with the new row, predicate evaluates TRUE, scan finds id=1 as an
  in-scope conflict, ABORT. ✓ (Not explicitly in the test fixture but follows
  from the logic and matches the memory-mode reference.)

### Tests

- `yarn test:store` → SQL Logic Tests (Store Mode) > 10.5.1-partial-indexes
  now passes (verified locally: 587 passing, 1 failing, where the failure
  is unrelated `102.1-unique-edge-cases`). ✓
- `yarn workspace @quereus/quereus run lint` → clean. ✓
- The remaining `102.1` failure is a pre-existing latent issue in
  `StoreModule.buildIndexEntries` (CREATE UNIQUE INDEX over existing duplicates
  silently succeeds) that became reachable only after this fix unblocks mocha
  from bailing at 10.5.1. Separate fix ticket
  `store-create-unique-index-skips-existing-duplicates` already filed by the
  implementer; out of scope for this ticket.
- **Test coverage gaps (acceptable for this ticket; not filed as a follow-up):**
  No isolation-layer-specific unit test for partial UNIQUE; the path is
  exercised only indirectly via the store-mode sqllogic run. The merged-view
  branch and the standalone-StoreTable branch run the *same* logic, and the
  sqllogic fixture's INSERT/UPDATE scenarios hit both REPLACE-free shapes.
  The conservative additions (`REPLACE`/`IGNORE` cases with partial UNIQUE,
  bulk INSERT with same in-scope code, update-into-scope-collision) would be
  nice-to-have but the logic is a mechanical mirror of the well-covered
  MemoryTable path.

### Hot-path cost

Per-row write under a partial UNIQUE adds one predicate evaluation on the new
row (out-of-scope short-circuits before any scan). On an in-scope newRow, each
candidate that matches on UC columns then pays one additional predicate eval
on the candidate. For full-table UCs, `compileFor` returns undefined and
behavior is unchanged (no overhead). The order — column-equality first, then
predicate — is the right default unless a very-restrictive predicate
dominates. ✓

### Documentation

- `docs/design-isolation-layer.md` § "Non-PK UNIQUE Conflict" updated to
  describe the partial-UNIQUE handling and the WeakMap-cached predicate. Other
  docs (`memory-table.md`, `architecture.md`, `runtime.md`) don't describe
  the store-side UNIQUE check at this granularity, so no further updates
  needed.

### Out-of-scope issues surfaced during review

The implementer correctly filed two follow-up tickets that surfaced from
this work; both are valid and remain out of scope for this ticket:

- `fix/store-create-unique-index-skips-existing-duplicates.md` —
  `buildIndexEntries` does not validate uniqueness against existing rows.
  Pre-existing; became visible because mocha no longer bails at 10.5.1.
- `fix/fd-partial-unique-index-treated-as-unconditional-key.md` —
  `tableSchemaToRelationType` ignores `uc.predicate` so the FD/keys layer
  treats every partial UNIQUE as an unconditional key. Independent of the
  run-time enforcement fix in this ticket but discovered while reviewing the
  partial-UNIQUE surface area.

### Disposition

No major findings. Minor doc update applied inline
(`docs/design-isolation-layer.md`). Validation re-run: lint clean,
`yarn test:store` shows 587 passing with only the pre-existing 102.1
failure (separately ticketed). Ready to complete.
