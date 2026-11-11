description: A prepared statement whose parameter was first given a real value (say 5) refuses NULL for that parameter on every later run, so a reused `update t set x = ?` can never set x to NULL. Make a type inferred from a bound value accept NULL, and let LIMIT / OFFSET expressions that are nullable only because of parameters be checked when the statement runs instead of when it is prepared.
architecture: docs/types-parameters.md#type-checking-and-validation
files: packages/quereus/src/core/param.ts, packages/quereus/src/planner/building/row-count-expression.ts, packages/quereus/src/planner/nodes/function.ts, packages/quereus/src/planner/nodes/reference.ts, packages/quereus/src/core/statement.ts, packages/quereus/test/parameter-types.spec.ts, packages/quereus/test/runtime/early-stop-consumption.spec.ts, docs/types-parameters.md, docs/sql-select.md
repro: verified
----
# Value-inferred parameter types are nullable

## The bug

Reproduced 2026-11-10:

```ts
await db.exec('create table t (k integer primary key, x integer null)');
const s = db.prepare('update t set x = ? where k = ?', [5, 1]);
await s.run();
await s.run([null, 2]);
// Parameter type mismatch for ?1: expected non-nullable INTEGER, got NULL
```

`getParameterScalarType` (`src/core/param.ts`, bottom of file) returns `nullable: value === null`, so a parameter first bound to `5` is typed INTEGER NOT NULL. That type is frozen for the statement's life (`establishParameterTypes`, `src/core/statement.ts`), and `validateParameterTypes` (same file, the `value === null` branch) rejects every later `null`.

## Decided rule (maintainer, 2026-11-10)

A type inferred from a bound value is **nullable**. The value fixes the storage class the parameter accepts, never whether it may be NULL — one execution's value says nothing about the next one. A declared type (the `ScalarType` map passed to `db.prepare`) keeps full control, including `nullable: false`; declaring `nullable: false` is how a caller keeps prepare-time LIMIT rejection and the planner's non-null facts.

LIMIT / OFFSET (widened by the maintainer): any LIMIT / OFFSET expression whose possible nullness comes **only from parameters** (value-inferred, ANY, or declared `nullable: true`) is accepted at prepare and left to the runtime check (`toRowCount` in `src/util/row-count.ts`, called on every value by `runtime/emit/limit-offset.ts` and `runtime/emit/ordinal-slice.ts`). So `limit ?`, `limit ? + 1` and `limit coalesce(?, 10) - ?` all prepare, and a NULL value is still an error, at run time ("LIMIT must not be NULL"). A LIMIT nullable for any other reason — a nullable column, a scalar subquery such as `(select max(n) from cfg)`, `null` itself, `? / 2` (division by zero is NULL) — is still rejected at prepare with "LIMIT expression may be NULL". Today `query_plan('… limit ? + 1')` with an unbound parameter fails at prepare while running it works; after this change both work.

## Design

### Arm 1 — inference (`src/core/param.ts`)

`getParameterScalarType` returns `nullable: true` for every value. Update its doc comment and the rule list on `getParameterTypes`. `validateParameterTypes` needs no change: its null branch now only fires for a declared `nullable: false`.

### Arm 2 — LIMIT / OFFSET prepare check (`src/planner/building/row-count-expression.ts`)

Replace `isUntypedParameter` with a test "is this expression still nullable when every parameter in it is assumed non-null?". Recommended mechanism — reuse the existing type inference rather than writing a second nullability calculator:

- Rebuild the built expression with every `ParameterReferenceNode` (reached through **scalar** children only; relational children such as a scalar subquery's body are left as they are — a subquery is nullable for its own reasons) replaced by a copy whose `targetType` is `{ ...targetType, nullable: false }`. The substitution walk has the same shape as `substituteInScalar` (`planner/rules/subquery/rule-subquery-decorrelation.ts`) and `substituteSubqueries` (`planner/analysis/scalar-subqueries.ts`); if a generic "map scalar tree" helper is worth extracting for three callers, do it, otherwise keep a local walk.
- Read `getType().nullable` of the rebuilt root. Nullable → reject at prepare as today. Not nullable → return the **original** node (never the rebuilt one: the plan must keep the parameter's real nullable type, or a rule could simplify `coalesce(?, 10)` to `?` and turn a NULL into a runtime error instead of 10).
- Only rebuild when the original is nullable and contains a parameter; the common case (`limit 10`, `limit ?` declared non-null) costs nothing.

Known trap in that mechanism: `ScalarFunctionCallNode.withChildren` (`src/planner/nodes/function.ts`) keeps the type inferred from the **original** arguments — there is a `NOTE:` there saying to re-run inference "if a rule ever does that". This substitution is that rule: `limit abs(?)` would keep the stale nullable claim and be wrongly rejected. Fix `withChildren` to re-run `inferReturnType(argTypes, argNullable)` when the schema has one (same call as `planner/building/function-call.ts`, after comparison coercion — the rebuilt children already carry any casts), and update the NOTE. Check the other scalar nodes reachable in a LIMIT expression (`UnaryOpNode`, `BinaryOpNode`, `CaseExprNode`, `CastNode`, `CollateNode`, `BetweenNode`, `InNode`) recompute nullability from their new children — the ones in `nodes/scalar.ts` use a lazily cached `generateType`, so a fresh instance recomputes; verify rather than assume for any that store a type at construction.

Rejected alternative: typing parameters non-null while building the LIMIT expression. It puts a false fact into the plan (see the `coalesce` example above).

### Other consumers of parameter nullability

Making a parameter nullable is the conservative direction everywhere: it can only remove a planner fact, never add a wrong one. Searched `src/` for nullability consumers (`.nullable` reads, "may be NULL"): the LIMIT / OFFSET check is the only prepare-time **rejection** driven by nullability. No rule folds `? is null` to false. `rule-subquery-decorrelation.ts`'s IN gate requires a column reference, so parameters never reach it. Visible effect elsewhere: announced result types — `select ? as v` prepared with `[5]` now announces a nullable INTEGER; any test pinning that must be updated, not the code.

### Docs

- `docs/types-parameters.md`: "NULL compatibility" bullet (Type Checking and Validation) — replace the statement of the rejection with the decided rule; mention that a declared `nullable: false` still rejects NULL at bind. The "A first binding of `null`" section's "LIMIT / OFFSET are checked on each execution" bullet should now say that holds for every inferred parameter, not only null-first ones. Note there that declaring `nullable: false` keeps prepare-time LIMIT rejection and the planner's non-null facts.
- `docs/sql-select.md` §3.6 "Valid row counts": rewrite the two bullets. Prepare-time rejection: an expression that may be NULL for a reason other than a parameter (list the examples above). Checked on each execution: any expression nullable only because of parameters (value-inferred, ANY, declared `nullable: true`), including `limit ? + 1`; a parameter declared `nullable: false` is judged at prepare like any non-null expression. Drop the sentence "A parameter whose type is known when the statement is planned … rebinding it to `null` later already fails at bind time."

## Tests (keep to these)

- `test/parameter-types.spec.ts`: the reproduction above — `update … set x = ?` prepared with `[5, 1]`, then `run([null, 2])` succeeds and stores NULL. One more assertion in the same case or neighbour: a declared hint with `nullable: false` still rejects `null` at bind (check whether the "explicit type hints" case near line 576 already covers a NULL rejection; extend it rather than add a new case).
- `test/runtime/early-stop-consumption.spec.ts` (has the existing `limit ?` NULL cases near line 139–160): `limit ? + 1` prepares (with and without a first value) and a NULL value fails at run with "LIMIT must not be NULL"; `limit ?` prepared with `[5]` then run with `[null]` fails at run, not at bind. Existing prepare-time rejections in `test/logic/94.1-limit-offset-edge-cases.sqllogic` and `test/logic/104-emit-mutation-kills.sqllogic` (`limit null`, scalar subquery) must keep passing unchanged — they are the "other reason" arm.
- If `limit abs(?)` needed the `withChildren` fix, one case pinning it (prepare succeeds).

## TODO

- Make `getParameterScalarType` return `nullable: true`; update its comments.
- Replace `isUntypedParameter` in `row-count-expression.ts` with the "nullable only through parameters" test described above; update the function's doc comment.
- Make `ScalarFunctionCallNode.withChildren` re-infer its return type when operands change; update the `NOTE:`. Verify the other scalar nodes recompute nullability.
- Add the tests listed above; update any existing test that pinned a non-nullable inferred parameter type (announced result types, plan output).
- Update `docs/types-parameters.md` and `docs/sql-select.md` §3.6.
- `yarn workspace @quereus/quereus run lint` and `yarn test`.
