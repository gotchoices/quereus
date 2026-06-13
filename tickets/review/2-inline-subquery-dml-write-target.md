description: Inline subquery as a DML write target — `update (select …) as v set …` / `delete from (select …) as v where …` parse, plan, and write through to the base via the ephemeral view-like substrate (the dual of the CTE-name target). Grammar + AST + stringify for UPDATE/DELETE; inline-subquery INSERT deliberately rejected. Build + lint + full test suite green.
prereq: cte-name-dml-write-target
files:
  - packages/quereus/src/parser/parser.ts                           # subquerySource requireAlias param; subqueryDmlTarget detector; updateStatement/deleteStatement wiring
  - packages/quereus/src/parser/ast.ts                              # UpdateStmt/DeleteStmt targetSource?: SubquerySource + alias docs
  - packages/quereus/src/planner/building/dml-target.ts             # resolveSubqueryTarget — ephemeral view-like from stmt.targetSource
  - packages/quereus/src/planner/building/update.ts                 # route targetSource through buildViewMutation (before CTE/schema dispatch)
  - packages/quereus/src/planner/building/delete.ts                 # same
  - packages/quereus/src/emit/ast-stringify.ts                      # subqueryTargetToString; updateToString/deleteToString render (body) as alias[(cols)]
  - docs/view-updateability.md                                      # L81 made true; new § Inline subquery DML target
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic         # inline-subquery write-through + reject block (appended)
  - packages/quereus/test/emit/ast-stringify.spec.ts               # 3 round-trip tests
  - packages/quereus/test/emit-roundtrip-property.spec.ts           # 2 property arbitraries (update/delete inline target)
----

# Review: inline subquery as a DML write target

A parenthesized subquery is now a real **inline DML write target** for UPDATE/DELETE:

```sql
update (select id, color from base) as v set color = 'x' where v.id = 1
delete from (select id, color from base) as v where v.id = 2
```

The subquery body routes through the **same** `buildViewMutation` substrate a named view /
CTE target uses, via an **ephemeral** `MutableViewLike` (the exact dual of the prereq's
CTE-name target). This is grammar + AST + stringify + a one-function resolver
(`resolveSubqueryTarget`) — the routing/substrate is entirely reused. INSERT is left
unchanged (`insert into (select …)` → existing `Expected table name` parse error).

## What changed (read the diff first)

- **Grammar** (`parser.ts`): `subquerySource` gained a `requireAlias` flag; a new
  `subqueryDmlTarget(withClause)` detects a leading `(` + relation-keyword (the same
  lookahead `tableSource` uses) and parses via `subquerySource` with `requireAlias=true`.
  `updateStatement`/`deleteStatement` call it before `tableIdentifier()`; for DELETE the
  check runs **after** the optional leading `FROM`. The previously-unused `_withClause`
  param is now used (un-prefixed) so the body resolves sibling CTEs.
- **AST** (`ast.ts`): `targetSource?: SubquerySource` on `UpdateStmt`/`DeleteStmt`. When set,
  `table` is a synthetic placeholder identifier `{name: alias}` (so generic `stmt.table.name`
  reads stay total) and `alias` carries the same correlation name.
- **Routing** (`dml-target.ts` + `update.ts`/`delete.ts`): `resolveSubqueryTarget` builds an
  ephemeral view-like (`name=alias`, `selectAst=body`, `columns=rename list`,
  `ephemeral:true`, `noun:'derived table'`) and rejects a DML-bodied target up front. Wired
  **before** the CTE/schema dispatch so the synthetic `table.name` is never re-resolved as a
  same-named CTE/schema object.
- **Stringify** (`ast-stringify.ts`): `subqueryTargetToString` renders `(body) as alias[(cols)]`,
  reusing the FROM-subquery body render; the standalone `as alias` push is suppressed when
  `targetSource` is present (no double-emit).

## Gates (all green; re-run after review changes)

- `yarn workspace @quereus/quereus test` → **6195 passing, 9 pending, 0 failing** (was 6190
  before; +3 ast-stringify round-trip, +2 property arbitraries; the sqllogic block rides the
  existing per-file aggregate `it`).
- `yarn workspace @quereus/quereus lint` → clean (eslint + `tsc -p tsconfig.test.json`).
- `yarn workspace @quereus/quereus build` → clean.
- `93.4-view-mutation.sqllogic` in isolation → green.

## Use cases covered (test floor — treat as a floor, not a ceiling)

Positive (write-through lands on the base, parity with the equivalent named view):
- UPDATE / DELETE through the inline target; DELETE with **and without** the optional `FROM`.
- `v.col` alias-qualified reference in WHERE; bare-column reference; `as v(k,c)` **rename list**
  maps to the right base column.
- RETURNING through the target (single-source base-op embed).
- Composite-PK body; key-preserving **join body** (multi-source substrate).
- **Sibling-CTE read** in the SET value (`with cv as (…) update (select …) as v set x=(select … from cv) …`).
- **Halloween / self-reference** (`… where v.id in (select id from base)`) — a deterministic
  positive write, NOT a reject (see boundary note below).

Reject (structured diagnostic, base unchanged):
- Missing alias (parse: `requires an alias`); aggregate / DISTINCT body (reason parity with the
  equivalent view); DML-bodied target (`no-base-lineage`); inline INSERT (`Expected table name`);
  CTE-in-body (`is not updateable in phase 1`).

## Honest gaps / deviations the reviewer should scrutinize

1. **SET targets are bare, not qualified.** The ticket spec said "SET assigns `v.<col>`", but
   `set v.color = …` is not valid SQL here (or in SQLite) — the SET parser takes a bare column
   name. I tested `v.col` in **WHERE** (an expression position, which works) and bare columns in
   SET. This is a pre-existing grammar limit, not introduced here, but it is a deviation from the
   ticket's literal wording — flag if the reviewer disagrees that bare-SET is the correct contract.
2. **Halloween is a write, not a reject — diverges from the ticket framing.** The ticket lumped
   the Halloween case with the CTE-target ("eager-capture discipline must hold, same as the CTE").
   But an inline subquery has no own-name to shadow out of its body, so the predicate's
   `from base` reads the **real** table and resolves — the write succeeds deterministically
   (both rows → 'x', since `id` is not mutated). The CTE-target rejects the analogous self-read
   precisely because its own name IS shadowed out. I verified determinism but did **not** add a
   key-mutating self-referential stress test (e.g. `set id = id+10 where id in (select id …)`) —
   a reviewer-worthy probe to confirm eager-capture holds when the predicate column is rewritten.
3. **Plan byte-identity not asserted.** Like the prereq, only observable STATE parity vs the named
   view is tested — not a plan-shape/byte-identical-base-op assertion. (The prereq filed
   `cte-dml-write-target-plan-rigor` for this; the inline path shares the substrate, so it would
   be covered by the same rigor work — no separate ticket filed unless the reviewer wants one.)
4. **VALUES-bodied target** (`update (values (1,2)) as v(a,b) …`) is not explicitly tested. It
   rejects downstream in `analyzeView` (`selectAst.type !== 'select'` → `no-base-lineage`), but I
   relied on the code path rather than a pinned test.
5. **Property net body is minimal.** The two new property arbitraries use a single-column
   `select <col> from <tbl>` body (shaped to mirror parser output). They guard against a dropped
   `targetSource`/`columns`, but do not randomize the body shape.

## Re-entry / recursion (checked — safe)

`buildViewMutation` → `propagate` → `rewriteViewUpdate/Delete` builds a **fresh** lowered base
statement (`single-source.ts` ~L1142) with `table = tableIdentifier(baseTable)`, `alias =
SELF_ALIAS`, and **no `targetSource` and no `withClause`**. So when `buildBaseOp` re-enters
`buildUpdateStmt`/`buildDeleteStmt`, both `resolveSubqueryTarget` (no `targetSource`) and
`resolveCteTarget` (no `withClause`) short-circuit → no recursion. Identical guarantee to the
CTE path; confirmed by code path + green suite.

## v1 boundaries (tested + documented in docs/view-updateability.md § Inline subquery DML target)

- INSERT not admitted (`insert into (select …)` → `Expected table name`); by design.
- DML-bodied target → `no-base-lineage` reject.
- Inline body that reads a CTE → `is not updateable in phase 1` (the multi-level boundary).
- Non-decomposable body (aggregate / distinct / limit / window) → same body-shape diagnostic as
  the equivalent view.
- Missing alias → parse error.
