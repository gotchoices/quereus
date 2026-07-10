description: Made the runtime's one type-cast helper strict, so a future emitter that declares a wrong argument or return type on its instruction's run-function is now caught by the type checker instead of slipping through silently.
files: packages/quereus/src/runtime/types.ts, packages/quereus/src/runtime/emit/block.ts, packages/quereus/src/runtime/emit/view-mutation.ts, packages/quereus/src/runtime/emit/create-index.ts, packages/quereus/src/runtime/emit/create-table.ts, packages/quereus/src/runtime/emit/drop-table.ts, packages/quereus/src/runtime/emit/transaction.ts, packages/quereus/src/runtime/emit/bloom-join.ts, packages/quereus/src/runtime/emit/join.ts, packages/quereus/src/runtime/emit/merge-join.ts, packages/quereus/test/logic/82-bloom-join.sqllogic, docs/runtime.md
difficulty: medium
----

## What landed

`asRun` in `src/runtime/types.ts` went from loose to generic:

```ts
// before — only checked "first arg is RuntimeContext, and it's a function"
export function asRun(run: (ctx: RuntimeContext, ...args: never[]) => unknown): InstructionRun

// after — TArgs is inferred from the run's own parameter tuple
export function asRun<TArgs extends RuntimeValue[]>(
	run: (ctx: RuntimeContext, ...args: TArgs) => OutputValue
): InstructionRun
```

The single unchecked `as`-to-`InstructionRun` still lives in the body (it has to —
parameter contravariance under `strictFunctionTypes` makes a precise `run`
unassignable to the general one). What changed is that every one of the ~85 emit
sites now gets its params and return checked before the cast is applied.

To make that compile, eight `run` signatures were tightened. All eight were
annotation bugs; none changed a runtime path.

**Nested-promise returns** (`OutputValue` already includes `Promise<RuntimeValue>`,
so `Promise<OutputValue>` is a promise-of-a-promise):
- `emit/block.ts` — `run`: `Promise<OutputValue>` → `Promise<RuntimeValue>`.
- `emit/view-mutation.ts` — `run` and `runBody`: same narrowing.

**`undefined` in the return** (`undefined` is not a `RuntimeValue`; every path
already returned `null`):
- `emit/create-index.ts`, `emit/create-table.ts`, `emit/drop-table.ts` — `run`:
  `Promise<SqlValue | undefined>` → `Promise<SqlValue>`.
- `emit/transaction.ts` — the `let run:` annotation, same narrowing. All five
  operation closures (`begin`/`commit`/`rollback`/`savepoint`/`release`) already
  returned `null`.

**Optional callback param** — this is the only structural change, and the one worth
the reviewer's attention. `join.ts`, `bloom-join.ts`, and `merge-join.ts` each emit a
trailing sub-program param *only when* the plan has a condition/residual, so `run` is
called with 2 or 3 args. They declared that as an optional param, which types as
`Callback | undefined` — and `undefined` is not a `RuntimeValue`. Reworked to a
trailing rest tuple, which is also the truthful description of the call sites:

```ts
// before
async function* run(rctx, leftSource, rightSource, residualCallback?: (ctx) => OutputValue)

// after
async function* run(rctx, leftSource, rightSource, ...residual: ResidualCallback[]) {
	const residualCallback: ResidualCallback | undefined = residual[0];
```

`join.ts` got the same treatment for its `conditionCallback`, plus named
`RightCallback` / `ConditionCallback` aliases. Its `rightCallback` param
(`(ctx) => AsyncIterable<Row>`) needed no change — its return is a `RuntimeValue`.

Why this is behavior-preserving: the scheduler's only call shape is
`instruction.run(ctx, ...args)` (`runtime/scheduler.ts:345,361,421`) with
`args.length === params.length`. Nothing reflects on `run.length` or arity — I grepped
for it. So a spread call into a rest param collects exactly the args a positional
optional param would have bound, and `residual[0]` is `undefined` in precisely the
cases `residualCallback` was `undefined` before. (`noUncheckedIndexedAccess` is off,
hence the explicit `| undefined` on the local.)

`docs/runtime.md` § "Wrap `run` in `asRun(...)`" now states the two rules an emitter
author has to follow (`async run` returns `Promise<RuntimeValue>`; a
sometimes-emitted callback param is a rest tuple, not optional), and the long-form
rationale lives in the `asRun` doc comment.

## Validation performed

- `tsc --noEmit` in `packages/quereus` — clean.
- `yarn lint` (eslint + `tsc -p tsconfig.test.json --noEmit`, all packages) — clean.
- `yarn test` (all workspaces) — green: 6708 quereus + 799 + 446 + 183 + … , 0 failing.
- `yarn docs:check` — `docs/runtime.md` passes its ratchet. See *Known gaps* for the
  three unrelated `docs/invariants.md` failures.

**The helper is actually strict — I verified it, don't take the signature's word for
it.** A throwaway `src/__asrun_probe.ts` (written, compiled, deleted) confirmed `tsc`
now rejects all four previously-silent mistakes and still accepts a conforming `run`:

| probe `run` | result |
|---|---|
| returns `Promise<SqlValue \| undefined>` | rejected — `undefined` not a `RuntimeValue` |
| returns `Promise<OutputValue>` | rejected — promise of a promise |
| has `cb?: (ctx) => OutputValue` | rejected — optional param |
| has a `Date` param | rejected — not a `RuntimeValue` |
| returns `Promise<SqlValue>` | accepted |

This is worth re-running if you touch `asRun`: a generic that silently falls back to
its constraint (`TArgs = RuntimeValue[]`) would look identical at the call sites but
check nothing.

## Use cases for the reviewer to exercise

The join rework is the only change that could plausibly break at runtime, so it is
where to spend effort. The two axes are **residual present vs. absent** and **join
type** (the `matched` bit feeds outer-join null-extension and semi/anti).

I found `emit/bloom-join.ts`'s residual path had **no test coverage at all** — the
only multi-conjunct case in `test/logic/82-bloom-join.sqllogic` was `ON m1.a = m2.x
AND m1.b = m2.y`, two equi pairs, no residual. Since my change rewrites exactly that
parameter, I added coverage before trusting the green run:

- `test/logic/82-bloom-join.sqllogic` — new block: a `query_plan(...) LIKE '%bloom%'`
  assertion (so the case can't silently stop using the bloom path), then inner, left,
  semi (`exists`), and anti (`not exists`) joins over `ON l.k = r.k AND l.s < r.t`.
  The data is chosen so `l.id = 2` has equi candidates that *all* fail the residual —
  the case that distinguishes "filtered by residual" from "no equi match" in the
  `matched`/null-extension logic.

I confirmed these assertions actually execute by mutating an expected value and
watching the suite go red (each `.sqllogic` file is one mocha test, so the overall
"6708 passing" count does not move when you add cases inside a file — a green run
alone would not have proved the new asserts ran).

Already-covered paths I leaned on rather than re-testing:
- merge-join residual: `test/logic/91-merge-join-edge-cases.sqllogic` (self-join with
  residual, residual inequality, NULL keys) and `83-merge-join.sqllogic`.
- nested-loop `join.ts` condition callback: exercised pervasively by the logic suite.
- The DDL/transaction `run`s: annotation-only, `null` was and is the sole return.

## Known gaps / honest notes

- **`view-mutation.ts` was not restructured**, only re-annotated. Its `run` still
  takes `...args: RuntimeValue[]` and indexes into it with `as Callback` casts, so
  the tight `asRun` gives it no more per-arg checking than the loose one did
  (`TArgs` infers as `RuntimeValue[]`). Same is true of `block.ts`. Genuinely
  variadic emitters can't be tuple-checked; tightening them would mean giving
  `ViewMutationNode` a typed param descriptor. Out of scope here, and I did not file
  a ticket — flagging it as a judgement call for the reviewer.
- **`bloom-join.ts` semi/anti with a residual is newly covered, but its interaction
  with side-swap is not.** `82-bloom-join.sqllogic` has a separate side-swap
  regression case (small left, large right, LEFT JOIN) with no residual. A residual +
  side-swap case would be a stronger test; I did not add one because I could not
  cheaply force the swap in a way that would stay stable if the cost model shifts.
- **`yarn docs:check` is red at HEAD**, independent of this diff:
  `docs/invariants.md:47` (`OPT-002`, two `guard:` lines, 148-word body) and
  `docs/invariants.md:343` (`OPT-046`, 155-word body). `docs/invariants.md` is
  untouched by this ticket. Filed as `tickets/fix/docs-invariants-conventions.md`.
  Not routed through `.pre-existing-error.md` because that mechanism is for failing
  *tests*, and `docs:check` is not part of `yarn test`.
- **I did not run `yarn test:store`.** Per AGENTS.md that is for store-specific
  diagnosis; nothing here touches the store path.

## Review findings

(To be filled by the review stage.)

- Tripwire parked in `src/runtime/types.ts`'s `asRun` doc comment: the helper's
  strictness is only as good as `TArgs` inferring a real tuple. If someone later
  widens a `run` to `...args: RuntimeValue[]` to silence an error, that emit site
  silently reverts to unchecked — the doc comment names the two shapes that force
  the fallback (optional param, `Promise<OutputValue>`) so the escape hatch is
  recognizable rather than accidental.
