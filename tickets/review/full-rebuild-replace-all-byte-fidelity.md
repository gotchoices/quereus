description: Review the full-rebuild floor `replace-all` byte-fidelity change — the wholesale identical-row skip now uses byte-faithful `rowsValueIdentical` instead of collation-aware `rowsEqual` (key pairing stays collation-aware via the PK comparator), in both the memory and store hosts. Verify the two pinned spec cases flipped correctly, the new NOCASE coverage is sound, and the docs collapsed to one discipline.
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts                    # replace-all arm (~L1403) now rowsValueIdentical; dead rowsEqual removed; comments updated
  - packages/quereus-store/src/common/backing-host.ts                    # applyReplaceAll (~L210) now rowsValueIdentical; dead rowsEqual removed; compareSqlValues import dropped
  - packages/quereus/src/util/comparison.ts                              # rowsValueIdentical (unchanged) — the byte-faithful discipline
  - packages/quereus/test/vtab/maintenance-replace-all.spec.ts          # L137 case flipped + byte-identical sibling added; header + L120 doc updated
  - packages/quereus-store/test/backing-host.spec.ts                    # new replace-all NOCASE byte-faithful case in the DESC/NOCASE block
  - packages/quereus/test/incremental/maintenance-equivalence.spec.ts   # new full-rebuild floor NOCASE-PK equivalence suite (deterministic + property)
  - docs/materialized-views.md                                          # § Value-identical write suppression — divergence note removed
  - docs/incremental-maintenance.md                                     # § replace-all primitive — collation-aware KEY pairing + byte-faithful VALUE compare
----

# Review: full-rebuild floor `replace-all` byte-fidelity

## What changed and why

The full-rebuild MV maintenance floor replaces the backing wholesale via a `replace-all`
`MaintenanceOp`, realized as a minimal keyed diff against the before-image. Two distinct
disciplines were conflated in that diff:

- **Key pairing** — which old row a new row pairs with — is collation-aware (the PK
  comparator). Load-bearing and **unchanged**: under a NOCASE PK, `'apple'` pairs with a
  stored `'APPLE'` so the result is an `update`, never a spurious insert + delete that
  would leak secondary-index bookkeeping.
- **Identical-row skip** — whether a paired row is a no-op — was *also* collation-aware
  (`rowsEqual` → per-column `compareSqlValues` under each column's collation). That was
  the bug: under NOCASE, `'apple'` ≡ `'APPLE'` and the payload matched, so a case-only
  rewrite was **skipped** and the backing kept stale bytes — `read(MV) != evaluate(body)`,
  a byte-wise violation of the maintenance-equivalence oracle.

The fix narrows the skip to **byte-faithful** `rowsValueIdentical` (BINARY per column,
numeric-storage-class tolerant), matching the point-op `upsert` skip already made
byte-faithful by `mv-noop-upsert-suppression`. Now a collation-equal / byte-different
paired row is an `update` that re-keys the stored bytes; a byte-identical row still skips.
Both hosts (memory `MemoryTableManager`, store `StoreBackingHost`) align identically. The
dead private `rowsEqual` was removed from both; the store host's now-unused
`compareSqlValues` import was dropped (it stays in the manager — still used elsewhere).

**Confirmed repro before fix** (per the implement-ticket investigation): `update t set
id='APPLE' where id='apple'` over a full-rebuild MV `select id, v from t` returned stale
`'apple'` from the MV backing while the live body returned `'APPLE'`. After the fix it
returns `'APPLE'`.

## Use cases / behavior to validate

- **Case-only PK rewrite under NOCASE re-keys the backing** (the bug): a full-rebuild MV
  over a `text collate nocase primary key` body must read the *new* byte value after a
  case-only `update id`. Pinned deterministically + property-tested in the new
  `maintenance-equivalence.spec.ts` floor-NOCASE suite.
- **True no-ops still suppress**: a `replace-all` with byte-identical rows emits no
  change and causes no btree churn (narrowed skip must not over-fire). Pinned in
  `maintenance-replace-all.spec.ts` (NOCASE byte-identical sibling case + the existing
  all-identical case).
- **Cross-type numeric tolerance preserved**: number `5` vs bigint `5n` still skip
  (byte-faithful is BINARY but numeric storage classes fold). Pinned in the L120 case.
- **Key pairing still collation-aware**: a collation-equal key with a changed payload is
  a single `update` (not insert + delete). Pinned in the unchanged L151 case.
- **Store-host parity**: same behavior over the store backing host (composite NOCASE/DESC
  PK). Pinned in `backing-host.spec.ts`.

## Validation run (all green)

- `test:single packages/quereus/test/vtab/maintenance-replace-all.spec.ts` — **11 passing**.
- `test:single packages/quereus/test/incremental/maintenance-equivalence.spec.ts` —
  **104 passing** (includes the new floor-NOCASE suite: 2 cases).
- `yarn workspace @quereus/store run test:single packages/quereus-store/test/backing-host.spec.ts`
  — **28 passing** (includes the new replace-all NOCASE case).
- `yarn workspace @quereus/quereus run test` (full memory suite) — **5853 passing, 9 pending**, exit 0.
- `yarn workspace @quereus/quereus run lint` — clean, exit 0.

## Honest gaps / things for the reviewer to probe

- **`test:store` (LevelDB persistence path) was NOT run** — the ticket directed using the
  targeted Mocha unit run instead (it's the store logic path but slower). The store
  `backing-host.spec.ts` exercises the host against the **in-memory** store provider
  (isolated + bare `StoreModule`), not a real LevelDB provider. The byte-fidelity change
  is provider-agnostic (a pure row comparison *before* `coordinator.put`), so persisted
  behavior should be identical — but this is unverified against an actual on-disk store.
- **No store-backed equivalence oracle for the floor.** The `maintenance-equivalence.spec.ts`
  oracle uses memory tables; the store `replace-all` is covered only by the direct host
  unit spec, not an end-to-end `read(MV) == evaluate(body)` oracle over a store backing.
- **Single-column NOCASE PK only** on the memory equivalence side. The store case uses a
  composite `(name desc, k)` PK with NOCASE on the leading column, but neither side
  pins a *multi-column NOCASE* PK in the wholesale-diff path beyond that.
- **Comment-only reference to the old `rowsEqual`** remains in the new equivalence-suite
  docstring (`maintenance-equivalence.spec.ts` ~L818) — intentional, it explains the bug
  context ("were the skip collation-aware (the prior `rowsEqual`)…"). Confirm it reads as
  historical context, not a live code reference.
- The `replace-all` op is reached in production only via the full-rebuild floor; the
  equivalence suite now covers that path (memory). Worth a sanity check that
  `forceFullRebuild` truly routes the NOCASE body through `applyFullRebuild` →
  `'replace-all'` and not some bounded-delta arm (the suite asserts equivalence, not the
  plan kind, for the NOCASE case specifically — the integer-PK floor suites assert kind).
