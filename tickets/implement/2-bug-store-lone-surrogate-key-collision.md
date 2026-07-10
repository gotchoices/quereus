---
description: Two different text values can collide onto the same storage key when they contain a broken half-character, so a persistent-store table wrongly reports a duplicate-key error (or overwrites an unrelated row) where an in-memory table stores both values fine.
prereq: bug-collations-compare-by-code-point
files:
  - packages/quereus-store/src/common/encoding.ts                  # encodeText — `new TextEncoder().encode(...)` silently substitutes U+FFFD
  - packages/quereus/src/util/comparison.ts                        # compareCodePoints — the comparator that must stay consistent with whatever encodeText does
  - packages/quereus/test/collation-normalizer.spec.ts             # the corpus that must exclude unpaired surrogates until this lands
  - packages/quereus-store/test/encoding.spec.ts                   # where the encoder's own unit tests live
difficulty: medium
---

# Store text keys are not injective over unpaired surrogates

## What is wrong

A JavaScript string is a sequence of 16-bit code units, not of Unicode characters. A
character above `U+FFFF` is stored as two units — a *surrogate pair*. A string may also
contain a **lone** (unpaired) surrogate: a half of a pair with no matching other half.
That is a legal JavaScript string and a legal Quereus `text` value, but it is not valid
Unicode: there is no character it denotes, and no UTF-8 byte sequence encodes it.

`encodeText` (`packages/quereus-store/src/common/encoding.ts`) produces a row's storage key
via `new TextEncoder().encode(...)`, which silently replaces **every** unpaired surrogate
with the replacement character `U+FFFD` (bytes `EF BF BD`). All 2048 distinct lone
surrogates therefore encode to the same three bytes. Distinct values collide onto one key.

## Reproduction (confirmed against HEAD)

```sql
create table s  (k text primary key, v text) using store;
create table ms (k text primary key, v text);                 -- memory oracle

insert into s  values ('\uD800', 'one'), ('\uD801', 'two');   -- ConstraintError: UNIQUE constraint failed: s PK
insert into ms values ('\uD800', 'one'), ('\uD801', 'two');   -- both rows stored
```

A spurious `UNIQUE` error is the visible half. The invisible half is worse: the same
collision applies to secondary-index keys, and an `insert or replace` / upsert keyed on a
lone surrogate will overwrite a row that holds a *different* value.

Note the JSON/object key path is **not** affected: `encodeObject` encodes
`JSON.stringify`'s output, and `JSON.stringify` (well-formed since ES2019) escapes a lone
surrogate to the seven ASCII characters `\ud800`. Only `encodeText` loses information.

## Why it cannot be fixed by the comparator

`bug-collations-compare-by-code-point` makes the built-in comparators agree with `memcmp`
of the key bytes for well-formed strings. It cannot do so here: the key bytes for
`'\uD800'` and `'\uD801'` are *identical*, so no comparator that calls those two strings
distinct can agree with them. The encoder has to change, not the comparator. That is why
this is a separate ticket, and why the property test's corpus in the prereq must stay free
of unpaired surrogates until this lands.

## The two options, and the recommendation

**Recommended — reject unpaired surrogates at store-key encode time.** Scan for an
unpaired surrogate in `encodeText` and throw a `QuereusError` naming the column value as
not representable in persistent storage. Rationale: the value is not valid Unicode, no
persistent format represents it, and merging two rows into one is the worst possible
answer. A loud error at insert time is cheap to understand and impossible to miss. The
cost is a memory-vs-store behaviour divergence — the memory table keeps accepting the
value — which should be stated plainly in the error message and in the encoding module's
doc comment. Detection is a scan for a high surrogate not followed by a low surrogate, or
a low surrogate not preceded by a high one, and it only needs to run on the (already
scanned) normalized string; the fast path is a `/[\uD800-\uDFFF]/` test that virtually
every real string fails immediately.

**Alternative — WTF-8 encode.** Emit a lone surrogate as its own three-byte `ED A0 80`–
`ED BF BF` sequence instead of `U+FFFD`. This keeps every string storable and keeps the
bytes injective. It is strictly more work and it changes the comparator's obligations: a
lone surrogate would then sort at its scalar value (`U+D800`–`U+DFFF`, i.e. between
`U+D7FF` and `U+E000`), which the prereq's `rank()` — which lifts *every* high surrogate
above `U+FFFF` — gets wrong. Taking this option means making `compareCodePoints`
pairing-aware, and it means `decodeText` can no longer use `TextDecoder` (which rejects
WTF-8). Only take it if a caller genuinely needs to persist ill-formed text.

Whichever is taken, the `orderPreserving` contract on the built-ins must end up actually
true for every value the store accepts.

## TODO

- Add a lone-surrogate detector to `packages/quereus-store/src/common/encoding.ts`, guarded
  by a cheap `/[\uD800-\uDFFF]/` pre-test so well-formed strings pay ~nothing.
- Throw a `QuereusError` (`StatusCode.ERROR`, or `CONSTRAINT` if it reads better at the
  call site) from `encodeText` on an unpaired surrogate. Message must say what was wrong
  (a text value contains an unpaired surrogate), that persistent storage cannot represent
  it, and that memory tables can.
- Confirm the throw surfaces cleanly from `insert`, `update`, secondary-index maintenance,
  and a range-seek bound built from a literal — a bound that cannot be encoded must not be
  silently widened or narrowed.
- `encodeObject` is unaffected (`JSON.stringify` escapes lone surrogates to ASCII). Add a
  one-line `NOTE:` at `encodeObject` recording *why*, so a future change to the
  canonicalizer does not quietly remove the escaping.
- Extend `packages/quereus-store/test/encoding.spec.ts`: distinct lone surrogates must not
  encode to equal bytes (they now throw); a well-formed astral character must round-trip.
- Add a store-vs-memory spec asserting the store raises a clear, ticket-named error rather
  than a `UNIQUE` violation, and that the memory table still accepts both values.
- Update `packages/quereus/test/collation-normalizer.spec.ts`: the comment excluding
  unpaired surrogates from `CORPUS` should now say they are *rejected by the store*, not
  that they are unfixable, and name this ticket's outcome.
- `yarn lint && yarn test`, then `yarn test:store`.
