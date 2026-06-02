description: Multi-source (two-table inner-join) DELETE ... RETURNING of a body-COMPUTED view column throws `No row context found for column <name>` at runtime. Fix by building the DELETE RETURNING projection in base terms over the planned `joinNode` (mirroring the correct UPDATE-RETURNING path), recomputing computed columns from base columns instead of referencing the optimizer-eliminated intermediate output attribute id of the planned body `root`. Consolidate the duplicated DELETE-side builder helpers onto the shared base-term projection machinery in `multi-source.ts`.
files: packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, packages/quereus/test/property.spec.ts
effort: medium

## Confirmed repro (fix stage)

The repro in the source ticket throws exactly as described — verified live against
`packages/quereus/src/index.ts`:

```sql
create table dr_p (pid integer primary key, label text);
create table dr_c (cid integer primary key, pref integer, note text,
    foreign key (pref) references dr_p(pid));
insert into dr_p values (10, 'P10'), (20, 'P20');
insert into dr_c values (1, 10, 'a'), (2, 20, 'b');
create view dr_jv as
    select c.cid as cid, c.note as note, p.label as label, c.note || '!' as banner
    from dr_c c join dr_p p on p.pid = c.pref;

delete from dr_jv where cid = 1 returning cid, banner;
-- QuereusError: No row context found for column banner. The column reference must be
-- evaluated within the context of its source relation.
--   at resolveAttribute (runtime/context-helpers.ts:152)
--   at emit/column-reference.ts ... collectRows (runtime/emit/view-mutation.ts:124)
```

Bare base-lineage RETURNING (`returning cid, note, label`) works; only a body-computed
column (or `returning *` over a join view with one) fails. Multi-source UPDATE RETURNING
of a computed column is **already green** (e.g. `93.4` section (e), the `rjoin3` view's
`dbl = c.qty * 2` at line ~1285) — that path recomputes from base terms, which is the
template for this fix.

## Root cause (validated)

`buildViewOutputScope` (`view-mutation-builder.ts:295`) registers each view-output column
as a `ColumnReferenceNode` pointing at `analysis.root.getAttributes()[i]` — the planned
body's **output** attribute id. `buildDeleteReturning` (`:268`) stacks
`ProjectNode(FilterNode(root))` over those ids.

- A pass-through projection (`c.cid as cid`) forwards the leaf base attribute id, which
  still exists after the optimizer merges/prunes `root`'s Project → resolves.
- A computed projection (`c.note || '!' as banner`) mints a **fresh intermediate**
  attribute id at `root`'s ProjectNode. Project-merge collapses it into an inline
  expression, so that id ceases to exist as a context attribute. The outer DELETE
  RETURNING reference to it dangles → `No row context found`.

Referencing a stacked Project's computed output attr id *by id* is the general hazard.
The fix recomputes in base terms instead, so nothing references a fragile intermediate id.

## Fix design (validated against the emitter + the UPDATE path)

Mirror `buildMultiSourceUpdateReturning` (`multi-source.ts:935`): build the DELETE
RETURNING projection in **base terms over the planned `analysis.joinNode`**, resolved
through `analysis.joinScope`, recomputing each view-spelled column from
`analysis.viewColToBaseRef`. The only DELETE/UPDATE difference is the filter + timing:

- **Filter**: the identifying predicate (user WHERE → base ∧ body WHERE) over the raw
  `joinNode`, built exactly like the key capture
  (`buildIdentifyingPredicate(ctx, analysis, stmt.where, view)` → `buildExpression` over
  `joinScope` → `FilterNode(joinScope, joinNode, predicate)`). This is the `pre` OLD image
  — the rows about to vanish.
- **Timing**: `returningTiming: 'pre'`. Confirmed at `runtime/emit/view-mutation.ts:180`:
  the `'pre'` branch collects the returning rows **before** `drainBaseOps`, reading the
  live base tables through the join — so the OLD image resolves naturally.

The existing private `buildReturningProjection` (`multi-source.ts:991`) already lowers
`returning *` / bare-rename / computed columns to base terms **and** enforces the
encapsulation guard via `guardTopLevelScope` on each explicit column (a RETURNING ref to a
hidden base column — not a view output — is rejected). The base-term DELETE path inherits
that guard for free, preserving parity with the current scope-based path.

### Consolidation

The UPDATE and DELETE RETURNING projection lowering is identical apart from the
`filtered` input relation. Extract a shared helper and route both through it:

```
// multi-source.ts
function buildMultiSourceReturningProjection(
    ctx, view, analysis, filtered: RelationalPlanNode, returningCols,
): RelationalPlanNode {
    const projections = buildReturningProjection(ctx, view, analysis, returningCols)
        .map(rc => {
            const col = rc as AST.ResultColumnExpr;
            return { node: buildExpression({ ...ctx, scope: analysis.joinScope }, col.expr), alias: col.alias };
        });
    return new ProjectNode(analysis.joinScope, filtered, projections, undefined, undefined, false);
}

// buildMultiSourceUpdateReturning: replace its inline projection block with a call,
//   passing the EXISTS-over-capture-filtered join (post-mutation).

export function buildMultiSourceDeleteReturning(ctx, view, stmt: AST.DeleteStmt, analysis): RelationalPlanNode {
    const idPredicateAst = buildIdentifyingPredicate(ctx, analysis, stmt.where, view);
    const predicate = idPredicateAst
        ? buildExpression({ ...ctx, scope: analysis.joinScope }, idPredicateAst)
        : undefined;
    const filtered = predicate
        ? new FilterNode(analysis.joinScope, analysis.joinNode, predicate)
        : analysis.joinNode;
    return buildMultiSourceReturningProjection(ctx, view, analysis, stmt.returning!, filtered);
}
```

(`buildReturningProjection`, `buildIdentifyingPredicate`, `substituteViewColumns`,
`guardTopLevelScope` are all private to `multi-source.ts` — same file, no new exports
beyond `buildMultiSourceDeleteReturning`.)

In `view-mutation-builder.ts`, the DELETE branch of `buildMultiSourceReturning` (`:252`)
becomes:

```
const node = buildMultiSourceDeleteReturning(ctx, view, req.stmt, analysis);
return { returning: node, returningTiming: 'pre' };
```

Then **delete** the now-dead builder helpers `buildDeleteReturning` (`:268`),
`buildViewOutputScope` (`:295`), and `buildViewReturningProjections` (`:317`), and add
`buildMultiSourceDeleteReturning` to the `../mutation/multi-source.js` import. Verify no
other builder helper still references the removed functions; `RegisteredScope`,
`ColumnReferenceNode`, `ProjectNode`, `Projection`, `FilterNode` imports all remain used by
the insert/decomposition paths and `buildPresenceGate`, so leave them.

## Acceptance

- `delete from dr_jv where cid = 1 returning cid, banner` → `[{"cid":1,"banner":"a!"}]`.
- `returning *` over a join view with a computed column expands and computes it.
- A computed RETURNING expression over a base-routed column
  (`returning note || '+' as notex`) stays green.
- A RETURNING ref to a hidden base column (e.g. `pref`, not a `dr_jv` output) is still
  rejected with a `cannot write through view` diagnostic (encapsulation-guard parity).
- `93.4-view-mutation.sqllogic` section (c): replace the placeholder note at lines
  ~1204-1206 (near the `dr_jv` comment) with real passing cases.
- `yarn workspace @quereus/quereus test` + `yarn workspace @quereus/quereus run lint` clean.
- Extend the `property.spec.ts` "View Round-Trip Laws" → "multi-source inner join" family
  (the `jv` view at line ~2669) so the delete-returning path generates a body-computed
  output column and asserts it is recomputed in the returned rows — guarding this going
  forward.

## TODO

- [ ] In `multi-source.ts`: extract `buildMultiSourceReturningProjection(ctx, view, analysis, returningCols, filtered)`; refactor `buildMultiSourceUpdateReturning` to call it (passing the EXISTS-filtered join).
- [ ] In `multi-source.ts`: add and export `buildMultiSourceDeleteReturning(ctx, view, stmt, analysis)` filtering `joinNode` by `buildIdentifyingPredicate` (the `pre` OLD image).
- [ ] In `view-mutation-builder.ts`: route the DELETE branch of `buildMultiSourceReturning` through `buildMultiSourceDeleteReturning`; delete `buildDeleteReturning`, `buildViewOutputScope`, `buildViewReturningProjections`; add the new import; confirm no dangling imports.
- [ ] `93.4-view-mutation.sqllogic` (c): add passing cases — `delete from dr_jv ... returning cid, banner`, `returning *`, `returning note || '+' as notex`, plus a hidden-base-column rejection (`returning pref` → error). Use the source ticket's `dr_p`/`dr_c`/`dr_jv` schema (or reuse the existing `rp`/`rc`/`rjoin` shape with a computed column added).
- [ ] Extend `property.spec.ts` multi-source family to generate a computed view column on the delete-returning path and assert recomputation.
- [ ] Run `yarn workspace @quereus/quereus test` and `... run lint`; both clean. (Streaming pattern per AGENTS.md if long.)
