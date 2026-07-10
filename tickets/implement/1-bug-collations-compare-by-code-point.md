---
description: Text containing emoji (or any other character outside the basic character range) sorts one way in memory tables and a different way in persistent-store tables, so store queries can return rows in the wrong order or silently drop rows. Fix by making the built-in string comparisons order characters the same way the store's stored bytes do.
files:
  - packages/quereus/src/util/comparison.ts                        # BINARY/NOCASE/RTRIM comparators + OBJECT-class canonical-string compare — all use JS `<`/`>`
  - packages/quereus/src/types/json-type.ts                        # deepCompareJson — string leaves + object keys, also `<`/`>`
  - packages/quereus/src/util/json-canonical.ts                    # canonicalJsonString — `Object.keys().sort()` (leave alone; see below)
  - packages/quereus/src/core/database.ts                          # built-in registration comment (~L400-415) + the NOTE at ~L1364 that records this bug
  - packages/quereus/test/collation-normalizer.spec.ts             # CORPUS is astral-free on purpose; the orderPreserving property test
  - packages/quereus-store/src/common/encoding.ts                  # encodeText / encodeObject — UTF-8 key bytes (read-only reference)
  - packages/quereus-store/test/collation-order-preserving.spec.ts # neighbour spec; new oracle test goes beside it
difficulty: hard
---

# Make the built-in collations order by code point, not by UTF-16 code unit

## What is wrong

JavaScript's `<` / `>` on strings compares **UTF-16 code units**. The persistent store
writes each text key as **UTF-8 bytes** and physically orders rows by `memcmp` of those
bytes, which is **code-point** order. The two agree for every character below `U+D800`
and disagree above `U+FFFF` (emoji, rarer CJK, musical symbols — the "astral" planes),
because such a character is stored in JavaScript as a surrogate pair whose first code
unit lies in `U+D800`–`U+DFFF`. JavaScript therefore sorts it *below* everything in
`U+E000`–`U+FFFF` (Private Use Area, CJK Compatibility Ideographs, Arabic Presentation
Forms, the Halfwidth/Fullwidth Forms used throughout CJK text, and `U+FFFD`), while its
UTF-8 encoding (`F0…`) sorts *above* their encodings (`EE…`, `EF…`).

All three built-in collations (`BINARY`, `NOCASE`, `RTRIM`) compare with `<` / `>`, and so
does the OBJECT-class (JSON array/object) branch of `compareSameType`, which compares two
canonical JSON strings. Every one of them is registered with `orderPreserving: true`,
whose contract is exactly the property that fails:

> for all strings `x`, `y`, `sign(comparator(x, y))` equals
> `sign(memcmp(utf8(normalizer(x)), utf8(normalizer(y))))`

The store trusts that stamp to (a) narrow a range predicate to a byte window and drop the
residual filter, and (b) advertise primary-key-byte order as a valid ordering so the
planner elides the `Sort`. Both are wrong for astral text.

## Reproduction (all three confirmed against HEAD)

`'Ａ'` is `U+FF21` (fullwidth capital A); `'😀'` is `U+1F600`. No custom collation involved.

```sql
create table t (k text collate binary primary key) using store;
create table m (k text collate binary primary key);            -- memory oracle
insert into t values ('😀'), ('Ａ');
insert into m values ('😀'), ('Ａ');

select k from t order by k;      -- store:  ['Ａ', '😀']   ← Sort elided, byte order emitted
select k from m order by k;      -- memory: ['😀', 'Ａ']   ← the comparator's answer

select k from t where k < 'Ａ';  -- store:  []            ← row silently dropped
select k from m where k < 'Ａ';  -- memory: ['😀']
```

The dropped row is the serious half: the store's byte window for `k < 'Ａ'` ends at
`EF BC A1`, the emoji's key is `F0 9F 98 80`, and the planner marked the range filter
handled and discarded the residual, so nothing rechecks the row.

The same split shows up for a JSON (`any`) primary key, via the OBJECT-class branch —
`encodeObject` writes the canonical JSON string as UTF-8, `compareSameType` compares it
with `<`:

```sql
create table j  (k any primary key) using store;
create table mj (k any primary key);
insert into j  values (json('["😀"]')), (json('["Ａ"]'));
insert into mj values (json('["😀"]')), (json('["Ａ"]'));

select k from j  order by k;     -- store:  [["Ａ"], ["😀"]]
select k from mj order by k;     -- memory: [["😀"], ["Ａ"]]
```

## Direction chosen: compare by code point

Of the two directions the fix ticket named, take the first. Iterating code points makes
the `orderPreserving` stamp honest, keeps every store range seek and byte-order
advertisement, and matches what SQLite's `BINARY` produces (SQLite `memcmp`s UTF-8). The
alternative — retracting the stamp — costs every store table its text range seeks and
primary-key-order advertisements unconditionally, a large permanent performance loss to
accommodate a rare input.

It *does* change the engine's observable sort order for astral text. That is the point,
and it is the more defensible order.

### The comparison primitive

Add one shared helper to `comparison.ts` and route the three collations plus the
OBJECT-class branch through it.

```ts
/** Compare two strings by Unicode code point — the order a memcmp of their UTF-8
 *  encodings produces, and the order SQLite's BINARY collation produces. */
export function compareCodePoints(a: string, b: string): number;
```

Only one detail is subtle, and it makes the implementation cheap. At the **first differing
code unit** of two well-formed strings, either both units are low surrogates
(`U+DC00`–`U+DFFF`) or neither is — because if one is a low surrogate its preceding unit
is the matching high surrogate, and the shared prefix forces the other string to carry the
same high surrogate and therefore a low surrogate of its own. So the verdict at the first
difference is decided by ranking each unit as

```
rank(u) = (u >= 0xD800 && u <= 0xDBFF) ? u + 0x2800 : u     // lift high surrogates above 0xFFFF
```

and comparing the ranks; ties in length fall back to the shorter string first. Verified
exhaustively against `memcmp` of `TextEncoder` output over a 63-string corpus (3969 pairs,
0 disagreements; the naive `<` comparator disagrees on 240 of them).

Suggested shape, so the hot ASCII/BMP path stays a native string compare:

```ts
const HAS_HIGH_SURROGATE = /[\uD800-\uDBFF]/;

export function compareCodePoints(a: string, b: string): number {
	if (a === b) return 0;
	if (!HAS_HIGH_SURROGATE.test(a) && !HAS_HIGH_SURROGATE.test(b)) {
		return a < b ? -1 : 1;        // no surrogates ⇒ code-unit order IS code-point order
	}
	// … first-differing-unit scan with rank() …
}
```

`BINARY` is the engine's hottest comparator, so measure before settling on a shape; a
plain `charCodeAt` scan is correct but forfeits V8's native string compare.

### RTRIM

`RTRIM_COLLATION` walks code units of the untrimmed strings up to the *trimmed* minimum
length. Reformulate it as a code-point comparison bounded by the trimmed lengths, with the
existing `lenA - lenB` tie-break (its sign stays correct: if every common code point is
equal, one string is a prefix of the other and is shorter in both code units and bytes).

### NOCASE

`toLowerCase()` handles surrogate pairs correctly (`U+10400` → `U+10428`), so comparing
the lowercased forms by code point satisfies the stamp. No change beyond the comparator
call.

### JSON / OBJECT class

- `compareSameType`'s `StorageClass.OBJECT` branch compares two `canonicalJsonString`
  outputs with `<`. This is the branch `Sort` uses for an `any` primary key, and it must
  match `encodeObject`'s UTF-8 bytes. **Required fix** — route through `compareCodePoints`.
- `deepCompareJson` (`types/json-type.ts`) compares string leaves and object keys with
  `<`. It backs `JSON_TYPE.compare`, not `Sort`, so it does not itself feed store key
  bytes — but leaving it on code-unit order while its sibling moves to code-point order is
  gratuitous incoherence. Move it too.
- `canonicalJsonString`'s `Object.keys(obj).sort()` needs only *determinism*, not agreement
  with any comparator: both the encoder and the comparison string run through the same
  canonicalizer. **Leave it alone** and add a `NOTE:` saying so — changing it would rewrite
  the stored key bytes of every object whose keys contain astral characters.

## Out of scope: unpaired surrogates

A lone surrogate (`'\uD800'` with no low surrogate after it) is not a valid Unicode scalar
and has no UTF-8 encoding; `TextEncoder` maps every one of them to `U+FFFD`. So *no*
comparator can make `orderPreserving` hold for such strings, and the store's text keys are
not injective over them. That is a separate, reachable defect — the store rejects an insert
the memory table accepts:

```sql
create table s (k text primary key, v text) using store;
insert into s values ('\uD800', 'one'), ('\uD801', 'two');   -- ConstraintError: UNIQUE constraint failed: s PK
```

Tracked as `bug-store-lone-surrogate-key-collision`, which depends on this ticket. **Do not
put unpaired surrogates in the corpus here** — they cannot pass the property test until
that ticket lands. State that exclusion in a comment, naming the ticket, exactly as the
current comment names this one.

## Expected behavior after the fix

A store-backed table and a memory-backed table return the same rows in the same order for
the same query, for any *well-formed* text a user can store — emoji included:

- a range predicate on a text primary-key or indexed column never drops a qualifying row;
- `order by <text pk>` emits comparator order, whether or not the `Sort` is elided;
- the plan still shows an `IndexSeek` for the range and still elides the `Sort` — the point
  of choosing this direction is that neither is given up.

## TODO

**Phase 1 — the primitive**

- Add `compareCodePoints(a, b)` to `packages/quereus/src/util/comparison.ts`, documented as
  "the order a memcmp of the UTF-8 encodings produces", with the surrogate-rank reasoning in
  the doc comment. Keep the fast path for surrogate-free strings.
- Route `BINARY_COLLATION`, `NOCASE_COLLATION`, and `RTRIM_COLLATION` through it. RTRIM
  needs a bounded variant (compare `a[0..lenA)` against `b[0..lenB)`); prefer a shared
  bounded helper over duplicating the scan.
- Route `compareSameType`'s `StorageClass.OBJECT` branch through it.
- Route `deepCompareJson`'s string-leaf and object-key comparisons
  (`packages/quereus/src/types/json-type.ts`) through it.
- Add a `NOTE:` at `canonicalJsonString`'s `Object.keys(obj).sort()` recording that its
  order needs only determinism, and that changing it would rewrite stored object-key bytes.

**Phase 2 — the assertions the fix makes true**

- `packages/quereus/src/core/database.ts`: rewrite the built-in-registration comment
  (~L400-415) — the comparators no longer compare with `<`/`>`, they compare by code point,
  which *is* the memcmp order of the normalized forms. Delete the NOTE at ~L1364 that
  records this bug (keep the surrounding re-registration guidance), replacing it with a
  one-line statement of the unpaired-surrogate carve-out and the ticket that owns it.
- `packages/quereus/test/collation-normalizer.spec.ts`: extend `CORPUS` with astral and
  near-boundary characters — at minimum `U+1F600` (😀), `U+10000`, `U+10FFFF`, `U+FF21` (Ａ),
  `U+E000`, `U+F900`, `U+FFFD`, `U+D7FF`, and combinations with an ASCII neighbour
  (`'x😀'`, `'😀x'`). Replace the comment explaining astral absence with one explaining the
  *unpaired-surrogate* absence. Both the equality probe and the `orderPreserving` property
  test must pass unchanged.

**Phase 3 — the oracle**

- New spec beside `packages/quereus-store/test/collation-order-preserving.spec.ts` (e.g.
  `astral-text-keys.spec.ts`), using its `createInMemoryProvider` / `column` / `planOps`
  helpers. Assert store output equals memory output for: `order by <text pk>`, `k < 'Ａ'`,
  the same two over a secondary index on a text column, and the `any`-typed JSON primary key
  above. Assert the plan **still** contains an `IndexSeek` and **still** elides the `Sort` —
  otherwise a future regression that silently retracts the stamp would pass the row checks.
- Cover `NOCASE` and `RTRIM` primary keys with astral text, not just `BINARY`.

**Phase 4 — sweep and validate**

- Sweep for other UTF-16-vs-UTF-8 comparisons that feed or read store bytes:
  `grep -rn "a < b ? -1\|strA < strB\|localeCompare" packages/*/src`. Known hits beyond the
  above: `packages/quereus-store/src/common/memory-store.ts` `compareHex` uses
  `localeCompare` to order hex-encoded keys. Its alphabet is `[0-9a-f]`, for which ICU and
  `memcmp` coincide, so it is not a defect today — record it as a `NOTE:` tripwire at the
  function ("locale collation only coincides with memcmp because the alphabet is hex; a
  wider alphabet here would silently mis-order the test oracle"), not as a ticket.
- Check `packages/quereus-sync` for any place that compares engine-sorted text against
  store-sorted bytes.
- `yarn lint && yarn test` from the repo root, then `yarn test:store` (store path).
