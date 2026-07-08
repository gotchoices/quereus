description: Fixed three isolation-layer robustness defects — a big-integer primary-key crash, duplicate rows when a case-insensitive key changes case, and a missing uniqueness check when an insert reuses a just-deleted key in the same transaction.
files:
  - packages/quereus-isolation/src/isolated-table.ts         # mergedSecondaryIndexQuery (~407-465); insert tombstone-revival branch (~774-795)
  - packages/quereus-isolation/test/isolation-layer.spec.ts   # describe: "merged secondary-index key encoding (bigint / collation)" — 4 specs
  - docs/design-isolation-layer.md                            # Index Scan Merge + Cross-Layer Constraint Detection sections
  - packages/quereus/src/util/key-serializer.ts               # serializeRowKey / resolveKeyNormalizer (reused, unchanged)
  - tickets/fix/1-txn-changelog-bigint-key.md                 # spun-off core-engine bigint change-log crash
difficulty: medium
----

## What shipped

Three defects in `packages/quereus-isolation/src/isolated-table.ts`, all fixed and
verified.

- **Bug 1 + 2 — `mergedSecondaryIndexQuery`.** The modified-PK set that excludes
  shadowed underlying rows during a secondary-index merge was keyed with
  `JSON.stringify(pk)`, which threw on a bigint PK and ignored collation (a NOCASE
  PK rewritten `'abc'` → `'ABC'` surfaced both the overlay and underlying rows).
  Both build and check sites now use the engine's canonical `serializeRowKey` with
  one `resolveKeyNormalizer` per PK column, agreeing with `getComparePK` / `keysEqual`.
- **Bug 3 — insert tombstone-revival branch.** An INSERT reusing a PK tombstoned
  earlier in the same transaction early-returned without the merged non-PK UNIQUE
  check, so a revived row colliding on a secondary UNIQUE slipped through and later
  flushed with `trustedWrite` (store skips its own re-check) → opaque INTERNAL error
  at commit. The branch now runs `checkMergedUniqueConstraints(overlay, values, [pk], …)`
  before the overlay write, surfacing REPLACE evictions via `attachEvicted`.

A separate, pre-existing core-engine bug surfaced during implementation: the
transaction change-log key encoder (`TransactionManager.serializeKeyTuple`) *also*
uses `JSON.stringify` and crashes on a bigint PK on a plain non-isolated table,
before the isolation merge path is ever reached. Spun off as
`fix/txn-changelog-bigint-key` (heavier: its key is round-tripped via `JSON.parse`,
so the encoder must be reversible). The bug-1 spec stages its bigint overlay row by
direct injection to sidestep that crash and drive the isolation merge site directly.

## Review findings

Reviewed the implement-stage diff (`b0800ca9`) with fresh eyes against the source,
the reused helpers (`serializeRowKey` / `resolveKeyNormalizer` / `_getCollationNormalizer`),
the flush path, and the engine-wide hash-key convention. Build, lint
(`yarn workspace @quereus/quereus lint` → exit 0), and the isolation suite
(`yarn workspace @quereus/isolation test` → **141 passing**) all green.

**Correctness — verified, no defects.**
- Bug 1/2: both sides of the merge use the same encoder + normalizers, so shadowing
  is internally consistent; number-vs-bigint tag divergence is a non-issue in
  practice (a given integer value has a deterministic JS type — number if
  ≤ MAX_SAFE_INTEGER, else bigint — so the same logical PK never mixes types across
  layers). Confirmed the two fixed sites are the *only* `JSON.stringify` PK-keying
  spots in the package; no other ad-hoc PK-string Set/Map keying exists.
- Bug 3: traced `findMergedUniqueConflict` — `selfPks=[pk]` correctly excludes the
  revived row's own PK, UNIQUE columns compared under enforcement collation, and the
  `trustedWrite` flush path (which skips the store's re-check) confirms the pre-check
  is required at exactly this branch. Fix mirrors the tested normal-insert path.

**Test coverage — one gap closed inline.**
- Added a 4th spec covering the bug-3 **REPLACE** tombstone-revival path (the ABORT
  path was the only one tested, yet the fix uniquely enables REPLACE). It asserts B
  is evicted (tombstoned) rather than throwing, the merged view holds only the
  revived row within the txn, and both committed rows return after rollback. Fails
  pre-fix (merged view would show two rows), so it is a meaningful regression guard.
  Suite now 141 passing.

**Tripwires (recorded, not ticketed).**
- *Custom-collation merge shadowing degrades to BINARY.* `resolveKeyNormalizer` only
  knows BINARY/NOCASE/RTRIM; a custom (or comparator-only) collation on a PK column
  falls back to BINARY, so a case-only PK rewrite under such a collation could fail
  to shadow the underlying row. This is **not** a fix-specific defect — it is the
  accepted engine-wide hash-key convention (bloom-join / window / hash-aggregate /
  store UNIQUE all use the same resolver and accept the same residual, documented in
  `docs/schema.md`). Parked as a `NOTE:` at the `pkNormalizers` site pointing at the
  shared divergence and the `db._getCollationNormalizer` escape hatch if it ever
  needs fixing (must be fixed at all hash sites together).

**Environmental gap (noted, not actionable here).**
- Only the memory-backed path was run. The isolation test harness wires
  `MemoryTableModule` as the underlying; there is no store-backed isolation test
  variant to run (`yarn test:store` re-runs `packages/quereus` logic tests, not this
  package). The bug-2/bug-3 fixes route through `getComparePK` / `keysEqual` /
  `checkMergedUniqueConstraints`, which are collation-driven and store-agnostic, so
  memory coverage is representative.

**Docs — verified accurate.** `docs/design-isolation-layer.md` Index Scan Merge and
Cross-Layer Constraint Detection sections correctly describe the canonical encoder
and the tombstone-reviving UNIQUE check; match the shipped code.

**Spun-off ticket — verified appropriate scoping.** `fix/txn-changelog-bigint-key`
is a genuinely distinct subsystem (core change-log, not isolation) with a round-trip
decode constraint the isolation fix does not have. Correct to separate.
