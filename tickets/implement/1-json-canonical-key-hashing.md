description: When rows are grouped, joined, de-duplicated, or checked for uniqueness on a JSON or mixed-numeric value, the engine can wrongly split values that are equal into separate buckets and wrongly merge values that are different into one — build a single canonical key form so a value's hash/stored key always agrees with the comparator that decides equality.
files:
  - packages/quereus/src/util/key-serializer.ts        # appendValue — runtime string hash-key (GROUP BY / DISTINCT / bloom join / asof / window / store UNIQUE re-validation)
  - packages/quereus/src/util/comparison.ts            # objectCanonicalString (~176-203) — OBJECT-class equality/order for compareSqlValues; NOTE already flags this work
  - packages/quereus/src/types/json-type.ts            # deepCompareJson — the equality source of truth (DO NOT change); serialize() is bare JSON.stringify
  - packages/quereus/src/common/json-types.ts          # JSONValue type
  - packages/quereus-store/src/common/encoding.ts      # encodeValue / encodeObject / decodeObject — persisted PK/index byte keys
  - packages/quereus/src/index.ts                      # export the new canonical serializer for quereus-store
difficulty: medium
----

## Summary

The hash/encoded-key paths promise an equality invariant — *values that compare
equal produce identical keys; values that compare unequal produce different keys* —
but three code paths break it. This ticket introduces **one canonical JSON
serializer** plus **numeric-class normalization**, and routes the derived
key/hash/encode paths through them. The comparator `deepCompareJson`
(`types/json-type.ts`) is the source of truth and is already correct — this work
brings the derived paths into agreement with it. **It does not change the
comparator, and it does not change how JSON values are displayed or stored** — only
how their *keys* are derived.

## Reproduction (confirmed)

Forcing a HashAggregate over a JSON column (PK on another column makes the scan
ordered by that column, so GROUP BY on the JSON column is unsorted → HashAggregate,
which is the buggy `serializeKey` path; a *sorted* GROUP BY instead picks
StreamAggregate, which uses the typed comparator and is already correct — that is
why a naive `group by json_col` test passes and hides the bug):

```sql
create table t (id integer primary key, j json) using memory;
insert into t values (1, '{"a":1}');
insert into t values (2, '{"a":2}');
insert into t values (3, '{"b":9}');
select count(*) as groups from (select j from t group by j);
-- EXPECTED 3 (three distinct objects); ACTUAL 1 (all collapse to 'o:[object Object]')
```

Empirically observed: `Actual {"groups":1}` vs `Expected {"groups":3}`. This
confirms breakage (a). Breakages (b) and (c) below follow from the same code by
inspection.

## Root causes

### (a) All JSON objects collapse to one key — runtime path

`appendValue` (`util/key-serializer.ts` ~46-59) serializes an object value as:

```ts
} else {
    return 'o:' + String(val);   // String({...}) === '[object Object]'
}
```

Every distinct JS object/array serializes to the same string `'o:[object Object]'`.
Any hash-keyed operation on native-object values over-groups them into one bucket:
HashAggregate GROUP BY, DISTINCT, bloom/asof join, window PARTITION BY, and store
UNIQUE re-validation (`serializeRowKey`).

Note: a JSON *column* often flows as a native object at runtime (`typeof(id)` →
`json`, value `{a:1}`), so this path is reachable. It does **not** reproduce when the
value happens to be a raw JSON *string* (string branch keys distinct strings
distinctly) nor when the plan picks StreamAggregate.

### (b) Equal numeric values get different tags — runtime path

`appendValue` tags numerics by JS runtime type: number → `'n:'`, bigint → `'b:'`,
and boolean falls into the object branch (`'o:true'`). But `compareSqlValues`
(`util/comparison.ts`, `StorageClass.NUMERIC`) treats `5n` (bigint) and `5` (number)
as equal, and `true`/`1` as equal (booleans coerced to 0/1). So values that compare
equal get different keys → wrongly split apart in GROUP BY / DISTINCT / joins / store
UNIQUE.

### (c) Object key order is significant where it must not be

`deepCompareJson` sorts object keys before comparing, so `{a:1,b:2}` and `{b:2,a:1}`
compare **equal**. But nothing canonicalizes key order in the derived paths:

- Runtime: `appendValue`'s object branch (once fixed for (a)) must sort keys too, or
  reorder-equal objects still key differently.
- `compareSqlValues`: `objectCanonicalString` (`util/comparison.ts` ~196-203) uses
  bare `JSON.stringify` (insertion order), so `compareSqlValues` treats reorder-equal
  objects as **unequal** — disagreeing with `deepCompareJson`. Its own NOTE (~186-192)
  already says to align it with "the `json-canonical-key-hashing` work if that lands a
  different [canonical form]" — this is that work.
- Store: `encodeValue` → `encodeObject(JSON.stringify(value), collation)`
  (`quereus-store/src/common/encoding.ts` ~131-133) encodes the raw insertion-order
  string, so reorder-equal JSON PKs encode to **different byte keys** → stored as two
  distinct rows instead of conflicting/replacing. Diverges from memory-vtab semantics
  for identical schema+data.

## Expected behavior

- `{a:1}` vs `{a:2}` → different keys (no collapse).
- `{a:1,b:2}` vs `{b:2,a:1}` → same key, same stored byte key; group/join together;
  on a JSON PK the second insert conflicts/replaces rather than inserting a 2nd row.
- `5n` vs `5` → same key. `true` vs `1` → same key.
- Arrays: element order **is** significant (comparator is positional) — sort object
  keys only, never array elements.
- Behavior identical across memory vtab and LevelDB store.

Use case:

```sql
create table t (id json primary key, n integer);
insert into t values ('{"a":1,"b":2}', 10);
insert into t values ('{"b":2,"a":1}', 20);  -- same logical key: conflict/replace, not a 2nd row
select id, count(*) from t group by id;       -- group by value, not one collapsed bucket
```

## Design

### One canonical JSON serializer

Add `util/json-canonical.ts` exporting e.g. `canonicalJsonString(v: JSONValue): string`:

- Recursively emit JSON with **object keys sorted** (ascending, matching
  `deepCompareJson`'s `Object.keys(objA).sort()`), arrays left in positional order.
- Stable, deterministic output.
- Keep NaN/Infinity → null and -0 → 0 consistent with what `JSON.stringify` /
  `safeJsonParse` already do, so no new round-trip mismatch is introduced.
- Export from `packages/quereus/src/index.ts` so `quereus-store` can import it (store
  already imports helpers from `@quereus/quereus`).

This canonical form is used **only to derive keys** — never as the value's stored or
displayed string. Do **not** change `json-type.ts` `serialize()` to canonicalize:
existing tests (`06.7-json-extended.sqllogic`, `json_group_object`, etc.) assert
insertion-order output; display/storage must stay insertion-order.

### Numeric-class normalization (runtime hash key)

In `appendValue`, collapse the numeric classes to a single tag so values equal under
`compareSqlValues` serialize identically:

- boolean → treat as `1`/`0`.
- bigint → decimal string.
- number that is integer-valued (`Number.isInteger`) → normalize via `BigInt(n)`
  decimal string, so `5`, `5.0`, and `5n` all key to the same `n:5`. (`BigInt(1e21)`
  === `10n**21n`, so exponential-notation integers also normalize.)
- non-integer number → its `String(n)` form.
- Emit under a single numeric tag (e.g. `n:`), distinct from the string tag.

Mirror `compareSqlValues`/`compareSqlValuesFast` semantics exactly — do not invent new
equality rules. Two numerics that compare equal must produce the same string; two that
compare unequal must differ.

### Route the paths through the canonical form

- `appendValue` object branch → `'o:' + canonicalJsonString(val)` (fixes a + c runtime).
- `objectCanonicalString` in `comparison.ts` → return `canonicalJsonString(v)` so
  `compareSqlValues` OBJECT-class equality matches `deepCompareJson`; retire/adjust the
  NOTE that flagged this work. (This also changes OBJECT-class *ordering* under
  `compareSqlValues` from insertion-order to sorted-key order — an alignment, not a
  regression; rely on the existing suite to catch fallout.)
- Store `encodeValue`/`encodeObject` → canonicalize the JSON string before encoding, so
  reorder-equal JSON values encode to identical bytes (fixes c persisted).

## Watch-outs (investigate during implement)

- **Store `decodeObject` round-trip.** Once `encodeObject` canonicalizes, decoding a
  JSON key yields sorted-key order, not insertion order. The stored *row* (via
  `deserializeRow`) is the source of truth for displayed values and is unaffected —
  but check whether any path reconstructs a JSON PK value *from the decoded key* (e.g.
  an index-only / covering scan that returns PK columns without reading the data row).
  If so, either route that value from the stored row, or accept canonical-order output
  and document it. Grep `decodeObject` / `decodeCompositeKey` consumers.
- **Numeric huge-magnitude edge.** A `number` and `bigint` that compare equal but whose
  decimal strings could differ (extreme magnitudes / float imprecision) is a rare edge;
  the `BigInt(n)` normalization handles the common integer cases. If a residual gap
  remains, leave a `NOTE:` at the site rather than over-engineering.
- **Related, out of scope — do not fix here.** `database-transaction.ts`
  `serializeKeyTuple` (~447) also uses `JSON.stringify(values)` for change-log keys
  (throws on bigint, no canonicalization); tracked separately in
  `fix/txn-changelog-bigint-key`. Mentioned so you recognize the same anti-pattern; do
  not touch it in this ticket.

## TODO

- Add `util/json-canonical.ts` with `canonicalJsonString` (recursive object-key sort,
  positional arrays, deterministic); unit-test it directly (reorder-equal → identical,
  distinct → different, nested, arrays-positional, null/-0/NaN parity with existing).
- Export it from `packages/quereus/src/index.ts`.
- Fix `appendValue`: numeric-class normalization (bigint/number/boolean) + object branch
  through `canonicalJsonString`.
- Route `objectCanonicalString` (`comparison.ts`) through `canonicalJsonString`; update
  its NOTE.
- Canonicalize the JSON string in `encodeValue`/`encodeObject` (`quereus-store`).
- Investigate `decodeObject` consumers per Watch-outs; route from stored row or document.
- Tests:
  - sqllogic (memory): forced-HashAggregate GROUP BY over distinct JSON objects → N
    groups (the confirmed repro above); reorder-equal → one group; numeric `5`/`5.0`
    (and a bigint path if reachable) → one group; `true`/`1` → one group. Also cover a
    bloom/hash join and DISTINCT on JSON/numeric keys.
  - store (`yarn test:store` or a store spec): JSON PK insert of reorder-equal values →
    conflict/replace (one row); store UNIQUE re-validation treats reorder-equal as
    duplicate and numeric `5n`/`5` as duplicate.
  - Confirm display/storage output stays insertion-order (JSON select round-trip
    unchanged).
- Run `yarn test` and `yarn lint` in `packages/quereus`; run `yarn test:store` (or the
  targeted store spec) for the persisted-path assertions. Stream long output with `tee`.
- Update `docs/types.md` / `docs/schema.md` where they describe JSON key/equality
  semantics, noting the single canonical key form and that display stays insertion-order.
