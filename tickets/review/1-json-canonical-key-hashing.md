description: A JSON/mixed-numeric value's hash and stored key now always agree with the comparator that decides equality, so grouping, joins, de-duplication, and uniqueness no longer wrongly split equal values apart or merge different ones together.
files:
  - packages/quereus/src/util/json-canonical.ts          # NEW canonicalJsonString — recursive object-key sort, arrays positional
  - packages/quereus/src/util/key-serializer.ts          # appendValue: numeric-class + OBJECT canonicalization
  - packages/quereus/src/util/comparison.ts              # objectCanonicalString routed through canonical form
  - packages/quereus/src/index.ts                        # exports canonicalJsonString
  - packages/quereus-store/src/common/encoding.ts        # encodeValue OBJECT branch canonicalizes
  - packages/quereus/test/util/json-canonical.spec.ts    # NEW unit spec
  - packages/quereus/test/logic/06.9-json-canonical-key.sqllogic  # NEW sqllogic (memory + store)
  - packages/quereus-store/test/encoding.spec.ts         # NEW OBJECT canonical byte-key assertions
  - docs/types.md, docs/schema.md                        # updated JSON key/equality semantics
difficulty: medium
----

## What shipped

One canonical JSON serializer + numeric-class normalization, routed through every
derived key path, so all of them agree with the equality source of truth
`deepCompareJson` (`types/json-type.ts`, **unchanged**).

- **`util/json-canonical.ts` (new)** — `canonicalJsonString(v)`: recursively rebuilds
  the value with object keys sorted ascending (matching `deepCompareJson`'s
  `Object.keys(obj).sort()`), arrays left positional, then `JSON.stringify`s it.
  NaN/Infinity → `null`, `-0` → `0` (JSON.stringify parity). Exported from
  `packages/quereus/src/index.ts` for `quereus-store`.
- **`util/key-serializer.ts` `appendValue`** (the runtime hash-key path — GROUP BY /
  DISTINCT / bloom+asof join / window PARTITION BY / store UNIQUE re-validation):
  - numeric classes collapse to one `n:` tag via `canonicalNumeric` (boolean→`0`/`1`,
    bigint→decimal, integer number→`BigInt(n)` decimal, non-integer→`String(n)`), so
    `5n`==`5`, `true`==`1` key alike;
  - OBJECT branch was `'o:' + String(val)` → **every object collapsed to
    `'o:[object Object]'`**; now `'o:' + canonicalJsonString(val)`.
- **`util/comparison.ts` `objectCanonicalString`** now returns `canonicalJsonString(v)`
  (still `WeakMap`-cached), so `compareSqlValues` OBJECT-class equality/order matches
  `deepCompareJson`. The stale NOTE that flagged this work is retired.
- **`quereus-store` `encodeValue`** OBJECT branch: `JSON.stringify` → `canonicalJsonString`,
  so reorder-equal JSON PK/index values encode to identical bytes.

Key derivation ONLY — storage and display stay insertion-order (unchanged
`json-type.ts` `serialize()`; store keeps the full row via `serializeRow`).

## How to validate / use cases

Confirmed repro (was `groups:1`, now `3`):
```sql
create table t (id integer primary key, j json);
insert into t values (1,'{"a":1}'),(2,'{"a":2}'),(3,'{"b":9}');
select count(*) as groups from (select j from t group by j);  -- 3
```
(PK on `id` leaves the scan ordered by id → GROUP BY on `j` is unsorted →
HashAggregate = the `serializeKey` path. A *sorted* GROUP BY picks StreamAggregate,
which used the typed comparator and was already correct — that's why a naive
`group by json_col` hid the bug.)

Reorder-equal / distinctness / JSON PK conflict:
```sql
create table pk (id json primary key, n integer);
insert into pk values ('{"a":1,"b":2}', 10);
insert or replace into pk values ('{"b":2,"a":1}', 20);  -- same key → replaces
select count(*) from pk;      -- 1 row
select id from pk;            -- {"b":2,"a":1} — display stays insertion-order
```

Tests to run:
- `cd packages/quereus && node test-runner.mjs --grep "json-canonical|canonicalJsonString|serializeKey equality"` (memory)
- `node test-runner.mjs --store --grep "json-canonical"` (LevelDB persisted byte-key)
- `cd packages/quereus-store && yarn test` (encoding.spec canonical byte-key assertions)

## Validation performed (all green)

- `packages/quereus` full memory suite: **6495 passing**, 9 pending.
- `packages/quereus` full **store mode** (`--store`): **6490 passing**, 14 pending —
  ran the whole suite because this touches persisted encoding; no JSON-PK regression.
- `packages/quereus` `yarn lint` (eslint + `tsc -p tsconfig.test.json`): clean.
- `packages/quereus-store` `yarn test`: **679 passing**.
- Documentation validation spec: 6 passing.

## Gaps / things a reviewer should probe (my tests are a floor)

- **Bloom/hash-join over JSON not pinned to the hash path.** The sqllogic join
  (`on l.j = r.j`) validates *comparator* agreement, but for a 1-row join the planner
  likely picks nested-loop, not a bloom/hash join — so `serializeRowKey`'s JSON path
  isn't exercised *as a join* by that test. It IS covered indirectly: `serializeRowKey`
  and `serializeKey` share `appendValue`, unit-tested directly. A reviewer wanting the
  true integration could force a hash join over a JSON key with enough rows.
- **Store-side numeric `5n`/`5` UNIQUE re-validation not directly asserted at the store
  level.** The ticket asked for it; I covered JSON-PK conflict/replace in store mode and
  numeric-class equality in the `serializeKey` unit spec (same code the store re-validator
  calls), but there is no store spec that inserts a bigint vs number colliding on a UNIQUE
  column. Getting a bigint to reach that path from pure SQL is awkward; worth a targeted
  store unit test if the reviewer wants belt-and-suspenders.
- **OBJECT-class ordering changed** under `compareSqlValues`, from insertion-order to
  sorted-key order (an alignment with `deepCompareJson`, not a regression). Full suite is
  green, so no fallout surfaced, but it is a real behavioral change for any `order by` on a
  raw JSON object column — worth a conscious ack.
- **`decodeObject` round-trip** now yields sorted-key order for a decoded JSON key. Verified
  **no production path** reconstructs a PK value from the decoded key (`decodeCompositeKey`/
  `decodeValue` are only defined/exported/unit-tested in `quereus-store`; rows are read from
  the stored payload via `deserializeRow`), so display is unaffected. If a covering/index-only
  scan that returns PK columns from the key is ever added, it must route from the stored row.

## Tripwire (recorded in code, not a ticket)

- `NaN`/`±Infinity` numeric hash keys: `canonicalNumeric` emits `n:NaN` / `n:Infinity`, so
  two NaN key alike but NaN never keys equal to a finite value — whereas the numeric
  comparator treats NaN as equal to everything (a degenerate SQL edge). Left as a `NOTE:` at
  `key-serializer.ts` `canonicalNumeric` rather than over-engineering; revisit only if
  NaN-valued numeric keys ever matter.
