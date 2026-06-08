---
description: Outer-join key + FD propagation refinement — preserved-side keys survive LEFT/RIGHT joins when equi-pairs cover the other side's unique key
files:
  - packages/quereus/src/planner/util/key-utils.ts
  - packages/quereus/src/planner/nodes/join-node.ts
  - packages/quereus/src/planner/nodes/bloom-join-node.ts
  - packages/quereus/src/planner/nodes/merge-join-node.ts
  - packages/quereus/test/optimizer/keys-propagation.spec.ts
  - packages/quereus/test/optimizer/fd-propagation.spec.ts
  - docs/optimizer.md
---

## What was built

Refined logical key propagation across LEFT/RIGHT outer joins so the preserved
side's unique keys survive when the join's equi-pairs cover the *other* side's
unique key (each preserved-side row then matches ≤ 1 row on the other side, so
no fan-out and no broken keys from null-padding). Previously
`combineJoinKeys` and `analyzeJoinKeyCoverage` returned `[]` for any
non-inner/cross join.

### `combineJoinKeys(leftKeys, rightKeys, joinType, leftColumnCount, equiPairs?)`

Branch table:
- `inner` / `cross`: union of both sides (right indices shifted).
- `left`: returns `leftKeys` iff `equiPairs` cover any right-side key; else `[]`.
- `right`: symmetric — returns `rightKeys` shifted iff `equiPairs` cover any
  left-side key; else `[]`.
- `full`: `[]` (both sides may be NULL-padded).
- `semi` / `anti`: returns `leftKeys` (left-only output, no null-padding).

`equiPairs` is optional; when omitted the LEFT/RIGHT branches conservatively
return `[]` (back-compat).

### `analyzeJoinKeyCoverage`

LEFT branch: when right-side key is covered, propagates left's physical
`uniqueKeys` and caps `estimatedRows` at `leftRows`. RIGHT is symmetric.
FULL still returns empty. INNER/CROSS/SEMI/ANTI unchanged.

### Call sites

- `JoinNode.getType()`: extracts equi-pairs via `extractEquiPairsFromCondition`
  and passes them to `combineJoinKeys`.
- `BloomJoinNode.getType()` / `MergeJoinNode.getType()`: derive column-index
  pairs from `this.equiPairs` (attribute-id form) and pass them through.
  Previously returned `[]` here, dropping logical keys at the physical layer.

### Soundness

SQL `=` is null-rejecting, so each LEFT JOIN row produces exactly one output
row (either matched-once when right key is covered, or NULL-padded). Left's
keys uniquely identify those output rows. Composite-key coverage is handled by
the `joinPairsCoverKey` "any-key fully covered" check, mirroring the
physical-layer logic in `analyzeJoinKeyCoverage`.

### Deviation from the plan

The plan ticket prescribed unconditionally propagating the preserved side's
keys for LEFT/RIGHT — that is unsound (a LEFT JOIN can still duplicate left
rows when the right join columns are non-unique). The implementation
conditions propagation on equi-pair coverage of the other side's key.

## Validation

- `yarn workspace @quereus/quereus run lint`: clean.
- `yarn workspace @quereus/quereus run test`: **2803 passing, 2 pending**, 0 failing.

### Tests added

- `test/optimizer/keys-propagation.spec.ts` — `Outer-join key propagation`:
  - LEFT JOIN preserves left PK when right PK covered.
  - LEFT JOIN drops keys when right key NOT covered.
  - LEFT JOIN with right PK covered: `estimatedRows` bounded by left cardinality.
  - DISTINCT eliminated above LEFT JOIN when right PK is covered.
  - `combineJoinKeys` unit tests covering LEFT (with/without coverage,
    without equiPairs), RIGHT, INNER union, SEMI passthrough, FULL.
- `test/optimizer/fd-propagation.spec.ts` — extended LEFT-outer test to
  assert left-side FDs survive (`{id} → {v}`).

## Reviewer survey of new logical-key consumers

`BloomJoinNode.getType()` / `MergeJoinNode.getType()` previously returned
`[]` for `RelationType.keys`; now they return the combined keys. Consumers
checked:

- `rule-distinct-elimination`: desired behavior — DISTINCT now eliminable
  above hash/merge joins (covered by new test).
- `analyzeJoinKeyCoverage`: reads `leftType.keys`/`rightType.keys` for
  coverage; tighter keys → better coverage detection. Sound.
- `SeqScanNode` / `IndexScanNode` / `IndexSeekNode` (`table-access-nodes.ts`):
  read keys from `TableReferenceNode`, never from joins. Unaffected.
- `ProjectNode.getLogicalAttributes`: display only.
- `buildJoinRelationType`: just stores them; no decision logic.

## Documentation

- `docs/optimizer.md` § "Shared join key-coverage analysis": per-join-type
  bullets for LEFT/RIGHT/FULL/SEMI/ANTI.
- `docs/optimizer.md` § "Key inference after projections / joins": full
  branch table for `combineJoinKeys`.

## Out of scope (potential follow-ups)

- FULL OUTER JOIN key inference (compound case where both sides are covered
  by equi-pairs surviving null-padding).
- Anti-join key refinement.
- Outer-join propagation for non-FD subtypes (approximate FDs).
