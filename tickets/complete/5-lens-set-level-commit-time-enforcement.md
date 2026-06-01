description: Live per-write enforcement of the lens prover's `enforced-set-level{mode:'commit-time'}` obligation — a logical `unique`/PK with no basis covering structure, realized as a deferred `(select count(*) from <logicalView> as _u where _u.lk = NEW.bk …) <= 1` count-subquery CHECK routed through the same `extraConstraints` seam as the row-local and FK classes. `or replace`/`or ignore`/upsert against such a key is rejected up front. Third enforcement class after row-local + FK. Completed and reviewed.
files: packages/quereus/src/planner/mutation/lens-enforcement.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/planner/mutation/mutation-diagnostic.ts, packages/quereus/src/schema/lens-prover.ts, packages/quereus/test/lens-enforcement.spec.ts, docs/lens.md
----

## What shipped

The third lens enforcement class, sibling to the shipped row-local CHECK and
child-side FK existence classes — all three contribute to the same
`extraConstraints` array on the basis insert/update.

- **Collector** (`planner/mutation/lens-enforcement.ts`):
  `collectLensSetLevelConstraints(slot)` reads `slot.obligations`, selects
  `enforced-set-level{mode:'commit-time'}` over a `primaryKey`/`unique`, and
  synthesizes (via `synthesizeUniqueCountExpr`) a deferred `(select count(*) from
  <logicalSchema>.<logicalTable> as _u where _u.lk = NEW.bk …) <= 1` CHECK —
  logical names inside the subquery, basis names (via the reused
  `logicalToBasisColumnMap`) on the `NEW.*` side. Tagged `LENS_BOUNDARY_ATTACHED_TAG`,
  named `lens:pk` / `lens:unique[:<name>]`. `hasCommitTimeSetLevelObligation(slot)`
  is the predicate the rejection consults.
- **Wiring** (`view-mutation-builder.ts`): `lensSetLevelConstraints(ctx, view)`
  appended to `extraConstraints` (non-delete); `rejectLensSetLevelConflictResolution`
  rejects `insert or replace`/`or ignore`/any upsert against a commit-time set-level
  slot before `propagate`.
- **Diagnostic** (`mutation-diagnostic.ts`): new reason
  `lens-set-level-conflict-resolution`.
- **Why it is correct:** the contained scalar subquery makes `buildConstraintChecks`
  auto-defer the check to commit (same mechanism the FK class relies on). At commit
  the logical view reflects the post-mutation basis: a unique key sees count `1`,
  a duplicate `≥ 2` ⇒ ABORT. NULL-distinct falls out for free. No new machinery,
  no `core/database-assertions.ts` coupling.

## Review findings

Adversarial pass over commit `8b0ea8c0`. Build, lint, and the full memory-backed
suite were re-run from a clean tree; the implement diff was read in full before the
handoff summary.

### Validation (all green, re-run during review)
- `yarn workspace @quereus/quereus run build` — exit 0.
- `yarn workspace @quereus/quereus run lint` — exit 0.
- `yarn workspace @quereus/quereus run test` (full suite) — **4212 passing**, 9
  pending, exit 0. No regressions; no `.pre-existing-error.md` needed.
- The review changed only `docs/lens.md` (prose) and added tickets — no source
  edits — so the above results carry.

### Checked — type safety & wiring
- The `MutationRequest` discriminated union (`propagate.ts`) makes the
  `req.op !== 'insert'` early-return in `rejectLensSetLevelConflictResolution`
  correctly narrow `req.stmt` to `InsertStmt` before reading `onConflict`/`upsertClauses`
  — type-safe.
- `UpdateStmt` (`parser/ast.ts`) carries **no** `onConflict` field, so the
  handoff's claim that "only INSERT needs the conflict-resolution gate" holds —
  Quereus has no `update or ignore` surface.
- The new `lens-set-level-conflict-resolution` reason is fully wired:
  `raiseMutationDiagnostic` throws with the message and no separate reason→code map
  needs updating.
- `setLevelKeyColumns` accesses `.index` (PK columns) / `.columns` (UNIQUE) against
  the actual `PrimaryKeyColumnDefinition` / `UniqueConstraintSchema` shapes — correct.
- The `count(*)` synthesis (`FunctionExpr{name:'count', args:[]}`) renders and
  enforces correctly end-to-end (covered by tests, confirmed in the re-run).

### Found — MAJOR → new ticket `tickets/fix/lens-set-level-commit-time-constraint-conflict.md`
`rejectLensSetLevelConflictResolution` inspects only the **statement-level**
`req.stmt.onConflict` / `upsertClauses`. Quereus also honors a **constraint-level**
default conflict action (`UniqueConstraintSchema.defaultConflict`; three-tier
resolution in `vtab/memory/layer/manager.ts` + `quereus-isolation`). A logical
`unique(email) on conflict replace` (or a PK column's `on conflict ignore`) with no
covering structure classifies `commit-time`, and a *plain* `insert` of a duplicate
then **silently ABORTs at commit** instead of honoring the declared REPLACE/IGNORE —
the exact failure the rejection was built to prevent, reached through the
constraint-level channel. Sound (never admits a duplicate) but the declared action
is silently dropped. Confirmed reachable: `schema/manager.ts` populates
`defaultConflict` from a logical `unique … on conflict …`. The fix needs a design
call (prefer deploy-time proving over a per-write rejection), so it is filed rather
than patched inline. The new ticket also folds in the **secondary, currently
unreachable** partial-predicate gap (`synthesizeUniqueCountExpr` ignores a
`UniqueConstraintSchema.predicate`; a logical-schema UNIQUE cannot carry one today,
so it is a latent over-count, not a live bug). A one-line note was added to
`docs/lens.md` § Constraint Attachment so the limitation is documented now.

### Checked — multi-source / decomposition boundary (no new ticket)
Both the set-level enforcement and the conflict-resolution rejection sit *after* the
multi-source-insert / decomposition-insert early returns in `buildViewMutation`, so
neither fires on those paths (which pass `extraConstraints: []` to member inserts).
A multi-source/decomposition lens with a commit-time set-level key therefore gets no
lens-level uniqueness enforcement **and** no rejection. This is **consistent with the
already-shipped row-local and FK classes** (identical `extraConstraints`-after-early-
returns boundary) — not a regression introduced here — and is the implementer's
explicitly-flagged boundary. Multi-source put fan-out is heavily restricted upstream.
Left as a documented boundary; no new ticket.

### Checked — empty / negative categories
- **Error paths:** the `logicalColumns.length === 0` guard (vacuous singleton key)
  and the `proved` / `row-time` negative cases are covered by tests and behave (the
  collector returns `[]`). Verified in the re-run.
- **Resource cleanup / async / performance:** no new resources, subscriptions, or
  teardown; cost is the documented O(n)-per-changed-row scan (the row-time sibling
  upgrades it). Nothing to flag.
- **DRY:** the new collector mirrors the row-local/FK collectors' obligation-loop +
  `logicalToBasisColumnMap` structure. Acceptable sibling mirroring; the row-time
  ticket already notes a shared-helper factoring opportunity.
- **Docs:** `docs/lens.md`, `lens-prover.ts` and `lens-enforcement.ts` module docs
  were read against the new reality and reflect it (plus the review's gap note).

## Follow-ups (already-filed siblings, not regressions)
- `lens-set-level-rowtime-enforcement` (plan/) — O(log n) row-time enforcement +
  statement-level conflict resolution via the covering structure. Takes this ticket
  as prereq.
- `lens-set-level-commit-time-constraint-conflict` (fix/, **new this review**) — the
  constraint-level `defaultConflict` over-abort gap above.

## Scope boundary

Detection-only. `core/database-assertions.ts` deliberately untouched.
