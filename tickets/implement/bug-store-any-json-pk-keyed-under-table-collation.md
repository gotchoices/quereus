---
description: In a persistent-store table, a primary key column declared with the flexible `any` or `json` type (or a date/time type) treats text case-insensitively when deciding whether two rows are the same row. Two rows whose keys differ only in letter case are wrongly treated as one — the second insert is rejected, and an "insert or replace" silently destroys the first row.
files:
  - packages/quereus-store/src/common/store-table.ts                     # resolvePkKeyCollations (the fix), validateKeyCollations (dead clause)
  - packages/quereus-store/src/common/encoding.ts                        # encodeValue: an undefined per-column collation falls back to options.collation
  - packages/quereus-store/src/common/store-module.ts                    # reconcilePkCollations (leave alone — see below)
  - packages/quereus-store/test/collation-order-preserving.spec.ts       # two tests encode the old behavior; invert/rewrite
  - packages/quereus-store/test/custom-collation-key.spec.ts             # one test's premise is removed by the fix
  - packages/quereus/src/util/comparison.ts                              # createTypedComparator — why the key collation must be BINARY
  - packages/quereus/src/types/builtin-types.ts                          # ANY_TYPE.compare is collation-blind
  - docs/schema.md                                                       # §"Per-column PK key collation" — the reader-facing rule
difficulty: medium
---

# `any` / `json` / temporal primary-key columns must be keyed under BINARY

## Root cause (confirmed)

The store enforces PRIMARY KEY uniqueness *physically*, in the key bytes. `resolvePkKeyCollations`
(`store-table.ts:124`) returns the per-column key collation for each PK member, and returns
`undefined` for any column whose logical type is not `isTextual`. Down in `encodeValue`
(`encoding.ts:93`) an `undefined` per-column collation is not "encode type-natively" — it means
*fall back to `options.collation`*, the table key collation K, which defaults to `NOCASE`.

So a text value in such a PK column gets `toLowerCase()` applied before it becomes key bytes,
while the engine compares that same column under `BINARY`. Uniqueness is enforced under NOCASE
and compared under BINARY.

## Reproduction (all four verified against HEAD)

```sql
create table t (k any primary key, v text) using store;
insert into t values ('A', 'upper');
insert into t values ('a', 'lower');            -- ConstraintError: UNIQUE constraint failed: t PK.

create table t (j json primary key, v text) using store;
insert into t values ('{"A":1}', 'upper');
insert into t values ('{"a":1}', 'lower');      -- ConstraintError: UNIQUE constraint failed: t PK.

-- UPDATE into a case-only-distinct key: same spurious rejection.
update t set k = 'a' where v = 'other';         -- ConstraintError

-- The DATA-LOSS direction the fix ticket asked about — it exists:
create table t (k any primary key, v text) using store;
insert into t values ('A', 'upper');
insert or replace into t values ('a', 'lower'); -- silently DESTROYS the row at 'A'
select count(*) from t;                         -- 1, should be 2
```

A memory table accepts both rows in every case. `insert or replace` is the serious one: no error,
one row gone.

## Blast radius is wider than the original ticket said

The bug is not confined to `any` and `json`. The predicate that matters is *text-capable but not
`isTextual`* — `logicalTypeCanHoldText(t) && !t.isTextual` — which is exactly:

| type | `physicalType` | `isTextual` | affected |
|---|---|---|---|
| `any` | `NULL` | — | yes |
| `json` | `OBJECT` | `false` | yes |
| `date`, `time`, `datetime`, `timespan` | `TEXT` | — | yes |

The temporal types store canonical ISO strings containing `T` and `Z`, which `toLowerCase()`
rewrites to `t` and `z`. Their canonical forms have fixed case, so no two distinct temporal
values ever collide — the *uniqueness* bug is unreachable for them. But their key bytes are
still wrong, and the read-side gate (below) has been declining every range seek on a `date`
primary key as a result. Fixing this restores that seek: verified that
`select v from t where d > '2024-03-01'` on a `date` PK goes from a full scan to an `INDEXSEEK`,
returning the same rows.

## The fix

In `resolvePkKeyCollations`, a text-capable-but-not-textual PK member must be keyed under
**hard-coded `BINARY`** — *not* under the column's declared collation:

```ts
return pkDef.map(def => {
    const col = columns[def.index];
    if (!col || !columnCanHoldText(col)) return undefined;   // integer/real/blob: type-native bytes
    if (!col.logicalType.isTextual) return 'BINARY';         // any/json/temporal: see below
    return (col.collation || fallback).toUpperCase();        // text: declared collation, else K
});
```

### Why hard `BINARY` and not `col.collation`

`ANY_TYPE.supportedCollations` is `undefined`, so `validateCollationForType` *accepts*
`create table t (k any collate nocase primary key)`. But the collation is then ignored at
comparison time. A memory table's PK comparator is built by `createTypedComparator`
(`comparison.ts:530`), which — when the logical type supplies its own `compare` — calls
`type.compare(a, b, collation)`. `ANY_TYPE.compare`, `JSON_TYPE.compare`, and every temporal
`compare` **discard that collation argument** and use `BINARY_COLLATION` unconditionally.
`TEXT_TYPE` supplies no `compare` at all, so text falls to `compareSqlValuesFast`, which *does*
honor the collation. That asymmetry is the whole rule.

Verified against the memory oracle: `create table m (k any collate nocase primary key, v text)`
accepts **both** `'A'` and `'a'`. So keying an `any` column under its declared `NOCASE` would
leave the store rejecting a row the memory module accepts — a different divergence, not a fix.
`'BINARY'` is what the engine actually compares under, so `'BINARY'` is what must be keyed.

Do **not** touch `reconcilePkCollations` (`store-module.ts:3318`). It correctly only reconciles
`isTextual` PK members; the non-textual ones need no schema-level collation at all, because the
key collation is now pinned independently of what the column declares.

## Consequences to clean up

**Dead clause in `validateKeyCollations`** (`store-table.ts`). Its `pkFallsBackToTableKeyCollation`
term tests `pkKeyCollations[i] === undefined && columnCanHoldText(schema.columns[def.index])`,
which after the fix can never be true — `columnCanHoldText` is now precisely the condition under
which a defined entry is returned. Remove the term and its explanatory paragraph in the doc
comment (the `indexKeysText` term stays: secondary-index *column* bytes still encode under K).
The `names` set will now contain `'BINARY'` for these tables, which always has a normalizer, so
no table becomes unopenable.

**The read-side gate un-declines itself, as predicted.** `pkOrderPreservingPrefixLength` compares
the member's key collation against `col.collation ?? 'BINARY'`; both are now `BINARY`, and
`_isCollationOrderPreserving('BINARY')` holds, so range seeks and PK-order advertisement return
for these columns. This is sound: the encoder's type tags order
`NULL(0x00) < NUMERIC(0x01) < TEXT(0x03) < BLOB(0x04) < OBJECT(0x05)`, matching the engine's
storage-class order `NULL(0) < NUMERIC(1) < TEXT(2) < BLOB(3) < OBJECT(4)` that
`compareSqlValuesFast` uses for cross-class comparison. Verified: a mixed-type `any` PK
(`2`, `'B'`, `'aa'`, `x'01'`) and a `json` PK both emit `order by <pk>` in exactly the memory
table's order, with the Sort elided.

**One residual conservatism, not a bug.** For the odd `k any collate nocase` declaration,
`pkOrderPreservingPrefixLength` will compare key `BINARY` against `col.collation` = `NOCASE`,
find them unequal, and decline the seek — even though both sides genuinely compare under BINARY.
That costs an optimization on a declaration nobody should write, and never a row. Leave it;
record it as a `NOTE:` at the `pkOrderPreservingPrefixLength` comparison site rather than
widening the gate.

## Migration

`packages/quereus-store` carries **no on-disk format version stamp** — there is no
`FORMAT_VERSION`, no `__version` catalog key, nothing to bump. This change alters the physical
key bytes of every existing `any` / `json` / temporal PK column in an already-written store whose
table key collation K is not `BINARY` (K defaults to `NOCASE`). Reopening such a store after the
fix would look for rows under bytes that were never written.

Per `AGENTS.md` ("Backwards compat: don't worry yet"), the resolution is an **explicit statement
that no such stores are supported across this change**, recorded in `docs/schema.md` — not a
rebuild path and not a version stamp. Say so plainly in the doc: a persisted store containing a
primary key of type `any`, `json`, `date`, `time`, `datetime`, or `timespan`, written before this
change, must be recreated. If a reviewer disagrees and wants a rebuild-on-open path, that is a
separate ticket — do not smuggle one in here.

## Adjacent, deliberately out of scope

`packages/quereus-isolation/src/isolated-table.ts:491` builds its modified-PK-set signature with
`logicalTypeCanHoldText(column.logicalType) ? column.collation : undefined`. For an
`any collate nocase` PK that hashes under NOCASE while the engine compares under BINARY — the same
class of divergence, in a different package. It is **not** reachable through the store path this
ticket fixes, and the store's own UNIQUE-constraint dedup sites (`store-module.ts:1013`, `:1154`)
are correct as written, because the engine's UNIQUE enforcement
(`resolveUniqueEnforcementCollations`) *does* honor `column.collation` for text values, unlike the
PK path's `type.compare`. Do not change those two sites. If the isolation site looks worth
pursuing, file it as a separate `backlog/bug-` ticket rather than expanding this one.

## Verification already done

The one-line fix was applied and reverted; `yarn workspace @quereus/store run test` went from
845 passing / 3 failing (the three below, which encode today's wrong behavior and nothing else)
to 848 passing once those three are updated. No other test in the package moved.

## TODO

- In `resolvePkKeyCollations` (`store-table.ts`), gate on `columnCanHoldText` and return
  hard-coded `'BINARY'` for a text-capable-but-not-`isTextual` member. Replace the long `NOTE:`
  comment — which currently documents the bug and points at this ticket's `fix/` slug — with a
  short explanation of *why* `BINARY` (`type.compare` is collation-blind for these types).

- Remove the now-unreachable `pkFallsBackToTableKeyCollation` term from
  `StoreTable.validateKeyCollations` and trim the corresponding paragraph from its doc comment.

- Add a `NOTE:` at the `pkOrderPreservingPrefixLength` comparison site recording that an explicit
  `any collate nocase` PK declines its seek conservatively, and that this costs speed, not rows.

- Invert `collation-order-preserving.spec.ts`'s `declines the PK RANGE seek on an 'any' PK…`
  (line ~229): rename it to assert the seek is now **kept**, and keep its row-correctness
  assertion (`['one']`), which already passes.

- Rewrite `collation-order-preserving.spec.ts`'s `truncates — rather than voids — the PK-order
  advertisement when a LATER member is unsafe` (line ~241). Its unsafe later member is `v any`,
  which is now safe. Reach for a genuinely unsafe member instead: a
  `text collate nocase` column under the file's `lengthFirst` comparator, which preserves
  equality but inverts order. The test's shape — leading member safe, later member unsafe,
  advertisement truncated rather than voided — is worth keeping.

- Replace `custom-collation-key.spec.ts`'s `rejects an ANY-typed PK column when the table key
  collation K cannot key` (line ~290). Its premise (an ANY PK falls back to K, so K must be
  keyable) is exactly what the fix removes. Invert it: an ANY PK column is now **unaffected** by
  an unkeyable K — `create table` succeeds, and `'A'` / `'a'` insert as two distinct rows.

- Add regression coverage for the four reproductions above, including the `insert or replace`
  data-loss case and a `json` PK, each asserted against a memory table as the oracle. A `date` PK
  range-seek test (rows correct **and** `INDEXSEEK` present) is worth adding alongside — it is the
  read-side win this fix unlocks.

- Update `docs/schema.md` §"Per-column PK key collation" (line ~365): state that a PK column whose
  type can hold text but is not `isTextual` (`any`, `json`, and the temporal types) is keyed under
  `BINARY`, matching its collation-blind `type.compare`, and that K is a default only for
  `isTextual` PK columns. Add the migration statement from the section above.

- Run `yarn workspace @quereus/store run test` and `yarn test`. Run `yarn test:store` as well —
  this change touches the physical key layout, and that suite is the one that exercises the store
  module against the engine's logic tests.
