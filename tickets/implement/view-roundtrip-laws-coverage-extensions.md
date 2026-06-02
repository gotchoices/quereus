description: Tighten the residual dynamic-coverage gaps in the View Round-Trip Law harness (`describe('View Round-Trip Laws')` in `test/property.spec.ts`) flagged at review of `view-roundtrip-laws-multi-source`. The harness is the acceptance gate for the `view-mutation-derived-backward-walk` migration; these extensions close paths the current seeding models in its oracle but never generates, so a put-path regression on them would pass the gate silently. None is a correctness defect in shipped engine code — each is a missing *dynamic* exercise of an already-supported (or already-rejected) path.
prereq: view-roundtrip-laws-multi-source
files: packages/quereus/test/property.spec.ts
effort: medium
----

## Why this exists

Review of `view-roundtrip-laws-multi-source` confirmed (by fault injection into
`decomposition.ts`'s assignment-routing — a wrong value threaded into a member's UPDATE
was caught end-to-end as a `T_b` base-image diff) that the laws genuinely red on a real
backward-walk bug, not merely on oracle mismatches. That closes the implementer's
top-flagged gap. The remaining gaps are **coverage**, not soundness of the laws
themselves: the oracle already models these shapes, but the seeding never produces them,
so the corresponding put-path arm is never dynamically walked.

These matter because `view-mutation-derived-backward-walk` (already `prereq`-chained to
this harness and naming `test/property.spec.ts` as its acceptance gate) will rewrite the
fan-out to consume each operator's landed `updateLineage`/`attributeDefaults` directly. A
regression on an un-generated path would not red the gate.

## Coverage extensions to land

- **Family C: the "mandatory member missing ⇒ logical row invisible & untouched" path.**
  The columnar PutGet seeds `T_b` for *every* `T_core` id, so the inner `core ⋈ b` join
  never hides a row and `expView`'s `.filter(id => bMap.has(id))` is a no-op. Seed some
  `T_core` rows with no `T_b` row and assert (a) the logical row is invisible through the
  view and (b) a mutation predicated on the anchor never materializes/perturbs the absent
  member. Also exercise anchor *non-key* column predicates (`where a = K`), not only the
  unique logical PK `id`.

- **Family C: surrogate multi-row minting through the decomposition path.** The surrogate
  PutGet inserts exactly one logical row per run, so per-row-distinct minting *through the
  decomposition fan-out* is never exercised (the multi-source-join insert covers multi-row
  minting only on its own path). Insert several logical rows in one statement and assert
  each member threads the same per-row surrogate and the surrogates are pairwise distinct.

- **Family C: lineage agreement over the EAV and surrogate advertisements.** The structural
  forward/backward lineage-agreement check runs only over the columnar advertisement; the
  EAV and surrogate advertisements are covered behaviorally (PutGet) but not by the
  structural member-map reconstruction. Extend the lineage-agreement assertion to those two.

- **Family B: fuzz the collision/overlap edges of `delete_via=parent` and the
  directly-supplied-key insert.** Both are currently single deterministic scenarios
  (`delete_via` is one fixed row; the directly-supplied insert always picks a fresh disjoint
  key). Property-fuzz them so a supplied key colliding with an existing base key, and a
  `delete_via=parent` removing a parent shared by multiple children, are exercised.

## Out of scope

- GetPut write-back of optional `c` / EAV columns — those are read-only through the
  decomposition by design (writes are deferred), so their round-trip is legitimately out of
  scope and should stay asserted-as-rejected, not round-tripped.
- The both-sides Family B update predicate-clash variant — owned by its own landed ticket
  (`view-mutation-multisource-both-sides-predicate-clash`), not re-fuzzed here.
