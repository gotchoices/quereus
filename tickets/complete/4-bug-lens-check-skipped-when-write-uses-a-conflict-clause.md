description: Some rules can only be checked once a write has landed, but an insert that asked to skip, replace or fail on conflicting rows made the database check them before the new row existed, so duplicates and other violations got through. Such rules are now marked commit-only in one place, always checked at commit, and an insert with such a conflict clause is refused up front.
architecture: docs/lens-constraints.md#row-local-checks-on-a-decomposition-write
files:
  - packages/quereus/src/schema/table.ts # ConstraintCheckCommitOnly, RowConstraintSchema.commitOnly
  - packages/quereus/src/planner/nodes/constraint-check-node.ts # ConstraintCheck.commitOnly
  - packages/quereus/src/planner/building/constraint-builder.ts # selfReadingCheckCommitOnly, rejectConflictClauseForCommitOnlyChecks, someTableReference
  - packages/quereus/src/planner/building/insert.ts # calls the refusal after child FK checks are appended
  - packages/quereus/src/runtime/row-constraints.ts # checkCheckConstraints defers commit-only checks under every action
  - packages/quereus/src/planner/mutation/lens-enforcement.ts # lensRowLocalCommitOnly, setLevelCommitOnly
  - packages/quereus/src/planner/building/view-mutation-builder.ts # rejectUpsertOnCommitTimeSetLevelKey (upsert-only); row-local guard deleted
  - packages/quereus/src/schema/lens-prover.ts
  - packages/quereus/src/planner/mutation/mutation-diagnostic.ts
  - packages/quereus/test/logic/40.2-check-extras.sqllogic
  - packages/quereus/test/lens-enforcement.spec.ts
  - packages/quereus/test/lens-row-local-null-write.spec.ts
  - docs/invariants.md # RT-002, LENS-004
  - docs/lens-constraints.md
  - docs/sql-dml.md
  - docs/lens-prover.md
repro: verified
----

# Commit-only checks: no conflict action pulls them to row time

## Problem

`checkCheckConstraints` (`runtime/row-constraints.ts`) deferred a relation-reading CHECK to COMMIT only under ABORT; any other effective conflict action evaluated it per row. That is right for a check reading *other* tables, but a check reading the relation the write lands in cannot see the not-yet-written row and passes a violation. Verified instances: lens commit-time set-level key under `insert or fail` / `or rollback` (unguarded), a plain-table CHECK reading its own table under any OR clause, and the lens decomposition row-local re-read (previously guarded by a one-off refusal).

## Resolution

- One marker, `ConstraintCheckCommitOnly { description, remedy? }` (`schema/table.ts`), carried on `RowConstraintSchema.commitOnly` / `ConstraintCheck.commitOnly`. Set by the two lens synthesizers (set-level count, grouped row-local re-read); derived in `buildConstraintChecks` for a user CHECK whose built expression references its own table (case-insensitive schema + name) outside `committed.*`. Views inline at plan time, so a self-read through a view is caught.
- Runtime fail-safe: a commit-only check stays deferred under every action (`shouldDefer && (commitOnly || !mustEvaluateNow)`), so a constraint-level `on conflict ignore|replace|…` on such a check acts as ABORT.
- One plan-time refusal, `rejectConflictClauseForCommitOnlyChecks`, called from `buildInsertStmt` (INSERT is the only statement with an OR clause); lens member inserts thread `stmt.onConflict`, so it fires for lens paths too.
- Retired `rejectRowLocalDeferredConflictResolution`; `rejectLensSetLevelConflictResolution` narrowed to `rejectUpsertOnCommitTimeSetLevelKey` (upsert arm only).

Implementation commit: `ticket(implement): bug-lens-check-skipped-when-write-uses-a-conflict-clause`.

## Review findings

**Checked**

- Read the full implement diff before the handoff. Runtime deferral condition, metadata plumbing (`buildConstraintMetadata` sets the required `commitOnly: boolean`), refusal placement in `buildInsertStmt` (after FK checks, honours `skipRowChecks`), operation filtering (a `check on update (…)` self-read is filtered out of INSERT checks before the refusal looks).
- Every source of a non-ABORT `stmtOR`: only `InsertStmt.onConflict`; UPDATE/DELETE pass `undefined`; the upsert DO UPDATE arm passes `plan.onConflict`, which the parser makes mutually exclusive with upsert. No internal code synthesises `insert or replace|ignore|fail|rollback` against user tables (grepped all `packages/*/src`), so no internal path (sync, bundle import, ALTER rebuild) newly trips the refusal.
- `core/derived-row-validator.ts` also calls `buildConstraintChecks`; it ignores `commitOnly` and defers on `needsDeferred` regardless of action, so the new marker is harmless there.
- Probed the built engine directly: `committed.t` self-read under `insert or ignore` still allowed and correctly skips; self-read via a view over the same table refused under `or ignore` and caught at commit under a plain insert; mixed-case table name (`T` vs `t`) matched; upsert DO UPDATE onto a duplicate and UPDATE with a constraint-level `on conflict ignore` both fail at commit (no silent pass).
- Stale references: no remaining mention of the deleted/renamed guards or the old error text in code, tests, or docs. Docs read: `sql-dml.md`, `lens-constraints.md`, `lens-prover.md`, `mv-constraints.md`, `sql-views.md`, `invariants.md` — consistent with the new behaviour.
- Tests: the two new sqllogic blocks are the bug reproduction and the runtime-arm pin (the plan-time refusal otherwise masks the runtime arm); the lens spec edits update existing assertions. All earn their place; nothing cut.
- `yarn workspace @quereus/quereus run lint` clean; `yarn workspace @quereus/quereus test` 11194 passing, 26 pending.

**Found / done**

- Minor: none needing a code change. Type safety, error handling (refusal throws a located `QuereusError`), and resource handling are fine; the extra expression walk per CHECK build (`someTableReference`) is negligible next to the existing `containsCommittedRef` walk.
- Accepted judgment calls from the handoff, reviewed and kept: plan-time refusal of OR clauses on plain tables with self-reading CHECKs (the decided design; no internal or test caller relied on the old behaviour); only the first commit-only check is named in the refusal (same remedy for all); lens callers now get a plain `QuereusError` instead of a `ViewMutationError` with a `mutationDiagnostic.reason` for this case (nothing reads that reason).
- Behaviour change noted, no ticket: an `insert or replace|ignore` into a decomposition whose commit-time key spans members (rides no member op) is now accepted instead of refused. That key is already unenforced on every insert form (debug-logged in `buildDecompositionInsert`); the `or` forms now match a plain insert. `docs/lens-constraints.md` § Current limitations lists the cross-member *FK* case but not a cross-member set-level key; not verified by repro here, so the doc was left unchanged.
- Tripwire (no ticket): self-reference detection is name-based on `TableReferenceNode`; a CHECK reading a materialized view over its own table is not marked commit-only. Already stated in the handoff and out of scope (MV maintenance timing); no new note added since the `selfReadingCheckCommitOnly` doc comment states what it matches.
- Tripwire: `docs/invariants.md` is at 11974 words against its 12000-word cap (`wc -w`); `yarn docs:check` warns. The next invariant added there needs a split first.
- Major: none.
