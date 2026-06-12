description: StoreTable.update()'s four internal probe/old-image reads (insert PK-conflict probe, update old-image, update PK-change probe, delete old-image) now route through the pending-overlay read primitive readEffectiveRowByKey, so bare-StoreModule DML conflict/cleanup/stats/event decisions agree with RYOW queries. Reviewed, validated, and accepted.
files:
  - packages/quereus-store/src/common/store-table.ts        # update() arms (insert ~848, update old-image ~984, PK-change probe ~1009, delete old-image ~1113); readEffectiveRowByKey ~1487
  - packages/quereus-store/test/store-ryow.spec.ts           # new describe "StoreTable DML internal reads are pending-aware (bare StoreModule)" (7 cases)
  - packages/quereus-isolation/src/isolated-table.ts         # flushOverlayToUnderlying ~1320 — trusted-flush invariants the safety comment pins
  - packages/quereus/src/vtab/table.ts                       # UpdateArgs.trustedWrite — doc confirms isolation-flush-only
  - packages/quereus-store/README.md                         # § Module Capabilities RYOW bullet — extended
----

# Complete: bare-store DML internal reads made pending-aware

## What landed

`StoreTable.update()` made four internal probe/old-image reads with
committed-only `store.get(...)`. A row written earlier in the same coordinator
transaction lives only in the pending bucket, so those probes reported "absent":
no PK conflict raised, no secondary-index cleanup, wrong stats deltas, and
events with a missing `oldRow`. All four now route through
`readEffectiveRowByKey(key)` (pending delete ⇒ null, pending put ⇒ its row, else
committed get), returning `Row | null` directly.

The insert-arm PK-conflict probe deliberately stays committed-only on the
trusted-flush (`trustedWrite`) path — a row present on a trusted insert is an
isolation-layer invariant violation that must surface loudly as INTERNAL. The
update/delete old-image reads and the update PK-change probe read effective
unconditionally; trusted safety there rests on the flush's deletes-first +
one-entry-per-PK invariants (effective ≡ committed on a flush write probing its
own key). README RYOW bullet extended to document the new behavior.

## Review findings

Adversarial pass over the implement diff (`acfc3870`), read with fresh eyes
before the handoff summary. Scrutinized SRP/DRY/modularity, type safety, error
handling, resource cleanup, performance, and the regression surface.

### Checked — correctness & safety reasoning
- **Trusted-flush divergence is sound.** Verified against the real
  `flushOverlayToUnderlying` (`isolated-table.ts:1320`): the flush runs in its
  own underlying mini-transaction, the overlay holds at most one entry per PK
  (stable-sorted), and tombstone deletes are applied before inserts/updates. So
  when any flush write probes its own key there is no prior pending op at that
  key → effective ≡ committed. The committed-only insert probe is therefore a
  pinned INTERNAL guard, not a correctness requirement. Confirmed.
- **`trustedWrite` is isolation-flush-only.** `find_references` over the whole
  tree: the only writers are the two flush sites (insert + update) in
  `isolated-table.ts`; the flush's delete path does NOT set it (and doesn't need
  to — the delete arm always reads effective, which equals committed during the
  flush). `UpdateArgs.trustedWrite`'s own doc comment corroborates "Used only by
  the isolation overlay→underlying flush." No non-flush caller can reach the
  divergent path. Confirmed.
- **Index/stats netting.** Empirically verified by the new tests: insert-then-
  delete in one txn nets row-count to 0 and leaves 0 index entries; REPLACE over
  a pending row keeps row-count 1 and the index at exactly 1 entry (the pending
  index-put is cancelled by the coordinator delete; a commit-batch delete of a
  never-committed key is a harmless no-op).

### Checked — tests (bug-floor verified, not assumed)
- Ran the new describe against a source reverted to committed-only reads: **all
  7 cases fail**, each for its documented reason (no UNIQUE raised, wrong final
  value, stats 2 vs 1, 2 index entries vs 1, stats 1 vs 0). This is a real,
  well-targeted regression floor — restored source, confirmed clean (empty diff).
- Coverage spans happy path, conflict (ABORT/IGNORE/REPLACE), PK-change conflict
  + REPLACE-eviction, index cleanup, stats netting, and event `oldRow` payloads.

### Checked — type safety / style / performance
- `yarn workspace @quereus/store run typecheck` (real `tsc --noEmit`, not the
  type-stripping test runner) → **EXIT 0**. No `any`, returns `Row | null`
  cleanly; the intermediate `Uint8Array`/`deserializeRow` juggling was removed.
- The insert arm checks `args.trustedWrite` in two consecutive blocks (read
  selection, then the loud-guard). Considered collapsing for DRY — **left as-is
  on purpose**: separating the read-selection from the guard keeps the pinned-
  invariant comment legible and the divergence explicit. Not a defect.
- `readEffectiveRowByKey` re-invokes `ensureStore()` although `store` is already
  in scope at the probe sites. `ensureStore()` is memoized (`if (this.store)
  return Promise.resolve(this.store)`), so the redundant call is effectively free
  — no perf regression. No change needed.

### Found — nothing requiring a fix or a new ticket
No minor defects to fix inline; no major defects to spin out. The implementer's
documented gaps were re-examined and judged acceptable / out of scope:
- **`UPDATE OR REPLACE` is parser-unsupported** (logic/47.2 §5) — the PK-change
  REPLACE path is reachable from SQL only via a schema-level `primary key on
  conflict replace` default, which is exactly what the test uses. Correct.
- **`replacedRow` verified indirectly** — it is an internal `UpdateResult` field
  not surfaced through SQL; the test asserts the observable outcome (single row
  at the new PK, row-count 1). Pinning the field directly would need a heavier
  `update()`-level unit test inside a coordinator txn; not warranted.
- **Trusted-flush path not exercised by a NEW test** — by the flush invariants
  the divergent state is unreachable, which is precisely why the insert arm
  keeps the loud committed-only guard. The existing isolation flush-invariant
  suite is the guardrail (126 passing below).
- **`evictedRows` (secondary-UNIQUE REPLACE) over pending rows** — out of scope
  of the four-read change; the secondary-UNIQUE checks already read through the
  merged `inTransaction` path, covered by the existing "UNIQUE constraints still
  see pending writes through the merge" test.

### Docs
README § Module Capabilities RYOW bullet now states that DML's own internal
reads (PK-conflict probe, old-image reads, PK-change probe) read through the
pending merge — accurate against the landed code. No other store doc describes
this internal behavior; nothing else stale.

## Validation performed (this review)
- `yarn workspace @quereus/store run test` → **543 passing**, EXIT 0.
- `yarn workspace @quereus/store run typecheck` → EXIT 0.
- `yarn workspace @quereus/isolation run test` → **126 passing**, EXIT 0 (the
  trusted-flush regression surface).
- Bug-floor verification: 7/7 new cases fail on committed-only-reverted source,
  pass on the landed source; source restored clean afterward.

The recurring store-suite console noise (`Data change listener error: boom`,
`Failed to rehydrate DDL entry`, `rollback-to savepoint depth … out of range`)
is from deliberate fixtures in `events.spec.ts` / rehydrate / savepoint-edge
specs — not failures. No `.pre-existing-error.md` written.

## End
