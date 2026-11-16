description: Inserting a row into an application-schema table that is stored as two joined underlying tables ignores every rule the table declares (checks, uniqueness, references to other tables), although updating the same table enforces them. Inserts should enforce the same rules, attached to the correct underlying table.
architecture: docs/lens-constraints.md#which-member-op-a-constraint-rides
files: packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/planner/mutation/lens-enforcement.ts, docs/lens-constraints.md, packages/quereus/test/lens-enforcement.spec.ts
difficulty: medium
repro: verified
----

# A join-backed logical table applies none of its declared rules on insert

## Reproduced

The bug was confirmed with throwaway specs (since deleted). Setup: basis `y.Core(id pk, name, age, org)` and `y.Contact(id pk references Core, mail)`. Logical `x.Person` has a lens body `select c.id, c.name, c.age, c.org, k.mail as email from y.Core c join y.Contact k on c.id = k.id`. Deploy succeeds and the prover classifies the rules as enforceable: `check` → `enforced-row-local`, `unique (email)` → `enforced-set-level` (commit-time), `foreign key (org) references Org(id)` → `enforced-fk`.

| write through `x.Person` | insert | update |
|---|---|---|
| `check (age >= 0)` violated | **accepted** | rejected `lens:agepos (NEW.age >= 0)` |
| `check (email like '%@%')`, where `email` is renamed from `mail` | **accepted** | rejected `lens:emailfmt (NEW.mail like '%@%')` |
| `check (id > 0)` (the shared key) | **accepted** | rejected |
| duplicate `email` (unique) | **accepted** | rejected `lens:unique:uemail` |
| dangling `org` (FK, `pragma foreign_keys = true`) | **accepted** | rejected `lens:fk:fkorg` |
| `check (name is not null or email is not null)` (one column from each side) | accepted | **accepted** (rides neither side; only a debug log) |

The question the original ticket left open, whether such a table can carry an enforceable rule at all, is settled: it can, and insert drops all of them.

## Second defect at the same seam (verified, update path)

Basis `Core(id, name)` and `Contact(id, name)` both have a column called `name`. Logical columns: `pname` from `c.name` and `cname` from `k.name`. Declared rule: `check (cname <> 'bad')`. Running `update x.Person set pname = 'bad'` is **wrongly rejected** with `lens:cnameok (NEW.name != 'bad')`, because the check also ran against Core's `name`.

Cause: `makeOwningRelationResolver` (`lens-enforcement.ts` ~91) finds the table that owns a logical column in one of two ways: decomposition advertisement members, or `resolveSlotBasisSource`, which handles single-source bodies only. A join body has neither, so it returns `undefined` for every column. `buildWriteRowRelations` then omits `referencedWriteRowRelations`, and `constraintsForOp` (`view-mutation-builder.ts` ~1546) falls back to matching by bare column name. A constraint over `NEW.name` therefore attaches to **every** side that has a column called `name`. Once insert starts receiving constraints it would hit the same misattachment, so both are fixed here.

## Fix

**1. Pass the lens constraints to the join insert, gated per side.** `buildMultiSourceInsert` (~1040) ends every side with `buildInsertStmt(ctx, sideInsert, [], source, false, sideNewRowScope)` (~1107). Reuse the collectors and gate that the update path already uses (`buildViewMutation` ~296–365); do not write a second collector:

- Collect the constraints in the join-insert dispatch in `buildViewMutation` (~163): `[...lensRowLocalConstraints(ctx, view), ...lensForeignKeyConstraints(ctx, view), ...lensSetLevelConstraints(ctx, view)]`. Leave out parent-side FKs, because an insert cannot orphan a child. Same list as `buildDecompositionInsert` (~1187), except that row-local checks use the routed basis-term form, for the reason in step 4.
- Pass the list into `buildMultiSourceInsert` as a new parameter. The other caller is the set-op join-leg splice in `buildSetOpMutation` (~990). Have it pass `[]` explicitly, with a short comment saying why: set-op bodies cannot be lens bodies (the parser rejects compound selects in `declare lens`), so those synthetic branch views never have a slot. Collecting at the dispatch keeps the slot lookup from running against a synthetic branch view.
- For each side, call `constraintsForOp(...)` and hand the result to `buildInsertStmt`. `constraintsForOp` takes `Pick<BaseOp, 'table'>` and reads only `op.table.tableSchema`. A side has `side.schema` (a `TableSchema`), so narrow the parameter to whatever both shapes can supply, e.g. a `TableSchema`, and update the two existing call sites. Do not build a fake `TableReferenceNode`.
- After the sides are built, add the same un-ridden trace loop the other two fan-outs use, so a constraint that attached to no side shows up in the debug log.

**2. Apply the conflict-clause guard.** `rejectLensSetLevelConflictResolution` (~197) runs *after* the join-insert dispatch returns, so an `insert or replace` / `or ignore` / upsert through a join-backed table with a commit-time unique key is never refused. Once step 1 lands, that constraint would ABORT at commit instead. Call the guard on the join-insert path, either by moving it above both insert dispatches or by calling it inside, the way `buildDecompositionInsert` (~1153) does.

**3. Attribute join-body columns to their table.** Add a third branch to `makeOwningRelationResolver` for join bodies. For each compiled-body result column that is a qualified column reference (`c.name`), resolve its qualifier through the body's FROM clause (alias or table name → the basis `TableSchema`) and return `{ schema, table }`. Columns it cannot attribute still return `undefined`, which keeps the bare-name fallback. Look for an existing alias→table resolver over a body's FROM before writing one; the multi-source analysis (`analyzeJoinView` / `analyzeMultiSourceInsert`) already maps each output column to its side. With attribution in place:

- the check above attaches only to the Contact side, on both update and insert;
- `relationQualify` in `collectLensRowLocalConstraints` stays false, because it is keyed on decomposition members. The rewrite stays `NEW.<basis>`, and that is correct, since each side's insert/update has its own write row. Do not turn on the per-member correlation for joins.
- FK and set-level constraints are attributed through the same resolver (`collectLensForeignKeyConstraints` ~1074, `collectLensSetLevelConstraints` ~1400), so they also stop falling back to bare names.

**4. Rules whose columns span both sides: match the update path.** A rule naming columns from both sides attaches to neither side and is not enforced. It is traced in the debug log and listed under § Current limitations. This is the update path's existing behaviour (verified above), and it is also the documented contract for a decomposition FK that spans members. Evaluating cross-side checks at the insert envelope only, as `buildDecompositionRowLocalChecks` does, would make insert stricter than update for the same rule. It would also evaluate an unsupplied column as its *logical* default, while the side insert stores its *basis* default (the `NOTE` on `substituteUnsuppliedLogicalColumns` ~743). That disagreement is more likely here, where users write the lens body themselves. The row-local checks keep the routed basis-term form because an inner-join side insert always runs, so it always sees the written value, NULL included.

## Things to check while there

- **Outer-join optional side.** A non-preserved side's insert is presence-gated (`side.presenceGateIndices`) and skipped when the row supplies none of its columns. A row-local check over that side's columns, and one that a NULL *fails* (`check (email is not null)`, `coalesce(...)`), would then go unevaluated. That is the decomposition NULL-write problem again. Find out whether a left-join lens body can be inserted through and can deploy such a check. If both hold, the check is skipped now, so it is a real defect, not a tripwire: send those checks to the envelope seam (`MutationEnvelope.rowChecks`, which `buildMultiSourceInsert`'s `ViewMutationNode` can already carry) or refuse the write loudly. If either does not hold, leave a `NOTE:` at the presence-gate site.
- **Sibling `bug-lens-check-skipped-when-write-uses-a-conflict-clause`** (in `fix/`) may replace `rejectLensSetLevelConflictResolution` with a seam-level "must defer" marker. If it lands first, step 2 is covered by that mechanism. If this ticket lands first, the call added in step 2 is one more site that ticket will delete.

## Docs

`docs/lens-constraints.md`:
- In § Row-local checks on a decomposition write, remove the "(Multi-source INSERT enforces no logical rules …)" aside and say the join seam covers INSERT too.
- In § Which member op a constraint rides, add the join insert to the threading sites, and add join-body FROM attribution to the sources of `referencedWriteRowRelations`.
- In § Current limitations, replace the multi-source INSERT bullet with one for the cross-side rule on a join-backed table (insert and update).

## Tests

Add to `packages/quereus/test/lens-enforcement.spec.ts`. Keep it to two `it`s:
- one that builds the join-backed deployment above and asserts that insert rejects the check, the renamed-column check, the duplicate unique key and the dangling FK, and accepts a valid row;
- one for the same-named-column case, asserting the `cname` check fires and the `pname` write passes on both update and insert.

## TODO

- Collect the lens constraints at the join-insert dispatch and pass them into `buildMultiSourceInsert`; the set-op join-leg caller passes `[]` with a comment.
- Narrow `constraintsForOp`'s op parameter so a join side can use it; gate each side; add the un-ridden trace loop.
- Run `rejectLensSetLevelConflictResolution` on the join-insert path.
- Attribute join-body columns to their owning relation in `makeOwningRelationResolver`.
- Investigate the outer-join optional-side case; fix it, or leave a `NOTE:`.
- Add the two tests; update `docs/lens-constraints.md`.
- `yarn workspace @quereus/quereus test` and `yarn lint` (from the repo root).
