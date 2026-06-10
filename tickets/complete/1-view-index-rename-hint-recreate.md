description: Hinted view/index rename → drop+recreate (was silent no-op) — implemented, reviewed, complete. Differ emits drop(old)+recreate(declared) from the views/indexes buckets for a hint-matched rename whether or not the body changed; the body-unchanged recreate is column-reconciled (NEW→OLD) so it plans before RENAME COLUMN; recreates excluded from the require-hint counts.
files:
  - packages/quereus/src/schema/schema-differ.ts            # views/indexes rename branches, require-hint guard, inverseRenamedViewParts (shared core), columnReconciledViewStmt / columnReconciledIndexStmt
  - packages/quereus/test/logic/50.2-declare-schema-renames.sqllogic   # §16–§21 (implement), §22–§23 (review)
  - packages/quereus/test/index-ddl-roundtrip.spec.ts       # re-pinned rename test + review-added collate-folded/partial-WHERE test
  - docs/schema.md                                          # § Migration Order item 1, § Rename Detection, § Index body-change detection, § View/MV definition-change detection
----

# Hinted view/index rename → drop+recreate (complete)

## What was broken

A `quereus.previous_name` / `quereus.id` hint-matched view or index rename with
an UNCHANGED body diffed empty and applied as a silent no-op: `resolveRenames`
consumed the actual (no drop) and matched the declared (no create), and
`generateMigrationDDL` emits rename DDL only for `kind === 'table'`.

## What was implemented

- **Views / indexes blocks** (`computeSchemaDiff`): after the definition/body
  compare concludes "unchanged", a rename match
  (`matchedActual.name.toLowerCase() !== name`) pushes drop(actual old name) +
  create(declared stmt) and `continue`s past the in-place SET TAGS branch (no
  double-emit; the recreate carries the declared tags).
- The body-unchanged recreate is rendered **column-reconciled** (NEW→OLD for
  any column renamed in the same diff) while keeping **declared table names**:
  in migration order the create runs after `ALTER TABLE … RENAME TO` but
  before `ALTER TABLE … RENAME COLUMN`, and CREATE VIEW / CREATE INDEX plan
  their bodies at create time. After the create, the live
  `propagateColumnRename` rewrites the fresh object, so post-apply state and a
  re-diff converge.
- Counters renamed `viewBodyRecreates`/`indexBodyRecreates` →
  `viewRecreates`/`indexRecreates`; hinted-rename recreates increment them so
  the deliberate drop+create pair never trips the `require-hint` guard.
- `generateMigrationDDL`'s stale "caller emits drop+recreate" comment
  corrected: non-table rename ops are metadata; convergence DDL comes from the
  view/index buckets.
- Docs updated: § Migration Order item 1, § Rename Detection, § Index
  body-change detection, § View/MV definition-change detection.

## Review findings

**Process:** read the implement diff (`0a6a9e69`) fresh before the handoff;
walked the views/indexes blocks, `resolveRenames`, both reconcile helpers,
`indexedColumnBareName`, `collectFromTableNames`, the rename-rewriter entry
points, and `generateMigrationDDL` ordering; traced eight interaction
scenarios by hand (rename × table-rename × column-rename × tags ×
insert-defaults × partial-WHERE × require-hint × deny); re-read every touched
docs section against the code.

**Correctness — confirmed sound, no major findings:**
- The migration-order invariant (declared TABLE names, actual COLUMN names)
  holds in every traced path; §19/§20 pin it end-to-end and the new §22/§23
  pin the two interactions the implementer left untested.
- Drop/create double-emission is impossible: rename branches `continue` past
  SET TAGS, and the trailing drop loops skip `consumedActuals`.
- The require-hint exclusion is exact: each recreate adds exactly one drop and
  one create, both subtracted; a genuine unhinted create+drop pair still trips
  the guard (§21, §14 unchanged).
- Type safety of the collate-folded casts in `columnReconciledIndexStmt` is
  guaranteed by `indexedColumnBareName`'s shape contract (non-undefined only
  for `col.name` or `collate(column)`).
- `deny` policy unaffected (resolver skips hints entirely → rename branches
  unreachable). Case-only re-declares cannot enter the rename branch (keys and
  comparisons lowercase both sides).
- Checked the "dependent view declared before its recreated dependency"
  ordering worry and dismissed it: `viewsToCreate` preserves declaration
  order, and a declaration must already be dependency-ordered for its initial
  apply, so any recreate subset stays validly ordered. No ticket filed.
- The re-pinned `index-ddl-roundtrip` test (~line 1018) asserts the intended
  semantics (drop old name, recreate naming the OLD column, rename op kept as
  metadata) — not just the implementation. Verified against the design.

**Minor — fixed in this pass:**
- DRY: `columnReconciledViewStmt` duplicated ~50 lines of
  `reconciledDeclaredViewDefinition`'s select-body + `insert defaults`
  inverse-rename logic (the only deltas — the table pass and OLD-name seeding —
  degenerate to identity with no table renames). Extracted a shared core
  `inverseRenamedViewParts(select, insertDefaults, tableRenames,
  columnRenamesByTable, schemaName)`; both callers are now thin wrappers
  (`columnReconciledViewStmt` passes `[]` for tableRenames, keeping declared
  table names). Behavior-identical; full suite green after the refactor.

**Test gaps — closed in this pass:**
- sqllogic §22: hinted view + index rename combined with an in-diff TABLE
  rename — pins the exact DDL order (ALTER TABLE RENAME first, then
  drop+creates naming the DECLARED table) and the "no inverse table pass"
  design choice, end-to-end with re-diff [].
- sqllogic §23: hinted view rename + `insert defaults` clause + in-diff column
  rename — exercises the previously fully-untested defaults branch of
  `columnReconciledViewStmt` (clause column inverse-mapped via the FROM-scoped
  lookup); pins recreate DDL, write-through after apply, re-diff [].
- spec test (index-ddl-roundtrip): hinted index rename over a collate-folded
  indexed column plus a partial WHERE referencing a second renamed column —
  the two `columnReconciledIndexStmt` branches the plain re-pin missed.

**Accepted as documented (no action):**
- Body-CHANGED hinted rename + same-diff column rename still fails at apply
  (raw render) — pre-existing residual hazard class, documented in
  docs/schema.md § View/MV definition-change detection.
- `columnReconciledIndexStmt`'s cross-table WHERE loop is dead code today
  (memory backend rejects cross-table partial-index predicates) — kept for
  symmetry, cannot be tested end-to-end.
- Index rebuild cost on a pure rename — documented tradeoff; an
  `ALTER INDEX … RENAME TO` primitive could later replace it without changing
  diff semantics.
- MV hinted renames unsupported by design; recreate stores the hint tags
  verbatim (inert on re-diff — name match wins before hint resolution).
- `yarn test:store` not run (AGENTS.md reserves it for store diagnosis /
  release); the recreate path is plain DDL through the standard migration loop.

**Validation:** `yarn workspace @quereus/quereus run typecheck` clean; root
`yarn test` all workspaces green (quereus 5650 passing / 0 failing / 9
pending); quereus `yarn lint` clean.
