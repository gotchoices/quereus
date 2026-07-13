---
description: |
  Refreshing a materialized view can silently store a NULL into a backing column its own schema
  declares NOT NULL. Make that a loud, clearly-worded error instead of silent data corruption.
prereq:
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # rebuildBacking (~1450) — add the NOT-NULL guard here
  - packages/quereus/src/runtime/emit/materialized-view.ts           # refreshMaintainedTable (~118, ~152) — funnels both refresh arms through rebuildBacking
  - packages/quereus/test/materialized-view-refresh-reshape.spec.ts  # regression case home
difficulty: medium
---

# Guard: `refresh` must not silently store NULL into a NOT-NULL ordering-seeded backing PK column

## The bug (reproduced, confirmed on current tree)

A materialized view whose body carries `order by <col>` seeds `<col>` into the backing table's
**physical** primary key (`computeBackingPrimaryKey`, materialized-view-helpers.ts ~236 — ordering
columns lead the key so the btree clusters in body order). At create time the derived NOT-NULL flag
tracks the source exactly, so a NOT-NULL source column becomes a NOT-NULL physical-PK backing column.

A physical-PK backing column cannot have its NOT NULL dropped — `MemoryTableManager.alterColumn`
throws `Cannot DROP NOT NULL on PRIMARY KEY column '<col>'`. The landed sibling fix
(`mv-reshape-loosens-not-null-on-ordering-seeded-backing-pk`) stopped `refresh` from emitting a doomed
`loosenNotNull` op on such a column (via `isPhysicalPkColumn` masks in `describeBackingShapeMismatch`
~1611 and `classifyBackingReshape`). That is correct — but it makes the following silent-NULL path
reachable through plain SQL:

```sql
create table par (id integer primary key, x integer not null);
insert into par values (1, 5);
create materialized view par_ix as select id, x from par order by x;  -- backing PK = [x, id], x NOT NULL
alter table par alter column x drop not null;                          -- source x now nullable
insert into par (id, x) values (2, null);                              -- a real NULL x
refresh materialized view par_ix;                                      -- SUCCEEDS silently (the bug)
select id, x from par_ix;                                              -- returns {1,5} and {2, NULL}
```

Empirically confirmed on the post-sibling-fix tree: `refresh` throws nothing, `par_ix.columns['x'].notNull`
stays `true`, and the stored rows are `[{"id":2,"x":null},{"id":1,"x":5}]`. The backing schema now **lies**
(declares `x` NOT NULL while holding a NULL) and a NULL sits in a declared-NOT-NULL physical-PK column.

### Scope findings from the fix-stage investigation

- **Only the refresh rebuild path is affected.** Create/import (`materializeView`) call
  `host.replaceContents` directly and derive the backing NOT-NULL flag from the source at that moment, so
  they cannot produce the *declared-NOT-NULL-but-holds-NULL* contradiction. Confirmed empirically: a
  `create materialized view … order by x` over a **nullable** source column `x` (`x integer null`) with a
  NULL row present produces a backing whose `x` is declared **nullable** (`notNull=false`) yet seeded into
  the physical PK `[x, id]` and holding a NULL. That is the *permitted* case per the ticket framing
  (declared nullable, stores NULL — self-consistent; memory tolerates NULL key components) — **do not
  reject it.** The defect is specifically *declared NOT NULL contradicted by a stored NULL*.

- **Both refresh arms funnel through `rebuildBacking`.** `refreshMaintainedTable`
  (materialized-view.ts:152) takes the data-only fast path `backingShapeMatches ⇒ rebuildBacking`, and the
  reshape arm runs `reshapeBackingInPlace` which calls `rebuildBacking` between its pre-/post-reconcile
  structural ops. `rebuildBacking` is used by nothing else on the refresh side. So a single guard there
  covers every refresh path.

- **At `rebuildBacking` time the backing already carries its post-reshape schema.** On the reshape arm the
  catalog is re-registered with the post-reshape PK *before* `rebuildBacking` runs (see the comment at
  ~1476), and non-PK NOT-NULL loosens run in `preReconcileOps` (pre-reconcile), while PK-column loosens are
  masked (never emitted). So the only columns still declared NOT NULL that can hold source-nullable data at
  this point are the physical-PK ones — exactly the reachable hole.

## The fix (decision: narrow loud-error guard, not the full rework)

The clean long-term resolution is to stop ordering-seeding the physical PK and express body ordering as a
materialized secondary index instead (the aspirational "covering ticket" the `// NOTE:` comments at
materialized-view-helpers.ts ~236 and elsewhere reference). That rework is large and out of scope for this
bug; it is filed separately as backlog `debt-mv-ordering-seed-to-materialized-index`. **This ticket lands
the narrow guard** so the failure is loud and correct until the rework arrives — meeting the ticket's
stated minimum bar ("storing a NULL into a NOT-NULL physical-PK column must be a loud, correctly-attributed
error, not a silent success").

Add a validation at the top of `rebuildBacking` (materialized-view-helpers.ts ~1450), after the recomputed
`rows` are collected and the live `backing` schema is resolved, **before** the branch split (so it covers
both the `replaceContents` fast path and the constraint-bearing pending-layer branch — neither validates
column NOT NULL today):

- Compute the set of backing columns that are **declared NOT NULL** and are **physical-PK members**
  (`backing.primaryKeyDefinition` indices; reuse the `isPhysicalPkColumn` vocabulary / a direct index
  scan). This is the precise reachable-contradiction set; a non-PK NOT-NULL column that legitimately holds
  no NULL is unaffected, and a non-PK column that the source loosened has already been loosened in the
  backing schema by the time we get here.
- If that set is non-empty, scan `rows`; on the first row holding `null` (or `undefined`) in one of those
  columns, throw a `QuereusError(StatusCode.CONSTRAINT)` attributed to the MV, naming the column and
  explaining the cause and the remedy. Suggested message shape:

  > `refresh of materialized view '<schema>.<name>' would store NULL in column '<col>', which the backing`
  > `declares NOT NULL because the view's \`order by\` seeded it into the physical primary key; the source`
  > `column became nullable and now produces a NULL row. Recreate the view without \`order by <col>\``
  > `(or excluding <col> from the ordering) to allow nullable values in it.`

  Keep it a real, self-explaining sentence (the project prefers diagnostics that name the contract, not the
  hidden mechanism — see `materializedViewNotASetError` in the same file for tone). Factor it into a small
  named helper alongside the other MV diagnostics.

On throw, the failing statement unwinds and the pre-refresh committed contents stay intact (the fast path
never ran `replaceContents`; the constraint-bearing branch had not committed). The MV stays stale and the
next read re-validates — same posture as the other refresh sited errors.

### Known limitation to record (tripwire, not a ticket)

While a source NULL exists in the ordering-seeded column, `refresh` will keep erroring — the MV cannot be
refreshed until the rework removes the pinned-NOT-NULL column or the user drops/recreates the view without
that ordering. This is the accepted trade of loud-correct over silent-wrong. Record it as:
- a `// NOTE:` at the guard site pointing at `debt-mv-ordering-seed-to-materialized-index`, and
- a one-line entry under `docs/materialized-views.md` § REFRESH MATERIALIZED VIEW (next to the existing
  collation-/type-sensitive-CHECK known limitations), and
- a line in the review handoff's `## Review findings`.

## TODO

- [ ] Add a `nullInNotNullSeededPkError`-style helper (MV-attributed, `StatusCode.CONSTRAINT`) next to the
      other MV diagnostics in materialized-view-helpers.ts.
- [ ] In `rebuildBacking` (~1450), after resolving `backing` and before the fast-path / constraint-bearing
      branch split, compute the declared-NOT-NULL physical-PK column set and scan `rows`; throw the helper's
      error on the first NULL found. Zero-cost when the set is empty or no NULL is present.
- [ ] Add a `// NOTE:` at the guard site referencing `debt-mv-ordering-seed-to-materialized-index` and
      noting the "MV stays un-refreshable while a source NULL persists" limitation.
- [ ] Regression test in `materialized-view-refresh-reshape.spec.ts`: the exact repro above (source
      `drop not null` + a NULL insert + `refresh`) now throws a CONSTRAINT error naming `x`, the stored
      snapshot is left at the pre-refresh contents (`{1,5}` only — the NULL row never materialized), and the
      MV stays stale. Add a companion positive case proving the **no-NULL** path still works: after
      `drop not null` with only non-NULL `x` values, `refresh` still succeeds and keeps `x` NOT NULL (this
      is the existing sibling test at spec ~276 — verify it still passes unchanged).
- [ ] Verify the reshape-arm variant (the sibling test at spec ~327: a genuine trailing-column reshape
      co-occurring with the PK-column loosen) also routes through the guard: with a NULL present it must
      throw the same CONSTRAINT error; with no NULL it must still reshape + keep `x` NOT NULL.
- [ ] Confirm the incremental full-rebuild path (`applyFullRebuild` in
      `core/database-materialized-views-apply.ts`, which does its own `applyMaintenance('replace-all')` +
      `validateDerivedChanges` rather than calling `rebuildBacking`) is either not reachable for a
      stale→full-rebuild with a source NULL, or already rejects it via per-delta validation. If it can
      silently store the NULL too, extend the same guard there (or share the helper); otherwise note in the
      handoff why it is safe.
- [ ] `yarn workspace @quereus/quereus test` (at least the MV specs) and `yarn lint` green. Update
      `docs/materialized-views.md` with the known-limitation line.
