description: ALTER TABLE/COLUMN RENAME now rewrites dependent MV bodies in place (parallel to plain views): sourceTables/bodyHash/sql re-keyed, backing columns renamed on output-name shift, row-time maintenance re-registered, materialized_view_modified fired; pre-existing stale flags preserved and failures leave the MV stale. Reviewed and approved with minor doc fixes; two follow-ups filed/updated.
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # snapshotStaleMaterializedViews, propagate{Table,Column}RenameToMaterializedViews, applyMaterializedViewRewrite, renameShiftedBackingColumns, backingColumnDef, failMaterializedViewRenamePropagation; backingShapeMatches refactored over describeBackingShapeMismatch
  - packages/quereus/src/runtime/emit/alter-table.ts                 # pre-statement staleness snapshot in runRenameTable/runRenameColumn; propagate* made async; MV loop inside the same-schema gate after the view loop
  - packages/quereus/src/core/database-materialized-views.ts         # MaterializedViewManager.markMaterializedViewStale
  - packages/quereus/src/core/database.ts                            # markMaterializedViewStale wrapper
  - packages/quereus/test/logic/53.2-materialized-view-rename-propagation.sqllogic
  - packages/quereus/test/mv-rename-propagation.spec.ts
  - packages/quereus/test/view-mv-ddl-persistence.spec.ts
  - docs/materialized-views.md                                       # § Rename propagation ("MV ≡ faster view")
  - docs/sql.md                                                      # RENAME TABLE / RENAME COLUMN / declarative-rename paragraphs now name MV bodies (review fix)
----

# Complete: MV body rewrite on source RENAME (parallel to plain views)

A source table/column rename rewrites a dependent MV exactly as it rewrites a plain
view ("MV ≡ faster view", human-dispositioned in fix stage): the body `selectAst` is
mutated by the same rename walkers, derived fields (`sourceTables`, `bodyHash`,
regenerated `sql`, `covers` reverse link) are recomputed on a shallow catalog clone,
a column-rename-induced output-name shift is carried onto the live backing in place
(data-preserving, via the module's `renameColumn`), row-time maintenance re-registers
against the renamed catalog, and `materialized_view_modified` fires so store-backed
catalogs re-persist the rewritten DDL. Staleness discipline: a pre-statement stale
flag is never cleared (body still rewritten so a later REFRESH resolves the new name);
statement-local staleness is restored after a successful rewrite; any per-MV failure
force-marks that MV stale (`markMaterializedViewStale`: flag + row-time release +
cached-backing-read invalidation) and propagation continues best-effort.

Implementation divergences from the fix-stage design (all judged sound in review):
failure-path reads serve the stale-but-valid backing rather than a diagnostic (engine-
wide stale-MV semantic; spec test asserts the honest behavior); `backingShapeMatches`
type comparison switched from identity to case-insensitive name (store module rebuilds
`LogicalType` instances after ALTER — identity was spuriously false); table rename
also processes an unchanged-AST MV whose `sourceTables` carries the old base (MV
reading the renamed table through a plain view); `materialized_view_modified` fires
for still-stale MVs too (rewritten DDL must re-persist).

## Review findings

**Process**: read the full implement diff fresh before the handoff summary; traced
every new function against the catalog/manager internals it touches
(`Schema.addMaterializedView` replace semantics, `MaterializedViewManager`
listener/`releaseRowTime`/`registerMaterializedView` idempotency, memory module
`renameColumn` + `columnDefToSchema`, store `saveMaterializedViewDDL` listener,
`generateMaterializedViewDDL` reading `selectAst`); ran live adversarial probes beyond
the committed tests; ran `yarn lint` (clean), `tsc --noEmit` (clean), `yarn test`
(5574 passing), `yarn test:store` (5570 passing — re-run because the type-name compare
change affects store-mode refresh).

**Correctness / staleness discipline — checked, no defects:**
- Snapshot/restore window: the rename statement's notify → listener stale-marking →
  propagation restore sequence has no DML interleaving point; statement-local
  staleness restored only after successful re-registration, and `updated.stale =
  false` is set after `registerMaterializedView` so a throw leaves the MV stale.
  MV schema objects are mutable by design (refresh emitter mutates them identically).
- Chained-MV ordering: traced both iteration orders for an MV reading both the renamed
  table and another MV — outcome is order-independent (live when the body still plans,
  stale via the failure path or the backing-rename cascade when it doesn't).
- Table rename's notify fires under the NEW name, so it never matches still-old-keyed
  `sourceTables` — dependents are not spuriously stale-marked; re-registration re-keys
  `rowTimeBySource` correctly (`releaseRowTime` removes old-base index entries).
- `backingColumnDef` emits explicit `{type:'null'}`/`{type:'notNull'}`, so the
  `default_column_nullability` option cannot corrupt a backing column's nullability
  through `columnDefToSchema`; memory `renameColumn` keeps `primaryKeyDefinition`
  positional, so PK semantics survive.
- Name-based type compare (divergence 2): no caller relied on identity inequality to
  force a rebuild — refresh's "fast path" re-runs the body and swaps the base layer
  anyway (data is always recomputed; only backing column metadata is reused), so a
  same-name type re-registration cannot serve wrong data.
- `renameShiftedBackingColumns` ordering hazard: impossible for a single-column source
  rename to produce colliding output shifts (a collision would have been rejected at
  the source-table rename's own conflict check); a duplicate-output-name pathological
  body hits the module's rename conflict → failure path → stale, never corruption.

**Live probes (beyond committed tests) — all passed:**
- Rename shifting a **PK backing column** (`v` PK projected bare): backing PK column
  renamed in place, insert/update/delete all propagate, REFRESH consistent.
- Rename **round-trip** (`t→t2→t`): MV live, sourceTables re-keyed back, writes flow.
- Body referencing the renamed column **only in WHERE**: rewritten, stays live, DDL
  regenerates with the new name.

**Found — minor, fixed in this pass:**
- `docs/sql.md` still described rename propagation as reaching "view bodies" only, in
  three places (RENAME TABLE ¶, RENAME COLUMN ¶, declarative-renames §2.x overview).
  All three now name materialized-view bodies and link the new
  `materialized-views.md` § Rename propagation section.
- The sibling fix ticket `view-insert-defaults-not-rewritten-on-source-rename` said
  "this ticket covers the **plain-view** clause" while expecting *this* ticket to
  handle `MaterializedViewSchema.insertDefaults` — and this ticket's handoff deferred
  the MV field back to it (mutual deferral; the field is carried verbatim into the
  regenerated MV DDL today, so the stale name would persist). Updated the sibling
  ticket to explicitly own BOTH fields, pointing at the exact rewrite site
  (`applyMaterializedViewRewrite`, before DDL regeneration).

**Found — major, filed as new ticket:**
- `tickets/backlog/mv-unaffected-by-rename-left-silently-stale.md`: an MV whose AST a
  rename does NOT change is left silently stale even when provably unaffected —
  (a) column rename of a column the body never references, and (b) a table rename that
  only rewrites a CHECK/FK/index-predicate on another MV source (the `table_modified`
  it fires marks the MV stale). In both cases writes silently stop propagating and
  reads serve the behind backing with no diagnostic until manual REFRESH. Verified
  live; pre-existing behavior class (the listener semantics predate this ticket) and
  within this ticket's settled "unchanged-AST stays on stale→REFRESH" disposition, so
  filed forward rather than fixed inline — the new propagation machinery makes it
  cleanly fixable (re-derive shape for unchanged-AST statement-local-stale MVs;
  restore on match).

**Explicitly checked, nothing found:** error handling (per-MV try/catch with logging,
no swallowed exceptions), resource cleanup (row-time plans released on every stale
transition; no leaked subscriptions), type safety (no `any`; tsc clean), DRY (shared
`applyMaterializedViewRewrite` core; `backingShapeMatches` refactored over the new
diagnostic helper rather than duplicated), event contract (exactly one
`materialized_view_modified` per affected MV, none for unrelated MVs — spec-asserted),
store persistence path (`saveMaterializedViewDDL` listener already handles
`materialized_view_modified`; DDL round-trip spec-asserted).

**Accepted gaps (documented in handoff, confirmed reasonable):** chained MV with
unchanged AST stays stale after a column rename flowing into the producer's exposed
name (staleness diagnostic on read — plain-view-chain parity); cross-schema MVs not
rewritten (exact parity with the plain-view same-schema gate); stale-MV `sourceScope`
watch imprecision across a rename (pre-existing class); v2 non-memory backing modules
route through the generic `alterTable` with an UNSUPPORTED throw → failure path →
stale → REFRESH, which is the correct degradation.

## Validation (review pass)

`packages/quereus`: `yarn lint` clean, `tsc --noEmit` clean, `yarn test` 5574 passing,
`yarn test:store` 5570 passing — all after the review's doc edits (docs-only; no src
changes were needed).
