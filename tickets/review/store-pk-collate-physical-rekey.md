description: Review the store's per-PK-column key collation + ALTER-time physical re-key (Option B): the store now honors ANY divergent PK SET COLLATE / CREATE-time PK collation by physically re-encoding keys, instead of the cheap UNSUPPORTED reject.
files: packages/quereus-store/src/common/encoding.ts, packages/quereus-store/src/common/key-builder.ts, packages/quereus-store/src/common/store-table.ts, packages/quereus-store/src/common/store-module.ts, packages/quereus/src/schema/column.ts, packages/quereus-store/test/create-table-conformance.spec.ts, packages/quereus-store/test/alter-table-conformance.spec.ts, packages/quereus-store/test/index-persistence.spec.ts, packages/quereus-store/test/rehydrate-catalog.spec.ts, packages/quereus/test/logic/41.7.1-alter-column-collate-unique.sqllogic, packages/quereus/test/logic/41.7.2-alter-column-collate-unique-store.sqllogic, packages/quereus/test/logic.spec.ts, docs/schema.md, docs/sql.md, docs/module-authoring.md
----

## What changed (the implementation under review)

The store previously enforced PRIMARY KEY uniqueness/ordering *physically* under a **single
fixed table-level key collation K** (`config.collation`, default `NOCASE`) and rejected any
divergent per-column PK collation with `UNSUPPORTED` (the `store-pk-collate-module-capability`
stopgap). This ticket replaces that with a **per-PK-column key collation** and an ALTER-time
**physical re-key**, reaching full parity with the memory module.

Core data-flow change — the PK key bytes are now encoded per-column:

```
encodeCompositeKey(values, options, directions, collations?)   // NEW 4th arg
   collations[i] (if defined) overrides options.collation for component i
        │
        ├── buildDataKey(pk, opts, dirs, collations)           // data-store key
        └── buildIndexKey(idxVals, pk, opts, idxDirs, pkDirs, pkCollations)
                                                               // index key: PK SUFFIX is per-column
```

- **`resolvePkKeyCollations(pkDef, columns, fallback)`** (exported from `store-table.ts`) is the
  single source of truth: per PK member, a **text** column → its declared `collation`
  (upper-cased), a **non-text** member → `undefined` (collation is meaningless for
  integer/real/blob keys — the encoder ignores it). Shared by `StoreTable`
  (`pkKeyCollations`, recomputed on every `updateSchema`) and `StoreModule.buildIndexEntries`,
  so the data-key and index-PK-suffix encodings can never drift.
- **`StoreModule.reconcilePkCollations`** no longer throws on an explicit divergent PK
  collation — it honors it. It still applies the store default K to an *implicit*-default text
  PK column (so an undecorated `text primary key` keeps the store's historical NOCASE-keyed
  behavior, not the engine's BINARY column default).
- **`ALTER COLUMN … SET COLLATE` on a PK member** now physically re-keys:
  `StoreTable.rekeyRows(pkDef, updatedSchema.columns)` re-encodes every data key under the new
  collation, then `StoreModule.rebuildSecondaryIndexes(...)` clears + rebuilds every secondary
  index (their keys embed the PK suffix). `rekeyRows`' first pass throws `CONSTRAINT` on a
  collision under the new collation **without mutating the store** — all-or-nothing, mirroring
  `ALTER PRIMARY KEY`. A target equal to the column's current collation is a schema-only no-op.
- `rebuildSecondaryIndexes` was **extracted** from the existing `alterPrimaryKey` arm (which now
  calls it too) — DRY, identical clear-then-rebuild for both re-key triggers.
- `buildIndexEntries` gained a `keyCollation` param: index *column* values now use the table K
  (previously hardcoded `'NOCASE'`), and the PK suffix uses per-column collations. For the
  default config (K = NOCASE) this is **byte-identical** to before; for `config.collation =
  'binary'` it now matches `updateSecondaryIndexes` (a previously latent build-vs-maintenance
  mismatch — see Risks).
- Persistence: the per-column key collation round-trips through the column's `COLLATE` clause —
  `generateTableDDL` elides the default `BINARY` and emits non-`BINARY` explicitly, and the
  engine import path defaults a no-`COLLATE` column to `BINARY`, so the reloaded collation
  matches the bytes the keys were written under. The load path does **not** reconcile (the DDL
  is the source of truth).

The engine-side `module.ts` `setCollation` "re-key / re-validate the PK" mandate is now
satisfied natively (no engine change needed — the engine already routes SET COLLATE through
`module.alterTable` and registers the returned schema).

## Byte-compatibility argument (why existing data/tests are unaffected)

For any table NOT using an explicit divergent PK collation (i.e. every pre-existing store
table), the emitted key bytes are **identical** to before:
- implicit text PK → reconciled to K = NOCASE → `pkKeyCollations = ['NOCASE']` → same as the old
  whole-key NOCASE,
- non-text PK → `undefined` → falls back to K, but the encoder ignores collation for
  integer/real/blob → same bytes,
- index keys → index columns use K, PK suffix as above → same.

New byte behavior only appears for an explicit non-K PK collation (the new capability) or
`config.collation = 'binary'` (the latent-mismatch fix). This is why the full store-mode logic
suite passes unchanged.

## Use cases / behaviors to validate

1. **Default NOCASE PK honors SET COLLATE binary** — existing rows re-key under BINARY, a
   case-distinct pair (`'a'`/`'A'`) then coexists, PK ordering/uniqueness follow BINARY.
   (`create-table-conformance` "after a default text-PK create…"; `alter-table-conformance`
   "SET COLLATE on PK column (divergent…) → honored re-key".)
2. **Explicit divergent PK collation at CREATE is honored** — `collate binary` / `collate rtrim`
   text PK keyed under that collation; composite-PK member too. (`create-table-conformance`.)
3. **Re-key collision → CONSTRAINT, store unchanged** — `'a'`/`'A'` distinct under BINARY
   collapse under NOCASE → rejected all-or-nothing. (`alter-table-conformance` "…collides under
   the new collation → CONSTRAINT"; cross-module `41.7.1`.)
4. **Secondary indexes survive the re-key** — white-box test in `index-persistence.spec.ts`:
   after a BINARY→NOCASE PK re-key, the rebuilt index has the right entry count, and
   `delete from t` drains the index store to **0** (proves rebuild and write-time maintenance
   agree on the new PK-suffix encoding — a stale suffix would orphan entries).
5. **Round-trip through close → reopen** — `rehydrate-catalog.spec.ts` "per-column PK key
   collation round-trips…": both an explicit-`collate binary` CREATE and a SET COLLATE re-key
   reopen with BINARY in force (ordering, `table_info`, uniqueness, point lookup).
6. **`41.7.1` migrated out of `MEMORY_ONLY_FILES`** — now cross-module (explicit `collate binary`
   PK lets the store hold `'a'`/`'A'`). `41.7.2` §9 rewritten to a cross-module divergent-honor
   case (NOCASE→BINARY).

## Validation performed (all green)

- `yarn workspace @quereus/store build` and `yarn workspace @quereus/quereus build` — clean.
- Full store unit suite: `node --import ./packages/quereus-store/register.mjs <mocha> "packages/quereus-store/test/**/*.spec.ts"` → **396 passing**.
- Full store-mode logic suite: `QUEREUS_TEST_STORE=true <mocha> packages/quereus/test/logic.spec.ts` → **226 passing, 4 pending** (the 4 memory-only skips), 35s.
- `41.7` logic fixtures in **both** memory and store mode → 3/3 passing each.

## Known gaps / risks (reviewer: please probe these)

- **`rekeyRows` swap hazard (pre-existing, inherited).** `rekeyRows` emits one batch of
  `delete(oldKey)` + `put(newKey)` per row. A true 2-cycle "swap" (rowA.newKey == rowB.oldKey
  AND rowB.newKey == rowA.oldKey, with the two new keys distinct) could clobber depending on
  batch op ordering. This is **pre-existing** (it already backs `alterPrimaryKey`) and was reused
  unchanged. For a collation change it is effectively unreachable: a deterministic per-value
  re-encode that would form such a cycle hits the `pending`-map collision check first. Not
  introduced here, but worth a skeptical look if the reviewer wants to harden `rekeyRows`.
- **Index *column* value collation is still table-K, not per-index-column.** Only the PK
  **suffix** of an index key is per-column. A `create index … on t(x collate nocase)` where `x`
  is BINARY is not honored in the index key bytes. Not a correctness issue today (store
  secondary indexes aren't used for query/range — full-scan fallback — and UNIQUE is enforced by
  a per-column-collation full scan), but it is a scope boundary, not a complete per-column story.
- **`buildIndexEntries` index-column encoding changed from hardcoded `'NOCASE'` to table K.**
  Byte-identical for the default (K = NOCASE) config; for `config.collation = 'binary'` it now
  agrees with `updateSecondaryIndexes` (fixing a latent build-vs-maintenance mismatch). No test
  exercises a BINARY-config store *with secondary indexes*, so that specific combination is
  reasoned-correct but not directly covered.
- **Custom comparator-only collation residual (pre-existing).** A PK column whose declared
  collation has no registered byte *encoder* falls back to NOCASE bytes inside `encodeText`
  (`?? NOCASE_ENCODER`), so its physical key is NOCASE-encoded regardless of the declared
  comparator. Same residual already documented for the store UNIQUE dedup. The store only
  physically honors BINARY/NOCASE/RTRIM.
- **`pk-desc-iteration` + collation interaction not specifically tested.** DESC PK columns and
  per-column collations are independently covered; a DESC *text* PK with a non-K collation
  (both bit-inversion and per-column collation on the same component) is exercised only
  incidentally. Low risk (the two transforms compose in `encodeCompositeKey`), but a targeted
  fixture would tighten it.
- **`reconcilePkCollations` still normalizes implicit text PK → K.** This is deliberate (keeps
  the store's historical NOCASE default for undecorated text PKs and preserves byte-compat), but
  it means the store's *default* still diverges from the engine's BINARY column default. If the
  intended end-state is "store default = engine default = BINARY", that is a larger follow-up,
  not done here.

## Follow-ups now unblocked / obsolete

- `store-pk-collate-logical-enforce` (engine-side write-time logical PK scan) is **no longer
  needed** — the store enforces PK uniqueness physically under the per-column collation. The
  reviewer may want to move that backlog ticket to obsolete/closed.
- `store-pk-collate-legacy-reopen-divergence` still stands (a genuinely *legacy* persisted DDL
  written before per-column keying, whose declared collation may not match its key bytes) — the
  `rehydrate-catalog` "legacy divergent text-PK collation loads…" arm documents that case.
