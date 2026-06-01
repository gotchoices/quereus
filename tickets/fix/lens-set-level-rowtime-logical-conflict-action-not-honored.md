description: A logical set-level key (`unique`/PK) classified **row-time** (backed by a basis UNIQUE + non-stale covering MV) whose UNIQUE/PK declares a **constraint-level** `on conflict replace`/`ignore` can silently resolve to ABORT at write time when the backing **basis** UC carries no matching conflict action. The lens re-plans against the basis, where conflict resolution is `statement-level OR > basis-UC defaultConflict > ABORT` — the *logical* constraint's `defaultConflict` is never threaded. This is the row-time analogue of `lens-set-level-commit-time-constraint-conflict` (which closed the commit-time channel at deploy time); the row-time channel is still open.
files: packages/quereus/src/planner/mutation/lens-enforcement.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/schema/lens-prover.ts, packages/quereus/test/lens-enforcement.spec.ts
prereq: lens-set-level-commit-time-constraint-conflict
----

## The gap

`lens-set-level-commit-time-constraint-conflict` closed the **commit-time** channel: a commit-time set-level key declaring a constraint-level `on conflict replace`/`ignore` is now rejected at `apply schema` (`lens.unenforceable-conflict-action`), because a commit-time count scan can only ABORT.

The **row-time** channel was deliberately left untouched on the theory that "row-time can honor REPLACE/IGNORE." That is only *capable*, not *guaranteed*:

- A row-time key is enforced by re-planning the lens write against the **basis** table (`planner/mutation/single-source.ts`), where the conflict action resolves as `statement-level OR > basis-UC defaultConflict > ABORT` (`view-mutation-builder.ts` skips `rejectLensSetLevelConflictResolution` for row-time; the basis UC's covering-MV path owns resolution).
- The **logical** constraint's own `defaultConflict` is **not** consulted in that re-plan. So a logical declaration

  ```sql
  declare logical schema x {
    table u (id integer primary key, email text null, unique (email) on conflict replace)
  }
  ```

  backed by a *plain* basis `unique (email)` (no declared action) **plus** a covering MV (which makes it row-time) resolves a duplicate to **ABORT**, not REPLACE — the declared action is silently not honored.

This is the same "declared conflict action silently dropped" class the commit-time ticket fixed, but on the row-time path. Verified by inspection (`view-mutation-builder.ts:63-66` + `rejectLensSetLevelConflictResolution`); **not** reproduced end-to-end yet — the existing row-time deploy-clean test (`lens-prover.spec.ts`, "`on conflict replace` on a row-time key … deploys clean") only asserts the *classification*, never that a write actually replaces.

## What to reproduce

- Basis `u (id pk, email)` with a plain `unique(email)` **and no** declared conflict action; add a covering MV `order by email`.
- Logical `u` re-declares `unique(email) on conflict replace`.
- `apply schema` deploys clean (correct — row-time is capable).
- `insert` a duplicate `email`: confirm whether it ABORTs (gap) or REPLACEs (already fine). The conjecture is ABORT.
- Contrast: a basis UC that *itself* declares `on conflict replace` (matching declaration) — that path is already exercised by the row-time `or replace` tests in `lens-enforcement.spec.ts` (which rely on statement-level OR or a matching basis action).

## Expected behavior / disposition options

Either of (decide in fix/implement):

1. **Honor it.** Thread the logical key's effective `defaultConflict` (PK via `resolvePkDefaultConflict(ctx.table)`, unique via the constraint's `defaultConflict`) into the basis re-plan so the row-time enforcement resolves to the declared action when neither a statement-level OR nor a matching basis-UC action is present.
2. **Reject it at deploy**, mirroring the commit-time fix: if a row-time logical key declares a constraint-level conflict action the backing basis UC cannot honor (basis UC has a *different* or *no* action and no statement-level override is possible), raise a blocking prover error. Less useful but consistent and sound.

Option 1 is the user-expected semantics; option 2 is the conservative floor. Prefer 1 if the basis re-plan can carry the action cleanly; fall back to 2 if threading proves invasive.

## Notes for the implementer

- `resolvePkDefaultConflict` is now an exported helper in `schema/table.ts` (added by the commit-time ticket's review) — reuse it for the PK effective-action read; don't re-derive.
- Row-time classification + revalidation lives in `lens-prover.ts` (`findBasisCoveringStructure`, `revalidateRowTime`). The basis-UC currency check there is the natural place to also compare declared actions if option 2 is chosen.
- Keep this scoped to **child-side** set-level keys; parent-side FK actions through the lens remain out of scope (per `docs/lens.md` § Constraint Attachment).
