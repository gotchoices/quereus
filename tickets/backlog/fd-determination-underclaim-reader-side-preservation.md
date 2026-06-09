description: Design decision — should the producer-side single↔single FD gate (shipped across the `fd-*-key-bag-overclaim` family) be replaced/augmented by a reader-side fix ("direction B") so the true one-way/bi-directional determination FD is PRESERVED on non-keyed tables instead of dropped? Recurring tradeoff deferred inline by every sibling ticket; consolidated here for a one-time human decision.
prereq:
files: packages/quereus/src/planner/util/fd-utils.ts, packages/quereus/src/planner/nodes/reference.ts, packages/quereus/src/planner/nodes/filter.ts
----

## Background

The `fd-*-key-bag-overclaim` ticket family fixed a wrong-results class where a
determination FD derived from a CHECK / hoisted assertion / filter predicate
(`check (a = b)` ⇒ `{a}↔{b}`, `check (b = a + 1)` ⇒ `{a}→{b}`) was read by
`deriveKeysFromFds` as a uniqueness claim. Over a narrow projection of a
non-keyed table (`select distinct a, b`) the FD's closure covered all output
columns, so `{a}` was read as a phantom key (a bag read as a set) and
`rule-distinct-elimination` dropped a REQUIRED DISTINCT.

The shipped fix is **direction A — producer-side gating** (`foldSingleSingleGated`
in `fd-utils.ts`, plus the inline `activateGuardedFds` gate in `filter.ts`):
every single↔single FD is folded onto a producer's physical FDs **only when an
endpoint is a genuine key there**; otherwise it is dropped — a sound *under-claim*.

## The accepted tradeoff (what this ticket is about)

The under-claim **loses the true determination FD on non-keyed tables**. Any
consumer that could legitimately use the FD when the output is *not* projected
narrowly — ordering reasoning, cache/dedup reasoning, etc. — no longer sees it.
No FD/key-consumer regression has surfaced in any sibling's full-suite sweep
(ordering, cache, lens-put, binding-extractor all green), so the loss is
currently invisible. But it is a real expressiveness reduction in the FD layer.

## Direction B (the deferred alternative)

Fix it on the **reader** side instead of the producer side: in
`fd-utils.ts` `isUnique` / `deriveKeysFromFds`, the proper-subset closure branch
should only treat a closure-covering determinant `K` as a *key* when `K` is
**itself independently unique** (i.e. `K` is a declared/derived key, not merely a
determinant whose closure happens to cover all columns via a determination FD).
That would let the determination FD remain in `physical.fds` for honest
consumers while still refusing to read it as a phantom key.

This was "repeatedly flagged and deferred across the sibling tickets" because it
is a heavier, riskier change to the core key-derivation logic that every node
depends on, versus the surgical producer gate. It needs human sign-off on:

- Whether the under-claim is acceptable as the permanent design (then close this
  as won't-do), OR direction B is worth the risk.
- If B: an audit of every `deriveKeysFromFds` / `isUnique` / `isSuperkey`
  call site to confirm the stricter "determinant must be independently unique"
  rule doesn't break legitimate key derivation (joins, projections, covered-key
  detection in `FilterNode`, etc.).
- Whether B *replaces* the producer gate or *coexists* with it (defense in
  depth — the producer gate is cheap and the marker-drop-through-join concern
  documented in `foldSingleSingleGated` argues for keeping it regardless).

## Decision needed

Accept the under-claim permanently (close this), or schedule direction B as a
planned change. No active code work until that decision is made.
