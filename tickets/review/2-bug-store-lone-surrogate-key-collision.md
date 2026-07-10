---
description: A persistent table used to merge two different text values onto one storage key when they contained a broken half-character; it now refuses the value outright with a clear error instead of corrupting or wrongly rejecting rows.
files:
  - packages/quereus-store/src/common/encoding.ts             # the fix: findUnpairedSurrogate / assertEncodableText, called from encodeText
  - packages/quereus-store/src/common/key-builder.ts          # NOTE: at buildCatalogKey — identifiers are NOT guarded (backlog ticket filed)
  - packages/quereus-store/test/lone-surrogate-keys.spec.ts   # new store-vs-memory spec
  - packages/quereus-store/test/encoding.spec.ts              # new `unpaired surrogates` describe block
  - packages/quereus-store/test/astral-text-keys.spec.ts      # header comment updated (no longer "unfixable")
  - packages/quereus/src/util/comparison.ts                   # compareCodePoints doc comment updated
  - packages/quereus/test/collation-normalizer.spec.ts        # CORPUS exclusion comment updated
difficulty: medium
---

# Store text keys are now injective: unpaired surrogates are refused, not folded

## Background, in plain terms

A JavaScript string is a sequence of 16-bit code units, not of characters. Characters above
`U+FFFF` (emoji, Deseret, …) take two units — a *surrogate pair*. A string can also hold a
**lone** (unpaired) surrogate: one half of a pair with no partner. That is a legal
JavaScript string and a legal Quereus `text` value, but it is not valid Unicode: it denotes
no character, and no UTF-8 byte sequence encodes it.

The persistent store keys text rows by their UTF-8 bytes. `TextEncoder` silently replaces
*every* unpaired surrogate with `U+FFFD` (bytes `EF BF BD`), so all 2048 of them produced
the same key. Two distinct values landed on one row.

## What was chosen

The ticket offered two options; the recommended one was taken. **`encodeText` now rejects a
text value containing an unpaired surrogate** rather than encoding it. WTF-8 was not
implemented — it would have required making `compareCodePoints` pairing-aware and dropping
`TextDecoder` from `decodeText`, for the benefit of persisting values that are not valid
Unicode.

The consequence, stated plainly and deliberately: **a memory table accepts a lone-surrogate
text key; a store-backed table raises.** This is the one behavioural divergence, and it is
what makes the built-in collations' `orderPreserving` stamp actually true for every value a
store-backed table can hold.

## What changed

`packages/quereus-store/src/common/encoding.ts`:

- `HAS_SURROGATE` — a `/[\uD800-\uDFFF]/` pre-test. Virtually every real string fails it, so
  the pairing scan never runs on the hot path.
- `findUnpairedSurrogate(value)` — returns the offset of the first unpaired surrogate, or
  `-1`. Consumes well-formed high+low pairs; a low surrogate reached without a preceding
  high, or a high with no low after it, is unpaired.
- `assertEncodableText(sortValue)` — throws `QuereusError(StatusCode.ERROR)` naming the
  offending code unit and offset, saying persistent storage cannot represent it and that
  in-memory tables can.
- `encodeText` calls it, on the **normalized** string (the string actually encoded), so a
  custom key normalizer that slices through a surrogate pair cannot smuggle a lone half in.
- `encodeObject` deliberately has **no** guard — `canonicalJsonString` ends in
  `JSON.stringify`, which is well-formed (ES2019) and escapes a lone surrogate to the seven
  ASCII characters `\ud800`. A `NOTE:` records why, so a future canonicalizer change that
  drops the escaping doesn't quietly reintroduce the collision.

Doc-comment updates: `compareCodePoints` and both spec headers previously said "no
comparator can be order-preserving over unpaired surrogates" and pointed at this ticket as
unresolved. They now say the store closes the gap from the other side by refusing them.

## Use cases to exercise when reviewing

These are the behaviours the fix asserts. `packages/quereus-store/test/lone-surrogate-keys.spec.ts`
covers each; re-derive them rather than trusting the spec.

- `insert into <store table> values ('\uD800', …)` raises an error whose message contains
  "unpaired surrogate" and does **not** contain "UNIQUE". Previously the *second* such
  insert raised `UNIQUE constraint failed`, claiming two different values were one row.
- The same two values still insert as **two distinct rows** into a memory table. That is
  the oracle; it must not regress into a matching rejection.
- `update` moving a row onto a lone-surrogate key raises, and the row is untouched.
- `insert or replace` keyed on a lone surrogate raises rather than overwriting the row held
  by a *different* lone surrogate. This was the invisible half of the bug — silent data loss.
- A lone surrogate in an **indexed** column raises on insert and on update (secondary-index
  keys collided identically).
- A range-seek bound built from a lone-surrogate literal (`where k > '\uD800'`,
  `where k = '\uD800'`) raises. It must **not** be silently widened or narrowed — an
  unencodable bound has no faithful byte position.
- Rejection holds under BINARY, NOCASE and RTRIM key collations.
- Well-formed astral characters (`'\u{10000}'`, `'\u{1F600}'`, `'\u{10FFFF}'`) still encode,
  round-trip, and sort by code point. Nothing about astral support changed.
- A lone surrogate in a **non-key** text column stores and returns unchanged (row values go
  through `JSON.stringify`, which escapes it). The divergence is confined to keys.
- An `any` primary key holding JSON with a lone surrogate inside keys fine and stays
  distinct from a different lone surrogate — `encodeObject`'s escaping already handled it.

## Validation run

- `yarn test` — all workspace suites pass. `packages/quereus-store` alone: 897 passing.
- `yarn test:store` — 6793 passing, 15 pending (LevelDB-backed logic suite).
- `yarn lint` — clean.
- `yarn workspace @quereus/store run typecheck` — clean.

## Known gaps — please probe these

- **Store spec files are never typechecked.** `packages/quereus-store/tsconfig.json` has
  `exclude: ["test"]`, and the mocha runner uses Node's type-stripping, which does not
  typecheck. So `yarn lint` / `typecheck` would not catch signature drift in the new spec.
  Pre-existing, not introduced here. I typechecked the two touched spec files ad hoc with
  `tsc --noEmit` and they are clean.
- **Identifiers are still unguarded, and that is a real defect.** `buildCatalogKey` runs the
  qualified `schema.table` name straight through `TextEncoder`, so two tables whose quoted
  names differ only by a lone surrogate share one catalog entry and one loses its DDL on
  reopen. Filed as `bug-store-catalog-key-lone-surrogate-identifier-collision` in
  `backlog/`, with a `NOTE:` at the call site. I did **not** confirm the parser accepts a
  raw lone surrogate inside a quoted identifier — that check gates the ticket's priority.
- **Error offset is into the normalized string.** For BINARY (identity) it is the caller's
  own offset; for NOCASE it can shift if a character's lowercase form is a different number
  of code units (e.g. `'İ'`). The doc comment says so. If a reviewer thinks a user-facing
  offset must always be into the *input*, the scan would have to run twice (once before
  normalization for the message, once after for correctness) — I judged that not worth a
  second regex test on every text key encode.
- **`quereus-sync` has its own `TextEncoder` key paths** (`src/metadata/*.ts`). I spot-checked
  `keys.ts` — its `encode()` calls are on constant ASCII prefixes, not row values — but I did
  not audit `tombstones.ts` / `column-version.ts` end to end. Values carrying lone surrogates
  can no longer reach a store-backed table at all, so any collision there should now be
  unreachable rather than latent; worth a skeptical second look.
- **Performance claim is reasoned, not measured.** The guard adds one compiled-regex test per
  text key encode (~15 ns for short keys, by analogy with the `HAS_HIGH_SURROGATE` guard in
  `compareCodePoints`, which was measured). The O(n) pairing loop only runs on strings that
  actually contain a surrogate code unit. No benchmark was run for this ticket.
- **The `proves the collision the guard exists to prevent` test asserts on `TextEncoder`,
  not on our code.** It is deliberate — it pins the platform behaviour the whole fix rests
  on — but it is the one test in the block that would not fail if the guard were deleted.
  The others would.
