description: StoreTable.scanPKRange seek + early-termination — buildPKRangeBounds derives an encoded-byte gte/lt window from leading-PK LT/LE/GT/GE constraints (DESC swap, custom-collation fallback); matchesFilters stays authoritative. Reviewed, hardened, complete.
files:
  - packages/quereus-store/src/common/store-table.ts        # buildPKRangeBounds + scanPKRange (range seek)
  - packages/quereus-store/src/common/store-module.ts        # getBestAccessPlan doc + range-scan comment
  - packages/quereus-store/test/pushdown.spec.ts             # range-seek tests (+ DESC NOCASE combo added in review)
  - docs/optimizer.md                                        # ruleSelectAccessPath store wording (fixed in review)
difficulty: medium
----

# Store PK range-scan seek + early-termination

`StoreTable.scanPKRange` derives ONE `gte`/`lt` iterate window from the
leading-PK-column range constraints (`buildPKRangeBounds`) instead of
full-scanning + post-filtering, then iterates that narrowed window via
`iterateEffective`. `matchesFilters` remains the authoritative collation-aware
row filter; the window is a guaranteed **superset** (over-fetch is fine,
under-fetch is the bug class).

`buildPKRangeBounds` encodes each bound value under the same per-column DESC
direction + key collation the data keys use (`encodePkPrefixBounds`), maps the
op to a lower/upper endpoint (the assignment swaps under DESC because
bit-inversion makes a larger value ⇒ smaller bytes), combines with MAX-lower /
MIN-upper, skips NULL/undefined bounds and overflowed (`incrementLastByte →
undefined`) upper increments, and falls back to a full scan when the leading
text PK column carries a comparator-only collation with no registered byte
encoder.

## Review findings

### Scope reviewed
Implement-stage diff `55e7d779` read first (store-table.ts `buildPKRangeBounds` +
`scanPKRange`, store-module.ts comments, pushdown.spec.ts), then traced every
supporting primitive: `encodePkPrefixBounds` → `buildPkPrefixBounds` →
`encodeCompositeKey`, `incrementLastByte`, `buildFullScanBounds`,
`keyWithinBounds`, `iterateEffective`, `matchesFilters` / `compareValues`,
`resolvePkKeyCollations`, `analyzePKAccess`, and the collation-encoder registry.

### Correctness (no bugs found)
- **ASC/DESC bound-swap table verified** against the encoding semantics for all
  four ops, both directions — derived each endpoint independently and confirmed
  it matches the implemented ternaries.
- **Combine logic** (`max` lower via empty-array start, `min` upper via
  `undefined` start) is sound; BETWEEN (one lower + one upper) and redundant
  same-side pairs both resolve correctly.
- **Superset-safety of the skip paths**: an overflowed `hi` and a NULL/undefined
  bound each leave that side unbounded (over-fetch), never under-fetch.
- **Seek-window collation vs filter collation — the highest-risk question.**
  `matchesFilters` compares under `columns[i].collation`; the key/window is
  encoded under `pkKeyCollations[0] = col.collation || fallback`. Investigated
  whether the fallback (table default, NOCASE) could diverge from the filter
  collation (BINARY) and cause **under-fetch**. It cannot: `ColumnSchema.collation`
  always defaults to a truthy `'BINARY'`, so `|| fallback` never fires for a real
  column — key collation always equals the filter collation. No regression vs.
  the old full-scan path.
- **read-your-own-writes** holds on the narrowed window: `iterateEffective`
  filters pending puts by the SAME `bounds` via `keyWithinBounds` (gte inclusive,
  lt exclusive — consistent with `store.iterate`).

### Docs (1 stale, FIXED inline — minor)
- `docs/optimizer.md` `ruleSelectAccessPath` still asserted the store "PK range
  scan visits the full key space so there is no early-termination to thread it
  into" — now false. Rewrote the parenthetical to describe `buildPKRangeBounds`
  seeking to the encoded `gte`/`lt` window + early-terminating, with the
  comparator-only-collation full-scan fallback. The two store-table.ts /
  store-module.ts comments the implementer already updated are accurate; the
  store README only references a `rangeScans` capability flag (no behavior text).

### Tests (1 gap, FILLED — minor)
- Implementer coverage is genuinely thorough: NOCASE range/BETWEEN/mismatch,
  RTRIM `>`/`>=`/point, BINARY control, blob point, DESC integer `>`/BETWEEN,
  window-narrowing (ASC + DESC, via a `CountingKVStore` that proves a real seek,
  not full-scan+filter), empty/contradictory window, reads-own-writes, and the
  white-box comparator-only fallback with a positive control.
- **Gap filled:** no test combined **DESC + a non-BINARY collation on the same
  leading PK column** — the one place the lower/upper SWAP and the collation
  encoder both apply to the same bound. Added `DESC NOCASE primary key` (range +
  BETWEEN) to `pushdown.spec.ts`; both assert the IndexSeek path is chosen and
  return collation-correct rows. Suite: **556 passing** (was 554).

### Findings NOT actioned (with reasons — no new tickets warranted)
- **Comparator-only-collation fallback is unreachable via DDL** (the engine
  restricts TEXT collations to BINARY/NOCASE/RTRIM, all of which have encoders).
  The branch is defensive against `encodeText`'s silent `?? NOCASE_ENCODER`
  fallback and any future custom-collation-column feature; the white-box test
  (cast-assigning `pkKeyCollations`) is an acceptable way to pin a defensive
  branch. Kept as-is — cheap insurance, clearly documented.
- **Contradictory window (`gte > lt`) no-throw on LevelDB** is asserted only
  against `InMemoryKVStore` here; LevelDB coverage is indirect via `yarn
  test:store` (full logic suite re-run on LevelDB, green). A dedicated LevelDB
  `gte > lt` iterate unit test would be belt-and-suspenders but the risk is low
  (yielding nothing for an empty byte range is standard provider behavior). Not
  filed.
- **Multi-column PK prefix seeks** (`pk0 = a and pk1 > b`) remain a scan —
  matches `analyzePKAccess`, which only forms a `range` access for the leading PK
  column, and the legacy planner doesn't forward those bounds anyway. Out of
  scope by design.
- **Window-narrowing `<= 5` slack** (expected 4) is a heuristic, not an exact
  count; robust for the contiguous-integer fixture. Acceptable.

### Validation
- `yarn workspace @quereus/store run typecheck` — clean (EXIT 0).
- `yarn workspace @quereus/store test` — **556 passing** (EXIT 0); the
  rollback/rehydrate/"boom" log noise is intentional negative-test output.
- No lint for `@quereus/store` (only `packages/quereus` has one); docs are not
  linted. Production store code was unchanged in this review pass (doc + test-only
  additions), so the implementer's `yarn test` / `yarn test:store` green runs for
  the store code path stand.
