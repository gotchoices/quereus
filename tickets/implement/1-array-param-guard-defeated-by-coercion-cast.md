description: A safety check is supposed to raise a clear error when a query parameter is bound to a JavaScript array or object but compared against an ordinary single value — a comparison that can never match. Whenever the engine knows the parameter holds an array, the check silently stops firing and the query returns no rows instead of the error.
architecture: docs/types-parameters.md
files:
  - packages/quereus/src/planner/analysis/scalar-param-usage.ts (`isScalarCounterpart` — reads the counterpart's post-coercion type)
  - packages/quereus/src/planner/building/coercion.ts (`wrapInCast` — mints the synthetic coercion cast)
  - packages/quereus/src/planner/nodes/scalar.ts (`CastNode` — needs to carry a synthetic marker)
  - packages/quereus/test/parameter-array-scalar.spec.ts (the guard's spec; only exercises `db.eval`, the one path where the guard still works)
  - docs/types-parameters.md (§ Type Checking and Validation — the "Array/object scalar guard" bullet)
repro: verified
----
# The array-valued-scalar-parameter guard stops firing once the plan knows the parameter's type

## What the guard is for

`collectScalarRequiredParams` (`planner/analysis/scalar-param-usage.ts`) walks the logical plan and collects every parameter used directly as a comparand in a scalar comparison (`= <> < <= > >=`, `IN`, `BETWEEN`) against a definitely-scalar operand. `Statement.validateParameterTypes` then refuses to bind a JS array or plain object to one of those parameters, with `StatusCode.MISMATCH`. Without it, `where id = ?` bound to `[[1, 2]]` silently matches nothing — the OBJECT storage class sorts above every scalar — which is the failure mode the guard was built to replace.

## What actually happens

The guard only fires when the plan does **not** know the parameter's type. Measured on a clean tree (`select * from t where id = ?` over `t(id integer primary key, name text)`, bound to `[[1, 2]]`):

| entry point | result |
| --- | --- |
| `db.eval(sql, [[1, 2]])` | throws `MISMATCH` — guard fires |
| `db.prepare(sql, [[1, 2]]).all()` | `[]` — silently no rows |
| `db.get(sql, [[1, 2]])` | `undefined` — silently no rows |
| `db.eval(sql, [[1, 2]], { readConcurrency: 'committed' })` | `[]` — silently no rows |

`db.eval` is the outlier because it plans before binding (that is its own defect — see `parameter-types-frozen-before-first-bind`), so its parameter is typed ANY and no coercion happens. Every path that passes the parameters to `prepare` types the parameter JSON, and that is what disables the guard.

## Mechanism

`insertCrossTypeCoercion` (`planner/building/coercion.ts`) reconciles a comparison whose operands are object-physical on one side and scalar on the other by wrapping the **scalar** side in a synthetic `CastNode` to the object side's type — so `id = ?` with a JSON-typed `?` is built as `cast(id as json) = ?`. `isScalarCounterpart` then asks that cast node for its type, gets JSON (`PhysicalType.OBJECT`), decides the counterpart is not a scalar, and never records the parameter. The comment on `collectScalarRequiredParams` says the JSON-vs-JSON case is excluded "via the counterpart-type check ... so this never over-fires" — the check reads the coerced type, so it also never *fires* where it should.

Confirmed by plan shape: `prepare('select * from t where name = ?', [[1, 2]])` compiles to 8 nodes including a `Cast`; the same statement with a text parameter, and with no parameter types at all, compiles to 7 nodes with no `Cast`.

## Fix

Look through the *synthetic* coercion cast, and only that one. An explicit user `cast(col as json) = :p` is a legitimate JSON-vs-JSON comparison and must stay allowed, so unwrapping every `CastNode` would over-fire. `CastNode` carries no marker today, so add one:

- `CastNode` gains a `synthetic` constructor flag (default `false`), preserved by `withChildren`.
- `wrapInCast` — the single mint site for coercion casts, shared by `insertCrossTypeCoercion`, `coerceComparisonSet` and `coerceComparisonGroup` — passes `true`.
- `isScalarCounterpart` unwraps synthetic casts before reading the physical type, mirroring how `paramOperand` already unwraps casts on the parameter side.

Prototyped against the current tree: the whole `parameter-array-scalar.spec.ts` + `parameter-types.spec.ts` pair passes, including the legitimate-use cases (`jsoncol = :p` with a JSON-bound parameter, `json_array_length(?)`, `select ? as v`, storing an array into a JSON column) and `id = cast(? as integer)`.

A `synthetic` marker on `CastNode` is worth having beyond this fix: `constraint-extractor.ts`'s `unwrapCast`/`unwrapCastForBindingKind` pair distinguishes value-preserving from converting casts by re-deriving types, and both of its doc comments name `insertCrossTypeCoercion` as the source of the casts they have to reason about. Do not change those call sites in this ticket — just note the marker exists.

## Coverage gap this leaves

`parameter-array-scalar.spec.ts` drives every case through `db.eval`. That is exactly the one path the guard still worked on, which is why the hole went unseen. The spec needs the same cases through at least one typed path.

## TODO

- Add a `synthetic` readonly flag to `CastNode` (`planner/nodes/scalar.ts`), defaulting to `false`, and carry it through `withChildren`.
- Set it from `wrapInCast` (`planner/building/coercion.ts`); document at the flag that it marks a plan-build coercion, not user-written SQL.
- Unwrap synthetic casts in `isScalarCounterpart` (`planner/analysis/scalar-param-usage.ts`) and update the `collectScalarRequiredParams` doc comment, which currently claims the counterpart-type check is what keeps the JSON-vs-JSON case out — say that it is the *unwrapped* counterpart type.
- Extend `parameter-array-scalar.spec.ts` so the "throws" cases run through a typed path as well as `db.eval` — `db.prepare(sql, params).all()` is the cheapest; assert the `MISMATCH` code and the "scalar comparison" wording on both.
- Keep the "does not over-fire" cases green on both paths, especially `JSON-column = JSON-param` and an explicit `cast(col as json) = :p` (add the latter — it is the case the `synthetic`-only unwrap exists to protect).
- Update the "Array/object scalar guard" bullet in `docs/types-parameters.md` § Type Checking and Validation to say the guard reads through plan-build coercion casts.
- Run `yarn workspace @quereus/quereus run test` and `yarn lint`.
