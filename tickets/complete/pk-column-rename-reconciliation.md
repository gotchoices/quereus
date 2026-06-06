description: PK-sequence rename reconciliation in the declarative differ — a pure PK-column rename now emits ONLY `RENAME COLUMN` (no spurious `primaryKeyChange` / `ALTER PRIMARY KEY`), mirroring the existing constraint-body rename reconciliation. Reviewed, lint/typecheck/tests green, one edge-case test added inline.
files:
  - packages/quereus/src/schema/schema-differ.ts          # computeTableAlterDiff PK block (~1136-1155); reuses inverseRenameConstraintColumns (~800), extractDeclaredPK (~1300), pkSequencesEqual (~1334)
  - packages/quereus/test/declarative-equivalence.spec.ts # 'rename without constraint churn' describe (now 19 cases); 6 new PK tests + 1 converted self-FK regression
  - docs/schema.md                                        # 'Constraint body-change detection' section — PK-reconciliation paragraph
----

## What shipped

`computeTableAlterDiff` reconciles the declared primary-key sequence against in-diff
column renames before deciding whether to emit a `primaryKeyChange`, mirroring the
constraint-body reconciliation (`reconciledDeclaredBody`):

```ts
const declaredPk = extractDeclaredPK(declaredTable);
const actualPk = actualTable.primaryKey;

// Clone (inverseRenameConstraintColumns mutates in place; declaredPk backs newPkColumns).
const reconciledDeclaredPk = declaredPk.map(c => ({ ...c }));
inverseRenameConstraintColumns(reconciledDeclaredPk, diff.columnsToRename);

if (!pkSequencesEqual(reconciledDeclaredPk, actualPk)) {
	diff.primaryKeyChange = {
		oldPkColumns: actualPk.map(pk => pk.columnName),
		newPkColumns: declaredPk, // NEW (declared) names for the genuine-change DDL
	};
}
```

A pure PK-column rename is already emitted as a metadata-only `RENAME COLUMN`, so the
reconcile suppresses the redundant `ALTER PRIMARY KEY`. Direction is still compared
(`pkSequencesEqual`), so an `asc`→`desc` change layered on a rename still churns the PK
change; `newPkColumns` keeps the declared (new) names so a genuine change ALTERs to the
correct post-rename columns. The default-PK case (no explicit `PRIMARY KEY` ⇒ all columns
are the key) is fixed for free.

## Review findings

**Diff reviewed:** `ba87af2b` (implement) — `schema-differ.ts` (+14/-4), `docs/schema.md`
(+2), `declarative-equivalence.spec.ts` (+227). Read the differ change in full plus all
helpers it leans on (`extractDeclaredPK`, `inverseRenameConstraintColumns`,
`pkSequencesEqual`, the `columnsToRename` population, `generateMigrationDDL`'s PK phase)
before reading the handoff.

### Checked — correctness

- **Aliasing / clone-before-mutate (implementer's #1 focus):** SOUND. `reconciledDeclaredPk
  = declaredPk.map(c => ({ ...c }))` deep-enough-clones each entry; `inverseRenameConstraintColumns`
  mutates only the clone array's entries (`col.name = r.oldName`); `newPkColumns: declaredPk`
  references the untouched original. No path leaks reconciled (old) names into `newPkColumns`.
  Directly asserted by the "rename layered on membership change" and the new
  "direction-on-rename" tests (both confirm `newPkColumns` carries NEW names).
- **Statement ordering:** SOUND. `diff.columnsToRename` is populated at the top of
  `computeTableAlterDiff` (~975), long before the PK block (~1136), so the reconcile sees a
  complete rename set. `generateMigrationDDL` emits `RENAME COLUMN` before `ALTER PRIMARY
  KEY` (phase order, ~1441), so a `newPkColumns` carrying post-rename names resolves against
  already-renamed columns at apply time.
- **Direction preserved through reconcile:** SOUND. The reconcile rewrites names only;
  `pkSequencesEqual` compares `direction`; the DDL gen renders `desc`. Verified end-to-end
  by the new test (see below).
- **Non-PK column rename:** unaffected — `inverseRenameConstraintColumns` only rewrites
  entries whose `name` matches a rename `newName`, so a PK that doesn't include the renamed
  column reconciles to itself.
- **Local-only scope:** correct and deliberately asymmetric vs. the FK body case — a PK
  references only this table's own columns, so threading just `diff.columnsToRename` (not
  the cross-table `columnRenamesByTable` / table renames) is right.
- **Converted self-FK regression (implementer's #2/#3):** ACCEPTED. The implementer's own
  change neutralized the sibling ticket's `rebuildMemoryTable` guard (it drove `ALTER
  PRIMARY KEY` via a pure PK-column rename, which now reconciles away → tautology).
  Re-pointing it at a *genuine* PK change (a `desc` flip, no rename) is a faithful
  substitution: a direction flip changes the BTree comparator, so the memory-table rebuild
  is still required — same `ALTER PRIMARY KEY → rebuildMemoryTable → post-rebuild insert
  commits with deferred self-FK` path. The added `diffOf` guard (`primaryKeyChange` present,
  `columnsToRename` empty before apply) makes the test provably reach the rebuild path
  rather than passing vacuously. Doing the conversion in this ticket was the right call —
  leaving a regression I caused to lapse as a silent tautology would paper over it.

### Checked — tests

- **Minor gap closed inline (implementer's #1 known gap):** Added `'REGRESSION: a direction
  change layered on a renamed PK column still emits primaryKeyChange'` — renames `id`→`pk`
  AND flips to `desc` in one diff, asserting `primaryKeyChange` survives with
  `newPkColumns=[{name:'pk',direction:'desc'}]` and DDL emits `RENAME COLUMN` then `ALTER
  PRIMARY KEY (pk desc)`, plus idempotent re-apply. This was the one edge case the ticket
  listed that no single test exercised directly; now covered.
- Existing coverage (happy path, composite PK, default-PK, genuine membership change,
  rename+membership change, two updated prose comments on sibling FK tests) is accurate and
  asserts the right things (diff shape AND generated DDL AND idempotent re-apply AND runtime
  enforcement after apply). No tautologies remain.

### Checked — docs

`docs/schema.md` PK-reconciliation paragraph read against the final code: accurate. Names
the right helper (`inverseRenameConstraintColumns`), correctly states names-only / direction
preserved / new-names-kept / default-PK-free / local-only-asymmetric-vs-FK. No drift.

### Found — nothing major

No new tickets filed. No major findings. The only change made in this pass was the one
inline edge-case test above (minor). The two store-path caveats the implementer flagged
(no `test:store` run; no memory-table-identity assertion that "no rebuild happened" on the
pure-rename path) are genuinely out of scope — this change lives entirely in pure diff
computation (no module/storage path), and the existing tests already assert the diff omits
`ALTER PRIMARY KEY` plus idempotent re-apply, which is the right floor.

### Validation (all green)

- `yarn workspace @quereus/quereus test` → **4900 passing, 9 pending, 0 failing** (+1 vs.
  implement: the new direction-on-rename case).
- `yarn workspace @quereus/quereus lint` → exit 0.
- `yarn workspace @quereus/quereus typecheck` → exit 0.
- `--grep "rename without constraint churn"` → **19 passing**.
- `test:store` not run (no store path exercised by a pure-differ change); pre-existing
  decision inherited from implement, accepted.
