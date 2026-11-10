description: The persistent store's planner now checks which collation each filter compares under before offering an index for it, so it no longer offers index plans for case-insensitive (or otherwise mismatched) filters that the engine then throws away. Review the change and its edge cases.
prereq: predicate-constraint-carries-comparison-collation
architecture: docs/module-authoring.md
files: packages/quereus-store/src/common/store-module-access-plan.ts, packages/quereus/src/vtab/best-access-plan.ts, packages/quereus/src/vtab/memory/module.ts, packages/quereus/src/index.ts, packages/quereus-store/test/access-plan-predicate-collation.spec.ts, packages/quereus-store/test/index-ordering.spec.ts, packages/quereus-store/test/pushdown.spec.ts, packages/quereus-store/src/common/store-table-scan.ts (comment only), docs/module-authoring.md, docs/optimizer-retrieve.md, packages/quereus/src/planner/rules/access/rule-select-access-path.ts (doc comment only)
----

## What changed

Every filter in `getBestAccessPlan` carries `PredicateConstraint.collation` (absent = BINARY). The store module (`computeBestAccessPlan` in `store-module-access-plan.ts`) now reads it, using the same rule the memory module already followed and the same rule the engine's `rule-select-access-path` collation cover enforces. So a plan the store offers is never declined by the rule on collation grounds.

### Engine: shared helpers (DRY)

- `equalityServesKeyColumn(f, keyCol)` and `rangeServesKeyColumn(f, keyCol)` moved from the memory module's private copies into `vtab/best-access-plan.ts` and are exported from `@quereus/quereus`. `keyCol` is `Pick<IndexColumnSchema, 'collation'>`, so a `primaryKeyDefinition` member qualifies. Equality: `collationRefines(pred, key)`. Range: normalized names equal.
- The memory module now calls the exported pair. Its `firstEqualityFilter` / `blockedByUnservedEquality` stay private (they also test `f.usable`). There is no import cycle: `util/comparison.ts` imports only types, errors and json-canonical.

### Store

- **`firstRoleFilterIndex(filters, colIdx, ops)`** (new): the one positional "first filter of this role on this column" pick. `claimFirstPerRole`, `resolveEqualityPins`, `rangeBoundSelectivity` and `rangeServedOn` all go through it.
- **`resolveEqualityPins(filters, keyColumns)`** now takes key column specs (`index.columns` or `primaryKeyDefinition`). The run stops at a column whose first equality fails `equalityServesKeyColumn`. It also returns `collationsExact`: every pin passes `rangeServesKeyColumn`.
- **`resolvePrimaryKeyPins`** takes `primaryKeyDefinition`. If one member fails, the pins are null and the request falls through to the leading-PK range and the secondary indexes.
- **`rangeServedOn(filters, keyCol)`** (new) answers whether a range may be walked on a column. The column must have a bound; its first equality, if any, must serve; and the first lower and first upper bound present must both match. It is used at `hasLeadingRange` (`index.columns[0]`), at the `trailingRangeCol` test, and in `leadingPkRangePlan` (`primaryKeyDefinition[0]`).
- **Beyond the ticket text — prefix-range prefix exactness.** `trailingRangeCol` also requires `collationsExact`. The rule checks a prefix-range's prefix equalities as range bounds (`classifyCollationCover(..., isEquality=false)`). So a BINARY `a = 'x'` over a NOCASE `a` plus a range on the next column would be declined to a scan. The arm stays `eq` on the prefix and the bound stays unclaimed. This is the rule `docs/module-authoring.md` already states ("A prefix-range seek … holds its prefix equalities to the range rule"), and the memory module already does it (`collationsExact`). The ticket's rule section left it out.
- A predicate-collation decline returns `null` from `tryIndexAccessPlan` (it falls through to "this index cannot serve this predicate"), never cost-only. The key-byte cost-only gates (`indexPrefixSeekIsCollationExact`, `indexRangeAtPositionIsOrderSafe`) are unchanged. The doc comment's "Collation safety" section now names three gates and the two questions they ask.
- `RANGE_OPS` was removed because nothing used it any more. The comments that named it (the multi-seek fall-through comment, and `store-table-scan.ts`'s `RANGE_CONSTRAINT_OPS` doc) were reworded.
- Comments rewritten:
  - The PK-arm block is now titled "No key-collation gate", with a paragraph on the predicate gate. The "one more reason `setSeekColumns` is load-bearing" sentence was dropped. The point arm's own `setSeekColumns` comment, about the single-element IN, still stands.
  - `resolveEqualityPins` doc, with a `NOTE:` tripwire for `b = 'x' collate nocase and b = 'x'`.
  - The `NO_PINNED_COLUMNS` comment states the decision (stays empty), the two reasons, and the revisit condition as a `NOTE:`.
- Docs:
  - `module-authoring.md` names the two helpers.
  - `optimizer-retrieve.md` says both bundled modules read the field.
  - The `orderingClaimSurvivesCollation` doc names both modules and calls the check a backstop for third-party modules.

## Tests

- **Added** `packages/quereus-store/test/access-plan-predicate-collation.spec.ts`: 12 table-driven direct `getBestAccessPlan` cases.
  - BINARY `ix_bc(b, c)`:
    - A NOCASE `b = 'x'` gets no `ix_bc`, the filter is unhandled, and there is no ordering claim on `c`. This is the regression for this ticket.
    - A BINARY `b = 'x'` seeks `ix_bc` and claims `c`.
    - A NOCASE `b > 'm'` gets no range; a BINARY one gets the range.
    - `[b = 'x' NOCASE, b > 'a' BINARY]` gets nothing on `ix_bc`.
  - BINARY `ix_ab(a, b)`: `a = 1` plus a NOCASE `b > 'm'` gets the `eq` arm on `[a]`, with the bound unclaimed.
  - NOCASE `ix_n_bc(b, c)`: a BINARY `b = 'x'` plus `c > 5` gets the prefix seek only, `[true, false]`. This covers the prefix-exactness branch above.
  - Text PK under the default NOCASE key:
    - Equality: RTRIM gets no `_primary_`; NOCASE and BINARY get a `_primary_` point lookup.
    - Range: RTRIM gets no `_primary_` range; NOCASE gets one.
- **Updated** `index-ordering.spec.ts` "index COLLATE the table column does not carry…": the hand-built `name > 'M'` filter now carries `collation: 'NOCASE'`. That is the stamp `name > 'M' collate nocase` would get, and the only bound that can walk the NOCASE index. The test's point (the seek fires, ordering is never claimed) is unchanged.
- **Updated** `pushdown.spec.ts` "collation-mismatched bound still declines to scan + residual": the store now declines the PK range itself. The leaf is its plain full scan (`INDEXSCAN … USING _primary_ ORDER BY 0`, a whole-key walk) instead of the rule's `SEQSCAN` decline. The assertion now accepts `SEQSCAN|INDEXSCAN` and requires a `FILTER`. The rows checked are unchanged (`[4]`).
- `memory-access-plan-collation.spec.ts` is unchanged and green after the helper move.

## Validation run

- `yarn workspace @quereus/quereus run lint`: clean.
- `yarn workspace @quereus/store run typecheck`: clean.
- `yarn test`: all workspaces green (engine 11135, store 2012, sync 878, …).
- `yarn test:store`: 11128 passing, 0 failing.
- Hand plan check (store table, BINARY `ix_bc(b, c)`, ~300 rows):
  - `where b = 'x' collate nocase` → `FILTER` over `INDEXSCAN _primary_ ORDER BY 0`, with no "Declining" debug log from the rule. The rows are right (`'x'` and `'X'`).
  - `where b = 'x' order by c` → `INDEXSEEK ix_bc`, no `SORT`.

## For the reviewer: worth a hard look

- **The prefix-exactness addition.** Confirm it matches the rule's prefix-range cover and the memory module. It goes beyond the ticket text.
- **The `pushdown.spec.ts` assertion change.** The old test pinned `SEQSCAN` because the engine's decline built one. Now the module's own scan plan carries the PK-order advertisement, so the rule builds an ordered `_primary_` scan. Same work, different node name. Decide whether `SEQSCAN|INDEXSCAN` plus `FILTER` is the right pin, or whether something stricter (for example, no `seekColumnIndexes` on the plan) belongs at the module level instead.
- **Edge cases checked by inspection only:**
  - Composite-PK partial pins (still all-or-nothing).
  - Multi-seek `IN` under a coarser collation (same gate as `=`).
  - Runtime-set probes: `key-set-seek-store.spec.ts` and `runtime-key-set-plan.spec.ts` stayed green.
  - Stats-backed estimates only run for arms that passed the gates.
  - Isolation-layer passthrough.
- **`f.usable`** is still not tested by the store, unchanged from before. The memory module tests it.

## Known gaps / tripwires

- `NOTE:` at `resolveEqualityPins`: only the first equality per column counts, so `b = 'x' collate nocase and b = 'x'` over a BINARY `b` offers no seek, although the second equality could seek. Same limitation as the memory module.
- `NOTE:` at `NO_PINNED_COLUMNS`: ordering-only walks and the PK ordering advertisement still pin nothing, by decision. Revisit when `feat-store-primary-key-prefix-equality-seek` lands and the veto counts the sort, or if a store plan is seen sorting after a residual equality that a walk could have pinned.
