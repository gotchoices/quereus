description: Multi-source (two-table inner-join) DELETE ... RETURNING of a body-COMPUTED view column throws an internal `No row context found for column <name>` error at runtime. A regression introduced by `view-mutation-retire-ast-roundtrip`: the new plan-node DELETE-RETURNING path (`buildDeleteReturning` / `buildViewOutputScope`) references the planned body `root`'s OUTPUT attribute ids, which the optimizer's project-merge eliminates for computed columns. Pass-through base columns are unaffected. The pre-refactor `select <returning> from <view>` re-query handled computed columns correctly.
files: packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic

## Symptom / repro

A two-table inner-join view with a **body-computed** output column, deleted with a
RETURNING that names (or `*`-expands to) that computed column, throws:

```
QuereusError: No row context found for column banner. The column reference must be
evaluated within the context of its source relation.
  at resolveAttribute (runtime/context-helpers.ts)
  at emit/column-reference.ts
  ... collectRows (runtime/emit/view-mutation.ts)
```

Minimal repro (a passing version is the acceptance test):

```sql
create table dr_p (pid integer primary key, label text);
create table dr_c (cid integer primary key, pref integer, note text,
    foreign key (pref) references dr_p(pid));
insert into dr_p values (10, 'P10'), (20, 'P20');
insert into dr_c values (1, 10, 'a'), (2, 20, 'b');
create view dr_jv as
    select c.cid as cid, c.note as note, p.label as label, c.note || '!' as banner
    from dr_c c join dr_p p on p.pid = c.pref;

delete from dr_jv where cid = 1 returning cid, banner;   -- THROWS (banner is computed)
-- expected: [{"cid":1,"banner":"a!"}]
```

Bare base-lineage RETURNING columns (`returning cid, note, label`) work; only a
body-computed column (or a `returning *` over a view that has one) fails. Multi-source
**UPDATE** RETURNING is **not** affected — it recomputes columns in base terms.

## Root cause

`buildViewOutputScope` (in `view-mutation-builder.ts`) registers each view-output
column as a `ColumnReferenceNode` pointing at `analysis.root.getAttributes()[i]` — the
planned body's **output** attribute id. `buildDeleteReturning` then stacks
`ProjectNode(FilterNode(root))` and projects those references.

- An **identity/pass-through** projection (`c.cid as cid`) forwards the *leaf* base
  attribute id, so the referenced output attr id still exists at the base
  `TableReferenceNode` after the optimizer merges/prunes `root`'s Project — it resolves.
- A **computed** projection (`c.note || '!' as banner`) mints a **fresh** intermediate
  attribute id at `root`'s `ProjectNode`. When the optimizer merges the outer
  DELETE-RETURNING Project into `root`'s Project (project-merge / projection-pruning),
  that intermediate id is collapsed into an inline expression and ceases to exist as a
  context attribute. The outer reference to it dangles → `No row context found`.

So the failure is the general hazard of referencing a stacked Project's computed output
attribute id by id. The retired path side-stepped it by re-querying `from <view>` (the
view body re-expands and recomputes); the new path must recompute too.

## Fix direction

Mirror the **UPDATE**-RETURNING path, which is correct: build the DELETE RETURNING
projection in **base terms over the planned `joinNode`** (not by referencing `root`'s
computed output attrs), recomputing each view-spelled column from
`analysis.viewColToBaseRef` via `substituteViewColumns` + `buildExpression` over
`analysis.joinScope` — exactly `buildReturningProjection` in `multi-source.ts`, which
already handles bare-rename, computed, and `returning *`. The DELETE difference is only
the **filter + timing**: project over `σ_{userWhere ∧ bodyWhere}(joinNode)` captured
`pre` (the OLD image, before the base delete fires) rather than the post-mutation
EXISTS-over-capture restriction the UPDATE path uses.

Concretely:
- Build the identifying filter the same way the key capture does
  (`buildIdentifyingPredicate(ctx, analysis, stmt.where, view)` → `buildExpression` over
  `joinScope` → `FilterNode(joinScope, joinNode, predicate)`), so the `pre` image is the
  user-predicate-restricted joined rows (matching the rows about to vanish).
- Project `buildReturningProjection(ctx, view, analysis, returningCols)` lowered to
  `Projection`s over `joinScope` (same `.map(buildExpression over joinScope)` shape as
  `buildMultiSourceUpdateReturning`), `preserveInputColumns=false`, `returningTiming: 'pre'`.
- This lets the user WHERE / RETURNING resolve in base terms (no `buildViewOutputScope`
  needed); a computed column recomputes from base columns directly, so nothing references
  a fragile intermediate attr id.

This also **consolidates** the now-duplicated DELETE-side helpers (`buildDeleteReturning`,
`buildViewReturningProjections`, `buildViewOutputScope` in the builder) onto the same
base-term projection machinery the UPDATE side already owns in `multi-source.ts` — prefer
a shared `buildMultiSourceReturningProjections(over: joinNode-filter, timing)` over the
two parallel implementations.

NB: keep the **encapsulation guard** the current scope relies on — a RETURNING ref to a
*hidden base column* (not a view output) must still be rejected (`guardTopLevelScope` /
`substituteViewColumns` already enforce this in the base-term path; verify parity).

## Acceptance

- The repro above returns `[{"cid":1,"banner":"a!"}]`; `returning *` over a join view
  with a computed column expands and computes it.
- A computed RETURNING **expression** referencing a base-routed column
  (`returning note || '+' as notex`) also works (it does today — keep it green).
- Re-enable the placeholder note in `93.4-view-mutation.sqllogic` (section `(c)`,
  near the `dr_jv` comment) as a real passing case.
- `yarn workspace @quereus/quereus test` + `run lint` clean; ideally extend the
  `property.spec.ts` View Round-Trip Laws multi-source family to generate a computed
  output column on the delete-returning path so the harness guards this going forward.
