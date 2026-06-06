description: Review the PK-sequence rename reconciliation in the declarative differ — a pure PK-column rename now emits ONLY `RENAME COLUMN` (no spurious `primaryKeyChange` / `ALTER PRIMARY KEY`), mirroring the existing constraint-body rename reconciliation. Includes one converted sibling regression test and a docs note.
files:
  - packages/quereus/src/schema/schema-differ.ts          # computeTableAlterDiff PK block (~1136-1155); reuses inverseRenameConstraintColumns (~800), extractDeclaredPK (~1290), pkSequencesEqual (~1323)
  - packages/quereus/test/declarative-equivalence.spec.ts # 'rename without constraint churn' describe (now 18 cases); 5 new PK tests + 1 converted self-FK regression + 2 comment updates
  - docs/schema.md                                        # 'Constraint body-change detection' section — new PK-reconciliation paragraph
----

## What was implemented

`computeTableAlterDiff` now **reconciles the declared primary-key sequence against
in-diff column renames** before deciding whether to emit a `primaryKeyChange`. This
mirrors the existing constraint-body reconciliation (`reconciledDeclaredBody`).

### The change (`schema-differ.ts`, PK block ~1136-1155)

```ts
const declaredPk = extractDeclaredPK(declaredTable);
const actualPk = actualTable.primaryKey;

// Clone (inverseRenameConstraintColumns mutates in place; declaredPk backs newPkColumns).
const reconciledDeclaredPk = declaredPk.map(c => ({ ...c }));
inverseRenameConstraintColumns(reconciledDeclaredPk, diff.columnsToRename);

if (!pkSequencesEqual(reconciledDeclaredPk, actualPk)) {
	diff.primaryKeyChange = {
		oldPkColumns: actualPk.map(pk => pk.columnName),
		newPkColumns: declaredPk, // keep NEW (declared) names for the genuine-change DDL
	};
}
```

Key properties (verify these hold under review):
- **Reuses `inverseRenameConstraintColumns`** — `extractDeclaredPK` returns exactly its
  `Array<{ name; direction? }>` shape. No new helper.
- **Comparison-only reconcile**: `newPkColumns` keeps the *declared* (new) names, so a
  genuine PK change still ALTERs to the correct post-rename columns.
- **Local-column-only**: a PK references only this table's own columns, so only
  `diff.columnsToRename` is threaded — no cross-table `columnRenamesByTable` / table
  renames (deliberately asymmetric vs. the FK body case).
- **Direction untouched**: `pkSequencesEqual` still compares direction, so an `asc`→`desc`
  change layered on a renamed PK column still churns the PK change.
- The default-PK case (no explicit `PRIMARY KEY` ⇒ all columns are the key) is fixed for
  free — `extractDeclaredPK` returns all columns, and the same inverse-rename applies.

## Use cases / validation (the testing floor — treat as a starting point)

All green:
- `yarn workspace @quereus/quereus test` → **4899 passing, 9 pending, 0 failing** (~1-2m).
- `yarn workspace @quereus/quereus lint` → exit 0.
- `yarn workspace @quereus/quereus typecheck` → exit 0.
- Targeted: `--grep "rename without constraint churn"` → **18 passing**.

NOT run: `yarn test:store` (LevelDB). This change is in the **differ** (pure diff
computation, no module/storage path), so the store path is not exercised by it; the
`apply schema` calls in the new tests use the memory backend. A reviewer wanting belt-and-
suspenders could spot-run the declarative tests under `test:store`.

### Tests added (in `describe('declarative-equivalence: rename without constraint churn')`)

Five new cases, following the block's `diffOf` / `generateMigrationDDL` pattern:
- **pure PK-column rename** (`id`→`pk`) → `columnsToRename` only, `primaryKeyChange`
  `undefined`, DDL has `RENAME COLUMN` and NO `ALTER PRIMARY KEY`; idempotent re-apply.
- **composite PK, one member renamed** (`(a,b)` rename `a`→`a2`) → no `primaryKeyChange`;
  idempotent. (Uses a named `constraint pk primary key (...)` — confirmed safe: the
  catalog's `namedConstraints` and `collectDeclaredNamedConstraints` both exclude PK, so
  no constraint churn.)
- **default-PK table** (`table t { a, b }`, no explicit PK) renaming `a`→`a2` → no
  `primaryKeyChange`; DDL has no `ALTER PRIMARY KEY`; idempotent.
- **REGRESSION: genuine PK membership change** (`(a)`→`(b)`, no hint) → `primaryKeyChange`
  present, `oldPkColumns=['a']`, `newPkColumns=[{name:'b',direction:undefined}]`, DDL has
  `ALTER PRIMARY KEY (b)`; idempotent.
- **REGRESSION: rename + genuine membership change** (`(a,b)` → `(a2,c)` with `a`→`a2`
  hinted) → reconcile `(a,c)` vs actual `(a,b)` differs → `primaryKeyChange` with
  `newPkColumns=[{name:'a2'},{name:'c'}]` — i.e. the **new** names land (directly verifies
  the `newPkColumns: declaredPk` choice); idempotent.

### Test converted (NOT merely a comment change — please scrutinize)

`'REGRESSION: a self-referential FK over a renamed PK column (→ ALTER PRIMARY KEY) commits
with the deferred self-FK enforced'` was added by the sibling ticket
`self-fk-alter-primary-key-deferred-connection` to guard the `rebuildMemoryTable`
connection-cleanup engine fix. It drove the `ALTER PRIMARY KEY` **via a pure PK-column
rename** — exactly the churn this ticket now reconciles away. After my change that test
no longer emits an `ALTER PRIMARY KEY`, so it would become a **tautology** w.r.t. the
engine fix (it would pass even if `rebuildMemoryTable`'s cleanup were reverted).

To preserve the coverage I caused to lapse, I **converted** it to drive the
`ALTER PRIMARY KEY` via a *genuine* PK change (flip the key to `desc`, no rename), retitled
it `'REGRESSION: a genuine ALTER PRIMARY KEY on a self-referential-FK table commits with
the deferred self-FK enforced'`, and added a **self-verifying guard** (`diffOf` asserts
`primaryKeyChange` is present and `columnsToRename` empty before the apply) so it provably
still reaches the rebuild path. Same downstream mechanics: `ALTER PRIMARY KEY` →
`rebuildMemoryTable` → post-rebuild insert commits with the deferred self-FK firing.

I also updated the now-stale prose comment in the sibling test `'a self-referential FK
whose referenced column is renamed…'` (~2216) and the ticket-mandated stale comment in
`'an FK whose referenced PARENT column is renamed…'` (~2111) — both previously asserted
in prose that a PK-column rename emits `ALTER PRIMARY KEY`, which is no longer true.

## Known gaps / risks for the reviewer

1. **Direction-change *layered on the same renamed PK column* is not directly asserted.**
   The ticket lists it as an edge case (should still emit `primaryKeyChange`). It is
   covered indirectly — the converted self-FK test does a pure `desc` flip (no rename), and
   the membership-change-on-rename test confirms reconciliation rewrites *names only* — but
   no single test does "rename `a`→`a2` AND flip `a2` to `desc` in the same diff" and
   asserts the PK change survives. Low risk (reconciliation never touches `direction`;
   `pkSequencesEqual` compares it), but a one-line case would close it explicitly.

2. **The converted self-FK regression rests on a substitution argument.** I assert the
   converted test emits a genuine `primaryKeyChange`, but I cannot assert from the test that
   `rebuildMemoryTable` *ran* (no observable hook). A `desc` PK flip changes the BTree
   comparator, so a memory-table rebuild is necessary — the same path the original rename
   reached. Please confirm you accept the direction-flip as a faithful stand-in, or suggest
   a stronger genuine-PK change that guarantees the rebuild while keeping the self-FK valid.

3. **Whether converting a sibling ticket's regression test belongs in this ticket** is a
   judgment call. I did it because *my* change silently neutralized that test; leaving it as
   a tautology felt like papering over a regression I introduced. If you'd rather the
   coverage move elsewhere (or the test revert + a fresh fix ticket), that's a clean call to
   make here.

4. **No end-to-end store/runtime assertion that the suppressed `ALTER PRIMARY KEY` was
   genuinely unnecessary.** The premise (the extra `ALTER PRIMARY KEY` was benign churn) is
   inherited from the ticket; the new tests assert the *diff* no longer contains it and that
   `apply` + re-`diff` is idempotent, but they don't, e.g., compare a memory-table identity
   before/after to prove "no rebuild happened" on the pure-rename path. Likely overkill, but
   noting the asserted floor.

## Suggested review focus

- The clone-before-mutate in the PK block (`inverseRenameConstraintColumns` mutates in
  place; `declaredPk` backs `newPkColumns`) — confirm no aliasing leaks the reconciled
  (old) names into `newPkColumns`.
- The converted self-FK test (correctness of the substitution; whether the guard is enough).
- Gap #1 (add the direction-change-on-rename case if you want it closed inline — minor).
