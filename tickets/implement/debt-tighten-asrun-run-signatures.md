description: Optional type-safety hardening — the runtime funnels every instruction's run-function through one loose cast helper that skips per-site checks; tighten the ~8 run-functions with sloppy signatures so the helper can be made strict and catch mistakes at each emit site.
files: packages/quereus/src/runtime/types.ts, packages/quereus/src/runtime/emit/block.ts, packages/quereus/src/runtime/emit/view-mutation.ts, packages/quereus/src/runtime/emit/create-index.ts, packages/quereus/src/runtime/emit/create-table.ts, packages/quereus/src/runtime/emit/drop-table.ts, packages/quereus/src/runtime/emit/transaction.ts, packages/quereus/src/runtime/emit/bloom-join.ts, packages/quereus/src/runtime/emit/join.ts, packages/quereus/src/runtime/emit/merge-join.ts
difficulty: medium
----

## Background

Every runtime emitter builds an `Instruction` whose `run` has a precise
signature (e.g. `(ctx, a: SqlValue, b: SqlValue) => SqlValue`), but the
scheduler drives all instructions through the general
`InstructionRun = (ctx, ...args: RuntimeValue[]) => OutputValue`. A precise
`run` is not structurally assignable to the general one (parameter
contravariance under `strictFunctionTypes`), so each emit site needs a cast.

The `debt-instruction-generic-args` ticket centralized all 85 of those casts
into one helper `asRun` (`src/runtime/types.ts`). That helper is **deliberately
loose**:

```ts
export function asRun(run: (ctx: RuntimeContext, ...args: never[]) => unknown): InstructionRun {
	return run as unknown as InstructionRun;
}
```

It only checks that the first arg is `RuntimeContext` and that the thing passed
is a function. It does **not** verify a `run`'s params are `RuntimeValue`-shaped
or its return is `OutputValue`-shaped. It was chosen loose on purpose: a tighter
generic `asRun<TArgs extends RuntimeValue[]>(run: (ctx, ...args: TArgs) => OutputValue)`
was tried and produced 11 tsc errors from ~8 run-functions whose signatures
genuinely do not conform — and fixing those edges toward type-surface change,
which the centralization ticket scoped out.

## Why this is worth doing (not just cosmetic)

The loose helper is exactly as permissive as the raw `as InstructionRun` casts
it replaced — so no regression — but it also means a future emitter could ship a
genuinely wrong `run` (wrong param type, wrong return) and the type checker
would stay silent. The ~8 non-conforming annotations are themselves imprecise
today and worth cleaning up on their own merits:

- **Nested-promise return** — `block.ts` and `view-mutation.ts` annotate
  `Promise<OutputValue>`. `OutputValue` already includes `Promise<RuntimeValue>`,
  so `Promise<OutputValue>` is a promise-of-a-promise and is not a subtype of
  `OutputValue`. Runtime `await` flattens it, so it is harmless — the annotation
  is just too wide. Should be `Promise<RuntimeValue>` (or whatever the run
  actually yields).
- **`undefined` in the return** — `create-index.ts`, `create-table.ts`,
  `drop-table.ts`, `transaction.ts` annotate `Promise<SqlValue | undefined>` but
  every code path returns `null`. `undefined` is not a member of `RuntimeValue`.
  Should be `Promise<SqlValue>`.
- **Optional callback param breaks tuple inference** — `bloom-join.ts`,
  `join.ts`, `merge-join.ts` take a `residualCallback?: ((ctx) => OutputValue) | undefined`
  param. The params are all valid `RuntimeValue`s, but the optional element
  stops a generic `<TArgs extends RuntimeValue[]>` from inferring a fixed tuple,
  so it falls back to `RuntimeValue[]` and the contravariance check fails. Needs
  the run reworked so a fixed tuple is inferable (or the callback passed a
  different way).

## Goal

- Tighten the ~8 run-function signatures above so they genuinely conform to
  `InstructionRun`.
- Swap the loose `asRun` for a tight generic
  `asRun<TArgs extends RuntimeValue[]>(run: (ctx: RuntimeContext, ...args: TArgs) => OutputValue): InstructionRun`
  so every emit site gets real per-site checking of params + return.
- `yarn typecheck`, `yarn lint`, `yarn test` all green.

## Not in scope / caution

This changes run-function type surfaces (return annotations, join run shapes),
so it is not the pure types-only, zero-behavior-change refactor the parent
ticket was. Confirm each annotation tightening does not alter a runtime path
(they should all be no-ops — `null` is already returned, promises already
flatten). Verify the 3 join reworks especially, since the optional-callback
rework is the only structural change rather than an annotation narrowing.
