description: Store per-PK-column key collation + ALTER-time physical re-key (Option B): the store honors ANY divergent PK collation by physically re-encoding keys, reaching memory-module parity. Replaces the prior UNSUPPORTED-reject stopgap.
files: packages/quereus-store/src/common/encoding.ts, packages/quereus-store/src/common/key-builder.ts, packages/quereus-store/src/common/store-table.ts, packages/quereus-store/src/common/store-module.ts, packages/quereus/src/schema/column.ts, packages/quereus/src/vtab/module.ts, packages/quereus-store/test/create-table-conformance.spec.ts, packages/quereus-store/test/alter-table-conformance.spec.ts, packages/quereus-store/test/index-persistence.spec.ts, packages/quereus-store/test/rehydrate-catalog.spec.ts, packages/quereus/test/logic/41.7.1-alter-column-collate-unique.sqllogic, packages/quereus/test/logic/41.7.2-alter-column-collate-unique-store.sqllogic, docs/schema.md, docs/sql.md, docs/module-authoring.md
----

## Summary

The store now encodes PRIMARY KEY uniqueness/ordering **physically** with a **per-PK-column
key collation** (`StoreTable.pkKeyCollations`, resolved by `resolvePkKeyCollations`), instead
of one fixed table-level collation K with a `UNSUPPORTED` reject for any divergence. An
explicit `collate binary` / `collate rtrim` / `collate nocase` text PK is keyed under that
collation natively (CREATE), and an `ALTER COLUMN … SET COLLATE` on a PK member physically
**re-keys** the data store (`StoreTable.rekeyRows`) + rebuilds every secondary index
(`StoreModule.rebuildSecondaryIndexes`, extracted DRY from the `alterPrimaryKey` arm), with a
first-pass `CONSTRAINT` on a collision under the new collation and no store mutation. K
survives only as the **default** for an undecorated text PK and as the secondary-index
*column* value collation. The per-column key collation round-trips through the column's
(BINARY-elided) `COLLATE` clause, so the load path needs no reconciliation. This reaches full
parity with the memory module; `41.7.1` migrated out of `MEMORY_ONLY_FILES` and is now
cross-module.

## Review findings

**Verdict:** the implementation is correct and well-tested within the store package; the
byte-compatibility argument holds; docs and tests are thorough. One **major** cross-package
gap was found (filed), one **minor** stale engine comment was fixed inline, and one
documented coverage gap was closed inline.

### Checked

- **Implement diff read first, fresh** (`git show 4f37e9f0`), then the handoff summary.
- **Encoding correctness** (`encoding.ts`, `key-builder.ts`): the new `collations` 4th arg to
  `encodeCompositeKey` overrides per-component collation only when defined; `undefined` falls
  back to `options.collation`; non-text components ignore collation (verified against
  `encodeValue`). DESC bit-inversion composes correctly with a per-column collation (both
  transforms apply in sequence). Byte-identical for the default (K=NOCASE) config — confirmed
  by reasoning and by the unchanged full store-mode logic suite.
- **`rekeyRows`** all-or-nothing (first-pass `pending`-map collision throw before any write;
  `bytesEqual` skip for no-op rows); the inherited 2-cycle swap hazard is unreachable for a
  deterministic collation re-encode (a cycle implies a `pending` collision, which throws
  first). Reused unchanged from `alterPrimaryKey`.
- **Ordering of the SET-COLLATE-on-PK arm**: both throw-only checks (non-PK UNIQUE
  re-validation, then `rekeyRows` first pass) precede the first store mutation; `rekeyRows`
  is handed `updatedSchema.columns` (new collation) while the OLD key bytes are taken
  verbatim; `rebuildSecondaryIndexes` reads the already-rekeyed data store and re-derives the
  PK suffix from `updatedSchema` — both resolve the same per-column collations, so data-key
  and index-PK-suffix encodings cannot drift. `updateSchema` (recomputes `pkKeyCollations`)
  runs last; consistent.
- **Persistence round-trip**: `generateTableDDL` emits non-BINARY `COLLATE` explicitly and
  elides BINARY; the import path defaults no-`COLLATE` to BINARY; an implicit text PK
  reconciled to NOCASE persists `collate nocase` and reloads NOCASE — so reloaded collation
  matches the bytes the keys were written under. The genuinely-legacy reopen case stays
  deferred (`store-pk-collate-legacy-reopen-divergence`), correctly documented in the
  `rehydrate-catalog` "legacy divergent…" arm.
- **Tests**: ran the full store unit suite (**397 passing**, +1 added below), the four touched
  store specs (67 passing), the `41.7` logic fixtures in **both** memory and store mode
  (3/3 each), and `eslint` on `@quereus/quereus` (clean). Conformance arms now assert
  honoring (BINARY / RTRIM / NOCASE / composite member / K=BINARY-with-explicit-NOCASE) and
  the collision→CONSTRAINT-rollback case — solid coverage.
- **Plugin packages** (leveldb / indexeddb) carry no duplicate key-encoding logic — they
  delegate to `quereus-store/common`. No drift there.

### MAJOR — filed `tickets/fix/store-pk-collate-sync-adapter-rekey.md`

`quereus-sync`'s `store-adapter.ts:218` (`applyRowChanges`) reconstructs the row data key as
`buildDataKey(pk, {collation: K}, pkDirections)` — **without** the new per-column `collations`
4th arg. Before this ticket a divergent per-column PK collation was impossible (rejected), so
keying the whole PK under K matched the store. Now that divergent collations are honored, the
adapter computes **different key bytes** than `StoreTable` for any synced table with a
divergent PK collation → remote insert/update lands at a phantom key, remote delete misses
the store's row (silent replica divergence). `resolvePkKeyCollations` is not yet in the
`@quereus/store` public barrel, so the fix also needs that export. Not fixed inline: it
crosses into another package's public API + needs quereus-sync test coverage and suite run,
beyond a safe review-pass edit. (The same adapter also never calls `buildIndexKey` — a
separate, pre-existing "sync doesn't maintain secondary indexes" concern, flagged in that
ticket as out of scope.)

### MINOR — fixed inline

- **Stale engine comment** in `packages/quereus/src/vtab/module.ts` (the `setCollation`
  contract, ~L422): it still described the store as negotiating accept-when-consistent /
  reject-when-divergent and throwing `UNSUPPORTED` on a PK collation change — no longer true.
  Rewrote it: the store (like memory) now re-keys; the negotiated-reject path is kept as the
  fallback contract for a module that genuinely *cannot* re-key. This file was not in the
  implementer's diff.

### MINOR — coverage gap closed inline

- The handoff flagged that the `buildIndexEntries` index-**column** encoding change (hardcoded
  `'NOCASE'` → table K) had **no test** for a `config.collation = 'binary'` store with a
  secondary index. Added a white-box regression to `index-persistence.spec.ts`
  ("binary-config store: CREATE INDEX over existing rows and write-time maintenance agree on
  the index-column key collation"): it builds an index over existing case-distinct text values
  on a `collation = binary` store, then DELETEs to prove build (`buildIndexEntries`) and
  write-time maintenance (`updateSecondaryIndexes`) agree on the index-column bytes (drained
  index store = no orphans). Verified it **fails** against the pre-fix hardcoded-NOCASE
  encoding (1 orphaned entry) and passes after — a genuine regression guard for the
  latent-mismatch fix.

### Accepted as documented (no action)

- Index *column* value collation is still table-K, not per-index-column (PK **suffix** is
  per-column). Scope boundary, not a correctness issue (store secondary indexes aren't used
  for range/query; UNIQUE is a per-column full scan).
- Custom comparator-only collation (no registered byte encoder) keys/dedups under NOCASE
  bytes — pre-existing residual, store physically honors only BINARY/NOCASE/RTRIM.
- DESC-text-PK + non-K-collation only incidentally covered — low risk (the two transforms
  compose in `encodeCompositeKey`); a targeted fixture would tighten it but isn't required.
- `reconcilePkCollations` still normalizes an implicit text PK → K (store default ≠ engine
  BINARY default). Deliberate, byte-compat preserving; a "store default = BINARY" end-state is
  a larger separate decision.

### Follow-up disposition

- `store-pk-collate-logical-enforce` (engine-side write-time logical PK scan) is now
  **obsolete** — the store enforces PK uniqueness physically per-column. Recommend a human
  close/move it (left in place; not a review-pass action).
- `store-pk-collate-legacy-reopen-divergence` still stands (documented above).
