description: select * over a join with duplicate-named columns now preserves both sides via `:N` disambiguation instead of silently dropping columns
prereq:
files:
  packages/quereus/src/planner/building/select-modifiers.ts
  packages/quereus/test/logic/11.1-join-using.sqllogic
----
## Summary

`select * from u_a join u_b using (k)` previously returned 4 columns instead of 6 — `u_a.id` and `u_a.k` were silently dropped because their names collided with `u_b`'s and the row→object conversion used JoinNode's raw column names. The same bug affected any `select *` (or unqualified column list) over an ON-equi-join with duplicate names.

`isIdentityProjection` in `select-modifiers.ts` was deciding `select *` over a JoinNode was a no-op (same arity, same per-position names) and skipping the `ProjectNode` that would have applied `name`, `name:1`, … disambiguation. Without that ProjectNode, downstream consumers saw raw duplicate column names, and `rowToObject` overwrote earlier keys with later ones.

## The fix

`packages/quereus/src/planner/building/select-modifiers.ts:213-224` — added a small Set-based duplicate-name check at the top of `isIdentityProjection`. If the source exposes duplicate column names (case-insensitive), the function returns `false`, forcing a `ProjectNode` insertion so downstream sees disambiguated names. The disambiguation itself happens in `ProjectNode.computeOutputType` via the existing `nameCount` map (`project-node.ts:50-83`).

## Behaviour after fix

For tables `u_a(id, k, va)` and `u_b(id, k, vb)`:

- `select * from u_a join u_b using (k)` → 6 columns: `id, k, va, id:1, k:1, vb`.
- `select * from u_a left join u_b using (k)` → 6 columns; unmatched right-side rows produce `null` for `id:1`, `k:1`, `vb`.
- `select * from u_a join u_b on u_a.k = u_b.k` → same 6-column shape.
- USING-key is *not* merged into a single output (Quereus does not implement SQLite's USING-merge); both copies appear (`k` and `k:1`).
- Existing `select l.id, l.val_l, r.id, r.val_r from t_left l join t_right r on …` style continues to produce `{id, val_l, id:1, val_r}` — that path already had projection-arity mismatch and was already inserting a ProjectNode.

## Tests

`packages/quereus/test/logic/11.1-join-using.sqllogic` adds two assertions for `select *` shape:

- `select * from u_a join u_b using (k) order by u_a.id` → 6-column disambiguated rows.
- `select * from u_a left join u_b using (k) order by u_a.id` → 6 columns with right side null on miss.

The unqualified-`k`-is-ambiguous expectation (line 18) is unchanged.

## Validation

- `yarn workspace @quereus/quereus lint` clean.
- `yarn workspace @quereus/quereus build` clean.
- `yarn workspace @quereus/quereus test` (full quereus suite): 918 passing, 1 failing.
- The single failure is `Extended constraint pushdown › OR predicates › handles OR with range predicate as residual correctly` (`packages/quereus/test/optimizer/extended-constraint-pushdown.spec.ts:289`). Confirmed pre-existing and unrelated: re-running with the duplicate-name check temporarily removed reproduces the same failure. It is a separate OR-predicate residual issue introduced by an earlier ticket and out of scope here.
- All 77 join-tagged tests pass (`--grep "join"`), covering `11-joins`, `11.1-join-using`, `11.2-comma-join`, `23-self-joins-duplicates`, `26-join-edge-cases`, `08.1-semi-anti-join`, bloom/merge join paths, etc.

## Notes

- ProjectNode-level dedup is case-sensitive (`nameCount.get(baseName)` in `project-node.ts:67`), but the duplicate-name short-circuit here uses `toLowerCase()`. This is intentional: SQL identifiers are case-insensitive, and the only practical way to produce same-key collisions through `rowToObject` (which uses JS object keys, case-sensitive) is via same-case duplicates from join children. The lowercasing is a slightly conservative trigger — it forces a ProjectNode for case-only differences, which costs nothing and matches SQL semantics.
- Aggregate path is already covered: `buildFinalAggregateProjections` always builds a ProjectNode when `needsFinalProjection`, and that ProjectNode dedupes via the same `outputTypeCache` path.
