description: Review the null-safe parent-side FK UPDATE short-circuit guard fix — a value→NULL update of a *nullable* referenced parent key while a child references the old value now ABORTs (parity with physical RESTRICT), via a guard built from existing AST node kinds. Verify soundness, benign-update preservation, and DELETE untouched.
files: packages/quereus/src/planner/mutation/lens-enforcement.ts, packages/quereus/test/lens-enforcement.spec.ts, docs/lens.md
----

## What changed

The lens parent-side FK UPDATE short-circuit guard (`buildParentSideUpdateGuard` in
`planner/mutation/lens-enforcement.ts`) previously compared the referenced key with
plain `=`:

```
( (OLD.p1 = NEW.p1 and … and OLD.pn = NEW.pn) or <NOT EXISTS over OLD> )
```

For a **nullable** referenced parent key, a value→NULL update made `OLD.p = NEW.p`
evaluate to NULL, and `NULL or <false NOT EXISTS> = NULL`, which the
deferred-constraint check (`value === false || value === 0` in
`runtime/deferred-constraint-queue.ts`) does **not** treat as a failure — so an
orphaning update was wrongly allowed, diverging from physical RESTRICT.

The fix introduces `buildNullSafeEquality(col)`, a per-column null-safe
(`is not distinct from`) comparison synthesized from only existing AST node kinds:

```
( OLD.p is null and NEW.p is null )
  or ( OLD.p is not null and NEW.p is not null and OLD.p = NEW.p )
```

This form was chosen deliberately over the naive
`(OLD.p = NEW.p) or (OLD.p is null and NEW.p is null)`, which yields `NULL` (not
`false`) when exactly one side is NULL — the original bug in a different shape.
**An initial implementation used the naive form and the value→NULL test still
passed-through (did not abort); the proper three-arm form was required.** The guard
now evaluates to a definite `false` for a value→NULL key change, falling through to
the `NOT EXISTS`, which finds the child ⇒ ABORT.

`buildParentSideUpdateGuard` now maps each parent basis column through
`buildNullSafeEquality` instead of building a plain `=`. DELETE is unchanged (still
the plain `NOT EXISTS` — it gets no guard, by op-specific synthesis).

## Behavior / acceptance (all covered by tests, in the
`lens enforcement: parent-side FK RESTRICT at the write boundary` describe block)

- **value→NULL orphaning update ABORTs.** Schema `parent(id pk, email text null,
  unique(email))`, `child(... pemail references parent(email))`, data
  `parent(1,'a@x')` + `child(10,'a@x')`. `update x.parent set email = null where
  id = 1` now ABORTs; the row is rolled back. (Was the soundness gap.)
- **NULL→NULL benign no-op succeeds** via the `is null and is null` arm
  (short-circuits true, no `NOT EXISTS`).
- **value→value benign update on a non-key / unchanged key still succeeds** (the
  existing `update … set name = 'renamed'` short-circuit test stays green; a new
  `set id = id` case confirms it too).
- **Unit assertion** on the synthesized UPDATE SQL: both the plain `OLD.email =
  NEW.email` arm and the `OLD.email is null and NEW.email is null` arm are present;
  the DELETE form has no `NEW.email` reference (no guard).

## Validation performed

- `yarn build` (quereus) — clean.
- Full `node test-runner.mjs` suite — **4343 passing, 9 pending, 0 failing.**
- `lens enforcement: parent-side FK` describe — 39 passing; full `lens enforcement`
  — 93 passing.
- eslint on the two changed source/test files — exit 0.
- `docs/lens.md` § Foreign key parent-side paragraph updated: the `≡` short-circuit
  guard is now documented as null-safe and the prior **v1 divergence** caveat
  (which referenced this ticket) was removed.

## Reviewer notes / known gaps

- **Reach.** This case requires an FK referencing a *nullable* unique column —
  unusual; references to NOT-NULL / PK keys are unreachable (the null arms are dead,
  the predicate collapses to plain `=`, exact physical parity). The fix is narrow by
  construction; the broad-impact risk is low.
- **Composite nullable keys** are not separately tested here — `buildNullSafeEquality`
  is applied per-column and the AND-reduction is unchanged, so a composite key gets a
  null-safe arm per column, but a reviewer may want a composite value→NULL test for
  one component (existing composite tests use NOT-NULL PK parents).
- **Physical-parity probe not re-run.** The ticket's empirical confirmation was a
  standalone `ABORTED? false` probe against the *old* code; I validated the fix via
  the in-suite tests rather than re-running that probe. A reviewer wanting to mirror
  the original repro can adapt it.
- **Unrelated working-tree changes.** `packages/quereus/src/core/database-watchers.ts`
  and `database.ts` carry unrelated, seemingly half-finished `notifyExternalChange`
  edits that were present in the working tree at session start (not authored by this
  ticket) and produce the only `yarn lint` error (`DeltaApplyInput` unused). Flagged
  in `tickets/.pre-existing-error.md`; left untouched.
