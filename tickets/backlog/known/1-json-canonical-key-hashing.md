description: JSON value hashing/key-encoding is not canonical — disagrees with the order-independent JSON comparator
files:
  - packages/quereus/src/types/json-type.ts (compare/deepCompareJson — order-independent truth; serialize is plain JSON.stringify)
  - packages/quereus/src/util/key-serializer.ts (appendValue — runtime hash-key path for GROUP BY / DISTINCT / bloom join)
  - packages/quereus-store/src/common/encoding.ts (encodeObject / encodeValue / encodeCompositeKey — persisted PK/index byte keys)
----

## Overview

The JSON logical type defines equality/ordering via `deepCompareJson`
(`json-type.ts:55-137`), which **sorts object keys before comparing**
(`Object.keys(objA).sort()`). So `{a:1,b:2}` and `{b:2,a:1}` compare *equal*,
and key order is treated as semantically irrelevant — the correct, intended
contract.

Nothing canonicalizes key order anywhere else, though. In-memory JSON is a
native JS object in insertion order, and `serialize()` is a bare
`JSON.stringify(v)` (no key sorting). The hash/key/encode paths that should
agree with the comparator instead derive keys from the raw object, so two
values the comparator calls equal can produce **different hashes / different
stored keys**. Two concrete divergences exist today:

### a) Store-layer key encoding is order-sensitive (correctness)

`quereus-store` encodes a JSON value for a key by its raw string:
`encodeObject(JSON.stringify(value), collation)` — "sort by JSON string
representation." So `{a:1,b:2}` and `{b:2,a:1}` encode to **different byte
keys** despite comparing equal in `deepCompareJson`. When a JSON value
participates in a primary key (or index) on the LevelDB store path, those two
are stored as **two distinct rows** — diverging from the in-memory / memory-vtab
comparator semantics, so the same schema + data behaves differently across
storage backends.

### b) Runtime hash-key serializer is lossy (correctness)

The GROUP BY / DISTINCT / bloom-join key path (`key-serializer.ts:46-58`)
serializes objects as:

```ts
return 'o:' + String(val);   // String({...}) === '[object Object]'
```

This collapses *every* distinct JSON object to the same key, so a GROUP BY or
hash join keyed on a JSON column over-groups all object values into one bucket.
This is independent of key ordering — it's wrong for any two distinct JSON
objects, not just reordered-equal ones.

## Expected behavior

A JSON value's hash / encoded key must agree with `deepCompareJson`: two values
that compare equal hash/encode identically, and two that compare unequal
hash/encode differently. Concretely:

- `{a:1,b:2}` and `{b:2,a:1}` → same hash, same stored key, group/join together.
- `{a:1}` and `{a:2}` → different hash, different stored key, do not collapse.
- Behavior is identical across the memory vtab and the LevelDB store.

## Use case

```sql
create table t (id json primary key, n integer);
insert into t values ('{"a":1,"b":2}', 10);
insert into t values ('{"b":2,"a":1}', 20);  -- same logical key → should conflict/replace, not insert a 2nd row

select id, count(*) from t2 group by id;      -- JSON column must group by value, not collapse all objects
```

## Considerations / direction

- Introduce one canonical JSON serializer (recursively sort object keys, stable
  output) and route the hash/key/encode paths through it: `appendValue` (fixes b),
  store `encodeObject`/key encoding (fixes a). Optionally `serialize()` itself if
  stored strings should be canonical (helps any `bodyHash`/schema-hash stability).
- The comparator (`deepCompareJson`) is the source of truth and already correct —
  this is purely making the derived hash/encode paths agree with it; the
  comparator should not need to change.
- Watch the array case: array element order *is* significant (the comparator
  compares positionally) — only object **keys** get sorted.
- NaN/Infinity → null and -0 → 0 already lose distinctions through JSON; keep the
  canonical form consistent with what `JSON.stringify`/`safeJsonParse` already do
  so round-trips don't introduce new mismatches.
- Cross-check that memory-vtab keying (digitree comparator path) already uses the
  type `compare`, so it is consistent — the work is bringing the string-key and
  byte-key paths in line with it.
