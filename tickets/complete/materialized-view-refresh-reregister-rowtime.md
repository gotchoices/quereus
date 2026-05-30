description: `refresh materialized view` now re-registers the MV's row-time (write-through) maintenance plan after rebuilding the snapshot. Previously refresh cleared `stale` and rebuilt the backing, but left the plan detached (a prior compatible source-schema change had released it), so post-refresh source writes were silently not propagated. Reviewed + minor-fixed (error-path ordering) + extended test coverage (covering-enforcement resumes after refresh).
files: packages/quereus/src/runtime/emit/materialized-view.ts, packages/quereus/test/logic/53-materialized-views-rowtime.sqllogic, packages/quereus/test/covering-structure.spec.ts, docs/materialized-views.md, packages/quereus/src/core/database-materialized-views.ts
----

## What shipped

### Fix — `emitRefreshMaterializedView` (`src/runtime/emit/materialized-view.ts:115`)

`refresh materialized view` now calls `db.registerMaterializedView(mv)` after rebuilding the backing
snapshot, re-attaching the row-time write-through plan that a prior compatible source-schema change had
detached. Without it, refresh rebuilt the snapshot but left the plan detached, so subsequent source
writes were silently dropped — only `drop + recreate` re-registered.

Root cause: a *compatible* source schema change (e.g. `alter table … add column`) marks the MV stale
**and** calls `releaseRowTime` (`database-materialized-views.ts:245`), detaching the compiled plan.
`registerMaterializedView` (`database-materialized-views.ts:260`) is idempotent — it `releaseRowTime`s
first, then rebuilds the plan — so re-registering a never-stale MV is a harmless no-op re-attach.

**Review minor-fix applied:** the implement stage cleared `stale` *before* re-registering; this pass
reordered to **register first, then clear `stale`**. `registerMaterializedView` never reads `mv.stale`,
so the success path is unchanged, but if registration ever threw (the eligibility gate re-runs there)
the MV is now left `stale` → the next read re-validates/errors rather than silently serving an
unmaintained snapshot. Comment updated to document the ordering rationale.

### Tests

- `test/logic/53-materialized-views-rowtime.sqllogic` §16 — from the implement stage: 16a (single-PK
  refresh-resume regression — fails without the fix), 16b (drop+recreate), 16c (idempotent never-stale
  refresh), 16d (compound-PK), 16e (partial-WHERE predicate honored after re-registration).
- `test/covering-structure.spec.ts` — **added** by this review: *"covering enforcement resumes after a
  refresh following a compatible source ALTER"*. Asserts the covering MV is enforcement-ready before the
  alter, that the `coveringStructureName` forward pointer survives the alter, that a *stale* MV is NOT
  enforcement-ready (falls back to the auto-index), and that `refresh` restores the MV as the
  enforcement-ready covering structure so a subsequent UNIQUE conflict is answered through its backing
  table. This closes the most important untested interaction the fix enables.

### Docs — `docs/materialized-views.md` § Schema-change staleness

States that marking an MV stale detaches its row-time plan and that the next successful refresh (or
drop+recreate) clears `stale`, rebuilds the snapshot, **and** re-registers the plan (idempotent for a
never-stale MV). Still accurate after the ordering change (it describes the net effect, not the internal
statement order).

## Review findings

**Scope reviewed:** the implement diff (`fa46a22a`) with fresh eyes, then the surrounding subsystem —
`emitRefreshMaterializedView`, `MaterializedViewManager.{registerMaterializedView, releaseRowTime,
subscribeToSchemaChanges, findRowTimeCoveringStructure, resolveCoveringStructureName}`, the
`rebuildBacking`/`revalidateBody` helpers, the `runAddColumn` alter path, and the covering-enforcement
call sites in `memory/layer/manager.ts` and `quereus-store/store-table.ts`.

- **Correctness (fix) — confirmed.** `rebuildBacking` only swaps the backing base layer; it does not
  touch the row-time plan, so the re-registration is genuinely required. `registerMaterializedView` is
  idempotent (release-then-rebuild, single `rowTimeBySource` entry). The §16a test would fail without
  the fix (post-refresh insert is dropped) — verified it is a real regression guard.

- **Error-path ordering — minor, fixed inline.** Reordered to register-before-clear-stale for a safer
  failure posture (see above). The implementer flagged this exact point and followed the ticket's
  prescribed order; the throw is unreachable in practice (`revalidateBody` runs first and a compatible
  alter preserves row-time eligibility), so this is defense-in-depth, not a live bug.

- **Covering-enforcement interaction — investigated, NOT a bug; now tested.** Initial concern: refresh
  re-registers the row-time plan but does *not* re-run `linkCoveredUniqueConstraints`, unlike
  drop+recreate. Traced `runAddColumn` (`alter-table.ts`): it builds the new schema via `{ ...tableSchema, … }`,
  which carries the same frozen `uniqueConstraints` array — so `coveringStructureName` survives a
  compatible alter. Covering enforcement is gated on the MV being non-stale + having a live row-time plan
  (`findRowTimeCoveringStructure`), both restored by the re-registration alone. So the fix fully restores
  covering enforcement with no extra re-link needed. Added a regression test proving this end-to-end
  (memory path; the spec drives `new Database()` directly).

- **Test coverage — adequate floor, extended.** §16 covers single/compound-PK and partial-WHERE MVs;
  this review added the covering-enforcement-resume branch. Remaining untested interactions, judged
  acceptable follow-ups (not blockers, no ticket filed — low-likelihood, mechanism shared with covered
  cases): expression-projection MV resuming after refresh; refresh-resume inside an explicit transaction
  with mid-statement reads-own-writes; MV-over-MV cascade edge surviving a producer re-registration.

- **SPP / DRY / type-safety / resource-cleanup / error-handling — no findings.** The fix is a single
  idempotent call reusing the existing public passthrough; no duplication, no new resources, no swallowed
  exceptions, no `any`. The cascade/eligibility machinery it re-enters is unchanged.

- **Validation:** `yarn build` (quereus) green; full memory suite **3960 passing / 9 pending / 0 failing**;
  §16 + the new covering test pass in **store** mode too (both exercise `ALTER`, whose store path differs
  from memory); `eslint` clean. Not run: cross-workspace `yarn test` over other packages and full
  `yarn test:store` (the change is confined to MV registration in `packages/quereus`; no other workspace
  references it, and the targeted store runs cover the ALTER-path concern).

## End
