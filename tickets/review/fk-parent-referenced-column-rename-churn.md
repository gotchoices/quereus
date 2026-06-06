description: REVIEW — Suppress redundant FK drop+recreate when only the FK's *referenced column on the parent table* is renamed. Implemented via a one-pass pre-resolution of every name-matched declared table's column renames in `computeSchemaDiff`, threaded into the FK branch of `reconciledDeclaredBody`.
files:
  - packages/quereus/src/schema/schema-differ.ts            # resolveColumnRenames helper, computeSchemaDiff pre-pass, computeTableAlterDiff param, reconciledDeclaredBody FK branch, inverseRenameStringColumns
  - packages/quereus/test/declarative-equivalence.spec.ts   # 4 new cases in describe('rename without constraint churn')
  - docs/schema.md                                          # removed the FK referenced-parent-column "Known limitation" sentence (~line 372)
----

## What was built

Extended the rename-reconciliation in `reconciledDeclaredBody` (FK branch) so that a
rename of the **referenced column on the parent table** no longer churns a spurious
`DROP CONSTRAINT` + `ADD CONSTRAINT` on the child FK.

Mechanism (matches the ticket's resolved design):

- **`resolveColumnRenames(declaredTable, actualTable, policy)`** — extracted the
  map-building + `resolveRenames` step that `computeTableAlterDiff` already did, into a
  shared helper returning the full `{ renames, pairs, consumedActuals }`.
- **Pre-pass in `computeSchemaDiff`** (after `tableRenames`, before the table loop):
  builds `Map<declaredTableNameLower, ColumnRenameOp[]>` for every *name-matched*
  declared table (pure creates contribute nothing; only non-empty rename lists stored).
  Keyed by the **declared (new)** table name — the same key an FK's `foreignKey.table`
  carries at diff time. The current table's renames are resolved twice (once here, once
  in its own `computeTableAlterDiff`); documented + accepted (O(columns), no I/O).
- **`computeTableAlterDiff`** takes the map as a new param and forwards it to
  `reconciledDeclaredBody`.
- **FK branch of `reconciledDeclaredBody`** — after the existing local-column and
  parent-table inverse-rewrites, looks up the parent's column renames by the **declared
  parent name** (BEFORE the table inverse-rename rewrites that name back to old) and
  inverse-renames the `string[]` referenced-parent-column list via the new
  **`inverseRenameStringColumns`** helper (string-list sibling of
  `inverseRenameConstraintColumns`, case-insensitive, in-place, no-op on undefined).
- Removed the "KNOWN LIMITATION" block from the JSDoc and the matching sentence in
  `docs/schema.md`; updated both to list the parent-referenced-column case as handled.

Self-referential FKs fall out for free: the parent *is* the current table, so
`map.get(currentTable)` returns the same renames as `diff.columnsToRename`.
A parent-table-rename + parent-column-rename in the same diff reconcile together
(look up parent col renames by the new parent name, then rewrite the table name to old).

## Validation status (all green)

- `yarn workspace @quereus/quereus run build` — clean (EXIT 0).
- `yarn workspace @quereus/quereus test` — **4859 passing, 9 pending, 0 failing**.
- `yarn workspace @quereus/quereus run lint` — clean (EXIT 0).
- New describe block (`rename without constraint churn`): **9/9 passing** (5 prior + 4 new).
- `test:store` deliberately NOT run (per ticket: differ-only change, catalog-side diff
  computation, not a module `alterTable`; the existing FK rename tests already cover the
  differ↔emit wiring).

## Tests added (use cases the reviewer should re-exercise / extend)

In `test/declarative-equivalence.spec.ts`, `describe('declarative-equivalence: rename
without constraint churn')`:

1. **`...referenced PARENT column is renamed does not drop+recreate the child FK`** —
   `parent.pid → parent.key`, child FK `references parent(key)`. Asserts child alter has
   empty `constraintsToDrop`/`constraintsToAdd`; parent `columnsToRename = [{pid→key}]`;
   DDL has parent `RENAME COLUMN` and **no** `DROP CONSTRAINT` / `ADD ...constraint`;
   after apply the FK rejects an orphan / accepts a valid ref; re-apply is idempotent.
2. **`...parent TABLE and referenced PARENT column are renamed together...`** —
   `parent→p2` (table) AND `pid→key` (column); child FK `references p2(key)`. Top-level
   `renames` carries the table rename, parent alter carries the column rename, child FK
   not churned; enforcement holds; idempotent.
3. **`a self-referential FK whose referenced column is renamed does not churn the FK`** —
   single table, FK to itself. **Uses a non-PK UNIQUE referenced column** (`code→ucode`),
   not the PK — see Gap #2 below for why. Asserts no self-FK / UNIQUE churn, no PK
   change, enforcement holds, idempotent.
4. **`REGRESSION: a genuine FK body edit layered on a parent-column rename...`** —
   `pid→key` AND add `on delete cascade` to the child FK. Asserts child
   `constraintsToDrop = ['fk']`, `constraintsToAdd.length = 1` (precedence preserved);
   after apply, deleting the parent row cascades to the child (the recreate installed the
   cascade); idempotent.

## Known gaps / things for the reviewer to scrutinize (treat tests as a floor)

**Gap #1 — Orthogonal PK-column-rename churn (NOT addressed; pre-existing).**
The ticket's literal example renames the parent's **PK column** (`pid`). Because
`pkSequencesEqual` compares PK columns by name with **no** rename reconciliation, renaming
a PK column ALSO emits a benign `primaryKeyChange` (an `ALTER PRIMARY KEY`) on that table.
This is a *separate* limitation, out of scope here. For ordinary (non-self) FKs it is
benign: tests 1, 2, 4 apply cleanly and re-apply idempotently with it present. Tests 1/2/4
therefore intentionally do **not** assert "parent emits ONLY a column rename" (the parent
also emits the PK change). A reviewer may want to file a follow-up for PK-column-rename
reconciliation (mirror this ticket's approach for `primaryKeyChange`).

**Gap #2 — Self-referential FK + PK-column rename trips a deferred-enforcement engine bug.**
Discovered while building test 3. When the renamed referenced column on a *self*-referential
FK is the **PK** column, the apply emits `RENAME COLUMN` + `ALTER PRIMARY KEY`, and a
subsequent INSERT fails at commit with
`QuereusError: Deferred constraint execution found multiple candidate connections for table main.node`
(`runtime/deferred-constraint-queue.ts findConnection`). Isolation probes showed:
  - plain `create table` self-FK + insert → enforces fine (immediate CHECK);
  - declarative-apply self-FK, **no** rename → enforces fine;
  - imperative `alter table … rename column` of the self-FK referenced col (no PK change) → enforces fine;
  - declarative apply that renames the self-FK's **PK** referenced column (⇒ `ALTER PRIMARY KEY`) → breaks.
So the trigger is `ALTER PRIMARY KEY` on a self-FK table, NOT this ticket's FK
reconciliation (the reconciliation is what *avoids* churn; the `ALTER PRIMARY KEY` is
present regardless of churn-vs-reconcile). This is almost certainly **pre-existing**, but I
did **not** conclusively prove the pre-change drop+recreate path would also break — worth a
reviewer check, and likely a new `fix/` ticket (self-referential FK deferred enforcement
after a schema-mutating apply). **Test 3 sidesteps it** by referencing a non-PK UNIQUE
column, which isolates exactly the FK-referenced-column reconciliation this ticket targets.

**Gap #3 — Edge cases covered by construction but NOT given a dedicated test:**
  - *Elided referenced-column list* (`references parent`, no column list):
    `inverseRenameStringColumns(undefined, …)` no-ops, so nothing is synthesized — but
    there is no explicit test asserting no-churn for the elided shape under a parent rename.
  - *Multi-column FK where only one referenced column is renamed*: per-entry matching
    rewrites only the renamed entry — not explicitly tested.
  - *`require-hint` policy on a pure parent-column rename*: the child FK is not churned, so
    its `constraintsToAdd`/`constraintsToDrop` stay empty and the guard can't trip — relied
    on by construction, not exercised under `policy = 'require-hint'`.
  A reviewer wanting belt-and-suspenders coverage could add these three.

**Gap #4 — Canonical-string symmetry** relied upon: the declared side renders the
referenced-parent-column list via `ast-stringify`'s `constraintBodyToCanonicalString`; the
actual side via `ddl-generator`'s `constraintToCanonicalDDL` (`referencedColumnNames`).
The passing idempotence assertions confirm byte-equality after reconciliation in the tested
shapes, but this is the usual fragile coupling the sibling FK cases also depend on.

## Notes

- All touched functions (`computeTableAlterDiff`, `reconciledDeclaredBody`,
  `inverseRenameConstraintColumns`/`inverseRenameStringColumns`, `resolveColumnRenames`) are
  private to `schema-differ.ts`; only internal call sites changed (one call site for
  `computeTableAlterDiff`).
- No `tickets/.pre-existing-error.md` written: the full suite has 0 failures.
