description: Review the fix routing StoreTable.update()'s four internal reads through the pending-overlay read primitive (readEffectiveRowByKey) so bare-StoreModule DML conflict/old-image decisions agree with RYOW queries. Implementation + tests landed; build and all suites green.
files:
  - packages/quereus-store/src/common/store-table.ts        # update() arms — the four converted reads (insert ~848, update old-image ~955, PK-change probe ~975, delete old-image ~1078); readEffectiveRowByKey ~1453
  - packages/quereus-store/test/store-ryow.spec.ts           # new describe block "StoreTable DML internal reads are pending-aware (bare StoreModule)"
  - packages/quereus-store/test/column-default-conflict.spec.ts  # reference: the committed-row PK-change ON CONFLICT REPLACE/IGNORE tests this mirrors for pending rows
  - packages/quereus-isolation/src/isolated-table.ts         # reference only: flushOverlayToUnderlying (~1320) — trusted-flush invariants the safety comment pins
  - packages/quereus-store/README.md                         # § Module Capabilities RYOW bullet — extended
----

# Review: bare-store DML internal reads made pending-aware

## What changed

`StoreTable.update()` previously made four internal probe/old-image reads with
committed-only `store.get(...)`. A row written earlier in the same coordinator
transaction lives only in the pending bucket, so these probes reported "absent":
no PK conflict raised, no secondary-index cleanup, wrong stats deltas, and
events without `oldRow`. All four now route through `readEffectiveRowByKey(key)`
(pending delete ⇒ null, pending put ⇒ its row, else committed get), returning
`Row | null` directly (the intermediate `Uint8Array`/`deserializeRow` juggling
was dropped).

The four converted reads:

1. **insert arm PK-conflict probe** — `existingRow`. *Pinned divergence:* the
   `trustedWrite` (overlay-flush) path stays committed-only here, since a row
   present on a trusted insert is an isolation-layer invariant violation that
   must be surfaced loudly. The non-trusted path reads effective. Downstream
   `existing` → `existingRow` (constraint result, REPLACE-as-update `oldRow`,
   the `!existing` stats gate, `replacedRow`).
2. **update arm old-image read** — `oldRow`, unconditional (trusted included).
3. **update arm PK-change conflict probe** — `existingAtNewRow` (guard stays
   `pkChanged && !args.trustedWrite`; trusted flush never changes a PK). The
   stale "Read through the coordinator…" comment (documenting behavior never
   implemented) was rewritten to describe the now-real effective read.
4. **delete arm old-image read** — `oldRow`, unconditional.

A trusted-flush safety comment was added at the insert arm (where it diverges
from the others): `flushOverlayToUnderlying` runs in its own coordinator
mini-transaction, holds at most one entry per PK, and orders tombstone deletes
before inserts/updates — so a flush write probing its own key sees no pending op
yet, i.e. effective ≡ committed on every trusted probe. The delete arm note
records that the flush's delete path does NOT pass `trustedWrite`, yet
deletes-first + one-entry-per-PK keep effective ≡ committed there too.

README § Module Capabilities RYOW bullet extended to state that DML's own
internal reads (PK-conflict probe, old-image reads, PK-change probe) read
through the pending merge.

## Validation performed (all green)

- `yarn workspace @quereus/store run test` → **543 passing**, EXIT 0.
- `yarn build` → EXIT 0 (tsc across all packages clean).
- `yarn test` (root, all workspaces) → all green, **Done in 3m 26s**, EXIT 0
  (quereus 5922 passing among them).
- `yarn test:store` (logic tests vs LevelDB store) → **5918 passing**, EXIT 0.

No pre-existing failures encountered; no `.pre-existing-error.md` written. The
recurring console noise in the store suite (`Data change listener error: Error:
boom`, `Failed to rehydrate DDL entry`, `rollback-to savepoint depth … out of
range`) is from deliberate fixtures in `events.spec.ts` / rehydrate /
savepoint-edge specs — not failures.

## New tests (the bug-floor; verify they actually fail on `git stash` of the src change)

New describe in `store-ryow.spec.ts`: *"StoreTable DML internal reads are
pending-aware (bare StoreModule)"*. Uses an in-memory provider that **exposes
its `stores` map** (to count index entries by `main.t_idx_<name>` store `.size`)
and passes a `StoreEventEmitter` to the `StoreModule` ctor (capturing
`onDataChange` events; intra-transaction events fire at commit). Row count via
`module.getTable('main','t')!.getEstimatedRowCount()`.

- `begin; insert (1,'a'); insert (1,'b')` → raises UNIQUE (ABORT); pending row
  stays `'a'`.
- `begin; insert (1,'a'); insert or ignore (1,'b')` → row stays `'a'`; after
  commit rowCount 1.
- `begin; insert (1,'a'); insert or replace (1,'b'); commit` → one row `'b'`,
  rowCount 1, one **update** event with `oldRow [1,'a']`, `newRow [1,'b']`.
- `begin; insert (1,'old'); update set v='new'; commit` (index on `v`) → exactly
  **one** index entry; **update** event carries `oldRow [1,'old']`.
- `begin; insert (1,'x'); delete; commit` (index on `v`) → no rows, rowCount 0,
  **zero** index entries, **delete** event carries `oldRow [1,'x']`.
- `begin; insert (1),(2); update set id=2 where id=1` → raises UNIQUE (ABORT).
- PK-change REPLACE via schema default `primary key on conflict replace`:
  `begin; insert (1,'one'),(2,'two'); update set id=2 where id=1; commit` →
  pending row 2 evicted, one row `{id:2, v:'one'}`, rowCount 1.

## Reviewer-relevant findings / honest gaps

- **`UPDATE OR REPLACE` is intentionally unsupported by the Quereus parser**
  (logic/47.2 §5, docs/sql.md §11). The ticket's literal use case
  ("with `or replace`, result reports the pending row as `replacedRow`") cannot
  be driven from SQL via `UPDATE OR REPLACE`. The fix-stage repro must have
  called `update()` directly with `onConflict: REPLACE`. The SQL-reachable path
  to PK-change REPLACE is a **schema-level** `primary key on conflict replace`
  default, which `resolvePkDefaultConflict` honors — that is what the test uses.
- **`replacedRow` is verified only indirectly.** It is an internal `UpdateResult`
  field (consumed by the engine's DML executor for ON DELETE cascade / SET NULL),
  not surfaced through SQL. The PK-change-REPLACE test asserts the observable
  outcome (final single row at the new PK + rowCount 1), not the `replacedRow`
  value itself. A reviewer wanting to pin `replacedRow` directly would need a
  unit test that calls `update()` on a connected table inside a coordinator
  transaction (heavier; not added).
- **The trusted-flush path is not exercised by a NEW test.** Its safety rests on
  the documented invariant (deletes-first + one-entry-per-PK ⇒ effective ≡
  committed) plus the existing `isolated-store.spec.ts` flush-invariant suite,
  which passed in the full run. There is no new test that drives `update()` with
  `trustedWrite` while a pending overlay entry sits at the probed key — by the
  flush invariants that state is unreachable, which is exactly why the insert
  arm keeps the committed-only read as a loud INTERNAL guard rather than a
  silent overwrite. Worth a skeptical second look at whether any non-flush
  caller ever sets `trustedWrite` (grep: only the isolation flush does).
- **`evictedRows` (secondary-UNIQUE REPLACE) over pending rows** was not added as
  a new case. The secondary-UNIQUE checks in the insert/update arms already read
  through `inTransaction` merged reads (unchanged by this ticket; the existing
  "UNIQUE constraints still see pending writes through the merge" test covers
  the merge). Out of scope of the four-read change, but a candidate if the
  reviewer wants broader pending-eviction coverage.
- **Regression focus:** confirm `isolated-store.spec.ts`, `store-ryow.spec.ts`,
  and the column-default-conflict committed-row cases all stayed green (they did
  in `yarn test` / the store suite). The behavioral risk of this change is the
  now-unconditional effective reads in the update/delete arms changing a trusted
  flush's decision — the safety comment + isolation suite are the guardrail.
