description: |
  A lens row-local CHECK whose subquery correlates a write-row column whose **logical name differs
  from its basis name** crashes at plan-build with `Column not found: <logicalName>`. `rewriteToBasisTerms`
  (planner/mutation/lens-enforcement.ts) rewrites a logical CHECK into basis terms via `transformExpr`
  **without** the `descend` argument, so it does not descend into subquery operands — a correlated bare
  write-row ref *inside* a subquery keeps its **logical** name, which then fails to resolve against the
  basis write row when logical≠basis spelling. Independent of decomposition: reproduces on a plain
  single-source lens too. Sibling/residual of `lens-decomp-row-local-subquery-metadata-gate`, which fixed
  the per-op GATE (constraint now routes onto the owning member) but left the REWRITE — explicitly scoped
  out of that ticket ("do not modify rewriteToBasisTerms").
files:
  - packages/quereus/src/planner/mutation/lens-enforcement.ts   # rewriteToBasisTerms (~L78); needs scope-aware descent
  - packages/quereus/src/planner/mutation/scope-transform.ts    # transformExpr `descend` arg; transformScopedExpr/Query + ScopeContext are the existing scope-aware machinery to reuse
  - packages/quereus/test/lens-put-fanout.spec.ts               # setupSubqueryCheck fixture: logical docKey maps to basis doc_key (a ready-made logical≠basis pair)
----

# Lens row-local subquery CHECK: correlated write-row ref with logical≠basis name crashes at build

## Symptom

```sql
declare logical schema x { table Doc { docKey text primary key, title text, ...
  constraint keyallow check (exists (select 1 from Allowed where Allowed.name = docKey)) } }
-- docKey (logical) projects from basis column doc_key (different spelling)
update x.Doc set title = 'ok' where docKey = 'k1';
-- ⇒ QuereusError: Column not found: docKey   (at plan build)
```

`docKey` is a correlated **write-row** ref appearing only inside the subquery. The
`lens-decomp-row-local-subquery-metadata-gate` fix correctly gates this CHECK onto the member op that
owns `doc_key`, but `rewriteToBasisTerms` leaves the subquery body untouched, so the built constraint
still spells the column `docKey`, which does not exist on the basis table (it is `doc_key`).

Confirmed reproducible during review of the gate ticket (a temporary test correlating `docKey` over the
existing `setupSubqueryCheck` fixture printed `REWRITE-GAP CRASH: Column not found: docKey`). The gate
ticket's own tests deliberately use same-named columns (`title`/`note`) to isolate the gate from this gap.

## Root cause

`rewriteToBasisTerms` (planner/mutation/lens-enforcement.ts ~L78):

```ts
function rewriteToBasisTerms(expr: AST.Expression, map: ReadonlyMap<string, string>): AST.Expression {
  return transformExpr(expr, (col) => { ... });   // no `descend` arg ⇒ subqueries pass through verbatim
}
```

`transformExpr` (scope-transform.ts) only descends into `subquery` / `exists` / `in (select …)` operands
when given a third `descend` transformer. Without it, a logical column correlated from inside a subquery
is never rewritten to its basis spelling.

## Requirements / expected behavior

- A row-local lens CHECK containing a subquery that **correlates** a write-row column must rewrite that
  correlated ref to its basis spelling, exactly as a top-level ref already is — so the built constraint
  resolves against the basis write row regardless of logical vs basis column naming.
- Subquery-**local** references (resolving against the subquery's own FROM) must stay untouched — the
  rewrite must be scope-aware, not a blanket rename. The existing `transformScopedExpr` /
  `transformScopedQuery` + `ScopeContext` machinery in scope-transform.ts already implements exactly this
  shadow/taint model for the single-source and multi-source backward paths; reuse it rather than a new
  walker (the module docstring already lists lens-enforcement as a shared caller).
- Must hold for both single-source and decomposition lenses.

## Use cases for testing

- Single-source lens, subquery row-local CHECK correlating a logical-named column whose basis spelling
  differs (e.g. `docKey`→`doc_key`): builds, enforces, ABORTs a violation.
- Decomposition lens, same shape, correlated column owned by one member: gates onto that member (gate
  already correct) AND now builds + enforces.
- Negative: a subquery-LOCAL column that happens to share a logical column's name is NOT rewritten
  (resolves against the subquery FROM) — guard against over-rewriting.
- Confirm the metadata derivation in the gate ticket stays consistent (it maps logical→basis already;
  this ticket makes the *expression* agree with that metadata).
