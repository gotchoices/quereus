description: Extend `ViewMutationNode` and its runtime emitter to carry an ORDERED list of identity captures materialized before the base ops, instead of the single `identityCapture` today. Each capture's `source` may reference an EARLIER capture's materialized rows, so they materialize in list order and tear down in reverse. Load-bearing prerequisite for `set-op-write-multisource-leg-compose`, where a join branch's inner base-PK capture chains off the outer set-op capture. Existing single-capture call sites become a list of one — byte-identical behavior.
prereq: set-op-write-multisource-leg-reject
files: packages/quereus/src/planner/nodes/view-mutation-node.ts, packages/quereus/src/runtime/emit/view-mutation.ts, packages/quereus/src/planner/building/view-mutation-builder.ts
difficulty: medium
----

## Why

`ViewMutationNode.identityCapture` is a **single** `IdentityCapture` side input: the emitter
materializes its `source` into `rctx.tableContexts` under one descriptor BEFORE the base ops
run, then drains the base ops (`runtime/emit/view-mutation.ts`, `run` → `runBody`).

`set-op-write-multisource-leg-compose` needs **two** captures live in one lowered statement:

1. the **outer** set-op capture (the affected view rows + their membership-probe flags, frozen
   once — `buildSetOpCapture`), and
2. an **inner** per-join-branch base-PK capture, whose `source` is
   `Project_{k<side>_<j>}(Filter_{memberExists}(branchJoinNode))` — and `memberExists`
   **references the outer capture** (`exists (… from __vmupd_keys k where k.<viewcol> = …)`).

So the inner capture must materialize AFTER the outer one (its source scans the outer's
`tableContexts` entry), and BEFORE the branch's base ops (which scan the inner). One capture
slot cannot express that ordering. This ticket generalizes the substrate to an **ordered list**
of captures; the next ticket fills it.

## Design

Model an ordered, dependency-respecting list. The simplest backward-minimal shape: keep the
primary `identityCapture` field meaning unchanged and ADD a sibling

```ts
readonly nestedCaptures?: readonly IdentityCapture[];
```

materialized AFTER `identityCapture`, in array order. (Alternatively, collapse to a single
`readonly identityCaptures: readonly IdentityCapture[]` and migrate all call sites — choose
whichever keeps the `ViewMutationNode` constructor and the ~5 existing call sites cleanest. The
`nestedCaptures` add-on touches fewer sites and is the recommended shape; document the choice in
the node doc-comment either way.)

### `ViewMutationNode` (planner/nodes/view-mutation-node.ts)

- New constructor param `nestedCaptures?` (after `identityCapture`).
- `getChildren()` — append each `nestedCaptures[i].source` AFTER the existing
  `identityCapture.source`, BEFORE the envelope children. Keep the documented child order
  contract in sync (base ops → returning → identityCapture.source → **nestedCaptures sources** →
  envelope source → keyDefault).
- `getRelations()` — nested capture sources are side inputs (materialized into context), NOT
  forwarded relations; exclude them exactly as the primary capture source is excluded.
- `withChildren()` — extend the cursor walk to slice back the nested sources in the same order,
  rebuild each `IdentityCapture` with its preserved descriptor, and add them to the unchanged-
  equality check.
- `toString` / `getLogicalAttributes` — reflect the nested count (e.g. `+capture(1+2)`), so a
  plan dump shows the chained captures.

### Emit (runtime/emit/view-mutation.ts)

- Thread each nested source as a callback param, in the SAME child order `getChildren` uses
  (after the primary capture source, before the envelope source) — the param/cursor bookkeeping
  in `emitPlan` must mirror the node's child order exactly or the scheduler wires the wrong
  sub-program.
- In `run`: materialize the primary capture (existing block), THEN each nested capture **in
  order** — collect its rows via `collectRows`, set `rctx.tableContexts.set(nested.descriptor,
  …)`. Each nested source is planned to read earlier captures via their cteNode refs, so the
  earlier `tableContexts` entry must already be set when the nested source runs. Run the body,
  then in `finally` delete the nested descriptors **in reverse order** and finally the primary
  (nest the try/finally, or build an explicit teardown stack — do NOT leak a context entry on a
  base-op throw).
- A statement with `nestedCaptures` but NO primary `identityCapture` should not occur in the
  set-op use (the outer capture is always the primary), but handle the general ordered list
  cleanly regardless — materialize whatever captures are present, primary-then-nested.

### Builder (planner/building/view-mutation-builder.ts)

- `buildSetOpMutation` is the only producer that will pass `nestedCaptures` (filled by the
  compose ticket). For THIS ticket, every existing producer passes `nestedCaptures = undefined`
  / `[]`, so the single-capture path is byte-identical. No behavior change here yet — just plumb
  the new optional constructor arg through (default empty).

## Edge cases & interactions

- **Materialization order is load-bearing.** A nested capture whose source scans an earlier
  capture MUST see that earlier capture already in `tableContexts`. Materialize strictly
  primary → nested[0] → nested[1] → … and assert (or at least document) that each nested
  source may depend only on STRICTLY-earlier captures, never a later one or itself.
- **Teardown on throw.** A base op (or a later nested capture's materialization) can throw; every
  `tableContexts` entry set must be removed in `finally`, in reverse, so a partially-run
  statement never leaks a context entry into a sibling statement. Mirror the existing
  single-capture `try/finally`, generalized to a stack.
- **Empty/absent list byte-identity.** `nestedCaptures` undefined or empty must lower and run
  identically to today. Pin with the full existing multi-source + decomposition + set-op suite
  (`93.4`, `93.6`, `53-*`) passing unchanged.
- **`withChildren` round-trip.** The optimizer rewrites children and calls `withChildren`; the
  slice cursor must reconstruct the exact same capture list (count, order, descriptors). An
  off-by-one in the cursor silently drops a capture or mis-binds the envelope source — cover
  with a plan-shape assertion if a unit harness exists, else lean on the integration tests the
  compose ticket adds.
- **Descriptor identity preserved across rewrite.** Each rebuilt `IdentityCapture` in
  `withChildren` must keep its original `descriptor` object (the readers bind to it by
  identity); minting a fresh `{}` would orphan the readers.
- **No primary capture but nested present.** Defensive: don't assume `identityCapture` is set
  whenever `nestedCaptures` is. Order the materialization off whatever is present.
- **getRelations / change-scope.** Nested sources must stay OUT of `getRelations()` so the
  attribute-provenance / change-scope walks don't treat them as forwarded output (same reasoning
  the doc-comment already gives for the primary capture source and the envelope source).

## TODO

- Add `nestedCaptures?: readonly IdentityCapture[]` to `ViewMutationNode` (constructor +
  `getChildren` + `getRelations` + `withChildren` + `toString` + `getLogicalAttributes`).
- Generalize the emit `run`/`runBody` capture materialization to a primary-then-ordered-nested
  stack with reverse teardown in `finally`; thread the nested source callbacks in matching child
  order.
- Plumb the new optional arg through `buildViewMutation` / `buildSetOpMutation` call sites with
  an empty default (no behavior change this ticket).
- `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/t.log; tail -n 60 /tmp/t.log` — existing
  view-mutation suites pass byte-identical.
- `yarn workspace @quereus/quereus lint`.
