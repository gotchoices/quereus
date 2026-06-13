description: Refine StoreTable.scanPKRange to seek+early-terminate on the leading PK column using encoded-byte bounds derived from buildPkPrefixBounds, instead of full-scan + matchesFilters post-filter.
files:
  - packages/quereus-store/src/common/store-table.ts        # scanPKRange (TODO), analyzePKAccess, PKAccessPattern, new buildPKRangeBounds
  - packages/quereus-store/src/common/key-builder.ts         # buildPkPrefixBounds, buildFullScanBounds, incrementLastByte
  - packages/quereus-store/src/common/encoding.ts            # getCollationEncoder (custom-collation detection)
  - packages/quereus-store/test/pushdown.spec.ts             # existing collated-PK-range-seek correctness tests; add DESC + fallback + window-narrowing cases
difficulty: medium
----

# Refine store PK range-scan bounds (seek + early-terminate)

`StoreTable.scanPKRange` currently ignores the `PKAccessPattern` (the arg is
`_access`), iterates `buildFullScanBounds()`, and leans entirely on
`matchesFilters` for correctness. The backing-host substrate work landed
`buildPkPrefixBounds` (`key-builder.ts:304`) — encoding a leading-PK-value
subset under the SAME per-column DESC `directions` (`pkDirections`) and key
`collations` (`pkKeyCollations`) the data keys use. This ticket converts the
leading-PK-column LT/LE/GT/GE constraints into encoded-byte `gte`/`lt` iterate
bounds so the scan seeks to the window start and early-terminates, while
`matchesFilters` remains the authoritative collation-aware row filter (a
superset window is fine — the store advertises `honorsCollatedRangeBounds`).

## Architecture

`analyzePKAccess` already returns `{ type: 'range', columnIndex: firstPkCol,
constraints: [{ columnIndex, op, value }] }` where every constraint targets the
leading PK column with an op in `{LT, LE, GT, GE}` (the legacy planner only
forwards range bounds for `primaryKeyDefinition[0]`; see `pushdown.spec.ts`
header). The new helper turns those constraints into one `IterateOptions`
window.

### Prefix-region anchors

For a leading-column value `x`, `buildPkPrefixBounds([x], encodeOptions,
[dir0], [coll0])` returns `{ gte: lo, lt: hi }` where `lo = encode([x])` (start
of the byte region whose leading column == x) and `hi = incrementLastByte(lo)`
(just past it; `undefined` when `lo` is all-`0xff`). Prefix-preservation holds
through per-column DESC bit-inversion and per-column collation encoders, so
`[lo, hi)` is exactly the keys whose leading column == x — for both ASC and DESC.

### Op → byte-bound mapping

Because DESC bit-inverts the bytes (larger value ⇒ smaller bytes), the
lower/upper assignment swaps with direction:

| op | ASC (dir=false)      | DESC (dir=true)       |
|----|----------------------|-----------------------|
| GE | lower `gte = lo`     | upper `lt  = hi`      |
| GT | lower `gte = hi`     | upper `lt  = lo`      |
| LE | upper `lt  = hi`     | lower `gte = lo`      |
| LT | upper `lt  = lo`     | lower `gte = hi`      |

Combine across constraints (BETWEEN ⇒ one GE/GT + one LE/LT): take the **max**
of lower-bound candidates for `gte` and the **min** of upper-bound candidates
for `lt` (via the already-imported `compareBytes`). A candidate that resolves to
`undefined` (an `hi` that overflowed all-`0xff`) is simply skipped — that side
stays unbounded, which is a safe superset.

### Custom comparator-only collation → fall back to full scan

`resolvePkKeyCollations` maps the leading text PK column to its declared
collation name (`pkKeyCollations[0]`). When that name has **no registered byte
encoder** (`getCollationEncoder(name) === undefined`), `encodeText` silently
falls back to NOCASE bytes — which do NOT track the column's logical order, so a
derived window could *under-fetch*. Detect this (`coll !== undefined &&
getCollationEncoder(coll) === undefined`) and return `buildFullScanBounds()`;
`matchesFilters` (collation-aware via `compareSqlValues`) stays authoritative.
A non-text leading column has `pkKeyCollations[0] === undefined` and encodes
type-natively — always safe to seek. BINARY/NOCASE/RTRIM are all registered.

### NULL / missing constraint value

`compareValues` already rejects every row for a range op against NULL, and the
planner never pushes `= NULL`. For bound-building, skip any constraint whose
`value` is `null`/`undefined` (leave that side unbounded — superset-safe);
correctness is preserved by `matchesFilters`.

### Proposed shape (illustrative, not prescriptive)

```ts
protected buildPKRangeBounds(access: PKAccessPattern): IterateOptions {
  const full = buildFullScanBounds();
  const constraints = access.constraints;
  if (!constraints || constraints.length === 0) return full;

  const dir = this.pkDirections[0];
  const coll = this.pkKeyCollations[0];
  if (coll !== undefined && getCollationEncoder(coll) === undefined) return full;

  let gte: Uint8Array = full.gte;
  let lt: Uint8Array | undefined;

  for (const c of constraints) {
    if (c.value === undefined || c.value === null) continue;
    const { gte: lo, lt: hi } = buildPkPrefixBounds(
      [c.value], this.encodeOptions, [dir], [coll],
    );
    const lower = !dir
      ? (c.op === IndexConstraintOp.GE ? lo : c.op === IndexConstraintOp.GT ? hi : undefined)
      : (c.op === IndexConstraintOp.LE ? lo : c.op === IndexConstraintOp.LT ? hi : undefined);
    const upper = !dir
      ? (c.op === IndexConstraintOp.LE ? hi : c.op === IndexConstraintOp.LT ? lo : undefined)
      : (c.op === IndexConstraintOp.GE ? hi : c.op === IndexConstraintOp.GT ? lo : undefined);
    if (lower && compareBytes(lower, gte) > 0) gte = lower;
    if (upper && (lt === undefined || compareBytes(upper, lt) < 0)) lt = upper;
  }
  return lt === undefined ? { gte } : { gte, lt };
}
```

Then `scanPKRange` drops the `_` from `_access`, computes
`const bounds = this.buildPKRangeBounds(access);`, and feeds it to
`this.iterateEffective(store, bounds)` — the rest (deserialize + `matchesFilters`
+ yield) is unchanged. `iterateEffective` already restricts the pending-merge to
`bounds` via `keyWithinBounds`, so reads-own-writes stays correct on the
narrowed window. Cost-model / explain output is unchanged (still the
range/IndexSeek path the store already advertises).

## Edge cases & interactions

- **DESC leading PK** — lower/upper assignment swaps (table above). Verify a
  `> x` on a DESC PK seeks the correct (smaller-bytes) window. The DESC-NULL
  leading-column `0xff` trap is handled by `buildPkPrefixBounds` returning
  `hi === undefined`, which we skip.
- **NOCASE / RTRIM key collations** — the bound value is encoded under the same
  registered encoder as the data keys, so the window is collation-correct;
  `matchesFilters` still re-checks. (Existing `pushdown.spec.ts` cases
  `name > 'banana'`, `between 'banana' and 'cherry'`, `val > 'cat'`,
  `val >= 'cat  '` must still pass — they pin under-/over-fetch behavior.)
- **Custom comparator-only collation** — `getCollationEncoder` returns
  `undefined` ⇒ full-scan fallback (no byte encoder tracks the logical order).
- **Contradictory bounds** (`x > 10 and x < 5`) ⇒ `gte > lt` ⇒ empty iterate;
  `matchesFilters` would also yield nothing. Confirm the KVStore `iterate`
  tolerates `gte > lt` (empty result, no throw) — both `InMemoryKVStore` and the
  LevelDB provider.
- **BETWEEN / two-sided** — both a lower and an upper constraint present; the
  max-gte / min-lt combine must keep both. **Redundant same-side** (`x > 1 and
  x > 5`) — max-gte keeps the tighter `5`.
- **All-`0xff` overflow** — `incrementLastByte` returns `undefined`; the affected
  side stays unbounded (superset). Don't set `lt` to `undefined` over a
  previously-set finite `lt`.
- **collation-mismatched bound** (`name > 'banana' collate BINARY` on a NOCASE
  PK) — the planner declines to SeqScan + residual (no IndexSeek), so
  `scanPKRange` is not even entered; the existing test pins this. No change here.
- **Pending-merge within bounds** — an in-transaction put/delete inside the
  window must still surface (reads-own-writes); `iterateEffective` already
  filters pending ops by the same `bounds`. Add/keep a test that ranges over
  uncommitted rows.
- **Non-leading-column range** (`age > 25` with PK `id`) — `analyzePKAccess`
  returns `type: 'scan'`, never reaching `scanPKRange`; unchanged.
- **No-explicit-PK tables** (every column becomes a PK column) — leading PK is
  `column 0`; range on it still seeks. Range on a non-leading column stays a
  scan (pinned by the `pushdown.spec.ts` header regression).

## TODO

- Add `getCollationEncoder` to the `./encoding.js` import in `store-table.ts`
  (alongside the existing `type EncodeOptions`).
- Implement `buildPKRangeBounds(access: PKAccessPattern): IterateOptions` per the
  shape above (single-purpose helper; decomposed from `scanPKRange`).
- Rewrite `scanPKRange` to use `access` (un-`_` the param), call
  `buildPKRangeBounds`, and iterate the narrowed bounds; delete the in-code TODO
  comment block.
- Update the `scanPKRange` doc comment and the `getBestAccessPlan`
  `honorsCollatedRangeBounds` comment in `store-module.ts:1582` (it currently
  states "There is no seek-start/early-termination … visits the full key space
  and post-filters") to reflect the new seek + early-termination; keep the
  superset / `matchesFilters`-authoritative framing.
- Tests (`packages/quereus-store/test/pushdown.spec.ts`, mirrors the
  `store-range-seek-collation-bounds` block):
  - DESC leading PK: e.g. `create table t (id integer primary key desc, n …)`;
    assert `id > k` / `id between a and b` return correct rows (IndexSeek path).
  - Custom comparator-only collation on a text PK: register a collation with a
    comparator but no byte encoder, confirm a range still returns correct rows
    (proves the full-scan fallback, not a wrong narrowed window). If wiring a
    custom collation through `db.exec` DDL is awkward, assert at the
    `StoreTable.buildPKRangeBounds` unit level that it returns full-scan bounds.
  - Window-narrowing proof: wrap an `InMemoryKVStore` so `iterate` counts
    visited entries (or spy on the `gte`/`lt` passed), and assert a selective
    range visits fewer than the full row count — distinguishing real seek from
    full-scan + filter (the existing correctness tests pass under both).
  - Empty/contradictory window (`x > 10 and x < 5`) returns `[]` without error.
- Run `yarn workspace @quereus/quereus-store test 2>&1 | tee /tmp/store-unit.log;
  tail -n 40 /tmp/store-unit.log` (pushdown + backing-host + isolated-store).
- Run `yarn test 2>&1 | tee /tmp/test.log; tail -n 60 /tmp/test.log` (memory
  path regression).
- Run `yarn test:store 2>&1 | tee /tmp/test-store.log; tail -n 80
  /tmp/test-store.log` — the logic suite re-run against the LevelDB store is the
  memory-vs-store correctness pin for range scans. If it routinely exceeds ~10
  min wall-clock, stream it and, if it can't finish in-window, document the
  deferral to CI rather than dropping the run silently.
