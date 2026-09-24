description: A safety check that catches binding a JavaScript array where a single value is expected covers the comparison operators but not two other places SQL compares values, so the same mistake goes undiagnosed there.
architecture: docs/types-parameters.md
files:
  - packages/quereus/src/planner/analysis/scalar-param-usage.ts (`collectScalarRequiredParams` — the hand-written construct list)
  - packages/quereus/src/planner/building/coercion.ts (`coerceComparisonSet`, `coerceComparisonGroup` — the other enumeration of comparison sites)
  - packages/quereus/src/runtime/emit/operand-comparator.ts (`makeComparisonGroup` — the emit-time half, for builtins that return one of their arguments)
  - packages/quereus/test/parameter-array-scalar.spec.ts
  - docs/types-parameters.md (§ Type Checking and Validation — "Array/object scalar guard")
difficulty: medium
repro: verified
severity: edge-case
likelihood: unusual
tradeoffs: The guard's documented scope already names only the comparison operators plus `IN` and `BETWEEN`, so today's code matches today's spec; and the two constructs are rare enough with array-valued parameters that a maintainer could reasonably decide the narrower surface is the right one and just say so in the docs.
----
# The array/object scalar-parameter guard enumerates comparison sites separately from the module that owns them

## What the guard is

Binding one `?` / `:name` placeholder to a whole JavaScript array (or plain object) and comparing it against an ordinary single value can never match — an array sorts above every scalar value — so instead of silently returning nothing, the engine rejects the binding with a clear error. That check is `collectScalarRequiredParams` in `planner/analysis/scalar-param-usage.ts`, and `docs/types-parameters.md` § Type Checking and Validation describes it.

## Root cause

`collectScalarRequiredParams` decides which plan nodes are comparisons from its own hand-written list: `BinaryOpNode`, `BetweenNode`, `InNode`. That is a **second enumeration of "constructs that compare operands"**, parallel to the one `planner/building/coercion.ts` already owns and documents as the single place they all meet:

> Every construct that compares operands — `=` and friends, BETWEEN, IN value lists, simple CASE, and scalar builtins that declare a comparison group — reconciles its operands through this one module so none of them can drift from the others.

The two lists have already drifted. Coercion covers simple `CASE` and the scalar builtins that declare `comparesArgs` (`nullif`, `greatest`, `least`); the guard covers neither. Nothing keeps them in step, so the next comparison-shaped construct added to `coercion.ts` will be missed by the guard too, silently.

## Observed behavior

Over `t(id integer primary key, name text)` holding rows 1–3, parameter bound to `[[1, 2]]`, identical on `db.eval` and `db.prepare(sql, params).all()`:

| query | result | expected |
| --- | --- | --- |
| `select * from t where id = ?` | throws `MISMATCH` | throws |
| `select case id when ? then 1 else 0 end as v from t` | `[{v:0},{v:0},{v:0}]` | throws |
| `select nullif(id, ?) as v from t` | `[{v:1},{v:2},{v:3}]` | throws |

The two silent rows are not *wrong* under storage-class comparison semantics — an array genuinely does not equal an integer, so `0` and "not nulled" are the defensible answers. They are the same undiagnosed user mistake the guard exists to turn into an error everywhere else, which is why this reads as a coverage gap rather than a wrong result.

## What "fixed" should look like

Prefer the shape that retires the class over adding two more `instanceof` arms:

- The guard and `coercion.ts` should read the set of comparison sites from **one** declaration, so a new comparison-shaped construct cannot reach the planner guarded by one and not the other. A shared list of node kinds plus a per-kind "give me the (probe, counterparts) pairs" accessor is the obvious shape, but the design is open.
- Failing that, a test that asserts the two enumerations agree — so the drift is caught at build time rather than by the next reviewer — is worth more than the two point fixes.

One wrinkle to design around: `nullif` / `greatest` / `least` return one of their arguments, so `coercion.ts` deliberately does **not** rewrite their operands (replacing an argument would replace the returned value). Their reconciliation happens at emit time in `runtime/emit/operand-comparator.ts` `makeComparisonGroup`. A shared enumeration therefore has to name the comparison group from the *function schema* (`BaseFunctionSchema.comparesArgs`) rather than from the presence of a coercion cast in the plan.

## Scope note

This is pre-existing — the change that prompted the finding (`array-param-guard-defeated-by-coercion-cast`) taught the guard to read through the planner's coercion casts and did not touch which constructs it walks. Whichever way this is resolved, `docs/types-parameters.md` should end up stating the guard's construct coverage and the reason for it, rather than listing operators that happen to match the code.
