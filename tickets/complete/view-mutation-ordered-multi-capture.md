description: Ordered multi-capture substrate for `ViewMutationNode` + its emitter. The node now carries an optional `nestedCaptures` list of `IdentityCapture`s materialized AFTER the primary `identityCapture`, in list order, before the base ops, and torn down in reverse. Each nested source may scan a strictly-earlier capture's materialized rows. Substrate-only: no producer fills the list yet, so every existing single-capture / capture-free path is byte-identical. Reviewed and completed.
files: packages/quereus/src/planner/nodes/view-mutation-node.ts, packages/quereus/src/runtime/emit/view-mutation.ts, packages/quereus/test/quereus/view-mutation-substrate.spec.ts
----

## What landed

Generalized the single `ViewMutationNode.identityCapture` side input to an ORDERED list: the
primary `identityCapture` (unchanged meaning) plus a new optional sibling
`nestedCaptures?: readonly IdentityCapture[]`, materialized AFTER the primary, in array order,
BEFORE the base ops, and torn down in reverse. Each nested source may scan a STRICTLY-earlier
capture's materialized rows. Load-bearing substrate for `set-op-write-multisource-leg-compose`
(which fills the list). Nothing fills it yet, so single-capture / capture-free statements lower
and run byte-identically to the pre-list substrate.

- **`view-mutation-node.ts`** — new trailing optional ctor param `nestedCaptures?` (doc-commented:
  strictly-earlier dependency, independent of the primary). `getChildren` appends nested sources
  after the primary, before the envelope; `getRelations` excludes them as side inputs;
  `withChildren` slices them back in the same order, preserving each `descriptor` by identity and
  extending the unchanged short-circuit; `toString` shows a `+capture(<primary>+<nested>)`
  breakdown only when nested are present; `getLogicalAttributes` adds a `nestedCaptures` count.
- **`view-mutation.ts` (emitter)** — threads one param slot per nested source, in list order, after
  the primary capture and before the envelope (mirroring `getChildren`). `run` was rewritten from a
  single-capture `try/finally` to an ordered capture stack: builds `orderedCaptureIdxs` (primary
  first, then nested in order), materializes each pushing onto a `setDescriptors` teardown stack,
  runs the body, then deletes the set descriptors in REVERSE in `finally`. Empty-list path returns
  `runBody(...)` directly (byte-identical to the old no-capture branch).
- **`view-mutation-builder.ts`** — no code change; the new ctor arg is optional + trailing, so all
  four producers pass it implicitly as `undefined`.

## Review findings

Read the implement diff (`a1d24420`) with fresh eyes before the handoff, audited the full
post-change files, and cross-checked the downstream `set-op-write-multisource-leg-compose` contract
the substrate must support.

### Checked — correct

- **Cursor-arithmetic parity (load-bearing).** All three sites lay out children in the identical
  order `baseOps → returning → primary capture → nested[0..n] → envelope source → keyDefault`:
  `getChildren` (node L239-245), the `withChildren` slice (L267-307), and the emit param push
  (emit L114-130). Verified across every `{returning?, primary?, nested?, envelope?, keyDefault?}`
  combination — no off-by-one. An off-by-one here would mis-bind the envelope sub-program, so this
  was the prime focus.
- **`withChildren` round-trip.** Reconstructs exact count/order, preserves each `descriptor` object
  by identity (reuses `c.descriptor`, never mints a fresh `{}` that would orphan the
  descriptor-bound readers), and the unchanged short-circuit (L313) returns `this` only when every
  source — base op, returning, primary, each nested, envelope — is reference-identical.
- **Reverse teardown on throw.** The `setDescriptors` stack records only descriptors actually
  installed and deletes them in reverse inside `finally` (emit L233-245), so a throw mid-statement
  (a base op, or a later nested capture's materialization) leaks no `tableContexts` entry. The
  single-primary case produces an identical set/delete to the prior `delete(captureDescriptor)`.
- **Byte-identity of the empty/single-capture paths.** Empty list → `return runBody(...)`
  (emit L227-229), identical to the old no-capture branch; `toString`/`getLogicalAttributes`/`note`
  all degrade to the pre-list rendering when no nested are present (bare `+capture`, no breakdown;
  `nestedCaptures` undefined). The 6309 pre-existing tests pass unchanged.
- **Aspect scan.** SPP/DRY/modularity: the ordered-stack rewrite removed the special-cased
  single-capture branch rather than bolting nested onto it — net simpler. Type safety: no `any`;
  `orderedCaptureIdxs` and the teardown stack are typed `TableDescriptor`. Resource cleanup:
  reverse teardown in `finally` is the one cleanup path and it is exhaustive. Error handling: a
  throw tears down exactly what was installed. Performance: empty-list path is a direct passthrough
  (no allocation) — zero overhead for the common case.

### Found & fixed (minor, in this pass)

- **Multi-capture path had zero direct test coverage.** The ticket's own "known gaps" flagged this:
  no producer fills `nestedCaptures` yet, so the ordered materialization, strictly-earlier
  dependency, and reverse teardown were covered only structurally-by-absence (the empty/single
  suite). Added a `View Mutation Substrate (ordered multi-capture)` describe block to the existing
  node-level harness (`view-mutation-substrate.spec.ts`, 5 tests) pinning the load-bearing cursor
  arithmetic directly: `getChildren` order (base ops → primary → nested in list order), capture
  sources excluded from `getRelations`, the `+capture(1+2)` / `+capture(0+1)` `toString` breakdown
  and `getLogicalAttributes` counts, the `withChildren` unchanged short-circuit returning `this`,
  the `withChildren` rebuild preserving EVERY `descriptor` identity while picking up a replaced
  source, the no-primary-with-nested defensive shape, and the empty/single-capture byte-identity
  floor. (The emitter's runtime materialization order + reverse teardown remain best exercised by
  the compose ticket's `93.4`/`93.6` integration cases — a runtime emit harness with a full
  `RuntimeContext` is net-new and out of scope here; the structural parity, which is what an
  off-by-one would break, is now pinned.)

### Major — none

No correctness, soundness, or design issue warranting a new fix/plan ticket. The substrate matches
the shape `set-op-write-multisource-leg-compose` consumes (primary outer capture + ordered inner
captures whose sources scan strictly-earlier captures, materialized outer-first, torn down in
reverse).

### Docs

`docs/view-updateability.md` § Set Operations (L448-452) still describes multi-source join legs as
"explicitly rejected … pending the `set-op-write-multisource-leg-compose` unlock" — which is
**accurate** for current runtime behavior (the substrate is unfilled; join legs are still rejected
by `set-op-write-multisource-leg-reject`). No doc change is warranted here; the compose ticket owns
the § Set Operations update when it flips the reject and starts filling `nestedCaptures`. The
substrate itself is documented in the `nestedCaptures` ctor doc-comment and the emitter's
"Chained nested captures" doc block.

## Validation

- `yarn workspace @quereus/quereus lint` — **exit 0** (eslint + `tsc -p tsconfig.test.json`,
  including the new test's signatures).
- `yarn workspace @quereus/quereus test` — **6314 passing, 9 pending, exit 0** (6309 prior + the 5
  new structural tests).
