description: Review the shipped outer-join non-preserved-side UPDATE (the matched-update / null-extended-insert per-row materialization) — consumer 1 of the optional-member transitions set. Realized over the EXISTING capture substrate (no new ViewMutationNode/emitter), so verify the equivalence and the documented boundaries. The decomposition optional/EAV dual (consumer 2) is split out to `view-write-decomposition-optional-update`.
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/func/builtins/schema.ts, packages/quereus/test/property.spec.ts, packages/quereus/test/logic/06.3.4-view-info.sqllogic, packages/quereus/test/logic/06.3.5-column-info.sqllogic, packages/quereus/test/logic/93.2-view-mutation-pending.sqllogic, packages/quereus/test/logic/93.4-view-mutation.sqllogic, docs/view-updateability.md
----

## What shipped

An `update` of a **non-preserved** (outer-join null-extended) column through a LEFT-join view now propagates per row instead of rejecting `unsupported-outer-join-update`:

- **Matched row** (the non-preserved side had a join partner) → an ordinary per-side base UPDATE on the non-preserved table.
- **Null-extended row** (no partner) with a non-null preserved-side join key → an INSERT that materializes the missing non-preserved row, carrying the EC join key (so the preserved row joins it) + the assigned value(s) + base defaults.
- **Null-extended row with a null join key** → a no-op (no key to seed a joinable row — documented boundary).

This is `view_info`/`column_info`-visible: a non-preserved base column now reports `is_updatable = 'YES'` (it was `'NO'`), because a LEFT join's preserved side pins each row's identity. A FULL outer join (no preserved anchor) still reports `'NO'` and rejects.

### Example (the property-test core, `rj_outer`/`npv`)

```sql
-- view: select c.cc as cc, c.cv as cv, p.pv as pv
--       from np_child c left join np_parent p on p.pp = c.pr
update npv set pv = 222 where cc = 2;   -- cc=2: child pr=99, no parent 99 (null-extended)
--   matched UPDATE: no-op (no parent matches the captured-null PK)
--   null-extended INSERT: insert into np_parent (pp, pv)
--                           select <c.pr=99>, <222> from __vmupd_keys
--                           where <np_parent PK captured null> and <join key not null>
--   ⇒ np_parent(99, 222); the child now joins it; PutGet reads pv=222.
```

## Design — realized over the EXISTING substrate (diverges from the ticket's "Target architecture")

The ticket proposed a NEW `ViewMutationNode` conditional-materialization side structure + new emitter logic. **That was not needed.** The existing up-front `__vmupd_keys` capture (materialized pre-mutation, then base ops drained — `runtime/emit/view-mutation.ts`, unchanged) already supplies the per-row pre-mutation partition. So:

- The capture already projects the non-preserved side's PK (it is the side the matched UPDATE targets, so `capturedSideIndices` includes it). For a null-extended row the LEFT join null-extends that PK to **NULL** — the partition discriminator, for free.
- The **matched UPDATE** is the existing per-side routing path: its identifying `exists(... k.k<np>_j = <pk>)` naturally excludes null-extended rows (a NULL captured key never equals a real PK). Its SET value reads the captured value back via the existing `capturedValueSubquery` (the same correlated-read mechanism cross-source `set a.x = b.y` already uses).
- The **null-extended INSERT** is a pure AST `BaseOp`: `insert into <np> (<cols>) select … from __vmupd_keys where <np PK> is null and <joinKey> is not null`, resolved by the builder's existing `cteNodes` injection (`withKeyCapture`). No builder change.
- The EC join key + the assigned value(s) ride the existing `sourceValues` capture channel (generalized to a `registerCapturedExpr(key, expr)` helper that `registerCrossSource` now delegates to).

Net code surface: **`multi-source.ts` `decomposeUpdate` + 3 new helpers** (`buildNullExtendedInsert`, `outerJoinInsertKey`, `assertNullExtendedInsertCovered`), plus the `column_info` static-surface flip in `schema.ts`. `view-mutation-node.ts`, `view-mutation.ts`, and `view-mutation-builder.ts` are **untouched**.

**Reviewer: the key thing to validate is that this AST-over-existing-substrate realization is behaviorally equivalent to the ticket's intended semantics**, since it took a different (DRYer) path than the spec drew.

## Tests / validation

- `yarn workspace @quereus/quereus test` — **4628 passing, 9 pending, green.**
- `yarn workspace @quereus/quereus lint` — clean.
- New: `property.spec.ts` → 'outer (left) join: non-preserved-side update materializes matched + null-extended rows' (matched, null-extended-with-dangling-key, null-key no-op, GetPut idempotence, `null-extended-create-conflict`).
- Flipped negatives → accepts: `property.spec.ts` (reject-do-not-widen smoke + dedicated outer-join `column_info` `pv='YES'`), `06.3.4`/`06.3.5` (oj_left `bv` now `'YES'` + the `update ... set bv` blocks now succeed), `93.4` (`update ojv set pv` matched, downstream `ojp` image), `93.2-pending` (the `voj` LEFT non-preserved-update rejection replaced by a FULL-join `voj_full` reject — the remaining deferred shape).

## Known gaps / risks the reviewer should weigh (tests are a floor)

1. **Scalar-subquery multiplicity (untested).** The matched UPDATE reads the captured value via `(select <val> from __vmupd_keys k where k.k<np>_0 = <pk>)`. If two affected view rows share the same non-preserved PK (two preserved rows joining one non-preserved row) with *different* assigned values, this is a multi-row scalar subquery → runtime error. Same theoretical limit as the pre-existing cross-source path; not exercised here.
2. **Duplicate null-extended inserts (untested).** Two null-extended rows whose preserved-side join keys collide would both try to insert the same non-preserved PK → a PK conflict (atomic rollback). No dedup. Consider whether to dedup the partition or document.
3. **Null join-key = silent no-op.** A null-extended row with a null preserved join key gets neither updated nor materialized (no key to make it joinable). Tested + documented, but it is a *silent* no-op — consider whether a diagnostic is warranted.
4. **`null-extended-create-conflict` is plan-time + data-independent.** It fires whenever the non-preserved side has an uncovered NOT NULL / no-default column, even if no null-extended row exists at runtime (conservative, matches the insert-path `assertNoMissingNotNull` precedent).
5. **Value capture timing.** The assigned value is captured once, pre-mutation, over the join body; a nondeterministic value (`random()`) is evaluated once and shared by both branches (intended, but note it).
6. **No fast-check property over random joined/unmatched data** for the non-preserved update — the new test is example-based. A property fanning random matched/null-extended rows through a `set pv` and asserting PutGet would harden the floor.
7. **RETURNING through a non-preserved-side update** is not exercised. The matched + null-extended split spans two base ops; the existing multi-source UPDATE RETURNING re-query reads the post-mutation join by captured identity — likely works for the matched rows, but a materialized null-extended row's RETURNING image is unverified.

## Out of scope (still rejecting — verify they stay red)

- Decomposition optional-member / EAV / all-null→delete UPDATE → `view-write-decomposition-optional-update` (consumer 2).
- FULL outer non-preserved update (`unsupported-outer-join-update`), RIGHT joins (excluded), non-preserved-only insert (`null-extended-create-conflict`), composite shared keys, aggregate/window propagation, multi-source-insert RETURNING.
