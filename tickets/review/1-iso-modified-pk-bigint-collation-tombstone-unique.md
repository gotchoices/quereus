description: Review the fix for three isolation-layer robustness defects — a big-integer primary-key crash, duplicate rows when a case-insensitive key changes case, and a missing uniqueness check when an insert reuses a just-deleted key in the same transaction.
files:
  - packages/quereus-isolation/src/isolated-table.ts         # mergedSecondaryIndexQuery (~397-460); insert tombstone-revival branch (~756-778)
  - packages/quereus-isolation/test/isolation-layer.spec.ts   # new describe: "merged secondary-index key encoding (bigint / collation)"
  - docs/design-isolation-layer.md                            # Index Scan Merge + Cross-Layer Constraint Detection sections
  - packages/quereus/src/util/key-serializer.ts               # serializeRowKey / resolveKeyNormalizer (reused, unchanged)
difficulty: medium
----

## What was implemented

Three defects in `packages/quereus-isolation/src/isolated-table.ts`, all fixed.
Build (`yarn workspace @quereus/isolation build`), lint
(`yarn workspace @quereus/quereus lint`), and the isolation test suite
(`yarn workspace @quereus/isolation test` → **140 passing**) are all green.

### Bug 1 + 2 — `mergedSecondaryIndexQuery` (~407-457)

The modified-PK set that excludes shadowed underlying rows during a secondary-index
merge was keyed with `JSON.stringify(pk)` at two sites (build + check). That:
- **threw** `TypeError: Do not know how to serialize a BigInt` on a bigint PK, and
- **ignored collation** — under a `NOCASE` PK, an overlay row keyed `'ABC'` and the
  underlying row it shadows keyed `'abc'` produced different JSON strings, so the
  underlying row was not excluded and the scan yielded **both** (duplicate).

Fix: both sites now use the engine's canonical `serializeRowKey` with one
`resolveKeyNormalizer` per PK column (drawn from that column's declared collation),
precomputed once. bigint is tagged `b:<value>` (no throw); collation-equal keys
encode identically, agreeing with the existing `getComparePK` / `keysEqual`
comparators. The `!` (non-null assertion) is safe because PK columns are NOT NULL;
both sides use the same encoder so they stay consistent regardless — commented at
each site.

### Bug 3 — insert tombstone-revival branch (~756-778)

When an INSERT reused a PK tombstoned earlier in the same transaction, the branch
early-returned **without** the merged non-PK UNIQUE check. A revived row colliding
on a secondary UNIQUE was missed and later flushed with `trustedWrite` (store skips
its own re-check) → opaque INTERNAL error at commit, or silent corruption.

Fix: the branch now runs `checkMergedUniqueConstraints(overlay, values!, [pk], …)`
(selfPks `[pk]` excludes the row's own PK) before the overlay write, surfacing any
REPLACE evictions via `attachEvicted` — mirroring the normal insert path.

## Use cases to validate / exercise

The three new specs live in a `describe('merged secondary-index key encoding
(bigint / collation)')` block in `isolation-layer.spec.ts`. Each stages **pending
overlay changes** so the merge path (not the fast delegate-to-underlying path) runs.

1. **bigint PK secondary scan** — a committed small-int row + a directly-injected
   bigint-PK overlay row; a secondary-index scan. Pre-fix throws on the bigint;
   post-fix returns rows and the bigint PK round-trips through the merge.
2. **NOCASE PK case-change** — `id TEXT COLLATE NOCASE PRIMARY KEY`; committed
   `'abc'`, then in-txn update to `'ABC'`, then secondary scan → asserts exactly
   one merged row (pre-fix: two).
3. **tombstone-revival UNIQUE collision** — PK + separate `UNIQUE(u)`; delete A
   (pk=1), then insert new pk=1 colliding with B on `u` → asserts a clean
   `StatusCode.CONSTRAINT` throw (not INTERNAL), and B intact after rollback.

## Known gaps / honest flags (reviewer: verify these)

- **The bug-1 test uses direct overlay injection, not a plain SQL INSERT.** During
  implementation I discovered a **separate, pre-existing core-engine bug**: the
  transaction change-log key encoder (`TransactionManager.serializeKeyTuple` in
  `packages/quereus/src/core/database-transaction.ts`) *also* uses `JSON.stringify`
  and throws on a bigint PK — reproduced on a **plain, non-isolated** table
  (`begin; insert into t(id integer pk) values (9007199254740993, …)` → crash).
  So a SQL-level bigint-PK insert crashes at the core change-log **before** the
  isolation merge path is reached. The isolation fix is correct and necessary, but
  the bigint PK use case is only fully usable end-to-end once the core bug lands.
  That core bug is filed as **`fix/txn-changelog-bigint-key`** (has a round-trip
  constraint — its key is decoded back via `JSON.parse` — so it's a heavier change
  than the isolation fix, and genuinely a different subsystem). The bug-1 spec
  sidesteps the core crash by injecting the bigint overlay row directly; **please
  confirm** you agree this is the right scoping and that the injection test still
  meaningfully exercises the isolation-layer fix (it drives `mergedSecondaryIndexQuery`
  step-1 build over a bigint overlay PK — the exact crash site).
- **Regression strength of bug-1 test not machine-verified by a revert.** By
  construction it hits the fixed line, but I did not run a revert-and-fail cycle.
  Cheap to add if you want belt-and-suspenders.
- **Only the memory-backed path was run** (`yarn test`, not `yarn test:store`). The
  bug-2 NOCASE and bug-3 UNIQUE fixes route through `getComparePK`/`keysEqual` and
  `checkMergedUniqueConstraints`, which the store path also exercises differently;
  a store-backed run was not done here.
- **Bug 3 REPLACE path is untested.** The new spec covers the ABORT (default)
  outcome. The `attachEvicted` wiring for an `INSERT OR REPLACE` reviving a
  tombstone into a secondary-UNIQUE collision (eviction surfaced to the DML
  executor) has no dedicated spec — worth adding.
- **Collation coverage is NOCASE-only.** `RTRIM` and a custom comparator-only
  collation (which has no string normalizer → falls back to BINARY in
  `resolveKeyNormalizer`) are not tested on the isolation merge path.

## Docs

`docs/design-isolation-layer.md` updated: the Index Scan Merge section now states
the modified-PK set uses the canonical collation-aware / bigint-safe encoder (not
`JSON.stringify`), and the Cross-Layer Constraint Detection section notes that a
tombstone-reviving insert runs the merged UNIQUE check.
