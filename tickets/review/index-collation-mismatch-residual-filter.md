description: REVIEW — Access-path collation-cover fix. An IndexSeek over an index whose per-column collation differs from a predicate's effective comparison collation used to consume the predicate with no residual, so it returned wrong rows (e.g. a NOCASE index seek for a BINARY `name = 'BOB'` leaked the collation-equal `'Bob'`). The fix classifies the collation-cover relation in the access-path rule and either keeps the seek + residual Filter (coarser equality index) or declines to a scan + residual (finer index, or any range mismatch).
files:
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts          # PRIMARY FIX. New collation-cover helpers (bottom of file) + wiring into selectPhysicalNodeFromPlan (equality / prefix-range / range / OR_RANGE) and selectPhysicalNodeLegacy (PK eq / PK range). Return types broadened to RelationalPlanNode.
  - packages/quereus/test/optimizer/secondary-index-access.spec.ts                # New describe block: 4 plan-shape + correctness tests (coarser keep+Filter, matching no-regression, range decline, finer decline).
  - packages/quereus/test/logic/06.4.2-collation-extras.sqllogic                  # KNOWN GAP block removed; restored `→ [{"id":2}]`; added BINARY-range-over-NOCASE and symmetric BINARY-index/NOCASE-predicate cases.
  - docs/optimizer.md                                                             # Rule-catalog + Known-Issues notes on collation cover.
----

# Collation-mismatched index seek now retains a residual (or declines)

## What was wrong

`selectPhysicalNodeFromPlan` / `selectPhysicalNodeLegacy` in `rule-select-access-path.ts`
built an `IndexSeekNode` from the access plan's seek constraints, treating a "handled"
filter as a *complete* substitute for the predicate. Neither read collation. So a NOCASE
secondary-index seek was emitted for a BINARY equality with **no residual Filter**, and the
seek over-fetched every collation-equal row. Repro (memory vtab):

```sql
create table coll_idx (id integer primary key, name text);   -- name is BINARY
insert into coll_idx values (1,'Alice'),(2,'BOB'),(3,'charlie'),(4,'Bob');
create index idx_name_nc on coll_idx (name collate NOCASE);
select id from coll_idx where name = 'BOB' order by id;       -- was [2,4] (WRONG), now [2]
```

This was latent until `index-explicit-column-collate-apply-path` made
`create index … (col collate NOCASE)` actually build a NOCASE index on a BINARY column.

## What changed (design as implemented)

All logic lives in the optimizer rule (not the vtab module), so it covers every index-style
module uniformly. New helpers at the bottom of `rule-select-access-path.ts`:

- `effectivePredicateCollation(constraint)` — resolves the predicate's effective collation
  at plan time, **mirroring runtime**: `BinaryOpNode` → `right.collationName ?? left.collationName ?? 'BINARY'`
  (matches `emitComparisonOp`, right-precedence); `InNode` → `condition.collationName ?? 'BINARY'`
  (matches `emitIn`); `BetweenNode` → `expr.collationName ?? 'BINARY'`. Normalized.
- `indexColumnCollationLookup(tableSchema, accessPlan)` — secondary via
  `tableSchema.indexes.find(name).columns.find(index).collation`; primary
  (`_primary_`/`primary`) via `tableSchema.columns[colIdx].collation`. Normalized.
- `primaryKeyCollationLookup(tableSchema)` — for the legacy PK path (no index identity).
- `classifyConstraintCover(predColl, indexColl, isEquality)` → `MATCH` | `COARSER_SAFE`
  (`isEquality && predColl==='BINARY' && indexColl!=='BINARY'` — the only provable superset
  among BINARY/NOCASE/RTRIM) | `MISMATCH_UNSAFE` (everything else: finer index that
  under-fetches, or any non-equality mismatch).
- `classifyCollationCover(consumed, isEquality, collationForColumn)` → aggregate
  `{ useIndex, residual }`: any UNSAFE ⇒ decline + residual = AND of *all* consumed
  `sourceExpression`s; else all MATCH ⇒ use, no residual; else (some COARSER_SAFE) ⇒ use +
  residual = AND of the COARSER_SAFE `sourceExpression`s.
- `combineResidualExpressions(exprs)` — identity-deduped AND-combiner (a BETWEEN yields two
  constraints sharing one source node), mirroring `combineParts`/`combineResiduals` shape.

Wiring:
- **Equality branch** (incl. single/composite multi-value IN): computes the cover up front.
  `!useIndex` ⇒ `createSeqScan` + optional residual Filter. Otherwise each `IndexSeekNode`
  return is wrapped by a local `finishSeek` that adds the residual when present.
  Empty-result short-circuits (literal-NULL keys) are left unwrapped (empty stays empty).
- **prefix-range / range / OR_RANGE branches**: `isEquality=false`, so any mismatch ⇒
  decline ⇒ seqscan + full residual. (A coarser collation reorders the walked window, so it
  is never a superset — not salvageable.)
- **Legacy** `selectPhysicalNodeLegacy`: same treatment for the PK equality seek (keep +
  residual / decline) and PK range seek (decline on mismatch).
- `selectPhysicalNode*` return types broadened to `RelationalPlanNode` (FilterNode is
  relational). Both callers already treat the result as the leaf and compose correctly:
  the `isIndexStyleContext` branch stacks the unsupported residual on top; the non-grow
  `createIndexBasedAccess` substitutes the leaf via `rebuildPipelineWithNewLeaf`.

## Validation performed

- `yarn build` (quereus): clean.
- `eslint` on both changed source/test files: clean.
- `node test-runner.mjs` (full memory suite): **5239 passing, 9 pending, 0 failing**.
- `secondary-index-access.spec.ts`: 24 passing (4 new collation tests).
- `06.4.2-collation-extras.sqllogic`: passing with restored + added assertions.

### Use cases / expected behavior (the floor — please extend)

| Case | Predicate | Index | Decision | Result |
|---|---|---|---|---|
| Coarser eq (repro) | `name = 'BOB'` BINARY | NOCASE | keep seek **+ residual Filter** | `[2]` |
| Matching eq | `name = 'bob' COLLATE NOCASE` | NOCASE | MATCH, no residual | `[2,4]` |
| Range mismatch | `name > 'BOB'` BINARY | NOCASE | **decline** → scan + residual | `[3,4]` |
| Finer eq (symmetric) | `name = 'bob' COLLATE NOCASE` | BINARY | **decline** → scan + residual | `[2,4]` |
| Coarser RTRIM eq | BINARY pred | RTRIM | keep seek + residual | superset recovered |
| Matching numeric/PK | `age = 25`, `id = 3` | BINARY | MATCH, no residual (no regression) | unchanged |

`query_plan(...)` asserts INDEXSEEK **and** FILTER present for the coarser case, and
SEQSCAN + FILTER (no INDEXSEEK) for the decline cases.

## Known gaps / where to scrutinize (treat tests as a floor)

- **Non-grow `createIndexBasedAccess` double-filtering.** When the access path takes the
  non-grow path, the source pipeline's original Filter is rebuilt above the leaf *and* our
  residual Filter wraps the leaf — two Filters for the same predicate. Correct (redundant
  evaluation is harmless) but a minor plan-bloat / perf nit. The repro takes the grow
  (index-style) path, so this is not exercised by the repro; worth a reviewer's eye on
  whether to dedupe. Not believed to affect any current test (full suite green).
- **Legacy PK collation path is reasoned, not directly exercised.** The memory module
  always provides index identity (→ `selectPhysicalNodeFromPlan`), and the store module
  retains predicates itself, so `selectPhysicalNodeLegacy`'s new collation handling has no
  memory-suite coverage. PK columns are typically BINARY (MATCH), so a mismatch there is
  rare — but the branch is essentially test-dark. Consider a targeted unit test if a
  non-BINARY PK text column is plausible.
- **OR_RANGE effective collation is fuzzy.** `effectivePredicateCollation` reads the OR
  `BinaryOpNode`'s own `collationName` (propagated through `generateType` as
  `left.collationName || right.collationName`). For a BINARY column this yields BINARY
  (MATCH, no regression — `or-multi-range-seek.spec.ts` still green); for a collated column
  it yields the column collation or, worst case, a value `!==` indexColl that triggers a
  *safe* decline. No dedicated OR_RANGE-over-collated-index test was added — verify the
  reasoning or add one.
- **BETWEEN over a collated index** is handled (`BetweenNode` arm) but has no dedicated
  test; it routes through the range branch (decline on mismatch).
- **Folding dependency for the finer/symmetric case.** The decline only fires if
  `'bob' COLLATE NOCASE` folds to a literal carrying `collationName='NOCASE'` so the
  constraint is extracted and the BINARY index is considered. The `finer BINARY index`
  spec test asserts no INDEXSEEK and returns `[2,4]`, which passes — but that assertion
  alone can't distinguish "decline fired" from "module never offered the index". The range
  and coarser tests prove the decline/keep paths more directly; reviewer may want a
  stronger assertion (e.g. probe that the constraint was extracted) if paranoid.
- **Adversarial angles to probe:** correlated/parameter-bound RHS (predColl resolution off
  a column-ref/param), composite indexes where only the trailing seek col is collated,
  RTRIM trailing-space semantics in the residual, and whether the residual `sourceExpression`
  always resolves against the rebuilt leaf's attributes (it references table-column
  attribute IDs, which IndexSeek/SeqScan reproduce — believed sound, confirm).

## Out of scope (do not touch here)

- The create path / persistence emitter (fixed in `index-explicit-column-collate-apply-path`).
- Pushing collation logic into any vtab module (kept in the rule by design).
