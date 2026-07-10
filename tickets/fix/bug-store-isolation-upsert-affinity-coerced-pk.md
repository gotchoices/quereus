---
description: |
  On a store-backed table wrapped in the isolation layer, an "insert … on conflict do
  update/nothing" where the inserted key is written in a different form than it is stored
  (e.g. the text '1' into an integer key holding 1) wrongly throws away the existing row and
  keeps the just-inserted one, instead of updating or leaving the existing row. Plain store
  and the in-memory engine both handle it correctly — only the isolation overlay is wrong.
files:
  - packages/quereus-isolation/src/isolated-table.ts   # insert/UNIQUE-conflict + overlay staging path
  - packages/quereus-store/src/common/store-table.ts    # coerceRow (~:853), insert conflict arm (~:1472) — the correct reference behavior
  - packages/quereus/src/runtime/emit/dml-executor.ts   # engine matchUpsertClause / executeUpsertUpdate — the CALLER (do not change)
  - packages/quereus/test/logic/47.4-upsert-conflict-target-affinity.sqllogic  # memory-only repro; flip to run in store mode once fixed
  - packages/quereus/test/logic.spec.ts                 # MEMORY_ONLY_FILES excludes 47.4 in store mode — remove that entry once fixed
difficulty: medium
---

# ON CONFLICT with an affinity-coerced PK value corrupts the row under the isolation layer

## Plain-language summary

SQLite (and Quereus) apply a column's *affinity* to a value before storing it: inserting the
text `'1'` into an `integer` column stores the integer `1`. So `insert into t values ('1', …)`
into a table that already holds a row with `id = 1` is a primary-key conflict. With an
`on conflict (id) do update …` / `do nothing` clause, that conflict should run the update (or be
skipped) against the **existing** row.

Under the memory backend and the plain store backend this works. Under the **isolation layer**
(the `createIsolatedStoreModule` wrapper the store-mode test harness uses, and the default for
store-backed transactional tables) it does not: the freshly-inserted row wins and the existing
row is lost.

## Reproduction

```sql
create table t (id integer primary key, n integer);
insert into t values (1, 100);
insert into t values ('1', 0) on conflict (id) do nothing;   -- proposed id is TEXT '1'
select id, n from t;
```

- **Memory backend / plain `StoreModule`:** `[{"id":1,"n":100}]` — DO NOTHING skipped, existing row intact. ✅
- **Isolated store (`createIsolatedStoreModule`):** `[{"id":1,"n":0}]` — existing row replaced by the proposed row. ❌

Same corruption with `do update set n = 555` (result is `n = 0`, the proposed value, not `555`)
and with a non-PK `unique` column keyed as `integer` and a proposed TEXT `'7'`.

A **same-storage-class** conflict (`insert into t values (1, 0) on conflict (id) do …`, integer
`1`) works correctly under the isolation layer — so the defect is specific to a proposed key
value whose storage class differs from the stored key's (the value the column's affinity
coerces onto the same key).

## Why this surfaced now

The engine's conflict-target matcher (`matchUpsertClause`, `runtime/emit/dml-executor.ts`) used
to compare the proposed value to the stored value by byte identity, so `'1'` (text) never matched
a stored integer `1` — the statement aborted with `UNIQUE constraint failed` before the isolation
overlay's mishandling could run. Ticket `bug-upsert-conflict-target-collation-match` corrected the
matcher to compare the way the constraint enforces (apply affinity, then the enforcement
collation), which is the right SQLite semantics. That fix now routes this conflict into the
DO UPDATE / DO NOTHING arm — exercising, and thereby exposing, the latent isolation-layer bug.
The engine fix is correct; this ticket is the store-isolation side.

## Suspected mechanism (starting point, not a conclusion)

Plain store coerces the whole proposed row to the declared column types (`StoreTable.coerceRow`,
`validateAndParse` per column) *before* extracting the PK and probing for a conflict, then
returns `{ status: 'constraint', existingRow }` and writes nothing. The engine then either skips
(DO NOTHING) or issues a follow-up `update` keyed on the existing row's coerced PK.

The isolation overlay appears to stage the proposed row (or key it) using the *pre-coercion*
value, so the staged entry lands under a different overlay slot than the one the conflict
detection / the follow-up update address — leaving the proposed row in the overlay to shadow the
committed row at commit. Confirm whether the overlay's insert path coerces the row and keys the
staged entry with the same affinity + key-collation the underlying store uses (mirroring
`StoreTable.coerceRow` / `buildDataKey`), and whether a returned UNIQUE constraint result
correctly discards any staged proposed row.

## Expected behavior

Under the isolation layer, an `on conflict` insert whose proposed key value coerces (by affinity)
onto an existing stored key must behave exactly as on the memory / plain-store backends: DO
NOTHING leaves the existing row untouched; DO UPDATE updates the existing row. No cross-storage-
class replacement.

## Acceptance

- The reproduction above returns `[{"id":1,"n":100}]` (DO NOTHING) and the DO UPDATE / non-PK
  UNIQUE variants update the existing row, under the isolated store module.
- Remove `47.4-upsert-conflict-target-affinity.sqllogic` from `MEMORY_ONLY_FILES` in
  `packages/quereus/test/logic.spec.ts` and confirm it passes in store mode
  (`yarn test:store`). That file already encodes the three variants (PK DO UPDATE, PK DO
  NOTHING, non-PK UNIQUE DO UPDATE).
