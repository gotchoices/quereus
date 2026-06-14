description: Memory module under-enforced a UNIQUE constraint when two UNIQUE indexes covered the same column-set with different collations — `findIndexForConstraint` resolved the enforcing index BY COLUMN-SET (first match in `schema.indexes`), so both same-column-set UCs enforced under the first-listed index's collation, silently under-enforcing a coarser-declared UNIQUE in an order-sensitive way. Fixed by resolving an index-derived UC BY NAME via `uc.derivedFromIndex` (matching store/isolation), keeping the column-set scan only as the non-derived/defensive fallback. Implemented + tested; ready for adversarial review.
prereq:
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts                  # findIndexForConstraint (the fix, ~line 1018-1045) + checkUniqueViaIndex comment (~line 1047+)
  - packages/quereus/src/schema/unique-enforcement.ts                  # helper doc-comment (~line 19-30) reworded
  - packages/quereus/test/unique-enforcement-collation.spec.ts         # header + resolveLiveIndex mirror + Shape/byIndex + multi-index shapes + test body
  - packages/quereus/test/logic/102.2-unique-collation.sqllogic        # §11 (both creation orders) + header
difficulty: medium
----

# Review: memory under-enforced UNIQUE with multiple same-column-set indexes of differing collation

## What changed (the fix)

`MemoryTableManager.findIndexForConstraint` (`manager.ts` ~line 1018) now resolves an
**index-derived** UNIQUE constraint by name before the column-set scan:

```ts
if (uc.derivedFromIndex) {
  const index = targetLayer.getSecondaryIndex?.(uc.derivedFromIndex);
  if (index) return { kind: 'memory-index', index };
}
// non-derived / defensive fallback: column-set scan (unchanged)
```

This sits **after** the `allowMvCovering` MV check and **before** the column-set loop, so
the MV-preference and maintenance-write paths are untouched. Returning the UC's OWN
`MemoryIndex` makes BOTH the final `compareSqlValues` (reads `index.specColumns[i].collation`)
AND candidate generation (`index.getPrimaryKeys` over a BTree keyed under that index's own
collation) use the correct per-column collation — so a coarser NOCASE UNIQUE now buckets
`'Bob'`/`'bob'` together and finds the conflict, regardless of index creation order.

Non-derived UCs (table-level / column UNIQUE) have `derivedFromIndex` unset and fall through
to the column-set scan, which finds the auto-built `_uc_*` index carrying the declared
collation — unchanged and correct for that shape.

The companion change is **documentation/comment**: the three sites that described this as a
"KNOWN gap / pre-existing memory bug" were reworded to state the two resolution paths now
agree on the multi-index shape (`manager.ts` `checkUniqueViaIndex` comment,
`unique-enforcement.ts` doc-comment, spec header).

## Why this was a bug (root cause, confirmed during fix stage)

The shared `uniqueEnforcementCollations(schema, uc)` helper (imported by `quereus-store` and
`quereus-isolation`) resolves the enforcement collation **by name** via `uc.derivedFromIndex`
— each UC enforces under its own index. Memory's `findIndexForConstraint` resolved **by
column-set**, returning the FIRST `schema.indexes` entry whose columns match. With two UNIQUE
indexes over the same column-set, both UCs collapsed onto the first-listed index → the coarser
one was enforced under the finer's collation. On `main`, the BINARY-first order *admitted* a
NOCASE duplicate (bug); the reverse order rejected it (order-sensitivity). The fix makes both
orders reject — matching SQLite and the store module.

## How to validate

Build/lint/tests already run green (see "Verification" below). To re-exercise:

- **Behavioral (runs under memory AND store):**
  `yarn workspace @quereus/quereus test` filtered to `--grep "102.2"`, and
  `QUEREUS_TEST_STORE=true … --grep "102.2"`. §11 in
  `test/logic/102.2-unique-collation.sqllogic` covers BOTH creation orders:
  - **11a** BINARY index first, then NOCASE → NOCASE UNIQUE rejects `'bob'` after `'Bob'`;
    `'Carol'` still inserts (finer index keeps byte-distinct apart, no false conflict).
  - **11b** NOCASE first, then BINARY → same rejection, proving order-independence.
- **Conformance lock:** `test/unique-enforcement-collation.spec.ts` drives every shape through
  BOTH the shared helper (by-name) and the live-index path (`resolveLiveIndex`, updated to
  mirror the new by-name-then-column-set resolution) and asserts equal per-column collation.
  Two new shapes — `multi-index same column-set (BINARY first)` / `(NOCASE first)` — use the
  `byIndex` field to pick each UC by its `derivedFromIndex` name (since
  `uniqueConstraints[0]` no longer uniquely identifies a constraint when two share a
  column-set) and assert each resolves to its OWN index's collation.

### Manual repro (sanity)

```sql
create table t (id integer primary key, b text collate nocase);
create unique index ix_binary on t (b collate binary);   -- finer, created FIRST
create unique index ix_nocase on t (b collate nocase);   -- coarser
insert into t values (1, 'Bob');
insert into t values (2, 'bob');   -- must be REJECTED (NOCASE UC) — was admitted on main
```

## Verification performed

- `yarn workspace @quereus/quereus lint` → **EXIT=0** (eslint + `tsc -p tsconfig.test.json`,
  which type-checks the spec call sites — catches the `Shape.expected` → optional + `byIndex`
  signature changes).
- `yarn workspace @quereus/quereus test` (full memory suite) → **6283 passing, 9 pending,
  EXIT=0**.
- Targeted `unique-enforcement-collation.spec.ts` → **9 passing** (incl. both new shapes).
- `102.2-unique-collation.sqllogic` under memory AND store (`--grep "102.2"`) → both passing.

## Known gaps / things for the reviewer to probe (work is a floor, not a finish line)

1. **Non-derived UC + derived index over the SAME column-set (untested mixed shape).** The fix
   only reroutes UCs with `derivedFromIndex` set. A non-derived UNIQUE still uses the column-set
   scan, which returns the FIRST matching index. If a table additionally has a
   `CREATE UNIQUE INDEX … COLLATE x` over the same column-set AND that derived index is listed
   in `schema.indexes` before the non-derived UC's auto-built `_uc_*` index, the non-derived UC
   could resolve to the derived index and enforce under `x` rather than the declared collation.
   This is outside the reproduced scenario (two *derived* indexes) and may not be reachable
   depending on `_uc_*` ordering in `ensureUniqueConstraintIndexes`, but I did not prove it
   safe. Worth a reviewer check: does `schema.indexes` ordering guarantee the non-derived UC's
   own `_uc_*` index is found first, or is a by-name resolution warranted there too?

2. **§11 cannot isolate a "genuine BINARY duplicate rejected by the BINARY UNIQUE" case.** Any
   re-insert of an existing byte-value is *also* a NOCASE duplicate, so the BINARY-only
   rejection can't be exercised independently. §11 instead demonstrates the BINARY index's
   "keeps byte-distinct apart" property via the `'Carol'` insert succeeding (no false conflict).
   Acceptable but not a full isolation of the finer index's enforcement.

3. **Defensive fallback path (name doesn't resolve) is not directly covered.** If
   `uc.derivedFromIndex` is set but `getSecondaryIndex(name)` returns undefined, the code falls
   through to the column-set scan. This is defensive and not expected in practice; no test
   forces it.

4. **Full `yarn test:store` suite not run.** Per the ticket, only the store path on
   `102.2-unique-collation.sqllogic` was exercised under store (passing). The broader store
   suite was not re-run (the shared helper path it depends on was unchanged by this fix).
