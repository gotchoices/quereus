description: Review the ordered multi-capture substrate added to `ViewMutationNode` + its emitter. `ViewMutationNode` now carries an optional `nestedCaptures` list of `IdentityCapture`s materialized AFTER the primary `identityCapture`, in list order, before the base ops, and torn down in reverse. Each nested source may scan a strictly-earlier capture's materialized rows. Load-bearing substrate for `set-op-write-multisource-leg-compose` (which fills the list). This ticket is substrate-only: every existing producer passes no nested list, so the single-capture / capture-free paths are byte-identical.
prereq: set-op-write-multisource-leg-reject
files: packages/quereus/src/planner/nodes/view-mutation-node.ts, packages/quereus/src/runtime/emit/view-mutation.ts, packages/quereus/src/planner/building/view-mutation-builder.ts
difficulty: medium
----

## What landed

Generalized the single `ViewMutationNode.identityCapture` side input to an ORDERED list:
the primary `identityCapture` (unchanged meaning) plus a new optional sibling

```ts
public readonly nestedCaptures?: readonly IdentityCapture[];
```

materialized AFTER the primary, in array order, BEFORE the base ops. Chose the
`nestedCaptures` add-on shape (not a collapse to a single `identityCaptures` list) because
it touches fewer call sites and keeps the four existing `new ViewMutationNode(...)` calls
byte-identical — documented in the constructor doc-comment. The downstream
`set-op-write-multisource-leg-compose` ticket fills the list; nothing fills it yet.

### `view-mutation-node.ts`
- New trailing optional ctor param `nestedCaptures?` (after `identityCapture`), with a full
  doc-comment: each entry's `source` may depend only on a STRICTLY-earlier capture (the
  primary or an earlier nested entry), never a later one or itself; the list is independent
  of `identityCapture` (handled cleanly even with no primary).
- `getChildren()` — appends each `nestedCaptures[i].source` AFTER the primary capture source,
  BEFORE the envelope children. Documented child order: base ops → returning →
  identityCapture.source → **nestedCaptures sources** → envelope source → keyDefault.
- `getRelations()` — unchanged code (still only baseOps + returning); doc-comment extended to
  state nested sources are side inputs, excluded from forwarded relations exactly as the
  primary capture source is.
- `withChildren()` — extended cursor walk slices the nested sources back in the same order,
  rebuilds each `IdentityCapture` preserving its original `descriptor` object (readers bind
  by descriptor identity — a fresh `{}` would orphan them), and adds them to the
  unchanged-equality short-circuit + the rebuilt-node ctor call.
- `toString()` — `+capture(1+2)` breakdown (primary count + nested count) only when nested
  are present; bare `+capture` retained for the common single-capture case (so the
  `VIEW MUTATION` prefix test and existing dumps are undisturbed).
- `getLogicalAttributes()` — adds `nestedCaptures: <count>` (undefined when empty).

### `view-mutation.ts` (emitter)
- Threads one param slot per nested source, in list order, immediately after the primary
  capture source and before the envelope source — mirroring `getChildren` exactly so the
  scheduler wires the right sub-program to each cursor index.
- `run` rewritten from a single-capture `try/finally` to an ordered capture stack: builds an
  `orderedCaptureIdxs` list (primary first, then nested in order), materializes each
  (`collectRows` → `rctx.tableContexts.set(descriptor, …)`) pushing onto a `setDescriptors`
  teardown stack, runs the body, then in `finally` deletes the set descriptors in REVERSE.
  The empty-list path returns `runBody(...)` directly (byte-identical to the old no-capture
  branch); the single-primary path produces an identical set/teardown to before.
- Doc-comment + `note` (`+nested(N)`) updated.

### `view-mutation-builder.ts`
- No code change. The new ctor arg is optional + trailing, so all four producers
  (`buildViewMutation`, `buildSetOpMutation`, `buildMultiSourceInsert`,
  `buildDecompositionInsert`) pass it implicitly as `undefined` ⇒ byte-identical. The
  compose ticket adds the explicit `nestedCaptures` arg to `buildSetOpMutation` only.

## Validation done

- `yarn workspace @quereus/quereus test` — **6309 passing, 9 pending, exit 0** (full suite,
  including the multi-source/decomposition/set-op view-mutation suites `93.4`, `93.6`, `53-*`).
- `yarn workspace @quereus/quereus lint` — clean (eslint + `tsc -p tsconfig.test.json`).

## Review focus / use cases to scrutinize

- **Child-order parity (load-bearing).** The emitter's param cursor MUST mirror
  `getChildren` exactly: base ops → returning → primary capture → nested[0..n] → envelope
  source → keyDefault. An off-by-one mis-binds the envelope sub-program. Verify the cursor
  arithmetic in both `getChildren`/`withChildren` (node) and the param-push block (emit) line
  up for every combination of {returning?, primary capture?, nested?, envelope?, keyDefault?}.
- **`withChildren` round-trip.** Confirm the slice reconstructs the exact capture list (count,
  order, and — critically — the SAME `descriptor` object per entry) and that the unchanged
  short-circuit returns `this` only when every source is reference-identical.
- **Reverse teardown on throw.** A base op, or a later nested capture's materialization, can
  throw; verify no `tableContexts` entry leaks (the `setDescriptors` stack is torn down in
  reverse inside `finally`). Single-primary case must behave identically to the prior
  `delete(captureDescriptor)`.
- **Byte-identity of the empty/single-capture paths** against the existing suite (the floor).

## Known gaps (treat tests as a floor)

- **The multi-capture path itself is NOT yet exercised at runtime.** No producer fills
  `nestedCaptures` in this ticket, so the ordered materialization, the strictly-earlier
  dependency, and the reverse teardown are covered only structurally (and indirectly via the
  empty/single-capture suite). The first real integration coverage arrives with
  `set-op-write-multisource-leg-compose` (its `93.4`/`93.6` join-leg cases). If the reviewer
  wants earlier confidence, a focused unit test constructing a `ViewMutationNode` with two
  captures (inner source scanning the outer descriptor) and asserting materialization order +
  reverse teardown would harden this before the compose ticket lands — no such node-level unit
  harness exists today, so it would be net-new.
- **No primary + nested present** is handled defensively in both node and emit, but is not a
  shape any current producer emits (the set-op use always has the outer capture as primary);
  it is unexercised.
- `toString`/`getLogicalAttributes` nested rendering is not asserted by any test (the only
  plan-shape assertion checks `.contain('VIEW MUTATION')`, still satisfied).
