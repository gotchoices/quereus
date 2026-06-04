description: Extend view/lens write-through to the shape families the model specifies but the substrate rejects today — outer-join / optional-member bodies and composite-key / >2-table / self-join inner joins.
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/mutation/propagate.ts, packages/quereus/src/planner/mutation/decomposition.ts, packages/quereus/src/planner/analysis/update-lineage.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/planner/nodes/view-mutation-node.ts, packages/quereus/src/runtime/emit/view-mutation.ts, packages/quereus/test/property.spec.ts, docs/view-updateability.md, docs/lens.md
----

## Why

The write-through model in `docs/view-updateability.md` already *specifies* outer-join and optional-member semantics (§ Outer Joins) and the n-way decomposition handles many shapes, but the multi-source substrate accepts only **two-table inner equi-joins with a single-column PK per side**. Every richer shape a user reaches for first is currently a clean diagnostic — but still a "no". These are the most visible gaps between the documented model and the shipped behaviour, and they block real lens decompositions (optional members ride outer joins; columnar splits exceed two tables).

This ticket closes the gap between "specified" and "wired" for the join/decomposition write path. It is the largest user-visible lever identified in the view-update/lens capability review.

## Scope — the shapes to admit

These are independent shape families; the plan stage may split them into chained implement tickets, but they share one substrate (the backward-walk consumer, the key-capture, the base-op fan-out) and should be designed together so the substrate is generalized once.

1. **Outer-join / optional-member write-through.** A `left` / `right` / `full outer join` body, including the lens default-mapper's outer-joined optional members. The `null-extended` lineage site already exists (`update-lineage.ts` `deriveJoinUpdateLineage`); what is missing is the propagation that consumes it:
   - update on the preserved side → unchanged passthrough;
   - update on a *matched* non-preserved row → ordinary base update;
   - update on a *null-extended* row → rewrite to an **insert** on the non-preserved side (join-key values via EC, others via default/`default_for`), per the documented "Updates on a non-preserved-side column" split;
   - insert/delete routing per the § Outer Joins rules (delete → preserved side by default; insert follows structural intent).
   - The lens decomposition `put` fan-out (`decomposition.ts`) must stop rejecting the outer joins its own optional members ride.

2. **Composite-key and >2-table inner joins, self-joins.** Remove the single-column-PK-per-side and two-table caps in `collectInnerJoinSources` / `buildMultiSourceKeyCapture` (`multi-source.ts`):
   - composite PK on either/both sides — the up-front base-PK key capture must materialize a multi-column key set;
   - n-way (>2) inner equi-join chains — generalize per-side routing and FK-ordered base-op issue beyond the binary case;
   - self-joins — per-alias update sites already exist in the model (§ Cycles, Self-Joins); wire per-alias routing with alias-declaration-order serialization.

3. **Cross-source `set` values** (assigning a column on one side from a column on another) — currently rejected; admit where lineage proves the read column is `base`.

## Expected behaviour / use cases

- The `Car` decomposition in `docs/lens.md` (CarCore ⟕ CarSpeed, optional speed) accepts an insert/update/delete that touches only the optional member, the anchor, or both.
- A three-table columnar split is fully writable through one logical insert (anchor-first, surrogate threaded once — the envelope already supports the fan-out; the join *recognition* is what blocks it).
- `update v set a.x = b.y where …` over an inner-join view lowers `a.x` to its base with the value read from `b.y`'s base lineage.
- A self-join view (`t` aliased twice) routes updates per alias, serialized in declaration order, each observing the prior.
- Composite-PK join sides round-trip: an update keyed on a 2-column PK binds the correct base rows.

## Out of scope (park in backlog/known if surfaced)

- Multi-source (join) **insert** RETURNING with a minted shared surrogate — already a tracked limitation; only fold in if it falls out naturally.
- Aggregate/window write propagation.
- `>2`-table mutual-FK delete-ordering analysis beyond the existing two-side ON-DELETE-aware rule (generalize only as far as the n-way fan-out needs).

## Tests (TDD seeds for later phases)

The acceptance gate is the **View Round-Trip Laws** property block (`test/property.spec.ts`): each newly-admitted shape must pass PutGet / GetPut / forward-backward lineage agreement over a planned tree that surfaces it, with a negative self-test proving the core reds on an injected violation. Add to the existing three families:
- outer-join family (matched + null-extended update, both-side insert, preserved-side delete);
- composite-key inner join, n-way (≥3) inner join, self-join;
- cross-source `set`.
Shapes still deferred after this ticket must continue to **reject** (assert the diagnostic), never silently widen.
