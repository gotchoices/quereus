description: Tell table modules which collation each filter comparison uses, so the memory module stops offering index plans for case-insensitive filters that the planner will reject, and so the planner stops choosing plans on the strength of those rejected offers.
architecture: docs/module-authoring.md
files: packages/quereus/src/vtab/best-access-plan.ts, packages/quereus/src/planner/analysis/constraint-extractor.ts, packages/quereus/src/planner/rules/access/rule-select-access-path.ts, packages/quereus/src/planner/rules/join/index-nested-loop.ts, packages/quereus/src/planner/rules/access/rule-key-set-seek.ts, packages/quereus/src/vtab/memory/module.ts, packages/quereus/src/index.ts, packages/quereus-store/src/common/store-module-access-plan.ts, packages/quereus/test/vtab/_collation-blind-memory-module.ts, packages/quereus/test/vtab/memory-access-plan-collation.spec.ts, packages/quereus/test/planner/constraint-extractor.spec.ts, packages/quereus/test/logic/06.4.2.1-collation-index-access-paths.sqllogic, docs/module-authoring.md, docs/plugins.md, docs/optimizer-retrieve.md, docs/optimizer-fd.md
----

## What landed

`PredicateConstraint` (the filter a table module receives in `getBestAccessPlan`) now carries `collation?: string` — the normalized collation the comparison runs under; absent means BINARY. Before this, constant folding turned `b = 'x' collate nocase` into a plain `=` on `b`, so the memory module offered a seek of a BINARY index for it and claimed ordering on the next key column. The planner then threw both away (seek declined to scan + residual; ordering claim refused), but only after costing the plan as the seek.

- **Field.** Optional on the public vtab interface (`vtab/best-access-plan.ts`); redeclared **required** on the planner's `PredicateConstraint` (`constraint-extractor.ts`), so any new mint site that forgets it fails to compile. The planner field's doc now holds the lattice explanation that used to live on `effectivePredicateCollation`.
- **Stamped at mint** in `constraint-extractor.ts`: binary comparison → `binaryConstraintCollation` (new; `effectiveComparisonCollation` for comparison operators, pure resolution with a BINARY floor on conflict for LIKE/GLOB/MATCH — see "Deviations"), BETWEEN → each bound via `effectiveBetweenBoundCollation`, IN → `effectiveInCollation`, IS [NOT] NULL → `operandCollation`, OR collapse (IN and OR_RANGE) → the first branch's stamp (equal to the column's collation post-gate). The OR-collapse "reviewer note" is retired.
- **Engine reads its own stamp.** `effectivePredicateCollation` is deleted; `orderingClaimSurvivesCollation` and `classifyCollationCover` read `constraint.collation`. `index-nested-loop.ts` `equalityRefinesKey` reads it too, and its `instanceof BinaryOpNode` source-shape gate is dropped (comment says why).
- **Key-set probe.** `rule-key-set-seek` computes `joinCollation` before probing and stamps it on the synthesized runtime-set filters.
- **Memory module** (`vtab/memory/module.ts`), using the index column's `normalizeCollationName(indexCol.collation ?? 'BINARY')`:
  - equality seeks/pins only when `collationRefines(filterColl, indexColl)` (exactly what `classifyConstraintCover` accepts for equality);
  - range / OR_RANGE offered only when the collations are equal;
  - first-filter-per-role: `findEqualityMatches` stops the prefix at a column whose first equality fails; `findRangeMatch` offers no range if the first lower or first upper bound fails;
  - `collectEqualityBoundColumns(filters, index)` is per index; `indexSatisfiesOrdering` derives its own pinned set; `adjustPlanForOrdering` / `evaluateOrderingOnlyPlans` no longer take a table-wide set; `buildMonotonicAdvertisement` passes `usedIndex`.
- **Public export:** `collationRefines` is now exported from `@quereus/quereus` (`src/index.ts`) because `docs/module-authoring.md` tells module authors to call it.
- **Docs:** `module-authoring.md` gains a `PredicateConstraint` block plus the pinning / range / first-filter rules and the "engine still checks" note; the "you cannot see a predicate's collation" sentence is rewritten. `plugins.md`, `optimizer-retrieve.md`, `optimizer-fd.md` (two `effectivePredicateCollation` references) updated. Store comment at `store-module-access-plan.ts` now says the field exists and the store doesn't read it yet (backlog `feat-store-access-plan-reads-predicate-collation`).

## Deviations from the plan — please scrutinize

- **A column with an unserved equality fills no role at all, range included** (`blockedByUnservedEquality`). The ticket said "per column and role", but `rule-select-access-path`'s equality picker (`eqBySeekCol`, ~line 557) takes any `=` on a *handled column* regardless of which filter was handled. So for `b = 'x' collate nocase and b > 'a'` over BINARY `idx_b`, offering only the range would make the rule build the NOCASE equality's seek and decline it. Same reasoning applied to OR_RANGE and to the trailing range of a prefix-range seek.
- **LIKE / GLOB / MATCH collation conflict.** `BinaryOpNode.generateType` does not validate collation for LIKE (it applies none), so `a.x like b.y` with two different declared collations is legal SQL and is extracted as a correlated constraint. The throwing helper would have made extraction throw where nothing threw before, so non-comparison operators resolve purely and take BINARY on conflict. No consumer reads collation for these ops today except a third-party module's handled filter in `orderingClaimSurvivesCollation`, where BINARY behaves as before for the non-conflict case.
- **`pinned` uses "any refining single-valued equality"**, not first-only, per the ticket's wording. Consequence parked in the `NOTE:` at `findEqualityMatches`: in the contrived `b = 'x' collate nocase and b = 'x'` shape the module still pins `b` and may claim an ordering the engine refuses.

## Tests

New:
- `test/vtab/memory-access-plan-collation.spec.ts` — direct `getBestAccessPlan` on `t(id, b, c)` with BINARY `idx_bc(b, c)`: a NOCASE `b = 'x'` neither seeks (`handledFilters[0] === false`) nor claims `providesOrdering`; a BINARY one seeks `idx_bc` and claims ordering on `c`. This is the regression for the bug.
- `test/planner/constraint-extractor.spec.ts` — `stamped comparison collation` describe: `b = 'x' collate nocase` stamps NOCASE; `b between 'a' and 'm' collate nocase` stamps `>=` BINARY / `<=` NOCASE. The two existing "matched" OR-collapse tests now also assert the collapsed IN / OR_RANGE carries `NOCASE`.
- `test/logic/06.4.2.1-collation-index-access-paths.sqllogic` — NOCASE column + NOCASE index with case-variant rows; `n = 'a' or n = 'B'` and `n < 'b' or n > 'x'` return exact rows (now a seek with no residual — verified by inspecting `query_plan`). Passes in memory and store mode.

New helper: `test/vtab/_collation-blind-memory-module.ts` — the memory module with `collation` stripped from filters, i.e. a module that ignores the field. Used where a test's subject is the **engine's backstop** and the stock memory module no longer exercises it:
- `test/vtab/access-path.spec.ts` — `UpperCasedIndexNameModule` now extends it, so "keeps the sort … under a nocase equality over a binary index" still tests `orderingClaimSurvivesCollation` refusing the claim (its comment says the module claims the ordering — true again).
- `test/optimizer/pushed-constraints-recorded.spec.ts` "stamps nothing when a collation mismatch declines the seek" registers it, so the rule's decline-to-SeqScan arm is still exercised.

Adjusted (assertion relaxed from "SeqScan" to "no IndexSeek", since the memory module now offers no seek and the leaf is its ordered primary-key walk):
- `test/optimizer/range-seek-collation-bounds.spec.ts` "NOCASE predicate over a BINARY index falls back to scan + residual"
- `test/optimizer/secondary-index-access.spec.ts` "BINARY range over NOCASE index declines the reordered seek"

`test/optimizer/index-nested-loop-batched.spec.ts` `constraint()` helper now supplies `collation`; five literal constraints in `constraint-extractor.spec.ts` got `collation: 'BINARY'` for the required field.

## Validation run

- `yarn workspace @quereus/quereus run lint` — clean (eslint + test-file tsc).
- `yarn test` — all workspaces green (quereus 11130 passing).
- `yarn workspace @quereus/quereus run test:store` — 11123 passing.
- Note for the reviewer: `packages/quereus/test-runner.mjs` runs Mocha with `--bail`, so a `yarn test` failure hides later ones. I found the two relaxed tests one run at a time; a no-bail run (`node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus/test/**/*.spec.ts" --reporter min` from the repo root) shows them all at once.
- Plan inspection on a 305-row table with BINARY `idx_bc(b, c)`: `where b = 'x' collate nocase` now gets a full-scan offer (cost 305.01, no filters handled) instead of the 30.5 seek; the plan is Filter over the primary-key walk. `where b = 'x' order by c` still seeks `idx_bc` with no Sort.

## Known gaps / things to check

- The store module still ignores the field (backlog `feat-store-access-plan-reads-predicate-collation`); store plans are unchanged except that OR-collapsed constraints now classify exactly (MATCH, seek without residual), which the store-mode logic run covers.
- `isolation` module forwards filter objects unchanged — checked by reading, not by a dedicated test.
- The engine's `orderingClaimSurvivesCollation` is still deliberately coarse (any mismatched equality on any index column refuses the claim). A NOCASE equality on an *ordered* column, e.g. `where b = 'x' collate nocase order by b, c` over BINARY `(b, c)`, lets the memory module claim the ordering (walking the index is genuinely ordered there) and the engine refuses it. Pre-existing, rare, costs one Sort; not changed here.
- The remaining callers of the lattice helpers in the extractor (`orBranchConstraintCollationOk`, `equalityConstraintCollationOk`, `inConstraintCollationOk`) still recompute from `sourceExpression` rather than reading the stamp. Left alone to keep the diff to the ticket's scope; they agree with the stamp by construction.

## Review findings

Reviewed `ticket(implement): predicate-constraint-carries-comparison-collation` diff first, then the handoff.

**Checked**
- Every engine site that mints a module-facing filter: only `constraint-extractor.ts` (binary, BETWEEN, IN, IS NULL, both OR collapses) and `rule-key-set-seek.ts`'s probe. All stamp `collation`; the planner type makes it required. Other probes (`rule-grow-retrieve`, `index-nested-loop`, `access-leaf`) pass extractor constraints through unchanged.
- The stamp helpers return normalized names. IN and BETWEEN cannot newly throw at extraction: `InNode` already rejects a collation conflict when it is typed, and BETWEEN bounds that get extracted are literals, where an explicit COLLATE always wins.
- The LIKE/GLOB/MATCH BINARY-on-conflict deviation is sound. Nothing reads the field for those ops except the coarse ordering check, and there BINARY behaves as it did before.
- `equalityRefinesKey` without the `BinaryOpNode` shape gate: its caller already restricts to `op: '='`, and every `=` now carries its own resolved collation. The gate's reason ("unknown shape defaults to BINARY") no longer exists.
- The deviation "a column with an unserved equality fills no role": confirmed against `rule-select-access-path`'s pickers (`handledByCol` is per column, so any `=` on a handled column gets picked). It is correct.
- Pinning via "any refining equality": reasoned through the plan-B walk with residuals. A BINARY equality pins its column even as a residual, so any claim it supports is valid. Worst case the engine refuses it and adds one Sort.
- Tests: the new module-level spec and the two extractor stamp tests pin real branching. The collation-blind helper keeps the engine-backstop tests exercising the engine rather than deleting them, and the two relaxed assertions ("no IndexSeek" in place of "SeqScan") are correct for the new plans. No tests cut.
- Docs: `module-authoring.md`, `plugins.md`, `optimizer-retrieve.md`, `optimizer-fd.md` match the code. No stale `effectivePredicateCollation` references remain outside tickets.

**Found and fixed (minor)**
- **The memory module still offered a prefix-range seek the planner rejects.** This is the same class of bug the ticket targets. The rule's prefix-range arm checks the prefix equalities as range bounds (`classifyCollationCover(…, false, …)`, exact collation only). The module, however, accepted any refining prefix equality. Reproduced: `where b = 'x1' collate binary and c > 5` over NOCASE `idx_bc(b, c)` planned as a full SEQSCAN, while the prefix-equality seek was available. Fix: `findEqualityMatches` now reports `collationsExact`, and the prefix-range arm in `evaluateIndexAccess` requires it. Otherwise the plan falls through to the equality-only prefix seek, which the rule keeps with a residual. After the fix the query plans as INDEX SEEK plus residual filters. Regression test added to `test/vtab/memory-access-plan-collation.spec.ts`. The prefix-range rule is added to `docs/module-authoring.md`, and the `rangeServesIndexColumn` doc is updated.
- The `findEqualityMatches` NOTE called itself an "accepted tradeoff", but no human had weighed it. Relabeled as a plain `NOTE:` tripwire.

**Tripwires / not filed**
- The engine's prefix-range cover is conservative: a BINARY prefix over a coarser index column is a real superset that a residual could trim. The module now matches the engine, so no plan is wasted; loosening the engine would be an enhancement, not a defect. Not filed.
- Store module still ignores the field: already tracked by backlog `feat-store-access-plan-reads-predicate-collation`.
- Coarse `orderingClaimSurvivesCollation` (NOCASE equality on an ordered column): pre-existing, already documented at the site. Unchanged.
- The extractor gate helpers (`orBranchConstraintCollationOk` etc.) still recompute from `sourceExpression`. They agree with the stamp by construction, and they run before the stamp exists for OR branches. Left alone.

**Validation**
- `yarn workspace @quereus/quereus run lint`: clean.
- Full quereus mocha suite (no bail): 11131 passing, 26 pending. `@quereus/isolation` tests: 453 passing.
- Store mode not re-run. This pass only changed the memory module; the implementer's store run (11123 passing) covers the rest of the diff.

