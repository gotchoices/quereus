description: COMPLETE — declared CHECK + child-side FK constraints are validated against rows a maintained-table derivation writes (create-fill, attach/re-attach reconcile, steady-state row-time maintenance, full-rebuild flush, external ingestion), failing the writing statement with a maintained-table-attributed CONSTRAINT diagnostic. Review pass added a registration-time gate rejecting OLD/NEW-image-qualified CHECKs and filed a fix ticket for validator staleness on dependency DDL. Secondary UNIQUE is the chained follow-on (`maintained-table-derivation-secondary-unique`).
files:
  - packages/quereus/src/core/derived-row-validator.ts                    # per-row evaluator (compile via DML builders, inline/deferred dispatch) + OLD/NEW-qualifier gate
  - packages/quereus/src/core/database-materialized-views.ts              # derivedRowValidator on MaintenancePlanCommon; hooks in maintainRowTime + flushDeferredRebuilds
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts        # validateDeclaredConstraintsOverContents (bulk, stripped-schema swap); attach hook
  - packages/quereus/src/schema/constraint-builder.ts                     # validateChecksOverExistingRows; onViolation on validateForeignKeyOverExistingRows; attribution helpers
  - packages/quereus/src/vtab/backing-host.ts                             # "Constraint validation — engine-owned" contract section
  - packages/quereus/test/logic/51.8-maintained-table-declared-constraints.sqllogic
  - packages/quereus/test/maintained-table-declared-constraints.spec.ts
  - docs/materialized-views.md                                            # § Derived-row constraint validation
----

# Complete: maintained-table derived-row CHECK / FK validation

## What was built (implement stage)

Declared CHECK and child-side FK constraints on a `create table … maintained
as` table were decoration — every derivation write bypassed them through the
privileged backing surface. Now every derivation write path validates, with a
diagnostic attributed to the maintained table.

Two mechanisms, one semantic (docs/materialized-views.md § Derived-row
constraint validation):

1. **Bulk (create-fill / attach / re-attach)** —
   `validateDeclaredConstraintsOverContents` scans the table's effective
   pending-over-committed contents (`select 1 from t where not (<expr>) limit
   1` per CHECK; the existing anti-join FK scan per FK) inside the attach
   core's reconcile try. The live record is swapped for a constraint-stripped
   clone during the scans (the optimizer would otherwise fold the scans to
   empty by trusting the declared constraints as proven invariants).

2. **Steady state (per-row)** — `registerMaterializedView` compiles a
   `DerivedRowConstraintValidator` through the DML pipeline's own builders
   (`buildConstraintChecks` over an INSERT-shaped OLD/NEW pair,
   `buildChildSideFKChecks` per single-FK schema view). `maintainRowTime`
   validates each insert/update image BEFORE cascading; `flushDeferredRebuilds`
   validates the full-rebuild diff at the statement flush. Non-subquery CHECKs
   evaluate inline; subquery CHECKs and all FKs route to the
   deferred-constraint queue with attribution threaded through a wrapped
   evaluator.

Semantics: CHECK op-mask collapse (any insert|update CHECK applies to every
written image); no OLD/NEW image references (rejected at registration — added
in review); FK pragma re-read at evaluation time; MATCH SIMPLE; always hard
abort; delete deltas never CHECK-validated; zero overhead when nothing is
declared (MV-sugar backings and constraint-less maintained tables build and
run nothing).

## Review findings

### What was checked

- Full implement diff read first, then every touched file plus the machinery
  it leans on: `buildConstraintChecks` (returns one plan per collapsed
  constraint, in order — the validator's positional pairing is sound),
  `buildChildSideFKChecks` (absent-parent null-guard fallback),
  `_queueDeferredConstraintRow` / deferred-queue parity with the DML path,
  `Schema.addTable` (a plain map write — the stripped-schema swap is
  side-effect-free, no events, no cache churn), the attach core's
  gate-ordering (registration precedes the bulk scan, so registration-time
  throws roll back through the existing restorePrior channel), and the ALTER
  guard on maintained tables (all structural ALTERs including ADD/DROP
  CONSTRAINT are blocked — the compiled validator cannot go stale via
  constraint DDL on the maintained table itself; rename re-registers and
  rebuilds it).
- NOT NULL on derived rows is statically guaranteed by the attach shape check
  (`backingNotNullMatches` rejects a nullable body under a NOT NULL column),
  so its absence from the validator is correct, not a gap.
- The `as unknown as Database` casts match established precedent in
  `database-materialized-views.ts` (documented in the file).
- Empirical probes beyond the suites: external-change ingestion violation is
  rejected with the maintained-table attribution (the handoff had flagged this
  untested); a non-deterministic CHECK without the pragma fails cleanly at
  create and frees the name; a PK-moving source update's violating image is
  rejected; a failed create leaves the catalog intact and re-enforcing; a
  self-referencing subquery CHECK (`(select count(*) from mt) <= n`) works at
  create-fill; renaming the maintained table rebuilds the validator with the
  new attribution.
- Lint clean; root `yarn test` green across all workspaces (5986 quereus,
  zero failures); 51.8 logic file (including the new review section) passes on
  BOTH memory and LevelDB store backends.

### Finding 1 (minor — fixed in this pass)

An `old.`/`new.`-qualified CHECK (transition CHECKs are a supported feature on
ordinary tables) made `create/alter … maintained as` fail with a confusing
`new.v isn't a column` binding error from the bulk SQL scan, which cannot
resolve the image qualifiers the per-row path handles. Since a derived row has
no OLD image (a transition CHECK would be vacuous) and NEW is the row itself
(expressible unqualified), the right behavior is an explicit reject: added a
registration-time gate in `buildDerivedRowValidator` that throws a sited
diagnostic ("references OLD/NEW row images … rewrite the constraint over plain
column names") for any applicable CHECK referencing the qualifiers
(delete-only CHECKs exempt — they never fire on derivation writes). Covered in
sqllogic section 11 (create + attach forms, name freed, plain table restored
with its CHECK still user-enforced, delete-only exemption); documented in
docs/materialized-views.md.

### Finding 2 (major — filed `fix/maintained-table-validator-stale-on-dependency-ddl`)

The validator compiled at registration goes stale when a table it references
that is NOT a derivation source — an FK parent, or a subquery-CHECK target —
is renamed or dropped. Reproduced: renaming the FK parent bricks ALL
subsequent maintenance writes to the maintained table with an internal
"Module connect failed" error (an ordinary child table keeps working);
dropping the parent or the subquery target fails writes with the same
internal error instead of the CONSTRAINT-class behavior of ordinary tables.
Root cause, expected behavior, and the `subscribeToSchemaChanges` extension
seam are documented in the fix ticket (prereq:
`maintained-table-derivation-secondary-unique`, so the invalidation covers the
UNIQUE validators too).

### Honest flags carried forward from implement (reviewed, accepted)

- Refresh gap: `refresh materialized view` of a STALE table re-commits
  unvalidated rows — tracked as `maintained-table-refresh-revalidation`
  (backlog), comments at both `replaceContents` call sites.
- Stripped-schema swap window: the bulk scan awaits while the
  constraint-stripped record is live; consistent with existing
  restorePrior catalog-flip patterns (DDL is not isolated). Verified the swap
  itself has no side effects beyond the map write.
- Standalone scalar optimization (`db.optimizer.optimize` on a bare
  ScalarPlanNode) is a novel entry use; works, breaks loudly if a future pass
  assumes relational roots.
- Per-row inline eval cost: one fresh RuntimeContext + row slot per validated
  image — acceptable for typical deltas.
- Deferred connectionId pinning: same exposure class as DML's captured
  activeConnection.
- Store-backend note: text PKs on maintained tables collate NOCASE under the
  store default (pre-existing), hence the integer-keyed full-rebuild test.

### Empty categories

- No DRY violations found: the attribution helpers, bulk validators, and the
  per-row compile all reuse existing builders rather than duplicating them.
- No resource-cleanup issues found: every prepared scan finalizes in
  `finally`; the row slot closes in `finally`; the stripped record restores in
  `finally`.
- No type-safety regressions: no new `any`; the casts follow file precedent.

## Out of scope (tracked separately)

- Secondary UNIQUE on derivation writes: `maintained-table-derivation-secondary-unique` (implement).
- Validator staleness on dependency DDL: `maintained-table-validator-stale-on-dependency-ddl` (fix).
- Parent-side FK orphaning by maintenance delete/update: `maintained-table-parent-side-fk-orphan` (backlog).
- Stale-refresh re-validation: `maintained-table-refresh-revalidation` (backlog).
