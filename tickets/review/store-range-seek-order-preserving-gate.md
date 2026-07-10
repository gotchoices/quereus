---
description: Applications can teach the database its own rule for sorting text. If that rule disagrees with how the stored bytes sort, persistent-store tables used to silently skip rows in range queries and return rows in the wrong order. Applications can now promise their rule agrees with byte order, and without that promise the store falls back to a safe full scan.
files:
  - packages/quereus/src/core/database.ts                          # collations map entry, registerCollation options, built-in stamps, _isCollationOrderPreserving, UTF-16 tripwire NOTE
  - packages/quereus/src/core/database-internal.ts                 # DatabaseInternal._isCollationOrderPreserving (stripInternal hides it from Database's .d.ts)
  - packages/quereus-store/src/common/store-table.ts               # keyOrderMatchesCollation, pkOrderPreservingPrefixLength, leadingPkRangeIsOrderSafe, indexRangeIsOrderSafe
  - packages/quereus-store/src/common/store-module.ts              # db plumbed through computeBestAccessPlan; range-vs-eq split in tryIndexAccessPlan; buildPkOrderingAdvertisement truncation
  - packages/quereus-store/test/collation-order-preserving.spec.ts # new, 13 tests
  - packages/quereus/test/collation-normalizer.spec.ts             # new `orderPreserving assertion` describe block
  - docs/store.md                                                  # § Order preservation (new), Built-in Collations table
  - docs/usage.md                                                  # db.registerCollation options object
difficulty: hard
---

# Order-preservation gate on store range seeks and PK-order advertisements

## What the bug was

A **collation** is an application-supplied rule for comparing strings, registered with
`db.registerCollation(name, comparator, { normalizer })`. The comparator answers "which
string sorts first"; the normalizer rewrites a string into a canonical form so that two
strings the comparator calls *equal* rewrite identically.

The persistent store (`using store`, plus the LevelDB / IndexedDB plugins on top of it)
writes each text value's **normalized** form into its key bytes and physically orders rows
by raw byte comparison of those bytes. `registerCollation` promised only that the
normalizer agrees with the comparator about **equality** — never about **order**. Three
store decisions assumed order anyway:

1. the primary-key byte-range window (`StoreTable.analyzePKAccess` → `buildPKRangeBounds`),
2. the secondary-index byte-range window (`StoreTable.analyzeIndexAccess`),
3. the PK-order advertisement (`StoreModule.buildPkOrderingAdvertisement`), whose
   `providesOrdering` lets the optimizer drop the Sort above `order by <pk>`.

Under a normalizer that preserved equality but not order, (1) and (2) silently dropped rows
and (3) returned them in byte order.

## What was built

**Engine** — `orderPreserving` is now an assertable collation property, mirroring the
existing `replicable` one exactly:

- `registerCollation(name, comparator, { normalizer, replicable, orderPreserving })`.
  Both booleans default to `false`; the legacy positional-normalizer third argument also
  yields `false` (correctness over speed). The three built-ins are stamped `true`.
- `Database._isCollationOrderPreserving(name)` reads it back. It returns `false` for an
  unregistered name, and — deliberately — for a collation that asserted `orderPreserving`
  without supplying a normalizer, since the assertion is *about* the normalizer.
- **Note for reviewers:** the accessor also had to be declared on the `DatabaseInternal`
  interface (`database-internal.ts`). The ticket did not anticipate this. `packages/quereus`
  compiles its `.d.ts` with `stripInternal: true`, so an `@internal`-tagged method on the
  `Database` class is invisible to the store package; `_isCollationReplicable` never crossed
  a package boundary, so this was the first time it mattered. The store calls it through
  `(db as DatabaseInternal)`, matching how it reaches `_findRowTimeCoveringStructure` etc.

The assertion's precise meaning, stated in the doc comment: *for all strings `x`, `y`,
`sign(comparator(x, y))` equals `sign(memcmp(utf8(normalizer(x)), utf8(normalizer(y))))`.*

**Store** — one shared predicate, consulted on both the "mark the filter handled" side
(`StoreModule`) and the "build a byte window" side (`StoreTable`), so the two can never
disagree:

```ts
// store-table.ts, exported
keyOrderMatchesCollation(db, column, keyCollation, compareCollation): boolean
//   non-text column                      → true  (type-native bytes)
//   compareCollation !== keyCollation    → false
//   else db._isCollationOrderPreserving(keyCollation)

pkOrderPreservingPrefixLength(db, schema, pkKeyCollations, tableKeyCollation): number
//   how many LEADING pk members pass the predicate
```

- **PK range** — `analyzePKAccess` returns `{ type: 'scan' }` when the leading PK column
  fails; `computeBestAccessPlan`'s `hasLeadingPkRange` arm declines under the same
  condition, falling through to the all-false-`handledFilters` full-scan plan.
- **Secondary-index range** — `analyzeIndexAccess` returns `null` for the range arm;
  `tryIndexAccessPlan` returns its `costOnly(...)` plan. The EQ/prefix arm is untouched on
  both sides (its coarser-`K` relaxation is sound for equality).
- **PK ordering advertisement** — `buildPkOrderingAdvertisement` truncates `pkOrdering` at
  the first failing PK member, and returns `{}` (no `providesOrdering`, no `monotonicOn`,
  no `supportsAsofRight`) when the leading member fails. `db` is now plumbed
  `getBestAccessPlan` → `computeBestAccessPlan` → `tryIndexAccessPlan` /
  `buildPkOrderingAdvertisement` (it was `_db` before).

## Behavior changes a reviewer should sanity-check

Two shapes lose an optimization. Both were **returning wrong rows before**, so this is a
correctness fix that costs speed, not a pure regression — but both are worth confirming
against real workloads:

- **Index range seek on a plain (BINARY) text column of a default-`K` (NOCASE) store
  table.** The range arm now requires `C === K`, not merely `K` coarser than `C`. Built-in
  counter-example, live today with no custom collation at all: `'K'` (U+212A KELVIN SIGN)
  is `> 'z'` under BINARY, yet its index bytes are `toLowerCase('K') = 'k'`, which sorts
  *before* `'z'` — the row fell outside the seek window and was dropped. Such a table now
  full-scans for ranges (equality seeks unchanged). Declaring the column `collate nocase`
  restores the seek. `backlog/debt-store-index-keys-use-column-collation` fixes it properly
  by encoding index-column bytes under `C`.
- **`any` / `json` primary-key columns.** `resolvePkKeyCollations` leaves them `undefined`
  (no `isTextual` marker), so their key bytes fall back to `K = NOCASE` while the engine
  compares them under BINARY. They now lose their PK range seek *and* their PK-order
  advertisement. Same class of dropped-row bug (`'B'` keys as `'b'`); covered by a new test.

## Use cases for testing / validation

New `packages/quereus-store/test/collation-order-preserving.spec.ts` (13 tests). The probe
collation is a legal registration today — `NOCASE` may be overridden, only `BINARY` is
protected — whose normalizer matches its comparator's equality classes exactly but whose
comparator orders **shorter strings first**, which byte order does not:

```ts
const lower = (s: string) => s.toLowerCase();
db.registerCollation('NOCASE',
  (a, b) => a.length !== b.length ? a.length - b.length
    : (lower(a) < lower(b) ? -1 : lower(a) > lower(b) ? 1 : 0),
  { normalizer: lower });
```

With rows `('aa'), ('b')` — comparator says `'aa' > 'b'`, key bytes say `'aa' < 'b'`:

| query | before | now |
|---|---|---|
| `select k from t where k > 'b'` (text PK) | `[]` | `['aa']`, no seek in plan |
| `select id from t where k > 'b'` (index on text `k`) | `[]` | `[1]`, no seek in plan |
| `select k from t order by k` | `['aa','b']` | `['b','aa']`, Sort retained |
| `select v from t where k = 'B'` (point seek) | found | found (equality path untouched) |

A memory-table control asserts the same rows for all of the above. The positive half
registers an order-preserving `stripSpaces` / `noSpace` pair with `{ orderPreserving: true }`
and asserts the PK seek is kept (`planOps` matches `INDEXSEEK`) and the Sort elided; the
*same* pair registered without the flag returns identical rows through the scan path.

The `shapes the gate must leave alone` block pins the shapes that must not regress: integer
PK range seek, built-in-NOCASE text PK range seek, coarser-`K` equality index seek.

**Mutation-checked**: with `keyOrderMatchesCollation` forced to return `true`, 7 of the 13
tests fail (all three failure modes plus the two coarser-`K` cases). The assertions are
two-sided — every `not.match(SEEK)` has a `match(SEEK)` twin in the same file.

Engine-side, `packages/quereus/test/collation-normalizer.spec.ts` gains an
`orderPreserving assertion` block: built-ins report `true`; a custom collation defaults to
`false` in both the options and legacy positional forms; the options form honours `true`;
overriding a built-in name drops the built-in's assertion; the flag is independent of
`replicable`; and a property test checks each built-in comparator against UTF-8 memcmp of
its normalized forms over the existing shared corpus.

## Validation run

- `yarn build` — clean.
- `yarn test` — all workspaces green (quereus 6785 passing / 9 pending; quereus-store 850).
- `yarn lint` — clean.
- `yarn test:store` — 6779 passing / 15 pending (LevelDB-backed logic suite; run because
  this ticket changes store plan shapes).

## Known gaps — treat the tests as a floor

- **`pkOrderPreservingPrefixLength`'s truncation path is untested.** Every test either passes
  at the leading member (full advertisement) or fails at it (empty advertisement). A composite
  PK whose *second* member is unsafe — e.g. `primary key (id, v)` with `v any` — would exercise
  the `pkOrdering.slice(0, n)` branch and the `required.length > pkOrdering.length` guard. I
  believe both are right by inspection; nothing proves it.
- **`supportsAsofRight` is dropped wholesale** when the leading PK member fails, per the
  ticket. Whether asof-join actually needs comparator order on the leading column (rather
  than merely a consistent total order) was not re-derived from `rule-asof-scan`; the
  conservative choice was taken. If it only needs monotonicity, this over-declines.
- **`monotonicOn` is still advertised on a truncated prefix.** It names only the leading PK
  column, which passed the predicate — sound as far as I can tell, but it is an asymmetry
  worth a second pair of eyes: `providesOrdering` shrinks while `monotonicOn` does not.
- **The `K`-vs-`C` equality relaxation was left exactly as it was**, including the
  `K === 'NOCASE' && C === 'BINARY'` special case, which only reasons about built-in names.
  A custom `K` that is genuinely coarser than a custom `C` still falls through to the scan.
  That is pre-existing and documented in the guard's doc comment.
- **No test drives the LevelDB / IndexedDB plugins directly.** The gate lives in the shared
  `quereus-store` layer, so `test:store` covers it transitively, but no plugin-level test
  registers a non-order-preserving collation.

## Review findings

- **Tripwire recorded, not filed:** the `orderPreserving` assertion is stated against UTF-8
  memcmp, but the three built-in comparators use JS `<`/`>`, i.e. UTF-16 **code-unit** order.
  The two disagree for astral-plane characters (a surrogate pair sorts below `U+E000`–`U+FFFF`
  in UTF-16 but above them in UTF-8), so a store range seek over text mixing an astral
  character with a `U+E000`–`U+FFFF` character can still mis-window — including under
  `BINARY`. Pre-existing, orthogonal, and left as a `NOTE:` on `Database.registerCollation`
  in `packages/quereus/src/core/database.ts` (just above the method, alongside the existing
  non-retroactivity NOTE). Per the ticket: recorded, not fixed, not ticketed. The engine test
  corpus is deliberately free of astral characters, which the test comments say out loud.
