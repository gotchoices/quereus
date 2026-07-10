---
description: Applications can teach the database their own rule for sorting text. If that rule sorts text differently from how the stored bytes sort, persistent-store tables silently skip rows in range queries and return rows in the wrong order. Add a way for an application to promise its rule agrees with byte order, and make the store fall back to a safe scan when it has no such promise.
files:
  - packages/quereus/src/core/database.ts                    # collations map entry, registerCollation options, registerDefaultCollations, new _isCollationOrderPreserving
  - packages/quereus-store/src/common/store-table.ts         # analyzePKAccess, buildPKRangeBounds, analyzeIndexAccess, resolvePkKeyCollations, columnCanHoldText
  - packages/quereus-store/src/common/store-module.ts        # getBestAccessPlan/computeBestAccessPlan, tryIndexAccessPlan → safeToHandle, buildPkOrderingAdvertisement
  - packages/quereus-store/test/pushdown.spec.ts             # existing seek plan-shape assertions (must stay green)
  - packages/quereus-store/test/custom-collation-key.spec.ts # existing overridden-collation key tests (must stay green)
  - docs/store.md                                            # § Collation Support
  - docs/usage.md                                            # db.registerCollation surface
difficulty: hard
---

# Range seeks and PK-order advertisements over a text key assume an order-preserving normalizer

## Background in plain terms

A **collation** is a rule for comparing two strings. An application supplies one with
`db.registerCollation(name, comparator, { normalizer })`:

- the **comparator** answers "which of these two strings sorts first?";
- the **normalizer** rewrites a string into a canonical form, so that two strings the
  comparator calls *equal* always rewrite to the *same* form.

The persistent store (`using store`, and the LevelDB / IndexedDB plugins built on it)
writes each text value's **normalized** form into its key bytes, and physically orders
rows by raw byte comparison of those bytes.

`registerCollation` promises only that the normalizer agrees with the comparator about
**equality**. It says nothing about **order**. The store assumes order in three places.

## What was reproduced

Repro collation (a legal registration today — `NOCASE` may be overridden; only `BINARY`
is protected):

```ts
// Equal iff lowercase-equal — matches the normalizer's partition exactly.
// But orders SHORTER strings first, which byte order does not.
const lower = (s: string) => s.toLowerCase();
db.registerCollation('NOCASE',
  (a, b) => a.length !== b.length ? a.length - b.length
    : (lower(a) < lower(b) ? -1 : lower(a) > lower(b) ? 1 : 0),
  { normalizer: lower });
```

Rows `('aa'), ('b')`. The comparator says `'aa' > 'b'`; the key bytes say `'aa' < 'b'`.
Against a memory table (the oracle — it orders by the comparator) every query below is
correct. Against `using store`:

| query | memory (correct) | store (observed) |
|---|---|---|
| `select k from t where k > 'b'` — text PK | `['aa']` | `[]` — row dropped |
| `select id from t where k > 'b'` — secondary index on text `k` | `[1]` | `[]` — row dropped |
| `select k from t order by k` | `['b','aa']` | `['aa','b']` — wrong order |

The third row of that table is **new information** relative to the original bug report:
the store advertises `providesOrdering` / `monotonicOn` for a PK scan
(`StoreModule.buildPkOrderingAdvertisement`) with no collation check at all, so the
optimizer elides the Sort and the caller receives byte-ordered rows. Same root cause: the
store equates byte order with comparator order.

Point (equality) seeks are unaffected — they need only the equality guarantee the
normalizer already provides.

## The fix: make order-preservation an assertable property

Mirror the existing `replicable` assertion exactly (same registration surface, same
"built-ins auto-qualify, custom opts in" shape, same `_is…` accessor).

### Engine

`packages/quereus/src/core/database.ts`:

- Widen the `collations` map entry to
  `{ comparator; normalizer?; replicable?; orderPreserving? }`.
- `registerCollation(name, func, optionsOrNormalizer)` — the options object gains
  `orderPreserving?: boolean`, default `false`. The legacy positional-normalizer form
  keeps `orderPreserving: false` (conservative: correctness over speed).
- `registerDefaultCollations()` stamps `orderPreserving: true` on `BINARY`, `NOCASE`,
  `RTRIM`, next to the existing `replicable: true` stamp.
- New public `_isCollationOrderPreserving(name: string): boolean`, alongside
  `_isCollationReplicable`. Normalize the name through `normalizeCollationName`. An
  unregistered name or a comparator-only collation returns `false` (defensive; the store
  already rejects a comparator-only key collation at DDL time).

Precise meaning of the assertion, to be stated in the doc comment: *for all strings
`x`, `y`: `sign(comparator(x, y))` equals `sign(memcmp(utf8(normalizer(x)), utf8(normalizer(y))))`.*
Order-preservation is a strictly stronger promise than the existing equality promise, and
`BINARY`'s identity normalizer makes it trivially true for `BINARY`.

### Store — one shared predicate, consulted on both sides

The store decides twice, and both decisions must agree or the bug reappears in a new
form:

- `StoreModule` decides whether to **mark the filter handled** (which drops the residual
  Filter), and whether to **advertise ordering**;
- `StoreTable` decides whether to **build a byte window** rather than full-scan.

If the module declines to handle but the table still windows, rows are still dropped. So
write the predicate once — an exported helper in `store-table.ts` alongside
`columnCanHoldText` — and call it from both:

```ts
/** True when a byte window / byte-order advertisement over `columnIndex` is sound. */
export function keyOrderMatchesCollation(
  db: Database,
  column: ColumnSchema | undefined,
  keyCollation: string,        // the collation whose normalizer produced the bytes
  compareCollation: string,    // the collation matchesFilters / the comparator uses
): boolean {
  if (!columnCanHoldText(column)) return true;          // type-native bytes
  if (compareCollation !== keyCollation) return false;  // see § K-vs-C below
  return db._isCollationOrderPreserving(keyCollation);
}
```

Call sites:

**PK range** — `StoreTable.analyzePKAccess` must return `{ type: 'scan' }` instead of
`{ type: 'range' }` when the leading PK column fails the predicate. Its key collation is
`this.pkKeyCollations[0] ?? K`; its comparison collation is the column's declared
collation, which for a text PK member is *the same name* (see `resolvePkKeyCollations`),
so the `K`-vs-`C` clause never bites on the PK path. Mirror-side:
`StoreModule.computeBestAccessPlan`'s `hasLeadingPkRange` arm must not claim the range
filters handled under the same condition — fall through to the full-scan plan with
`handledFilters` all-false.

**Secondary-index range** — `StoreTable.analyzeIndexAccess` must return `null` for the
range arm (the EQ/prefix arm stays) when the leading index column fails the predicate.
Its key collation is the table key collation `K` (`buildIndexKey` encodes index-column
bytes under `K`, not under the column's collation); its comparison collation is
`C = indexCol.collation ?? column.collation ?? 'BINARY'`. Mirror-side:
`StoreModule.tryIndexAccessPlan` must return its existing `costOnly(...)` plan for the
range arm under the same condition. Leave the EQ arm's `safeToHandle` exactly as it is.

**PK ordering advertisement** — `StoreModule.buildPkOrderingAdvertisement` must truncate
`pkOrdering` at the first PK member that fails the predicate, and return `{}` (no
`providesOrdering`, no `monotonicOn`, no `supportsAsofRight`) when the *leading* member
fails. `getBestAccessPlan` currently ignores its `_db` argument — plumb it through
`computeBestAccessPlan` → `tryIndexAccessPlan` / `buildPkOrderingAdvertisement`.
`StoreTable` reads `this.db` directly.

### § K-vs-C: why the range arm must require `C === K`, and what that costs

For the EQ/prefix arm, `tryIndexAccessPlan.safeToHandle` today admits `K` **coarser than**
`C` (concretely `K = NOCASE`, `C = BINARY`). That is sound for equality under *any*
normalizer: every row a `C`-equality matches normalizes to the bound's normalized form,
so it lies inside the window. Leave it alone.

For the range arm it is **not** sound, even with the built-in `NOCASE`. The window is
built from byte order of `K`-normalized forms while `matchesFilters` compares under `C`,
so soundness needs the `K` normalizer to be monotone with respect to `C`'s order — a
different and much stronger property than "`K` is order-preserving w.r.t. its own
comparator". Built-in counter-example, live today with no custom collation at all:

- `create table t (id integer primary key, v text) using store` (so `C = BINARY`,
  `K = NOCASE` — the store's default table key collation), `create index ix_v on t (v)`.
- Row `v = 'K'` (KELVIN SIGN). `'K' > 'z'` under BINARY, so it matches
  `where v > 'z'`.
- Its index bytes are `normalize_NOCASE('K') = 'k'`, which sorts *before* `'z'` — the
  row is outside the seek window and is dropped.

Requiring `C === K` for the range arm closes that hole too. **Cost:** a store table with
the default `K = NOCASE` and an index on a plain (BINARY) text column loses its index
*range* seek and falls back to the existing cost-only plan (full scan + residual —
correct, just not sped up). EQ seeks on that shape are unchanged. No existing test asserts
the lost plan shape (the text-range index tests in `pushdown.spec.ts` declare the column
`collate nocase`, so `C === K`); `packages/quereus-store/test/pushdown.spec.ts` around the
`text range bounds on a … NOCASE index column` cases is the place to confirm. The follow-up
`backlog/debt-store-index-keys-use-column-collation` restores that seek properly.

## Tripwire to record, not fix

The order-preservation assertion compares `sign(comparator(x,y))` against UTF-8 memcmp of
the normalized forms. The three built-in comparators use JS `<`/`>` on strings, which is
UTF-16 **code-unit** order, while UTF-8 memcmp is **code-point** order. The two disagree
for astral-plane characters (a surrogate pair, `0xD800`–`0xDFFF`, sorts below `U+E000`–
`U+FFFF` in UTF-16 but above them in UTF-8). So a store range seek over text containing
both an astral character and a `U+E000`–`U+FFFF` character can still mis-window. This is
pre-existing, orthogonal to this ticket, and affects `BINARY` too. Record it as a `NOTE:`
comment at `Database.registerCollation`'s `orderPreserving` doc and move on — do **not**
file a ticket, and do **not** try to fix it here.

## Tests

New `packages/quereus-store/test/collation-order-preserving.spec.ts`, modelled on
`custom-collation-key.spec.ts` (same `createInMemoryProvider` helper). Under the
length-first `NOCASE` override above:

- `select k from t where k > 'b'` over a text PK returns `['aa']` (comparator order), and
  the plan shows no index seek.
- `select id from t where k > 'b'` over a secondary index on a `collate nocase` text
  column returns `[1]`, no index seek.
- `select k from t order by k` returns `['b','aa']` — the Sort is retained.
- A point seek `where k = 'B'` still finds the row (equality path untouched).
- A memory-table control produces the same rows for all of the above.

Then the positive half: register a normalizer that *is* order-preserving (e.g.
`stripSpaces` / `noSpace` from `custom-collation-key.spec.ts`) with
`{ normalizer, orderPreserving: true }` and assert the PK range still uses the seek
(`planOps(q)` matches `INDEXSEEK`, following `pushdown.spec.ts`'s `planOps` helper) and
returns the right rows. Also assert that the *same* pair registered without
`orderPreserving` returns identical rows via the scan path — the gate must cost
performance, never correctness.

Engine-side, extend the existing collation tests (`packages/quereus/test/` — look for the
`registerCollation` boundary-validation and `materialized-view-replicable.spec.ts` shapes):
built-ins report `orderPreserving`; a custom collation defaults to `false`; the legacy
positional-normalizer form defaults to `false`; the options form honours `true`.

## Docs

- `docs/store.md` § Collation Support: replace the closing paragraph (which currently
  points at `backlog/bug-store-range-seek-assumes-order-preserving-key-normalizer`) with
  the guarantee as built. State that a range/prefix seek requires an `orderPreserving`
  collation *and* `C === K` on the index path, that the built-ins carry the assertion, and
  that a collation without it degrades to a full scan rather than dropping rows. Update the
  `Custom` row of the Built-in Collations table.
- `docs/usage.md`: document `orderPreserving` on the `registerCollation` options object.
- Remove the `Tracked by …` pointers in the `NOTE:` on `StoreTable.buildPKRangeBounds` and
  the `NOTE:` above `StoreModule.tryIndexAccessPlan`, replacing them with a statement of
  the enforced guarantee.

## TODO

- [ ] `database.ts`: `orderPreserving` on the collations map entry, on the
      `registerCollation` options object, stamped `true` on the three built-ins; add
      `_isCollationOrderPreserving`.
- [ ] `database.ts`: `NOTE:` comment recording the UTF-16-vs-UTF-8 ordering tripwire.
- [ ] `store-table.ts`: export `keyOrderMatchesCollation`; gate `analyzePKAccess`'s range
      arm and `analyzeIndexAccess`'s range arm on it.
- [ ] `store-module.ts`: plumb `db` through `computeBestAccessPlan`; gate the
      `hasLeadingPkRange` handled-claim, `tryIndexAccessPlan`'s range arm (require
      `C === K` there, EQ arm unchanged), and `buildPkOrderingAdvertisement`.
- [ ] New `packages/quereus-store/test/collation-order-preserving.spec.ts` covering all
      three failure modes plus the positive `orderPreserving: true` path.
- [ ] Engine tests for the new registration option and accessor.
- [ ] `docs/store.md`, `docs/usage.md`, and the two in-code `NOTE:` comments.
- [ ] `yarn build`, `yarn test`, `yarn lint`. `yarn test:store` if time allows (slower;
      it re-runs the engine logic suite against the LevelDB store module, and this ticket
      changes store plan shapes).
