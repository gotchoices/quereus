----
description: Implemented — body-irrelevant (constraint/stats/tags-only) `table_modified` now recompiles dependent MVs' row-time plans in place (shape-gated) instead of marking them stale; mark-stale remains the fallback on any failure. Review the listener rework, the classifier, and the deviations from the original test spec noted below.
files:
  - packages/quereus/src/core/database-materialized-views.ts        # listener rework, emitBackingInvalidation coupling comment, module doc
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts  # new: isBodyIrrelevantTableChange, tryRecompileMaterializedViewLive (+ private bodyRelevantColumnMatches/sameGeneratedExpr/samePrimaryKeyDefinition)
  - packages/quereus/test/logic/53.3-materialized-view-constraint-only-ddl.sqllogic  # new suite (passes memory + store mode)
  - packages/quereus-store/test/mv-rehydrate-adopt.spec.ts          # stale-forcer swapped: create index → unprojected add column (see below)
  - docs/materialized-views.md                                      # staleness section: recompile carve-out + fallback causes
  - tickets/.pre-existing-error.md                                  # add-CHECK→drop/rename "not found" bug, reproduced at HEAD
difficulty: hard
----

# Review: recompile (not stale) dependent MVs on body-irrelevant `table_modified`

## What was built

Exactly the settled design from the implement ticket:

- **Classifier** `isBodyIrrelevantTableChange(old, new)` (materialized-view-helpers.ts,
  colocated with the per-column predicates it reuses): reference-equality guard first
  (`old === new` ⇒ body-RELEVANT — the `emitBackingInvalidation` same-object contract,
  cross-commented on both sides), then same name/schema (lowercased), columns pairwise
  identical in name / logical type / NOT NULL / collation / generated flag+expression
  (via `expressionToString`), and pairwise physical-PK identity (`index`, `desc`,
  *effective* per-component collation: explicit ?? keyed column's ?? BINARY).
  `defaultValue`, per-column conflict metadata, `tags`, `collationExplicit`,
  `generatedStored`, and all table-level constraint/index/statistics fields are ignored.
- **Recompile helper** `tryRecompileMaterializedViewLive(db, mv)` — synchronous,
  never throws, returns false on any failure. Gate order: `deriveBackingShape`
  (throws → false) → `sameSourceTables` → `describeBackingShapeMismatch` against the
  live catalog record (strict positional columns + exact physical-PK equality) →
  `db.registerMaterializedView` (re-runs arm selection / eligibility / cost gates;
  event-silent). Deliberately not `restoreMaterializedViewLive` (async, clears `stale`).
- **Listener** (`subscribeToSchemaChanges`, `table_modified` arm only): classification
  computed once per event; live dependents route through the recompile helper and
  `continue` on success (no stale flag, no `releaseRowTime`, no
  `emitBackingInvalidation`); already-stale dependents `continue` immediately on a
  body-irrelevant event (no re-release / re-emit — only REFRESH may clear the flag);
  any recompile failure falls through to the previous stale block verbatim.
  `table_removed`, `table_added`, `materialized_view_removed`, and the
  `rebuildConstraintValidatorsFor` tail are unchanged (a recompiled MV's validator is
  rebuilt twice — once inside registration, once by the tail — idempotent, noted in a
  comment).

## Deviations from the implement ticket's test spec — read these first

1. **Stale reads do not error for shape-only divergence.** The ticket's dropped-UNIQUE
   tests expected `select * from mv` → `error: is stale`. The build-time stale guard
   (`building/select.ts`) only raises the staleness diagnostic when the body **fails to
   plan**; a stale MV whose body still plans serves its frozen snapshot (documented
   behavior: "while stale the MV serves its last snapshot"). Dropping a UNIQUE doesn't
   break planning, so the 53.3 tests assert staleness **behaviorally**: writes stop
   propagating (frozen content) and `refresh` errors with the shape diagnostic
   (`output shape changed incompatibly`). Verified by direct probing before writing the
   tests. If the reviewer thinks shape-divergent-stale *should* error on read, that is a
   separate ticket against the stale guard, not this change.
2. **The literal CHECK-fold scenario is unreachable.** The ticket specced: create MV
   under a contradicting source CHECK (compiled body folds to empty), drop the CHECK,
   insert → "row MUST appear". In reality `ruleFilterContradiction` folds the *entire*
   body to an `EmptyRelation` — the source table vanishes from the optimized plan — so:
   (a) at create, the MV is rejected by a pre-existing guard ("body reads no source
   table"; its dependencies could never be recorded), and (b) when the contradicting
   CHECK is *added* post-create, the recompile's re-derived source set shrinks to ∅ and
   the `sameSourceTables` guard (correctly, conservatively) forces the stale fallback.
   53.3 §13 pins both conservative outcomes. The **live** recompile-not-skip soundness
   proof is instead §5 (FK drop demotes the join-residual arm: post-drop `delete` of a
   referenced parent removes the joined MV rows; a skipped/stale upsert-only lookup plan
   would have left phantoms) — also from the ticket's own test list.
3. **Four quereus-store rehydrate tests were piggybacking on the old behavior.**
   `mv-rehydrate-adopt.spec.ts`'s "stale-at-close exclusion" tests used
   `create index` on a source as a cheap stale-forcer. An index-only `table_modified`
   is precisely a body-irrelevant change, so those MVs now stay live — the intended
   new behavior, which broke the tests' setup (not their subject). Swapped the forcer
   to an unprojected `add column w integer null` (body-relevant: column set changes;
   body/backing shape untouched, so refill/adopt semantics under test are unaffected)
   and adjusted the now-3-column positional inserts to `insert … (id, v) values …`.

## Use cases to validate (all covered in 53.3, memory + store mode)

- DROP CONSTRAINT (CHECK) / RENAME CONSTRAINT / ADD CONSTRAINT CHECK / ADD UNIQUE on an
  unprojected column → MV stays live; writes propagate; refresh still works (§1–§4).
- FK drop over a provable 1:1 join body → live, arm demoted; parent delete removes
  joined rows; dangling child joins nothing (§5).
- Dropped UNIQUE backing the recorded backing PK → stale: frozen, refresh errors,
  drop-and-recreate recovers (§6). Same shape with a consumer MV on top → the failure's
  `emitBackingInvalidation` (same-object event → body-relevant) cascades; both freeze (§11).
- ANALYZE → live (was: silently staled every dependent) (§7).
- Pre-existing staleness never cleared by a later constraint-only DDL; REFRESH recovers,
  including the backing reshape for the retype that caused it (§8).
- Mid-statement independence: one DDL, two dependents — PK-shifted one stales, the
  sibling recompiles live (§9).
- MV-over-MV: constraint-only DDL on the base keeps both levels live; writes cascade (§10).
- RENAME of an FK target with an MV reading BOTH tables: ends live (whether the MV
  stales via the rename event or the cascade event mid-statement, the rename
  propagation's MV loop restores it) (§12). 53.2 §11/§13 keep passing via the new path.

## Known gaps / reviewer attention

- **Skip-path narrowing for already-stale dependents:** previously *every* qualifying
  event re-ran `releaseRowTime` + `emitBackingInvalidation` for stale dependents; on
  body-irrelevant events these are now skipped entirely (per the ticket: the original
  false→true transition already emitted, and the docs note the per-event re-emit is
  defensive redundancy for the single-level case). Body-RELEVANT events keep the
  unconditional re-emit. Worth a second pair of eyes on MV-over-MV chains where the
  producer was already stale before the constraint-only DDL (53.3 §8 covers single
  level; §11 covers the transition-time cascade).
- **Recompile runs inside the synchronous change-notifier**, i.e. re-entrant planning
  during DDL emitters (add-constraint validation windows, rename cascades, analyze).
  The full suite (6028 quereus + 546 store tests) and 53.3 §12 exercise this, but the
  reviewer should sanity-check there is no emitter window where planning the MV body
  mid-event could observe a half-swapped catalog beyond the rename case (which safely
  falls back to stale and is restored by the rename loop).
- **Documented conservatisms (not fixed here, by design):** ADD CONSTRAINT UNIQUE that
  reorders `keysOf`'s first proved key → strict-PK mismatch → stale (follow-up could
  relax to a superkey check); ANALYZE revealing full-rebuild pathology → registration
  throws → stale; any fold that adds/removes a source table from the re-planned body
  (FK-driven join un-elimination, CHECK-driven contradiction fold, `exists`-FK
  trivialization) → `sameSourceTables` → stale.
- **Pre-existing bug filed** (`tickets/.pre-existing-error.md`, reproduced at HEAD with
  the working tree stashed): a CHECK added via `ALTER TABLE … ADD CONSTRAINT` cannot be
  dropped/renamed by name ("Named constraint not found"; UNIQUE roundtrips fine).
  53.3 §3 therefore never drops the CHECK it adds.
- The classifier compares generated expressions textually (`expressionToString`) —
  semantically-equal-but-differently-spelled rewrites classify body-relevant (stale
  path; conservative, matches ticket guidance to avoid semantic AST comparison).

## Validation performed

- `yarn build` (root, all packages) green; `yarn lint` in packages/quereus green.
- `yarn test` (workspace) green: quereus 6028 passing / 9 pending; quereus-store 546
  passing (after the 4-test stale-forcer fix); all other workspaces green.
- Store mode: `QUEREUS_TEST_STORE=true` over 53.1/53.2/53.3 green (LevelDB-backed
  ALTER/ANALYZE/MV paths).
- Behavior additionally probed directly against the built package during development
  (frozen-snapshot semantics, refresh diagnostics, classifier outcomes per DDL).
