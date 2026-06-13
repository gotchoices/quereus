----
description: Completed — body-irrelevant (constraint/index/stats/tags-only) `table_modified` now recompiles dependent MVs' row-time plans in place (shape-gated) instead of marking them stale; mark-stale remains the fallback on any failure. Reviewed adversarially; minor findings fixed inline, one follow-up conservatism filed to backlog.
files:
  - packages/quereus/src/core/database-materialized-views.ts        # listener rework, emitBackingInvalidation same-object contract, module doc
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts  # isBodyIrrelevantTableChange, tryRecompileMaterializedViewLive (+ bodyRelevantColumnMatches/sameGeneratedExpr/samePrimaryKeyDefinition)
  - packages/quereus/test/logic/53.3-materialized-view-constraint-only-ddl.sqllogic  # suite, extended in review (§3 add→drop roundtrip, §7b index/tags)
  - packages/quereus-store/test/mv-rehydrate-adopt.spec.ts          # stale-forcer swapped create-index → unprojected add-column
  - docs/materialized-views.md                                      # staleness section carve-out + fallback causes; rehydrate §'s stale-at-close parenthetical fixed in review
difficulty: hard
----

# Complete: recompile (not stale) dependent MVs on body-irrelevant `table_modified`

## What was built (implement stage)

- **Classifier** `isBodyIrrelevantTableChange(old, new)`: reference-equality guard
  first (`old === new` ⇒ body-RELEVANT — the `emitBackingInvalidation` same-object
  contract, cross-commented on both sides), then same name/schema, columns pairwise
  identical in name / logical type / NOT NULL / collation / generated flag+expr
  (textual via `expressionToString`), and pairwise physical-PK identity (index,
  desc, effective per-component collation). Constraints, indexes, statistics, tags,
  defaults, and per-column conflict metadata are deliberately ignored.
- **Recompile helper** `tryRecompileMaterializedViewLive(db, mv)` — synchronous,
  never throws, false on any failure. Gates: `deriveBackingShape` (throws → false)
  → `sameSourceTables` → `describeBackingShapeMismatch` (strict positional columns
  + exact physical-PK equality) → `db.registerMaterializedView` (re-runs arm
  selection / eligibility / cost gates; event-silent).
- **Listener** (`table_modified` arm): live dependents of a body-irrelevant event
  recompile in place (no stale flag, no `releaseRowTime`, no
  `emitBackingInvalidation`); already-stale dependents skip entirely (only REFRESH
  clears a pre-existing flag); any recompile failure falls through to the previous
  stale block verbatim.
- DROP/RENAME/ADD CONSTRAINT, CREATE/DROP INDEX, ANALYZE, and tag-only ALTERs on a
  source no longer de-liven dependents whose backing shape is unaffected.

## Review findings

**Process:** read the implement diff (36fc9f62) fresh before the handoff; traced
every code path the listener rework touches; enumerated all emitters; ran
build + lint + full workspace tests + store mode.

**Checked, found sound (no action):**

- **Classifier coverage vs every genuine `table_modified` emitter** in the engine
  (add/drop/rename constraint, add/drop/rename column, alter column, alter PK +
  rebuild fallback, create/drop index, ANALYZE, tag updates, rename-cascade
  constraint rewrites, MV backing reshape/rename events, `emitBackingInvalidation`):
  every body-relevant emitter changes a classifier-checked field (name / columns /
  physical PK), and every event classified irrelevant is genuinely unable to change
  body results. The same-object reference-equality guard is honored on both sides
  of the coupling; no genuine emitter passes the same object as old/new.
- **Failure-path consistency** of the recompile helper: `registerMaterializedView`
  releases the row-time plan before `buildMaintenancePlan` can throw, but every
  throw falls into the caller's stale block (flag + release + invalidation emit),
  so a failed recompile can never leave a live-but-unmaintained MV. The
  `sourceScope` overwrite before a throw is harmless (recomputed from the same
  recorded `sourceTables`).
- **Skip-path narrowing for already-stale dependents** (handoff's first attention
  item): sound. A plan compiled while the MV was live was invalidated by the
  false→true transition's emit; a plan compiled while stale carries direct source
  dependencies, so the body-irrelevant source event itself invalidates it via the
  statement listener (which matches type+objectName, payload ignored). MV-over-MV
  with both levels already stale: a skipped producer emits nothing, but the
  consumer's reads of its frozen backing are unaffected by a body-irrelevant
  change on the base — no gap.
- **Re-entrant planning inside the change notifier** (handoff's second attention
  item): every body-irrelevant emitter performs `schema.addTable(updated)` BEFORE
  `notifyChange`, so the recompile observes a consistent catalog for the changed
  table. The only mid-statement inconsistency window is the rename cascade
  (constraint-rewrite event on a co-source while the MV body still names the old
  table), which fails shape derivation → stale fallback → restored by the rename
  propagation's own MV loop (pinned by 53.3 §12). Registration is event-silent, so
  the success path fires no nested notifications.
- **Derivation symmetry:** `deriveBackingShape` runs under the same
  MV-rewrite suppression at create, refresh, restore, and recompile, so
  `sameSourceTables` compares sets derived identically — no false mismatch for
  MV-over-MV bodies.
- **Handoff deviations 1–3 accepted:** (1) stale reads serving the frozen snapshot
  when the body still plans is documented pre-existing behavior, not introduced
  here — the 53.3 §6/§11 behavioral assertions (frozen content + refresh
  diagnostic) are the right pins; no read-time-error ticket filed since that would
  be a design change to the long-standing stale-guard contract, for a human to
  initiate. (2) The CHECK-fold scenario is genuinely unreachable as specced
  (`ruleFilterContradiction` folds the source away entirely); §13 pins both
  conservative outcomes and §5 (FK-drop arm demotion with post-drop parent delete)
  is the live recompile-not-skip soundness proof. (3) The
  `mv-rehydrate-adopt.spec.ts` stale-forcer swap (create index → unprojected add
  column) preserves the tests' subject (stale-at-close refill/adopt semantics)
  while respecting the new liveness — verified the add-column event is
  body-relevant (column count) and backing-shape-neutral.

**Minor findings — fixed in this pass:**

- `docs/materialized-views.md` § rehydrate (stale-at-close marker) still claimed
  "any `table_modified` on a source — an ALTER, even a `create index` — detaches
  its row-time maintenance". A `create index` is now exactly the body-irrelevant
  case that stays live. Reworded to "a body-relevant `table_modified` … a
  constraint/index/stats-only change instead recompiles the dependent in place".
- 53.3 had no direct coverage for the index-only and tags-only classifier paths
  (only constraint DDL and ANALYZE). Added §7b: `create index`, `drop index`, and
  `alter table … set tags` each keep the MV live with writes propagating.
- The implementer's pre-existing-bug report (ALTER-added CHECK cannot be
  dropped/renamed by name) was triaged and fixed at f9b4a9be, which landed after
  the implement commit. Extended 53.3 §3 with the add→drop CHECK roundtrip the
  implementer had to skip: dropping the just-added CHECK is another
  body-irrelevant event; the MV stays live and the previously-rejected write
  propagates.

**Major findings:** none. No new fix/plan tickets required.

**Follow-ups filed / pre-existing:**

- `backlog/mv-recompile-superkey-pk-gate` (new): relax the recompile gate's strict
  positional backing-PK equality to a superkey check so an ADD CONSTRAINT UNIQUE
  that reorders `keysOf`'s first proved key no longer forces the stale fallback
  (pure conservatism today — no worse than pre-carve-out behavior).
- `backlog/mv-restore-unaffected-structural-alters` (pre-existing, already
  cross-references this work): extend the shape-rederivation discipline to
  structural ALTERs on columns the body provably never reads — deliberately out of
  scope here because shape identity alone does not prove content identity for
  structural changes.

**Validation (review pass):**

- `yarn build` (root, all packages) green; `yarn lint` (packages/quereus) green.
- Full workspace `yarn test` green: quereus 6031 passing / 9 pending; quereus-store
  546 passing; all other workspaces green.
- After the review's test additions: quereus package suite re-run green; 53.3
  re-run green in isolation; `QUEREUS_TEST_STORE=true` over 53.1/53.2/53.3 green
  (LevelDB-backed paths).
