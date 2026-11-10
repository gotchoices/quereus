description: Make the persistent store's planner check which collation each filter compares under before offering an index for it, so it stops offering index plans for case-insensitive (or otherwise mismatched) filters that the engine then throws away. The in-memory table module already does this.
prereq: predicate-constraint-carries-comparison-collation
architecture: docs/module-authoring.md
files: packages/quereus-store/src/common/store-module-access-plan.ts, packages/quereus/src/vtab/best-access-plan.ts, packages/quereus/src/vtab/memory/module.ts, packages/quereus/src/index.ts, docs/module-authoring.md, docs/optimizer-retrieve.md, packages/quereus/src/planner/rules/access/rule-select-access-path.ts (comment on `orderingClaimSurvivesCollation` only), packages/quereus-store/test/pushdown.spec.ts (pattern for direct `getBestAccessPlan` calls)
----

## Background

Every filter the engine hands a table module in `getBestAccessPlan` now carries `PredicateConstraint.collation`: the normalized collation the comparison runs under (`'NOCASE'` for `b = 'x' collate nocase`, or for a plain `b = 'x'` on a column declared `collate nocase`). Absent means BINARY. The memory module reads it (landed in `predicate-constraint-carries-comparison-collation`). The store module (`StoreModule.getBestAccessPlan` → `computeBestAccessPlan` in `store-module-access-plan.ts`) still treats `b = 'x' collate nocase` as an ordinary equality on `b`.

Answers are already right: `rule-select-access-path`'s `classifyCollationCover` declines a mismatched seek to a scan plus residual, and `orderingClaimSurvivesCollation` refuses a mismatched ordering claim. The cost is plan quality. The store costs the plan as the seek it described, that plan can win against cheaper alternatives (another index, the primary-key range, a different join order), and the engine then rebuilds it as a full scan.

## The rule (from docs/module-authoring.md)

Let `C` be the collation of the key column a filter would use: `normalizeCollationName(keyCol.collation ?? 'BINARY')`, where `keyCol` is the `IndexColumnSchema` entry. Secondary indexes use `index.columns[i]`. The primary key uses `tableInfo.primaryKeyDefinition[i]`, the same type, which `rederivePrimaryKeyCollations` keeps equal to the column's collation after `reconcilePkCollations` rewrites an undecorated text PK to the table key collation K. This is exactly the collation the engine's index descriptor reports, so the store agrees with the engine's decline by construction.

- **Equality** (`=`, literal `IN`, runtime-set `IN`) fills an equality role (pins the column, seeds a seek key, counts toward a multi-seek) only when `collationRefines(f.collation ?? 'BINARY', C)`. That means the predicate is BINARY, or its collation equals `C`. A BINARY equality over a coarser `C` is the engine's `COARSER_SAFE` case: the store claims it, and the engine keeps the seek and adds a residual.
- **Range bound** (`>`, `>=`, `<`, `<=`) is served on that column only when `normalize(f.collation ?? 'BINARY') === C`. The store already advertises `honorsCollatedRangeBounds`, so an equal non-BINARY collation is a `MATCH`.
- **Positional pick.** The rule picks the FIRST equality, the FIRST lower bound and the FIRST upper bound on every column the module marks handled. So:
  - If a column's first equality fails, that column fills **no** role on this key: no equality, and no range either. The rule's `eqBySeekCol` takes the first `=`/IN on any handled column, so a range offered beside an unserved equality would be built as that equality's seek and then declined.
  - If the first lower or first upper bound present fails, offer no range on that column at all. Claiming one side would make the rule build the other side too.
  - A later filter that would pass is never claimed in place of a failing first one. It stays unhandled and becomes a residual.
- Collation does not gate OR_RANGE here, because the store never claims OR_RANGE (`RANGE_OPS` excludes it). Leave that as is.

## Design

### Share the two predicates with the memory module (DRY)

Move the memory module's private `equalityServesIndexColumn` / `rangeServesIndexColumn` (and their `indexColumnCollation` / `filterCollation` helpers) from `packages/quereus/src/vtab/memory/module.ts` into `packages/quereus/src/vtab/best-access-plan.ts`, next to `equalitySeekKeyCount` / `isMultiValueEquality`. Export them from `src/index.ts` in the same export block:

```ts
/** Whether equality `f` may seek / pin key column `keyCol` (collationRefines over normalized names). */
export function equalityServesKeyColumn(f: PredicateConstraint, keyCol: Pick<IndexColumnSchema, 'collation'>): boolean;
/** Whether range bound `f` may be walked on key column `keyCol` (normalized names equal). */
export function rangeServesKeyColumn(f: PredicateConstraint, keyCol: Pick<IndexColumnSchema, 'collation'>): boolean;
```

The names say "key column" because primary-key definitions qualify too. Have the memory module call the exported pair and delete its private copies. Its `firstEqualityFilter` / `blockedByUnservedEquality` stay private, because they also test `f.usable`, which the store does not. Check that `best-access-plan.ts` importing `collationRefines` / `normalizeCollationName` from `util/comparison.js` creates no import cycle (`comparison.ts` imports types, errors and json-canonical only). In `docs/module-authoring.md`'s `PredicateConstraint` bullets, name the two helpers as the ready-made form of the rule; `collationRefines` stays exported.

### Store: one positional finder, then the gates

In `store-module-access-plan.ts`:

- **`resolveEqualityPins(filters, keyColumns)`** takes the key column specs (`readonly IndexColumnSchema[]`: `index.columns` or `primaryKeyDefinition`) instead of bare `colIdxs`. For each key column, take the first filter with `f.columnIndex === keyCol.index && equalitySeekKeyCount(f) !== null`, as today. Break the run when it is missing **or** `!equalityServesKeyColumn(pin, keyCol)`. The returned `cols` stay column indexes, so every downstream consumer (claiming, `resolveArmEstimate`, `buildIndexOrderingAdvertisement`'s pinned set, `seekCols`) is gated automatically.
  - `resolvePrimaryKeyPins(filters, pkColumns)` → pass `tableInfo.primaryKeyDefinition`. It keeps the "whole key or null" rule. A failing PK member makes the pins null, and the request falls through to the leading-PK range and the secondary indexes. A secondary index on the same column under a matching collation (`create index ix on t (id collate nocase)`) can then serve it, with no special handling needed.
  - The secondary arm passes `index.columns`.
- **`rangeServedOn(filters, keyCol): boolean`** (new). True when the column has at least one lower or upper bound, its first equality (if any) passes `equalityServesKeyColumn`, and the first lower bound and first upper bound that are present both pass `rangeServesKeyColumn`. "First" uses the same `ops.includes(f.op)` pick that `claimFirstPerRole` and `rangeBoundSelectivity` use. Use it at the three sites that today ask only "is there a range op on this column":
  - `tryIndexAccessPlan`'s `hasLeadingRange` (on `index.columns[0]`);
  - `tryIndexAccessPlan`'s `trailingRangeCol` test (on `index.columns[eqCols.length]`). When the equality run stopped at that column because its first equality failed, this returns false, and the arm stays `eq` on the prefix;
  - `leadingPkRangePlan`'s guard (on `primaryKeyDefinition[0]`).
- Consider one shared `firstRoleFilter(filters, colIdx, ops)` finder used by `claimFirstPerRole`, `resolveEqualityPins`, `rangeBoundSelectivity` and `rangeServedOn`, so the positional pick is stated once. Do it if it falls out cleanly; it is not required.
- **A predicate-collation decline returns `null` from `tryIndexAccessPlan`** (the index cannot serve this predicate), **not** `costOnly(...)`. A cost-only plan advertises the arm's cheaper shape for what is really a sequential scan, which is the misleading cost this ticket removes. The existing key-collation cost-only declines (`indexPrefixSeekIsCollationExact`, `indexRangeAtPositionIsOrderSafe`) stay as they are. They ask a different question: whether the index's key bytes agree with its residual comparator. Say so in the doc comment's "Collation safety" section, which should now name three gates: predicate collation, then the two key-byte gates.

### Comments to rewrite

- The PK-arm block in `computeFilterAccessPlan` (~line 586–610). Keep the first half, but retitle it as being about **key-byte** collation ("No key-collation gate…"), because its two reasons are about key bytes against the residual. Replace the "one divergence neither reason covers is PREDICATE-side and invisible from here" paragraph with a short statement that `resolvePrimaryKeyPins` / `leadingPkRangePlan` now gate on `PredicateConstraint.collation` against `primaryKeyDefinition[].collation`, the collation the engine's `_primary_` descriptor reports. Keep the sentence about `setSeekColumns` being load-bearing only if it still holds for its other reason (the single-element IN).
- `resolveEqualityPins`' doc: add the collation stop. Add a `NOTE:` tripwire matching the memory module's: `b = 'x' collate nocase and b = 'x'` over a BINARY `b` offers no seek, although the second equality could seek, because only the first equality per column counts (the rule seeks the first). Revisit if the shape appears in real queries.
- **`NO_PINNED_COLUMNS` stays empty** (decision below). Rewrite its comment. The collation argument it gives is now answerable from `PredicateConstraint.collation`, so that is no longer the reason. The reason now is that the pinning would buy almost nothing:
  - The only primary-key shape where pinning changes the plan is an equality on a leading strict prefix of a composite key (`where a = ? order by b` over `primary key (a, b)`). That shape is better served by a primary-key prefix seek, which the store does not offer yet (backlog `feat-store-primary-key-prefix-equality-seek`).
  - For a secondary index, the walk with a pinned column could only win when that same index's own equality seek lost or was vetoed. The seek reads a subset of what the walk reads, so in that case the walk is worse than the seek it would replace. The underlying issue is that the seek-versus-scan veto ignores the sort the scan forces.
  - Record the revisit condition: if the primary-key prefix seek lands and the veto starts counting the sort, this can stay empty for good. If a store plan is ever seen sorting after a residual equality that a walk could have pinned, pin with `equalityServesKeyColumn` (single-valued equalities only, `!isMultiValueEquality`), as `MemoryTableModule.collectEqualityBoundColumns` does.
- `orderingPrefixSatisfies`' comment ("the ordering walk and the primary-key arms pin nothing") stays true. Re-read it after the edit.
- `docs/optimizer-retrieve.md` ~line 90 "(the memory module reads it; the store does not yet)" → both read it. `rule-select-access-path.ts` `orderingClaimSurvivesCollation` doc ("The memory module reads the field…") → name both bundled modules; the backstop remains for third-party modules.

## Decision: ordering-only walks keep pinning nothing

The plan ticket left open whether `NO_PINNED_COLUMNS` (the pinned set for `chooseOrderingPlan`'s ordering-only index walk and for `buildPkOrderingAdvertisement`) should pin refining equalities, as the memory module does. It should not, for the reasons in the comment rewrite above. Pinning there makes ordering claims that rest on a residual `Filter`, which adds wrong-order risk for a gain that a primary-key prefix seek delivers better. The rejected alternative was a pinned set derived per key via `equalityServesKeyColumn` and passed at the three `NO_PINNED_COLUMNS` call sites. It is reversible with no stored-state consequences.

## Edge cases & interactions

- **Filter with no `collation`** (hand-built requests in tests, an older engine) → BINARY. On a NOCASE key column, a BINARY equality still refines (claimed, engine adds a residual), but a BINARY **range** no longer matches. Existing store specs that hand-build range filters on a text column whose collation is not BINARY (for example a text PK under the default NOCASE K) will lose their range plan. Fix those requests by stamping the collation the engine would stamp; do not loosen assertions. Found by running the specs.
- **Text PK under default K (NOCASE):** `id = 'x'` (stamped NOCASE) → point lookup; `id = 'X' collate binary` → still a point lookup (refines; engine residual); `id = 'x' collate rtrim` → no `_primary_` plan. Test (below).
- **Unserved equality beside a range on the same column** (`b = 'x' collate nocase and b > 'a'` over BINARY `ix_b`) → `ix_b` offers nothing. Test.
- **Prefix-range whose trailing column fails** (`a = 1 and b > 'm' collate nocase` over `ix_ab(a, b)` with BINARY `b`) → `eq` arm on `[a]`, bound unclaimed. Covered by the `rangeServedOn` site; verify by inspection or fold into the range test.
- **Composite PK with a failing later member** → pins null, fall-through; no partial PK point plan. By inspection: `resolvePrimaryKeyPins` keeps its whole-key rule.
- **Multi-seek (`IN`) under a coarser collation** → no multi-seek on that index, and no `_primary_` multi-seek. Same gate as `=`; by inspection.
- **Runtime-set probes** from `rule-key-set-seek` carry the join collation. When the store now declines one, the engine's own lattice (`classifyConstraintCover`, `MISMATCH_UNSAFE`) would have declined it as well, so the rewrite outcome is unchanged. `seekSurvivesVeto`'s runtime-set exemption is untouched. Verify by inspection, and by `key-set-seek-store.spec.ts` and `runtime-key-set-plan.spec.ts` staying green.
- **Ordering advertisements** follow `eqCols`, so a coarser equality no longer pins a column for `buildIndexOrderingAdvertisement`. `where b = 'x' collate nocase order by c` over BINARY `(b, c)` makes no claim on that index. Test (fold into the first case).
- **Stats-backed estimates** (`resolveArmEstimate`, `rangeBoundSelectivity`) only run for arms that passed the gates, so a measured factor never prices a bound the arm does not serve. By inspection.
- **Collation-blind / never-text columns** (`json`, temporal types, integer): the engine compares against the same `IndexColumnSchema.collation`, so the store matches it whatever the key bytes are. The key-byte gates still run after. By inspection.
- **Isolation layer** forwards filter objects unchanged (checked by reading in the prereq), so `quereus-isolation` over the store picks this up with no change.
- **`f.usable`**: the store does not test it today, and this ticket does not change that.

## Tests

The default is no new test; these pin new branching logic. Add one spec, `packages/quereus-store/test/access-plan-predicate-collation.spec.ts`, calling `storeModule.getBestAccessPlan` directly. Copy the `planFor` helper pattern in `pushdown.spec.ts` ("row-resolution cost and the seek-versus-scan comparison"). Use table-driven cases with `collation` set explicitly on each filter:

- `t(id integer primary key, b text, c integer)`, `create index ix_bc on t (b, c)` (BINARY): `b = 'x'` NOCASE → `indexName !== 'ix_bc'`, `handledFilters[0] === false`, and with `requiredOrdering: [{columnIndex: c}]` no `providesOrdering`. The same with BINARY → `indexName === 'ix_bc'`, handled, ordering on `c` claimed. (This mirrors `packages/quereus/test/vtab/memory-access-plan-collation.spec.ts` and is the regression for this ticket.)
- Range on BINARY `ix_b`: `b > 'm'` NOCASE → no `ix_b` range; BINARY → `ix_b` range. Also `[b = 'x' NOCASE, b > 'a' BINARY]` → no `ix_b` plan.
- Text PK under default K: `id = 'x'` RTRIM → `indexName !== '_primary_'`; NOCASE → `_primary_` point lookup.

No engine-side test changes are expected. `packages/quereus/test/vtab/memory-access-plan-collation.spec.ts` must stay green after the helper move.

## Validation

- `yarn workspace @quereus/quereus run lint` (the helper move touches the engine).
- `yarn test` (all workspaces, including `@quereus/store` specs).
- `yarn test:store` — the engine's sqllogic suite against the store. Plans change for collated predicates but results must not. The prereq ran it at about 11,100 passing, so it is agent-runnable; stream it in the foreground.
- Plan check by hand: on a store table with BINARY `ix_bc(b, c)` and a few hundred rows, `where b = 'x' collate nocase` should now get no `ix_bc` offer (a scan plus Filter, with no "Declining index seek" debug log from the rule), and `where b = 'x' order by c` should still seek `ix_bc` with no Sort.

## TODO

- Move `equalityServesIndexColumn` / `rangeServesIndexColumn` (renamed `equalityServesKeyColumn` / `rangeServesKeyColumn`) into `vtab/best-access-plan.ts`, export them from `src/index.ts`, and switch the memory module to them.
- Store: change `resolveEqualityPins` to take key column specs and stop at a non-refining first equality; update `resolvePrimaryKeyPins` and the `tryIndexAccessPlan` callers.
- Store: add `rangeServedOn` and use it at `hasLeadingRange`, `trailingRangeCol` and `leadingPkRangePlan`.
- Store: make sure a predicate-collation decline yields `null`, not cost-only; update `tryIndexAccessPlan`'s "Collation safety" doc.
- Rewrite the PK-arm comment block, the `resolveEqualityPins` doc (plus `NOTE:` tripwire), and the `NO_PINNED_COLUMNS` comment (decision + revisit condition).
- Update `docs/module-authoring.md` (name the helpers), `docs/optimizer-retrieve.md` (~line 90) and the `orderingClaimSurvivesCollation` doc comment.
- Add `access-plan-predicate-collation.spec.ts`; fix any hand-built store spec requests that relied on absent-collation ranges over non-BINARY text columns.
- Run lint, `yarn test`, `yarn test:store`, and the hand plan check.
