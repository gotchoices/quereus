description: Made the runtime's one type-cast helper strict, so a future emitter that declares a wrong argument or return type on its instruction's run-function is now caught by the type checker instead of slipping through silently.
files: packages/quereus/src/runtime/types.ts, packages/quereus/src/common/types.ts, packages/quereus/src/runtime/emit/block.ts, packages/quereus/src/runtime/emit/view-mutation.ts, packages/quereus/src/runtime/emit/alter-table.ts, packages/quereus/src/runtime/emit/dml-executor.ts, packages/quereus/src/runtime/emit/create-index.ts, packages/quereus/src/runtime/emit/create-table.ts, packages/quereus/src/runtime/emit/drop-table.ts, packages/quereus/src/runtime/emit/transaction.ts, packages/quereus/src/runtime/emit/bloom-join.ts, packages/quereus/src/runtime/emit/join.ts, packages/quereus/src/runtime/emit/merge-join.ts, packages/quereus/test/logic/82-bloom-join.sqllogic, docs/runtime.md
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

The single unchecked `as`-to-`InstructionRun` still lives in the body (parameter
contravariance under `strictFunctionTypes` makes a precise `run` unassignable to the
general one). What changed is that every one of the ~85 emit sites now gets its params
and return checked before the cast is applied.

To make that compile, eight `run` signatures were tightened. All eight were annotation
bugs; none changed a runtime path.

**Nested-promise returns** (`OutputValue` already includes `Promise<RuntimeValue>`, so
`Promise<OutputValue>` is a promise-of-a-promise): `emit/block.ts` `run`;
`emit/view-mutation.ts` `run` and `runBody` — all narrowed to `Promise<RuntimeValue>`.

**`undefined` in the return** (`undefined` is not a `RuntimeValue`; every path already
returned `null`): `emit/create-index.ts`, `emit/create-table.ts`, `emit/drop-table.ts`,
and the `let run:` annotation in `emit/transaction.ts` — all narrowed to
`Promise<SqlValue>`.

**Optional callback param → trailing rest tuple.** `join.ts`, `bloom-join.ts`, and
`merge-join.ts` each emit a trailing sub-program param *only when* the plan has a
condition/residual, so `run` is called with 2 or 3 args. They declared that as an
optional param, which types as `Callback | undefined` — and `undefined` is not a
`RuntimeValue`:

```ts
// before
async function* run(rctx, leftSource, rightSource, residualCallback?: (ctx) => OutputValue)

// after
async function* run(rctx, leftSource, rightSource, ...residual: SubProgram[]) {
	const residualCallback: SubProgram | undefined = residual[0];
```

Behavior-preserving: the scheduler's only call shape is `instruction.run(ctx, ...args)`
(`runtime/scheduler.ts:345,361,421`) with `args.length === params.length`, and nothing
reflects on `run.length` (re-grepped during review). A spread call into a rest param
collects exactly the args a positional optional param would have bound.

`SubProgram` (`(ctx: RuntimeContext) => OutputValue`) is now exported from
`src/common/types.ts` and is the arm `RuntimeValue` is built from; the six emit files
that had each declared their own private copy of that function type now import it.

`docs/runtime.md` § "Wrap `run` in `asRun(...)`" states the two rules an emitter author
has to follow (`async run` returns `Promise<RuntimeValue>`; a sometimes-emitted
sub-program param is a rest tuple, not optional). The long-form rationale plus the
strictness caveat live in the `asRun` doc comment.

## Validation performed

- `tsc --noEmit` in `packages/quereus` — clean.
- `yarn lint` (eslint + `tsc -p tsconfig.test.json --noEmit`, all packages) — clean.
- `yarn test` (all workspaces) — green: 6708 quereus + 799 + 446 + 183 + … , 0 failing.
- `yarn docs:check` — `docs/runtime.md` passes its word ratchet. The three
  `docs/invariants.md` failures are unrelated and pre-existing (see below).
- Throwaway probe file (written, compiled, deleted) re-run during review confirming
  `tsc` rejects `Promise<SqlValue | undefined>`, `Promise<OutputValue>`, an optional
  callback param, and a `Date` param — and accepts both a conforming positional `run`
  and the rest-tuple form.

## Review findings

### Checked

Read the implement diff before the handoff summary. Scrutinized: the `asRun` generic's
actual strictness (re-ran the probe rather than trusting the signature), the single
remaining unchecked cast (`grep "as InstructionRun"` → exactly one, in `asRun`), the
scheduler's call shape and arity assumptions, absence of any `run.length` reflection,
the residual/condition rewiring in all three join emitters against their `params`
construction, the annotation-only DDL/transaction narrowings, DRY across the emit
files, and whether `docs/runtime.md` reflects the new reality. Ran `yarn lint`,
`yarn test`, `yarn docs:check`.

### Found and fixed in this pass

- **The new bloom-join semi/anti tests exercised no join at all.** The implement diff
  added SEMI/ANTI residual cases to `test/logic/82-bloom-join.sqllogic` spelled as
  correlated `where exists (select 1 from r where …)`. Dumping the plan for those
  queries shows `EXISTS → PROJECT → FILTER → INDEXSEEK` — no join node, so no bloom
  join and no residual sub-program. `select count(*) from query_plan(…) where
  properties like '%bloom%'` returns 0 for both, i.e. the two cases the handoff called
  out as the highest-value new coverage covered nothing of the code the ticket changed.
  Rewrote both as the existence-flag form the semi/anti recovery rule actually accepts
  (`left join … exists right as h where h` / `where not h`), which does plan as a bloom
  join (verified: bloom count 1 for each), and added `query_plan(…) like '%bloom%'`
  assertions in front of each so the cases cannot silently stop using the bloom path.
  Also added the same plan assertion for the LEFT residual case, which had none. Row
  expectations were unchanged by the rewrite and still pass, which is itself the useful
  signal: the bloom `matched`-bit gating under a residual now agrees with the
  index-seek plan's answer.
- **DRY: `(ctx: RuntimeContext) => OutputValue` was declared privately six times.** The
  diff added three of them (`ResidualCallback` twice, `ConditionCallback` once) next to
  three pre-existing copies (`Callback` in `emit/alter-table.ts` and
  `emit/view-mutation.ts`, `UpsertEvaluator` in `emit/dml-executor.ts`). Exported the
  type once as `SubProgram` from `src/common/types.ts`, defined `RuntimeValue` in terms
  of it, and folded all six sites onto it. Type-only change; `tsc` and the suite are
  clean. `join.ts` keeps its local `RightCallback`, which is genuinely narrower (its
  return is always `AsyncIterable<Row>`, not `OutputValue`).
- **The claimed tripwire was not actually recorded.** The handoff said the `asRun` doc
  comment names the shapes that make `TArgs` fall back to its constraint. It did not —
  it named the two shapes `asRun` *rejects*, which is the opposite. Wrote the real
  tripwire (below).

### Filed as new tickets

None. The one structural gap the implementer flagged — `view-mutation.ts` and
`block.ts` remain genuinely variadic (`...args: RuntimeValue[]`), so `TArgs` infers the
constraint and they get no per-arg checking — is not a defect and not conditional: it
is the correct type for an emitter whose param list is data-dependent. Tightening it
would require giving `ViewMutationNode` a typed param descriptor, which is a design
change, not a cleanup. It is now stated in the `asRun` doc comment rather than left
implicit, so a future reader meets it at the site.

### Tripwires (recorded, not ticketed)

- `src/runtime/types.ts`, `asRun` doc comment: the per-arg checking is only as strong
  as `TArgs` inferring a real tuple. A `run` declared `(ctx, ...args: RuntimeValue[])`
  infers `TArgs = RuntimeValue[]` — the constraint itself — and is accepted unchecked.
  That is intentional for the two variadic emitters, but it is also the escape hatch a
  future author would reach for to silence one of the two errors `asRun` now raises.
  The comment names it as an opt-out rather than a fix.
- `test/logic/82-bloom-join.sqllogic`, end of the residual block: no residual case pins
  build/probe **side-swap** (the swap fires only for inner joins with the larger side on
  the left, and the cost model decides, so a pinned case would be brittle). If a
  swap-related residual bug ever surfaces, that is where a case belongs.

### Not found

- No behavior change from the seven annotation-only narrowings: the DDL and transaction
  `run`s returned `null` on every path before and after; `block.ts` / `view-mutation.ts`
  never returned a nested promise.
- No arity hazard from the optional→rest rewrite: the scheduler is the sole caller and
  always spreads exactly `params.length` args, and the `params` arrays in all three join
  emitters push the residual/condition instruction last and only when the plan carries
  one.
- No stale docs: `docs/runtime.md` is the only doc that describes `asRun`, and it was
  updated (and re-checked against its word ratchet).

### Pre-existing, untouched

`yarn docs:check` reports three failures in `docs/invariants.md` (`OPT-002` has two
`guard:` lines and a 148-word body; `OPT-046` has a 155-word body). That file is not
touched by this ticket and the failures reproduce at HEAD. Already tracked as
`tickets/fix/docs-invariants-conventions.md`. Not routed through
`.pre-existing-error.md`, which is for failing *tests*; `docs:check` is not part of
`yarn test`.
