description: Inside a transaction on an isolated (store-backed) table, changing a UNIQUE column on a row that was itself written earlier in the same transaction is never checked against already-committed rows, and a primary key's own conflict action wrongly leaks onto the UNIQUE column — producing duplicates, commit-time internal errors, silently deleted rows, or silently dropped rows depending on the backend and the declared conflict action.
architecture: docs/design-isolation-layer.md#cross-layer-constraint-detection
files:
  - packages/quereus-isolation/src/isolated-table.ts                 # update(), 'update' case, existingOverlayRow && !pkChanged arm (~L1315 "Same PK — update the overlay row in place"); checkMergedUniqueConstraints ~L1850; compileFor ~L1507
  - packages/quereus/src/schema/unique-enforcement.ts                # home for a shared uniqueColumnsChanged helper
  - packages/quereus/src/index.ts                                    # re-export (~L226, next to uniqueEnforcementComparators)
  - packages/quereus-store/src/common/store-table-constraints.ts     # uniqueColumnsChanged ~L231 — switch to shared helper
  - packages/quereus/src/vtab/memory/layer/manager.ts                # uniqueColumnsChanged ~L1242 — switch to shared helper (keep its NOTE)
  - packages/quereus-isolation/test/isolation-layer.spec.ts          # regression pins next to the PK-REPLACE pins (~L663-708)
  - packages/quereus/test/logic/47.2.1-pk-replace-secondary-unique.sqllogic   # or a new sibling file — runs under yarn test:store through the isolation layer
  - docs/design-isolation-layer.md                                   # § Cross-Layer Constraint Detection
repro: verified
----

# Isolation layer: same-PK UPDATE of an overlay-resident row skips the merged UNIQUE check

## Background

`IsolatedTable.update` (`packages/quereus-isolation/src/isolated-table.ts`) stages a transaction's writes in a private in-memory **overlay** table and flushes them to the underlying table at commit with `trustedWrite` (the underlying skips its own UNIQUE re-check, trusting the isolation layer's merged-view pre-check). Every write arm calls `checkMergedUniqueConstraints` — which searches overlay rows **and** committed underlying rows — before writing the overlay. One arm does not: an UPDATE whose target row is already live in the overlay and whose primary key is unchanged. It calls `overlay.update({...argsForOverlay, ...})` directly.

Two defects at that one site:

1. **No merged check.** The overlay's own memory module only sees overlay rows, so a collision with a committed underlying row is never detected.
2. **PK action leaks onto UNIQUE.** `argsForOverlay.onConflict` folds the primary key's `on conflict` default in as if it were a statement OR clause, so the overlay's memory module applies the PK's action to every secondary UNIQUE too.

## Reproduction (verified with a scratch isolation spec, memory underlying, `using isolated`)

| table | committed | in txn | observed | expected |
|---|---|---|---|---|
| `(id int pk, v text unique)` | `(2,'b')` | `insert (1,'a'); update t set v='b' where id=1` | update succeeds; COMMIT throws `Isolation flush insert ... invariant violation` | update raises `UNIQUE constraint failed: t (v)` |
| `(id int pk on conflict replace, v text unique)` | — | `insert (1,'a'),(2,'b'); update t set v='b' where id=1` | no error; commit leaves `[(1,'b')]` — row 2 silently deleted | UNIQUE error (v keeps default ABORT) |
| `(id int pk, v text unique on conflict ignore)` | `(2,'b')` | `insert (1,'a'); update t set v='b' where id=1` | commit leaves `[(2,'b')]` — row 1 silently **lost** (flush insert ignored by the underlying) | update skipped; `[(1,'a'),(2,'b')]` |
| `(id int pk, v text unique on conflict replace)` | `(2,'b')` | `insert (1,'a'); update t set v='b' where id=1` | `[(1,'b')]` — right rows, but only because the underlying evicted at flush; no `evictedRows`, so FK cascades / change events for row 2 never run | `[(1,'b')]` with row 2 reported via `evictedRows` |

Over a store underlying (`QUEREUS_TEST_STORE=true`, scratch sqllogic of row 1) the commit stores both rows with `v = 'b'` (verified by the fix-stage filer).

Note: `update or <action>` is intentionally unsupported by the parser (see `47.2-replace-and-or-clauses.sqllogic` §5), so IGNORE/REPLACE on an UPDATE can only come from a constraint-level `on conflict` default — pins must use those.

## Fix

In the `existingOverlayRow && !pkChanged` arm:

- Before the overlay write, when a UNIQUE column (or a column referenced by a partial-UNIQUE predicate) changed between `existingOverlayRow.slice(0, tombstoneIndex)` and `coercedValues`, run `checkMergedUniqueConstraints(overlay, coercedValues!, [targetPK], tombstoneIndex, args.onConflict, evicted)` — the **original** `args.onConflict`, so each UNIQUE resolves statement OR > its own default > ABORT. Return its result if non-null; on success return through `attachEvicted(...)` like the sibling arms.
- That alone fixes defect 2: once the merged check has passed or REPLACE-tombstoned the conflicting row, the overlay sees no UNIQUE conflict, so the PK-folded action it is handed has nothing to act on (a same-PK update cannot conflict on the PK). Keeping `argsForOverlay` for the overlay write is fine; passing plain `args` is also fine — pick one and comment why.
- The gate matters: `checkMergedUniqueConstraints` scans the whole overlay per UNIQUE constraint (Phase 1), so ungated, a bulk `update t set <non-unique col> = ...` over N rows staged in the txn costs O(N²) overlay scans.

### Share `uniqueColumnsChanged` instead of writing a third copy

Memory (`manager.ts` ~L1242) and store (`store-table-constraints.ts` ~L231) each have their own; they differ only in how they obtain a partial predicate's referenced columns. Proposed shape in `packages/quereus/src/schema/unique-enforcement.ts`, re-exported from `src/index.ts`:

```ts
export function uniqueColumnsChanged(
	uniqueConstraints: ReadonlyArray<UniqueConstraintSchema> | undefined,
	oldRow: Row,
	newRow: Row,
	predicateColumns: (uc: UniqueConstraintSchema) => Iterable<number> | undefined,
): boolean
```

Memory passes its `findIndexForConstraint`/`compilePredicate` lookup; store and isolation pass `uc => this.compileFor(uc)?.referencedColumns`. Keep memory's existing NOTE (BINARY `compareSqlValues` over-triggers for semantic-ordering columns — gate-only, correct) on the shared helper.

### Class-level follow-up

This is the third arm of `IsolatedTable.update` found skipping the merged check (tombstone revival, PK-REPLACE over a live overlay row, now this). A class-level differential test is filed separately as `debt-isolation-write-arm-differential-test` (backlog). If restructuring `update()` so every arm funnels through one "merged checks, then overlay write" step falls out naturally while fixing this, do it; otherwise don't expand scope.

## TODO

- Add shared `uniqueColumnsChanged` to `unique-enforcement.ts`, export from `@quereus/quereus` index; switch memory and store to it (behaviour unchanged).
- In the same-PK overlay-row UPDATE arm: gate on the shared helper, run `checkMergedUniqueConstraints` with `args.onConflict`, collect `evicted`, return via `attachEvicted`.
- Isolation spec pins (`isolation-layer.spec.ts`, near ~L663–708): the four rows of the repro table — ABORT vs committed row (throws CONSTRAINT, commit leaves table consistent), PK-level REPLACE + plain UNIQUE between two overlay rows (throws, nothing deleted), UNIQUE `on conflict ignore` (row 1 keeps `'a'`), UNIQUE `on conflict replace` (committed row evicted; assert `evictedRows` via a direct `IsolatedTable.update` call or an FK child with `on delete cascade` disappearing).
- Also pin a non-UNIQUE-column update over an overlay row still succeeding (gate doesn't wrongly block), and a partial-UNIQUE case where only the predicate column changes, moving the row into scope onto a committed duplicate.
- sqllogic pin (memory + `yarn test:store`): add a section to `47.2.1-pk-replace-secondary-unique.sqllogic` or a new sibling file with the ABORT, PK-REPLACE-leak, IGNORE and REPLACE (with FK cascade child) cases inside `begin; ... commit;`.
- Update `docs/design-isolation-layer.md` § Cross-Layer Constraint Detection: state that every overlay write arm, including the same-PK update of an overlay-resident row (gated on a UNIQUE-relevant column change), runs the merged check, and that the merged check always uses the statement's OR, never the PK-folded action.
- Run `yarn workspace @quereus/isolation test`, `yarn workspace @quereus/store test`, `yarn workspace @quereus/quereus test`, `yarn test:store` (or at least the touched sqllogic file in store mode), and `yarn workspace @quereus/quereus lint`.
