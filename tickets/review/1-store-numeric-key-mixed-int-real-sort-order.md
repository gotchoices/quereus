description: Verify the fix that makes a persistent-store numeric key sort all numbers by value (whole and fractional interleaved), so range queries no longer silently skip rows.
prereq:
files:
  - packages/quereus-store/src/common/encoding.ts          # the fix: unified TYPE_NUMERIC encode/decode (encodeNumeric ~216, decodeNumeric ~395)
  - packages/quereus-store/test/encoding.spec.ts            # unit sort-order/roundtrip tests (mixed int/real ~81, large-int ~95, -0 ~114)
  - packages/quereus-store/test/pushdown.spec.ts            # store-vs-memory range parity tests (~398-435)
  - packages/quereus-plugin-indexeddb/test/store.spec.ts    # key-layout assertions updated 9→17 bytes (~286, ~571)
  - packages/quereus/src/util/comparison.ts                 # the oracle: compareNumbers (173), getStorageClass (130)
difficulty: hard
----

# Review: store numeric key encoding unified to order all numbers by value

## What the bug was (one paragraph, plain)

The persistent store turns each primary/index key value into bytes, and the
key-value store compares those bytes left-to-right (memcmp). The old encoder
chose the numeric format by the value's JavaScript *shape*: a whole number
(`bigint`) got type-tag byte `0x01`, a fractional number (`number`) got `0x02`.
Because the tag comes first, **every** whole number sorted before **every**
fractional one — so `3` sorted below `2.5`. A range query like `where x >= 2.5`
builds a byte window starting at `2.5`'s bytes; the row `3` lived below that
window and was never visited. The query silently returned fewer rows than it
should. (The row-level `matchesFilters` re-filter cannot rescue a row the seek
window skipped — it only sees rows the seek already yielded.)

## The fix that landed

Single type tag `TYPE_NUMERIC = 0x01` for both `bigint` and `number`. Fixed
17-byte body: `[tag][8-byte order-preserving double][8-byte signed tie-break]`.

- **Primary 8 bytes** = the sortable-double transform (IEEE-754 big-endian, sign
  bit flipped for non-negatives / all bits flipped for negatives) of
  `Number(value)`. Orders every value by magnitude across the int/real boundary
  and preserves `-Inf < … < +Inf < NaN`.
- **Tie-break 8 bytes** = the exact signed residual `value - nearestDouble`
  (sign-flipped big-endian int64). Distinct finite doubles never share primary
  bytes, so the only collisions are large integers (past 2^53) that round to the
  same double; the residual orders those exactly and **keeps full int64
  precision** (no data loss where two big ints would otherwise collide to one
  key). A `number` is its own exact double, so its residual is always 0.
- `-0` normalized to `+0` so `-0`, `+0`, `0n` collide to one key (matches
  `compareNumbers(-0, 0) === 0`).
- **decode** returns `bigint` for integer-valued results, `number` otherwise —
  same contract as before (integer-valued reals like `0.0` roundtrip to `0n`).
  Every downstream comparator is numeric-class-tolerant (`5n` equals `5.0`), so
  the bigint/number choice is cosmetic, never a correctness lever.

`TYPE_INTEGER`/`TYPE_REAL` and their encode/decode helpers were removed (no
external importers; on-disk backcompat is explicitly not a concern yet per
AGENTS.md). Key width grew 9→17 bytes for numeric keys — see tripwire below.

## The oracle (what "correct" is measured against)

`packages/quereus/src/util/comparison.ts`: `getStorageClass` maps `bigint`,
`number`, `boolean` all to one NUMERIC class; `compareNumbers` is `a < b ? -1 :
a > b ? 1 : 0`. JS relational operators compare a bigint against a number by
exact mathematical value (no lossy coercion), so the in-memory path interleaves
ints and reals by true value with full int64 precision. The store's encoded
bytes must memcmp in exactly that order. The parity tests assert store output
equals the in-memory-vtab output for the same query.

## How it was validated (this is a floor, not a ceiling)

All green:
- `yarn test` (full workspace) — exit 0; quereus 6511, store 690, indexeddb 73,
  leveldb, sync 429, quoomb-web 74, others.
- `yarn test:store` (logic tests over the **real LevelDB** store path, exercises
  actual encoded keys) — 6506 passing, exit 0.
- `yarn workspace @quereus/quereus run lint` — exit 0 (eslint + tsc typecheck of
  spec call sites). store/indexeddb packages have no lint (intentional no-op).

New/changed tests worth re-reading:
- `encoding.spec.ts`: mixed int/real memcmp order over `[-3.5,-3n,-2.5,0n,2.5,3n,3.5]`;
  large-int precision over `2^53 .. 2^53+2` (distinct + ordered + exact roundtrip);
  `-0`/`+0`/`0n` collide to one key.
- `pushdown.spec.ts` → `numeric primary key mixed int/real range seek`: ASC
  `x >= 2.5`, `BETWEEN 2.5 and 3`, and **DESC** `x >= 2.5` all asserted equal to
  the memory-vtab oracle (DESC exercises the whole-component `^0xff` inversion on
  the fixed-width body).
- `store.spec.ts` (indexeddb): key-layout assertions updated to 17 bytes, first
  byte `0x01` (now TYPE_NUMERIC).

## Where a reviewer should push hardest (known gaps — honest)

1. **No end-to-end SQL range query over |int| ≥ 2^53 through the store.** The
   large-integer collision/precision case is covered at the *unit* level
   (`encoding.spec.ts` byte-order + roundtrip) and the range-seek *mechanism* is
   covered at small magnitudes (`pushdown.spec.ts`). But nothing runs, e.g.,
   `where x between 9007199254740990 and 9007199254740994` against the store and
   compares to the oracle. The two existing tests together cover the moving
   parts, but a skeptic may want that one combined test. Consider adding it.
2. **Fuzz parity.** The ticket suggested a fuzz set mixing `|int| ≥ 2^53` with
   reals through the numeric range path. Not added. The property-based planner
   fuzz in the main suite does not specifically target 2^53-neighborhood numeric
   PKs. Worth a targeted fuzz if you want belt-and-suspenders on the tie-break.
3. **Integer-valued reals decode to `bigint`, including huge ones** (e.g. a
   `number` `1e19` → `10000000000000000000n` on key decode). Intended and
   comparator-safe, but confirm no consumer downstream of a *key* decode assumes
   `number` for a value that came in as a real. (Row *values* are stored/served
   separately via `serializeRow`, not from the key, so display fidelity is
   unaffected — but verify that reasoning holds for any index-only read path.)
4. **DESC + tie-break interaction.** DESC inverts all 17 bytes. Convince yourself
   the tie-break tail inverts correctly for negative-primary tie-sets (e.g. two
   big *negative* ints sharing a double). Reasoned correct (fixed width ⇒
   inversion reverses total memcmp order) and the DESC test passes at small
   magnitude, but there is no DESC test at 2^53 magnitude.

## Tripwire (parked, not a ticket)

Numeric key width doubled (9 → 17 bytes). The 8-byte tie-break tail is wider
than necessary — an int64's residual is bounded by ~2^11, so a 4-byte int32 tail
would do. Parked as a `NOTE:` comment at `NUMERIC_KEY_LENGTH` in `encoding.ts`:
*if numeric-PK key size ever becomes a storage/index-size problem, shrink the
tail to 4 bytes (keep it fixed-width).* Fine as-is now; only trips if key size
becomes a measured concern.

## Review findings

- Implementation + all four test-file edits were already committed by the prior
  interrupted run (the "agent error" commit); this run verified them end-to-end
  (`yarn test`, `yarn test:store`, lint all green) and added the key-width
  tripwire NOTE. No behavioral changes made this run.
- Noticed and parked: numeric key width doubled to 17 bytes; tie-break tail
  reducible to 4 bytes — recorded as a `NOTE:` at `encoding.ts` `NUMERIC_KEY_LENGTH`.
- Flagged gaps (above): no combined end-to-end SQL range test at |int| ≥ 2^53, no
  targeted numeric fuzz, no DESC test at 2^53 magnitude. All are additive
  coverage on an already-passing mechanism, not known defects.
