description: COMPLETE — Suppress redundant FK drop+recreate when only the FK's *referenced column on the parent table* is renamed. Implemented via a one-pass pre-resolution of every name-matched declared table's column renames in `computeSchemaDiff`, threaded into the FK branch of `reconciledDeclaredBody`.
files:
  - packages/quereus/src/schema/schema-differ.ts            # resolveColumnRenames helper, computeSchemaDiff pre-pass, columnRenamesByTable, reconciledDeclaredBody FK branch, inverseRenameStringColumns
  - packages/quereus/test/declarative-equivalence.spec.ts   # 7 cases in describe('rename without constraint churn') for this ticket (4 from implement + 3 added in review)
  - docs/schema.md                                          # FK referenced-parent-column case documented as handled (~line 372)
----

## What shipped

A rename of the **referenced column on the parent table** no longer churns a spurious
`DROP CONSTRAINT` + `ADD CONSTRAINT` on the child FK. Mechanism:

- **`resolveColumnRenames(declaredTable, actualTable, policy)`** — extracted the
  map-building + `resolveRenames` step into a shared helper returning
  `{ renames, pairs, consumedActuals }`.
- **Pre-pass in `computeSchemaDiff`** builds `Map<declaredTableNameLower, ColumnRenameOp[]>`
  for every name-matched declared table, keyed by the declared (new) table name — the same
  key an FK's `foreignKey.table` carries at diff time. Threaded through `computeTableAlterDiff`
  into `reconciledDeclaredBody`.
- **FK branch of `reconciledDeclaredBody`** inverse-renames the `string[]` referenced-parent
  column list via the new **`inverseRenameStringColumns`** helper, looking the parent's
  renames up by the *new* parent name BEFORE the existing parent-table inverse-rename rewrites
  that name back to old. Self-referential FKs fall out for free (parent == current table);
  parent-table + parent-column renames in the same diff reconcile together.
- Docs (`schema.md` + JSDoc) updated; the old "KNOWN LIMITATION" removed.

## Validation

- `yarn workspace @quereus/quereus run build` — clean.
- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn workspace @quereus/quereus test` (full suite) — **4862 passing, 9 pending, 0 failing**.
- `describe('rename without constraint churn')` — **12/12 passing** (5 prior + 4 implement + 3 review).
- `test:store` not run (differ-only change; catalog-side diff computation, not a module
  `alterTable` — existing FK rename tests cover the differ↔emit wiring).

## Review findings

Adversarial pass over commit `92a0c89f`. Diff read first, then the handoff.

### Checked

- **Correctness of the cross-table reconcile.** Verified the pre-pass keys `columnRenamesByTable`
  by the declared (new, lowercased) table name (`declaredTables` is keyed that way at
  build, `schema-differ.ts:221`) and that an FK's `foreignKey.table` carries the same
  declared name at diff time — so the lookup key matches. Verified the ordering: parent
  *column* renames are looked up by the new parent name **before** the parent-*table*
  inverse-rename rewrites it back to old, and the already-cloned `foreignKey.columns` array
  is safely mutated in place then carried through the `{ ...clone.foreignKey, table }` spread.
  Confirmed the actual-side canonical body renders the FK referenced columns by their
  pre-rename names, so the reconciled declared body compares byte-equal. **No issues.**
- **Pure-create / absent-parent paths.** Pure creates contribute nothing to the map
  (`tableRenames.pairs.get` is undefined → skipped); an FK to a freshly-created parent finds
  no map entry → no-op. **Correct.**
- **Double-resolution of the current table's renames.** Documented and accepted (O(columns),
  no I/O). Under `require-hint` it would throw earlier (pre-pass) than before, but with the
  identical error — not an outcome regression. **Acceptable.**
- **Elided referenced-column list (`references parent`).** Traced through
  `constraint-builder.ts` → `referencedColumnNames` stays `undefined` (PK resolution is
  deferred to enforcement via `resolveReferencedColumns`, `table.ts:498`) and the canonical
  body keeps the list elided on BOTH sides. So a parent PK-column rename never touches the FK
  body and `inverseRenameStringColumns(undefined, …)` correctly no-ops — it never synthesizes
  a column list. **Genuinely safe (was flagged as untested in the handoff's Gap #3 — now tested).**
- **Docs.** `docs/schema.md` ¶ on body-change detection now lists the parent-referenced-column
  case as handled; the old "KNOWN LIMITATION" sentence is gone; JSDoc matches. No other doc
  (incl. `change-scope.md`) carries a stale reference to the old limitation. **Up to date.**
- **Lint + full test suite.** Both green (see Validation).

### Found & fixed in this pass (minor)

- **Edge-case test coverage was a floor.** Added 3 tests to `describe('rename without
  constraint churn')` for the cases the handoff flagged as covered-by-construction-only
  (Gap #3): (a) an FK with an **elided** referenced-column list under a parent PK-column
  rename → no churn, no synthesized list; (b) a **multi-column FK** where only ONE referenced
  parent column is renamed → per-entry reconcile, no churn; (c) a pure parent-column rename
  under the **`require-hint`** policy → guard not tripped. All pass; enforcement + idempotence
  asserted where applicable.

### Found & filed as new tickets (major — out of scope for an inline fix)

- **`fix/self-fk-alter-primary-key-deferred-connection`** (Gap #2, engine bug).
  A self-referential-FK table that undergoes `ALTER PRIMARY KEY` during an apply (e.g. when
  its PK column is renamed) throws at the next commit:
  `Deferred constraint execution found multiple candidate connections for table main.node`
  (`runtime/deferred-constraint-queue.ts findConnection`). **Conclusively confirmed
  pre-existing**, resolving the handoff's open question: I reverted `schema-differ.ts` to the
  pre-ticket version (debf8cbe) and the repro throws the **identical** error, so the
  drop+recreate path breaks too — the trigger is `ALTER PRIMARY KEY` on a self-FK table, not
  this ticket's reconciliation. Test 3 in this ticket deliberately uses a non-PK UNIQUE
  referenced column to isolate the FK reconcile from this bug; that remains the right call.
- **`backlog/pk-column-rename-reconciliation`** (Gap #1, differ enhancement).
  Renaming a PK column still emits a benign `primaryKeyChange` / `ALTER PRIMARY KEY` because
  `pkSequencesEqual` compares PK columns by name with no rename reconciliation. Benign for
  ordinary FKs (tests apply cleanly and are idempotent) but unnecessary churn, and the
  trigger for the self-FK engine bug above. Filed to mirror this ticket's approach for the
  PK sequence.

### Empty categories (explicit)

- **Type safety / `any` / resource cleanup:** nothing found. All touched functions are
  private to `schema-differ.ts`, fully typed; helpers mutate already-cloned structures, no
  shared-state leakage; tests close their `Database` in `finally`.
- **DRY / modularity:** the `resolveColumnRenames` extraction removed the duplication it
  introduced; `inverseRenameStringColumns` is a deliberate `string[]` sibling of
  `inverseRenameConstraintColumns` (the `{name}[]` shapes don't unify cleanly). No further
  consolidation warranted.
- **Performance:** pre-pass is O(total columns) with no I/O; no concern.
