description: The persistent store's planner now checks which collation each filter compares under before offering an index for it, so it no longer offers index plans for case-insensitive (or otherwise mismatched) filters that the engine then throws away.
prereq: predicate-constraint-carries-comparison-collation
architecture: docs/module-authoring.md
files: packages/quereus-store/src/common/store-module-access-plan.ts, packages/quereus/src/vtab/best-access-plan.ts, packages/quereus/src/vtab/memory/module.ts, packages/quereus/src/index.ts, packages/quereus-store/test/access-plan-predicate-collation.spec.ts, packages/quereus-store/test/index-ordering.spec.ts, packages/quereus-store/test/pushdown.spec.ts, packages/quereus-store/src/common/store-table-scan.ts, docs/module-authoring.md, docs/optimizer-retrieve.md, packages/quereus/src/planner/rules/access/rule-select-access-path.ts
----

## What landed

Implemented in `ticket(implement): store-access-plan-reads-predicate-collation`.

The store module's `getBestAccessPlan` (`computeBestAccessPlan` in `store-module-access-plan.ts`) now reads `PredicateConstraint.collation` (absent means BINARY) and applies the same rules as the engine's collation cover in `rule-select-access-path`:

- An equality may seek, and pin, a key column only when its collation refines the key column's (BINARY, or the key's own collation). `equalityServesKeyColumn`.
- A range bound, and every equality in a prefix-range seek's prefix, must compare under exactly the key column's collation. `rangeServesKeyColumn`.
- Only the first filter of each role (equality, lower bound, upper bound) on a column counts (`firstRoleFilterIndex`). A range is offered on a column only if its first equality, when present, also serves (`rangeServedOn`).

These two predicates moved out of the memory module into `vtab/best-access-plan.ts` and are exported from `@quereus/quereus`. Both bundled modules use them.

The rules apply to the secondary-index arms, the primary-key point and multi-seek arms (`resolvePrimaryKeyPins`, all-or-nothing per key), and the leading primary-key range (`leadingPkRangePlan`). When the predicate collation rules out an index, the arm returns null ("this index cannot serve this predicate"). It never returns a cost-only plan. The cost-only fallback is kept for the key-byte collation gates, which are unchanged.

## Review findings

**Diff read first, then the handoff.** Checked every hunk of the implement commit against the rule it claims to mirror.

- **Correctness against the engine rule (checked, sound).**
  - `classifyCollationCover` is called with `isEquality = false` for the prefix-range seek, and the prefix equalities are passed in with the trailing bounds (`rule-select-access-path.ts`, prefix-range arm). So the `collationsExact` requirement on a prefix-range prefix is right. The implementer's addition beyond the ticket text matches the rule and the memory module.
  - Equality: MATCH or COARSER_SAFE (BINARY over a coarser key) is accepted, and the rule re-adds a residual for COARSER_SAFE. That is exactly `collationRefines`.
  - Range: equal names, with `honorsCollatedRangeBounds`, which the store advertises.
- **Collation source agreement (checked, consistent).** The rule's legacy primary-key path reads `tableSchema.columns[i].collation`. The store reads `primaryKeyDefinition[i].collation`. `Schema.addTable` rejects a definition whose member collations disagree with the columns, and `reconcilePkCollations` rewrites both together, so the two always agree. For a secondary index, the engine's descriptor reads `index.columns[i].collation ?? BINARY`, the same field the store reads. Index-column collation is resolved at index build time (explicit `COLLATE`, else the table column's, else BINARY). The store's `reversedIndexDescriptor` is built from the schema, so a module-supplied descriptor can't diverge either.
- **Refactor equivalence (checked).** `firstRoleFilterIndex(…, EQ_OR_IN_OPS)` picks the same filter as the old `equalitySeekKeyCount(f) !== null` scan, because `equalitySeekKeyCount` is non-null only for `=` and well-formed `IN`. The extra `IN` shape gate in `rangeBoundSelectivity` is inert for bound operators.
- **End-to-end (ran it).** I ran a throwaway spec (deleted afterwards) with 15 queries over store tables and identical memory tables, and the rows agreed every time. Tables: a BINARY `(b, c)` index, a NOCASE `(b, c)` index, and a NOCASE composite text primary key. Shapes: NOCASE, RTRIM and BINARY equalities, ranges, `collate nocase in (…)`, prefix plus trailing range, and composite-PK partial pins. The plans were the expected ones:
  - A coarser predicate gets `FILTER` over a scan.
  - A BINARY prefix over a NOCASE index gets `FILTER > FILTER > INDEXSEEK`, the prefix seek only.
  - `order by c` stays sort-free there, correctly: a BINARY equality over a NOCASE key reads one NOCASE group, which is already ordered by `c`.
  - An RTRIM primary-key member falls back to `SEQSCAN` plus residual.
- **`pushdown.spec.ts` assertion change (accepted as is).** `SEQSCAN|INDEXSCAN` plus `FILTER` plus "no `INDEXSEEK`" plus the row check pins the observable contract: no seek, a residual, and the right rows. The module-level "no seek columns" pin the handoff suggested already exists, as the `_primary_` range cases in `access-plan-predicate-collation.spec.ts`. A stricter node-name pin would only re-couple the test to how the rule picks a scan node.
- **Tests (cut none; tidied one).** The 12 direct cases each exercise a distinct branch. The positive controls are needed so a case that returns null for an unrelated reason can't pass. One change: the prefix-range case reused the `B`/`C` column constants for table `u`'s columns `a`/`b`, which didn't match. I renamed `u`'s columns to `(b, c)` and its index to `ix_u_bc` so the constants mean what they say. No new tests: no defect was found, and every contract is already covered.
- **Docs (checked).** `module-authoring.md`, `optimizer-retrieve.md` and the `orderingClaimSurvivesCollation` doc comment are accurate. Nothing else in `docs/` or the source still says the store ignores the field. The backlog ticket `feat-store-primary-key-prefix-equality-seek` already names the predicate-collation gate as a requirement.
- **Source hygiene.** The new comments state constraints and reasons rather than narrate the code. `store-module-access-plan.ts` is now 1,968 lines (`wc -l`), up from 1,851. That file is already tracked in `backlog/debt-oversized-source-files.md`, so I updated its line count there rather than filing a new ticket.
- **Error handling, resource cleanup, types.** No new error paths, and nothing allocated. The helpers take `Pick<IndexColumnSchema, 'collation'>`, so primary-key members and index columns both type-check without casts.
- **Tripwires (left as the implementer placed them, both with `NOTE:`):**
  - `resolveEqualityPins`: a duplicate equality where the first one doesn't serve and a later one would.
  - `NO_PINNED_COLUMNS`: ordering-only walks still pin nothing, with the revisit condition stated.
- **Not addressed, no change:** the store still doesn't test `PredicateConstraint.usable`. That is unchanged by this ticket and outside its scope. No current engine caller sends `usable: false` filters to the store in a way that changes the result, and the residual covers them.
- **Major findings:** none, so no tickets filed.

## Validation

- `yarn workspace @quereus/quereus run lint`: exit 0.
- `yarn workspace @quereus/store run typecheck`: exit 0.
- `yarn test`: every workspace green (engine 11135 passing, store 2012, sync 878, the rest green). The renamed spec was re-run afterwards: 12 passing.
- `yarn test:store` was not re-run in review. The implementer reported it green (11128 passing), and the review changes touch only a test's table and column names.
