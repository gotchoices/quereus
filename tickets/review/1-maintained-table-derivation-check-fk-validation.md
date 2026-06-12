description: Review — declared CHECK + child-side FK constraints are now validated against rows a maintained-table derivation writes (create-fill, attach/re-attach reconcile, steady-state row-time maintenance), failing the writing statement with a maintained-table-attributed CONSTRAINT diagnostic. Implements Option 2 of the triage for CHECK + FK; secondary UNIQUE is the chained follow-on (`maintained-table-derivation-secondary-unique`).
prereq:
files:
  - packages/quereus/src/core/derived-row-validator.ts                    # NEW — per-row evaluator (compile via DML builders, inline/deferred dispatch)
  - packages/quereus/src/core/database-materialized-views.ts              # derivedRowValidator on MaintenancePlanCommon; hooks in maintainRowTime + flushDeferredRebuilds; validateDerivedChanges
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts        # validateDeclaredConstraintsOverContents (bulk, stripped-schema swap); attach hook; replaceContents deferral comments
  - packages/quereus/src/schema/constraint-builder.ts                     # validateChecksOverExistingRows (new), onViolation on validateForeignKeyOverExistingRows, attribution helpers
  - packages/quereus/src/vtab/backing-host.ts                             # "Constraint validation — engine-owned" contract section
  - packages/quereus/test/logic/51.8-maintained-table-declared-constraints.sqllogic   # NEW — SQL-level behaviors (passes on memory AND store backends)
  - packages/quereus/test/maintained-table-declared-constraints.spec.ts   # NEW — zero-overhead spies, explicit-txn deferral, cascade attribution
  - docs/materialized-views.md                                            # § Derived-row constraint validation (declared CHECK / FK)
  - tickets/backlog/maintained-table-refresh-revalidation.md              # NEW backlog ticket — refresh gap found during implementation
difficulty: hard
----

# Review: maintained-table derived-row CHECK / FK validation

## What was built

Declared CHECK and child-side FK constraints on a `create table … maintained
as` table were decoration — every derivation write bypassed them through the
privileged backing surface. Now every derivation write path validates, with a
diagnostic attributed to the maintained table (the failing statement targets a
different table, so attribution is load-bearing):

```
CHECK constraint failed: <name> (<expr>) — row derived into maintained table 'main.mt' violates its declared constraint
FOREIGN KEY constraint failed: <name> — row derived into maintained table 'main.mt' references a missing 'main.parent'
```

Two mechanisms, one semantic (documented in docs/materialized-views.md
§ Derived-row constraint validation):

1. **Bulk (create-fill / attach / re-attach)** —
   `validateDeclaredConstraintsOverContents` in
   `runtime/emit/materialized-view-helpers.ts`, called inside the attach core's
   reconcile try (so `restorePrior` + statement rollback cover failure). Runs
   `validateChecksOverExistingRows` (new sibling in
   `schema/constraint-builder.ts`, `select 1 from t where not (<expr>) limit 1`
   per CHECK) and the existing `validateForeignKeyOverExistingRows` per FK,
   both with attributed `onViolation` overrides, over the table's effective
   pending-over-committed contents.

   **Key subtlety the reviewer should scrutinize:** the optimizer trusts
   DECLARED constraints as proven invariants — `ruleFilterContradiction` /
   `ruleAntiJoinFkEmpty` would fold the validation scans to EmptyRelation,
   because (unlike the ALTER ADD paths) the constraints under validation are
   already on the live record. The live record is therefore swapped for a
   constraint-stripped clone for the duration of the scans and restored in a
   `finally` (the ADD COLUMN intermediate-schema discipline). Confirmed
   experimentally: without the strip, a NOT NULL FK validation folds away.

2. **Steady state (per-row)** — `core/derived-row-validator.ts` (new).
   `registerMaterializedView` compiles a `DerivedRowConstraintValidator` onto
   the maintenance plan (`MaintenancePlanCommon.derivedRowValidator`,
   `undefined` when nothing declared — the zero-overhead gate). Compilation
   reuses the DML pipeline's own builders (`buildConstraintChecks` with an
   INSERT-shaped OLD/NEW attribute pair; `buildChildSideFKChecks` built per
   single-FK schema view so checks pair with their FK), then optimizes each
   expression standalone (`db.optimizer.optimize(expression, db)`) and emits a
   scheduler. `maintainRowTime` validates each insert/update
   `BackingRowChange`'s newRow BEFORE cascading; `flushDeferredRebuilds`
   validates the full-rebuild diff at the statement flush. Non-subquery CHECKs
   evaluate inline (immediate attributed abort); subquery CHECKs and all FK
   checks (`needsDeferred`) route to `db._queueDeferredConstraintRow` with a
   wrapped evaluator that throws the attributed error itself (the queue's
   generic message never fires).

Semantics: CHECK op-mask collapse (any CHECK intersecting insert|update applies
to every written image, OLD section all-NULL); FK pragma re-read at evaluation
time (no retro-validation on flip); MATCH SIMPLE; always hard abort (no
IGNORE/REPLACE masking); delete deltas never CHECK-validated.

## Validation performed

- `yarn build` (full monorepo) clean; `yarn lint` clean.
- `yarn test` (all workspaces): 5986 passing in quereus (+8 new), zero
  failures, all other workspaces green — existing 51.x/53.x suites unaffected.
- New logic file passes on BOTH backends: memory (`yarn test`) and LevelDB
  (`node test-runner.mjs --store --grep "51.8"`). Full `yarn test:store` was
  NOT run (only the targeted file) — deferred per ticket allowance.
- Manually smoke-tested beyond the suites: deferred-FK satisfied-by-commit,
  commit-time rollback, pragma flip both directions, re-attach restorePrior
  with live prior plan, full-rebuild flush, two-level cascade.

## Use cases to probe in review

- Create-fill violation drops the half-built table (name stays free).
- Steady-state insert AND update images validate; statement rolls back whole.
- FK: create-fill orphan, steady-state orphan (deferred → fails autocommit /
  explicit commit), NULL FK column admitted, pragma off→on validates only new
  deltas.
- Subquery CHECK defers; mid-txn violation healed before commit passes.
- Op-mask collapse: `check on update` fires on derived insert, `check on
  insert` fires on derived update, delete-only CHECK never fires.
- Attach over a pre-existing violator the derivation does NOT reproduce:
  reconcile deletes it, attach succeeds (detach-no-strand falls out).
- Re-attach violation restores the prior derivation + plan (a1 write still
  maintains).
- Cascade: mt2-over-mt1 violation attributes to mt2; producer level rolls back.
- Zero-overhead: spies prove no prepare / no deferred enqueue on writes to
  constraint-less maintained tables and MV-sugar tables.

## Known gaps / honest flags (reviewer: treat tests as a floor)

- **Refresh gap (filed, not fixed):** `refresh materialized view` →
  `rebuildBacking` → `replaceContents` swaps COMMITTED contents with no
  validation. For a continuously-maintained table the refresh re-derives an
  already-validated set, so exposure is the STALE-table refresh (plan released,
  source writes unvalidated, refresh commits them). Backlog ticket
  `maintained-table-refresh-revalidation` + comments at both `replaceContents`
  call sites. The ticket's premise that rebuildBacking "operates only on
  MV-sugar backings" was inaccurate — refresh reaches table-form maintained
  tables — hence the comment documents the actual reasoning rather than
  asserting.
- **Stripped-schema swap window:** the bulk scan `await`s while the
  constraint-stripped record is registered; a concurrent statement on the same
  Database could observe it mid-attach. Consistent with the existing
  restorePrior catalog-flip patterns (DDL here is not isolated), but worth a
  reviewer's eye.
- **Standalone scalar optimization:** `db.optimizer.optimize()` on a bare
  `ScalarPlanNode` (not a Block root) is a novel entry use; it works (verified
  including EXISTS subqueries evaluated at commit), but no other call site does
  this. If a future pass assumes relational roots this breaks loudly.
- **Per-row inline eval cost:** one fresh RuntimeContext + row slot per
  validated image (hoisted across checks, not across rows). Fine for typical
  deltas; a hot bulk write over an inline-CHECK-bearing maintained table pays
  it per row.
- **Deferred connectionId pinning:** queued entries pin the backing connection
  (resolved via the per-statement cache or deterministic re-resolve). If that
  connection disappears before commit the queue throws INTERNAL — the same
  exposure class as DML's captured activeConnection, but new surface.
- **External-change ingestion** (`ingestExternalRowChanges`) flows through
  `maintainRowTime` and therefore validates — not directly tested.
- **`pragma nondeterministic_schema`** is honored transitively (the reused
  `buildConstraintChecks` gates determinism); no direct test. A
  non-deterministic CHECK without the pragma now throws at
  registerMaterializedView (create/attach roll back cleanly) — also untested
  directly.
- Store-backend note: a text PK on a maintained table collates NOCASE under
  the store default and fails the attach SHAPE check before validation; the
  full-rebuild logic test was written integer-keyed for backend neutrality
  (pre-existing behavior, not a regression).
