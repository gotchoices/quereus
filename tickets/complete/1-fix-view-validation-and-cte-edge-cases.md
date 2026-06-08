description: Closed view column-list arity, CTE-in-VIEW body, recursive CTE LIMIT, and CTE column-count mismatch validation gaps
prereq:
files:
  packages/quereus/src/parser/parser.ts
  packages/quereus/src/planner/building/create-view.ts
  packages/quereus/src/planner/building/with.ts
  packages/quereus/src/planner/nodes/recursive-cte-node.ts
  packages/quereus/src/runtime/emit/recursive-cte.ts
  packages/quereus/test/logic/08.1-view-edge-cases.sqllogic
  packages/quereus/test/logic/13.4-cte-extras.sqllogic
  packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic
  docs/sql.md
----
## What was built

Four small validation/execution gaps closed around DDL/CTE handling:

1. **View column-list arity check at DDL time** — `buildCreateViewStmt`
   (`src/planner/building/create-view.ts`) plans the SELECT body when an explicit
   column list is supplied and rejects the DDL if declared arity ≠ projection
   arity. Discarded plan; only `getAttributes().length` is read. No schema
   side effects (only attribute IDs are consumed from the global counter).

2. **CREATE VIEW body may begin with WITH** — `createViewStatement`
   (`src/parser/parser.ts:2324`) optionally consumes a leading `WITH` after `AS`,
   threads it into `selectStatement` for FROM-clause CTE resolution, and
   re-attaches it to `select.withClause` so `selectToString` reproduces the
   correct stored SQL.

3. **Recursive CTE LIMIT/OFFSET** — `buildRecursiveCTE`
   (`src/planner/building/with.ts`) lifts `limit`/`offset` from the outer
   compound select onto a new `RecursiveCTENode` (carried as optional 3rd/4th
   children with proper `getChildren`/`withChildren` arity bookkeeping).
   `emitRecursiveCTE` (`src/runtime/emit/recursive-cte.ts`) gates yields
   through `tryYield`: skips OFFSET produced rows then stops once LIMIT yields
   are reached. The infinite-recursion safety check is suppressed when LIMIT
   has been satisfied. The recursive-iteration `try/finally` releases the
   `tableContexts` slot even when `break` exits the inner `for await`.

4. **CTE column-count mismatch** — `buildCommonTableExpr` and `buildRecursiveCTE`
   error when declared column count differs from the inner SELECT projection
   arity (matching SQLite).

## Key files

- `packages/quereus/src/parser/parser.ts` — `createViewStatement` parses inner WITH
- `packages/quereus/src/planner/building/create-view.ts` — DDL-time arity check
- `packages/quereus/src/planner/building/with.ts` — column-count validation + LIMIT/OFFSET extraction
- `packages/quereus/src/planner/nodes/recursive-cte-node.ts` — variable-arity children for limit/offset
- `packages/quereus/src/runtime/emit/recursive-cte.ts` — `tryYield` early-termination gate
- `docs/sql.md` §3.7.3 — added LIMIT-as-recursion-cap example

## Tests

- `test/logic/08.1-view-edge-cases.sqllogic` — `create view cr_bad (a, b) as select id, name, val from cr_base` errors
- `test/logic/13.4-cte-extras.sqllogic` — recursive `limit 5` yields 5 rows; `limit 0` yields 0 rows; `with bad(a, b) as (select 1)` errors; `create view ... as with positives as (...) select ...` parses and queries correctly
- `test/logic/41.3-alter-rename-propagation.sqllogic` — comment updated; the test stays disabled because rename propagation through views is independently unimplemented (out of scope here)

## Validation

- `npx tsc --noEmit` — clean
- `yarn lint` (in `packages/quereus`) — clean
- `yarn test` (memory module) — 918 passing. The 3 ticket-specific files
  (`08.1-view-edge-cases`, `13.4-cte-extras`, `41.3-alter-rename-propagation`)
  all pass on HEAD.
- One unrelated failure remains:
  `extended-constraint-pushdown.spec.ts:289` (OR with range predicate) — verified
  this is pre-existing on HEAD and not introduced by this ticket. The OR test
  passes both at the ticket's fix commit (`7922732b`) and at the prior review
  commit (`9c8058b4`); regression originates in a later, unrelated commit on
  the constraint-pushdown / OR-predicate code path.

## Review notes

- `tryYield` early-termination cleans up `tableContexts`: the `try/finally`
  inside the recursive-iteration loop always runs `tableContexts.delete` even
  when `break` exits the inner `for await`. The base-case loop never sets a
  table context, so it doesn't need cleanup.
- Planning the view's SELECT inside `buildCreateViewStmt` for the arity check
  has no schema side effects — `buildSelectStmt` only walks the AST and
  resolves references.
- For recursive CTE LIMIT, the gate counts rows that survive UNION DISTINCT
  dedup (i.e., user-visible output), matching SQLite. OFFSET applies after
  dedup, before LIMIT.
- `RecursiveCTENode.getChildren`/`withChildren` are now variable-arity
  (2..4 children depending on whether limit/offset were specified). No
  optimizer rules reference `RecursiveCTENode` directly, so there is no rule
  fan-out concern. `withChildren` reconstructs the optional slots in the same
  order they were emitted.

## Usage

```sql
-- View column-list arity is now caught at CREATE VIEW time
create view bad (a, b) as select 1, 2, 3;
-- ERROR: View 'bad' has 2 declared columns but SELECT produces 3

-- WITH is now allowed inside the view body
create view recent_active as
  with active as (select id, last_seen from users where active = 1)
  select id from active where last_seen > date('now', '-7 days');

-- LIMIT bounds an unbounded recursion
with recursive nat(n) as (
  select 1
  union all
  select n + 1 from nat
  limit 100
)
select count(*) from nat;  -- 100

-- CTE column-count mismatch is caught
with bad(a, b) as (select 1) select * from bad;
-- ERROR: CTE 'bad' has 2 declared columns but query produces 1
```
