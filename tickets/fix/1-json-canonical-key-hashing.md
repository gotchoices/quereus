description: Two data values that the engine considers equal can be given different internal keys (and two unequal ones the same key), so grouping, joins, uniqueness checks, and stored rows can wrongly split apart or wrongly merge together.
files:
  - packages/quereus/src/util/key-serializer.ts (appendValue — runtime hash-key path for GROUP BY / DISTINCT / bloom join; numeric/bool tags and object serialization, ~46–59)
  - packages/quereus/src/types/json-type.ts (compare/deepCompareJson — order-independent equality; serialize is plain JSON.stringify)
  - packages/quereus-store/src/common/encoding.ts (encodeObject / encodeValue / encodeCompositeKey — persisted PK/index byte keys)
----

## Problem

The key/hash serializer promises an equality invariant — "values that compare
equal produce identical keys, values that compare unequal produce different keys"
— but it does not hold. Two independent classes of breakage:

### a) JSON objects all collapse to one key

`appendValue` in `util/key-serializer.ts` (~46–58) serializes an object value as:

```ts
return 'o:' + String(val);   // String({...}) === '[object Object]'
```

So *every* distinct JSON object serializes to the same key `'o:[object Object]'`.
A GROUP BY or hash/bloom join keyed on a JSON column over-groups all object values
into one bucket, and store UNIQUE re-validation wrongly treats distinct objects as
duplicates. This is wrong for any two distinct objects, independent of key order.

### b) Numeric classes get different tags for equal values

The JSON logical type's comparator (`deepCompareJson` in `types/json-type.ts`)
defines equality by value, and the SQL comparators treat `5n` (bigint) and `5`
(number) as equal, and `true` and `1` as equal. But `appendValue` tags these by
JavaScript runtime type, so `5n` vs `5` and `true` vs `1` get *different* keys.
Values that compare equal thus land in different buckets / different stored keys —
wrongly splitting equal values apart in PARTITION BY, GROUP BY, DISTINCT, hash
joins, and store UNIQUE re-validation.

### c) Object key order is significant where it should not be (store path)

`deepCompareJson` sorts object keys before comparing, so `{a:1,b:2}` and
`{b:2,a:1}` compare **equal**. But nothing canonicalizes key order elsewhere:
in-memory JSON keeps insertion order and `serialize()` is a bare `JSON.stringify`.
`quereus-store` encodes a JSON key value by its raw string
(`encodeObject(JSON.stringify(value), collation)`), so those two reorder-equal
values encode to **different byte keys** and are stored as two distinct rows on
the LevelDB store path — diverging from memory-vtab semantics for the same schema
and data.

## Expected behavior

A value's hash / encoded key must agree with the comparator that defines its
equality: values that compare equal hash and encode identically; values that
compare unequal hash and encode differently. Concretely:

- `5n` and `5` → same key. `true` and `1` → same key (matching SQL comparator).
- `{a:1}` and `{a:2}` → different keys; must not collapse into one bucket.
- `{a:1,b:2}` and `{b:2,a:1}` → same key, same stored key, group/join together, and
  on a primary key they conflict/replace rather than insert a second row.
- Behavior identical across the memory vtab and the LevelDB store.

## Use case

```sql
create table t (id json primary key, n integer);
insert into t values ('{"a":1,"b":2}', 10);
insert into t values ('{"b":2,"a":1}', 20);  -- same logical key: should conflict/replace, not insert a 2nd row

select id, count(*) from t group by id;       -- must group JSON by value, not collapse all objects into one bucket
```

## Considerations / direction

- Normalize numeric classes to a single tag in `appendValue` so bigint/number
  (and boolean where the comparator treats it numerically) that compare equal
  serialize identically — mirror `compareSqlValues` semantics, don't invent new ones.
- Introduce one canonical JSON serializer (recursively sort **object** keys, stable
  output) and route the derived key/hash/encode paths through it: `appendValue`
  (fixes a and c for the runtime path) and store `encodeObject` / key encoding
  (fixes c for the persisted path). Optionally `serialize()` itself if stored
  strings should be canonical (also helps schema/body-hash stability).
- `deepCompareJson` is the source of truth and is already correct — this is purely
  bringing the derived hash/encode paths into agreement; the comparator should not change.
- Arrays: element order **is** significant (the comparator compares positionally) —
  only object **keys** get sorted, never array elements.
- NaN/Infinity → null and -0 → 0 already lose distinctions through JSON; keep the
  canonical form consistent with what `JSON.stringify` / `safeJsonParse` already do
  so round-trips introduce no new mismatches.
- Memory-vtab keying (digitree comparator path) already uses the type `compare`, so
  it is consistent — the work is bringing the string-key and byte-key paths in line.
