description: Fixed a persistent-store bug where a numeric primary/index key sorted every whole number before every fractional one, so range queries silently skipped rows; verified end-to-end and reviewed.
files:
  - packages/quereus-store/src/common/encoding.ts          # unified TYPE_NUMERIC encode/decode (encodeNumeric ~224, decodeNumeric ~403)
  - packages/quereus-store/test/encoding.spec.ts            # unit sort-order/roundtrip/tie-break/-0 tests (~81-121)
  - packages/quereus-store/test/pushdown.spec.ts            # store-vs-memory range parity tests (ASC/BETWEEN/DESC ~398-435) + gap-1 NOTE
  - packages/quereus-plugin-indexeddb/test/store.spec.ts    # key-layout assertions updated 9→17 bytes
  - packages/quereus/src/util/comparison.ts                 # the oracle: compareNumbers, getStorageClass
----

# Complete: store numeric key encoding unified to order all numbers by value

## What shipped

The persistent store encoded each primary/index key value into bytes that a
key-value store compares left-to-right (memcmp). The old encoder picked the
numeric format by JavaScript *shape*: a whole number (`bigint`) got type-tag
`0x01`, a fractional number (`number`) got `0x02`. Because the tag sorts first,
**every** whole number sorted before **every** fractional one — so `3` sorted
below `2.5`. A range query like `where x >= 2.5` built a byte window starting at
`2.5`'s bytes; the row `3` lived below that window and was never visited, so the
query silently returned fewer rows than it should.

The fix uses a single tag `TYPE_NUMERIC = 0x01` for both `bigint` and `number`,
with a fixed 17-byte body: `[tag][8-byte order-preserving double][8-byte signed
tie-break residual]`. The primary 8 bytes order every value by magnitude across
the int/real boundary (IEEE-754 big-endian, sign-bit flipped for non-negatives /
all bits flipped for negatives, of `Number(value)`). The tie-break 8 bytes are
the exact signed residual `value - nearestDouble`, so large integers past 2^53
that round to the same double stay distinct and correctly ordered with full
int64 precision. `-0` normalizes to `+0`. Decode returns `bigint` for
integer-valued results, `number` otherwise. `TYPE_INTEGER`/`TYPE_REAL` and their
helpers were removed (no external importers; on-disk backcompat out of scope).

## Review findings

### Verified correct (checked, no defect)

- **Encoding math.** Re-derived the sortable-double transform, sign handling
  (incl. `+0`/`+Inf`/`NaN` non-negative branch, all-bits-flip for negatives),
  the tie-break residual ordering within a shared-double tie-set, and the
  cross-tie-set boundary (residual bounded by half-ulp < one ulp gap ⇒ no
  overlap). All sound. Decode reverses each step; `slice` copies so the source
  buffer is not mutated.
- **DESC + tie-break.** `encodeCompositeKey` bit-inverts the whole fixed-width
  17-byte component; fixed width ⇒ inversion reverses total memcmp order
  regardless of internal structure, including negative-primary tie-sets. Correct.
- **Key-decode consumers.** `decodeCompositeKey`/`decodeValue` have **no callers
  in `quereus-store/src`** (only definition + export). Row values are served via
  `serializeRow`/`deserializeRow`, never key decode — so "integer-valued reals
  decode to `bigint`" (handoff gap 3) has no live internal consumer, and every
  comparator is numeric-class-tolerant (`5n` == `5.0`) if an external one exists.
  Non-issue.
- **Tests.** Unit (mixed int/real byte order, 2^53 tie-break distinct+ordered
  +exact roundtrip, `-0`/`+0`/`0n` collision) and store-vs-memory-oracle range
  parity (ASC `x>=2.5`, `BETWEEN 2.5 and 3`, DESC `x>=2.5`) all pass.

### Lint + tests (must-pass gate)

- `yarn workspace @quereus/store test` — **690 passing, exit 0** (the logged
  `[StoreModule]`/`boom` lines are intentional error-path assertions).
- `yarn workspace @quereus/quereus run lint` — **exit 0** (eslint + `tsc`
  typecheck of spec call sites).

### Major — filed elsewhere (already tracked, not re-filed)

- **End-to-end SQL range over |int| ≥ 2^53 is blocked upstream, not by this fix.**
  Attempting the handoff's "gap 1" combined test (`insert into t(x integer
  primary key) values (9007199254740993…)` then range-seek vs oracle) crashes in
  `TransactionManager.serializeKeyTuple` → `canonicalJsonString` → `JSON.stringify`
  with *"Do not know how to serialize a BigInt"*. Integer literals above
  `Number.MAX_SAFE_INTEGER` (2^53−1) surface as JS `bigint`, and the transaction
  change log cannot serialize a bigint PK. This is the store's own encoding
  working correctly but a **different layer** failing — already tracked in
  `fix/txn-changelog-bigint-key` (which prescribes exactly this repro test).
  **Not re-filed.** The combined e2e test belongs in that fix's suite once bigint
  PKs can be written at all. I replaced the failing test I'd drafted with an
  explanatory `NOTE` comment in `pushdown.spec.ts` pointing to that ticket, so
  the next reader knows why the e2e case is absent here.

### Additive coverage gaps (not defects — no action needed)

- **Targeted numeric fuzz** (handoff gap 2): not added. The existing unit +
  parity tests cover the moving parts; fuzz is belt-and-suspenders. Optional,
  and would also be blocked by `txn-changelog-bigint-key` for the SQL path.
- **DESC test at 2^53 magnitude** (handoff gap 4): the DESC-inversion argument is
  magnitude-independent (fixed-width full-inversion), covered at small magnitude;
  the 2^53 DESC SQL case is again gated on `txn-changelog-bigint-key`.

### Tripwires (parked, not tickets)

- **Numeric key width doubled (9 → 17 bytes).** The 8-byte tie-break tail is
  wider than needed — an int64 residual is bounded by ~2^11, so a 4-byte tail
  would suffice. Parked as a `NOTE:` at `NUMERIC_KEY_LENGTH` in `encoding.ts`:
  shrink to 4 bytes (kept fixed-width) *if* numeric-PK key size ever becomes a
  measured storage/index-size problem. Fine as-is.
- **`encodeNumeric` on a `bigint` beyond ±double-range would throw.** `primary =
  Number(value)` becomes `Infinity`, and `BigInt(Infinity)` throws. Not
  SQL-reachable: SQL integers are int64 (≤ ~9.2e18), whose `Number()` is finite.
  Only trips if a caller feeds `encodeNumeric` a non-SQL bigint > ~1.8e308.
  Recorded here; no code change (would add dead defensive branches).

## Review outcome

Encoding fix is correct and adequately covered at the unit + range-parity level.
Lint and store tests green. The one genuine end-to-end gap is not a defect in
this ticket's code — it is blocked by the already-tracked
`fix/txn-changelog-bigint-key`, and that gap is documented in-code for the next
reader. No new tickets filed; one tripwire NOTE added; no behavioral changes.
