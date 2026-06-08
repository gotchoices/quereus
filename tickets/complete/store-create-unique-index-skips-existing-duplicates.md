---
description: `StoreModule.buildIndexEntries` now enforces UNIQUE during the seed pass for `CREATE UNIQUE INDEX` over pre-existing data — duplicates are rejected with `UNIQUE constraint failed: <table> (<cols>)` before any entries are written, partial predicates are honored, and the SQL "multiple NULLs are allowed" rule is preserved. Matches the memory module's `populateNewIndex`.
files:
  packages/quereus-store/src/common/store-module.ts             # buildIndexEntries — compilePredicate + Set dup-check
  packages/quereus-store/test/column-default-conflict.spec.ts   # unit tests under the CREATE INDEX block
  packages/quereus/src/vtab/memory/layer/base.ts                # reference: populateNewIndex
  packages/quereus/test/logic/102.1-unique-edge-cases.sqllogic  # logic coverage lines 57-100
---

## What changed

`StoreModule.buildIndexEntries` previously wrote one index entry per row
unconditionally, so `CREATE UNIQUE INDEX` over duplicated data silently
produced a UNIQUE index that already had duplicate keys — only the *next*
insert would have been caught by the synthesized `uniqueConstraint`.

The seed pass now mirrors `populateNewIndex` in the memory module:

1. If `indexSchema.predicate` is set, compile once with
   `compilePredicate(indexSchema.predicate, tableSchema.columns)` and skip
   rows whose predicate is not unambiguously TRUE (false/null both
   exclude — matches SQLite partial-index semantics).
2. For UNIQUE indexes, a `Set<string>` of `JSON.stringify(indexValues)`
   tracks already-seen rows. Rows where any indexed column is NULL skip
   the dup check (SQL UNIQUE allows multiple NULLs) but still emit their
   index entry.
3. On collision, throw
   `QuereusError(StatusCode.CONSTRAINT, "UNIQUE constraint failed: <tableName> (<colNames>)")`
   — same message shape as `store-table.ts:checkUniqueConstraints`.
4. The throw fires before `batch.write()`, so the index store is left
   empty on failure.

## Review findings

### Reviewed

- **Behavior vs. memory module** — implementation is a faithful mirror of
  `populateNewIndex` (`packages/quereus/src/vtab/memory/layer/base.ts:233-269`):
  same predicate-compile timing, same NULL-skip rule, same `JSON.stringify`
  dedup signature, same error message format. Consistent behavior between
  the memory and store paths is the explicit goal.
- **Schema rollback on failure** — `createIndex` calls `getIndexStore`,
  then `buildIndexEntries`, then `table.updateSchema(updatedSchema)`. The
  throw fires from inside `buildIndexEntries` *before* `updateSchema`, so
  the in-memory `StoreTable` schema is unchanged on failure — the engine
  sees no UNIQUE constraint, no index, and the test verifies a retry after
  `DELETE` succeeds (reusing the same index-store directory).
- **Imports** — `compilePredicate` and `CompiledPredicate` are exported
  from `@quereus/quereus` (`packages/quereus/src/index.ts:138-139`) and
  the same pair is already imported by `store-table.ts` for the runtime
  UNIQUE-check path — no new dependency surface.
- **Lint / typecheck / tests** — `yarn workspace @quereus/quereus run lint`
  clean. `yarn workspace @quereus/store run typecheck` clean.
  `yarn workspace @quereus/store run test` → 266 passing (264 from the
  implement stage + 2 new partial-predicate cases added during review).

### Fixed in this pass (minor)

- **Partial-predicate seed-pass coverage gap** — the implementer flagged
  the missing test under "Known gaps". Added two cases in
  `column-default-conflict.spec.ts`:
  - `partial UNIQUE seed pass: duplicates outside the predicate scope are allowed`
    (rows with same `x` but both `active = 0`, predicate is `active = 1`,
    `CREATE UNIQUE INDEX` succeeds).
  - `partial UNIQUE seed pass: duplicates inside the predicate scope are rejected`
    (two rows with same `x` and `active = 1` + one out-of-scope dup;
    `CREATE UNIQUE INDEX` fails with a UNIQUE error).
  Both pass.

### Observations — left as-is (pre-existing pattern, also true of the memory module)

- **`JSON.stringify` doesn't handle `bigint`** — for INTEGER columns
  outside the `MIN_SAFE_INTEGER..MAX_SAFE_INTEGER` window, values
  deserialize as `bigint` (`packages/quereus-store/src/common/serialization.ts`
  reviver, and `packages/quereus/src/util/affinity.ts:33-43`). Stringifying
  a `bigint` throws `TypeError: Do not know how to serialize a BigInt`.
  The memory module's `populateNewIndex` does the same thing
  (`packages/quereus/src/vtab/memory/layer/base.ts:253`), so this is a
  shared latent risk on > 2^53 INTEGER values in a UNIQUE index. Out of
  scope here — fixing it should be a coordinated change at both sites
  (custom replacer or a shared serializer that handles `bigint` and
  `Uint8Array`).
- **Case-sensitive dedup vs. NOCASE-encoded keys** — `buildIndexKey` is
  invoked with `{ collation: 'NOCASE' }` hardcoded, so `'foo'` and
  `'FOO'` produce the same encoded byte key. The dup-check, however,
  uses raw `JSON.stringify` which is case-sensitive, so two case-variant
  rows would both pass the dedup gate and then collide in the batch
  (second `put` wins). The memory module has the same shape — the BTree
  is case-folding via collation but the `seen` map is case-sensitive.
  Not a regression from this fix; would warrant a separate ticket if
  ever exercised. (No production scenario currently hits it, and the
  prior code was strictly worse — it didn't dedup at all.)
- **Orphaned index-store directory on failure** — `getIndexStore`
  allocates the storage directory before `buildIndexEntries` runs; on
  throw the directory exists but contains zero entries (test verified).
  The next successful retry reuses the same directory. The original
  ticket explicitly scoped tear-down on partial failure as out-of-bounds.

### Categories with nothing to report

- **Resource cleanup** — no streams/handles opened by `buildIndexEntries`
  that need teardown; `batch` is local and is GC'd on throw.
- **Type safety** — explicit types on `predicate`, `seen`, and the
  thrown `QuereusError`; no `any` introduced.
- **Performance** — single in-memory `Set<string>` allocated only for
  UNIQUE indexes, scoped to one CREATE INDEX. Matches memory module.
- **Concurrency** — `createIndex` is a DDL operation routed through the
  engine's serialized schema-change path; no new concurrent-access
  hazard introduced.
- **Docs touched by this change** — none required. `docs/optimizer.md`,
  `docs/schema.md`, and `packages/quereus-store/README.md` describe
  index lifecycle at a level that doesn't enumerate seed-pass dedup
  semantics; the new code matches the memory module's documented
  contract, so the user-facing story is unchanged.

## Tests run

- `yarn workspace @quereus/store run typecheck` — clean.
- `yarn workspace @quereus/store run test` — 266 passing (incl. 2 new
  partial-predicate tests).
- `yarn workspace @quereus/quereus run lint` — clean.
- Inherited from implement stage: `yarn test` (2942 passing, 2 unrelated
  pre-existing failures in `@quereus/sample-plugins`), `yarn test:store`
  (636 passing, 1 unrelated pre-existing failure in 29.1).
