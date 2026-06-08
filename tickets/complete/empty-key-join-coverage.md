description: Recognize the empty (≤1-row) key as join coverage in the logical `combineJoinKeys` path and migrate the physical `analyzeJoinKeyCoverage` path onto the unified `keysOf`/`isUnique` surface, propagating ≤1-row-ness through joins as the singleton `∅ → all_cols` FD. Reviewed and completed.
files: packages/quereus/src/planner/util/key-utils.ts, packages/quereus/src/planner/nodes/join-utils.ts, packages/quereus/src/planner/util/fd-utils.ts, packages/quereus/src/planner/nodes/join-node.ts, packages/quereus/test/optimizer/keys-propagation.spec.ts, docs/optimizer.md
----

## What landed (summary)

- `joinPairsCoverKey` dropped its `k.length > 0` guard: the empty key `[]` is now
  unconditional coverage (a ≤1-row side caps the partner at one match). LEFT/RIGHT/
  inner/cross no longer early-return `[]` on empty `equiPairs` when the opposite side
  is ≤1-row. Both sides ≤1-row ⇒ the join advertises `[]` (deduped); full outer stays `[]`.
- `analyzeJoinKeyCoverage` migrated onto `keysOf`/`isUnique`: coverage collapses to a
  single `isUnique(eqIndices, side)` call (folds the old `coversLogicalKey || isSuperkey`
  pair and adds empty-key recognition); `preservedKeys` sourced from `keysOf` (declared +
  FD-derived + empty), closing the prior logical-keys-only gap. Both sides ≤1-row pushes
  `[]`, materialized by `propagateJoinFds` → `superkeyToFd([])` as the singleton `∅ → all`.
- semi/anti `preservedKeys` also sourced from `keysOf(leftRel)`.
- Logical layer (`combineJoinKeys`/`getType().keys`) recognizes only the logical empty
  key by design; FD-provable ≤1-row-ness flows through the physical path.

## Review findings

**Read the implement diff (`1ea3b488`) first, then the source, the FD/key surface
(`fd-utils.ts`), and the join-node caller.** Build, lint, and the full quereus suite were
run; all green.

### Verified sound (checked, no change needed)

- **Empty-key coverage soundness.** `joinPairsCoverKey([], …)` is vacuously true — the
  removed `k.length > 0` was a conservative *miss*, not a soundness guard. The empty key
  in `RelationType.keys` is the established ≤1-row marker (TableDee / scalar aggregate);
  no node injects `[]` for a multi-row relation, so treating it as coverage is sound.
- **≤1-row × ≤1-row ⇒ ≤1-row** for inner/cross/left/right (verified per join type,
  including LEFT/RIGHT NULL-padding: ≤1 left row × ≤1 match-or-pad = ≤1 output). Full
  outer correctly excluded (two non-matching ≤1-row sides → two padded rows).
- **`isUnique` all-columns branch is stricter (more sound)** than the old
  `isSuperkey(allCols)` — a correctness improvement, Key Soundness tier stays green.
- **Index/column-count consistency** at the `join-node.ts` caller: `totalCols =
  getAttributes().length` (left shape for semi/anti), `preservedKeys` left-indexed for
  semi/anti and right-shifted elsewhere; `superkeyToFd(allCols)` → `undefined` (skipped),
  so no spurious FD from the new `keysOf`-sourced all-columns key.
- **The "belt-and-suspenders" explicit `push([])`** noted by the implementer is indeed
  redundant (when a side is ≤1-row, the covered-branch already pushes a `keysOf`-sourced
  `[]`) but harmless (duplicate `[]` collapses in `addFd`). Left in place as documented
  intent; not worth churning.

### Mandatory empty-key / ≤1-row sweep (carried-forward requirement)

Swept every `keys.length > 0` / `k.length > 0` / direct `RelationType.keys` read in the
planner against the unified surface:

- **DISTINCT elimination, GROUP BY simplification, ORDER BY trailing-key pruning** all
  already consume `keysOf`/`isUnique`, so the join's new empty key flows into them
  automatically. Confirmed DISTINCT elimination and GROUP BY collapse fire over a ≤1-row
  join.
- **`async-gather-node` cartesian key fold** reads logical `.keys` directly — correct,
  it is the logical layer (no FD access), and it folds the empty key soundly.
- **`constraint-extractor` / `filter.ts` `uniqueKeys`** are table-schema constraint
  analysis, a separate concern — not an empty-key gap.

Follow-up tickets filed (work NOT expanded into this ticket):

- **`tickets/fix/limit-one-singleton-fd`** — `LimitOffsetNode.computePhysical` never
  emits `∅ → all` for `LIMIT 1` (confirmed candidate from the carried-forward note). A
  `LIMIT 1` relation is provably ≤1-row and should advertise the empty key.
- **`tickets/backlog/sort-elimination-over-singleton`** — a single-key ORDER BY over a
  ≤1-row source is a no-op but is not eliminated (`rule-orderby-fd-pruning` only prunes
  trailing keys and never the first). General sort-elimination over ≤1-row sources.

### Major finding — pre-existing correctness bug surfaced (filed, not fixed here)

Adding a behavioral test (the implementer's honesty note #1: "tests assert FD presence,
not end-to-end rows") surfaced a **pre-existing** wrong-column bug:

```sql
SELECT * FROM (SELECT count(*) AS a FROM t) x CROSS JOIN (SELECT count(*) AS b FROM t2) y
-- returns { a: 3, id: 2 } — second column mislabeled `id` instead of `b`
```

Reproduces with explicit `SELECT x.a, y.b` (not a `*`-only issue), across different
tables, with and without DISTINCT, and — verified by reverting `key-utils.ts` +
`join-utils.ts` to the parent commit `9a4e3a92` — **on the parent commit too**. It is a
scalar-aggregate-subquery column-naming/attribute-id defect, fully independent of the
FD/key propagation work (which cannot affect emitted column names/values). Filed as
**`tickets/fix/scalar-agg-subquery-star-column-naming`**. Values are correct; only the
output column identity is wrong.

### Tests added (minor — done in this pass)

Addressed the implementer's honesty note #1 by adding two behavioral tests in
`keys-propagation.spec.ts`:

- `DISTINCT-eliminated ≤1-row join returns the same rows as the un-eliminated query` —
  asserts result-set equality of the DISTINCT-eliminated plan against the DISTINCT-free
  query (the actual soundness property), rather than a hard-coded `{a,b}` shape that
  would trip the unrelated pre-existing naming bug above.
- `≤1-row CROSS JOIN preserving the other side keys returns correct rows` — explicit
  column refs over a scalar-aggregate cross join return correct rows/values.

Honesty note #2 (ORDER BY / GROUP BY collapse) was investigated: **GROUP BY collapse and
DISTINCT elimination over a ≤1-row join do fire** (both consume `keysOf`); **full ORDER
BY elimination does not** and is the `sort-elimination-over-singleton` backlog ticket.

### Validation

- `yarn workspace @quereus/quereus run build` — pass.
- `yarn workspace @quereus/quereus run lint` — pass (exit 0).
- `yarn workspace @quereus/quereus test` — **3623 passing, 9 pending** (was 3621; +2
  behavioral tests). Key Soundness tier green.
- `test:store` not run (no store-specific surface touched; FD/key metadata is
  storage-agnostic).
