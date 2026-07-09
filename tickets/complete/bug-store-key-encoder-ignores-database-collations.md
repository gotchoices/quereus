---
description: The persistent store used to lay out its keys with a built-in text-sorting rule even when the application had taught the database its own rule, so two values the application considers identical could be stored as two separate primary-key rows; the store now uses the application's rule and refuses, at table-creation time, any rule it cannot use for keys.
files:
  - packages/quereus/src/core/database-internal.ts        # + _getCollationNormalizer on the facade
  - packages/quereus/src/index.ts                         # resolveKeyNormalizer export → BUILTIN_NORMALIZERS
  - packages/quereus/src/util/key-serializer.ts           # resolveKeyNormalizer deleted
  - packages/quereus/src/planner/analysis/comparison-collation.ts  # logicalTypeCanHoldText is now the single predicate
  - packages/quereus-store/src/common/encoding.ts         # encoder registry deleted; EncodeOptions.normalizers
  - packages/quereus-store/src/common/store-table.ts      # validateKeyCollations(); columnCanHoldText delegates
  - packages/quereus-store/src/common/store-module.ts     # resolver threaded into index rebuild / UNIQUE re-validation
  - packages/quereus-store/test/custom-collation-key.spec.ts  # 13 cases
  - packages/quereus-store/test/encoding.spec.ts, test/pushdown.spec.ts
  - docs/sql.md, docs/schema.md, docs/store.md, docs/plugins.md, docs/optimizer.md
difficulty: medium
---

# Store key encoding resolves collations against the database

## What was wrong

`quereus-store`'s `encoding.ts` held a **process-global** map from collation name to a
byte encoder, seeded with only `BINARY`, `NOCASE`, and `RTRIM`, and it silently fell back
to the `NOCASE` encoder on an unknown name. The database's own per-connection registry
(`Database.registerCollation`) was never consulted, while every value comparison
`StoreTable` makes already went through `db.getCollationResolver()`. Key layout and
comparator could therefore disagree about which rows are the same row: an application
that re-registered `NOCASE` so that `'a b'` equals `'ab'` could insert both and end up
with a duplicate primary key.

## What shipped

- **The encoder registry is gone.** `EncodeOptions` grows `normalizers?: KeyNormalizerResolver`;
  `encodeText` / `encodeObject` resolve through it with no fallback. The default,
  `BUILTIN_KEY_NORMALIZER_RESOLVER`, is built over the engine's exported
  `BUILTIN_NORMALIZERS` and throws on any other name. `CollationEncoder`,
  `registerCollationEncoder`, and `getCollationEncoder` were deleted (public API break,
  waived by AGENTS.md).
- **`StoreTable` binds `db.getKeyNormalizerResolver()` once** into `encodeOptions`, so
  every `buildDataKey` / `buildIndexKey` / prefix-bounds call inherits it.
  `StoreModule.buildIndexEntries`, `rebuildSecondaryIndexes`, and
  `validateUniqueOverExistingRows` each take the resolver from a caller holding `db`.
- **DDL-time validation** (`StoreTable.validateKeyCollations`) rejects a collation the
  table's key encoding needs but cannot use — unregistered (`no such collation sequence`)
  or comparator-only (`cannot key a persisted structure`). It fires on catalog
  rehydration too, so reopening from a connection that never re-registered its collation
  raises instead of reading rows under a key layout it cannot reproduce.
- **`resolveKeyNormalizer` deleted** from the engine; its two remaining callers resolve
  through `db.getKeyNormalizerResolver()`.
- **`RTRIM` key bytes changed for non-space whitespace, on purpose.** The retired store
  encoder stripped `/\s+$/`; the engine's `RTRIM_NORMALIZER` — matching `RTRIM_COLLATION`,
  the comparator the store's own UNIQUE enforcement uses — strips only ASCII `0x20`.
  `'a\t'` and `'a'` used to share a key while comparing distinct, so a row could be
  clobbered by its neighbour. Any persisted RTRIM-keyed row whose key ends in non-space
  whitespace changes key bytes. `BINARY` and `NOCASE` are byte-identical.

## Review findings

### Checked

The implement diff read cold before the handoff summary; every `EncodeOptions` construction
site in `quereus-store/src` (all now carry `normalizers`); every `buildDataKey` /
`buildIndexKey` / `buildIndexPrefixBounds` / `buildPkPrefixBounds` caller; the four deleted
`getCollationEncoder` guards and whether each is genuinely unreachable now; `encodeCompositeKey`'s
per-column collation override (spreads `options`, so the resolver survives); repo-wide grep for
dangling references to the deleted API (none); the `columnCanHoldText` / `logicalTypeCanHoldText`
split; the `K`-vs-`C` coarseness reasoning in both seek guards; every doc file the diff touched
plus `docs/store.md`'s surrounding prose. `yarn build`, `yarn lint`, `yarn test` (all workspaces,
0 failing), and `yarn test:store` (6692 passing, 14 pending) all green; no pre-existing failures
surfaced.

### Major — filed as a ticket

- **`backlog/bug-store-range-seek-assumes-order-preserving-key-normalizer`.** The implement
  handoff parked "a range window is sound only when the key normalizer is order-preserving"
  as a *tripwire*, on the reasoning that only a built-in collation name can reach a PK
  column. That reasoning is wrong: a built-in **name** can be re-registered with an arbitrary
  comparator + normalizer pair (that is exactly the mechanism this whole ticket's bug used),
  and `registerCollation` guarantees only that the normalizer partitions strings the way the
  comparator calls them *equal*, never that it preserves *order*. A legal registration whose
  comparator orders shorter strings first makes `where k > 'b'` seek past `'aa'` and silently
  drop the row. Reachable today, so it is a defect, not a tripwire. Pre-existing (the old
  built-in-encoder + custom-comparator pairing had the same hazard, and worse), which is why
  it is filed rather than fixed here. The `NOTE:` comments at `buildPKRangeBounds` and
  `tryIndexAccessPlan`, and the `docs/store.md` paragraph, all asserted "not reachable today";
  each was corrected in place to point at the ticket.

### Minor — fixed in this pass

- **`validateKeyCollations` falsely rejected any table with a secondary index over
  type-natively keyed columns.** It required the table key collation `K` whenever
  `schema.indexes` was non-empty, but a secondary index only encodes `K` for a *text-capable*
  index column. With a comparator-only `NOCASE` registered, `create index ix_n on t (n)` over
  `t(id integer primary key, n integer)` threw `cannot key a persisted structure` — and threw
  *after* `buildIndexEntries` had already written the entries. Confirmed with a failing test
  before the fix; `usesTableKeyCollation` now tests `columnCanHoldText` on each index column.
  Two tests added (all-integer index accepted; text-column index still rejected).
- **`updateSchema` mutated `tableSchema` / `pkDirections` / `pkKeyCollations` before
  validating**, so a rejected `CREATE INDEX` or `ALTER` left the live `StoreTable` carrying a
  schema the DDL never committed. `validateKeyCollations` now takes the candidate
  `pkKeyCollations` as a parameter and runs before any field is assigned.
- **DRY: `columnCanHoldText` was a verbatim reimplementation** of the engine's exported
  `logicalTypeCanHoldText`, down to its own copy of the `NEVER_TEXT_PHYSICAL_TYPES` set — and
  the same diff imported the engine's version into `store-module.ts`. `columnCanHoldText` now
  delegates; the engine-side "mirrors `columnCanHoldText`" comment was dropped.
- **Two stale doc comments in `store-module.ts`** (`getBestAccessPlan`, `tryIndexAccessPlan`)
  still described a "comparator-only collation with no byte encoder falls back to a full scan"
  path that this change deleted.
- **`docs/store.md`** § Collation Support: the DDL-validation paragraph did not mention
  `CREATE INDEX` and overstated when `K` is required; corrected alongside the index-column fix.

### Test gaps from the handoff — all closed

The implementer flagged three untested areas. Each now has a case in
`custom-collation-key.spec.ts` (13 cases total, up from 8):

- **`validateUniqueOverExistingRows` under a custom collation** — `alter table … add
  constraint unique` over two rows that collide only under the override is rejected, and
  accepted once they are made distinct.
- **`rebuildSecondaryIndexes` under a custom collation** — `alter column … set collate` on a
  PK member rekeys the data store and rebuilds the index; the test then reads through the
  index *and* deletes through it, which is what a mis-threaded resolver would leave orphaned
  (a read alone would not catch it, since index entries resolve through their stored data key,
  not their PK suffix).
- **Rehydration across a reopen** — three connections over one provider: the one that
  re-registers the override finds the row, and the one whose `NOCASE` is comparator-only is
  refused the table rather than reading it under a layout it cannot reproduce.
- Also added: the previously-untested `ANY`-typed-PK branch of `validateKeyCollations` (a PK
  member `resolvePkKeyCollations` leaves `undefined` yet which can hold text, so its bytes fall
  back to `K`).

### Tripwires — where they live

- `encodeObject` in `encoding.ts` keeps its `NOTE:` — the normalizer runs over the canonical
  JSON string, so a character-deleting normalizer could leave a string `decodeObject` cannot
  parse. Genuinely conditional: nothing in the row path decodes an object key today. Left as
  the implementer parked it.
- `buildPKRangeBounds`' `NOTE:` was **not** a tripwire (see Major above); it was rewritten to
  describe a reachable defect and to name the ticket that tracks it. A matching `NOTE:` was
  added at `StoreModule.tryIndexAccessPlan`, whose range arm carries the same assumption and
  had no marker at all.

### Accepted as-is

- `StoreTable.validateKeyCollations` re-runs on every `updateSchema`. A Set over at most a few
  names plus one Map lookup each, at DDL frequency. Not worth caching.
- `BUILTIN_KEY_NORMALIZER_RESOLVER` reports an unregistered name as `no such collation
  sequence`, which is technically ambiguous for a caller with no `Database` (the name might be
  registered on some connection). Every in-tree store call site now threads a resolver, so the
  built-ins-only path is reachable only from direct `encodeValue` calls in tests.
- A `JSON`- or `ANY`-typed PK column encodes under `K` rather than its own declared collation
  (`resolvePkKeyCollations` gates on `isTextual`). Pre-existing and already tracked by
  `backlog/bug-json-columns-classified-as-non-textual`.
