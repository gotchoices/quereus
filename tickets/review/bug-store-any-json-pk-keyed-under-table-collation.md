---
description: Fixed a bug where a persistent-store table with a flexible `any`, `json`, or date/time primary key treated text case-insensitively when deciding whether two rows were the same row — rejecting a legitimate second row, and silently destroying the first row on "insert or replace". Such keys now compare byte-for-byte, matching what a memory table does.
files:
  - packages/quereus-store/src/common/store-table.ts                     # the fix + the dead-clause removal + the NOTE tripwire
  - packages/quereus-store/test/any-json-pk-binary-key.spec.ts           # NEW — regression coverage for all four reproductions
  - packages/quereus-store/test/collation-order-preserving.spec.ts       # two tests inverted/rewritten
  - packages/quereus-store/test/custom-collation-key.spec.ts             # one test's premise inverted
  - docs/schema.md                                                       # §"Per-column PK key collation" + migration statement
difficulty: medium
---

# Non-textual, text-capable PK columns are now keyed under BINARY

## What changed

`resolvePkKeyCollations` (`store-table.ts:124`) decides, per primary-key column, which
collation produces that column's physical key bytes. It used to gate on
`col.logicalType.isTextual` and return `undefined` for everything else. But `undefined` does
not mean "encode type-natively" to `encodeValue` — it means *fall back to `options.collation`*,
the table key collation K, which defaults to `NOCASE`. So an `any` / `json` / temporal PK
column's text was lowercased before it became key bytes, while the engine compared that same
column under `BINARY`. Uniqueness was enforced under NOCASE and compared under BINARY.

The gate is now `columnCanHoldText`, and a text-capable-but-not-`isTextual` member returns a
hard-coded `'BINARY'`. That is the collation the engine actually compares under: `ANY_TYPE`,
`JSON_TYPE`, and every temporal type supply their own `logicalType.compare`, and all of them
discard the collation argument `createTypedComparator` hands them and use `BINARY_COLLATION`
unconditionally. `TEXT_TYPE` supplies no `compare` at all, so text alone reaches the
collation-honoring `compareSqlValuesFast`. That asymmetry is the whole rule.

Not the column's *declared* collation: `create table t (k any collate nocase primary key)` is
accepted (`ANY_TYPE.supportedCollations` is `undefined`, so `validateCollationForType` waves it
through) but the collation is inert. A memory table accepts both `'A'` and `'a'` in such a
column, so keying under NOCASE would be a different divergence, not a fix.

Two consequential cleanups:

- **`validateKeyCollations`' `pkFallsBackToTableKeyCollation` term is gone.** It tested
  "`pkKeyCollations[i] === undefined` *and* the column can hold text", which is now
  unsatisfiable by construction. The `indexKeysText` term stays — secondary-index *column*
  bytes still encode under K. `'BINARY'` now enters the `names` set for these tables and always
  has a normalizer, so no table becomes unopenable.

- **The read-side gate un-declines itself.** `pkOrderPreservingPrefixLength` compares the
  member's key collation against `col.collation ?? 'BINARY'`; both are now `BINARY`, and
  `_isCollationOrderPreserving('BINARY')` holds, so PK range seeks and PK-order advertisement
  return for these columns. This is sound because the encoder's type tags order
  `NULL(0x00) < NUMERIC(0x01) < TEXT(0x03) < BLOB(0x04) < OBJECT(0x05)`, matching the engine's
  storage-class order `NULL(0) < NUMERIC(1) < TEXT(2) < BLOB(3) < OBJECT(4)` that
  `compareSqlValuesFast` uses across classes.

`reconcilePkCollations` (`store-module.ts:3318`) was deliberately **not** touched: it correctly
reconciles only `isTextual` PK members, and the non-textual ones now pin their key collation
independently of what the column declares.

## Use cases to test / validate

Every one of these was a live reproduction against the pre-fix HEAD. They are covered by
`packages/quereus-store/test/any-json-pk-binary-key.spec.ts`, each asserted against a memory
table as the oracle.

```sql
-- 1. Spurious UNIQUE rejection on an `any` PK.
create table t (k any primary key, v text) using store;
insert into t values ('A', 'upper');
insert into t values ('a', 'lower');            -- was: ConstraintError. now: 2 rows.

-- 2. Same, for `json` — the object KEY's case was being lowercased into the key bytes.
create table t (j json primary key, v text) using store;
insert into t values ('{"A":1}', 'upper');
insert into t values ('{"a":1}', 'lower');      -- was: ConstraintError. now: 2 rows.

-- 3. UPDATE into a case-only-distinct key: the same spurious rejection.
update t set k = 'a' where v = 'other';

-- 4. The DATA-LOSS direction — no error, one row silently gone.
create table t (k any primary key, v text) using store;
insert into t values ('A', 'upper');
insert or replace into t values ('a', 'lower');
select count(*) from t;                          -- was: 1. now: 2.

-- 5. The read-side win: a `date` PK range now seeks instead of full-scanning.
create table t (d date primary key, v text) using store;
select v from t where d > '2024-03-01';          -- plan now contains INDEXSEEK

-- 6. PK-order advertisement returns for mixed-type `any` and for `json` PKs:
--    `order by <pk>` emits rows in exactly the memory table's order, Sort elided.
```

The temporal types (`date`, `time`, `datetime`, `timespan`) store canonical ISO strings whose
case is fixed, so no two distinct temporal values ever collided — the *uniqueness* bug was
unreachable for them. Their key bytes were still wrong, and the read-side gate had been
declining every range seek on them as a result. Case 5 is that seek coming back.

## Tests changed, and why

- `collation-order-preserving.spec.ts` — `declines the PK RANGE seek on an 'any' PK…` asserted
  today's wrong behavior. Renamed and inverted to assert the seek is now **kept**; its
  row-correctness assertion (`['one']`) was already passing and is unchanged.

- `collation-order-preserving.spec.ts` — `truncates — rather than voids — the PK-order
  advertisement when a LATER member is unsafe` used `v any` as its unsafe later member, which is
  now safe. Rewritten to use a genuinely unsafe member: a `text collate nocase` column under the
  file's `lengthFirst` comparator (equality-preserving, order-inverting). The test's shape —
  leading member safe, later member unsafe, advertisement truncated rather than voided — is
  preserved intact.

- `custom-collation-key.spec.ts` — `rejects an ANY-typed PK column when the table key collation K
  cannot key` had exactly the removed behavior as its premise. Inverted: an ANY PK column is now
  unaffected by an unkeyable K (`create table` succeeds, `'A'` / `'a'` insert as two rows).

## Validation run

- `yarn workspace @quereus/store run test` — 858 passing, 0 failing.
- `yarn test` — all workspaces green (6785 + 858 + … passing, 9 pending; no failures).
- `yarn test:store` — 6779 passing, 15 pending, 0 failing. This is the suite that matters most
  here: the change alters the physical key layout, and `test:store` re-runs the engine's logic
  tests against the LevelDB store module.
- `yarn build` — clean.
- `npx tsc -p tsconfig.test.json --noEmit` in `packages/quereus-store` — clean.

## Known gaps / things a reviewer should push on

- **No test asserts the removed `pkFallsBackToTableKeyCollation` term is actually unreachable.**
  The argument is by construction (`columnCanHoldText` is now exactly the condition under which a
  defined entry is returned), not by coverage. If a future logical type is text-capable *and*
  yields `undefined` from `resolvePkKeyCollations`, the K-keyability check silently stops firing
  for it. Worth deciding whether that deserves an assertion in `resolvePkKeyCollations` itself.

- **`json` PK ordering is asserted against the memory oracle, not against a hand-written expected
  order.** The `json` order-advertisement test compares `select json_quote(j) … order by j` on
  store vs memory. If both were wrong in the same way, the test would pass. The mixed-type `any`
  test has the same shape. I judged the oracle sufficient (matching memory *is* the contract) but
  a reviewer may want one absolute assertion pinning the cross-storage-class order.

- **Migration is a doc statement, not code.** `packages/quereus-store` has no on-disk format
  version stamp — no `FORMAT_VERSION`, no `__version` catalog key. This change alters the physical
  key bytes of every existing `any` / `json` / temporal PK column in an already-written store
  whose K is not `BINARY`. Per `AGENTS.md` ("Backwards compat: don't worry yet") the resolution is
  an explicit *unsupported* statement in `docs/schema.md`, not a rebuild path. If a reviewer wants
  rebuild-on-open, that is a separate ticket — it was deliberately not smuggled in here.

- **No test for `alter table … alter column k set collate` on an `any` PK member.** The rekey path
  (`rekeyRows` → `resolvePkKeyCollations`) now returns BINARY before and after such an ALTER, so it
  should be a no-op re-key. Untested.

## Tripwire recorded

- `NOTE:` at the `pkOrderPreservingPrefixLength` comparison site
  (`store-table.ts`): an explicit `k any collate nocase` PK declines its range seek
  conservatively, because the key collation is `BINARY` (what `ANY_TYPE.compare` uses) while
  `col.collation` is the declared-but-ignored `NOCASE`. Both sides genuinely compare under BINARY,
  so the decline costs an optimization on a declaration nobody should write, and never a row. The
  note says what to do if that declaration ever shows up in practice (resolve the *comparison*
  collation the way the key collation is resolved, rather than widening the gate).

## Adjacent, deliberately out of scope

`packages/quereus-isolation/src/isolated-table.ts:491` builds its modified-PK-set signature with
`logicalTypeCanHoldText(column.logicalType) ? column.collation : undefined`. For an
`any collate nocase` PK that hashes under NOCASE while the engine compares under BINARY — the
same class of divergence, in a different package. It is not reachable through the store path this
ticket fixed, and was left alone. The store's own UNIQUE-constraint dedup sites
(`store-module.ts:1013`, `:1154`) are correct as written: the engine's UNIQUE enforcement
(`resolveUniqueEnforcementCollations`) *does* honor `column.collation` for text values, unlike the
PK path's `type.compare`. If the isolation site looks worth pursuing, it should become a separate
`backlog/bug-` ticket.
