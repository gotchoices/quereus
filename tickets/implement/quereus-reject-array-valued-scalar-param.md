description: When someone binds a single SQL parameter to a whole array (instead of one value) and compares it to a normal column, the query quietly matches no rows; make it raise a clear error instead.
prereq:
files:
  - packages/quereus/src/util/comparison.ts (storage-class logic; add the non-scalar predicate-guard helper here)
  - packages/quereus/src/runtime/emit/binary.ts (emitComparisonOp — =, <>, <, <=, >, >=)
  - packages/quereus/src/runtime/emit/subquery.ts (IN membership compare at lines ~111, 157, 257)
  - packages/quereus/src/runtime/emit/between.ts (BETWEEN range bounds, line ~24-30)
  - packages/quereus/src/runtime/emit/scan.ts (IndexSeek dynamic seek-key args, lines ~96-99 / 120-126)
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts (NOTE marker in equalitySeekKey — update/clear once guarded)
  - packages/quereus/src/common/errors.ts, packages/quereus/src/common/types.ts (QuereusError / StatusCode.MISMATCH)
difficulty: medium
----

# Reject (or clearly diagnose) an array-valued scalar parameter

## Reproduction (confirmed 2026-06-20)

`create table t (id integer primary key, name text) using memory` with rows `(1,'a'),(2,'b'),(3,'c')`:

| query | params | current result | desired |
|-------|--------|----------------|---------|
| `select * from t where id = ?`        | `[[1,2]]` | `[]` (silent) | **clear error** |
| `select * from t where id in (?)`     | `[[1,2]]` | `[]` (silent) | **clear error** |
| `select * from t where name = ?`      | `[[1,2]]` | `[]` (silent) | **clear error** (non-PK path) |
| `select * from t where id in (?, ?)`  | `[1, 2]`  | rows 1,2      | unchanged |
| `select json_array_length(?)`         | `[[1,2,3]]` | `3`         | unchanged (JSON fn) |
| `select ? as v`                       | `[[1,2]]` | `[1,2]`       | unchanged (projection) |

So the footgun spans **both** the indexed-seek path (`id = ?`, `id in (?)` over the PK) and the
non-indexed comparison path (`name = ?`). The legitimate array/JSON uses (function argument,
projection, JSON-column storage) must keep working untouched.

## Root cause

Arrays/plain objects are valid `SqlValue`s (JSON) — see `isSqlValue` in `common/types.ts`. When such a
value reaches a scalar predicate it is classified `StorageClass.OBJECT` (= 4), the highest class, so
`compareSqlValuesFast(array, scalar)` returns a non-zero class delta (`classA - classB`) for **every**
scalar column value — the predicate matches nothing. Nothing diagnoses the shape mismatch.

Parameter-type validation does not catch it: `validateParameterTypes` (core/statement.ts) checks bound
values against types **inferred from the values themselves** (`getParameterTypes`/`inferLogicalTypeFromValue`
map an array to `JSON_TYPE`), not against how the parameter is used in the query. There is no usage-driven
"this param must be scalar here" signal at bind time.

## Design — runtime predicate-site guard (recommended)

A **value-driven runtime guard at the scalar-predicate sites** is the robust fix: it fires exactly when a
non-scalar value actually meets a scalar in a predicate, regardless of plan shape, and it is trivially
correct about the legitimate cases (function args / projection / JSON storage never route through these
comparison sites). Do **not** put the guard inside the generic `compareSqlValuesFast` — that comparator is
also used by ORDER BY / DISTINCT / joins where mixed OBJECT-vs-scalar ordering of a schemaless column is
legitimate and must not throw.

### Guard rule

Throw iff **exactly one** operand is OBJECT-class (a JS array or plain object — i.e. `typeof === 'object'`,
non-null, not `Uint8Array`) **and the other operand is a non-null scalar** (numeric / text / blob).

- OBJECT-vs-OBJECT (e.g. comparing two JSON values) → **allowed** (unchanged, stringify-compare).
- Any operand NULL → **allowed** (unchanged three-valued-logic NULL result).

This precisely characterizes "a non-scalar value reached a scalar comparison site" from the ticket.

### Shared helper (in `util/comparison.ts`)

```ts
/** A JS array or plain object used as a JSON SqlValue (StorageClass.OBJECT). */
export function isObjectClassValue(v: SqlValue): boolean {
	return typeof v === 'object' && v !== null && !(v instanceof Uint8Array);
}

/**
 * Predicate-site guard: throws when one comparand is a non-scalar (array/object)
 * JSON value and the other is a non-null scalar — i.e. an array-valued parameter
 * (or other non-scalar) used in a scalar comparison. OBJECT-vs-OBJECT and any-NULL
 * are left to the caller's normal comparison/NULL semantics.
 * `describe` yields the operand label for the message (e.g. ':1', '?2', or 'value').
 */
export function assertScalarComparands(
	a: SqlValue, b: SqlValue,
	describe?: (side: 'left' | 'right') => string,
): void { /* throw QuereusError(StatusCode.MISMATCH, ...) on mismatch */ }
```

Error: `QuereusError` with `StatusCode.MISMATCH`, message in the spirit of
`parameter :1 bound to an array/object value but used in a scalar comparison`. When the offending operand's
**plan node** is statically a `ParameterReferenceNode` (possibly wrapped in `CastNode`), include its
`nameOrIndex` (`:name` / `?index`); otherwise fall back to a generic `non-scalar (array/object) value used in
a scalar comparison`. The operand-description is computed once at **emit time** (the plan nodes are in scope
there) and captured into the run closure, so the hot path only does the `isObjectClassValue` checks.

### Guard sites (all four must be covered)

- **`runtime/emit/binary.ts` — `emitComparisonOp`.** Both run closures (`runSameCategoryCompare` fast path
  and `runGenericComparison`) — add the guard at the top after the existing `v1/v2 === null` early-out.
  Covers `name = ?` and every residual `=/<>/</<=/>/>=` filter. Compute the per-side describe from
  `plan.left` / `plan.right` at emit time.
- **`runtime/emit/subquery.ts` — IN membership.** The `compareSqlValuesFast(condition, rowValue, …)` calls
  (~lines 111, 157, 257). Covers non-indexed `x in (?)` with an array param. Here `condition` is the LHS
  scalar and `rowValue` the list element; guard the pair.
- **`runtime/emit/between.ts`.** The `run(value, lowerBound, upperBound)` (~line 24) — guard `value` vs each
  bound. Covers `col between ? and ?` with an array bound.
- **`runtime/emit/scan.ts` — IndexSeek dynamic seek keys.** After `dynamicArgs` are resolved (~line 96), for
  each arg whose target seek column is a scalar type, throw if `isObjectClassValue(arg)`. The seek column
  index is `plan.filterInfo.constraints[i].constraint.iColumn`; the column logical type is
  `source.tableSchema.columns[iColumn].logicalType`. **Allow** an OBJECT arg when the seek column itself is
  JSON-typed (OBJECT-vs-OBJECT seek). Covers `id = ?` and `id in (?)` over the PK/secondary indexes.

### Why not bind-time / plan-time

A static "mark each parameter scalar-required by walking its usage sites, then reject at bind" approach
centralizes into one check with the nicest message, but it is materially harder to get right (correctly
classifying every usage site through CASTs / wrapping expressions / planner rewrites) and a **false
positive breaks a legitimate query** — strictly worse than the runtime guard's false-negative-free,
value-driven behavior. If a future change wants the earlier/cheaper diagnostic, it can be layered on top;
the runtime guard remains the backstop. Document this tradeoff if the implementer revisits.

## Tests

Add a focused spec (e.g. `packages/quereus/test/parameter-array-scalar.spec.ts`, or extend
`parameter-types.spec.ts`) asserting the table above:
- `id = ?`, `id in (?)`, `name = ?`, and a `between` case with an array param each **throw** a
  `QuereusError` (`StatusCode.MISMATCH`) whose message names the parameter / says "scalar comparison".
- `id in (?, ?)` with `[1,2]` still returns rows 1,2.
- `select json_array_length(?)` with `[[1,2,3]]` → `3`; `select ? as v` with `[[1,2]]` → `[1,2]`;
  inserting an array param into a JSON/text column still works — i.e. the guard does **not** over-fire.
- Optional: a JSON-column `=` JSON-param comparison still compares (OBJECT-vs-OBJECT not thrown).

Confirmed: no existing test relies on the current silent-empty behavior (grep of `test/**` for
array-bound scalar comparisons found only unrelated PK-key/attribute-map arrays).

## Follow-up housekeeping

Update the `NOTE (array-valued scalar param)` comment block in `equalitySeekKey`
(`rule-select-access-path.ts`, ~line 1078) to point at the now-landed guard instead of "tracked separately".

## TODO

- [ ] Add `isObjectClassValue` + `assertScalarComparands` (or equivalent guard) to `util/comparison.ts`,
      throwing `QuereusError(StatusCode.MISMATCH, …)` on a one-sided OBJECT-vs-scalar pair.
- [ ] Add an emit-time operand-describe helper that names a `ParameterReferenceNode` (through `CastNode`)
      as `:name` / `?index`, else `value`.
- [ ] Wire the guard into `emitComparisonOp` (both run closures) in `runtime/emit/binary.ts`.
- [ ] Wire the guard into the IN-membership compares in `runtime/emit/subquery.ts`.
- [ ] Wire the guard into `runtime/emit/between.ts`.
- [ ] Wire the seek-key guard into `runtime/emit/scan.ts` (skip JSON-typed seek columns).
- [ ] Add the parameter-array-scalar spec covering throw + no-over-fire cases.
- [ ] Update the `NOTE` comment in `equalitySeekKey`.
- [ ] `yarn workspace @quereus/quereus test` and `yarn workspace @quereus/quereus lint` green
      (stream output with `tee`).
