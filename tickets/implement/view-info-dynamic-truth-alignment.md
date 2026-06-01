description: Align `view_info()` updateability columns with dynamic-mutation truth for two static-surface divergences — `default_for` tag-defaults (under-reports `is_insertable_into`) and outer-join `null-extended` bodies (over-reports `is_updatable` / `effective_targets`).
files: packages/quereus/src/func/builtins/schema.ts, packages/quereus/src/planner/mutation/mutation-tags.ts, packages/quereus/src/planner/mutation/single-source.ts, packages/quereus/src/planner/analysis/update-lineage.ts, packages/quereus/src/planner/nodes/reference.ts, packages/quereus/test/logic/06.3.4-view-info.sqllogic, docs/view-updateability.md
----

# view_info() ↔ dynamic-mutation truth alignment

`view_info()` (in `func/builtins/schema.ts`, `deriveViewInfo`) is a **static**
projection over the planned view body's backward `updateLineage` /
`attributeDefaults`. The review pass found two places where the static reading
diverges from what the dynamic `propagate()` substrate actually accepts. Fix
both, with sqllogic coverage that cross-checks the surface against a real
mutation through the view.

Re-read the landed surface and the substrate before editing:
- `deriveViewInfo` / `baseSiteOf` / `viewInfoFunc` — `func/builtins/schema.ts:626-842`.
- `readDefaultFor` (returns a `Map<lowercaseCol, exprText>`) — `mutation-tags.ts:123-129`.
- `resolveDefaultForColumn` (the rewrite's view-/base-column resolution the fix mirrors) — `single-source.ts:669-680`.
- `deriveJoinUpdateLineage` (wraps the non-preserved side `null-extended` for left/right/full; inner/cross never null-extend) — `update-lineage.ts:221-271`.
- `propagateMultiSource` → `collectJoinSources` **rejects every non-inner join** (`fc.joinType !== 'inner'`) — `multi-source.ts:478-483`. This is the load-bearing fact for Divergence 2: an outer-join view supports *no* mutation today, on either side.

## Divergence 1 — `default_for` tag-defaults under-report `is_insertable_into`

`AttributeDefault.kind` has three members but only `constant-fd` (Filter) and
`base-default` (TableReference, `reference.ts:229`) are ever emitted onto
`PhysicalProperties.attributeDefaults`. `tag-default` is declared
(`plan-node.ts:270-273`) but never produced: `quereus.update.default_for.<col>`
is consumed only in the rewrite (`rewriteViewInsert` → `single-source.ts:721`),
never threaded onto the physical surface. `deriveViewInfo` plans the body
standalone via `_buildPlan([view.selectAst])` **without** the view's tags, so a
view whose insertability depends on a `default_for` tag covering a not-null,
no-declared-default, projected-away base column reports
`is_insertable_into = 'NO'` even though an insert through the view *succeeds*
(the tag supplies the omitted value). Safe direction (NO-when-YES), but wrong.

**Resolution — option (c), the view-level minimal fix.** Fold view-level
`default_for` tags into `deriveViewInfo`'s `defaultable` map directly. Plan-node
threading of `tag-default` (option b) requires injecting the view's tags at plan
time and is out of scope here — it belongs with the parked per-column surface
(`tickets/backlog/view-column-updateability-surface.md`); leave the unused
`tag-default` union member in place for that future work. Statement-level
`default_for` is irrelevant to a per-view static surface (there is no statement),
so option (c) loses nothing for this surface.

In `deriveViewInfo`, after the existing whole-spine `defaultable` walk and before
the per-target insertable check, resolve each `readDefaultFor(view.tags)` column
to a `(tableId, baseColumn)` and add it to that table's `defaultable` set,
mirroring `resolveDefaultForColumn`:

- **base column of a reachable target** (the common case — the column is
  projected away): for each `id` in `targetIds`, search
  `tableRefsById.get(id)?.tableSchema.columns` for a name match; on hit, add the
  base column (lowercased) to `defaultable.get(id)`.
- **a visible view output column with base lineage**: find the root attribute
  whose `name` matches, take `baseSiteOf(rootLineage.get(attr.id))`, add
  `{table, baseColumn}` to `defaultable`.
- **unresolvable name** (a typo): silently skip — do NOT raise. The rewrite
  raises `tag-target-not-found`, but a read-only introspection surface must stay
  on its conservative never-throw posture (a column it cannot resolve simply
  does not contribute insertability). The per-view `try/catch` would otherwise
  collapse the whole row to all-`NO`.

`readDefaultFor` already lowercases its keys, so they compare directly against
the lowercased base-column names the existing walk uses.

## Divergence 2 — outer-join `null-extended` bodies over-report `is_updatable` / `effective_targets`

`baseSiteOf` (`schema.ts:654-658`) unwraps any number of `null-extended`
wrappers to the inner `base` site. For inner-join / plain bodies this is
harmless (they never null-extend). For an **outer-join** body the `JoinNode`
wraps the non-preserved side `null-extended`, and `propagateMultiSource` rejects
the entire outer join (`unsupported-join`) — so `view_info()` currently reports
`is_updatable = 'YES'`, lists the unwrapped base in `effective_targets`, and may
report `is_insertable_into` / `is_deletable` `'YES'`, while **every** mutation
through the view (including the preserved side) is rejected. Dangerous direction
(YES-when-NO).

Note the ticket's framing (gate only the null-extended *side*) does **not**
match today's substrate: because the preserved side is also unwritable
(`collectJoinSources` rejects the whole join), per-column strict-base gating
would still over-report the preserved side, and a `null-extended`-side column
projected away would leave no null-extended site at the root at all. The
truth-matching fix today is therefore **body-level**.

**Resolution.** In `deriveViewInfo`, detect any `null-extended` site across the
collected body nodes' `updateLineage` (not just the root output — an outer join
whose non-preserved columns are all projected away still carries `null-extended`
sites on the `JoinNode`'s own lineage, which `collectBodyNodes` includes). On
detection, return `CONSERVATIVE_VIEW_INFO` (all-`NO`, `[]`). This makes
`view_info()` agree with `propagate()` for every LEFT/RIGHT/FULL outer-join view
today, regardless of which columns the projection keeps, while leaving the
inner-join multi-source case (`ms_jv` in the sqllogic — no null-extended, reports
`is_updatable: YES`) untouched.

Add a small predicate, e.g.

```ts
function hasNullExtendedLineage(nodes: RelationalPlanNode[]): boolean {
  for (const n of nodes) {
    const l = n.physical?.updateLineage;
    if (l) for (const site of l.values()) if (site.kind === 'null-extended') return true;
  }
  return false;
}
```

and short-circuit early in `deriveViewInfo` (after `collectBodyNodes`, before the
target walk).

Future evolution (document, do not build): when outer-join write materialization
lands, relax from body-level conservative to per-side writability — the preserved
side becomes writable and only the not-yet-materialized null-extended side stays
gated. Capture this in the doc note below so the next agent knows the body-level
gate is a deliberate today-truth choice, not the end state.

## Adjacent finding (parked, not in scope)

Cross / comma / `> 2`-table join bodies are the **same** YES-when-NO class:
`propagateMultiSource` accepts only two-table inner equi-joins, but those bodies
produce strict-`base` lineage (no `null-extended`), so the null-extended gate
above does not catch them — `view_info()` still over-reports them as writable.
This needs an AST-shape check (join type / arity), a different mechanism than
the lineage read. Parked in
`tickets/backlog/view-info-non-inner-join-overreport.md`.

## Tests

Extend `test/logic/06.3.4-view-info.sqllogic` (the existing surface suite) so each
new assertion is cross-checked against a real mutation through the view.

**Divergence 1 — `default_for` rescues insertability.**

```sql
-- A not-null, no-declared-default base column, projected away, recovered by a
-- view-level default_for tag → insertable (cross-checked by a real insert).
create table dfi (id integer primary key, name text, created integer not null);
create view dfi_v as select id, name from dfi
    with tags ("quereus.update.default_for.created" = '999');
select is_insertable_into, is_updatable, is_deletable, effective_targets
    from view_info('dfi_v');
→ [{"is_insertable_into":"YES","is_updatable":"YES","is_deletable":"YES","effective_targets":"[\"dfi\"]"}]

-- The dynamic truth the surface now matches: the omitted not-null column is
-- supplied by the tag.
insert into dfi_v (id, name) values (1, 'x');
select * from dfi order by id;
→ [{"id":1,"name":"x","created":999}]

-- Negative control: same table+view shape WITHOUT the tag → not insertable
-- (isolates the tag as the sole cause of the YES above).
create view dfi_v_notag as select id, name from dfi;
select is_insertable_into from view_info('dfi_v_notag');
→ [{"is_insertable_into":"NO"}]
```

**Divergence 2 — outer-join views report conservative and agree with `propagate()`.**
Cover LEFT, RIGHT, and FULL; assert the surface is all-`NO`/`[]` and that a
mutation through the view is rejected (the `-- error:` form). One representative
shape:

```sql
create table oj_a (aid integer primary key, av text);
create table oj_b (bid integer primary key, bv text);
create view oj_left as
    select a.aid as aid, a.av as av, b.bv as bv
    from oj_a a left join oj_b b on b.bid = a.aid;
select is_insertable_into, is_updatable, is_deletable, effective_targets
    from view_info('oj_left');
→ [{"is_insertable_into":"NO","is_updatable":"NO","is_deletable":"NO","effective_targets":"[]"}]

-- Surface agrees with propagate(): a mutation through the outer-join view is rejected.
update oj_left set av = 'z' where aid = 1;
-- error: cannot write through view
```

Repeat the `view_info` assertion for a `right join` and a `full join` variant
(same all-`NO`/`[]` expectation). Keep the existing inner-join `ms_jv` case as the
positive control — it must still report `is_updatable: YES` with both targets
(it has no null-extended lineage), proving the gate is outer-join-specific.

If the `-- error:` cross-check phrasing differs from what the substrate emits,
match the harness convention already used in `93.4-view-mutation.sqllogic`
(e.g. `-- error: not a column` at line 318) — copy its exact comment style.

## Docs

Update `docs/view-updateability.md` § Information Schema Surface (≈ lines
604-629):

- `is_insertable_into` row in the column table: it already lists `default_for`
  as a recoverable default — keep, but it is now actually honored at the
  view-tag level (no wording change needed beyond confirming accuracy).
- Add an explicit **outer-join contract** sentence: a body carrying any
  `null-extended` lineage (LEFT/RIGHT/FULL join) yields the conservative
  all-`NO`/`'[]'` row, because outer-join mutation is wholly unsupported by
  `propagate()` today (both sides). State that this is a deliberate today-truth
  gate, to be relaxed to per-side writability when outer-join write
  materialization lands. The section currently enumerates only the
  wholly-unthreaded read-only shapes; make the outer-join behavior explicit.

## TODO

- [ ] Divergence 1: in `deriveViewInfo` (`func/builtins/schema.ts`), import `readDefaultFor` from `../../planner/mutation/mutation-tags.js` and fold view-level `default_for` columns into the `defaultable` map (base-column branch + view-output-column branch; silently skip unresolvable names).
- [ ] Divergence 2: add `hasNullExtendedLineage` and short-circuit `deriveViewInfo` to `CONSERVATIVE_VIEW_INFO` when any body node's `updateLineage` carries a `null-extended` site.
- [ ] Update the `baseSiteOf` doc comment to note the unwrap is now used only for `effective_targets` membership on bodies the null-extended gate already cleared (no behavioral comment drift).
- [ ] Extend `test/logic/06.3.4-view-info.sqllogic`: Divergence-1 rescue + negative control (with real insert cross-check); Divergence-2 LEFT/RIGHT/FULL conservative rows + a rejected-mutation cross-check; keep `ms_jv` inner-join positive control.
- [ ] Update `docs/view-updateability.md` § Information Schema Surface with the outer-join contract.
- [ ] `yarn workspace @quereus/quereus run build` then `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/vi.log; tail -n 60 /tmp/vi.log` — confirm `06.3.4-view-info` and `93.4-view-mutation` pass.
- [ ] Lint: `yarn workspace @quereus/quereus run lint` (single-quote globs on Windows).
