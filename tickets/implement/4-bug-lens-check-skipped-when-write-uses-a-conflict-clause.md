description: Some rules can only be checked once a write has landed, but an insert that asks to skip, replace or fail on conflicting rows makes the database check them before the new row exists, so duplicates and other violations get through silently. Mark such rules as commit-only in one place, keep them deferred no matter what, and refuse the conflict clause up front where it cannot be honoured.
architecture: docs/lens-constraints.md#row-local-checks-on-a-decomposition-write
files:
  - packages/quereus/src/runtime/row-constraints.ts # checkCheckConstraints, `mustEvaluateNow` (~341) — the site that pulls a deferred check forward to row time
  - packages/quereus/src/planner/nodes/constraint-check-node.ts # ConstraintCheck — add the commit-only marker here
  - packages/quereus/src/schema/table.ts # RowConstraintSchema (~1111) — add the synthesis-side marker
  - packages/quereus/src/planner/building/constraint-builder.ts # buildConstraintChecks (~32, needsDeferred at ~202) — compute the marker; home for the single plan-time refusal
  - packages/quereus/src/planner/building/insert.ts # ~985-1035 — the only builder that holds a statement OR clause next to the built checks
  - packages/quereus/src/planner/mutation/lens-enforcement.ts # synthesizeLensRowLocalDeferredConstraint (~861), collectLensSetLevelConstraints (~1436) — set the marker at synthesis
  - packages/quereus/src/planner/building/view-mutation-builder.ts # rejectRowLocalDeferredConflictResolution (~796, delete), rejectLensSetLevelConflictResolution (~947, keep upsert arm only), comments at ~154 and ~826
  - packages/quereus/test/lens-enforcement.spec.ts # ~906 set-level conflict-clause test
  - packages/quereus/test/lens-row-local-null-write.spec.ts # ~328 row-local conflict-clause test
  - docs/lens-constraints.md # lines ~40 and ~47
  - docs/invariants.md # LENS-004 (~1346)
  - docs/sql-dml.md # conflict-resolution (OR clause) section
difficulty: hard
repro: verified
----

# Commit-only checks are pulled forward to row time by a conflict clause

## The defect

`runtime/row-constraints.ts` `checkCheckConstraints` queues a check whose expression reads a relation (`needsDeferred`, set in `constraint-builder.ts` when the built expression contains a subquery) for evaluation at COMMIT — **unless** the effective conflict action is anything but ABORT:

```ts
const effectiveAction = pickAction(stmtOR, metadata.schema.defaultConflict);
const mustEvaluateNow = effectiveAction !== ConflictResolution.ABORT;
if (metadata.shouldDefer && !mustEvaluateNow) { /* queue for commit */ }
```

The reasoning ("IGNORE/REPLACE/FAIL/ROLLBACK must be applied while the row is in hand") is right for a check that reads *other* tables — an FK existence check, `exists (select 1 from Allowed …)` — because those tables already hold their final state at row time. It is wrong for a check whose answer depends on the row being written already being visible: run before the insert, such a check sees the table without the new row, finds nothing wrong, and the violating row is written and kept.

## Reproduced (2026-11-16, at 5e6380fa4)

**Lens set-level key, commit-time (unguarded — live hole).** Logical `unique (email)` over a basis with no unique on `email`:

```sql
declare schema y { table u (id integer primary key, email text null) }; apply schema y;
declare logical schema x { table u (id integer primary key, email text null, unique (email)) }; apply schema x;
insert into x.u (id, email) values (1, 'a@x');
insert or fail     into x.u (id, email) values (2, 'a@x');  -- accepted; both rows persist
insert or rollback into x.u (id, email) values (2, 'a@x');  -- accepted; both rows persist
insert or abort    into x.u (id, email) values (2, 'a@x');  -- correctly fails: CHECK constraint failed: lens:unique
```

`rejectLensSetLevelConflictResolution` only refuses `or replace` / `or ignore` / upsert; its comment says `or fail` / `or rollback` "are fine — they ABORT", which does not match the runtime above.

**Plain table, user CHECK that reads its own table (same site, outside lens entirely).**

```sql
create table t (id integer primary key, x integer, check ((select count(*) from t as o where o.x = new.x) <= 1));
insert into t values (1, 7);
insert or fail    into t values (2, 7);  -- accepted, row persists
insert or ignore  into t values (2, 7);  -- accepted, row persists
insert or replace into t values (2, 7);  -- accepted, row persists
insert            into t values (2, 7);  -- correctly fails at commit
```

**Lens row-local CHECK that reads other relations on a decomposition write** — already guarded by `rejectRowLocalDeferredConflictResolution` (refused with `lens-row-local-unenforceable`); covered by `test/lens-row-local-null-write.spec.ts` "a non-ABORT conflict clause is refused rather than silently skipped".

All three are one class at one site: a check that must observe its own statement's write, forced to row time by `mustEvaluateNow`.

## Design (decided here)

**One property, set once.** Add a "commit-only" marker to `ConstraintCheck` (e.g. `commitOnly: boolean`, name at implementer's discretion). It is true when either:

- the `RowConstraintSchema` says so — a new optional field set by the two lens synthesizers (`synthesizeLensRowLocalDeferredConstraint`, `collectLensSetLevelConstraints`); these read the logical view the write feeds, so they always need the post-write image; or
- `buildConstraintChecks` finds, in the built CHECK expression, a `TableReferenceNode` for the target table itself that is not `readCommitted` (a `committed.t` read sees pre-statement state on purpose and does not need the write). Compare by schema + table name, case-insensitively.

Only `kind: 'check'` gets the structural test. FK checks (`foreign-key-builder.ts`) keep current behaviour: a self-referencing FK evaluated at row time can only falsely *reject* (row referencing itself), never falsely accept — a different question, not this ticket.

Carry a human label for the refusal message: for lens-synthesized constraints the basis-level constraint name (`lens:unique`, the grouped row-local name) means nothing to the user, so the schema-side marker should carry text naming the logical table and rule(s) (e.g. the logical `unique (email)` / the CHECK names). For a user CHECK the constraint name and table suffice.

**Runtime honours it first.** In `checkCheckConstraints`, a commit-only check is queued deferred regardless of the effective action — `if (metadata.shouldDefer && (metadata.commitOnly || !mustEvaluateNow))`. Its deferred evaluator already throws, so it ABORTs at commit. Update the comment there ("Only ABORT reaches this branch …") to say a commit-only check also reaches it under any action, and why. This makes the runtime fail-safe even if the plan-time refusal is bypassed (e.g. a constraint-level `on conflict ignore` on a self-reading CHECK, or a future builder).

**Plan time refuses the mismatch, in one place.** When a statement-level OR clause other than ABORT (`ignore`, `replace`, `fail`, `rollback`) meets a commit-only check that applies to the operation, refuse the statement with a diagnostic naming the check (label above), the table, and the remedy (plain insert / `insert or abort`, or for a lens set-level key, a covering materialized view). Put the helper in `constraint-builder.ts` and call it from `insert.ts` after child-side FK checks are appended and before `ConstraintCheckNode` is built — INSERT is the only statement with an OR clause (UPDATE has none; the upsert arm in `dml-executor.ts` passes `onConflict` undefined).

Chosen over "keep deferred and silently downgrade to ABORT": a user writing `or ignore` / `or replace` expects the offending row skipped/replaced; quietly turning that into a commit-time abort of the whole transaction surprises, and refusing is what both existing hand-written guards already do. The downgrade still happens for the constraint-level `defaultConflict` case (rare; documented), since refusing every insert into a table for its own DDL would be worse.

**Retire the hand-written guards.**

- Delete `rejectRowLocalDeferredConflictResolution` and its call in `buildDecompositionRowLocalChecks`; trim that function's doc comment (the "A non-ABORT statement OR clause is rejected up front…" paragraph) to point at the general seam.
- Shrink `rejectLensSetLevelConflictResolution` to the upsert arm only (an upsert's conflict target cannot match a key no index backs — an intent problem, not a timing one; upserts are not forced early). Rewrite its doc comment and the block comment at ~154 accordingly; drop the stale "`or fail` / `or rollback` are fine" claim. If `'lens-set-level-conflict-resolution'` / `'lens-row-local-unenforceable'` reasons lose all their conflict-clause uses, keep them for their remaining uses (`lens-row-local-unenforceable` is still raised by `requireLensLogicalRowAddress` / `lens-enforcement.ts:539`).
- `schema/lens-prover.ts:1660` mentions the gate by name — update the comment.

## Tests (reproductions only)

- `test/lens-enforcement.spec.ts` ~906 "rejects `or replace` / `or ignore` / upsert against a commit-time set-level key": add `or fail` and `or rollback` to the refused list (this is the verified hole); keep `or abort` / plain insert passing and still detecting the duplicate; keep the upsert refusal. Update regexes to the new message. Line ~1522 (composition caveat) should still refuse `or replace` — adjust regex only.
- `test/lens-row-local-null-write.spec.ts` ~328: same four clauses still refused; update the regex from `/non-ABORT conflict clause forces row-time evaluation/` to the new message.
- One new case for the plain-table class (sqllogic or spec, implementer's choice of the lowest layer): a self-reading CHECK refuses `insert or ignore` / `or fail` at plan time, plain insert of a duplicate still fails at commit, plain insert of a fresh value lands.
- Existing coverage that must stay green and proves the marker is not over-applied: `or ignore` with an FK / other-table subquery CHECK still skips at row time (e.g. `test/lens-enforcement.spec.ts` ~336, ~3594, `lens-row-local-null-write.spec.ts` ~191, ~578, and the general `or ignore` FK logic tests). Run `yarn test` from root; the full quereus suite.

## Docs

- `docs/lens-constraints.md` line ~40: replace the "as does an INSERT combining the deferred seam with a non-ABORT conflict clause … (the posture `rejectLensSetLevelConflictResolution` takes …)" sentence with a pointer to the general rule; line ~47: "`insert or replace` / `or ignore` / upsert … rejected" becomes "any non-ABORT conflict clause, and any upsert".
- `docs/invariants.md` LENS-004: the conflict-clause refusal is no longer `lens-row-local-unenforceable` from `view-mutation-builder.ts`; point at the general seam. Consider a short general invariant ("a check that reads the written relation is evaluated only at commit; a statement OR clause that would need it at row time is refused") with `constraint-builder.ts` as code and the new plain-table test as guard.
- `docs/sql-dml.md` conflict-resolution (OR clause) section: one paragraph — CHECKs that read other tables follow the OR clause at row time; a CHECK that reads its own table (and every lens commit-time rule) is evaluated at COMMIT, so a statement OR clause other than ABORT is refused, and a constraint-level `on conflict` action on such a CHECK acts as ABORT.

## TODO

- Add the commit-only field to `RowConstraintSchema` (with a label for diagnostics) and to `ConstraintCheck`; compute it in `buildConstraintChecks` (schema flag OR non-committed self-reference in a `check`).
- Set the schema flag + label in `synthesizeLensRowLocalDeferredConstraint` and `collectLensSetLevelConstraints`.
- Carry it into `ConstraintMetadataEntry` (`buildConstraintMetadata`) and make `checkCheckConstraints` defer it under every action; fix the comment.
- Add the plan-time refusal helper in `constraint-builder.ts`; call it from `insert.ts`.
- Delete `rejectRowLocalDeferredConflictResolution`; shrink `rejectLensSetLevelConflictResolution` to upsert; fix comments in `view-mutation-builder.ts` and `lens-prover.ts:1660`.
- Update the two existing tests' clause lists/regexes; add the plain-table reproduction.
- Update `docs/lens-constraints.md`, `docs/invariants.md`, `docs/sql-dml.md`.
- `yarn build`, `yarn lint` (quereus type-checks tests), `yarn test`.
