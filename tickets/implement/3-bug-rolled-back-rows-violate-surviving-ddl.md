----
description: When a transaction deletes or overwrites rows, then adds a unique index, changes a column's collation or type, or marks a column NOT NULL, and then rolls back, the rule change stays but the old rows come back and silently violate it. Fix: the schema change must also check every state a rollback could restore, and refuse (telling the user to commit first) when one of them would break the new rule.
architecture: docs/memory-table.md#ddl-and-transactions
files:
  - packages/quereus/src/vtab/module.ts                         # EffectiveRowSource type + createIndex/alterTable signatures
  - packages/quereus/src/vtab/table.ts                          # VirtualTable.createIndex(rows) + new optional savepoint-rows hook
  - packages/quereus/src/vtab/memory/layer/connection.ts        # savepointStack is private — needs an accessor for the layers a rollback restores
  - packages/quereus/src/vtab/memory/layer/manager.ts           # effectiveDdlRows, validateUniqueOverEffectiveRows, validateRekeyedUniqueStructures, createIndex, addUniqueConstraint, alterColumn, convertBaseRows
  - packages/quereus/src/vtab/memory/layer/alter-column.ts      # AlterColumnContext.effectiveRows, planTightenNotNull, assertEveryValueConverts
  - packages/quereus/src/vtab/memory/layer/transaction.ts       # convertColumn swallows unconvertible values — becomes unreachable
  - packages/quereus/src/vtab/memory/table.ts                   # MemoryTable implements the savepoint-rows hook
  - packages/quereus-isolation/src/isolation-module.ts          # effectiveRowsFor / issuerEffectiveRows / createIndex / alterTable
  - packages/quereus-isolation/src/overlay-rows.ts              # iterateEffectiveRows — needs a per-savepoint-frame variant
  - packages/quereus-isolation/src/alter-migration.ts           # two NOTEs citing this ticket (~884, ~1018); backfillStagedNotNull writes only the current frame
  - packages/quereus-store/src/common/store-module-index.ts     # createIndex: wrapper-supplied rows skip the committed check entirely
  - packages/quereus-store/src/common/store-module-index-build.ts  # effectiveDdlRows, validateUniqueOverExistingRows, validateUniqueIndexOverRows
  - packages/quereus-store/src/common/store-module-alter.ts     # alterAddConstraint unique
  - packages/quereus-store/src/common/store-module-alter-column.ts  # alterColumnSetNotNull, alterColumnSetDataType (the NOTE), set collate unique re-validation
  - packages/quereus/test/ddl-in-transaction-validation.spec.ts
  - packages/quereus/test/logic/41.2.1-alter-column-retype-deleted-row-memory.sqllogic
  - packages/quereus/test/logic/41.7.3-alter-column-retype-unique.sqllogic   # § 8 flips
  - packages/quereus/test/logic.spec.ts                         # MEMORY_ONLY_FILES entry for 41.2.1
  - packages/quereus-isolation/test/alter-table-conformance.spec.ts   # "ignores an illegal value only in a row the transaction deleted" flips
  - packages/quereus-isolation/test/isolation-layer.spec.ts     # "ADD CONSTRAINT UNIQUE … ignores in-transaction deletion markers" flips
  - docs/memory-table.md                                        # § DDL and transactions, rule 1 and the "Rule 1 assumes the transaction commits" paragraph
  - docs/module-authoring.md                                    # § When the pending rows live outside your module
  - docs/module-capabilities.md                                 # non-transactional tier description
  - docs/store.md                                               # the pre-commit validation paragraph (~550)
difficulty: hard
repro: verified
----

# Row-validating DDL must hold for every state a rollback can restore

## The bug, in one paragraph

Schema changes on the memory and store backends are not undone by `rollback` (the decided `'non-transactional'` tier; see `docs/module-capabilities.md`). A schema change that has to inspect rows inspects the rows the issuing transaction can see (committed rows, plus its own uncommitted inserts and updates, minus its own uncommitted deletes). So a transaction can delete or overwrite the rows that would have blocked the change, get the change accepted, and then roll back: the deleted or overwritten rows come back, the change stays, and the table holds data its own schema forbids. Nothing re-validates afterwards.

## Reproduction (verified 2026-11-03 against `main`, memory backend, run through the mocha loader)

All six of these are accepted today and leave the table in the corrupt state shown. Case F and case H are legal shapes that must stay accepted.

| Case | Statements | Observed after the rollback |
|---|---|---|
| A | committed `(1,'a')`; `begin; insert (2,'a'); savepoint s; delete id=2; create unique index ix on t (v); rollback to s; commit` | two rows with `v='a'` under a unique index |
| B | committed `(1,'a'),(2,'A')`, unique index on `v`; `begin; delete id=2; alter column v set collate nocase; rollback` | `'a'` and `'A'` both present, column and index NOCASE |
| C | committed `(1,'abc'),(2,'20')`; `begin; delete id=1; alter column v set data type integer; rollback` | row 1 holds text `'abc'` in a column `table_info` reports as INTEGER |
| D | committed `(1,null)`; `begin; update t set v='x'; alter column v set not null; rollback` | a NULL in a NOT NULL column |
| E | committed `(1,'a'),(2,'a')`; `begin; update t set v='b' where id=2; create unique index ix on t (v); rollback` | two rows with `v='a'` under a unique index |
| F (legal) | committed `(1,'a'),(2,'b')`; `begin; delete id=2; create unique index ix on t (v); rollback` | both rows back, no violation: must stay accepted |
| H (legal) | committed `(1,'a')`; `begin; insert (2,'a'); savepoint s; delete id=2; release s; create unique index ix on t (v); commit` | the released savepoint cannot be rolled back to, so no restorable state holds the duplicate: must stay accepted |

Case C also reproduces behind the isolation wrapper over memory (`using isolated`, registered as in `packages/quereus-isolation/test/alter-table-conformance.spec.ts`). The isolation-wrapped **store** leg (what `yarn test:store` runs) currently rejects case C only by accident: the store's convert pre-pass scans its own committed rows and ignores the wrapper's stream (the NOTE in `alterColumnSetDataType`), which is why `41.2.1-…-memory.sqllogic` is memory-only today.

## The decided rule (maintainer, 2026-11-03)

A failure can only be reported at the DDL statement, because that is the last point that can report one. So:

**Row-validating DDL inside a transaction validates, in addition to the rows the transaction sees now, every state a rollback could return to: the committed rows (what a whole-transaction `rollback` restores) and the rows as they stood at each open savepoint taken before the DDL (what `rollback to savepoint` restores). Each state is judged on its own, with the same check the effective rows get. If any such state would violate the new rule, the DDL is refused with an error that tells the user to commit the pending writes first.** States after the DDL need no check, because the new rule is enforced on every write that follows it.

Consequences worth spelling out:

- The delete-then-DDL shape stays legal when the deleted row breaks no rule (case F). It is refused only when a rollback would actually break the table.
- A **released** savepoint is not a restorable state (case H stays legal). The memory backend's layer chain keeps one immutable layer per statement boundary after an eager savepoint, so this rule must walk the connection's **savepoint stack**, not the parent chain. (Rule 3 of `docs/memory-table.md`, the primary-key representability pass, deliberately walks the whole chain and raises `BUSY`; leave it exactly as it is. It answers a different question: whether a map-shaped tree can physically hold the pair.)
- Status and wording: raise `StatusCode.BUSY`, the same retryable posture rule 3 uses, with a message of this shape: `Cannot <create unique index ix | alter column v set …> on table t: rows this transaction has deleted or overwritten would violate it if the transaction rolled back. Commit the pending writes first, then retry.` Tests should match `/commit the pending writes first/i`. A violation among the rows the transaction can **see** keeps its current status (`CONSTRAINT`, or `MISMATCH` for an unconvertible value); only a violation confined to a restorable state is `BUSY`.
- This makes the memory and store legs agree behind the isolation wrapper (both refuse case C), so the memory-only exclusion on `41.2.1` goes away.
- The interim mitigation `pragma ddl_transaction_policy = 'strict'` is unaffected.

### What "judged on its own" means for each backend

Judge a restorable state as the rows it **will hold after the DDL's rewrite has reached it**, which is exactly what the effective-rows pass already does through its `mapRow` conversion:

- **Memory, unwrapped.** The value-rewriting arms (`set data type`, the `set not null` null-to-DEFAULT backfill) rewrite the base **and every open layer and savepoint snapshot** (`propagateAlterColumnToOpenLayers` → `TransactionLayer.convertColumn`). So a restorable state is judged with the altered column converted: a NULL under a DEFAULT backfill is fine (it will be filled); an unconvertible value, a NULL with no DEFAULT, or a post-conversion UNIQUE collision refuses. With that in place, the "shadowed unconvertible value, keep as-is" branches in `convertBaseRows` (manager.ts) and `TransactionLayer.convertColumn` become unreachable; turn them into thrown `INTERNAL` errors so a regression is loud, and drop the comments that justify the swallow.
- **Isolation wrapper (over memory or over the store).** The issuing connection's pending rows live in the overlay, a `MemoryTable`. The retype path migrates the overlay through the overlay module's own `alterColumn`, which converts its savepoint snapshot frames too (pinned by `isolation-layer.spec.ts` "SET DATA TYPE keeps the pre-savepoint row CONVERTED"). The NOT NULL backfill does **not**: `backfillStagedNotNull` issues ordinary staged updates into the current frame only (the overlay column cannot be NOT NULL because tombstone rows carry placeholder NULLs), and the NOTE at ~1018 of `alter-migration.ts` already documents the resulting hole. So a savepoint frame is judged **as-is** for the NOT NULL arm: a non-tombstone NULL in a frame a rollback could restore refuses, DEFAULT or not. The two NOTEs in `alter-migration.ts` that cite this ticket should be rewritten to say the refusal now closes the hole.
- **Store behind the wrapper.** The store holds only committed rows while wrapped (the overlay holds everything pending), so its own effective stream *is* the whole-rollback state. Today, when `rows` is supplied, `createIndex` skips the committed check entirely, `alterAddConstraint` and the `set collate` re-validation judge only the wrapper's stream, and `alterColumnSetNotNull` scans only the wrapper's stream; `alterColumnSetDataType` is the odd one out (it scans only its own rows, which is the accidental rejection above). Every one of these needs: the wrapper's effective stream for the `CONSTRAINT`/`MISMATCH` question, then the committed rows and each wrapper-supplied savepoint state for the `BUSY` question. Committed NULLs under a DEFAULT backfill are fine on this leg too (`mapRowsAtIndex` fills them).
- **Store, unwrapped (bare `StoreModule`).** Its row-rewriting arms flush the buffered transaction at DDL time (`ddlCommitPendingOps`, the `'auto-commit'` tier), after which nothing is left to roll back, so they need no new pass. Its non-committing arms (`create unique index`, `add constraint … unique`, `set not null` when no NULL is visible) do have the hole through the coordinator's buffered deletes and savepoints. That is a different site (the coordinator's op log) and is split out as `bug-bare-store-ddl-ignores-buffered-rollback-states`, which lands after this ticket.

## Design

### 1. The interface: what a wrapper hands down

Replace the bare `rows?: EffectiveRowSource` parameter on `VirtualTableModule.createIndex`, `VirtualTableModule.alterTable`, `VirtualTable.createIndex`, and the memory manager's `createIndex` / `alterColumn` / `alterPrimaryKey` / `addConstraint` with a small bundle (keep `EffectiveRowSource` as the re-callable stream type):

```ts
/** The rows a row-validating DDL must judge on behalf of the connection issuing it,
 *  supplied by a wrapper module that stages that connection's writes outside the target
 *  module. See docs/module-authoring.md § When the pending rows live outside your module. */
export interface IssuerRowSources {
	/** The rows the issuing transaction can see now. Judged for CONSTRAINT / MISMATCH. */
	readonly effective: EffectiveRowSource;
	/** The rows the issuing transaction would see after `rollback to` each open savepoint taken
	 *  before this DDL, oldest first. Each is judged on its own; a violation refuses with BUSY.
	 *  The whole-transaction rollback state is not listed: it is the receiving module's own
	 *  committed rows, which it holds and must judge itself. */
	readonly savepoints: readonly EffectiveRowSource[];
}
```

A bundle rather than a second optional parameter so a wrapper author cannot forget the savepoint half; the type makes it mandatory. The ~60 references to `EffectiveRowSource` across the three packages are mostly `rows ? rows() : own` call sites that become `rows ? rows.effective() : own`.

### 2. Memory backend

- `MemoryTableConnection`: add an accessor over the private `savepointStack` returning, oldest first, the layer each entry would restore (`entry.snapshot ?? entry.readLayer`), deduplicated by identity and excluding the manager's base layer (after `ensureSchemaChangeSafety` drains and re-points lazy markers, a lazy marker's `readLayer` is the base, which the manager judges separately).
- `MemoryTableManager`: alongside `effectiveDdlRows()`, a `rollbackStateRows()` yielding the base primary tree's rows and each savepoint layer's rows as synchronous iterables when unwrapped; when `rows` is supplied, the base (= committed) plus `rows.savepoints`. One shared helper runs a probe over each state and rewraps any `CONSTRAINT`/`MISMATCH` it throws as the `BUSY` "commit the pending writes first" error, so the five sites below do not each re-implement the wording:
  - `createIndex` (unique) and `addUniqueConstraint` → `validateUniqueOverEffectiveRows` over each state.
  - `validateRekeyedUniqueStructures` (the `set collate` / rewrite arms) → same probe with the same `mapRow`.
  - `alter-column.ts`: `AlterColumnContext` gains the restorable states; `planTightenNotNull`'s NULL scan and `assertEveryValueConverts` run over the effective rows first (current statuses), then over each state (`BUSY`). Keep the sync-iterable discipline `scanEffectiveRows` documents.
  - `validateRekeyedPrimaryKey`: unchanged (rule 3).
- `MemoryTable` implements the new optional `VirtualTable` hook (next section) by reading its connection's savepoint layers.

### 3. A hook so the wrapper can read the overlay at a savepoint

Add to `VirtualTable` (next to `savepoint?` / `rollbackTo?`):

```ts
/** For each open savepoint, oldest first: the rows this table would show its connection after
 *  `rollback to` that savepoint. A wrapper module uses this on its staging table to build
 *  IssuerRowSources.savepoints. Optional; a module without it cannot be used as a staging
 *  overlay for row-validating DDL under open savepoints. */
savepointRowSources?(): readonly EffectiveRowSource[];
```

`MemoryTable` implements it. The isolation module's `effectiveRowsFor` builds `savepoints` by merging each overlay frame with the underlying's committed rows: factor `iterateEffectiveRows` in `overlay-rows.ts` so the overlay-entry source is a parameter (today it always reads the live overlay through `collectOverlayEntries`). Savepoints taken before the overlay existed (`savepointsBeforeOverlay`) restore "no overlay rows" = the committed rows, which the underlying already judges, so they contribute nothing. If the configured overlay module lacks the hook and the issuer has both staged changes and open savepoints, refuse the DDL with the same `BUSY` message rather than leave the hole open.

### 4. Isolation wrapper's own pre-flight

The wrapper's `validateOverlayMigration` dry-run (overlay `alterSchema(..., validateOnly)`) now inherits the overlay memory table's own rollback-state checks for free; make sure a `BUSY` raised there is routed like the existing `BUSY` in the `apply` helper (~1408), not swallowed by the `CONSTRAINT || MISMATCH` filter at ~1672, and that `renameOverlayInError` rewrites the overlay staging-table name in the new message too (the invariant `expectAlterError` pins in `isolation-layer.spec.ts`).

### 5. Tests that pin the old acceptance and must flip

- `ddl-in-transaction-validation.spec.ts`: "sees a pending DELETE" (create unique index, ~158), "sees a pending DELETE" (set collate, ~473), "accepts the change when the only unconvertible value is in a pending-deleted row" (~1075), "accepts the change when the only NULL is in a pending-deleted row" (~1235), "accepts when a pending UPDATE clears the only committed NULL" (~1265). Each becomes an `expectError(..., StatusCode.BUSY, /commit the pending writes first/i)` with a follow-up proving the transaction is still usable and that `commit` then the same DDL succeeds.
- `41.2.1-alter-column-retype-deleted-row-memory.sqllogic`: flip to the refusal, rename without the `-memory` suffix, remove its entry from `MEMORY_ONLY_FILES` in `logic.spec.ts` (both legs now refuse), and drop the stale reference to `bug-retype-of-deleted-row-leaves-wrong-typed-value`.
- `41.7.3-alter-column-retype-unique.sqllogic` § 8: `'1'` and `'01'` both committed, `'01'` deleted, retype to integer — the committed state collides after conversion, so this flips to the refusal (cross-module file; the store leg reaches the same answer through § "Store behind the wrapper" above).
- `quereus-isolation/test/alter-table-conformance.spec.ts` "same-class SET DATA TYPE ignores an illegal value only in a row the transaction deleted" (~661): flips to `BUSY`.
- `quereus-isolation/test/isolation-layer.spec.ts` "ADD CONSTRAINT UNIQUE over a primary-key member ignores in-transaction deletion markers" (~2707): committed `(1,1),(1,2)` collide on `a`, both deleted, `UNIQUE (a)` added — flips to `BUSY`. Keep what the test was really pinning (tombstones are not judged as duplicates of each other) by changing the seed so the committed rows do not collide.
- `41.2.3-alter-column-set-not-null-pk-backfill.sqllogic` § 3 and § 9 already encode compatible answers (rule 3 `BUSY`; a deletion is a before-image, not a duplicate) and should not change.

### 6. New coverage (one test per behaviour, lowest layer that reproduces)

- Memory (`ddl-in-transaction-validation.spec.ts`): case A (rollback to savepoint), case D (update + set not null), case E (update + unique index), case H (released savepoint stays legal), and a "NULL under a DEFAULT in a restorable state is backfilled, not refused" case.
- Cross-module sqllogic (new file in the `41.x` range): cases A–F in SQL so the memory and store legs are asserted identical by the existing runner.
- Isolation (`isolation-layer.spec.ts`): a NULL in an overlay savepoint frame under `set not null … default` refuses (the frame the backfill cannot reach), and case A over `using isolated`.

### 7. Documentation

- `docs/memory-table.md` § DDL and transactions: rewrite rule 1 to the decided rule (effective rows for legality, restorable states for `BUSY`, released savepoints excluded, rewrite-reaches-every-layer for the value arms) and replace the "Rule 1 assumes the transaction commits" paragraph (~624) that points at this ticket.
- `docs/module-authoring.md` § When the pending rows live outside your module: the new `IssuerRowSources` shape, the wrapper's obligation to supply savepoint states, and the receiver's obligation to judge its own committed rows and each state with `BUSY`. The current text says a module "MUST NOT reject the DDL as a constraint violation over a duplicate that exists only in its own committed data" — still true for `CONSTRAINT`; it must now refuse with `BUSY` instead of accepting.
- `docs/module-capabilities.md` non-transactional tier: add the sentence that row-validating DDL refuses when a rollback would break it.
- `docs/store.md` pre-commit validation paragraph (~550): add the committed-rows and savepoint-state passes for the wrapped leg.
- The two NOTEs in `alter-migration.ts` (~884, ~1018).

## TODO

- Define `IssuerRowSources` in `vtab/module.ts`, export it from `index.ts`, and change the four public signatures plus the memory manager's; update every `rows()` call site in the three packages to `rows.effective()`.
- Add the `VirtualTable.savepointRowSources?()` hook and implement it on `MemoryTable` via a new `MemoryTableConnection` accessor over its savepoint stack.
- Memory manager: `rollbackStateRows()`, the shared "judge each state, rewrap as BUSY" helper, and wire it into `createIndex`, `addUniqueConstraint`, `validateRekeyedUniqueStructures`, and the two `alter-column.ts` scans through `AlterColumnContext`.
- Turn the unreachable swallow branches in `convertBaseRows` and `TransactionLayer.convertColumn` into thrown `INTERNAL` errors.
- Isolation: factor `iterateEffectiveRows` to take an overlay-entry source; build `savepoints` in `effectiveRowsFor`; refuse with `BUSY` when the overlay module lacks the hook and the issuer has staged changes under open savepoints; check `BUSY` routing and overlay-name rewriting on the new error; rewrite the two `alter-migration.ts` NOTEs.
- Store (wrapped leg): add the committed-rows and per-savepoint `BUSY` passes to `createIndex` (unique), `alterAddConstraint` (unique), the `set collate` unique re-validation, `alterColumnSetNotNull`, and `alterColumnSetDataType` (which also gains the effective-stream `MISMATCH` pass it is missing; delete the NOTE).
- Flip the tests listed in § 5; add the coverage in § 6; remove `41.2.1` from `MEMORY_ONLY_FILES`.
- Update the docs listed in § 7.
- Run `yarn build`, `yarn lint`, `yarn test`, and `yarn workspace @quereus/quereus test:store` (the wrapped store leg is only exercised there); report any pre-existing failure per the ticket rules.
