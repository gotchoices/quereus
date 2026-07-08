description: The SQL runtime built each instruction by casting its run-function to shut the type checker up (86 casts across 58 files); those casts are now funneled through one small audited helper so the rest of the code is cast-free.
files: packages/quereus/src/runtime/types.ts, packages/quereus/src/runtime/emit/*.ts, packages/quereus/src/func/builtins/mutation.ts, packages/quereus/src/func/builtins/json.ts, docs/runtime.md
difficulty: hard
----

## What was done

Every emitter builds an `Instruction` whose `run` has a specific signature (e.g.
`(ctx, v1: SqlValue, v2: SqlValue) => SqlValue`), but `Instruction.run` is typed
as the general `InstructionRun = (ctx, ...args: RuntimeValue[]) => OutputValue`.
The specific function is not structurally assignable to the general one
(parameter contravariance + arity under `strictFunctionTypes`), so each emit
site wrote `run: run as InstructionRun`.

**Solution — one audited cast helper `asRun`** (added to
`packages/quereus/src/runtime/types.ts`):

```ts
export function asRun(run: (ctx: RuntimeContext, ...args: never[]) => unknown): InstructionRun {
	return run as unknown as InstructionRun;
}
```

Every `X as InstructionRun` cast became `asRun(X)`. After this, the **only**
`as`-to-`InstructionRun` in the runtime is the single line inside `asRun`.

Transform was uniform across all patterns:
- object literal: `run: run as InstructionRun,` → `run: asRun(run),`
- inline return: `return { params: [], run: run as InstructionRun, note }` → `run: asRun(run)`
- `let run: InstructionRun` + branch assignment (dml-executor, set-operation): `run = runInsert as InstructionRun;` → `run = asRun(runInsert);`
- ternary (case.ts): `(a ? b : c) as InstructionRun` → `asRun(a ? b : c)`
- `createValidatedInstruction(params, run as InstructionRun, ctx, note)` → `asRun(run)` as the run arg (envelope-scan, scan, scalar-function, cte-reference, table-valued-function)

Counts: **86 casts eliminated across 58 files** → 85 `asRun(...)` call sites (subquery.ts had one redundant `runFunc as InstructionRun` where `runFunc` was already typed `InstructionRun`; that cast was simply dropped, not wrapped). `InstructionRun` is still imported in exactly three files — `dml-executor.ts`, `set-operation.ts`, `subquery.ts` — each because of a legitimate `let run: InstructionRun;` / `let runFunc: InstructionRun;` declaration; removed from every other file.

`docs/runtime.md` "Creating an Emitter" example updated to show `run: asRun(run)` (it previously showed a bare `run,` that would not actually type-check).

## The key design decision the reviewer should weigh (honest gap)

The original casts were doing **double duty**, and this only surfaced after the
mechanical pass:

1. The contravariance workaround the ticket describes (the ~78 well-behaved
   sites — `SqlValue` params, proper `OutputValue` returns).
2. **Silently masking ~8 run functions whose signatures genuinely do not conform
   to `InstructionRun` at all.** A raw `as` between function types is permissive
   enough to hide these; a typed helper is not.

The non-conforming sites and why:
- **Imprecise return annotations** — `block.ts` and `view-mutation.ts` return
  `Promise<OutputValue>` (a nested promise: `OutputValue` already includes
  `Promise<RuntimeValue>`, so `Promise<OutputValue>` ⊄ `OutputValue`). At runtime
  `await` flattens this, so it is harmless — the annotation is just too wide.
- **`undefined` in the return** — `create-index.ts`, `create-table.ts`,
  `drop-table.ts`, `transaction.ts` annotate `Promise<SqlValue | undefined>` but
  every path returns `null`; `undefined ∉ RuntimeValue`.
- **Optional callback param breaks tuple inference** — `bloom-join.ts`,
  `join.ts`, `merge-join.ts` take `residualCallback?: ((ctx) => OutputValue) | undefined`.
  The params themselves are valid `RuntimeValue`s, but the optional element
  prevents a generic `<TArgs extends RuntimeValue[]>` from inferring a fixed
  tuple, so it falls back to `RuntimeValue[]` and the contravariance check fails.

**I first tried a tight generic** `asRun<TArgs extends RuntimeValue[]>(run: (ctx, ...args: TArgs) => OutputValue)`
— it cleanly handled the ~78 conforming sites but rejected those ~8 (11 tsc
errors). Rather than change 8 run-function signatures (which edges toward
behavior/type-surface change, and the ticket says *types-only, no behavior
change*), I chose the **deliberately loose** `asRun` above: first arg typed as
the runtime context, rest `never[]`, return `unknown`, one internal
`as unknown as` cast. It is exactly as permissive as the raw `as` it replaces →
truly zero behavior/signature change, and the cast lives in exactly one place.

**Trade-off (this is the thing to review):** the loose `asRun` does *not* verify
that a `run`'s params are `RuntimeValue`-compatible or its return is
`OutputValue`-compatible — it only checks that the first arg is `RuntimeContext`
and that the argument is a function. So it centralizes the cast but gives weaker
per-site checking than a tight generic would. This is documented in `asRun`'s
JSDoc. If the reviewer prefers stronger checking, the follow-up (a `debt-`
ticket, not required for correctness) is: tighten the ~8 imprecise annotations
(e.g. `block.ts` `Promise<OutputValue>` → `Promise<RuntimeValue>`,
`create-index.ts` `Promise<SqlValue | undefined>` → `Promise<SqlValue>`), rework
the 3 optional-callback join runs so a fixed tuple can be inferred, then swap
`asRun` for the tight generic. Left as a judgment call for review rather than
done unilaterally, because it changes run-function type surfaces.

## Validation performed (treat as a floor, not a ceiling)

From `packages/quereus/`:
- `yarn typecheck` (`tsc --noEmit`) — **EXIT 0**
- `yarn lint` (eslint + `tsc -p tsconfig.test.json --noEmit`) — **EXIT 0**
- `yarn test` (memory-backed logic suite) — **6511 passing, 9 pending, EXIT 0**

Not run (out of scope / not agent-runnable in-ticket): `yarn test:store` (LevelDB
path — slower; this change is types-only and does not touch the store path), full
monorepo build of downstream packages.

## Suggested review focus / use cases

- **Spot-check the mechanical transform.** Most of the 58 files were edited by
  parallel sub-agents under a single uniform rule. Confirm no emit site changed
  behavior — every edit should be purely `X as InstructionRun` → `asRun(X)` (or a
  dropped redundant cast in subquery.ts:239) plus an import swap. `git diff` per
  file should be tiny.
- **Import hygiene.** Verify `InstructionRun` was removed from imports wherever it
  is no longer referenced (tsc `noUnusedLocals` passing is evidence, but eyeball
  the 3 retained: dml-executor, set-operation, subquery — each keeps it for a
  `let run: InstructionRun;`).
- **The `asRun` signature itself** (`types.ts`) — is the loose
  `(ctx, ...args: never[]) => unknown` acceptable, or should the tighter generic
  + the 8 annotation fixes be done now? See the design-decision section above.
- **Branch-assignment sites** (dml-executor.ts ~1098, set-operation.ts ~234) and
  the **multi-cast subquery.ts** (async-arrow cast at ~212, redundant cast dropped
  at ~239) — these needed the most care; confirm they read correctly.
- Nothing here is dormant-path or behavior-bearing; the risk profile is "did any
  file get an edit that wasn't a pure cast-centralization".
