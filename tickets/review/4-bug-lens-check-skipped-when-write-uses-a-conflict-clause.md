description: Some rules can only be checked once a write has landed, but an insert that asked to skip, replace or fail on conflicting rows made the database check them before the new row existed, so duplicates and other violations got through. Such rules are now marked commit-only in one place, always checked at commit, and an insert with such a conflict clause is refused up front.
architecture: docs/lens-constraints.md#row-local-checks-on-a-decomposition-write
files:
  - packages/quereus/src/schema/table.ts # ConstraintCheckCommitOnly, RowConstraintSchema.commitOnly
  - packages/quereus/src/planner/nodes/constraint-check-node.ts # ConstraintCheck.commitOnly
  - packages/quereus/src/planner/building/constraint-builder.ts # selfReadingCheckCommitOnly, rejectConflictClauseForCommitOnlyChecks, someTableReference
  - packages/quereus/src/planner/building/insert.ts # calls the refusal after child FK checks are appended
  - packages/quereus/src/runtime/row-constraints.ts # checkCheckConstraints defers commit-only checks under every action
  - packages/quereus/src/planner/mutation/lens-enforcement.ts # lensRowLocalCommitOnly, setLevelCommitOnly
  - packages/quereus/src/planner/building/view-mutation-builder.ts # rejectUpsertOnCommitTimeSetLevelKey (renamed, upsert-only); row-local guard deleted
  - packages/quereus/src/schema/lens-prover.ts # comments + lens.no-backing-index warning text
  - packages/quereus/src/planner/mutation/mutation-diagnostic.ts # reason comment
  - packages/quereus/test/logic/40.2-check-extras.sqllogic
  - packages/quereus/test/lens-enforcement.spec.ts
  - packages/quereus/test/lens-row-local-null-write.spec.ts
  - packages/quereus/test/lens-put-fanout.spec.ts # comment only
  - docs/invariants.md # new RT-002, LENS-004 updated
  - docs/lens-constraints.md
  - docs/sql-dml.md
  - docs/lens-prover.md
repro: verified
----

# Commit-only checks: no conflict action pulls them to row time

## What was wrong

`runtime/row-constraints.ts` `checkCheckConstraints` deferred a relation-reading CHECK to COMMIT only under ABORT; any other effective action (IGNORE / REPLACE / FAIL / ROLLBACK) evaluated it per row. That is right for a check reading *other* tables, but wrong for one that reads the relation the write lands in: per row, before the write, it cannot see the new row and passes a violation. Three verified instances: lens commit-time set-level key under `insert or fail` / `or rollback` (was unguarded), a plain-table CHECK reading its own table under any OR clause, and the lens decomposition row-local re-read (was guarded by a hand-written refusal).

## What changed

- **One marker.** `ConstraintCheckCommitOnly { description, remedy? }` (`schema/table.ts`) — the presence of `commitOnly` on `RowConstraintSchema` / `ConstraintCheck` means "decide only at commit"; the text names the rule in the user's terms for the refusal message.
  - Set by the two lens synthesizers: `synthesizeLensRowLocalDeferredConstraint` (description lists the grouped CHECK names + logical table) and `collectLensSetLevelConstraints` (description = `the unique key 'name' (cols) of logical table 'x.u'`, remedy = add a covering MV).
  - Derived in `buildConstraintChecks` for a `kind: 'check'` whose built expression contains a `TableReferenceNode` for the target table itself (schema + name, case-insensitive) that is not `readCommitted`. Views inline at plan time, so a CHECK reading a view over its own table is caught too. FK checks are untouched.
- **Runtime fail-safe.** `ConstraintMetadataEntry.commitOnly`; the defer condition is now `shouldDefer && (commitOnly || !mustEvaluateNow)`. A constraint-level `on conflict ignore` on a self-reading CHECK therefore acts as ABORT at commit (documented, not refused).
- **Plan-time refusal, one place.** `rejectConflictClauseForCommitOnlyChecks(checks, stmt.onConflict, stmt.loc)` in `constraint-builder.ts`, called from `buildInsertStmt` after child-side FK checks are appended. Throws `QuereusError` (StatusCode.ERROR): `cannot insert with 'or fail': <description> is checked only at commit, … Use a plain insert or 'insert or abort' …[, or <remedy>].` Lens decomposition/multi-source/set-op member inserts all thread `stmt.onConflict` into `buildInsertStmt`, so the refusal fires on the member op the commit-only constraint rides.
- **Retired guards.** `rejectRowLocalDeferredConflictResolution` deleted (and the now-unused `onConflict` param of `buildDecompositionRowLocalChecks`). `rejectLensSetLevelConflictResolution` → `rejectUpsertOnCommitTimeSetLevelKey`, upsert arm only (reason `lens-set-level-conflict-resolution` kept for it). `lens-row-local-unenforceable` is still raised for the unaddressable-row case.

## Tests

- `test/logic/40.2-check-extras.sqllogic` — new `t_selfread` block: a self-reading CHECK refuses `insert or ignore` / `or fail` at plan time, a plain duplicate insert fails at commit (`x_once`), a fresh value lands. Reproduction of the plain-table hole.
- same file — `t_selfread_ci`: the same CHECK declared `on conflict ignore` still rejects a duplicate under a plain insert. Pins the runtime arm, which the plan-time refusal otherwise masks; verified it fails with the `commitOnly ||` term removed.
- `test/lens-enforcement.spec.ts` "rejects every non-ABORT conflict clause and upsert against a commit-time set-level key…" — now seeds `a@x` first and asserts `or ignore` / `or replace` / `or fail` / `or rollback` duplicates are refused (the verified `or fail` / `or rollback` hole) and nothing lands; upsert still refused; `or abort` / plain still pass and detect duplicates.
- `test/lens-enforcement.spec.ts` composition caveat (~1530) and `test/lens-row-local-null-write.spec.ts` (~328) — regex updated to `/checked only at commit/`; comments updated.

Not-over-applied evidence: `or ignore` with an FK / other-table subquery CHECK still skips at row time — whole quereus suite green, including the lens `or ignore` cases the fix ticket listed.

Validation run: `yarn build` OK, `yarn workspace @quereus/quereus run lint` OK (eslint + test type-check), `yarn docs:check` OK, `yarn test` all green (quereus 11194 passing, 26 pending; other workspaces passing).

## For the reviewer — known gaps / judgment calls

- **Behaviour change on plain tables.** `insert or replace` / `or ignore` into any table with a CHECK that reads its own table is now refused at plan time, even when the user meant the PK-replace semantics and the CHECK would not be violated. This is the ticket's decided design; worth a second look that no real-world schema in tests or samples relied on it (none in the suite did).
- **Lens cross-member set-level key.** The old `rejectLensSetLevelConflictResolution` refused `or replace` / `or ignore` up front even when the commit-time count rode no member op (cross-member key on a decomposition, already logged as "not enforced on this write"). Now the refusal follows the constraint, so such an insert is accepted — consistent with a plain insert, which also gets no enforcement there.
- **Self-reference test is name-based**, per the ticket; a CHECK reading a *materialized view* over its own table is a different `TableReferenceNode` and is not marked (MV maintenance timing was out of scope).
- **The refusal reports the first commit-only check only**; with several, the user fixes one and meets the next. Acceptable — the remedy (plain insert) is the same for all.
- **`docs/invariants.md` is 26 words under its 12000-word cap** after adding RT-002 (`yarn docs:check` warns); the next entry there needs a split first.
- Error class is a plain `QuereusError` (not `ViewMutationError`), so lens callers lose the structured `mutationDiagnostic.reason` they got from the old row-local guard. No test or code read that reason for this case.
