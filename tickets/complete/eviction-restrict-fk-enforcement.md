description: Secondary-UNIQUE REPLACE evictions now enforce FK ON DELETE RESTRICT / NO ACTION via a post-eviction transitive scan + statement-savepoint rollback. One-line call in processEvictions, a regression suite, and two doc updates. Reviewed and completed.
files: packages/quereus/src/runtime/emit/dml-executor.ts, packages/quereus/src/runtime/foreign-key-actions.ts, packages/quereus/test/logic/55.1-eviction-restrict-fk.sqllogic, docs/runtime.md, docs/module-authoring.md
----

## Summary

A secondary-UNIQUE REPLACE eviction (a new/updated row collides on a *non-PK* UNIQUE
with an existing row at a *different* PK) deletes the evicted parent. Previously the FK
`RESTRICT` / `NO ACTION` pre-check never ran for that internal delete, silently orphaning
children where SQLite fails the statement. Because the FK default `onDelete` is `'restrict'`,
this affected every FK lacking an explicit `CASCADE` / `SET NULL` / `SET DEFAULT`.

The fix is a single call at the top of the `processEvictions` row loop
(`dml-executor.ts:594`), before `_recordDelete`:

```typescript
await assertTransitiveRestrictsForParentMutation(ctx.db, tableSchema, 'delete', evicted);
```

The substrate already physically removed the evicted row inside `vtab.update()`, so the
scan runs **post-eviction** — the child rows it keys off remain, so the RESTRICT scan and
the transitive cascade-children walk still resolve. On a violation it throws; the
statement-scope savepoint (`__stmt_atomic_N`, opened before the row loop in
`runWithStatementSavepoints`) rolls back, unwinding both the substrate eviction and the
writing row. Verified on the key-based memory and store substrates.

## Review findings

Reviewed adversarially against the implement diff (commit `2b596a5f`) with fresh eyes
before reading the handoff. Effort focused on the four "probe" items the implementer
flagged plus an independent sweep.

### Checked — and what was found

- **`-- error:` directive is REQUIRED, not optional (resolved the implementer's open
  question).** `logic.spec.ts:595` (`executeExpectingError`) throws *"Expected error
  matching … but SQL block executed successfully"* when the block does not throw, and
  `:601` asserts the message contains the substring. So the suite is **not** vacuous — the
  three negative cases genuinely require the eviction to fail, and the subsequent
  data-unchanged `select`s are real assertions on a single shared db. Confirmed the block
  parser (`:722-729`) runs the accumulated SQL as setup + a final throwing statement, which
  matches how the cases are written.

- **Error-translation path is correct and consistent with existing behavior.** The thrown
  `QuereusError(StatusCode.CONSTRAINT)` from `assertNoRestrictedChildrenForParentMutation`
  is *not* a `ConstraintError` subclass, so `translateConflictError` (`dml-executor.ts:294`)
  returns it untranslated for the non-FAIL REPLACE/ABORT path — the statement savepoint then
  rolls back at `:398-402`. This is the same path the pre-existing plain-DELETE RESTRICT
  check already uses; no regression, no transaction-level teardown (subsequent statements in
  the test file run fine on the same db, proving statement-scope — not transaction-scope —
  unwind).

- **OR FAIL interaction is a non-issue.** A statement-level `or fail` overrides an
  index-level `on conflict replace`, so no eviction occurs under FAIL; and even if one did,
  the per-row `__or_fail_N` savepoint wraps the whole row's work (eviction + write), so
  rollback would still be correct. The `__stmt_atomic_N` branch handles the real cases.

- **Ordering.** The assert (`:594`) precedes `_recordDelete` (`:596`) and
  `executeForeignKeyActions` (`:598`), so cascade children are still present when the
  transitive walk scans them — the depth-2 path below depends on this and is now tested.

- **Docs.** Read both touched docs (`runtime.md` Per-row post-write pipeline,
  `module-authoring.md` Update results / REPLACE displacement) end-to-end against the code —
  they accurately describe the post-eviction scan, the savepoint rollback, the error form,
  and the rowid-chained (lamina) out-of-scope caveat. Grepped all of `docs/` and
  `README.md` for stale "RESTRICT not enforced for evictions" wording and the tracking slug;
  **none remain** (the other `evict` doc hits are unrelated cache-eviction prose).

- **Resource cleanup / type safety.** `assertTransitiveRestrictsForParentMutation` and
  `assertNoRestrictedChildrenForParentMutation` finalize prepared statements in `finally`
  blocks; the new call adds no `any`, no new imports. Clean.

### Minor findings — fixed inline (this pass)

- **Two coverage gaps the handoff honestly flagged are now closed**, both added to
  `55.1-eviction-restrict-fk.sqllogic` and passing on memory **and** store:
  - **Case 5 — transitive depth-2.** Eviction whose `ON DELETE CASCADE` child has its own
    `ON DELETE RESTRICT` grandchild: the post-eviction walk recurses through the
    (not-yet-cascaded) child and the grandchild's RESTRICT blocks the whole statement; all
    three levels assert unchanged. Plus a positive companion (grandchild also CASCADE → the
    depth-2 eviction succeeds and both levels are removed). This proves the *transitive*
    walk, not just the direct scan, fires for evictions.
  - **Case 6 — multi-row statement atomicity.** A RESTRICT-violating eviction inside a
    multi-row `insert or replace … values (a),(b)` unwinds the *whole* statement — the
    prior, otherwise-valid row is asserted **not** inserted — matching SQLite's per-statement
    atomicity.

### Major findings — none

No correctness, resource, or type-safety defects found. The single behavioral change is
minimal, mirrors the established plain-DELETE pre-check, and the savepoint rollback is
proven by the data-unchanged assertions (not a vacuous green).

### Deferred / out of scope (no new ticket warranted)

- **Rowid-chained backends (lamina).** Unchanged status quo — the post-eviction transitive
  recursion cannot dereference the already-removed parent for a rowid-chained FK column.
  This mirrors the pre-existing, documented SET-DEFAULT recursion gap
  (`foreign-key-actions.ts:201-208`) and is *no regression beyond status quo*. All
  verified substrates (memory, store) are key-based. No lamina/rowid harness exists here to
  test against; left as documented out-of-scope rather than spawning a ticket, since it is
  not a new defect.
- **`yarn test:full` / cross-package** not run. The change is confined to `dml-executor.ts`
  with no cross-package importers of the edited path; risk is low. A full release run is the
  human/CI call.

## Validation performed (this review pass)

- `mocha --grep "eviction"` (memory): 2 passing (55 + 55.1), exit 0 — includes the new
  cases 5 & 6.
- `mocha --grep "eviction"` with `QUEREUS_TEST_STORE=true` (LevelDB store): 2 passing,
  exit 0 — store parity for the new cases confirmed.
- `yarn lint` (packages/quereus): exit 0, no findings. (The test addition is a `.sqllogic`
  fixture, outside the lint globs; src was not touched in this pass.)

No `.pre-existing-error.md` written — no unrelated failures observed.
