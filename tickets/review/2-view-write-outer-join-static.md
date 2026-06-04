description: Review outer-join (left/right/full) write-through admission into the multi-source substrate for the statically-expressible cases — preserved-side update passthrough, delete-to-preserved, and insert routing (both-side / preserved-only / presence-gated non-preserved member). A non-preserved-side UPDATE defers (`unsupported-outer-join-update`, owned by `view-write-optional-member-transitions`); a non-preserved-only insert rejects (`null-extended-create-conflict`); a FULL outer join (no preserved anchor) is rejected wholesale. Static `view_info`/`column_info` surfaces relaxed to per-side.
prereq: view-write-nway-inner-join
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/mutation/mutation-diagnostic.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/func/builtins/schema.ts, packages/quereus/test/property.spec.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, packages/quereus/test/logic/93.2-view-mutation-pending.sqllogic, packages/quereus/test/logic/06.3.4-view-info.sqllogic, packages/quereus/test/logic/06.3.5-column-info.sqllogic, docs/view-updateability.md
----

## What landed

`collectInnerJoinSources` (now `collectJoinSources`) rejected every non-inner join (`joinType !== 'inner'`), so an outer-join body — preserved side and all — was rejected wholesale. The join-update lineage already marked non-preserved-side columns `null-extended` (`deriveJoinUpdateLineage`); the missing piece was the **consumer**. This ticket admits `left`/`right`/`full` at recognition and wires the per-op routing the **static** base-op fan-out can express.

```
-- view: select c.cc as cc, c.cv as cv, p.pv as pv from oj_child c left join oj_parent p on p.pp = c.pr
--   oj_child (left)  = PRESERVED      cc, cv  -> base-writable
--   oj_parent (right)= NON-preserved  pv      -> null-extended (read-only on update, insertable as optional member)

update ojv set cv = 9 where cc = K     -> child update (works for null-extended rows too)
update ojv set pv = 9 where cc = K      -> reject unsupported-outer-join-update  (deferred: view-write-optional-member-transitions)
delete from ojv where cc = K            -> delete the PRESERVED (child) side only (parent survives)
insert into ojv (cc,cv,pv) values (…)   -> both-side: child + presence-gated parent under a minted shared key
insert into ojv (cc,cv) values (…)      -> preserved-only: single child insert; row reads back null-extended (pv null)
insert into ojv (pv) values (…)         -> reject null-extended-create-conflict  (no preserved anchor)
```

### Recognition (`multi-source.ts`)

- `JoinSide` gained `preserved: boolean` + optional `guard?` (the enclosing outer join's ON predicate). `OutColumn` gained `nullExtended: boolean`.
- `collectInnerJoinSources` → **`collectJoinSources`**: accepts `inner`/`left`/`right`/`full`; walks the join tree tracking which branch each table sits on (right-of-`left`, left-of-`right`, both-of-`full` are non-preserved), conjoining the enclosing ON predicate(s) into each leaf's `guard`. `isDecomposableJoinBody` (the boolean shadow consumed by the static surfaces) widened to the same four join types.
- `analyzeJoinView` threads `preserved`/`guard` onto each `JoinSide` and `nullExtended` onto each `OutColumn` (cross-checking the AST-shape classification against the planned body's `null-extended` lineage).

### UPDATE (`decomposeUpdate`)

- Preserved-side column → ordinary base update (unchanged path).
- A non-preserved (`out.nullExtended`) column with base lineage → new reject **`unsupported-outer-join-update`** (added to the `mutation-diagnostic.ts` reason union), *before* the generic `no-inverse` (the column DOES have base lineage; it just needs the deferred materialization). A genuinely-computed column still hits `no-inverse`.

### DELETE (`chooseDeleteSides`)

- The default candidate set is now **`preservedSideIndices`** (was `allSideIndices`); tags compose within. Inner joins are all-preserved ⇒ unchanged. A FULL outer join (no preserved side) → reject `unsupported-join` (per-row routing is not statically expressible).

### INSERT (`analyzeMultiSourceInsert` + `buildMultiSourceInsert`)

- Implicit supplied set now includes null-extended base columns (`sideIndex && baseColumn && !inverse`), and the `Supplied` resolution dropped the `!writable` gate so a non-preserved base column is insertable. `MsInsertSide` gained `presenceGateIndices`.
- **Active sides** = preserved (always inserted) ∪ non-preserved-with-supplied-columns. An inactive non-preserved side emits no insert (the preserved-only case); an active non-preserved side is presence-gated per row over its supplied columns (reusing `buildPresenceGate` from the decomposition fan-out). The shared key is minted/threaded only when **≥2 active sides** (preserved-only ⇒ 1 active ⇒ no mint, the preserved side's join-key column defaults to null).
- New rejects: `null-extended-create-conflict` (only non-preserved columns supplied, no preserved anchor) and `unsupported-join` (FULL outer insert).
- `buildMultiSourceInsert` wraps each non-preserved side's `EnvelopeScanNode` in a presence `FilterNode`.

### Static surfaces (`func/builtins/schema.ts`)

- Removed the outer-join all-`NO` short-circuit (`hasNullExtendedLineage` deleted). `baseSiteOf` now reports `nullExtended`. `deriveViewInfo`/`deriveColumnInfo` use it per-column: a preserved base column is `is_updatable='YES'` with its trace; a null-extended column is `'NO'` (matching the dynamic deferral). Deletability + insertability are decided over **preserved** targets only (a non-preserved target is optional on insert and never the delete route); effective_targets still lists both. A body with **no** preserved target (FULL outer, or a LEFT/RIGHT projecting away its whole preserved side) short-circuits to conservative all-`NO`.

## Use cases to validate (the acceptance gate)

`test/property.spec.ts` § View Round-Trip Laws → `describe('multi-source inner join')`:

- **`outer (left) join: preserved write-through + presence-gated optional member round-trips`** (new) — the headline test. Static plan-lineage (cc/cv `base`, pv `null-extended`); static `view_info`/`column_info` per-side agreement; negatives (`update set pv` → `unsupported-outer-join-update`, `insert (pv)` → `null-extended-create-conflict`); a property loop over both-side / preserved-only insert, preserved update (incl. null-extended rows), delete-to-preserved (incl. null-extended rows), with a GetPut idempotence check.
- **`reject-do-not-widen`** block (flipped) — `insert into rj_outer (cc,cv,pv)` is now an **accept** (was `unsupported-join`); added preserved-only insert, preserved update, delete smokes; the non-preserved-update negative is now `unsupported-outer-join-update`, plus the non-preserved-only-insert and cross-source-through-outer (`no-inverse`) negatives. The `rjparent.pp` fixture gained the high-water-mark default (the both-side insert mints the shared key from it).

`test/logic/93.4-view-mutation.sqllogic` § "Outer joins" (new): end-to-end LEFT-join preserved update / non-preserved-update reject / both-side + preserved-only insert / non-preserved-only reject / delete-to-preserved, all on real data. `93.2-view-mutation-pending.sqllogic` `voj` comment refreshed. `06.3.4-view-info.sqllogic` / `06.3.5-column-info.sqllogic` Divergence-2 rewritten: LEFT/RIGHT report per-side YES/per-column, FULL stays conservative.

## Validation performed

- `yarn workspace @quereus/quereus test` — **4603 passing**, 9 pending, 0 failing.
- `yarn workspace @quereus/quereus lint` — clean (exit 0).
- `yarn workspace @quereus/quereus run typecheck` (`tsc --noEmit`) — clean.
- Did **not** run `test:store` — the change is planner/mutation + static-introspection only, no storage path touched.

## Known gaps / where to scrutinize (honest — tests are a floor)

- **Dangling minted key on a per-row-absent non-preserved value (FK-off only path tested).** When a non-preserved side is *statically* active (its column is in the insert list) but a *given row's* value is null, that row's non-preserved insert is presence-gated off while the preserved side still threads the minted shared key into its FK column — so that preserved row points at a key with no partner row. It reads back correctly null-extended, but with **FK enforcement on** this is a dangling reference (single-row `values (k, v, NULL)` reaches it too, not just multi-row). The clean fix is a per-row conditional key thread (`pr = case when <present> then key else null`), deferred. The *statically* absent case (a non-preserved side with no supplied columns at all) is handled correctly (inactive ⇒ no key threaded). All tests use FK off + single non-null rows. **A reviewer should decide whether to gate/diagnose the FK-on mixed-null insert or accept the documented gap.**
- **RIGHT join dynamic round-trips not directly exercised.** RIGHT is covered by the static `view_info`/`column_info` rows (`oj_right`) and the recognition is symmetric with LEFT (preserved = right side), but no property/sqllogic case drives a RIGHT-join insert/update/delete to completion. Worth a mirror of the LEFT property test.
- **n-way anchor-rooted outer shapes (anchor inner-joined to ≥1 left-joined optional member) untested dynamically.** `collectJoinSources` + the active/presence-gate machinery generalize to it, but only the 2-table LEFT join is round-trip-tested. The decomposition path already covers the *advertisement-driven* optional-member insert/delete (Family C); this ticket brought the *hand-written join view* path to parity for 2 tables — n-way hand-written outer is a generalization on the same code, not separately pinned.
- **`guard` is surfaced but unused by v1 routing.** `JoinSide.guard` carries the enclosing ON predicate for future per-row materialization; nothing consumes it yet. USING outer joins leave it undefined (no AST `Expression`), though preserved/non-preserved classification still works for USING.
- **Cross-source `set` through an outer join now rejects `no-inverse` (was `unsupported-join`).** `update rj_outer set cv = pv` is caught by `gateCrossSourceReads` because `pv` is non-preserved (null-extended ⇒ not `base`-writable), so the partner value is not recoverable from a captured base column. This is a *more precise* reject, not a behavior loss, but the reason code changed — confirm that is the desired diagnostic.
- **Minted-key determinism in tests.** The both-side insert relies on the anchor partner declaring a `coalesce(max(pk),0)+mutation_ordinal()` default (mirrors the inner-join `jparent` fixture). The property/sqllogic tests never assert the exact minted value — only that child and parent agree (the join holds) and the view reads correctly — so they are robust to the allocator's exact output.
- **Quereus columns are NOT NULL by default.** A fixture column that must hold null needs an explicit `null` (this bit the first 93.4 draft — `ojc.pr`). The fixtures now declare `null` where needed; a reviewer adding cases should remember this.

## Out of scope (unchanged, by design)

- Non-preserved-side UPDATE materialization (matched→update / null-extended→insert) — `view-write-optional-member-transitions` (the deferral target of `unsupported-outer-join-update`).
- Decomposition optional-member UPDATE (`unsupported-decomposition-update`) — also that ticket; untouched here.
- FULL outer join write-through (no preserved anchor) — rejected wholesale; surfaces report conservative.
