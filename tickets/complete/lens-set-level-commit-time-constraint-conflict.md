description: Deploy-time rejection of a commit-time lens set-level key whose UNIQUE/PK declares a constraint-level `on conflict replace`/`ignore` it can never honor. New blocking prover error `lens.unenforceable-conflict-action` (raised in `classifyKeyConstraint`) plus a defensive partial-UNIQUE guard. Replaces the prior silent over-ABORT-at-commit behavior.
files: packages/quereus/src/schema/lens-prover.ts, packages/quereus/src/schema/table.ts, packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/test/lens-prover.spec.ts, docs/lens.md
----

## What shipped

A commit-time lens set-level key (a logical `unique`/PK with no basis covering structure) whose UNIQUE/PK carried a **constraint-level** `on conflict replace`/`ignore` previously silently ABORTed a duplicate at commit instead of honoring the declared action — the write-time gate (`rejectLensSetLevelConflictResolution`) only inspects *statement-level* `onConflict`, so the constraint-level channel was never caught.

The fix is **deploy-time only**: `lens-prover.ts` now rejects the unsound schema at `apply schema` with a new blocking error `lens.unenforceable-conflict-action`, so no commit-time key carrying a REPLACE/IGNORE default can deploy. `classifyKeyConstraint`'s `!readOnly` block resolves the effective constraint-level default (via `effectiveKeyDefaultConflict`) and pushes the error for REPLACE/IGNORE; ABORT/FAIL/ROLLBACK/none are untouched. A defensive partial-UNIQUE guard (`lens.unrealizable-constraint`) is also raised for a commit-time `unique` whose `predicate` is set (unreachable today — invariant lock). `docs/lens.md` § Constraint Attachment flipped the "Known gap" to "resolved."

## Review findings

**Diff reviewed first, fresh, before the handoff summary** (`git show 7aa480f5`). Disposition: one **minor correctness bug fixed inline** (with a regression test), one **major out-of-scope gap filed as a new ticket**, plus a DRY consolidation. All else verified sound.

### Fixed inline (minor)

- **PK effective-conflict read only the *first* PK column — a reachable hole.** `effectiveKeyDefaultConflict`'s `primaryKey` branch read only `ctx.table.columns[firstPkIndex]?.defaultConflict`. The handoff argued non-first PK columns can't carry a column-level conflict action ("column-level PK on >1 column is a multiple-PK error"). That reasoning only considered the column-level **`primary key`** channel. A column's `defaultConflict` is **also** set by a column-level **`not null on conflict X`** / **`null on conflict X`** clause (`schema/column.ts:170-184`). So a multi-column **table-level** PK whose *non-first* PK column carries `not null on conflict replace` resolves to REPLACE in the runtime (`resolvePkDefaultConflict` iterates **all** PK columns, and `TableSchema.primaryKeyDefaultConflict`'s own doc says "column-level `defaultConflict` on **any** PK column") — but the prover read only the first column and let it deploy, **reopening the silent-over-ABORT bug for that shape**. Confirmed reachable with a failing-then-passing regression test (deployed clean pre-fix, throws post-fix). **Fix:** routed the PK branch through a new shared `resolvePkDefaultConflict(schema)` exported from `schema/table.ts` (iterates all PK columns), so the deploy-time check agrees with what the runtime resolves. The helper's own doc-comment claim of "mirroring the documented precedence" is now actually true.

- **DRY consolidation (rolled into the same fix).** `resolvePkDefaultConflict` was triplicated (memory layer / `quereus-isolation` / `quereus-store`). Extracted the canonical copy to `schema/table.ts` and routed the in-package memory-layer resolver (`vtab/memory/layer/manager.ts`) through it (identical logic — byte-for-byte behavior). The two cross-package copies (`quereus-isolation`, `quereus-store`) operate on their own boundaries and are left for a separate cross-package consolidation (noted in the helper's doc-comment); not in this review's blast radius.

### Filed as a new ticket (major, out of scope)

- **Row-time logical conflict action is the same class of gap, still open** → `tickets/fix/lens-set-level-rowtime-logical-conflict-action-not-honored.md`. The fix scopes strictly to commit-time. For a **row-time** key the write-time gate is skipped and the basis re-plan resolves conflicts as `statement OR > basis-UC defaultConflict > ABORT` — the *logical* constraint's `defaultConflict` is never threaded. So a logical `unique(email) on conflict replace` over a *plain* basis UC (no action) + covering MV silently resolves to ABORT, not replace. Verified by inspection (`view-mutation-builder.ts:63-66`); not reproduced end-to-end. Out of scope for the commit-time ticket; the new fix ticket carries the repro + the honor-vs-reject disposition.

### Verified, no action needed

- **No ALTER-logical path reopens the deploy-time-only soundness (handoff concern #3).** Searched for an ALTER-like mutation of a deployed logical slot's constraint-level `defaultConflict`; none exists. The only path to change a logical key's conflict action is re-declare + `apply schema`, which re-runs `proveLens` → the new error gates it. The write-time fallback being omitted is therefore safe.
- **Advisory drift guard intact.** `lens.unenforceable-conflict-action` is an **error** code (added to `LensErrorCode` only), correctly absent from `ADVISORY_CODE_LIST` / `ACKNOWLEDGEABLE_ADVISORY_CODES`; `lens-ack.spec.ts` still asserts exactly the four advisory codes and passes.
- **Partial-UNIQUE guard is genuinely dead code today (handoff concern #4).** A logical declaration never synthesizes `UniqueConstraintSchema.predicate` (only `CREATE UNIQUE INDEX … WHERE` does, a path the declaration surface never takes). Reuses the existing `lens.unrealizable-constraint` code appropriately. The invariant-lock test guards the assumption.
- **`unique` effective-conflict read is correct.** A column-level `email text unique on conflict replace` lands its action on `UniqueConstraintSchema.defaultConflict` (`manager.ts` `extractUniqueConstraints`), which the `unique` branch reads — no first-column hole there (unique is single-source per constraint, not a multi-column table PK).
- **No new write-time test needed (handoff concern #5).** The failure moved earlier to deploy time; the existing `lens-enforcement.spec.ts` commit-time suite still covers the plain-insert ABORT floor for keys without a declared action.

### Validation (all green)

- `yarn typecheck` — clean
- `yarn lint` — clean
- `yarn test` (memory-backed) — **4235 passing, 9 pending** (+1 = the new PK regression test). Targeted `lens-prover.spec.ts` = 26 passing; `lens-ack.spec.ts` + `lens-enforcement.spec.ts` = 62 passing.
- `yarn test:store` — not run (this change is deploy-time schema validation + an identical-logic helper extraction; the store code path is not exercised). Left to CI/human, consistent with the implement stage's deferral.

## Tests added this stage

- `lens-prover.spec.ts`: "a commit-time multi-column PK whose NON-FIRST column carries column-level `not null on conflict replace` blocks the deploy" — regression lock for the inline fix.
