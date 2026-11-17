description: A table can be created with a rule (CHECK) or computed column that calls a function which does not exist, or calls a real function with the wrong number of arguments. Nothing complains until someone tries to write a row, and then every write to that table fails. Refuse such a table when it is created, the way a bad column default already is.
architecture: docs/determinism.md#validation-timing
files:
  - packages/quereus/src/schema/manager.ts   # findNonDeterministicCall (~2582), validateCheckConstraintDeterminism (~2504), validateGeneratedColumnDeterminism (~2551), createTable gate calls (~3074)
  - packages/quereus/src/planner/building/schema-resolution.ts   # resolveFunctionSchema (~127) — the write-time lookup the new gate must mirror
  - packages/quereus/test/logic/44-determinism-validation.sqllogic   # home for the reproduction
  - docs/determinism.md   # § Validation Timing, CREATE TABLE bullets (~157-169)
repro: verified
----

# Unknown function in a CHECK or generated column is accepted at CREATE TABLE

## Reproduction (run against `packages/quereus/dist`)

| Statement | At declaration | At first write |
|---|---|---|
| `create table t (id integer primary key, a integer check (nosuchfn(a) > 0))` | accepted | `Function not found: nosuchfn/1` |
| same, table-level `check (nosuchfn(a) > 0)` | accepted | same |
| `… x integer generated always as (nosuchfn(a)) stored` | accepted | same |
| `… check (exists (select nosuchfn(1)))` (call inside a subquery) | accepted | same |
| `… check (abs(a, a) > 0)` (real function, wrong arity) | accepted | `Function not found: abs/2` |
| `pragma nondeterministic_schema = true` then the first row | accepted | same |
| `… a integer default (nosuchfn(1))` | **rejected** | — |
| `alter table t add constraint c check (nosuchfn(a) > 0)` | **rejected** | — |
| `alter table t add column x … generated always as (nosuchfn(a)) stored` | **rejected** | — |
| `create assertion … check (… nosuchfn(a) …)` | **rejected** | — |

So every other authoring surface already refuses the typo; only the two `CREATE TABLE` gates for CHECK and generated bodies let it through.

## Cause

`SchemaManager.findNonDeterministicCall` (`packages/quereus/src/schema/manager.ts`, ~2582) walks the CHECK / generated body's AST and looks each `function` node up with `findFunction(name, argCount) ?? findFunction(name, -1)`. When both lookups miss, it skips the node — its doc comment says so explicitly ("an unknown function still surfaces at write time, not here"). In addition, both callers short-circuit before walking when `nondeterministic_schema` is on, so even a resolution check placed inside that walk would not run under the pragma.

These gates walk the AST instead of building the expression because a CHECK or generated body names the table's own columns, which have no scope at declaration time. A full build is not an option: a CHECK may legitimately reference its own table or a table created later (`check (a in (select v from later))` followed by `create table later …` is accepted today and its writes succeed — verified), and a build at CREATE would break that.

## The registration-ordering question from the fix ticket — resolved

The fix ticket parked this on "is the function registry populated whenever a schema is declared *or reloaded*?" Findings:

- The CHECK / generated / DEFAULT gates are called only from `SchemaManager.createTable`, i.e. the authoring statement. Catalog reload (`importCatalog` → `importDDL` → `importTable`, used by quereus-store's `rehydrateCatalog` and schema sync) goes through `buildTableSchemaFromAST` and never runs these gates (documented at `docs/determinism.md` § Validation Timing, last CREATE TABLE bullet, and in the doc comment on `validateGeneratedColumnDeterminism`). So placing the new check beside the existing ones leaves reload permissive — a persisted table whose plugin registers late still opens.
- At authoring time the engine already assumes the registry is complete: an unknown function in a DEFAULT is rejected by `createTable` today, as are the ALTER and CREATE ASSERTION cases above. This change extends that existing contract to two more expression sites; it does not introduce it.
- One path re-runs authoring DDL on another connection: quereus-sync replays a remote `create table` with `db.exec(change.ddl)` (`packages/quereus-sync/src/sync/store-adapter.ts` ~1234). A peer lacking a plugin function will now refuse a replicated CREATE TABLE whose CHECK / generated body calls it. That peer already refuses the same table if the function is in a DEFAULT, and already refuses `alter table … add constraint check (…)` with it, so this is the same exposure, not a new class. Accepted; mention it in the NOTE at the site.

No blocking question remains.

## Fix

Make the CREATE TABLE AST walk resolve every function call the same way the write-time builder does (`resolveFunctionSchema` in `planner/building/schema-resolution.ts`: exact arity, then variadic `-1`), and reject a call that resolves to nothing — **regardless of `nondeterministic_schema`** (this is a scope/resolution check like the bind-parameter pre-walk, not a determinism check). Determinism checking stays gated by the pragma as now.

Suggested shape (implementer's call on exact decomposition, keep functions small):

- Add a private `rejectUnresolvedFunctionCalls(expr, site)` (or similar) that walks with `traverseAst`, and for each `function` node whose two lookups both miss throws a `QuereusError` with `StatusCode.ERROR`, worded like the DEFAULT gate: `` `${site} is invalid: Function not found: ${name}/${argCount}` `` — e.g. `CHECK constraint '_check_a' on table 'cf' is invalid: Function not found: nosuchfn/1`. Pass the node's `loc` line/column if present. Walk into subqueries too (the builder resolves calls there with the same registry).
- Call it in `validateCheckConstraintDeterminism` beside `rejectIllegalReferences` (before the `allowNonDeterministic` `continue`), and in `validateGeneratedColumnDeterminism` before its `allowNonDeterministic` early return (restructure so the resolution walk runs in both modes).
- Update `findNonDeterministicCall`'s doc comment: unknown names are now rejected beforehand by the resolution walk, so its "skip unknown" branch is unreachable from these callers.

Do not move any of this into `buildTableSchemaFromAST` — that would put it on the reload path.

### Optional second arm, same site (implementer may include or leave)

The same walk could also refuse an aggregate function used at the top level of a CHECK / generated body (outside any subquery): `check (sum(a) > 0)` is accepted at CREATE today and every insert then fails with `Aggregate function sum not allowed in this context` (verified). It needs subquery-depth tracking — `rejectIllegalReferences` (~2229) already has the `isQueryBoundary` / depth pattern to reuse — because `check (a > (select count(*) from t))` is legitimate. If included, test it with one extra statement; if left, say so in the review handoff.

## Docs

`docs/determinism.md` § Validation Timing, CREATE TABLE bullets: the CHECK bullet (~157) currently claims "any function call is rejected unless the registry marks it DETERMINISTIC", which was never true for unknown names. Rewrite to say every call must resolve in the registry (by name and argument count) — enforced in both `nondeterministic_schema` modes — and must additionally be `DETERMINISTIC` in strict mode. The generated bullet (~161) inherits "walked the same way". Also adjust the opening paragraph of the section (~137-140), which lists the checks that stay on in both modes, to include function resolution.

## TODO

- Add the reproduction to `packages/quereus/test/logic/44-determinism-validation.sqllogic` (follow that file's error-expectation syntax): unknown function in a column CHECK, in a generated column, wrong-arity call (`abs(a, a)`) in a CHECK, and one case under `pragma nondeterministic_schema = true` (restore the pragma afterwards if the file relies on the default). Also keep one positive case proving a CHECK with a forward reference to a later table is still accepted, if no existing test covers it (`grep -rn "select .* from later\|forward" packages/quereus/test/logic/40*.sqllogic` first).
- Implement the resolution walk and wire it into both validators as above.
- Update `findNonDeterministicCall`'s doc comment.
- Add a `NOTE:` at the new walk recording the sync-replay exposure (a peer missing a plugin function refuses the replicated CREATE TABLE, same as for DEFAULT today).
- Update `docs/determinism.md` as above.
- Run `yarn workspace @quereus/quereus test` and `yarn workspace @quereus/quereus lint`. Watch for existing logic tests that declare a CHECK / generated body calling a function registered later in the same file — those would now fail at CREATE and need reordering (that would be a genuine test bug, not a reason to loosen the gate).
