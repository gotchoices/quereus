description: Build the missing capability that makes CTE-name and subquery-in-FROM DML write targets real — `update <cte>`, `insert into <cte>`, `delete from <cte>`, and the inline `update (select …) as v set …` / `delete from (select …) where …` forms — routing through the existing predicate-driven view-mutation substrate. Today the docs (view-updateability.md L81, L662) claim this works but the engine has no such path: DML targets parse as bare identifiers only and a CTE name falls through to a schema-manager lookup miss.
files:
  - packages/quereus/src/parser/ast.ts                              # InsertStmt.table / UpdateStmt.table / DeleteStmt.table are IdentifierExpr; alias? fields exist but parser never produces them
  - packages/quereus/src/parser/parser.ts                           # tableIdentifier() at the three DML productions (~422 insert, ~2271 update, ~2331 delete) rejects a parenthesized/subquery target
  - packages/quereus/src/planner/building/insert.ts                 # ~476 resolves stmt.table via getView/getMaintainedTable only
  - packages/quereus/src/planner/building/update.ts                 # ~70 same
  - packages/quereus/src/planner/building/delete.ts                 # ~70 same
  - packages/quereus/src/planner/building/view-mutation.ts          # the substrate a CTE/subquery target must route into (propagate / single-source spine / multi-source)
  - docs/view-updateability.md                                      # L81, L662 already describe the end-state; this makes them true
difficulty: hard
----

# CTE / subquery-in-FROM as DML write targets

## Decision context (2026-06-13, human sign-off)

The block on `with-defaults-cte-subquery-targets` surfaced that the docs claim
CTE bodies and subqueries-in-FROM are first-class write targets, but no such
path exists — DML targets parse as bare identifiers and a CTE name misses the
schema-manager lookup. Asked whether the docs were aspirational or over-claiming,
the dev chose **build the capability**. This ticket is that feature; the
`with-defaults-cte-subquery-targets` test ticket chains behind it.

## What this is

A logical table reachable by view-update decomposition should be writable
through DML whether it is named by a `create view`, a `with` CTE, or an inline
`from`-subquery. The view-mutation substrate (`view-mutation.ts` — single-source
projection/filter spine, two-table key-preserving joins, decomposition fan-out,
predicate-driven default recovery) already does the hard part for views. The gap
is purely **reaching it** from a non-view DML target:

1. **Grammar** — accept a write target that is (a) a CTE name introduced by a
   leading `with`, or (b) a parenthesized subquery with a mandatory alias for
   UPDATE/DELETE (`update (select …) as v set …`, `delete from (select …) as v
   where …`). The `alias?` fields already on `UpdateStmt`/`DeleteStmt` (today
   never produced) are the natural carriers. INSERT into a CTE name is in scope
   where the body is insert-decomposable; an inline-subquery INSERT target
   (`insert into (select …)`) is the odd one — decide in the plan pass whether it
   is admitted or only the CTE-name INSERT form is.
2. **AST** — widen the three DML `table` fields (or add a parallel
   `targetSource`) so a non-identifier target round-trips through stringify.
3. **Resolution / routing** — when the target is a CTE name, resolve it against
   the planning **scope** (where CTEs live) rather than the schema manager, take
   its body relational expression, and route it through the same
   `buildViewMutation` / `propagate` path a view body takes; an inline subquery
   target uses its parsed body directly. Non-decomposable bodies (aggregate,
   DISTINCT, LIMIT, recursive CTE, set-op legs that are not key-preserving) reject
   with the existing structured view-update diagnostics — the same obstruction
   vocabulary, just reached from a new target kind.

## Reuse, do not fork

The whole point is that this adds **no** new write semantics: it reuses the
predicate-driven updateability framework verbatim (constant-FD default recovery,
write routing by writable-presence columns, the `no-inverse` / `no-default` /
`predicate-contradiction` / `recursive-cte` diagnostics, the round-trip prover).
A CTE/subquery target that is structurally a single-source projection-and-filter
must behave **identically** to the equivalent named view — that equivalence is
the acceptance bar and the natural property test (the existing View Round-Trip
Laws block extended to CTE/subquery targets).

## Acceptance (to refine in the plan pass)

- `with t as (select id, color from base) update t set color = 'x' where id = 1`
  writes through to `base` exactly as the equivalent view would; same for the
  `insert into t` and `delete from t` forms over a decomposable CTE body.
- `update (select id, color from base) as v set color = 'x' where v.id = 1` and
  the `delete from (select …) as v where …` inline forms parse and write through.
- A non-updatable CTE/subquery target (aggregated, DISTINCT, recursive, LIMIT)
  rejects with the same structured diagnostic the equivalent view body raises —
  never a generic "table not found" or "expected table name".
- view-updateability.md L81 / L662 become **true** (the prose already describes
  this end-state); the `with-defaults-cte-subquery-targets` test ticket then runs
  as originally written.
- Stringify round-trips a CTE/subquery DML target (emit-roundtrip nets extended).

## Edge cases & interactions (for the plan pass to enumerate)

- CTE-name vs schema-table name collision (a CTE shadowing a real table as a
  write target) — resolution order and whether to warn.
- A CTE referenced as a write target **and** read in the same statement
  (self-reference / Halloween) — must reuse the eager-capture discipline.
- Compound-leg / `union`-bodied CTE as a target (membership-routed write — ties
  into the predicate-driven set-op decomposition; keep out of scope or chain).
- Multi-source (join) CTE body as an UPDATE/DELETE target — already supported for
  views; confirm it composes through the new target resolution unchanged.
- `with defaults (…)` riding the target (the dependent test ticket) and
  `with schema` / `with context` clause ordering on a CTE-targeted DML.
- Recursive CTE as a target → `recursive-cte` reject (already in the vocabulary).
