description: Follow-up coverage for the constraint-bearing `refresh materialized view` re-validation path (landed by `maintained-table-refresh-revalidation`). Two low-risk, untested corners of the NEW `rebuildBacking` constraint-bearing branch — store-backed parity and a collation-sensitive CHECK on the reshape arm. Both are coverage/edge-hardening, not known defects.
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts        # rebuildBacking constraint-bearing branch (the code under test)
  - packages/quereus/test/maintained-table-refresh-revalidation.spec.ts   # the memory-only spec to mirror / extend
  - packages/quereus-store/test/mv-store-backing.spec.ts                   # store MV test harness to add a constraint-bearing refresh case to
difficulty: medium
----

# Follow-up coverage: constraint-bearing refresh re-validation

The `maintained-table-refresh-revalidation` ticket added declared CHECK/FK
re-validation to the constraint-bearing branch of `rebuildBacking` (the
stale-refresh gap). It shipped with a 17-case **memory-backed** spec. Two corners
of the new branch remain untested; both are believed low-risk and neither is a
known defect — this ticket is to close the coverage rather than to fix a bug.

## Store-backed parity for the constraint-bearing refresh path

The new spec (`test/maintained-table-refresh-revalidation.spec.ts`) exercises the
**memory** backing only. Existing store MV tests
(`packages/quereus-store/test/mv-store-backing.spec.ts`) cover refresh/reshape of
**constraint-less / MV-sugar** store backings — those take the unchanged
`replaceContents` fast path and never enter the new
`applyMaintenance('replace-all')` + `validateDeclaredConstraintsOverContents` +
`conn.commit()` branch.

Risk is low: the attach core (`attachMaintainedDerivation`) already runs the
*identical* sequence on store backings and is store-tested, so the only untested
variable is the **trigger** (refresh vs attach), not the sequence. Still, a
store-parity case for a constraint-bearing **table-form** maintained-table refresh
(seed clean → stale via source `alter add column` → drift a CHECK-violator and an
FK-orphan → assert the refresh throws the maintained-table-attributed diagnostic
and leaves the pre-refresh committed contents intact) would close the gap and pin
that the bulk scan reads the store connection's **pending** reconcile writes
(reads-own-writes) the same way memory does.

`yarn test:store` (the LevelDB sqllogic re-run) was also **not** run for the
original ticket — worth a one-off pass when this is picked up.

## Collation-sensitive CHECK on the reshape arm

On the **reshape** arm, `rebuildBacking` runs
`validateDeclaredConstraintsOverContents` against the reconciled rows in their
**pre-post-reconcile physical form** — i.e. before the post-reconcile
data-validating ops (retype / recollate / tighten-NOT-NULL) apply. This is correct
for value-domain CHECK/FK (tested), and is the same two-phase ordering the attach
reshape path uses. The untested corner: a **recollate** that flips a
*collation-sensitive* CHECK's outcome (a CHECK whose truth depends on the
column's collation, on a column being recollated by the reshape, with a value
that is clean under the old collation but violating under the new). The declared
CHECK is validated against the old-collation physical form, so such a row could
pass validation and then be recollated into a state the CHECK would reject.

This is an esoteric corner (collation-sensitive CHECK ∧ recollate-during-reshape ∧
value clean-old/dirty-new). Add a test to characterize the actual behavior and
decide whether the CHECK should re-run post-recollate or the corner stays a
documented limitation.
