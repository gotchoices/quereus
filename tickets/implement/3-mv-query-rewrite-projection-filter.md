description: Foundation for automatic MV query rewrite — recognize when a covering materialized view subsumes a scan-projection-filter query the user did not name, and rewrite to scan the MV's backing table with a residual projection/filter. Establishes the matcher module, the rewrite rule + pass placement, MV enumeration + soundness gates, the cost gate, query_plan visibility, and the equivalence test harness that the aggregate-rollup and join-subsumption phases build on.
prereq:
files: packages/quereus/src/planner/analysis/coverage-prover.ts, packages/quereus/src/planner/analysis/partial-unique-extraction.ts, packages/quereus/src/planner/analysis/predicate-normalizer.ts, packages/quereus/src/planner/analysis/predicate-shape.ts, packages/quereus/src/planner/rules/cache/rule-materialization-advisory.ts, packages/quereus/src/planner/rules/join/rule-join-elimination.ts, packages/quereus/src/planner/framework/registry.ts, packages/quereus/src/planner/framework/pass.ts, packages/quereus/src/planner/framework/context.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/src/planner/cost/index.ts, packages/quereus/src/planner/building/select.ts, packages/quereus/src/schema/view.ts, packages/quereus/src/schema/manager.ts, packages/quereus/src/runtime/emit/materialized-view-helpers.ts, docs/materialized-views.md, docs/optimizer.md
----

## Goal

The read-side dual of the covering-structure *enforcement* path. Today an MV is
consulted only when (a) it answers a UNIQUE constraint (coverage prover, write
path) or (b) a query *names* it (resolved to the backing `TableReference` in
`building/select.ts`). This phase adds the third path: the optimizer recognizing
that an *arbitrary* scan-projection-filter query — one that never names the MV —
is **answered from** a covering MV, and rewriting it to scan the MV's backing
table instead of recomputing the body against the base tables.

This first ticket delivers the **vertical slice** for the simplest matching
shape (projection + filter subsumption) and *all* the shared infrastructure the
two later phases extend. The aggregate-rollup and join-subsumption phases are
pure additions to the matcher built here.

```sql
create materialized view recent as
  select id, customer_id, amt from sales where amt > 0;

-- never names `recent`, but the optimizer answers from it:
select customer_id, amt from sales where amt > 0 and customer_id = 7;
--   → scan _mv_recent, residual filter (customer_id = 7), residual project (customer_id, amt)
```

## Soundness contract (load-bearing)

This mirrors the coverage prover's discipline exactly: **a false NotMatch only
forgoes a speedup; a false Match returns wrong rows.** Every check forgoes the
rewrite on doubt. The pre-existing recompute-over-base path is correct by
construction, and the rule only ever *replaces* it with a provably-equivalent
plan, so the rewrite is non-regressing: a no-op when nothing matches or the cost
gate declines, and byte-identical rows (including NULL handling) when it fires.

Gates every candidate MV must pass before any shape matching (all reuse
already-solved sub-problems on the enforcement path):

- **Not stale** — `mv.stale === true` ⇒ skip. A stale MV's backing is an
  unmaintained snapshot (its row-time plan is detached); never read it.
- **Deterministic body** — a body with `random()` / `now()` / a volatile UDF can
  never be substituted for live recomputation. Reuse the create-time determinism
  analysis (the same gate that rejects non-deterministic bodies at
  `create materialized view`); do not re-implement it.
- **Registered + has a backing table** — `mv.backingTableName` resolves to a live
  `TableSchema`. (A stale-but-registered MV is already excluded above.)
- **Source-schema sanity** — the MV's `sourceTables` are the tables the query
  fragment reads; a mismatch is a trivial NotMatch.

## The matcher (new analysis module)

`planner/analysis/query-rewrite-matcher.ts` — a pure analysis module, sibling to
`coverage-prover.ts`. It is **distinct from** `coverage-prover.ts` (which proves
a *base-table UNIQUE constraint* is covered) but shares its entailment
vocabulary: `recognizeConjunctiveClauses` / `guardClausesEntail`
(`partial-unique-extraction.ts`), `normalizePredicate`
(`predicate-normalizer.ts`), and the `ColumnIndexResolver` surface
(`predicate-shape.ts`).

The question this module answers is **output-relation subsumption**: does the
MV's stored output relation contain (a superset of, reproducible via a bounded
residual) the rows the query fragment produces, keyed so the residual recovers
exactly the fragment's output?

```ts
export type RewriteFailureReason =
  | 'no-candidate'        // no non-stale/deterministic MV reads these sources
  | 'shape'               // fragment or MV body not a scan-project-filter chain
  | 'source-mismatch'     // MV reads different base table(s) than the fragment
  | 'predicate-not-entailed' // fragment WHERE not entailed by MV WHERE (would read rows the MV dropped)
  | 'missing-column'      // fragment needs an output column the MV does not project
  | 'cost-declined';      // matched, but the MV scan is not cheaper (set by the rule, not the matcher)

export interface RewriteMatch {
  readonly mv: MaterializedViewSchema;
  readonly backing: TableSchema;
  /** Extra predicate clauses the fragment imposes beyond the MV's WHERE — the
   *  residual Filter to apply on top of the backing scan. Empty ⇒ no residual filter. */
  readonly residualClauses: readonly GuardClause[];
  /** For each fragment output attribute, the backing-table column index that
   *  supplies it (a bare passthrough) — drives the residual Project. */
  readonly outputColumnMap: ReadonlyArray<{ attrId: number; backingCol: number }>;
}

export type RewriteResult =
  | { match: RewriteMatch }
  | { match: undefined; reason: RewriteFailureReason };
```

### Projection/filter subsumption rule

Given the **fragment** (the logical subtree under consideration:
`Project(Filter?(Retrieve(TableScan)))` over base `T`) and a **candidate MV**
whose optimized body is the same single-source `TableReference → Filter? →
Project` shape over the same `T`:

1. **Shape.** Both fragment and MV body must walk down to the *same* single base
   `T` through the row-preserving pass-throughs already enumerated in
   `coverage-prover.ts` (`PASS_THROUGH`). Aggregation / DISTINCT / set-op / join /
   LIMIT on either side ⇒ `shape` (joins and aggregates are the later phases).
2. **Predicate entailment (containment).** The fragment's materialized row set
   must be a subset of the MV's: the MV's WHERE `P_mv` must be entailed by the
   fragment's WHERE `P_q` (every MV-required clause is implied by the query) —
   i.e. the MV keeps *at least* every row the query needs. The **residual** is
   the conjunction of `P_q` clauses not already entailed by `P_mv`
   (`guardClausesEntail` per clause), applied as a Filter on the backing scan.
   - MV with no WHERE subsumes any fragment WHERE (residual = full `P_q`).
   - Fragment with no WHERE requires `P_mv` empty too (else the MV dropped rows
     the query needs ⇒ `predicate-not-entailed`).
   - NULL handling: clause entailment is the same vocabulary the coverage prover
     uses for partial-UNIQUE / NULL-skip; reuse it verbatim so NULL semantics are
     identical.
3. **Projection coverage.** Every fragment output column must be a column the MV
   projects (mapped via stable attribute ids → backing column index, exactly the
   `baseAttrToCol` technique in `coverage-prover.ts`). A fragment output that is a
   computed expression the MV does not already store ⇒ `missing-column` (v1 does
   not re-derive expressions over the backing; a later refinement may, when the
   inputs are all stored).
4. **Determinism of the residual.** The residual Filter must itself be
   deterministic over a backing row (it is — it is a subset of the fragment's own
   WHERE, which planned fine over `T`); no extra gate needed.

Output the `RewriteMatch`. The rule (below) turns it into nodes.

## The rule

`planner/rules/cache/rule-materialized-view-rewrite.ts` (new), registered in
`optimizer.ts` `registerRulesToPasses()`, `sideEffectMode: 'safe'`, **`rewrite`
phase, Structural pass**. Placement rationale:

- **Logical→logical, before physical access selection** (`rule-select-access-path`
  in the Physical pass) so the substituted backing `TableReference` flows through
  the *normal* physical access-path selection and costing — the MV scan is then
  just an ordinary table scan to the rest of the optimizer, which is exactly why
  `query_plan()` visibility is free.
- It is `'safe'`: it replaces a subtree with a provably row-equivalent subtree
  whose children survive in the same output positions (same attribute ids). It
  does not move/duplicate/drop a side-effecting subtree (a read-only SELECT
  fragment). Follow the attribute-id-preservation discipline used by
  `rule-join-elimination` and `rule-materialization-advisory`.

**Which node type to register on.** Register on the fragment root the matcher
recognizes — for projection/filter that is the `Project` node (the topmost shape
node). The rule:

1. Runs the gates, enumerates candidate MVs via
   `context.db.schemaManager.getAllMaterializedViews()` filtered to those whose
   `sourceTables` intersect the fragment's base table(s).
2. Calls the matcher for each surviving candidate; collects matches.
3. **Cost gate.** For each match, estimates the MV-backed plan cost
   (`seqScanCost(backingRows)` + residual filter/project cost via
   `filterCost`/`projectCost`, using `context.stats` for `backingRows`) and
   compares to the fragment's current estimated cost (recompute over base). Choose
   the MV scan only when strictly cheaper. When more than one MV matches, pick the
   cheapest; **stable tiebreak** by MV name (lowercased) so plans are
   deterministic.
4. **Builds the replacement.** A `TableReferenceNode` against
   `mv.backingTableName` (construct it the way `building/select.ts` resolves a
   named MV reference to its backing table — reuse that helper rather than
   hand-rolling), wrapped in the residual `Filter` (if `residualClauses`
   non-empty) and a `Project` that **re-emits the fragment's existing output
   Attribute objects/ids** from the backing columns via `outputColumnMap`. The
   replacement MUST carry the identical output attribute ids as the fragment it
   replaces (the parent splice depends on it).
5. Returns the replacement (or `null` when no match / cost declines).

## query_plan() visibility

Free: the replacement is an ordinary `TableReference`/`Retrieve` against
`_mv_<name>`, so `query_plan()` shows the backing-table scan. A golden plan test
asserts the MV-backed scan appears for a rewritten query and the base recompute
appears for a near-miss.

## Tests (TDD)

Unit (`test/` near `covering-structure.spec.ts` style — drive the matcher
directly so per-reason outcomes are observable):
- positive: fragment WHERE ⊇ MV WHERE ⇒ match with residual = the extra clause;
  fragment WHERE == MV WHERE ⇒ match with empty residual.
- negative `predicate-not-entailed`: fragment with no WHERE vs MV with WHERE.
- negative `missing-column`: fragment projects a column the MV omits.
- negative gates: a **stale** MV is never matched; a **non-deterministic-body**
  MV is never matched; a wrong-source MV is `source-mismatch`.

Golden plans (`test/plan/`):
- a query that should rewrite shows the `_mv_<name>` backing scan + residual.
- a near-miss (stale MV, non-entailed predicate) shows the base recompute (no
  rewrite).
- tiny-base / no-cost-win case shows base recompute (cost gate declines).

Equivalence property harness (`test/` — model it on the maintenance-equivalence
oracle, `test/incremental/maintenance-equivalence.spec.ts`): over a corpus of MV
bodies + random base seeds, for every matching scan-project-filter query shape,
assert `rewritten(query) == unrewritten(query)` row-for-row including NULLs and
empty results. Run each query twice — once with the rewrite rule enabled, once
with it disabled (`tuning.disabledRules`) — and assert identical output. This
harness is the soundness backstop the later phases extend with their shapes.

## TODO

### Phase A — matcher + gates
- Create `planner/analysis/query-rewrite-matcher.ts` with the `RewriteResult` /
  `RewriteMatch` types and the candidate gates (stale, determinism, registered
  backing, source intersection). Locate and reuse the create-time determinism
  analysis rather than re-implementing it.
- Implement single-source shape walk (reuse `PASS_THROUGH` / the descent style
  from `coverage-prover.ts`; consider extracting a shared single-source walker if
  it stays DRY without coupling the two provers).
- Implement predicate entailment + residual extraction via
  `recognizeConjunctiveClauses` / `guardClausesEntail` / `normalizePredicate`.
- Implement projection coverage + `outputColumnMap` via stable attribute ids.

### Phase B — rule + cost gate + node construction
- Create `rule-materialized-view-rewrite.ts`; register in `optimizer.ts`
  (`rewrite` phase, Structural pass), `sideEffectMode: 'safe'`.
- Enumerate candidates (`getAllMaterializedViews()`), run matcher, collect matches.
- Cost gate (`seqScanCost` + residual costs vs fragment cost), cheapest-wins,
  stable name tiebreak.
- Build the replacement preserving fragment output attribute ids; reuse the
  backing-table-reference construction from `building/select.ts`.

### Phase C — tests + docs
- Matcher unit tests (positive + per-reason negatives + gates).
- Golden plan tests (rewrite shows backing scan; near-misses show recompute).
- Equivalence property harness (rule-enabled vs rule-disabled identical rows).
- Run `yarn build` and `yarn test` (stream with `Tee-Object`); fix regressions.
- Update `docs/materialized-views.md` (new "Automatic query rewrite (read side)"
  section under § Query resolution, cross-linking the enforcement dual) and
  `docs/optimizer.md` (the new rule + its pass placement). Keep DRY — describe
  the shared matcher once and let the later phases append their shapes.

### Out of scope (park, do not grow this ticket)
- Aggregate rollup → `mv-query-rewrite-aggregate-rollup`.
- Join subsumption → `mv-query-rewrite-join-subsumption`.
- Re-deriving a fragment's computed output column from stored backing inputs
  (v1 requires the column be stored). If worth doing, file a backlog ticket.
