description: When a query is run with values supplied at execution time rather than at prepare time, the engine plans it as if the values' types were unknown. Comparisons between a text column and a number (or the reverse) then quietly return no rows, and storage plugins fall back to scanning a whole table instead of using an index.
prereq: array-param-guard-defeated-by-coercion-cast
architecture: docs/types-parameters.md
files:
  - packages/quereus/src/core/statement.ts (`compile()` lines ~205-218 — freezes parameter types from whatever is bound so far, including nothing; `bind`/`bindAll`; `nextStatement`)
  - packages/quereus/src/core/database.ts (`_evalGenerator` — `prepare(sql)` without params, and the multi-statement branch's `new Statement(this, [lastAst])`)
  - packages/quereus/src/core/param.ts (`getParameterTypes` — `:name` and `name` collide, last one wins)
  - packages/quereus/test/parameter-types.spec.ts
  - packages/quereus/test/property.spec.ts (§ Numeric Affinity, lines ~350-386 — asserts storage-class ordering for `select ? = ?`)
  - docs/types-parameters.md
repro: verified
----
# A statement compiled before anything is bound freezes every parameter at ANY

## Root cause

`Statement.compile()` establishes `parameterTypes` on the **first** compile, from `getParameterTypes(this.boundArgs)`. `getParameterTypes({})` returns an empty `Map` — not `undefined` — so "nothing was bound" is indistinguishable from "types established, and there are none". Every parameter in that plan resolves through `ParameterScope`'s default, `ANY`, and the map is never re-derived, so the values bound afterwards never reach the planner.

The existing `NOTE:` at that site says the freeze "only shows through pre-bind introspection" and names its own revisit condition: *"Revisit (invalidate the plan on a type-changing bind) if pre-bind introspection ever needs to agree with the executed plan."* That condition has tripped — the execution paths below compile before they bind, so the frozen-ANY plan is the one that runs.

## Measured, on a clean tree

`create table t (k integer primary key, v text)` holding `(1, '5')`; query `select k from t where v = ?` bound to `[5]` (an integer against a text column):

| entry point | rows |
| --- | --- |
| `db.eval(sql, [5])` | `[]` — **wrong** |
| `db.eval(sql, [5])` over a multi-statement batch | `[]` — **wrong** |
| `db.prepare(sql).all([5])` | `[]` — **wrong** |
| `db.prepare(sql).get([5])` | `undefined` — **wrong** |
| `db.get(sql, [5])` | `{k: 1}` |
| `db.prepare(sql, [5]).all()` | `{k: 1}` |
| `db.eval(sql, [5], { readConcurrency: 'committed' })` | `{k: 1}` |

The same split appears with the operands reversed (an integer column compared against a `'5'` string parameter). So two `eval` calls that differ only in `readConcurrency` return different answers, and `db.eval` disagrees with `db.get` on identical SQL and parameters.

The filing consumer reported this as a performance defect — a storage module that will not seek on a bound whose plan-time type it cannot trust ran a 30-row range read as a 1,200-row scan, 250-400 ms against 10-58 ms for the same query through `prepare(sql, params)`. That is the same defect seen from outside; silently dropped rows are the sharper face of it.

## Where the compile-before-bind happens

- `Database._evalGenerator` calls `this.prepare(sql)` with no parameters and then `stmt.getColumnNames()`, which compiles. Its multi-statement branch builds `new Statement(this, [lastAst])` with no parameters either. `_iterateRowsRaw(params)` binds afterwards, too late.
- `Statement.all(params)` / `get(params)` / `_allConcurrentGenerator(params)` each read `getColumnNames()` before handing `params` to `_iterateRowsRawInternal`, so a statement prepared without parameters is frozen by its own `all()` call.
- Any caller that introspects (`getColumnDefs()`, `isQuery()`, `getPlanShape()`) before binding freezes the statement for its whole life.

`_iterateRowsRawInternal` itself is already in the right order — `bindAll(params)` precedes `compile()`. Only the callers that read column names first defeat it.

## Fix: establish types from the first binding, never from emptiness

Make "frozen from zero bindings" unrepresentable rather than patching each caller:

- In `compile()`, when `parameterTypes` is `undefined`, infer from `boundArgs` and assign **only if the inferred map is non-empty**. Otherwise leave `parameterTypes` undefined, build the plan with defaults (parameters announce `ANY`, unchanged), and record that the plan is provisional — a private `planTypesProvisional` flag is enough.
- In `bind()` and `bindAll()`, when the plan is provisional and `boundArgs` is now non-empty, drop it: clear `planTypesProvisional`, set `needsCompile = true`, null `plan` / `emissionContext` / `scheduler`, and clear `columnDefCache` — the same invalidation set the schema-change listener in `compile()` uses. The next `compile()` then establishes real types.
- `nextStatement()` already resets `parameterTypes`; reset the provisional flag there too.

This preserves every contract currently pinned by tests: pre-bind introspection still announces `ANY`; types established from a bind are still frozen, so `bindAll([9])` then `get([3.14])` still raises `Parameter type mismatch`; a statement prepared with values or explicit hints never recompiles. It costs at most one extra compile, and only for a statement that was compiled before its first bind.

Prototyped against the current tree: every entry point in the table above returns `{k: 1}`, including the multi-statement `eval` batch, with no change to `database.ts` at all.

### Also fix `_evalGenerator`, for cost not correctness

`eval` prepares a fresh statement per call, so under the change above every parameterised `eval` would compile twice. Pass `params` to `prepare(sql, params)` and to the multi-statement branch's `new Statement(...)`, then pass `undefined` down to `_iterateRowsRaw` so the values are not rebound and revalidated — exactly what `Database.get` and `_evalRoutedGenerator` already do, with the same comment explaining why. The earlier statements of a multi-statement batch keep going through `_executeSingleStatement(ast, params)`, which already types its plan correctly.

## Two coupled changes, or the suite goes red

**1. `getParameterTypes` key collision (`core/param.ts`).** It normalizes a `:name` key to `name`, so an argument object carrying both spellings collapses to one entry, last one wins — while `boundArgs` keeps both and `validateParameterTypes`' scalar-guard lookup deliberately gives the **bare** key precedence (`Object.hasOwn`, not `??`). Today the eval path never infers types at all, so the disagreement is invisible there; once it does, `parameter-array-scalar.spec.ts`'s "honors a null bare binding rather than the `:`-prefixed alternate" case types `:needle` from the array alternate and dies with `expected non-nullable JSON, got NULL`. Fix: in `getParameterTypes`, skip a `:`-prefixed entry when the bare key is also present, matching the precedence the bind-time lookup already uses. (This is a live defect on the typed paths today, not one the root fix introduces.)

**2. `property.spec.ts` § Numeric Affinity.** It asserts that `select ? = ?` compares by storage class ("NULL < INTEGER/REAL < TEXT < BLOB"), driving the assertion through `db.eval`. Once `eval` plans with types, `'!'` against `0` coerces the text side to NUMERIC per `types/comparison-coercion.ts` and compares equal, and the property fails on the counterexample `["!", 0]`.

The engine's rule is settled, not in question: on a clean tree `db.get("select ('!' = 0) as r")` — **literals, no parameters anywhere** — already returns `true`, as does `db.get("select ('!' = ?) as r", [0])` and `db.get('select (? = ?) as r', ['!', 0])`. Only the untyped-parameter spelling answers `false`. So the property test encodes the behaviour of the defect rather than the engine's documented coercion rule, and the fix makes `? = ?` agree with the literal spelling of the same comparison. Update the test: either restrict its storage-class oracle to same-class pairs and assert the coercion rule for a text-vs-numeric pair, or replace `compareSqlValues` as the oracle for mixed-class pairs. Do not weaken it into a tautology — it should still pin the ordering for pairs within one storage class. Call this out in the review handoff: it is the one deliberate behaviour change in this ticket.

## Blast radius, measured

With the prototype of this ticket **and** its prereq applied: `yarn workspace @quereus/quereus run test` reported **7671 passing, 1 failing** — the `property.spec.ts` numeric-affinity property above, and nothing else. Other workspaces were not run against the prototype; run the full root `yarn test` during implementation.

## TODO

- Add the provisional-plan representation to `Statement`: assign `parameterTypes` in `compile()` only when the inferred map is non-empty, and track that the plan was built without established types.
- Invalidate a provisional plan from `bind()` and `bindAll()` once something is bound, reusing the schema-change invalidation set (`needsCompile`, `plan`, `emissionContext`, `scheduler`, `columnDefCache`); reset the flag in `nextStatement()`.
- Rewrite the stale `NOTE:` in `compile()` — it now documents the new invariant ("types are established from the first binding source, never from emptiness"), and its "only shows through pre-bind introspection" claim and its TEXT-default reference are both wrong today (the default has been `ANY` since `planner/scopes/param.ts` changed it).
- Pass `params` into `prepare` and into the last-statement `Statement` in `Database._evalGenerator`, and pass `undefined` downstream so the values are not rebound; mirror the comment in `Database.get`.
- Give `:name`/`name` the bare-key precedence in `getParameterTypes` (`core/param.ts`).
- Update `property.spec.ts` § Numeric Affinity as described above, and say in the review handoff that `select ? = ?` for mixed-class operands changed answer.
- Add a parity test — one query, every entry point (`db.eval`, `db.eval` with `readConcurrency: 'committed'`, `db.eval` over a multi-statement batch, `db.get`, `db.prepare(sql, params).all()`, `db.prepare(sql).all(params)`, `db.prepare(sql).get(params)`) must return the same rows for a cross-type parameter comparison. Write it as a table-driven case so a future entry point is cheap to add; this is the test that catches the whole class, not just `eval`.
- Add a case pinning that pre-bind introspection still announces `ANY`, and that binding afterwards re-announces the bound value's type (`getColumnDefs()` before and after `bindAll`).
- Update `docs/types-parameters.md`: "Types are established at prepare time" becomes "from the first binding source — values or hints at `prepare()`, otherwise the first `bind`/`bindAll`/execution-time parameters"; note that a statement compiled before its first bind recompiles once; state that `db.eval(sql, params)` plans with those types.
- Run `yarn test` from the repo root and `yarn lint`.
