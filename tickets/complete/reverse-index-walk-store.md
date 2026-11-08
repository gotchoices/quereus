description: The persistent store (LevelDB, IndexedDB and the other key-value backends) now answers a descending-order query by reading an ascending index or the primary key backwards instead of sorting the whole table.
prereq: reverse-index-walk-engine-and-memory
architecture: docs/module-authoring.md
files:
  - packages/quereus-store/src/common/store-module-access-plan.ts
  - packages/quereus-store/src/common/store-table-scan.ts
  - packages/quereus-store/test/index-ordering.spec.ts
  - packages/quereus-store/test/key-set-seek-store.spec.ts
  - packages/quereus-store/README.md
  - docs/optimizer-rules.md
  - packages/quereus/src/planner/rules/aggregate/rule-minmax-index-boundary.ts
----

# Backwards index walks: store backend

Store half of the backwards-walk feature; the engine contract and memory module landed in `reverse-index-walk-engine-and-memory` (reversed descriptor → `reverse=1` in `idxStr`, direction-aware NULL gate).

## What was built

**Planner (`store-module-access-plan.ts`).** `indexOrderingSatisfies` returns `'forward' | 'reverse' | undefined`, trying forward first; each attempt builds the walked ordering (`walkOrdering`: order-preserving prefix cut by the direction-aware `nullSafeOrderingPrefixLength`, directions flipped when reversed) and matches it with `orderingPrefixSatisfies` (equality-pinned skip, `nullsFirst` declines). It serves the secondary single-window arms (`eq`, `range`, `prefixRange`), the ordering-only index walk (`chooseOrderingPlan` / `buildOrderingWalkPlan`) and the primary key (`buildPkOrderingAdvertisement`, used by the PK range arm and the full scan). A reverse claim carries `reversedIndexDescriptor(...)`, minted only in `walkDirectionFields`; `monotonicOn.direction` follows the walk (`pkMonotonicAdvertisement`). The primary-key multi-seek passes `allowReverse = false`; the secondary multi-seek claims no order. No request ⇒ only the forward ordering is advertised. `explains` gets a ` (reverse walk)` suffix.

**Runtime (`store-table-scan.ts`).** `query()` decodes `reverse` once (`idxStrWalksReverse`) and threads it into the full scan (where an ordering-only `_primary_` walk lands), `scanPKRange`, and `scanIndex` → `produceIndexEntries` → `iterateEffective`. `scanMultiSeek` throws `INTERNAL` on a `reverse=1` idxStr.

## Review findings

Read the `ticket(implement): reverse-index-walk-store` diff first, then the surrounding code.

**Checked, correct as written:**
- Planner claim soundness: forward-first, all-or-nothing direction agreement, NULL gate run per direction, `nullsFirst` declines. The restructured `buildPkOrderingAdvertisement` keeps the old no-claim behaviour (forward `monotonicOn`, empty when the leading member fails the forward NULL gate) and correctly runs the reverse attempt before that early-out.
- Runtime merge: `mergeWithPending` (store-table-base.ts) reverses a filtered copy of the pending puts and folds direction into the comparison sign; shadowing and delete suppression are direction-independent. Every KV backend (memory, LevelDB, IndexedDB, React Native LevelDB, NativeScript SQLite) honours `reverse` over `[gte, lt)` bounds, and `paged-iterate.ts` tightens the upper bound on resume for reverse.
- Isolation layer: `IsolatedTable.resolveScanIndex` reads `path.index.reverse` and negates the merge comparator, for both `_primary_` and secondary descriptors. A store index key is `{index columns}{PK}`, so a backwards walk emits ties in reverse primary-key order, which is what the module-authoring contract requires.
- Runtime degrade paths: a PK range that degrades to a full scan still walks in the claimed direction, because `reverse` reaches the full-scan arm too. A point lookup and the multi-seek never carry a reversed claim.
- No scan arm relies on forward-only early termination; bounds go to the KV iterate and `matchesFilters` re-checks rows.
- `supportsAsofRight` on a reversed primary-key claim: the asof rule (`rule-lateral-top1-asof.ts`) only uses the probe as a capability gate with an ascending request, and the stream the store would deliver for that request is ascending. This matches the memory module's `buildMonotonicAdvertisement`. Accepted without a new test.
- Tests: the two added plan-level tests pin real branching (the reverse NULL gate on a nullable ASC column; `monotonicOn` flipping on a reversed PK claim) and are kept. Each changed pin still tests what its new name says; the `key-set-seek-store.spec.ts` change mirrors the memory twin in the prereq.
- Docs: README "ORDER BY from key order" paragraph, `docs/optimizer-rules.md` minmax caveat, the minmax rule header (its `buildIsNotNull` NOTE exists), and `docs/module-authoring.md` (updated by the prereq) all match the new behaviour. A sweep for stale "forward only" / "no reverse walk" wording in docs, sources and tests found none.

**Fixed inline (minor):**
- `computeFilterAccessPlan`'s "seek priced above the scan" return overwrote `explains` with a fixed string, dropping the ` (reverse walk)` suffix. It now appends to `scanPlan.explains`; the forward string is unchanged, so `pushdown.spec.ts`'s match still holds.

**Tripwire recorded:**
- `StoreTableScan.analyzeIndexAccess` returning null makes `query()` scan the data store in primary-key order, which is the wrong order under an index ordering claim (forward or backward; pre-existing, not introduced here). The only known route under a claim is an unfaithful semantic probe on the leading equality column, which the planner cannot see. Parked as a `NOTE:` at that `return null`.

**Not filed / no action:**
- No test for the `scanMultiSeek` reverse assertion: unreachable from SQL and from the planner; same treatment as the prereq's seq-scan assertion.
- File size: `store-module-access-plan.ts` is 1,749 lines (`wc -l`, measured by the implementer), already tracked by backlog `debt-oversized-source-files`, which the implement pass updated.
- IndexedDB backwards reads cost one request per row; this is recorded as a `NOTE:` in `walkDirectionFields` and in the IndexedDB store. Unmeasured, so no ticket.
- The nullable-column `min`/`max` gap on costly-read backends stays with backlog `feat-store-claim-is-not-null-seek-bound`.

## Validation

- `yarn workspace @quereus/store typecheck` and `yarn workspace @quereus/store test` (1991 passing) after the review edits.
- The implement pass ran `yarn test`, `yarn test:store` (11109 passing, 33 pending, including the prereq's `10.5.3-desc-index-ordering.sqllogic` against the store), `yarn workspace @quereus/quereus lint` and `yarn docs:check`. The review edits touch one explanation string and one comment in the store package, so those were not re-run.
