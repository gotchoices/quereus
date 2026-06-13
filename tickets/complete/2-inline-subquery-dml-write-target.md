description: Inline subquery as a DML write target — `update (select …) as v set …` / `delete from (select …) as v where …` parse, plan, and write through to the base via the ephemeral view-like substrate (the dual of the CTE-name target). Grammar + AST + stringify for UPDATE/DELETE; inline-subquery INSERT deliberately rejected. Shipped, reviewed, build + lint + full test suite green.
files:
  - packages/quereus/src/parser/parser.ts                           # subquerySource requireAlias; subqueryDmlTarget; startsParenSubquery (shared lookahead helper)
  - packages/quereus/src/parser/ast.ts                              # UpdateStmt/DeleteStmt targetSource?: SubquerySource + alias docs
  - packages/quereus/src/parser/visitor.ts                          # traverseAst now descends into stmt.targetSource (update + delete)
  - packages/quereus/src/planner/building/dml-target.ts             # resolveSubqueryTarget — ephemeral view-like from stmt.targetSource
  - packages/quereus/src/planner/building/update.ts                 # route targetSource through buildViewMutation (before CTE/schema dispatch)
  - packages/quereus/src/planner/building/delete.ts                 # same
  - packages/quereus/src/emit/ast-stringify.ts                      # subqueryTargetToString; updateToString/deleteToString render (body) as alias[(cols)]
  - docs/view-updateability.md                                      # § Inline subquery DML target
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic         # inline-subquery write-through + reject block (+ key-mutating Halloween, + VALUES-body reject)
  - packages/quereus/test/emit/ast-stringify.spec.ts               # 3 round-trip tests
  - packages/quereus/test/emit-roundtrip-property.spec.ts           # 2 property arbitraries
  - packages/quereus/test/visitor.spec.ts                          # 2 inline-target traversal tests
----

# Inline subquery as a DML write target (complete)

A parenthesized subquery is now a real **inline DML write target** for UPDATE/DELETE:

```sql
update (select id, color from base) as v set color = 'x' where v.id = 1
delete from (select id, color from base) as v where v.id = 2
```

The subquery body routes through the **same** `buildViewMutation` substrate a named view /
CTE target uses, via an **ephemeral** `MutableViewLike` (the exact dual of the prereq's
CTE-name target). Implementation is grammar + AST + stringify + a one-function resolver
(`resolveSubqueryTarget`); the routing/substrate is entirely reused. INSERT is left
unchanged (`insert into (select …)` → existing `Expected table name` parse error).

See `docs/view-updateability.md` § Inline subquery DML target for the timeless spec.

## Review findings

Adversarial pass over commit `e6ae72f6` (implement). Diff read fresh before the handoff,
then every aspect scrutinized. Outcome: **no major findings; three minor fixes applied in
this pass**; the handoff's self-declared gaps were each verified and dispositioned.

### What was checked

- **Parser correctness / lookahead.** `subqueryDmlTarget` detects `(` + relation keyword
  (same set as the FROM-subquery path) and parses via `subquerySource(requireAlias=true)`;
  placed before `tableIdentifier()` (UPDATE) and after the optional leading `FROM` (DELETE).
  Probed the bare-alias-without-`AS` forms (`delete from (select …) v where …`,
  `update (select …) v set …`, trailing bare alias) — **all parse correctly**; the
  `isEndOfClause` check tests the alias token itself (not the following keyword), so a bare
  alias immediately before `WHERE` is recognized. No off-by-one.
- **Pre-dispatch `stmt.table` reads.** The synthetic placeholder `table = {name: alias}` has
  no `schema`, so the early `isCommittedSchemaRef(stmt.table.schema)` guard and tag
  diagnostics stay total and never misfire. Inline resolution runs before the CTE/schema
  dispatch, so the synthetic name is never re-resolved as a same-named object.
- **Write-through behavior (ad-hoc probes, all green).** Key-mutating Halloween
  self-reference (`set id = id+10 where v.id in (select id from t)`) is **deterministic**
  (eager-capture holds: {1,2} captured pre-write → 1→11, 2→12). Alias **shadowing a real
  same-named table** writes through to the base and leaves the same-named table untouched.
  Bind **parameters** in the target `where` work. **DELETE … RETURNING** through the target
  works.
- **Reject paths.** Missing alias (parse `requires an alias`); aggregate/DISTINCT body
  (`is not updateable in phase 1`, parity with the equivalent view); DML-bodied target
  (`no recoverable base operation`); **VALUES-bodied target** (`has no recoverable base
  operation`, downstream in view analysis); inline INSERT (`Expected table name`);
  CTE-in-body (`is not updateable in phase 1`).
- **Stringify round-trip.** `(body) as alias[(cols)]`; standalone `as alias` push suppressed
  when `targetSource` is set (no double-emit); rename list survives. Verified string-stable.
- **Re-entry / recursion.** The lowered base statement carries no `targetSource`/`withClause`,
  so `resolveSubqueryTarget`/`resolveCteTarget` short-circuit on re-entry — no recursion.
- **Docs.** `docs/view-updateability.md` § Inline subquery DML target reflects the shipped
  reality (alias-mandatory, Halloween-is-a-write, v1 boundaries, INSERT excluded).

### Minor findings — fixed in this pass

1. **AST visitor did not descend into `targetSource`** (`parser/visitor.ts`). The `update` /
   `delete` cases traversed only `stmt.table` (the synthetic alias placeholder), so the real
   inline subquery body was invisible to `traverseAst`. Latent — current consumers
   (`schema/manager.ts`, `schema/table.ts`) only walk DEFAULT/CHECK/generated **expression**
   subtrees, not full UPDATE/DELETE statements — but a real incompleteness in a shared,
   tested utility (every other child node is traversed). **Fixed**: both cases now
   `traverseAst(stmt.targetSource, …)`; added two `visitor.spec.ts` cases asserting the inner
   `select` is reached.
2. **DRY: duplicated relation-keyword lookahead** (`parser.ts`). The 6-way token OR was copied
   between `tableSource` and the new `subqueryDmlTarget`. **Fixed**: extracted
   `private startsParenSubquery()`; both call sites now share it. Behavior identical (full
   suite green).
3. **Test floor strengthened** (`93.4-view-mutation.sqllogic`). Added the **key-mutating
   Halloween** write-through (handoff gap #2 — confirms eager-capture when the predicate
   column is itself rewritten) and the **VALUES-bodied reject** (handoff gap #4 — was code-path
   only). Both pinned.

### Handoff gaps — dispositioned (no action needed)

- **#1 bare SET targets** — correct contract (`set v.col` is not SQL here or in SQLite); not a
  deviation to fix.
- **#3 plan byte-identity not asserted** — shared substrate with the CTE target; folded into
  the existing backlog ticket `cte-dml-write-target-plan-rigor` (extended its scope to add the
  inline-target comparison arm), rather than filing a near-duplicate.
- **#5 minimal property net** — the two property arbitraries guard against a dropped
  `targetSource`/`columns`; the sqllogic + ad-hoc probes cover body-shape variety. Acceptable
  for v1; the plan-rigor ticket carries the deeper structural assertions.

### Major findings

None. No new fix/plan tickets filed. One backlog ticket
(`cte-dml-write-target-plan-rigor`) had its scope extended to cover the inline-target plan
rigor (shared substrate).

## Gates (all green)

- `yarn workspace @quereus/quereus test` → **6197 passing, 9 pending, 0 failing**
  (+2 visitor traversal tests over the implement baseline; sqllogic additions ride the
  per-file aggregate).
- `yarn workspace @quereus/quereus lint` → clean (eslint + `tsc -p tsconfig.test.json`).

## v1 boundaries (tested + documented)

- INSERT not admitted (`insert into (select …)` → `Expected table name`); by design.
- DML-bodied / VALUES-bodied target → `no recoverable base operation` reject.
- Inline body that reads a CTE → `is not updateable in phase 1` (multi-level boundary).
- Non-decomposable body (aggregate / distinct / limit / window) → same body-shape diagnostic
  as the equivalent view.
- Missing alias → parse error.
