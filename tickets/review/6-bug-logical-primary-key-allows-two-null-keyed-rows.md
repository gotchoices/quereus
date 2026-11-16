description: An application-schema table whose primary key column may be left empty used to accept two rows with an empty key when written through its lens; both lens enforcement paths for primary keys now treat two empty keys as the same key and reject the second row. Review the fix.
architecture: docs/lens-constraints.md#set-level-unique-primary-key
files:
  - packages/quereus/src/planner/mutation/lens-enforcement.ts # SetLevelKeyColumn, synthesizeUniqueCountExpr, collectLensSetLevelConstraints, setLevelCommitOnly
  - packages/quereus/src/schema/lens-prover.ts # classifyKeyConstraint — nullablePrimaryKey gate + diagnostic wording
  - packages/quereus/src/planner/building/view-mutation-builder.ts # rejectUpsertOnCommitTimeSetLevelKey suggestion text
  - packages/quereus/test/lens-enforcement.spec.ts # two new tests in the set-level commit-time describe
  - docs/lens-constraints.md # § Set-level row-time + commit-time bullets, FD table row-time note
  - docs/lens-prover.md # lens.no-backing-index row
  - docs/mv-constraints.md # "recommended response to lens.no-backing-index" note
difficulty: medium
repro: verified
----

# Lens-enforced primary keys treat NULL as equal to NULL — review handoff

## The rule

docs/schema.md § Primary-key nullability: primary-key comparison treats NULL as equal to itself (two NULL keys collide); `UNIQUE` treats NULLs as distinct. Before this change, a logical primary key the lens could not prove unique was enforced with `UNIQUE`'s NULL-distinct semantics on both enforcement paths, so a nullable logical PK admitted duplicate NULL-keyed rows.

## What changed

**Arm 1 — commit-time count (`lens-enforcement.ts`).** Each key column of the synthesized `(select count(*) from <logical> as _u where …) <= 1` check is now built with `captureKeyEquality(_u.col, newSide, nullSafe)`. `nullSafe` is true only for a `primaryKey` whose logical column is not declared NOT NULL (an unresolvable column reads as nullable, matching `keyColumnInfo`). `unique` keys and NOT NULL PK columns keep the plain `=`. The three `keyColumns` return sites in `collectLensSetLevelConstraints` carry the flag via a new `SetLevelKeyColumn` interface. Emitted predicate for a nullable single-column PK: `_u.code = NEW.code or _u.code is null and NEW.code is null`. The commit-only refusal remedy (`setLevelCommitOnly`) now tells a nullable PK to declare its columns NOT NULL first, since a covering view alone cannot help it.

**Arm 2 — row-time classification (`lens-prover.ts`).** `classifyKeyConstraint` computes `nullablePrimaryKey = isPrimaryKey && any key column is not notNull` and skips `findBasisCovering` for it, so such a key always falls through to commit-time (where arm 1 enforces it). The `lens.no-backing-index` warning and the commit-time `lens.unenforceable-conflict-action` error share a remedy string that, for a nullable PK, explains why no covering structure can enforce it and says to declare the key columns NOT NULL. The view-mutation upsert refusal suggestion gained a short "a primary key must also declare its columns not null" clause.

Verified while implementing: a logical NOT NULL column over a nullable basis column is a deploy error (`lens.nullability-mismatch`), so after this change a `row-time` obligation is always a `unique` — the FD-table note in docs/lens-constraints.md now says so.

## Tests added (`test/lens-enforcement.spec.ts`, describe "set-level (unique / PK) commit-time at the write boundary")

- `a nullable re-keyed PK (commit-time) treats NULL keys as equal…` — arm 1 regression: single-column nullable PK, second all-NULL insert fails with `lens:pk` and the first row survives; composite `primary key (a, b)` over a second basis table, `(1, null)` and `(2, null)` coexist, a second `(1, null)` fails.
- `a nullable PK over a basis UNIQUE + covering MV classifies commit-time, not row-time…` — arm 2 regression: the ticket's row-time repro schema now classifies `['commit-time']` and a second NULL-keyed insert fails.

Existing UNIQUE NULL-distinct tests (commit-time single and composite, row-time composite) pass unchanged. One stale test comment at the row-time "re-keyed PK over a basis unique(code) is PROVED" case was reworded (it claimed "a logical PK is NOT NULL" unconditionally).

## Validation

- `yarn workspace @quereus/quereus test` — 11196 passing, 26 pending, 0 failing.
- `yarn workspace @quereus/quereus lint` — exit 0.
- `yarn test:store` was not run.

## Points for the reviewer

- **Behaviour change for existing schemas:** a nullable logical PK that used to classify row-time now classifies commit-time. Consequences, accepted per the fix ticket: it now emits `lens.no-backing-index`; a declared `on conflict replace/ignore` on it now fails deploy with `lens.unenforceable-conflict-action`; statement `or replace` / `or ignore` / `or fail` / `or rollback` and upserts against it are refused; it no longer contributes the guarded row-time FD. No existing test relied on the old row-time classification for a nullable PK.
- **Warning wording:** for the arm-2 shape the `lens.no-backing-index` message still opens with "has no basis covering structure" even though a basis covering view exists; the added sentence explains why it cannot be used. Reword the opening if that reads as wrong.
- **Advisory fingerprint unchanged:** `buildFingerprint` inputs do not include nullability, so an acknowledgement recorded for a nullable PK's `lens.no-backing-index` keeps matching. A nullable PK that was previously row-time had no such warning, so nothing to re-acknowledge there except the new warning itself.
- **Index-friendliness:** the NULL-safe disjunction may cost the commit-time count an index seek compared with plain `=`. The count is already an O(n) scan of the logical view by design, so not measured.
- `test/lens-put-fanout.spec.ts` decomposition suites with `integer null primary key` logical tables were not looked at individually; they pass in the full run.
