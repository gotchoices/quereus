---
description: |
  Refreshing a materialized view could silently store a NULL into a backing column its own schema
  declares NOT NULL; refresh now raises a clear error instead. Ready for review.
prereq:
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts    # nullInNotNullSeededPkError + assertNoNullInNotNullSeededPk + the rebuildBacking guard call
  - packages/quereus/test/materialized-view-refresh-reshape.spec.ts    # § NOT-NULL ordering-seeded PK guard (3 new tests)
  - docs/materialized-views.md                                         # § REFRESH — new "Known limitation — NULL into a NOT-NULL ordering-seeded PK column"
  - tickets/fix/bug-mv-rowtime-null-into-notnull-seeded-pk.md          # the row-time vector this guard does NOT cover (filed)
difficulty: medium
---

# Review handoff: guard `refresh` against storing NULL into a NOT-NULL ordering-seeded backing PK column

## What shipped

A materialized view body with `order by <col>` seeds `<col>` into the backing table's **physical**
primary key (`computeBackingPrimaryKey`). A NOT-NULL source column then becomes a NOT-NULL physical-PK
backing column. A physical-PK column cannot lose NOT NULL (the memory manager refuses to DROP NOT NULL on
it; the reshape masks the doomed loosen — the landed sibling `mv-reshape-loosens-not-null-on-ordering-
seeded-backing-pk`). So once the source column drops NOT NULL and yields a NULL row, a rebuild that stored
that NULL would leave the backing schema declaring NOT NULL while holding a NULL.

All changes in `materialized-view-helpers.ts`:

- **`nullInNotNullSeededPkError(schemaName, viewName, columnName)`** — MV-attributed `StatusCode.CONSTRAINT`
  diagnostic next to `materializedViewNotASetError`. Self-explaining sentence: names the column, the cause
  (the `order by` seed pinned it NOT NULL, source became nullable), and the remedy (recreate without
  `order by <col>`).
- **`assertNoNullInNotNullSeededPk(backing, rows, schemaName, name)`** — computes the guarded set (backing
  columns both declared NOT NULL **and** physical-PK members, by direct `primaryKeyDefinition` index scan),
  then scans `rows`; throws on the first NULL/undefined in a guarded column. No-op when the set is empty or
  no NULL is present.
- **Call site in `rebuildBacking`** — placed after `backing`/`host` resolution and **before** the
  fast-path/constraint-bearing branch split, so it covers BOTH branches (neither validates column NOT NULL)
  and both refresh arms (the data-only fast path and the reshape arm, which calls `rebuildBacking` between
  its structural ops).

On throw the failing statement unwinds and the pre-refresh committed contents stay intact (nothing was
swapped yet); the MV stays stale/unrefreshed and the next read re-validates.

## ⚠️ The finding the reviewer must weigh: the ticket's scope premise was wrong

The implement ticket claimed **"Only the refresh rebuild path is affected."** That is **empirically false.**
Verified on the current tree with a throwaway spec:

- `alter table par alter column x drop not null` does **not** mark a plain projection MV stale — the body
  recompiles **live** (`isBodyIrrelevantTableChange`/`tryRecompileMaterializedViewLive`), so the row-time
  maintenance plan **stays attached**.
- Therefore `insert into par (id, x) values (2, null)` is **maintained straight into the backing by
  row-time maintenance** (`applyInverseProjection`) — storing the NULL into the NOT-NULL PK column
  **before any `refresh` runs**. `select id, x from par_ix` then returns `{1,5}` and `{2, NULL}` with the
  insert alone; the refresh is a silent no-op re-store.

So the **row-time path is the primary silent-corruption vector**, and the refresh guard here does **not**
close it. (The original review that spawned this ticket reproduced the corruption via `refresh` and
attributed the materialization to refresh — but the NULL was already stored by the preceding insert.)

**What this guard is still worth:** refresh IS the sole vector when the MV is **stale** (row-time detached)
— e.g. a `select *` MV made stale by a trailing source add, or a full-rebuild-only MV — and the guard
correctly makes that loud. It also establishes the shared `nullInNotNullSeededPkError` the row-time fix
will reuse.

**Filed:** `tickets/fix/bug-mv-rowtime-null-into-notnull-seeded-pk.md` — the row-time vector, with repro,
affected arms (inverse-projection confirmed; full-rebuild by inspection), and a design note (precompute a
per-plan NOT-NULL/nullable **skew** flag at plan build so the hot path stays cheap — the guarded set is
non-empty for almost every MV, so a naive per-change scan would run on every maintained write). Both
vectors are ultimately rooted out by `backlog/debt-mv-ordering-seed-to-materialized-index`.

## How to test / validate / use

Tests live in `materialized-view-refresh-reshape.spec.ts` § *NOT-NULL ordering-seeded PK guard* (3 new):

1. **Fast-path guard, exact repro** — projection MV, `drop not null`, insert `(2, null)`, `refresh` →
   throws `CONSTRAINT` naming `x`, backing still declares `x` NOT NULL. (Inline note flags that the NULL was
   already row-time-stored — this test pins only that refresh doesn't silently re-store.)
2. **Reshape-arm guard, clean isolation** — `select *` MV made **stale** by a trailing add (row-time
   detached), so the NULL insert is unmaintained and the backing cleanly holds only `{1,5}`; `refresh` →
   throws `CONSTRAINT` naming `x`, **pre-refresh contents intact** (`{1,5}`), MV stays stale, no
   `table_removed`/`table_added`. This is the clean "the guard prevented a store" case.
3. **Permitted case not rejected** — a **nullable** source ordering column seeds a **nullable** PK column
   that self-consistently stores NULL; both `create` and `refresh` succeed (guard fires only on
   `col.notNull === true`).

Sibling no-NULL tests still pass unchanged: § *a source DROP NOT NULL on an ordering-seeded backing PK
column refreshes without dropping the backing PK NOT NULL* (spec ~276) and § *a PK-column DROP NOT NULL
coexisting with a genuine reshape* (spec ~327) — with only non-NULL values the guard is a no-op.

Commands run (all green):
- `materialized-view-refresh-reshape.spec.ts` → 18 passing.
- All `maintained-table-*` + `materialized-view-*` + `incremental/*` specs → **325 passing**, no regression.
- `yarn workspace @quereus/quereus run build` → exit 0.
- `cd packages/quereus && yarn lint` (eslint + `tsc -p tsconfig.test.json`) → exit 0.

## Known gaps / things for the reviewer to probe

- **The row-time vector is open** (filed, above). If the reviewer judges the refresh-only guard
  insufficient to ship on its own, the fix ticket is ready to pick up; the shared helper is already in
  place. Consider whether the two should be one landing.
- **Guarded-set cost on refresh** is O(rows × guarded columns), amortized inside the full rebuild
  (`collectBodyRows` already materializes all rows) — negligible for refresh, but the same shape is NOT
  cheap on the row-time hot path (see the fix ticket's design note).
- **Message wording** currently opens "refresh of materialized view …"; the row-time fix will want to
  reuse the helper, so it may need to generalize the lead-in to be vector-neutral.
- **The `applyFullRebuild` full-rebuild arm** is affected by inspection only (not separately reproduced) —
  see the fix ticket. I did not construct a full-rebuild-eligible ordering-seeded MV with a nullable source.

## Tripwire recorded

The "MV cannot be refreshed while a source NULL persists in the seeded column" trade (loud-correct over
silent-wrong) is recorded as: a `// NOTE:` at the guard site in `rebuildBacking` pointing at
`debt-mv-ordering-seed-to-materialized-index`, and a *Known limitation* paragraph under
`docs/materialized-views.md` § REFRESH MATERIALIZED VIEW. Not a ticket — it is the accepted, documented
behavior of this guard.
