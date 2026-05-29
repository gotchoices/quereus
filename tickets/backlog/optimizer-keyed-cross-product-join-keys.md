description: Teach join key derivation to advertise the *product key* of a keyed cross/lateral (no-equi-pair) inner/cross join — `(leftKey ∪ shiftedRightKey)` — when both sides expose a unique key. Today `combineJoinKeys` returns `[]` for such joins and leans on `RelationType.isSet` for whole-row set-ness, so a genuinely unique composite key (e.g. `(base.id, json_each(base.arr).key)` for a lateral TVF, or `(a.pk, b.pk)` for `a cross join b`) is never surfaced to `keysOf`.
files: packages/quereus/src/planner/util/key-utils.ts, packages/quereus/src/planner/nodes/join-node.ts, packages/quereus/test/optimizer/keys-propagation.spec.ts, docs/optimizer.md
----

## Problem

`combineJoinKeys` (`planner/util/key-utils.ts`) preserves a join key only when
one side's key *alone* survives the join (i.e. the equi-pairs cover the *other*
side's key, so each row matches ≤1 partner). For a bare cross / lateral join with
no equi-pairs neither side's key survives alone, so it returns `[]` — even though
the **cross product of two keyed relations is itself keyed** by the pair
`(leftKey, rightKey)`. The result-set's set-ness is instead carried only by
`RelationType.isSet`, which is coarser (a boolean, not a column key).

This conservative choice avoids key-count blow-up (k_left × k_right keys, which
compound across chained joins), but it means downstream consumers that need an
actual *column* key — notably row-time materialized-view maintenance of a
lateral-TVF body, which wants `(base.PK ∪ TVF-per-call-key)` as the backing PK —
cannot recover it from `keysOf` and must reason about the advertisement directly
(see `materialized-view-rowtime-general-bodies`, the lateral-TVF row-time shape
that would otherwise work around this MV-locally).

## Expected behavior

For an `inner`/`cross` join where both sides advertise at least one unique key
and the join is a true product over those keys (lateral fan-out included), the
output advertises the product key `(leftKey ∪ rightKey-shifted-by-leftColumnCount)`.
`keysOf` over `a cross join b`, and over a lateral `base ⋈ tvf(base.x)` whose TVF
advertises a per-call key, then surfaces the composite unique key. Equi-join and
outer/semi/anti behavior is unchanged.

## Constraints / open questions

- **Blow-up containment.** Bound the product to a small number of keys (e.g. the
  lex-min key per side, or cap at 1×1) so chained joins don't explode the key
  set. Decide the policy.
- **Physical FD path.** `analyzeJoinKeyCoverage` / `propagateJoinFds` (the FD
  layer) must stay consistent with the logical `combineJoinKeys` change.
- **Regression surface.** MV backing-PK derivation (`deriveBackingShape` via
  `keysOf`) would change from all-columns fallback to the composite key for
  affected bodies — a narrowing that is sound but alters physical layout; run the
  full suite and the MV corpus.

## Use case

Unblocks letting the lateral-TVF row-time shape in
`materialized-view-rowtime-general-bodies` (and the deferred both-clean join path)
lean on `keysOf` for the backing PK instead of bespoke advertisement reasoning,
and improves key-driven optimizations (distinct elimination, covering proofs) for
cross/lateral products generally.
