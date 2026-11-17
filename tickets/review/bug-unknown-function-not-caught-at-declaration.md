description: CREATE TABLE now refuses a CHECK rule or computed column that calls a function which does not exist, calls a real one with the wrong number of arguments, or uses an aggregate like sum() directly on the row — all of which used to be accepted and then made every write to the table fail.
architecture: docs/determinism.md#validation-timing
files:
  - packages/quereus/src/schema/declaration-calls.ts   # new: findUnbuildableCall, resolveCallSchema, isQueryBoundary
  - packages/quereus/src/schema/manager.ts   # rejectUnbuildableCalls (new), validateCheckConstraintDeterminism, validateGeneratedColumnDeterminism, findNonDeterministicCall, rejectIllegalReferences (now imports isQueryBoundary)
  - packages/quereus/test/logic/44-determinism-validation.sqllogic   # Test 9
  - docs/determinism.md   # § Validation Timing
repro: verified
----

# Unknown function in a CHECK or generated column is now refused at CREATE TABLE

## What changed

`SchemaManager.createTable`'s CHECK and `GENERATED ALWAYS AS` gates now run a resolution walk (`findUnbuildableCall` in the new `schema/declaration-calls.ts`) before the determinism walk, in **both** `nondeterministic_schema` modes. The walk rejects the first call the write-time build is certain to refuse:

- a plain call with no registry entry by name + argument count, falling back to a variadic (`-1`) entry — the same lookup `resolveFunctionSchema` (`planner/building/schema-resolution.ts`) does; message `… is invalid: Function not found: <name>/<n>`;
- a window call (`f(...) over (...)`) naming no registered window function — resolved against the window registry, as the builder does, and its inner call is not looked up as a plain function (window-only names like `row_number` are not in the plain registry); message `Unknown window function: <name>`;
- an aggregate call outside every subquery (the optional second arm from the fix ticket — included); message `Aggregate function <name> not allowed in this context`. Subquery depth uses the shared `isQueryBoundary`, now exported from the new module and reused by `rejectIllegalReferences`.

Error text: `CHECK constraint '<name>' on table '<t>' is invalid: <reason>` / `GENERATED ALWAYS AS for column '<c>' in table '<t>' is invalid: <reason>`, with the call's line/column.

The walk never inspects table references, so `check (a in (select v from later))` before `create table later …` is still accepted and its writes succeed (probed by hand). Catalog reload (`importTable` via `buildTableSchemaFromAST`) never reaches these gates — unchanged. A `NOTE:` on `rejectUnbuildableCalls` records the quereus-sync replay exposure: a peer missing a plugin function now refuses a replicated CREATE TABLE whose CHECK/generated body calls it, as it already did for DEFAULT and `alter table … add constraint check`.

`findNonDeterministicCall` now uses the shared `resolveCallSchema`; its "skip unknown" branch is unreachable from the two gates (doc comment updated).

## Test added

`44-determinism-validation.sqllogic` § Test 9 (one statement each):

- unknown function in a column CHECK → full message incl. site, pins the CHECK gate;
- unknown function in a stored generated column → full message, pins the generated gate;
- `exists (select abs(a, a))` → wrong arity, reached inside a subquery;
- `check (sum(a) > 0)` → top-level aggregate arm;
- unknown function under `pragma nondeterministic_schema = true` → pragma does not lift it (pragma restored to false after).

## Validation run

- `yarn workspace @quereus/quereus test` — 11187 passing, 23 pending; `lint` clean.
- `@quereus/store` (2019), `@quereus/isolation` (460), `@quereus/sync` (879), `@quereus/bundle` (14) — all passing.
- Hand probes against `dist` (not kept as tests): `row_number() over (order by k)` inside a CHECK subquery accepted and insert works; `nosuchwin() over ()` rejected; `count(*)` in a CHECK subquery accepted; forward reference to a later table accepted and writable; `generated always as (sum(a))` rejected at CREATE (ALTER ADD COLUMN already rejected it through its build); `a->>'$.x'` (desugars to `json_extract`) accepted.

## Known gaps / for the reviewer

- Table-valued functions in a subquery's FROM (`functionSource` nodes, e.g. `select … from nosuchtvf(1)`) are **not** resolved by the new walk — an unknown one still surfaces at first write. Same class, left out to keep scope to `function` nodes; the builder resolves them via `resolveFunctionSchema` + an `isTableValuedFunctionSchema` check (`planner/building/table-function.ts`), so adding it would be a small arm in `findUnbuildableCall`.
- Window-call arity is not checked (only the name); the builder also checks `argCount` and `requiresOrderBy`. A window call is only legitimate inside a subquery of a CHECK, so this is contrived.
- The generated-column gate still does not reject bind parameters (pre-existing; the CHECK gate does). `docs/determinism.md` says generated bodies are "walked the same way CHECK constraints are", which overstates that one point — not introduced here.
- No scalar `max(a, b)` exists in this engine, so `check (max(a, b) > 0)` is now refused at CREATE with `Function not found: max/2` — correct (the write-time build refuses it identically), but a user coming from SQLite may notice the earlier error.
