description: Tell table modules which collation each filter comparison uses, so the memory module stops offering index plans for case-insensitive filters that the planner will reject, and so the planner stops choosing plans on the strength of those rejected offers.
architecture: docs/module-authoring.md
files: packages/quereus/src/vtab/best-access-plan.ts, packages/quereus/src/planner/analysis/constraint-extractor.ts, packages/quereus/src/planner/analysis/comparison-collation.ts, packages/quereus/src/planner/rules/access/rule-select-access-path.ts, packages/quereus/src/planner/rules/join/index-nested-loop.ts, packages/quereus/src/planner/rules/access/rule-key-set-seek.ts, packages/quereus/src/vtab/memory/module.ts, packages/quereus/test/vtab/runtime-key-set-protocol.spec.ts (pattern for direct memory-module `getBestAccessPlan` tests), packages/quereus/test/planner/constraint-extractor.spec.ts, packages/quereus/test/logic/06.4.2.1-collation-index-access-paths.sqllogic, docs/module-authoring.md, docs/plugins.md, docs/optimizer-retrieve.md
----

Split from the fix ticket `bug-collated-equality-keeps-an-ordering-claim-the-plan-cannot-serve`; the correctness half landed as `collation-checks-resolve-the-chosen-index-like-the-rest-of-the-planner`. Nothing here is needed for correct answers; it is plan quality and the module contract.

## Problem

Constant folding turns `'x' collate nocase` into a literal whose type carries NOCASE, so `b = 'x' collate nocase` reaches a module's `request.filters` as a plain `=` on `b`. `PredicateConstraint` (`vtab/best-access-plan.ts:82`) has no collation field, and the rules that would let a module work it out from `sourceExpression` are planner-internal. So the memory module:

- offers a seek of a BINARY index for a NOCASE equality, which `rule-select-access-path` then declines (`MISMATCH_UNSAFE`) to a sequential scan plus re-check;
- treats the column as pinned to one value (`collectEqualityBoundColumns`, `vtab/memory/module.ts:207`) and claims the index delivers `order by` on the next key column, which `orderingClaimSurvivesCollation` then refuses. `buildMonotonicAdvertisement`, `adjustPlanForOrdering` and `evaluateOrderingOnlyPlans` all share that pinned set.

Observed at HEAD on a 305-row memory table with `idx_bc(b, c)`: `rule-grow-retrieve` accepted the index plan for `where b = 'x' collate nocase` at the module's seek cost 30.5 against 1000 for a scan, then physical selection replaced the seek with a full scan.

## Design

### The field

`PredicateConstraint` (vtab, public) gains:

```ts
/**
 * Normalized collation the comparison runs under at runtime (e.g. 'BINARY', 'NOCASE').
 * Absent means BINARY. Advice for the module: the engine re-checks collation itself.
 */
readonly collation?: string;
```

The planner's `PredicateConstraint` (`constraint-extractor.ts:56`, which extends the vtab one) redeclares it **required**: `readonly collation: string`. Every planner constraint is minted in `constraint-extractor.ts`, so the type makes a mint site that forgets the field a compile error. (Narrowing optional → required in an `extends` is legal TypeScript.)

### Where it is computed: at mint, per shape

Decision: compute once where constraints are minted, not where requests are built. Every request site (`rule-select-access-path.ts:271`, `rule-grow-retrieve.ts:906`, `index-nested-loop.ts` via `extractConstraints`, `access-leaf.ts`) passes the planner constraint objects straight through as `filters`, so a value stamped at mint reaches every module with no per-site work, and `IndexSeekNode.pushedConstraints` (spread copies) carries it too. Computing at request-build time would need the same resolution repeated at four sites.

Each mint site knows its own shape, so it calls the lattice helper in `analysis/comparison-collation.ts` directly — the same helpers `effectivePredicateCollation` (`rule-select-access-path.ts:1541`) calls today:

| Mint site | `collation` |
|---|---|
| `extractBinaryConstraint` (`col op value`, incl. flipped) | `effectiveComparisonCollation(expr.left, expr.right)` |
| `extractBetweenConstraints`, `>=` constraint | `effectiveBetweenBoundCollation(expr.expr, expr.lower)` |
| `extractBetweenConstraints`, `<=` constraint | `effectiveBetweenBoundCollation(expr.expr, expr.upper)` |
| `extractInConstraint` | `effectiveInCollation(expr)` |
| `extractNullConstraint` (IS NULL / IS NOT NULL) | `operandCollation(expr.operand)` — a null test compares nothing; the column's own collation is the honest "what it is compared under" and no consumer reads it for null tests |
| `collapseBranchesToIn`, `tryCollapseToOrRange` (OR collapse) | `operandCollation` of the column side — `orBranchConstraintCollationOk` has just proved every branch's effective collation equals it. Take it from the first branch constraint (`template.collation` / the first branch's `collation`), which equals it post-gate |

These helpers throw only on a same-rank collation conflict, which plan-time validation (`BinaryOpNode.generateType`, `InNode.generateType`) already rejects; `orBranchConstraintCollationOk` already calls them at extraction time, so stamping at mint adds no new throw point.

### The engine reads its own stamp

- Delete `effectivePredicateCollation` from `rule-select-access-path.ts`; its two call sites there (`orderingClaimSurvivesCollation`, `classifyCollationCover`) read `constraint.collation`. Move its doc comment's lattice explanation to the field's doc on the planner interface.
- `index-nested-loop.ts` `equalityRefinesKey` reads `constraint.collation`. Its source-shape gate (`instanceof BinaryOpNode`) existed only because the old resolver answered BINARY — the strongest claim — for an unrecognised shape. With a per-site stamp there is no default, so drop the gate and rewrite the comment to say why it is no longer needed.
- Retire the "Reviewer note … optional follow-up" paragraph in `tryExtractOrBranches` (`constraint-extractor.ts:726-732`): collapsed constraints now carry their exact collation, so the cover check is precise rather than conservative.
- "Not something the engine trusts": no engine check depends on a module's answer about collation. The engine reads the value it stamped on its own constraint object; the field is `readonly` on the public interface so a TypeScript module cannot reassign it.

Behaviour change from the OR-collapse precision (intended, needs the logic test below): on a NOCASE column with a NOCASE index, `name = 'a' or name = 'B'` used to classify as BINARY-over-NOCASE (`COARSER_SAFE`, seek + residual) and now classifies `MATCH` (seek, no residual); `name < 'b' or name > 'x'` used to decline (`MISMATCH_UNSAFE`) and is now `MATCH` for a module advertising `honorsCollatedRangeBounds` (memory and store both do). Both must still return the right rows.

### `rule-key-set-seek` probe

`probeModuleCosts` (`rule-key-set-seek.ts:382`) mints vtab constraints with `runtimeSet`. Compute `joinCollation` (now at line ~480, `effectiveCollationOfTypes(cols.targetType, cols.keyType)` normalized) before the probe and stamp it on `runtimeSetFilter` so "every constraint the engine sends carries it" holds. The later `classifyConstraintCover` check stays.

### Memory module

The pinning and seek-offer rule, using the index column's collation `normalizeCollationName(indexCol.collation ?? 'BINARY')` (the same value `resolveIndexKeyCollations` reads off the descriptor; the PK pseudo-index from `gatherAvailableIndexes` carries `primaryKeyDefinition[].collation`) and the filter's `f.collation ?? 'BINARY'`:

- **Equality pins / seeks** when `collationRefines(f.collation ?? 'BINARY', indexColColl)` (`util/comparison.ts:166`) — predicate BINARY, or equal to the index column. This is exactly the set `classifyConstraintCover` accepts for equality (MATCH or COARSER_SAFE), so the module's offers and the rule's acceptance agree.
- **Range / OR_RANGE** is offered when `f.collation ?? 'BINARY'` equals `indexColColl` (the memory module honours collated range bounds, so that is exactly `classifyConstraintCover`'s range MATCH).

Positional contract: `rule-select-access-path` picks the FIRST role-filling filter on a column whenever any filter on that column is handled (`handledByCol`, line ~549). So the module must not skip a non-refining first filter and claim a later refining one on the same column — the rule would seek on the first and decline. Rule: per column and role, look only at the first filter that fills the role (as today); if it fails the collation test, the column fills no role on this index (equality: stop the prefix there; range: if the first lower or the first upper bound fails, offer no range on that column). The filter stays unhandled and becomes a residual.

Concretely:

- `collectEqualityBoundColumns(filters, index)` becomes per index: the columns of `index` pinned by a usable single-valued equality whose collation refines that index column's. Callers: `buildMonotonicAdvertisement` (pass `usedIndex`), and the ordering path — `indexSatisfiesOrdering` computes the pinned set for the index it is given instead of taking `equalityCols` as a parameter; `adjustPlanForOrdering` and `evaluateOrderingOnlyPlans` stop computing a table-wide set. `nullSafeOrderingPrefixLength` receives the per-index set.
- `findEqualityMatches`, `findRangeMatch`, `findOrRangeMatch` apply the test above against the index column they are matching.
- Choose "not offered" over "priced as a scan": an unoffered filter lets another index, or a scan, win honestly, and needs no new pricing arm.

### Docs

- `docs/module-authoring.md`: document `collation` beside the other `PredicateConstraint` fields (there is no field list there today — add a short `PredicateConstraint` interface block next to `BestAccessPlanRequest` at line ~150), with the pinning rule (`collationRefines(constraint.collation ?? 'BINARY', indexColumnCollation)`), the range rule, the first-filter-per-role caveat, and that absent means BINARY. Rewrite the line-222 sentence "…because you cannot see a predicate's collation" — modules now can; the engine still checks.
- `docs/plugins.md:1493` `interface PredicateConstraint`: add the field.
- `docs/optimizer-retrieve.md:90`: same "cannot see a predicate's collation" wording — update.
- Comment in `orderingClaimSurvivesCollation` (`rule-select-access-path.ts:1602`, "A module cannot see a predicate's collation…"): reword — a module can now, the engine's check stays as the backstop for modules that ignore the field.

## Edge cases & interactions

- **Older/third-party modules that ignore the field**: behave exactly as today; the engine's checks still decline mismatched seeks and ordering claims. Verified by the existing `test/vtab/access-path.spec.ts` collation cases (wrapper modules) staying green.
- **`isolation` module** (`quereus-isolation`) forwards `getBestAccessPlan` to the underlying module with the same filter objects — the field flows through. Inspection.
- **Store module** still ignores the field — parked as backlog `feat-store-access-plan-reads-predicate-collation`. Its existing comment at `store-module-access-plan.ts:588` ("`PredicateConstraint` carries no collation") becomes inaccurate; change it to say the field exists and the store does not read it yet, pointing at the backlog ticket.
- **BETWEEN with a collated bound only**: `b between 'a' collate nocase and 'm'` — the two constraints carry different collations (NOCASE / column's). Covered by the extractor test.
- **Two equalities on one column with different collations** (`b = 'x' collate nocase and b = 'x'`): the module looks only at the first; if it is the NOCASE one, no seek on BINARY `b` even though the second could seek. Accepted (contrived); add a `NOTE:` at `findEqualityMatches`.
- **COARSER_SAFE equality (BINARY predicate over NOCASE index)** pins the column: the residual keeps one exact value, and within one NOCASE group the next key column is still ordered. So `orderingClaimSurvivesCollation` accepts it and the module may claim ordering. Inspection against `classifyConstraintCover`.
- **Null tests** never pin and never seek; their stamped collation is unread. Inspection.
- **Multi-value IN / runtime set**: still never pins (unchanged `isMultiValueEquality` gate), collation test applies on top for seek offers.
- **Tests that hand-build planner constraints** (`test/planner/constraint-extractor.spec.ts`, `test/optimizer/index-nested-loop*.spec.ts`) mostly spread real constraints; any literal object must now supply `collation`. `yarn lint` in `packages/quereus` type-checks test files.
- **Collation names**: always normalized (`normalizeCollationName`) on both sides before comparison; the lattice helpers already return normalized names.

## Tests (only these)

- `test/vtab/runtime-key-set-protocol.spec.ts`-style direct call to `MemoryTableModule.getBestAccessPlan` (new `it`s in a memory-module collation spec, or a `describe` in an existing memory access-plan spec): table `t(id primary key, b text, c text)` with BINARY `idx_bc(b, c)`, filter `{ columnIndex: b, op: '=', value: 'x', usable: true, collation: 'NOCASE' }`, `requiredOrdering: [c asc]` → the plan neither seeks `idx_bc` (`handledFilters[0] === false`) nor claims `providesOrdering`. Same request with `collation: 'BINARY'` (control) → seeks `idx_bc` and claims ordering on `c`.
- `test/planner/constraint-extractor.spec.ts`: stamped `collation` for `b = 'x' collate nocase` (NOCASE over BINARY `b`), `b between 'a' and 'm' collate nocase` (lower = column's, upper = NOCASE), and an OR collapse on a NOCASE column (`n = 'a' or n = 'B'` → one `IN` with `collation: 'NOCASE'`).
- `test/logic/06.4.2.1-collation-index-access-paths.sqllogic`: NOCASE column with NOCASE index, rows differing only in case; `where n = 'a' or n = 'B'` and `where n < 'b' or n > 'x'` return the exact expected row sets (the OR-collapse precision change now seeks without a residual).

## TODO

- Add `readonly collation?: string` to vtab `PredicateConstraint`; redeclare as required `readonly collation: string` on the planner `PredicateConstraint` with the lattice doc.
- Stamp `collation` at every mint site in `constraint-extractor.ts` per the table; retire the OR-collapse reviewer note.
- Replace `effectivePredicateCollation` with `constraint.collation` in `rule-select-access-path.ts` and `index-nested-loop.ts`; delete the function and the INL source-shape gate; update comments.
- Stamp `joinCollation` on the `rule-key-set-seek` runtime-set probe filters.
- Memory module: per-index `collectEqualityBoundColumns`; collation tests in `findEqualityMatches` / `findRangeMatch` / `findOrRangeMatch`; `indexSatisfiesOrdering` derives its own pinned set; add the `NOTE:` for the first-filter caveat.
- Update the store comment at `store-module-access-plan.ts:588`.
- Docs: `module-authoring.md`, `plugins.md`, `optimizer-retrieve.md`.
- Write the three tests above; re-check the 305-row `idx_bc` observation (plan for `where b = 'x' collate nocase` no longer carries a 30.5 seek offer) by inspection of the plan.
- `yarn workspace @quereus/quereus run lint`, `yarn test`.
