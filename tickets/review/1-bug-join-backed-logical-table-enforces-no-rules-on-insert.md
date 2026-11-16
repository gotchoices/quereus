description: Inserting into an application-schema table stored as two joined tables ignored every rule the table declares, while updates enforced them. Inserts now enforce the same rules on the right underlying table, and a rule over one table's column no longer fires on a same-named column of the other table.
architecture: docs/lens-constraints.md#which-member-op-a-constraint-rides
files: packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/planner/mutation/lens-enforcement.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/nodes/view-mutation-node.ts, docs/lens-constraints.md, packages/quereus/test/lens-enforcement.spec.ts
repro: verified
----

# Join-backed logical table: rules now enforced on insert

## What was wrong

A logical table whose lens body is a join (`select c.id, c.name, c.age, c.org, k.mail as email from y.Core c join y.Contact k on c.id = k.id`) accepted, on insert, rows that broke its `check`, `unique` and `foreign key` rules. Update rejected the same rows. Separately, when both basis tables had a column with the same name, a check over one table's column also fired on the other's (update wrongly rejected `set pname = 'bad'` for a check on `cname`).

A third defect turned up while investigating the outer-join question in the ticket: with a `left join` body, a check over the optional side (`check (email is not null)`) was skipped for any row that wrote no row to that side. It is reachable (the body deploys, the check classifies `enforced-row-local`) and is fixed here.

## What changed

- **Join insert carries the lens rules** (`view-mutation-builder.ts`). The join-insert dispatch in `buildViewMutation` collects row-local checks (routed `NEW.<basis>` form), child-side FKs and commit-time set-level keys, and passes them to `buildMultiSourceInsert` as `{ rowLocal, other }`. Each side gets the subset `constraintsForOp` admits; rules that ride no side are traced with `log`. The set-op join-leg caller passes `NO_JOIN_INSERT_LENS_RULES` (set-op bodies cannot be lens bodies).
- **`constraintsForOp` takes a `TableSchema`** instead of `Pick<BaseOp, 'table'>`; the three callers pass `op.table.tableSchema`, `op.schema`, `side.schema`.
- **Conflict-clause guard moved** above both insert dispatches. `rejectLensSetLevelConflictResolution` now runs once, before the decomposition and join insert dispatches; the copy inside `buildDecompositionInsert` was removed. `insert or replace` / `or ignore` / upsert through a join-backed table with a commit-time unique key is now refused up front, as it already was for single-source and decomposition tables.
- **Join-body column attribution** (`lens-enforcement.ts`). `makeOwningRelationResolver` gained a third branch, `joinBodyColumnOwners`: each logical column whose body output is a column reference is attributed to the basis table its qualifier names, or (unqualified) to the single FROM source that has the column. This is a catalog-only walk of the compiled body's FROM; unqualified FROM names are treated as CTEs and not resolved, like `resolveSlotBasisSource`. `relationQualify` stays false for joins, so the rewrite stays `NEW.<basis>`.
- **Outer-joined side, absent rows** (`buildAbsentSideRowChecks` / `absentSidePresence`). For a row-local check whose columns all belong to an outer-joined side, the envelope evaluates `<side present> or <check with NEW.* replaced by NULL>` (`MutationEnvelope.rowChecks`). When the side inserts, its own routed check decides the row against the stored values (basis defaults included). Otherwise the envelope checks the NULL-extended row the read returns. Each row is checked once. `MsInsertAnalysis` gained `absentSides` (outer-joined sides the statement writes no row to). FK and set-level rules need no such check, because NULL satisfies both.
- **Shared envelope compile**: the decomposition path's per-check compile was extracted into `compileEnvelopeRowChecks` + `checkFailedMessage`, which both insert fan-outs now use.
- **Docs**: `docs/lens-constraints.md` § Row-local checks on a decomposition write (join seam covers INSERT, plus the outer-joined-side envelope check), § Which member op a constraint rides (join insert threading site; join-body FROM attribution), § Current limitations (multi-source INSERT bullet replaced by the cross-side rule bullet). The `MutationEnvelope.rowChecks` doc in `view-mutation-node.ts` mentions the join use.

## Tests added (`test/lens-enforcement.spec.ts`, describe "join-backed logical table (multi-source body)")

- `insert enforces the check, renamed-column check, unique key and FK on the side that owns each`: reproduces the main bug. Rejects `age < 0`, `email` not matching `%@%` (`email` renamed from `mail`), a duplicate `email`, and a dangling `org`; accepts a valid row.
- `a check over one side's column does not fire on the sibling side's same-named column`: reproduces the misattribution. The `cname` check fires on insert and update, and `pname` writes pass on both.
- `a check over a left-joined side fires when the insert writes no row to that side`: reproduces the outer-join defect. Covers the side not supplied at all, the side supplied as NULL (presence gate fails), and `insert or ignore` skipping only the violating row. This is a third `it` beyond the two the ticket asked for; it pins the extra defect fixed here.

Validation: `yarn workspace @quereus/quereus test` passed (11192 passing, 26 pending), and `yarn lint` passed.

## Known gaps / things to look at

- **Cross-side rules stay unenforced** on both insert and update (`check (name is not null or email is not null)`). This is unchanged and documented under § Current limitations, as the ticket intended.
- **Subquery in an absent-side check** is evaluated at the envelope at row time, while its routed form on a present row is deferred to commit. They agree unless the subquery reads a table the same insert writes. A `NOTE:` at `buildAbsentSideRowChecks` describes this.
- **Unattributable columns** (a computed body output, or the bare key of a `using` join, which two sources carry) leave the whole constraint without `referencedWriteRowRelations`, so it falls back to bare-name gating and gets no absent-side envelope check. Example: a `left join … using (id)` body with `check (id < 100 or email is not null)` rides the Contact side by bare name, and an insert that writes no Contact row is not checked. In practice this is the cross-side class above, reached through a different route.
- **Self-join lens bodies**: relation-identity gating cannot tell two aliases of one table apart, so a rule over one alias's column rides both sides. This predates the change (the old bare-name fallback did the same), and self-join lens bodies with rules are unlikely.
- **NOT NULL on an outer-joined column** (`email text not null` over `left join`) is refused at deploy today, so the absent-side seam never sees a `notNull` obligation. If it ever does, the envelope check handles it through `violationMessage`.
- Sibling `bug-lens-check-skipped-when-write-uses-a-conflict-clause` (in `fix/`) may replace `rejectLensSetLevelConflictResolution`. That ticket now has one call site to delete instead of two.
