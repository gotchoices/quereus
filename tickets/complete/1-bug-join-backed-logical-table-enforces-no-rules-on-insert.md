description: Inserting into an application-schema table stored as two joined tables ignored every rule the table declares, while updates enforced them. Inserts now enforce the same rules on the right underlying table, and a rule over one table's column no longer fires on a same-named column of the other table.
architecture: docs/lens-constraints.md#which-member-op-a-constraint-rides
files: packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/planner/mutation/lens-enforcement.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/nodes/view-mutation-node.ts, docs/lens-constraints.md, packages/quereus/test/lens-enforcement.spec.ts
repro: verified
----

# Join-backed logical table: rules now enforced on insert

## What was wrong

A logical table whose lens body is a join (`select c.id, c.name, c.age, c.org, k.mail as email from y.Core c join y.Contact k on c.id = k.id`) accepted, on insert, rows that broke its `check`, `unique` and `foreign key` rules, while update rejected them. When both basis tables had a same-named column, a check over one table's column also fired on the other's. With a `left join` body, a check over the optional side (`check (email is not null)`) was skipped for any row that wrote no row to that side.

## What changed (`ticket(implement): bug-join-backed-logical-table-enforces-no-rules-on-insert`)

- The join-insert dispatch in `buildViewMutation` passes the lens row-local checks, child-side FKs and commit-time set-level keys to `buildMultiSourceInsert`, which gates each onto the side that owns its columns via `constraintsForOp` (now taking a `TableSchema`). Rules that ride no side are traced with `log`.
- `rejectLensSetLevelConflictResolution` runs once, above both insert envelopes (the copy inside `buildDecompositionInsert` was removed).
- `makeOwningRelationResolver` attributes join-body columns to the basis table named by the output column's qualifier, or the single FROM source carrying a bare name (`joinBodyColumnOwners`).
- For an outer-joined side, `buildAbsentSideRowChecks` adds an envelope check `<side present> or <check with NEW.* as NULL>` so rows that write no row to that side are still checked once. `MsInsertAnalysis.absentSides` lists the sides the statement never writes.
- The decomposition path's envelope-check compile was extracted into `compileEnvelopeRowChecks` / `checkFailedMessage` and shared.
- Docs: `docs/lens-constraints.md` (seam, threading site, attribution, limitations).
- Tests: three `it`s in `test/lens-enforcement.spec.ts` › "join-backed logical table (multi-source body)": the main repro, the same-named-column misattribution repro, and the left-join absent-side repro.

## Review findings

Read the implement diff first, then the handoff. Ran `yarn workspace @quereus/quereus lint` (exit 0) and `yarn workspace @quereus/quereus test` (11192 passing, 26 pending) after the review edits. Probed behaviour with a temporary spec (deleted).

**Correctness, checked and holding**
- Gate attribution: `columnProvenance` index and `compiledBody.columns` index line up because a compiled body projects exactly the logical columns in order (`lens-compiler.ts` § `deriveRelationBacking` relies on the same fact), so `joinBodyColumnOwners` cannot misalign on `*`.
- Envelope absent-side check: presence indices come from `presenceGateIndices` (supplied-column indices), and the check compiles over a scope of exactly those supplied columns, so the presence predicate resolves. A NULL check result passes (the runtime treats NULL as pass), so `NULL like '%@%'` correctly does not reject. A side forced active by an existence flag has no presence gate and gets no envelope check, which is correct because it always inserts.
- Probed: a SELECT-source insert enforces the routed check; an inner-join insert that omits the Contact column still writes a Contact row and the check sees NULL; a left-join present-side check and a preserved-side check both fire.
- Moving the conflict-clause guard above the set-op dispatches is harmless: set-op bodies have no lens slot, so the guard returns early.

**Major: filed**
- `insert or ignore` / `insert or fail` through a join view is not all-or-nothing per logical row. A side the clause rejects is skipped or stopped alone, and the sides already inserted keep their half of the row (an orphaned Core row the inner-join view hides; under a left join the row stays with `email` NULL and the supplied value is silently dropped). Reproduced with a **plain** join view and a basis CHECK, so it predates this change and belongs to the join insert fan-out, but this change makes lens rules reach it. Filed `backlog/bug-join-view-insert-or-ignore-keeps-half-a-row` (class-level: the conflict action must apply to the logical row) and added a bullet under docs/lens-constraints.md § Current limitations.

**Minor: fixed inline**
- The join-insert dispatch comment in `buildViewMutation` still said "inner-join" and claimed every side insert runs. Reworded to cover outer joins and point at `buildAbsentSideRowChecks`.
- docs/lens-constraints.md cited "a `using` key" as an example of a bare name two sources carry. In Quereus a bare `using` column is deliberately ambiguous (`test/logic/11.1-join-using.sqllogic`), so such a body cannot be read at all. Dropped the example; the rule it illustrates is unchanged. The handoff's `left join … using (id)` gap is therefore unreachable.

**Tripwires recorded**
- Self-join lens bodies: both aliases attribute to one relation, so a rule over one alias's column rides both sides. Pre-existing for update, and insert through a self-join is contrived. Parked as a `NOTE:` on `joinBodyColumnOwners` (`lens-enforcement.ts`).
- Subquery in an absent-side check evaluated at row time vs commit time: the implementer's `NOTE:` on `buildAbsentSideRowChecks` stands.

**Size and hygiene**
- `view-mutation-builder.ts` is 1,860 lines and `lens-enforcement.ts` 1,476 (`wc -l`, 2026-11-16). Both were appended as arms to `backlog/debt-oversized-source-files` rather than filed fresh.
- DRY: `joinBodyBasisSources` re-walks a body FROM much like the private `collectOverrideSources` in `lens-compiler.ts`. Left as is: it is 15 lines, the two differ on bare-name handling, and sharing would mean exporting compiler internals into the planner. Noted, not filed.

**Tests**
- All three added tests are bug reproductions at the SQL layer, one per behaviour. None restates the implementation. Kept all three, added none: the findings above are either filed or comment and docs fixes.

**Observed, out of scope, not investigated**
- A lens whose body uses a bare `using` column deploys (`apply schema` succeeds), but every read of the logical table then fails with "ambiguous column name". Deploy does not appear to plan the body's projection. Not investigated beyond the probe; no site named, so not filed.

**Not affected / empty categories**
- Resource cleanup and performance: no new runtime state. The envelope check reuses the existing per-row check slot, and the attribution walk runs once per constraint collection over the catalog only.
- Type safety: the two `as AST.LiteralExpr` / `as AST.BinaryExpr` casts on synthesized AST nodes follow the existing pattern in this file. No `any`.
- Cross-side rules (one rule over columns of both sides) stay unenforced on insert and update, as documented under § Current limitations. That was the ticket's intent, so it was not re-filed.
