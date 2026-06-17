description: Correct stale docs, comments, and tests that wrongly claimed the flag-less set-op write path defers non-equi inner-join legs — add tests proving all three write paths accept them uniformly.
prereq:
files: packages/quereus/src/planner/mutation/set-op.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, packages/quereus/test/logic/93.6-set-op-flagless-write.sqllogic, docs/view-updateability.md
difficulty: easy
----

## What was done

No production logic was changed. This was a precision cleanup: comment/doc fixes and new positive-coverage tests.

### Comment fixes

**`set-op.ts` `isWritableLeafLeg`** (≈ 1565–1572): Replaced "INNER equi-join … non-equi join leg is deferred" with accurate wording: `isInnerJoinBody` keys only on `joinType`, so a non-equi INNER join is admitted. Only OUTER/cross legs fall to `false`.

**`set-op.ts` `isOperandWritable`** (≈ 203–205): Removed the clause "— the flag-less route is stricter; see docs/view-updateability.md § Set Operations" — the flag-less route is not stricter on equi-ness.

**`multi-source.ts` `isInnerJoinBody` JSDoc** (≈ 332–334): Replaced "ships INNER equi-join legs" with the correct framing: the gate is `joinType`-only, non-equi INNER joins are admitted.

**`docs/view-updateability.md`** (≈ 498–502): Removed the "flag-less route is stricter / defers a non-equi leg / follow-up ticket" sentence; replaced with a statement that all three paths (standalone, membership, flag-less) admit non-equi inner legs identically.

### Test relabeling (`93.6`)

The `NEV` view section was mislabeled "Non-equi (theta) INNER join leg deferral". The actual reason for the all-`NO` is the **missing literal discriminator** in a union-all body — `flaglessShape` returns `null` regardless of equi-ness when no leg projects a literal. Relabeled to "Missing-discriminator deferral" with an explicit note that non-equi is NOT the reason.

### New positive tests

**`93.6` `NEVD`**: Added `NEVD` — same schema as `NEV` but with a `'ne' as tag` discriminator in the join leg. Asserts `is_insertable_into=NO, is_updatable=YES, is_deletable=YES` and exercises UPDATE + DELETE through the non-equi inner join leg on the flag-less path.

**`93.4` `NJV`**: Standalone non-equi inner join view. Asserts `YES/YES/YES` and exercises UPDATE + DELETE (only rows where the theta predicate holds are visible — id=1 with x=10 satisfies `5 < x < 15`).

**`93.4` `NMV`**: Membership set-op with a non-equi inner join leg. Asserts `NO/YES/YES` (join-leg INSERT deferred, UPDATE/DELETE compose) and exercises UPDATE + DELETE.

### Test validation

- Full suite: **6330 passing**, 9 pending, 0 failures.
- Lint + tsc: clean exit (0).

## Use cases for testing

1. `NEVD` view (flag-less path): verify `is_updatable=YES, is_deletable=YES` and that UPDATE/DELETE route through the non-equi join leg without any `k.k0_0` internal error.
2. `NJV` (standalone path): verify all three `YES` and that UPDATE/DELETE compose.
3. `NMV` (membership path): verify `NO/YES/YES` and that UPDATE/DELETE fan through the join branch.
4. Regression: `NEV` still reports `NO/NO/NO` (missing-discriminator deferral is intact).
5. All existing 93.x tests still pass (no production logic changed).

## Known gaps / reviewer notes

- No no-op write assertion added (e.g., `delete … where id = <invisible row>`). The ticket described this as optional; the primary coverage goal (visible-row positive writes) is met.
- Cartesian-duplicate dedup (a base row with ≥2 partner matches) is not explicitly tested; covered implicitly by `ne2` having two rows that both match `ne1.id=1` via the theta predicate (but both have the same lo/hi, so there's only one unique match in this fixture). An explicit 2-partner scenario was not added; flag for follow-up if desired.
- INSERT through the non-equi join leg remains deferred (`is_insertable_into=NO`) — this is by design and tested.
