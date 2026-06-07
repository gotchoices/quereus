description: An IndexSeek over a secondary index whose per-column collation differs from a predicate's effective comparison collation consumes the predicate WITHOUT retaining a residual filter, so the seek over-fetches collation-equal rows and returns wrong results. Fix in the access-path rule: detect index-vs-predicate collation mismatch and either (a) keep the seek + re-apply the predicate as a residual (coarser index, equality only) or (b) decline the seek and fall back to a scan + residual (finer index, or any range mismatch).
prereq:
files:
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts   # PRIMARY FIX SITE. selectPhysicalNodeFromPlan equality branch (~313-516), prefix-range (~518-606), range (~608-653), OR_RANGE (~655-709), and selectPhysicalNodeLegacy (~747-885). None read collation today.
  - packages/quereus/src/planner/analysis/constraint-extractor.ts          # PlannerPredicateConstraint carries `sourceExpression: ScalarPlanNode` (the original BinaryOp/In node) — this is the residual to re-apply
  - packages/quereus/src/runtime/emit/binary.ts                            # emitComparisonOp (~209-220): the canonical effective-collation resolution (right.getType().collationName ?? left ?? 'BINARY'). Mirror this at plan time.
  - packages/quereus/src/schema/table.ts                                   # IndexSchema / IndexColumnSchema (~315-345): IndexColumnSchema.collation is normalized (e.g. 'NOCASE'); ColumnSchema.collation holds the PK/declared column collation
  - packages/quereus/src/util/comparison.ts                               # normalizeCollationName (uppercase/trim) for byte-comparable collation names
  - packages/quereus/src/planner/nodes/filter.ts                          # FilterNode(scope, source, predicate) — used to wrap the leaf with the retained residual
  - packages/quereus/test/logic/06.4.2-collation-extras.sqllogic          # restore the corrected `→ [{"id":2}]` assertion (KNOWN GAP block ~163-169)
----

# Collation-mismatched index seek must retain a residual predicate (or decline the index)

## Confirmed reproduction

Verified live (memory vtab). With the NOCASE index present:

```sql
create table coll_idx (id integer primary key, name text);      -- name is BINARY
insert into coll_idx values (1,'Alice'),(2,'BOB'),(3,'charlie'),(4,'Bob');
select id from coll_idx where name = 'BOB' order by id;          -- → [{"id":2}]   (correct, no index)
create index idx_name_nc on coll_idx (name collate NOCASE);
select id from coll_idx where name = 'BOB' order by id;          -- → [{"id":2},{"id":4}]  ← WRONG ('Bob' leaks)
```

The physical plan for the wrong query (via `query_plan(...)`) is:

```
BLOCK → SORT(ORDER BY id ASC) → PROJECT(id) → INDEXSEEK(coll_idx USING idx_name_nc)
```

**There is no Filter above the IndexSeek.** The `name = 'BOB'` predicate was extracted
into an equality constraint, pushed into the Retrieve as the "supported" fragment,
and then fully consumed by the NOCASE index seek — with the original BINARY predicate
neither kept in the pipeline nor re-applied as a residual. The NOCASE seek for `'BOB'`
returns every NOCASE-equal index entry (`'BOB'` and `'Bob'`), and nothing discards the
BINARY-illegal `'Bob'`.

## Root cause (precise)

`selectPhysicalNodeFromPlan` in `rule-select-access-path.ts` builds the `IndexSeekNode`
from the access plan's `seekColumnIndexes` + the equality constraints, treating a
"handled" filter as a *complete* substitute for the predicate. It never compares the
index column's collation against the predicate's effective comparison collation, so a
NOCASE index seek is emitted for a BINARY equality with no residual. The file reads
`collation` nowhere.

Why no residual survives elsewhere: when the predicate is the *fully supported*
fragment, predicate-pushdown / grow-retrieve move it INTO the Retrieve pipeline and the
access-path rule's `isIndexStyleContext` branch (rule-select-access-path.ts ~70-79)
only re-applies `moduleCtx.residualPredicate` (the *unsupported* portion). The supported
equality is consumed into the seek and dropped. (The non-grow `createIndexBasedAccess`
path rebuilds the source pipeline above the leaf, which would keep a Filter — but the
repro takes the index-style path, so the predicate is gone.)

The runtime comparator is correct and out of scope: `emitComparisonOp` (binary.ts)
resolves the effective collation from operand types (default BINARY) and *would* reject
`'Bob'` if the predicate were still evaluated. The defect is purely that the access path
drops it.

This was latent until `index-explicit-column-collate-apply-path` made
`create index … (col collate NOCASE)` actually build a NOCASE index on a BINARY column.

## Why this is memory-vtab-specific (today)

The memory module's `evaluateIndexAccess` / `findEqualityMatches`
(`vtab/memory/module.ts` ~381-500) match constraints to index columns by `columnIndex`
only and set `handledFilters[i] = true` regardless of collation. The store module
(`quereus-store/src/common/store-module.ts` ~1313+) never marks secondary-index filters
handled (it relies on `matchesFilters`), so it naturally retains the predicate and is
not affected. Fixing in the optimizer rule covers all index-style modules generically —
do **not** push the fix into the module.

## Required behavior & the collation cover relation

For a seek to be a complete substitute for an equality predicate, the index column's
collation must equal the predicate's effective collation. On mismatch, classify per the
*cover* relation (does index-collation equality return a SUPERSET of predicate-collation
equality?):

- **MATCH** (`indexColl === predColl`): seek fully satisfies — no residual (today's
  behavior, must not regress).
- **COARSER_SAFE** — equality op, the index collation's equality is a strict superset of
  the predicate's, so the seek over-fetches a superset and a residual recovers exact
  matches. Among supported collations (BINARY, NOCASE, RTRIM) the only provable superset
  is **`predColl === 'BINARY'` and `indexColl !== 'BINARY'`** (BINARY-equal ⟹ equal under
  any collation; NOCASE/RTRIM are mutually incomparable). → **keep the IndexSeek, wrap the
  leaf with a residual FilterNode** built from the constraint's `sourceExpression`.
- **MISMATCH_UNSAFE** — everything else: a *finer* index than the predicate
  (BINARY index, NOCASE/RTRIM predicate) UNDER-fetches (a residual can't recover missing
  rows), AND **any range/prefix-range/OR_RANGE mismatch** (a different collation reorders
  the index, so the walked window is not a superset — not salvageable even from a coarser
  index). → **decline the index seek; fall back to `createSeqScan` and retain the full
  predicate as a residual** so the scan is still filtered.

Effective predicate collation, resolved exactly like `emitComparisonOp` but at plan time
off the constraint's `sourceExpression` operands:
```
const b = constraint.sourceExpression as BinaryOpNode;       // (or InNode for IN)
const predColl = normalizeCollationName(
    b.right.getType().collationName ?? b.left.getType().collationName ?? 'BINARY');
```
Index column collation:
```
// secondary: tableSchema.indexes.find(i => i.name === accessPlan.indexName)
//            .columns.find(c => c.index === colIdx).collation   (already normalized)
// primary ('_primary_'/'primary'): tableSchema.columns[colIdx].collation
```
Both default to `'BINARY'` when absent; normalize before comparing.

## Fix design (suggested, least-invasive)

Do the wrapping INSIDE `selectPhysicalNodeFromPlan` / `selectPhysicalNodeLegacy` and
broaden their return type to `RelationalPlanNode` (FilterNode is relational). Both callers
already treat the result as the new leaf: the `isIndexStyleContext` branch wraps any extra
`residualPredicate` ON TOP, and `createIndexBasedAccess` substitutes the leaf via
`rebuildPipelineWithNewLeaf` — a returned `Filter(IndexSeek)` or `Filter(SeqScan)` slots in
correctly and stacks with the unsupported residual. Ordering advertisements survive (a
Filter preserves order), so monotonic/merge-join downstream is unaffected.

Add a helper, e.g. `classifyCollationCover(tableRef, accessPlan, constraints, op)`, that
returns per-seek-constraint MATCH / COARSER_SAFE / MISMATCH_UNSAFE and an aggregate
decision:
- any MISMATCH_UNSAFE → `{ useIndex: false, residual: <AND of all consumed constraints' sourceExpressions> }`
- else if all MATCH → `{ useIndex: true, residual: undefined }`
- else (some COARSER_SAFE) → `{ useIndex: true, residual: <AND of the COARSER_SAFE constraints' sourceExpressions> }`

Then:
- equality branch (~486-516): if `!useIndex` build `createSeqScan(tableRef)`; either way,
  if `residual` present, return `new FilterNode(tableRef.scope, leaf, residual)`.
- range / prefix-range / OR_RANGE branches: mismatch ⇒ MISMATCH_UNSAFE ⇒ seqscan + residual.
- legacy path: same treatment for the secondary/PK seek it builds (PK collation from
  `tableSchema.columns[colIdx].collation`).

AND-combine multiple residual `sourceExpression`s with a `BinaryOpNode('AND', …)` the same
way `combineParts` / `combineResiduals` do in constraint-extractor.ts (reuse the pattern;
keep it DRY — consider a tiny shared local combiner). FilterNode scope: `tableRef.scope`.

Minimal residual = only the COARSER_SAFE / declined constraints; including a MATCH
constraint too is harmless (just redundant evaluation) if it simplifies the code.

## Acceptance

- Repro returns `[{"id":2}]` with the NOCASE index present.
- Restore in `06.4.2-collation-extras.sqllogic` (replace the KNOWN GAP block ~163-169):
  `select id from coll_idx where name = 'BOB' order by id;` → `[{"id":2}]`.
- NOCASE predicate over the NOCASE index still returns both rows
  (`where name = 'bob' collate NOCASE` → `[{"id":2},{"id":4}]`) — must not regress.
- The index is still USED (IndexSeek, not degraded to full scan) for the coarser case —
  assert via `query_plan(...)` that the plan contains INDEXSEEK for the BINARY-pred query
  and that a Filter is present above it.
- Symmetric case (BINARY index, NOCASE-collated predicate): build a BINARY index and run a
  `collate NOCASE` equality; result must include all case variants (correctness via the
  MISMATCH_UNSAFE → seqscan + residual fallback). Add coverage.
- Range mismatch: a range predicate whose effective collation differs from the index
  column must not silently use the reordered index seek — verify correct rows.
- Whole suite green: `yarn test` (memory). Spot-run the collation logic file and the
  optimizer access-path specs.

## Notes / scope guards

- Scope is the access-path/optimizer layer only. The create path and persistence emitter
  (fixed in `index-explicit-column-collate-apply-path`) are correct and out of scope.
- Don't fix this in the vtab module — keep the cover logic in the rule so it covers every
  index-style module uniformly. (Store module already retains the predicate.)
- Correctness bug (wrong rows), not a perf nicety — prioritize correctness; the index-use
  optimization for the coarser case is a bonus that the residual makes safe.

## TODO

- Add an effective-predicate-collation helper (mirror emitComparisonOp) and an
  index-column-collation lookup (secondary via `tableSchema.indexes`, PK via
  `tableSchema.columns[colIdx].collation`), both normalized.
- Add `classifyCollationCover(...)` returning the per-constraint MATCH / COARSER_SAFE /
  MISMATCH_UNSAFE classification and the aggregate `{ useIndex, residual }` decision.
- Wire it into `selectPhysicalNodeFromPlan`: equality branch first (covers the repro), then
  prefix-range / range / OR_RANGE branches (mismatch ⇒ decline ⇒ seqscan + residual).
- Wire it into `selectPhysicalNodeLegacy` for the PK/secondary seek it builds.
- Broaden the `selectPhysicalNode*` return types to `RelationalPlanNode`; wrap the leaf
  with `FilterNode(tableRef.scope, leaf, residual)` when a residual is required. Verify
  both callers (`isIndexStyleContext` branch and `createIndexBasedAccess`) still compose.
- Build a small AND-combiner for multiple residual `sourceExpression`s (reuse the
  constraint-extractor `combineParts`/`combineResiduals` shape; keep DRY).
- Restore the corrected `→ [{"id":2}]` assertion and delete the KNOWN GAP comment in
  `06.4.2-collation-extras.sqllogic`; add the NOCASE-still-works, symmetric BINARY-index,
  and range-mismatch cases (sqllogic and/or an optimizer spec asserting IndexSeek+Filter).
- Run `yarn test`; fix any fallout. Update `docs/optimizer.md` if it documents access-path
  / residual behavior.
