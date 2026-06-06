description: Two residuals of the per-op resolvability gate for lens-synthesized constraints (`view-write-decomp-set-level-check-overbroad-member-update`). (1) The `writeRowColumns` AST walker that drives the gate relies on the invariant "the `enforced-row-local` obligation class is subquery-free", but the prover does NOT enforce that — `classifyCheckConstraint` classifies *any* scalar CHECK over reconstructible columns as `enforced-row-local`, including one containing a subquery (Quereus supports + auto-defers subquery-bearing CHECKs). A logical row-local CHECK with a *correlated* subquery that references a write-row column only **bare, inside the subquery** would be under-collected by the walker (it ignores bare refs inside a subquery, assuming they resolve against the subquery FROM), so on a decomposition that CHECK could be threaded onto a member op that cannot resolve the column — re-opening the original `NEW.<col> isn't a column` build-failure class for that (exotic, currently untested) shape. (2) The documented cross-member CHECK/FK *deferral* residual has no behavioral test: no test constructs a decomposition whose logical CHECK/FK spans two members and asserts the violation is NOT caught (deferral), while a single-member-resolvable CHECK/FK still ABORTs.
prereq:
files:
  - packages/quereus/src/planner/building/view-mutation-builder.ts   # writeRowColumns / collectWriteRowColumns / collectQueryWriteRowColumns / constraintsForOp (~L865-1024) — the walker + gate
  - packages/quereus/src/planner/mutation/lens-enforcement.ts         # collectLensRowLocalConstraints (~L96) — candidate site for approach-B referenced-basis-column metadata
  - packages/quereus/src/schema/lens-prover.ts                        # classifyCheckConstraint (~L1062) — confirms enforced-row-local does NOT exclude subqueries
  - packages/quereus/src/planner/building/constraint-builder.ts       # auto-defer-on-subquery (~L164) — confirms subquery-bearing CHECKs are supported
  - packages/quereus/test/lens-put-fanout.spec.ts                     # surrogate-keyed optional-member fixture (~L1454) — candidate base for the new cross-member CHECK/FK behavioral test
----

# Harden the lens decomposition constraint-gate against subquery-bearing row-local CHECKs, and add cross-member deferral coverage

The fix `view-write-decomp-set-level-check-overbroad-member-update` added a per-op resolvability gate
(`constraintsForOp` + the `writeRowColumns` AST walker) at the single `extraConstraints` threading site
in `buildViewMutation`. It is sound and well-tested for every reachable common path (single-source
spine; the synthesized set-level / child-FK / parent-FK classes, which are exclusively `NEW.*` / `OLD.*`
qualified; and subquery-free row-local CHECKs). Review surfaced two **residual** concerns at the edges
of that gate. Neither is reachable by any current test, and the first fails **loud** (a build-time
`QuereusError`, not silent data corruption) — hence backlog, not a blocking fix.

## Residual 1 — the walker's bare-ref-in-subquery assumption is not prover-guaranteed

`writeRowColumns` collects a constraint's write-row column refs as: (a) any `NEW.*` / `OLD.*`-qualified
column anywhere (including inside a subquery), plus (b) any **bare** (unqualified) column **not** inside
a subquery. Rule (b) deliberately *ignores* bare refs inside a subquery, on the stated assumption that
they resolve against the subquery's own FROM — and that the `enforced-row-local` class (the only class
with bare write-row refs) is **subquery-free** "by the prover's definition".

That invariant is **not** actually enforced by the prover. `classifyCheckConstraint`
(`lens-prover.ts` ~L1062) classifies *every* scalar CHECK over reconstructible (non-computed) columns as
`enforced-row-local` — it only errors on a computed-lineage column, never on a subquery. And Quereus
**supports** subqueries in CHECK constraints (`constraint-builder.ts` ~L164 auto-defers a CHECK whose
expr contains a subquery). So a logical row-local CHECK such as

```sql
check (exists (select 1 from peer where peer.k = somecol))   -- somecol: a write-row column, bare, only inside the subquery
```

is classified `enforced-row-local`, enters `extraConstraints` via `collectLensRowLocalConstraints`, and
on a **decomposition** is gated by the walker. The walker, descending into the subquery with
`insideSubquery = true`, sees bare `somecol` and ignores it (rule b) — **under-collecting** the real
write-row dependency. The constraint's computed write-row set is then too small, so the gate keeps it on
a member op whose target lacks `somecol`; `buildConstraintChecks` cannot resolve the correlated bare ref
there and throws `somecol isn't a column` at plan-build time — the exact original-bug class, for this
(exotic, untested) shape.

Note the failure is **loud** and only on previously-crashing-anyway configs: the walker's `NEW.*`/`OLD.*`
collection exactly mirrors what `buildConstraintChecks` must resolve, so the gate never silently drops a
constraint a base op was previously enforcing — the only divergence is this under-collection, which
re-surfaces a build error, never a silent non-enforcement.

### Suggested fix — approach B for the row-local class (the implementer's named fallback)

Don't try to teach the AST walker which bare-in-subquery names are correlated (that needs the subquery's
resolved FROM columns — expensive and duplicative of the resolver). Instead carry the answer as
**metadata**: `collectLensRowLocalConstraints` already holds the logical→basis `map` and the source CHECK
expr; it can enumerate the CHECK's referenced logical columns (the prover's `collectColumnRefNames`
already does this) and attach their mapped **basis** column names to the synthesized
`RowConstraintSchema` (e.g. an optional `referencedWriteRowColumns?: readonly string[]`, or via `tags`).
`constraintsForOp` then prefers that metadata over the AST walk when present. The synthesized set-level /
FK classes can keep the walk (their `NEW.*`/`OLD.*` qualifiers are unambiguous) or be migrated for
uniformity. This removes the dependence on the un-guaranteed subquery-free invariant.

(An alternative, cheaper guard: if a row-local CHECK contains a subquery, treat the walk as untrusted and
conservatively decline to gate it — but that just re-exposes the original crash for the cross-member
subquery case, so metadata is the real fix.)

## Residual 2 — the cross-member deferral residual has no behavioral test

The shipped behavior (documented in `docs/lens.md` § Enforcement by constraint class and
`docs/view-updateability.md`): a logical row-local CHECK / child-FK whose write-row columns span **more
than one** member of a decomposition resolves on no single member op and is **deferred** (silently not
enforced, matching the decomposition INSERT path); a **single-member-resolvable** CHECK / FK still rides
its member and fires. Only the set-level key-routing arm is pinned by a test (`a docKey re-key routes the
commit-time uniqueness CHECK onto the Doc_core anchor op`). The CHECK/FK deferral-vs-enforcement split is
verified only by reasoning + a debug `log`.

Add a behavioral test alongside the surrogate-keyed optional-member fixture (or a sibling fixture):
- A decomposition whose logical table declares `check (title <> note)` — `title` on the `Doc_core`
  member, `note` on the `Doc_meta` member (cross-member). An `update x.Doc` that violates it across
  members currently **passes** (deferral) — assert that, documenting the residual; assert the debug drop
  `log` fires if a log-capture harness is available.
- A **single-member** logical `check (length(title) < N)` (Doc_core only) — an UPDATE violating it must
  still **ABORT** (rides the Doc_core op). Pins that the gate enforces, not just defers.
- Optionally the child-FK dual once a decomposition-with-logical-FK fixture exists.

This asserts a deliberate non-enforcement (a weaker contract), so it is belt-and-suspenders — but it pins
the deferral boundary so a future change to the gate cannot silently flip it.
