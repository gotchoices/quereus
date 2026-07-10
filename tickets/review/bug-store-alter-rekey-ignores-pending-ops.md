description: On tables backed by the persistent store, an ALTER TABLE that rewrites the stored rows used to ignore rows written earlier in the same open transaction, corrupting or losing them on commit; those ALTERs now flush the pending writes first, so the rewrite sees every live row.
files:
  - packages/quereus-store/src/common/store-module.ts        # ddlCommitPendingOps (~1181), its 4 alterTable call sites, renameTable, rebuildSecondaryIndexes NOTE
  - packages/quereus-store/src/common/store-table.ts         # hasAnyRows (~411) now reads effectively
  - packages/quereus-store/test/alter-pending-ops.spec.ts    # new — 17 regression tests
  - docs/store.md                                            # new "DDL that implicitly commits" subsection
difficulty: medium
----

# Row-rewriting `ALTER TABLE` now DDL-commits before touching storage

## What was wrong

`StoreModule.alterTable`'s four row-rewriting arms (`ADD COLUMN`, `DROP COLUMN`,
`ALTER PRIMARY KEY`, and `SET COLLATE` on a primary-key column) call
`StoreTable.migrateRows` / `rekeyRows`, which scan and batch-write the **committed**
key-value store directly. The transaction coordinator, meanwhile, buffers pending
writes as `(keyBytes, valueBytes, store)` triples encoded at DML time under the
*pre-ALTER* schema. Nothing reconciled the two, so on the eventual `commit` the
stale-schema ops replayed over the rewritten store: rows landed under keys nothing
could find, deletes addressed keys that no longer existed, and rows came back with
the wrong column count.

`renameTable` already handled this class by committing the coordinator before moving
the on-disk directory. The `alterTable` arms never got the same treatment.

## What changed

- **New private helper `StoreModule.ddlCommitPendingOps()`** — commits the
  module-wide coordinator if a transaction is open. Carries the full explanation
  (why a physical rewrite cannot honor the buffer; the two consequences below).
  `renameTable` now calls it too, so the reasoning lives in exactly one place.
- **Called from each of the four rewriting arms**, immediately before the first
  physical write and after every throw-only validation that can reject without the
  flush.
- **`StoreTable.hasAnyRows()` now reads effectively** (`iterateEffectiveEntries`)
  instead of committed-only. This was necessary, not incidental: its one caller is
  `ADD COLUMN`'s "NOT NULL without a DEFAULT on a non-empty table" rejection. With
  a committed-only probe, `begin; insert; alter table t add column w int not null`
  would see an empty table, wave the ALTER through, then (post-flush) hand the
  pending row a NULL in a NOT NULL column. Reading effectively both fixes that
  **and** keeps the check *before* the DDL-commit, so a rejection leaves the
  transaction alive. The symmetric case — a pending delete of the last row makes the
  table legitimately empty — is now correct too.
- **`addConstraint`'s UNIQUE arm** gained a comment saying why it is exempt (writes
  no rows; its validation scan already reads effectively).
- **`docs/store.md`** gained a "DDL that implicitly commits" subsection under
  Transaction Support, listing exactly which statements flush and which do not.

### Deliberate posture (documented, and pinned by tests)

1. The coordinator is module-wide, so a rewriting ALTER commits **every** table's
   pending ops, not just the altered one's. Same as `renameTable`. There is a test
   asserting a sibling table's insert survives a `rollback` issued after an ALTER
   on an unrelated table.
2. `rekeyRows`' duplicate-key pass **must** see pending rows (a pending insert can
   itself be the duplicate), so the flush necessarily precedes it. A `CONSTRAINT`
   from `rekeyRows` therefore fails a statement whose enclosing transaction is
   already committed. The store itself is left unmutated — only the transaction is
   gone. Test: `rejects a pending insert that duplicates the new primary key`.

## How to exercise it

New file `packages/quereus-store/test/alter-pending-ops.spec.ts` — 17 tests, all
against the in-memory KV provider. Shape: `begin` → DML → rewriting `ALTER TABLE`
→ `commit` → assert.

Run: `yarn workspace @quereus/store test`, or just this file:

```
node --import ./packages/quereus-store/register.mjs node_modules/mocha/bin/mocha.js \
  "packages/quereus-store/test/alter-pending-ops.spec.ts" --reporter spec
```

Coverage, per arm, pending insert **and** pending delete:

| arm | key assertion |
| --- | --- |
| `alter primary key (b)` | moved row reachable by a **point lookup** on the new key (`where b = 20`) — a full scan hides the orphan |
| `alter primary key (b)` | pending `delete where a = 1` actually removes the row |
| `alter primary key (b)` | secondary index rebuilt over rows that were pending at ALTER time (`where c = 'y'` resolves) |
| `alter primary key (b)` | pending insert duplicating the new PK → `CONSTRAINT`, store unmutated |
| `set collate binary` on a text PK | pending delete of `'A'` stays deleted; pending insert of `'B'` is case-sensitively addressable, `'b'` is absent |
| `add column w integer default 7` | pending row carries `w = 7` |
| `add column w integer not null` | rejected when the only rows are pending (transaction survives, rolls back cleanly) |
| `add column w integer not null` | **allowed** when the only row is pending-deleted |
| `drop column w` | pending row does not resurrect the dropped column as a phantom `col_2` |

Plus a `DDL-commit posture` block: for each rewriting arm, a `rollback` issued after
the ALTER does **not** restore the pre-ALTER rows; a sibling table's pending insert
is committed too; and `rename column` (non-rewriting) still rolls back normally.

### Note on the original ticket's repro

`set collate nocase` on a text PK does **not** reproduce: the store's default key
collation is already `NOCASE`, so no key bytes change and `rekeyRows` skips every
row. Use `set collate binary`. The tests do.

## Validation performed

- `yarn workspace @quereus/store test` — **828 passing, 0 failing** (up from 811;
  17 new).
- `yarn test` (all workspaces) — 0 failing. (`failingKv` in the sync log is a test
  fixture name, not a failure.)
- `yarn test:store` (quereus logic tests against the LevelDB store module) —
  6770 passing, 15 pending, 0 failing.
- `yarn build` — clean. `yarn lint` — clean.
- **Negative control**: with `ddlCommitPendingOps()` stubbed to a no-op, 11 of the
  17 new tests fail. They are not vacuous.

## Known gaps / things for the reviewer to push on

- **The four arms were not audited for a *nested savepoint* interaction.** A
  DDL-commit clears the coordinator's savepoint stack; `releaseSavepoint` /
  `rollbackToSavepoint` then `console.warn` and degrade rather than throw. That path
  existed before this change (`renameTable` and `replaceContents` hit it) and is
  unchanged here, but no test in the new file opens a savepoint before the ALTER.
  Worth deciding whether `savepoint sp1; insert; alter table t add column ...;
  rollback to sp1` should warn or error.
- **`hasAnyRows` scope.** Changing it to read effectively is a behavior change to a
  method on a public-ish class, justified above. It has exactly one caller today
  (`grep hasAnyRows` across `packages/` confirms), so blast radius is nil, but a
  reviewer may reasonably want the effective read inlined at the call site instead.
- **Tripwire parked as a code comment**, not a ticket: `rebuildSecondaryIndexes`
  (`store-module.ts:~1083`) reads the data store committed-only and writes index
  stores outside the coordinator. That is sound *only because* both of its callers
  DDL-commit first. A future third caller that skips the flush would rebuild an
  index missing that transaction's pending rows. Recorded as a `NOTE:` in its
  docblock.
- **`dropColumn` on a PK member** would shrink `primaryKeyDefinition` without
  re-keying — but the engine rejects it upstream
  (`packages/quereus/src/runtime/emit/alter-table.ts:729`, `Cannot drop PRIMARY KEY
  column`), so the store arm is unreachable. Verified, not defended in the store.
- The tests only drive the **in-memory** KV provider. The LevelDB path is covered
  transitively by `yarn test:store`'s ALTER logic tests, but none of those run DML
  and a rewriting ALTER inside one transaction.
