----
description: Standalone forward key-derivation improvement (no spike prereq): combineJoinKeys advertises the product key of a keyed cross/lateral join; supplies lateral-TVF backing PK to keysOf so general-bodies prereqs it. Renamed (seq 2).
prereq:
files: planner/util/key-utils.ts, planner/nodes/join-node.ts, test/optimizer/keys-propagation.spec.ts, docs/optimizer.md
----

> **Relationship to the maintenance substrate.** This is a standalone forward-optimizer
> key-derivation improvement (it also helps distinct elimination and covering proofs), so
> it carries **no** prereq on `incremental-maintenance-substrate-spike` and can land
> independently. Its maintenance relevance is that it supplies the composite backing PK the
> `'prefix-delete'` / lateral-TVF arm of `materialized-view-rowtime-general-bodies`
> consumes from `keysOf` — so general-bodies prereqs *this* ticket (the explicit reverse
> edge), not the other way around. Keep this ticket's scope purely on `combineJoinKeys` /
> `analyzeJoinKeyCoverage`; the maintenance consumption lives in general-bodies.

## Problem

`combineJoinKeys` (`planner/util/key-utils.ts`) preserves a join key only when
one side's key *alone* survives the join — that is, the equi-pairs cover the
*other* side's key, so each row matches ≤1 partner. For a bare cross / lateral
join with no equi-pairs, neither side's key survives alone, so the function
returns `[]` — even though the **cross product of two keyed relations is itself
keyed** by the pair `(leftKey, rightKey)`. The result-set's set-ness is instead
carried only by `RelationType.isSet`, which is coarser (a boolean, not a column
key).

This conservative choice avoids key-count blow-up (k_left × k_right keys,
compounding across chained joins), but it means downstream consumers that need
an actual *column* key — notably row-time materialized-view maintenance of a
lateral-TVF body, which wants `(base.PK ∪ TVF-per-call-key)` as the backing PK
— cannot recover it from `keysOf` and must reason about the advertisement
directly (see `materialized-view-rowtime-general-bodies`, the lateral-TVF
row-time shape that would otherwise work around this MV-locally).

The current `inner`/`cross` branch in `combineJoinKeys` already handles the
case where equi-pairs cover one side's key (preserving the other side's key),
and handles the ≤1-row (empty-key) shortcut. What it does not handle is the
third case: *both* sides advertise at least one non-empty unique key and there
are no equi-pairs (or the equi-pairs do not cover either side's key) — a true
relational product. In that regime the product is keyed by `(lex-min left key
∪ lex-min right key shifted by leftColumnCount)`, and that composite key is not
emitted today.

## Expected behavior

For an `inner`/`cross` join where both sides advertise at least one unique key
and the join is a true product over those keys (lateral fan-out included), the
output advertises the product key `(leftKey ∪ rightKey-shifted-by-leftColumnCount)`.
`keysOf` over `a cross join b`, and over a lateral `base ⋈ tvf(base.x)` whose
TVF advertises a per-call key, then surfaces the composite unique key. Equi-join
and outer/semi/anti behavior is unchanged.

The physical layer (`analyzeJoinKeyCoverage` → `propagateJoinFds`) must emit a
corresponding FD `(left-key-cols ∪ right-key-cols-shifted) → (all join cols)` so
that `isUnique` and `keysOf` over physical properties agree with the logical
layer.

## Design constraints

**Blow-up containment.** Emit at most one product key per `inner`/`cross` call:
select the lex-min key from each side (fewest columns, then lowest first-column
index) and concatenate them. This bounds the key-set growth to at most one new
entry per join node regardless of how many alternative keys each side carries,
keeping chained-join scenarios tractable. Document this policy in the function
comment alongside the existing soundness argument.

**Gating condition.** The product key is emitted only when:
1. The join type is `inner` or `cross`.
2. Neither the equi-pairs-cover-right-key nor the equi-pairs-cover-left-key
   branch already fired (those branches are the existing equi-join logic and
   yield the correct individual-side survivor keys).
3. Both sides have at least one non-empty key entry (an empty key means ≤1-row
   and is already handled by the existing empty-key shortcut; the product key
   would be redundant and structurally empty).

**Physical FD path consistency.** `analyzeJoinKeyCoverage` uses the physical FD
closure (`keysOf` / `isSuperkey` path) in addition to logical keys. After the
logical change, add a parallel branch in `analyzeJoinKeyCoverage` that detects
the same three conditions above and emits the composite key into `preservedKeys`,
so `propagateJoinFds` generates the FD `(left ∪ right-shifted) → (all cols)`.

**Regression surface.** MV backing-PK derivation (`deriveBackingShape` via
`keysOf`) changes from an all-columns fallback to the composite key for affected
lateral-TVF bodies — a narrowing that is sound but alters physical layout. Run
the full test suite and the MV logic corpus (`51-materialized-views.sqllogic`,
`53-materialized-views-rowtime.sqllogic`, `54-covering-mv-enforcement.sqllogic`)
to confirm no regressions before merging.

## Key tests

- Unit test in `keys-propagation.spec.ts`: `CROSS JOIN` where both sides
  advertise a single-column PK → output carries the two-column composite key
  with right-side column index shifted by `leftColumnCount`.
- Unit test: `a INNER JOIN b ON a.x = b.y` where the equi-pair does not cover
  either side's key but both sides have keys → no product key emitted (the
  equi-pair introduces fan-out, so the composite is not sound without full
  coverage reasoning).
- Integration test via `query_plan(...)`: a lateral TVF with a declared per-call
  key joined to a base table → the join node's physical properties contain the
  composite FD; a `DISTINCT` above the join is eliminated.
- Regression: existing `combineJoinKeys` unit tests (the `≤1-row` empty-key
  suite, left/right/semi/anti/full branches) must all continue to pass.

## Use case

Unblocks letting the lateral-TVF row-time shape in
`materialized-view-rowtime-general-bodies` (and the deferred both-clean join
path) lean on `keysOf` for the backing PK instead of bespoke advertisement
reasoning, and improves key-driven optimizations (distinct elimination, covering
proofs) for cross/lateral products generally.
