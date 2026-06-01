description: Closed the row-time set-level conflict-action leak — a logical `unique`/PK declaring `on conflict replace`/`ignore` whose backing basis UC cannot honor it was silently dropped to ABORT at write time. Now rejected at `apply schema` with `lens.unenforceable-conflict-action`, symmetric with the commit-time sibling. Sound deploy-time floor (option 2); true per-key honoring (option 1) deferred.
files: packages/quereus/src/schema/lens-prover.ts, packages/quereus/test/lens-prover.spec.ts, packages/quereus/test/lens-enforcement.spec.ts, docs/lens.md
----

## What shipped

A row-time logical set-level key is enforced by re-planning the lens write against the **basis** table, where the conflict action resolves `statement-OR ?? basis-uc.defaultConflict ?? ABORT` — the *logical* key's own `defaultConflict` is never consulted. So a logical `on conflict replace`/`ignore` the backing basis UC does not itself carry was silently dropped to ABORT at write time. The fix rejects this at deploy in the row-time branch of `classifyKeyConstraint` (`schema/lens-prover.ts`), mirroring the existing commit-time `lens.unenforceable-conflict-action` block.

Mechanism:
- The row-time branch resolves the covering via `findBasisCovering` (returns `{ ref, uc }`) so the backing basis `UniqueConstraintSchema` is in hand; the thin `findBasisCoveringStructure` wrapper was removed.
- New `rejectRowTimeConflictAction(...)` pushes `lens.unenforceable-conflict-action` (severity `error`) when `!readOnly`, the logical effective action (`effectiveKeyDefaultConflict`) ∈ {REPLACE, IGNORE}, **and** it differs from `covering.uc.defaultConflict` (matching → basis honors it for free, no reject). New `conflictActionName(action)` renders the enum for the message.

Verdict table (logical effective / basis-UC action → verdict): REPLACE|IGNORE over no-action/FAIL/ROLLBACK/explicit-ABORT/mismatched → **reject**; REPLACE/REPLACE & IGNORE/IGNORE → no reject; ABORT/FAIL/ROLLBACK/none logical → no reject.

Remediation: declare the matching `on conflict <action>` on the basis UNIQUE/PK (the basis UC then resolves it for free), or drop the logical conflict action.

## Review findings

### Scope of review
Read the full implement-stage diff (`2b2df455`) — `lens-prover.ts`, both spec files, `docs/lens.md` — before the handoff summary. Scrutinized for soundness of the core premise, the reject condition's truth table, helper correctness, dead-code/reference hygiene, the rewritten pre-existing test, and the documented known-gaps. Ran typecheck, lint, targeted specs, and the full memory suite.

### Correctness / soundness — checked, sound
- **Core premise verified against the actual runtime resolvers.** The row-time write path resolves conflicts via `onConflict ?? uc.defaultConflict ?? ConflictResolution.ABORT` — confirmed in `quereus-store/src/common/store-table.ts:1057`, `vtab/memory/layer/manager.ts` (`checkUniqueConstraints` / `checkUniqueViaMaterializedView`), and the isolation layer. The logical key's action is genuinely never consulted. The deploy-time floor is the right fix.
- **`covering.uc.defaultConflict` is always a genuine UNIQUE's action.** `findBasisCovering` matches against `basis.uniqueConstraints`, which by definition **excludes** the PK (`UniqueConstraintSchema` doc: "beyond the primary key"). So the comparison never conflates a PK's `resolvePkDefaultConflict` precedence with a UC's `defaultConflict` — the value compared is exactly what the write path honors. Sound.
- **Truth table** holds for all six logical/basis combinations, including explicit `ABORT` (enum 2, not 0) and `FAIL`/`ROLLBACK` on the basis (mismatch → reject). `ConflictResolution` is a numeric enum starting at 1, so `?? ABORT` is `0`-safe and the `ConflictResolution[...]` reverse-mapping in `conflictActionName` works.
- **Statement-level OR still honored** — the reject targets only the constraint-level default; it cannot and does not inspect `stmt.onConflict`. Existing row-time `or replace`/`or ignore` tests stay green.
- **Reference hygiene** — removed `findBasisCoveringStructure` has zero dangling references; both surviving `findBasisCovering` callers (`classifyKeyConstraint`, `revalidateRowTime`) use the `{ref, uc}` interface correctly.

### Tests — starting point extended
- **Rewritten pre-existing test confirmed legitimate, not bent-to-pass.** The old `… deploys clean — row-time can honor it` encoded the buggy assumption (no-action basis UC + logical REPLACE). Under the now-correct semantics row-time honors only the *basis* UC's action, so that shape must reject; the rewrite to a *matching* basis REPLACE reflects intended semantics.
- **Minor finding, fixed inline:** end-to-end coverage existed only for the matching-**REPLACE** remediation. IGNORE travels a *different* runtime branch (`checkUniqueViaMaterializedView` returns `{status:'ok', row:undefined}` — silently drops the duplicate and **keeps the original**, vs REPLACE's eviction). Added `a matching basis-UC 'on conflict ignore' honors IGNORE on a plain duplicate insert (keeps the original)` to `lens-enforcement.spec.ts` (original id=1 kept, id=2 dropped, count 1). Passes.

### Known gaps — adjudicated
- **PK row-time arm untested:** verified genuinely **unconstructible**, not merely untested. A logical PK is NOT NULL → a matching basis UNIQUE+NOT-NULL *proves* it (`proved`, not row-time); with no basis UNIQUE it falls to commit-time; and `findBasisCovering` never matches the basis PK (excluded from `uniqueConstraints`). The defensive arm is correct-by-reuse via `effectiveKeyDefaultConflict`. No action needed.
- **Store path (`test:store`) not run:** the change is purely deploy-time (the prover is storage-layer-agnostic; no write-path resolver in memory/isolation/store was touched). Low risk; accepted. Memory suite is the agent default.
- **Inverse divergence & option 1** deliberately out of scope per source ticket; documented in `docs/lens.md` as a deferred enhancement (no backlog ticket filed — file `lens-set-level-per-constraint-conflict-channel` only if pursued).

### Other dimensions
- **Docs:** `docs/lens.md` row-time bullets and the maturity narrative updated to state the row-time path honors statement-OR + matching-basis-UC action, rejecting a non-matching logical constraint-level action — accurate and consistent with the code.
- **DRY / SPP / error handling / types:** `rejectRowTimeConflictAction` and `conflictActionName` are small and single-purpose; reuse `effectiveKeyDefaultConflict`; no `any`; the error is pushed-then-obligation-returned, matching the commit-time block. No issues.

### Disposition
No major findings — no new tickets filed. One minor finding fixed inline (IGNORE end-to-end test).

## Validation
- `yarn workspace @quereus/quereus typecheck` → clean.
- `yarn workspace @quereus/quereus lint` → clean (re-run after the test addition).
- `lens-prover.spec.ts` + `lens-enforcement.spec.ts` → 78 passing (was 77; +1 IGNORE end-to-end).
- Full memory-backed suite (`node packages/quereus/test-runner.mjs`) → **4242 passing, 9 pending, 0 failing**.

## Out of scope (carried forward)
- Per-constraint conflict-resolution channel (option 1 — true per-logical-key honoring).
- Inverse divergence (basis UC action leaking into an unrequested lens write).
- Parent-side FK conflict actions through the lens.
