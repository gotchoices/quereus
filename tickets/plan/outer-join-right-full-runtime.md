description: Implement runtime execution of RIGHT and FULL outer joins (or a planner RIGHT→LEFT / FULL→LEFT∪anti normalization), then re-admit RIGHT (and FULL where expressible) into view write-through recognition and the static view_info/column_info surfaces.
files: packages/quereus/src/runtime/emit/join.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/func/builtins/schema.ts, packages/quereus/test/logic/90.5-unsupported-join-types.sqllogic, packages/quereus/test/logic/06.3.4-view-info.sqllogic, packages/quereus/test/logic/06.3.5-column-info.sqllogic, packages/quereus/test/property.spec.ts, docs/view-updateability.md
----

## Why

`runtime/emit/join.ts` throws `RIGHT JOIN is not supported yet` / `FULL JOIN is not supported yet` for `joinType === 'right' | 'full'` — the engine cannot execute either join shape today (pinned by `test/logic/90.5-unsupported-join-types.sqllogic`). A `select … right join …` (or `full join`) fails at runtime; nothing reads or writes through such a body.

The view-write substrate (`view-write-outer-join-static`) classifies a RIGHT join's preserved/non-preserved sides as the exact mirror of LEFT, so it *would* route writes and advertise `view_info`/`column_info` updatability for a RIGHT-join view — except the runtime can't execute the body at all. To avoid that false advertisement, RIGHT is currently **excluded** from write-through recognition (`collectJoinSources` / `isDecomposableJoinBody` accept only `inner` / `left` / `full`; the static surfaces report a RIGHT-join view conservative all-`NO`). FULL self-conservatizes (no preserved side). See the inline notes in `multi-source.ts` and the `06.3.4` Divergence-2 block.

This ticket is the **runtime** prerequisite that unblocks re-admitting RIGHT (and, where statically expressible, FULL) into write-through.

## Scope

1. **Runtime execution.** Either:
   - implement RIGHT and FULL join execution in `runtime/emit/join.ts` (the right-side / both-side null-extension passes), or
   - normalize at plan time: rewrite `A right join B on p` → `B left join A on p`, and `A full join B on p` → `(A left join B) union all (B anti-join A null-extended)` (or the engine's preferred full-outer lowering), so emit only ever sees INNER/LEFT. A planner normalization is likely the smaller, lower-risk change and automatically makes every downstream consumer (read, lineage, view-write) work.

   Whichever path: flip the `90.5-unsupported-join-types` RIGHT/FULL expectations from `-- error` to real result rows, and add read-path coverage.

2. **Re-admit in view write-through.** Once the runtime executes RIGHT (and FULL where a preserved anchor exists post-normalization):
   - add `right` (and re-evaluate `full`) back to the accepted sets in `collectJoinSources` and `isDecomposableJoinBody` (restore the removed `case 'right'` recursion — left of `right` non-preserved, right of `right` preserved);
   - flip the `06.3.4` `oj_right` row from conservative all-`NO` back to the per-side LEFT shape (`is_insertable_into`/`is_updatable`/`is_deletable` = YES, non-preserved column NO), and add a `column_info('oj_right')` per-side row to `06.3.5`;
   - add a RIGHT-join dynamic round-trip mirror of the LEFT property test (`property.spec.ts` § View Round-Trip Laws → multi-source) and a RIGHT-join end-to-end block to `93.4-view-mutation.sqllogic`;
   - update the `docs/view-updateability.md` § Outer Joins "RIGHT / FULL — not yet" note.

## Notes

- If a planner RIGHT→LEFT normalization lands, the view-write recognition may not even need a `right` branch — a normalized body already presents as LEFT to `collectJoinSources`. Verify whether `deriveViewInfo`/`collectJoinSources` see the pre- or post-normalization AST (they plan the body via `_buildPlan`, but `isJoinBody`/`isDecomposableJoinBody` read `view.selectAst` directly — the raw AST still says `right`). If the surfaces read the raw AST, they still need the join-type allowance even after normalization.
- FULL write-through stays bounded by the model: every side is null-extended per row, so there is no static preserved anchor — full-outer writes likely remain conservative even after the runtime supports full-outer *reads*. Treat FULL read support and FULL write-through as separable.
