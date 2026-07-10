---
description: Text containing emoji (or any other character outside the basic character range) sorts one way in memory tables and a different way in persistent-store tables. Persistent-store queries can return rows in the wrong order, or silently drop rows from a range query, with no custom collation involved.
files:
  - packages/quereus/src/util/comparison.ts                        # BINARY_COLLATION / NOCASE_COLLATION / RTRIM_COLLATION — compare with JS `<`/`>`
  - packages/quereus/src/core/database.ts                          # registerCollation — `orderPreserving` doc + the NOTE that records this
  - packages/quereus-store/src/common/encoding.ts                  # encodeText — `new TextEncoder().encode(...)`, i.e. UTF-8 key bytes
  - packages/quereus-store/src/common/store-table.ts               # keyOrderMatchesCollation — trusts the built-ins' `orderPreserving` stamp
  - packages/quereus/test/collation-normalizer.spec.ts             # CORPUS is deliberately astral-free; the property test would fail otherwise
difficulty: hard
---

# Built-in collations order by UTF-16 code unit; store keys order by UTF-8 byte

## The disagreement

The engine's three built-in collations compare strings with JavaScript's `<` / `>`
(`packages/quereus/src/util/comparison.ts`). JavaScript compares strings by **UTF-16 code
unit**. The persistent store writes each text key as **UTF-8 bytes**
(`encodeText` → `new TextEncoder().encode(...)`) and physically orders rows by `memcmp` of
those bytes.

For every character in the basic multilingual plane below `U+D800` the two orders agree.
They disagree for characters *above* `U+FFFF` (emoji, rarer CJK, musical symbols — the
"astral" planes). Such a character is stored in JavaScript as a **surrogate pair**, whose
first code unit is in `U+D800`–`U+DFFF`. So JavaScript sorts it *below* every character in
`U+E000`–`U+FFFF`, while its UTF-8 encoding (`F0…`) sorts *above* their encodings (`EE…`,
`EF…`).

`U+E000`–`U+FFFF` is not an obscure corner: it holds the Private Use Area, the CJK
Compatibility Ideographs (`U+F900`–`U+FAFF`), the Arabic Presentation Forms, the
Halfwidth/Fullwidth Forms used throughout CJK text (`U+FF00`–`U+FFEF`), and the replacement
character `U+FFFD`.

## Reproduction

No custom collation, no `orderPreserving` opt-out — this is the default `BINARY` path.
`'Ａ'` below is `U+FF21` (fullwidth capital A); `'😀'` is `U+1F600`.

```sql
create table t (k text collate binary primary key) using store;
create table m (k text collate binary primary key);            -- memory oracle
insert into t values ('😀'), ('Ａ');
insert into m values ('😀'), ('Ａ');

select k from t order by k;      -- store:  ['Ａ', '😀']   ← wrong; Sort was elided
select k from m order by k;      -- memory: ['😀', 'Ａ']   ← the comparator's answer

select k from t where k < 'Ａ';  -- store:  []            ← row silently dropped
select k from m where k < 'Ａ';  -- memory: ['😀']
```

The dropped row is the more serious half. The store's byte window for `k < 'Ａ'` ends at
`EF BC A1`; the emoji's key is `F0 9F 98 80`, outside it. The planner marked the range
filter handled and discarded the residual, so nothing rechecks the row.

The wrong `order by` is the store's `providesOrdering` advertisement being taken at its
word: the rows arrive in key-byte order and the Sort was elided.

## Why the recent order-preservation gate does not catch it

`store-range-seek-order-preserving-gate` added `registerCollation(..., { orderPreserving })`,
whose stated contract is exactly the property that fails here:

> for all strings `x`, `y`, `sign(comparator(x, y))` equals
> `sign(memcmp(utf8(normalizer(x)), utf8(normalizer(y))))`

and it stamps `orderPreserving: true` on `BINARY`, `NOCASE`, and `RTRIM`. That stamp is
**false** for astral input, for all three. The store therefore trusts the byte window and
the byte-order advertisement precisely where it must not. The gate's engine-side property
test (`packages/quereus/test/collation-normalizer.spec.ts`, `orderPreserving assertion` →
"holds for each built-in comparator over the corpus") passes only because its shared corpus
contains no astral characters.

Memory tables are unaffected: they order and filter with the comparator, never with bytes.

## Expected behavior

A store-backed table and a memory-backed table must return the same rows in the same order
for the same query, for any text a user can store — emoji included. Concretely:

- A range predicate on a text primary-key or indexed column must never drop a qualifying row.
- `order by <text pk>` must emit comparator order, whether or not the Sort is elided.

## Shape of the fix (for the fix agent to decide, not prescribed here)

Two directions, and they are not equivalent:

1. **Make the comparators compare by code point.** Iterate code points (`for…of`, or
   `codePointAt`) instead of relying on `<` / `>`. UTF-8 `memcmp` order *is* code-point
   order, so this makes the `orderPreserving` stamp honest and the store's key bytes
   correct by construction. It changes the *engine's* observable sort order for astral text
   — arguably to the more defensible one, and the one SQLite's `BINARY` produces — but it is
   an ordering change existing callers may see.
2. **Retract the `orderPreserving` stamp from the built-ins.** Correct, and a one-line
   change, but it costs every store table its text range seeks and PK-order advertisements —
   a large, unconditional performance regression for a rare input.

Whichever is chosen, extend the corpus in `collation-normalizer.spec.ts` with astral
characters and remove the comment that explains their absence, and add a store-vs-memory
oracle test for the two queries above.

Note the same UTF-16-vs-UTF-8 split may affect anything else that compares engine-sorted
text against store-sorted bytes — index maintenance, merge joins over `providesOrdering`,
the sync engine's key ordering. Worth a sweep once the direction is picked.
