description: Review hinted view/index rename → drop+recreate fix (was silent no-op). Differ now emits drop(old)+recreate(declared) from the views/indexes blocks for a body-unchanged hint-matched rename, with the recreate column-reconciled (NEW→OLD) and excluded from the require-hint counts.
files:
  - packages/quereus/src/schema/schema-differ.ts            # views block, indexes block, require-hint guard, new helpers columnReconciledViewStmt / columnReconciledIndexStmt (after reconciledDeclaredViewDefinition), generateMigrationDDL renames-loop comment
  - packages/quereus/test/logic/50.2-declare-schema-renames.sqllogic   # new §16–§21
  - packages/quereus/test/index-ddl-roundtrip.spec.ts       # re-pinned "renamed index over a concurrently-renamed column" test (~line 1018)
  - docs/schema.md                                          # § Migration Order item 1, § Rename Detection, § Index body-change detection, § View/MV definition-change detection
----

# Hinted view/index rename → drop+recreate (implemented)

## What was broken

A `quereus.previous_name` / `quereus.id` hint-matched view or index rename with
an UNCHANGED body diffed empty and applied as a silent no-op: `resolveRenames`
consumed the actual (no drop) and matched the declared (no create), and
`generateMigrationDDL` emits rename DDL only for `kind === 'table'`. Five
verified repro variants (view/index × pure rename / + tag drift / + in-diff
column rename) all converged to "old name survives, new name never exists".

## What was implemented (per ticket design — no deviations)

- **Views block** (`computeSchemaDiff`): after the definition compare concludes
  "unchanged", a rename match (`matchedActual.name.toLowerCase() !== name`)
  pushes `viewsToDrop.push(matchedActual.name)` and a create of the declared
  stmt rendered via the new `columnReconciledViewStmt`, then `continue`s —
  so the (name-match-only) in-place SET TAGS branch can never double-emit.
- **Indexes block**: same shape via `columnReconciledIndexStmt` +
  `applyIndexDefaults` before `createIndexToString`.
- **Counters** `viewBodyRecreates`/`indexBodyRecreates` renamed to
  `viewRecreates`/`indexRecreates`; hinted-rename recreates increment them, so
  the `require-hint` guard does not trip on the deliberate drop+create pair.
- **New helpers** (placed after `reconciledDeclaredViewDefinition`):
  - `columnReconciledViewStmt(stmt, columnRenamesByTable, schemaName)` —
    clone-based inverse application of in-diff COLUMN renames (NEW→OLD) to the
    select body (via `renameColumnInAst` seeded with each DECLARED table name —
    no inverse table pass, since table renames run before creates) and to the
    `insert defaults` clause (column via FROM-scoped lookup, expr via
    `renameColumnInCheckExpression`), mirroring
    `reconciledDeclaredViewDefinition` minus the table pass. Identity
    short-circuit on `columnRenamesByTable.size === 0`.
  - `columnReconciledIndexStmt(stmt, colRenames, columnRenamesByTable,
    schemaName)` — indexed-column bare names inverse-mapped NEW→OLD (both the
    plain and the parser's collate-folded forms), partial WHERE cloned and
    inverse column-renamed (own table via the seeded CHECK entry point, other
    tables via the plain scope-aware walk — cross-table refs are unreachable
    today, kept for symmetry).
- **`generateMigrationDDL`**: stale "caller emits drop+recreate via the
  standard buckets" comment corrected — non-table rename ops are metadata; the
  convergence DDL now comes from the view/index buckets even when hinted.
- **Docs** (`docs/schema.md`): § Migration Order item 1 (only tables get rename
  DDL; hinted view/index renames realize as drop+recreate in the drop/create
  phases), § Rename Detection (the false "still fall back via the standard
  buckets" sentence replaced with the hinted-recreate + column-reconciled
  render + propagation interplay), plus one-line parity fixes in § Index
  body-change detection and § View/MV definition-change detection (removed the
  stale `view-rename-hint-silent-noop` backlog reference).

## Migration-order invariant (the load-bearing part — verify this in review)

Recreate DDL references **declared (new) TABLE names** (table renames emit
first) but **actual (old) COLUMN names** for any column renamed in the same
diff (`RENAME COLUMN` emits last, and CREATE VIEW / CREATE INDEX plan their
bodies at create time). After the create, the live `propagateColumnRename`
rewrites the freshly created object's body/columns, so the post-apply state and
a re-diff converge. Pinned end-to-end by sqllogic §19/§20 (diff DDL shape,
apply, re-diff empty).

## Test / validation surface

- `test/logic/50.2-declare-schema-renames.sqllogic` new sections:
  - §16 view hint rename: exact diff DDL (`DROP VIEW IF EXISTS v_old` +
    `create view v_new … with tags (…)`), apply, `schema()` lists new name
    only, data visible through new view, re-diff `[]` (hint tags stored
    verbatim are inert).
  - §17 index hint rename: same shape via `schema()` type='index'.
  - §18 view rename + non-hint tag drift: recreate carries the tags
    (`json_extract(tags,'$.owner')`), re-diff `[]`.
  - §19 view rename + in-diff column rename: recreate names the OLD column,
    RENAME COLUMN emits after the create, select through the new view sees the
    NEW column, re-diff `[]`.
  - §20 index rename + in-diff column rename: same for the indexed column.
  - §21 hinted view+index rename under `rename_policy = 'require-hint'`
    applies without tripping the guard.
- `test/index-ddl-roundtrip.spec.ts` ~line 1018: the test that previously
  PINNED the buggy no-op ("emits the index rename only, no body recreate") was
  re-pinned to the new shape (drop `ix_old`, one recreate naming the OLD
  column, rename op still recorded as metadata). This was the only failing
  test across the repo before the update — review that the new assertions
  match the intended semantics rather than just the implementation.
- Commands run, all green: `yarn workspace @quereus/quereus run typecheck`,
  root `yarn test` (all workspaces; quereus 5649 passing / 0 failing),
  quereus `yarn lint`.

## Known gaps / honest notes for the reviewer

- **Body-CHANGED hinted rename recreate is unchanged** (pre-existing path): it
  renders `createViewToString(stmt)` raw, so a genuine definition edit that
  ALSO references a column renamed in the same diff still fails at apply
  (documented residual hazard in docs/schema.md § View/MV definition-change;
  same as before this ticket). Only the body-UNCHANGED rename path got the
  column-reconciled render.
- `columnReconciledIndexStmt`'s cross-table WHERE loop is dead code today (the
  memory backend rejects cross-table refs in partial-index predicates at
  create time) — kept for symmetry with `declaredIndexCanonicalBody`, untested
  end-to-end by necessity.
- `yarn test:store` was NOT run (AGENTS.md reserves it for store-specific
  diagnosis/release). The recreate path is plain DDL through the standard
  migration loop, but a reviewer wanting belt-and-braces could run it.
- No `quereus.id`-specific view/index sqllogic section — the resolver is
  shared with tables (covered by §2) and the diff shape is identical; deemed
  redundant.
- MV hinted renames remain unsupported by design (differ ignores MV hints);
  `deny` policy untouched (hints skipped ⇒ standard buckets).
- Index rebuild cost on a pure rename is the accepted tradeoff (documented);
  a future `ALTER INDEX … RENAME TO` primitive could replace the recreate
  without changing diff semantics.
