----
description: The runtime's instruction objects are not typed over their argument shapes, so nearly every place that builds one casts its run function to shut the type checker up; a proper generic would remove ~68 of these casts.
files: packages/quereus/src/runtime/types.ts, packages/quereus/src/runtime/emit/*.ts, packages/quereus/src/runtime/scheduler.ts, packages/quereus/src/runtime/emitters.ts
difficulty: hard
----
Each emitter builds an `Instruction` whose `run` has a specifically-typed signature (e.g. `(ctx, v1: SqlValue, v2: SqlValue) => SqlValue`) but the `Instruction.run` field is typed as the general `InstructionRun = (ctx, ...args: RuntimeValue[]) => OutputValue`. A specific function is not assignable to the general one (parameter-count/variance), so every emit site writes `run: run as InstructionRun`. There are **68 such casts across 56 files** (`packages/quereus/src/runtime/emit/*` plus a few others).

The review suggested making `Instruction<TArgs>` generic so the argument types flow through and the casts disappear.

## Obstacle discovered during the cleanup pass (read before starting)
A naive `Instruction<TArgs extends RuntimeValue[] = RuntimeValue[]>` with `run: (ctx, ...args: TArgs) => OutputValue` does **not** cleanly eliminate the casts, because of function-parameter **contravariance** under `strictFunctionTypes`:
- The scheduler drives instructions generically — it holds `Instruction` (= `Instruction<RuntimeValue[]>`) and calls `run(ctx, ...args)` with args sourced from the params' outputs (all `RuntimeValue`).
- A specialized `Instruction<[SqlValue, SqlValue]>` returned by `emitBinaryOp` must be assignable to that general `Instruction<RuntimeValue[]>`. A function accepting `[SqlValue, SqlValue]` is **not** safely assignable to one accepting `RuntimeValue[]` (a caller could pass more/other args), so the assignment is rejected — moving the cast from `run as InstructionRun` to a cast at the return `as Instruction`, which is no improvement.

So this is a genuine structural refactor, not a mechanical find-replace. A workable direction likely needs one of:
- keep `run` typed as the general `InstructionRun` but make the *builder* generic and do the arg-tuple narrowing internally in one well-documented place, or
- a small typed factory (e.g. `makeInstruction<TArgs>(params, run, ...)`) that performs the single unavoidable cast internally so call sites stay clean and cast-free, or
- accept a per-file/line-scoped disable only where a cast is truly unavoidable.

## Scope / expectations
- Eliminate (or centralize into one audited spot) the `run as InstructionRun` casts across `runtime/emit/*`.
- No behavior change; this is types-only. `yarn build`, `yarn lint`, and the logic-test suite must stay green.
- Touching 56 files — coordinate with any in-flight work in `runtime/emit/` to avoid churn conflicts.

## Note
The two file-wide `eslint-disable @typescript-eslint/no-explicit-any` comments in `emitters.ts` and `utils.ts` that the original review paired with this item were **already removed** in the smaller-cleanups pass (their `any`s were unrelated to these casts and were typed directly). This ticket is now purely about the casts.
