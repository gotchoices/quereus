---
description: Text containing emoji used to sort one way in memory tables and another way in persistent-store tables, so store queries could return rows in the wrong order or silently drop them. The built-in string comparisons now order characters the same way the store's stored bytes do.
files:
  - packages/quereus/src/util/comparison.ts                        # NEW compareCodePoints + bounded variant; BINARY/NOCASE/RTRIM + OBJECT branch routed through it
  - packages/quereus/src/types/json-type.ts                        # deepCompareJson: string leaves, object keys, and the object-key SORT
  - packages/quereus/src/util/json-canonical.ts                    # NOTE: key sort stays code-unit (deliberate)
  - packages/quereus/src/index.ts                                  # compareCodePoints exported (public: custom collations need it)
  - packages/quereus/src/core/database.ts                          # registration comment (~L400) + rewritten NOTE (~L1364)
  - packages/quereus/test/collation-normalizer.spec.ts             # CORPUS now carries astral + surrogate-boundary characters
  - packages/quereus-store/test/astral-text-keys.spec.ts           # NEW store-vs-memory oracle spec (12 tests)
  - packages/quereus-store/src/common/memory-store.ts              # NOTE tripwire on compareHex/localeCompare
  - docs/store.md                                                  # built-in collation table + the "not actually true" footnote
---

# Built-in collations now order by Unicode code point

## What was wrong, in one paragraph

JavaScript's `<` / `>` on strings compares UTF-16 **code units**. The persistent store writes
each text key as UTF-8 bytes and physically orders rows by `memcmp` of those bytes, which is
**code-point** order. The two disagree above `U+FFFF`: an astral character (emoji, rarer CJK)
is stored in JS as a surrogate pair whose leading unit lies in `U+D800`–`U+DBFF`, so `<` sorts
it *below* everything in `U+E000`–`U+FFFF` (Private Use Area, CJK Compatibility Ideographs,
the Halfwidth/Fullwidth Forms), while its UTF-8 encoding (`F0…`) sorts *above* theirs (`EE…`,
`EF…`). All three built-in collations compared with `<` / `>` yet were stamped
`orderPreserving: true`, which the store trusts to (a) narrow a range predicate to a byte
window and *drop the residual filter*, and (b) advertise byte order so the planner elides the
`Sort`. Both were wrong for astral text: rows were silently dropped and `order by` emitted byte
order.

## What changed

**`compareCodePoints(a, b)`** (new, exported from `@quereus/quereus`) is the single primitive.
It fast-paths to V8's native string compare when neither operand contains a high surrogate
(then code-unit order *is* code-point order), and otherwise scans for the first differing code
unit and ranks it with high surrogates lifted above `U+FFFF` (`u + 0x2800`). No surrogate-pair
decoding is needed: at the first difference of two well-formed strings, either both units are
low surrogates or neither is.

Routed through it: `BINARY_COLLATION`, `NOCASE_COLLATION` (on the lowercased forms),
`RTRIM_COLLATION` (via a bounded variant that compares the untrimmed strings up to their
trimmed lengths), `compareSameType`'s `StorageClass.OBJECT` branch (two canonical JSON
strings — this is what an `any` primary key sorts under), and `deepCompareJson`'s string
leaves and object keys.

**Deliberately unchanged:** `canonicalJsonString`'s `Object.keys().sort()` stays on the default
code-unit sort. That order needs only determinism — both the byte encoder and the comparison
string run through the same canonicalizer — and changing it would rewrite the stored key bytes
of every persisted object whose keys contain astral characters. A `NOTE:` at the call site says
so.

**This changes the engine's observable sort order for astral text**, in memory tables too. That
is the point: `'Ａ'` (U+FF21) now sorts before `'😀'` (U+1F600), matching UTF-8 bytes and
matching what SQLite's `BINARY` produces. All 6785 engine tests and 6779 store-mode tests pass
unchanged, so nothing in the suite depended on the old order.

## How to validate

```
yarn lint && yarn test          # 6785 quereus + 872 quereus-store + rest; all pass
yarn test:store                 # 6779 passing, 15 pending — LevelDB-backed logic tests
```

Targeted:

```
node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js \
  "packages/quereus/test/collation-normalizer.spec.ts"          # 24 passing
node --import ./packages/quereus-store/register.mjs node_modules/mocha/bin/mocha.js \
  "packages/quereus-store/test/astral-text-keys.spec.ts"        # 12 passing
```

### The two properties the tests pin

1. **`collation-normalizer.spec.ts`** — for every ordered pair in `CORPUS`,
   `sign(comparator(a,b)) === sign(memcmp(utf8(normalizer(a)), utf8(normalizer(b))))`, for each
   of BINARY / NOCASE / RTRIM. `CORPUS` now carries `U+1F600`, `U+10000`, `U+10FFFF`, the
   Deseret case pair `U+10400`/`U+10428`, and the BMP neighbours that straddle the surrogate
   range (`U+D7FF`, `U+E000`, `U+F900`, `U+FF21`, `U+FF41`, `U+FFFD`), plus ASCII/astral mixes.
   *This test has teeth:* reverting any built-in to `<`/`>` fails it.

2. **`astral-text-keys.spec.ts`** — a store table and a memory table built from the same DDL and
   the same rows must return the same rows in the same order, AND the plan must still contain
   its `IndexSeek` / still elide its `Sort`. The plan assertions matter: a future regression that
   fixed the rows by silently retracting the `orderPreserving` stamp would pass the row checks
   alone. Covered: BINARY text PK (`order by k`, `k < 'Ａ'`, `k > 'z'`, point seek), a secondary
   index over a NOCASE text column, a NOCASE PK (including astral case-folding on a point seek),
   an RTRIM PK, and an `any` PK holding JSON arrays.

Verified the spec fails against the pre-fix build: 11 of its 12 tests failed before
`compareCodePoints` landed.

### Manual repro that used to fail

```sql
create table t (k text collate binary primary key) using store;
create table m (k text collate binary primary key);
insert into t values ('😀'), ('Ａ');
insert into m values ('😀'), ('Ａ');
select k from t order by k;   -- now ['Ａ','😀'] in BOTH; was ['Ａ','😀'] vs ['😀','Ａ']
select k from t where k < 'Ａ';  -- now [] in BOTH; store used to drop the emoji row silently
```

## Performance

`BINARY` is the engine's hottest comparator, so the shape was measured rather than assumed
(microbench, 500-key corpora, ns per comparison):

| shape | short ASCII | 40-char common prefix |
|---|---|---|
| native `<` (old, wrong) | 5.8 | 8.0 |
| **guard + native fast path (shipped)** | **21.5** | **23.7** |
| unconditional per-unit scan | 17.3 | 109.4 |

The regex guard costs a flat ~15 ns and keeps the long-common-prefix case on V8's memcmp; the
naive "just always scan" shape is ~6x worse there. Correctness was checked exhaustively:
115,600 pairs over a mixed corpus, **0** disagreements with `memcmp(utf8(·))` (the old `<`
comparator disagrees on 16,680 of them).

**Gap:** no engine-level benchmark was run. `packages/quereus` has `yarn bench`; a reviewer who
wants a real-workload number should run it before/after. A 3x regression on a ~6 ns operation is
unlikely to show, but it was not measured.

## Known gaps and things a reviewer should look at

- **`deepCompareJson`'s object-key sort changed** from `Object.keys().sort()` to
  `.sort(compareCodePoints)`. Required for soundness — sorting by code unit and then *comparing*
  the sorted sequences by code point is not a total order — but it means `JSON_TYPE.compare` can
  now order two objects *with different key sets containing astral keys* differently than before.
  Equality classes are unaffected (same key set ⇒ same sorted sequence under any total order).
  **Not covered by a test.**
- **`JSON_TYPE.compare` (deepCompareJson) and `compareSameType`'s OBJECT branch never agreed on
  *order*, only on equality** — one compares key lists then values, the other compares JSON
  syntax strings with braces and quotes. Moving both to code point does not change that. If the
  reviewer believes they *should* agree on order, that is a separate ticket.
- **No direct unit test for `compareCodePoints` itself**, nor for `deepCompareJson` with astral
  string leaves / object keys. Coverage is via the BINARY property test and the store oracle's
  `any`-PK `order by`.
- **Unpaired surrogates are out of scope and untested here.** They have no UTF-8 encoding
  (`TextEncoder` folds each to `U+FFFD`), so no comparator can be order-preserving over them and
  the store's text keys are not injective — `bug-store-lone-surrogate-key-collision`
  (`tickets/implement/2-…`) owns that, and it depends on this. The corpus comment names it.
- **`agreesWithMemory` in the new spec rewrites `\bt\b` → `m`** to derive the memory query from
  the store query. Brittle if a future test adds a query with another bare `t` token.
- **`docs/store.md` (~L606) is stale about `any` / `json` PKs** — it still says their range seeks
  and PK-order advertisement are declined, which stopped being true when
  `bug-store-any-json-pk-keyed-under-table-collation` landed (that ticket is still in `review/`).
  Not touched here; flagging so it is not attributed to this change.

## Review findings — tripwires parked during implementation

- `packages/quereus-store/src/common/memory-store.ts` — `compareHex` orders the in-memory KV
  store's keys with `localeCompare` (ICU collation), which only coincides with `memcmp` of the
  key bytes because `keyToHex`'s alphabet is `[0-9a-f]`. Not a defect today; it *is* the oracle
  the whole store test suite compares against. Parked as a `NOTE:` at the function.
- `packages/quereus/src/util/json-canonical.ts` — the `Object.keys().sort()` that must stay on
  code-unit order, and why. Parked as a `NOTE:` at the call site.

Swept for other UTF-16-vs-UTF-8 comparisons that feed or read store bytes. `localeCompare` hits
in `planner/analysis/change-scope.ts`, `schema/lens-prover.ts`, `sync-coordinator`, and
`quoomb-web` all order names/identifiers for determinism or display, never key bytes.
`quereus-sync`'s `compareSiteIds` compares a `Uint8Array` (SiteId is 16 raw bytes), not text, so
`compareHLC` and the change-log key bytes are unaffected.
