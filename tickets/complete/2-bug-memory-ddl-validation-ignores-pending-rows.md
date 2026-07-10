----
description: Fixed a memory-table bug where creating a unique index or adding a UNIQUE constraint inside an open transaction ignored the rows that transaction had just written, letting duplicate rows commit under a constraint that forbids them.
files:
  - packages/quereus/src/vtab/memory/layer/base.ts                    # populateIndexFromRows, iteratePrimaryRows, addIndexToBase
  - packages/quereus/src/vtab/memory/layer/transaction.ts             # adoptSchema, reindexOwnWrites
  - packages/quereus/src/vtab/memory/layer/manager.ts                 # createIndex, addUniqueConstraint, ensureSchemaChangeSafety + helpers
  - packages/quereus/src/vtab/memory/layer/connection.ts              # hasOpenWork, readSnapshot
  - packages/quereus/test/ddl-in-transaction-validation.spec.ts       # 24 cases
  - packages/quereus/test/logic/10.1.2-ddl-in-transaction.sqllogic    # memory-only for now
  - packages/quereus/test/logic.spec.ts                               # MEMORY_ONLY_FILES entry
  - docs/memory-table.md                                              # "DDL and transactions" section
  - docs/module-authoring.md                                          # cross-reference
difficulty: hard
----

# Memory backend: index-building DDL now sees the open transaction

## What was wrong

Two independent defects, both fixed.

1. **The build/validate scan read committed rows only.** `BaseLayer.populateNewIndex` walked
   the base primary tree, so a row the transaction had inserted but not committed never entered
   the duplicate check.

2. **After the DDL, the transaction stopped enforcing the new constraint.** A `TransactionLayer`
   freezes its schema at construction, so a layer created before the `create index` had neither
   the new `IndexSchema` nor the derived `uniqueConstraints` entry.

Net effect: `begin; insert (1,'a'); create unique index ix on t(v); insert (2,'a'); commit` left
two rows with `v='a'` under a UNIQUE index.

## What shipped

**Validation over the effective rows.** `BaseLayer.populateNewIndex`'s duplicate-detection body
was lifted into an exported `populateIndexFromRows(rows, index, pkFromRow, enforceUnique,
tableName, columns)` taking a row iterable. `MemoryTableManager.createIndex` and
`addUniqueConstraint` call it with a throwaway `MemoryIndex` over the DDL connection's
*effective* rows (`pendingTransactionLayer ?? readLayer`, the layer `MemoryTable.query` scans),
before anything is mutated. Partial predicates, multiple-NULLs-allowed, and collation-aware key
comparison come free from the `MemoryIndex`.

**The base index still holds only committed rows.** `addIndexToBase` populates from the base
primary tree with `enforceUnique: false` — base rows are not a subset of effective rows (a
duplicate the transaction *deleted* still sits in the base tree). Safety rests on
`checkUniqueViaIndex` re-validating every candidate entry against the live effective row.

**Enforcement for the rest of the transaction.** `TransactionLayer.adoptSchema(newSchema)`
replaces the layer's frozen schema and builds any newly-declared index over its parent's tree,
re-indexing only that layer's own writes (driven off `ownWrites`, deduped by primary key).
`MemoryTableManager.adoptSchemaOnOpenLayers` applies it oldest-first across the pending layer
and every savepoint snapshot beneath it. Rebasing would have invalidated those snapshots.

**Only the DDL issuer may hold uncommitted writes.** `ensureSchemaChangeSafety` raises `BUSY`
when any *other* connection has open work, and leaves the DDL connection's own read view alone
instead of re-pointing it at the base layer.

**Two adjacent fixes fell out.** A `create index` failing after `addIndexToBase` no longer
strands the half-built index in the base layer's index map; and a DDL statement issued after an
eager savepoint no longer silently discards every pre-savepoint row at commit.

## Review findings

### Checked

Read the implement diff before the handoff summary. Reviewed `populateIndexFromRows` extraction
(correct: identical body, and the `enforceUnique: false` for `addIndexToBase` is justified — a
transaction-deleted duplicate legitimately still sits in the base tree); the `adoptSchema` /
`reindexOwnWrites` inheritance and copy-on-write reasoning; `hasOpenWork` against every
savepoint state machine transition in `connection.ts`; the `adoptSchemaOnOpenLayers` chain walk
against `ensureSchemaChangeSafety`'s consolidation ordering; the `createIndex` catch-path
teardown; resource cleanup (no new handles/listeners); type safety (no `any`, no inline
`import()` — the diff in fact removes one). Ran `yarn lint` (clean), `yarn test`
(6733 passing, 9 pending, 0 failing), `yarn workspace @quereus/quereus test:store`
(6727 passing, 15 pending, 0 failing). No pre-existing failures surfaced.

Each "known gap" in the handoff was independently reproduced rather than taken on trust.

### Found and fixed in this pass

- **`hasOpenWork()` missed a released eager savepoint — silent data loss.** `release` pops the
  savepoint entry but leaves its snapshot installed as `readLayer`, still holding uncommitted
  rows. The implemented `savepointStack.some(e => e.snapshot !== null)` therefore reported "no
  open work" for a connection whose rows were uncommitted. Two consequences, both reproduced:
  `begin; insert; savepoint s; release s; create index ix; commit` **lost the row entirely**
  (`ensureSchemaChangeSafety` re-pointed `readLayer` at the base), and a duplicate held only in
  that snapshot passed validation. This is the exact defect the implement pass set out to close
  for the un-released savepoint; the release path was the hole. Fixed by tracking the installed
  snapshot in a new `MemoryTableConnection.readSnapshot` field — the stack cannot express this
  state, since `release` discards the entry while the snapshot stays live. Two regression tests
  added to `ddl-in-transaction-validation.spec.ts` (24 cases now); both fail without the fix.

- **`docs/memory-table.md` overstated the scope of its two rules.** Added a paragraph naming the
  two DDL statements that still do *not* follow them (`alter column … set collate`, `drop index`)
  with pointers to their tickets, so a reader does not generalize the section.

### Found and filed as new tickets

- **`tickets/fix/bug-memory-alter-collate-ignores-pending-rows.md`** (major). The handoff flagged
  `alter column … set collate` as possibly in scope; it is a real, reachable data-corruption bug
  of the same class, and it is now confirmed by direct repro:
  `begin; insert (1,'a'); insert (2,'A'); alter table t alter column v set collate nocase; commit`
  is accepted and commits both rows under a `nocase` unique index. It reaches uniqueness through
  `rebuildAllSecondaryIndexesStrict`, which scans base rows only. The store backend already
  validates this case, so memory and store disagree — filed to `fix/` rather than fixed here
  because the re-keying path genuinely has to mutate base structures and the design choice
  (re-point the strict rebuild vs. add a validation pre-pass) deserves its own ticket.

### Verified, no action

- **`tickets/backlog/bug-drop-index-in-transaction-still-enforced.md`** — reproduced.
  `begin; insert(3,'b'); drop index ix; insert(2,'a')` still raises `UNIQUE constraint failed`.
  Pre-existing, spurious-rejection only (no corruption). The handoff's triage stands; correctly
  left in `backlog/` pending a savepoint-semantics decision.

- **The `MEMORY_ONLY_FILES` skip for `10.1.2-ddl-in-transaction.sqllogic` is justified.** The
  handoff asked this to be checked rather than believed. Removed the entry and ran
  `test:store --grep 10.1.2`: it fails at the very first case (`create unique index` accepted
  over colliding overlay rows), and `IsolationModule.createIndex` delegates straight to the
  underlying table without exposing the connection's overlay. Entry restored. The cause is the
  isolation layer, as claimed, and `tickets/fix/isolation-ddl-validation-ignores-overlay-rows.md`
  already carries the instruction to delete the entry.

### Tripwires (conditional; not tickets)

- `adoptSchemaOnOpenLayers` walks every `TransactionLayer` below the view, which can include a
  committed layer already drained into the base. Harmless today — adopting it is idempotent
  because its rows are already in the base's new index — and it *cannot* simply skip committed
  layers, because a savepoint snapshot is `markCommitted()` too. Parked as a `NOTE:` at the walk
  in `manager.ts`, tripping if `adoptSchema` ever removes structures or stops being idempotent.

- `ddlConnection()` takes the first Database-registered connection. Confirmed the registry holds
  at most one connection per table name (`Database.activeConnections` is keyed that way, and the
  spec's sibling connection comes from `manager.connect()`, which never registers), so no path
  today picks the wrong view. The implementer's `NOTE:` at the site already states the condition
  under which it would.

- `reindexOwnWrites` walks `ownWrites` per newly-adopted index, so cost scales with the
  transaction's write count times the number of indexes the change adds (always one today). The
  method's docstring already records this and why a `Set` dedup beat a full effective-row scan.

### Explicitly empty

No findings on resource cleanup, error handling, or type safety: the diff adds no disposable
resources, every new throw path is a typed `QuereusError` with a `StatusCode`, and the only
error swallowed anywhere near it (`createIndex`'s catch) re-throws after restoring state — which
this pass verified also drops the half-built base index.

## Validation performed (review pass)

- `yarn lint` — clean.
- `yarn test` — 6733 passing, 9 pending, 0 failing (6731 before; the 2 new regression tests).
- `yarn workspace @quereus/quereus test:store` — 6727 passing, 15 pending, 0 failing.
- Both new regression tests confirmed failing against the implement-stage tree.
