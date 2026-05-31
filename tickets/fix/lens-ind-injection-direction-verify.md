description: Verify (and likely correct) the DIRECTION of the existence-anchor inclusion dependency injected by `computeExistenceAnchorInds`. The producer emits `member.key ⊆ anchor.key` (cols=member, target=anchor), but the stated consumer obligation — no-row-loss of the mandatory INNER join, preserving anchor rows — needs `anchor.key ⊆ member.key`. The emitted direction is also the one NOT guaranteed by `presence:'mandatory'` (it needs member→anchor referential integrity), so it may be unsound. Currently inert (no consumer reads `LensSlot.injectedInds`), so fix BEFORE a consumer lands.
prereq: lens-multi-source-ind-injection
files: packages/quereus/src/schema/lens-compiler.ts, packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/src/vtab/mapping-advertisement.ts, packages/quereus/src/planner/util/ind-utils.ts, packages/quereus/src/planner/util/fd-utils.ts, packages/quereus/test/lens-advertisement.spec.ts
----

## Problem

`computeExistenceAnchorInds` (lens-compiler.ts) injects, per mandatory non-anchor
non-EAV decomposition member, an `InclusionDependency`:

```
cols   = member shared-key column indices (on the member's own basis relation)
target = { kind:'relation', relationId: <anchor>, targetCols: <anchor key indices> }
nullRejecting = false
```

Per the `InclusionDependency` convention (FK seeding `seedTableForeignKeyInds` puts the
referencing/child cols in `cols` and the referenced/parent in `target.targetCols`), this
asserts **`member.key ⊆ anchor.key`** — "every mandatory-member key value exists in the
anchor" (member is the child).

### Why that may be the wrong fact

The get-synthesis (lens-multi-source-get-synthesis) builds a left-deep join rooted at the
existence **anchor**, INNER-joining each mandatory member. The obligation this IND is
meant to discharge ("no row loss", "put soundness") is: **no anchor row is dropped by the
inner join** → every anchor entity has a matching mandatory-member row → the required
inclusion is **`anchor.key ⊆ member.key`** (the opposite direction).

`presence:'mandatory'` means *totality of the component w.r.t. the anchor* (every logical
/anchor row has this member), which gives exactly `anchor.key ⊆ member.key`. It does **not**
give `member.key ⊆ anchor.key` — that would require member→anchor referential integrity
(no orphan member rows), which the decomposition contract does not state. A mandatory-member
row whose key is absent from the anchor is simply filtered out of the get by the inner join
(reads stay correct), but it makes the **injected** `member ⊆ anchor` IND *false* → unsound
fact injection.

The implementer's defense (slot/ticket "Direction note") is that anchor↔mandatory-member is
1:1 on the shared key so "the converse holds too". Even granting 1:1: (a) only one direction
is injected, and `member ⊆ anchor` does not let a consumer derive `anchor ⊆ member`; (b) the
1:1-ness is not itself represented as a fact; (c) the ticket *spec* literally specified
`member.key ⊆ anchor.key`, so this needs a design decision, not just a code tweak.

## What to decide / do

- Confirm the `InclusionDependency` direction convention by reading `plan-node.ts`
  (`InclusionDependency` / `IndTarget`) and how `ind-utils.ts` consumers interpret
  `cols` vs `target.targetCols`.
- Confirm the precise meaning of `presence:'mandatory'` in `mapping-advertisement.ts`.
- Decide the correct fact(s) to inject. Most likely: emit **`anchor.key ⊆ member.key`**
  (the totality direction `mandatory` actually guarantees and the no-row-loss consumer
  needs), or emit **both** directions only when a separate invariant guarantees member→anchor
  RI. Whatever is asserted must come with a one-line soundness justification tied to a
  property the advertisement/store actually guarantees.
- Update the 6 IND-injection tests in `lens-advertisement.spec.ts` (they currently assert
  the as-implemented direction, so they do not catch this) and the docs in
  `docs/lens.md` / `docs/optimizer.md`.

## Notes

- No live incorrectness today: no code reads `LensSlot.injectedInds` (verified — the prover
  does not consume it). This is a correctness-of-the-fact issue to settle before the
  consumer (`lens-multi-source-put-fanout` or a prover no-row-loss obligation) is built.
- Also revisit, while here: `injectedInds` is computed for **any** advertisement-backed slot
  including a full hand-authored override that bypasses the advertised body — the fact may
  not match the actual compiled joins in that case (review finding R2).
