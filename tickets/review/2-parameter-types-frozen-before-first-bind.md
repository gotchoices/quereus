description: A query run with values supplied at execution time used to be planned as if those values' types were unknown, so a comparison between a text column and a number quietly returned no rows. Parameter types are now taken from the first values bound, whenever that happens, and every way of running a query gives the same answer.
architecture: docs/types-parameters.md
files:
  - packages/quereus/src/core/statement.ts (`establishParameterTypes`, `dropProvisionalPlanOnBind`, `invalidatePlan`, `compile`, `bind`, `bindAll`, `nextStatement`, `getAnalysisPlan`)
  - packages/quereus/src/core/database.ts (`_evalGenerator`)
  - packages/quereus/src/core/param.ts (`getParameterTypes` — bare-key precedence)
  - packages/quereus/src/planner/analysis/scalar-param-usage.ts (comment only)
  - packages/quereus/test/parameter-types.spec.ts (new: first-binding-source group, entry-point parity group)
  - packages/quereus/test/parameter-array-scalar.spec.ts (comments; null-bare-binding case now runs on both paths)
  - packages/quereus/test/property.spec.ts (Numeric Affinity section)
  - docs/types-parameters.md, docs/usage.md
----
# Parameter types are established from the first binding source

## What changed

`Statement.compile()` used to freeze `parameterTypes` from `getParameterTypes(this.boundArgs)` on the first compile. With nothing bound that call returns an **empty Map**, not `undefined` — an established map with no entries — so every parameter stayed at `ANY` for the statement's whole life, and values bound afterwards never reached the planner. Every entry point that introspects (`getColumnNames()`, `getColumnDefs()`, `isQuery()`) before binding landed there.

Now:

- `Statement.establishParameterTypes()` is the single place types are established. It assigns `this.parameterTypes` only when the inferred map is **non-empty**, so "nothing bound yet" can never masquerade as "typed, and there are none". Explicit hints or values handed to `prepare()` still win, unchanged.
- `compile()` records `planTypesProvisional` when it planned with no established types.
- `bind()` / `bindAll()` call `dropProvisionalPlanOnBind()`: once `boundArgs` is non-empty and the plan is provisional, the plan is discarded and rebuilt on the next `compile()`. Costs at most one extra compile per statement.
- `invalidatePlan()` is now the one invalidation set (`needsCompile`, `plan`, `emissionContext`, `scheduler`, `columnDefCache`), shared by the schema-change listener, `nextStatement()` and the provisional drop.
- `getAnalysisPlan()` (the `getChangeScope()` path) had the same freeze-from-emptiness bug and now goes through `establishParameterTypes()` too. **Not covered by a new test** — see gaps.
- `Database._evalGenerator` prepares with `params` (and builds the multi-statement branch's last `Statement` with them), then passes `undefined` downstream so values are not rebound and re-validated. Without this every parameterised `eval` would compile twice.
- `getParameterTypes` (`core/param.ts`) now skips a `:name` entry when the bare `name` key is also present, matching the precedence `validateParameterTypes`' scalar-guard lookup already uses. Without it the plan would be typed from one entry and validated against the other.

## Deliberate behaviour change — call this out in review

**`select ? = ?` (and `<`) with one numeric and one textual operand now answers differently.** Parameters are typed, so the planner mints the comparison-site coercion from `types/comparison-coercion.ts`: the text side converts to NUMERIC/REAL, and text that names no number lenient-casts to `0`. So `db.eval('select ? = ?', ['!', 0])` is now **true** where it was false.

This makes the parameterised spelling agree with the literal one — `db.get("select ('!' = 0) as r")` has always returned `true` on a clean tree, as has `db.get("select ('!' = ?) as r", [0])`. The property test was encoding the defect, not the rule.

`property.spec.ts` Numeric Affinity was updated accordingly: its storage-class oracle (`compareSqlValues`) still pins ordering for every pair the coercion rule does **not** touch, and the numeric-vs-textual pairs it now excludes are pinned instead by a new deterministic test that asserts `select (? = ?)` / `select (? < ?)` deep-equal the **literal** spelling of the same comparison, over five hand-picked pairs (`'5'`/5, `'!'`/0, `'1e3'`/1000, `'5'`/6, `'1.5'`/1). Reviewers should sanity-check that this exclusion is precise: `coercesAtComparison` treats `number`/`bigint` as numeric and excludes BOOLEAN, because `BOOLEAN_TYPE` is neither `isNumeric` nor `isTextual` and so takes no coercion.

## Validation

`yarn test` from the repo root: **all workspaces green**, `@quereus/quereus` at 10467 passing / 25 pending / 0 failing. `yarn lint` clean (eslint plus the `tsconfig.test.json` type pass). No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.

**Negative control, run deliberately:** with `dropProvisionalPlanOnBind` stubbed to return immediately, the new parity test fails on `db.prepare(sql).all(params)` with `expected [] to deeply equal [ { k: 1 } ]`. The test is not vacuous.

### New tests, and what to poke at

`parameter-types.spec.ts`, *Cross-type parameter comparison agrees across entry points* — table-driven over **eight** entry points by two cases:

- entry points: `db.eval`; `db.eval` with `readConcurrency: 'committed'`; `db.eval` over a multi-statement batch (`select 1 as ignored; <sql>`); `db.get`; `db.prepare(sql, params).all()`; `db.prepare(sql).all(params)`; `db.prepare(sql).get(params)`; `db.prepare(sql).bindAll(params).all()`.
- cases: integer parameter against a TEXT column (`select k from t where v = ?` with `[5]`), and text parameter against an INTEGER column (`select k from u where n = ?` with `['5']`). Both must return exactly `[{ k: 1 }]`.
- Adding a ninth entry point is one array element — that was the point of the shape.

`parameter-types.spec.ts`, *Parameter types are established from the first binding source*:

- pre-bind `getColumnDefs()` announces `ANY`; after `bindAll([9])` it announces `INTEGER`.
- the frozen contract still holds: after establishing INTEGER, `bindAll([3.14])` keeps announcing INTEGER and execution raises `Parameter type mismatch`.

`parameter-array-scalar.spec.ts`: the "honors a null bare binding rather than the `:`-prefixed alternate" case was eval-only, with a carve-out comment saying the typed paths could not pass it. The `param.ts` precedence fix removes that, so it now runs on **both** paths — that case is the direct regression test for the `getParameterTypes` change.

## Known gaps — treat the tests as a floor

- **`getChangeScope()` / `getAnalysisPlan()` has no new test.** It had the identical freeze-from-emptiness bug and was fixed by routing through the shared helper, but nothing pins it. A reviewer wanting a real check should assert that `stmt.getChangeScope()` called before any bind does not poison the later executed plan's parameter types.
- **The performance claim is untested here.** The ticket's filing consumer reported a storage module falling back to a full scan (250-400 ms against 10-58 ms) because it would not seek on a parameter whose plan-time type it could not trust. This change makes the type available on those paths; no benchmark was run to confirm the seek is now chosen. `performance-sentinels.spec.ts` passes but does not cover that shape.
- **Column names are read off the provisional plan.** `all(params)` / `get(params)` on a statement prepared without values call `getColumnNames()` (compiling provisionally) before handing `params` down, then recompile. The captured names are still correct — a result column's name and the column count come from the projection, not from parameter types — but the reasoning is load-bearing and worth a second look. Parked as a `NOTE:` tripwire on `dropProvisionalPlanOnBind`, with the fix if it ever shows up in a profile (bind at those call sites before reading names, pass `undefined` downstream, as `Database.get` does).
- **The extra compile is unmeasured.** "At most one extra compile, only for a statement compiled before its first bind" is reasoned from the code, not profiled. `prepared-statement-amortization.spec.ts` passes unchanged.
- **`getParameterTypes` key collision is only partly closed.** The bare key now wins over `:name`. A pathological pair like `{ '1': x, ':01': y }` still collapses onto key `1` with last-one-wins, because `Object.hasOwn(params, '01')` is false while `normalizeParamKey('01')` is `1`. Not reachable from any documented usage. The separate pre-existing looseness — a `:p`-only binding is never type-validated, because `validateParameterTypes` reads `boundArgs['p']` — is untouched.

## Comments refreshed because the change made them false

Worth checking these read true now: the `NOTE:` in `compile()` (was "only shows through pre-bind introspection", and referenced a TEXT default that has been `ANY` since `planner/scopes/param.ts` changed); the `paths` doc comment and two case comments in `parameter-array-scalar.spec.ts` (claimed `db.eval` leaves parameters at `ANY`); the `unwrapSyntheticCasts` NOTE in `planner/analysis/scalar-param-usage.ts` (justified the guard's pessimism by "db.eval mints no coercion" — now it does, the outcome is unchanged, and the justification was rewritten); `docs/usage.md`'s `bindAll` note (said pre-bind introspection leaves parameters at the "default TEXT type").
