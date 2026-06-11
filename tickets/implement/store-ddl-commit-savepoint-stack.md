description: Store DDL-commits (replaceContents / renameTable) clear the coordinator's savepoint stack, so a later `rollback to <savepoint>` / `release <savepoint>` broadcast onto the still-registered StoreConnection throws NOTFOUND (rollback-to) or pads-and-corrupts the stack (release). Make TransactionCoordinator.rollbackToSavepoint and releaseSavepoint warn-and-return on an out-of-range depth, mirroring the memory connection's posture, and pin it with store-vs-memory parity tests.
difficulty: easy
files:
  - packages/quereus-store/src/common/transaction.ts          # FIX: rollbackToSavepoint throws / releaseSavepoint pads on out-of-range depth
  - packages/quereus-store/src/common/backing-host.ts          # replaceContents commit-first (the DDL-commit that clears the stack) — context only
  - packages/quereus-store/src/common/store-module.ts          # renameTable commit-first — context only, same posture
  - packages/quereus/src/vtab/memory/layer/connection.ts       # reference: warn-and-return rollbackToSavepoint (L181-210) + guarded releaseSavepoint (L160-175)
  - packages/quereus/src/core/database.ts                      # _rollbackToSavepointBroadcast / _releaseSavepointBroadcast fan-out (L1313-1358) — NO per-connection try/catch
  - packages/quereus-store/test/transaction.spec.ts            # ADD: coordinator-level unit tests (savepoint ops after a commit-clear)
  - packages/quereus-store/test/mv-store-backing.spec.ts       # ADD: refresh-in-savepoint store-vs-memory parity (mirrors existing DDL-commits parity test, L295-325)

# Store DDL-commits × savepoint stack: tolerate an out-of-range savepoint depth

## Root cause (traced + confirmed)

A store DDL-commit operation commits the per-table `TransactionCoordinator`
mid-transaction, which runs `clearTransaction()` and empties
`savepointStack`. The engine, however, still believes the connection's
savepoints are open and broadcasts later savepoint operations to it.

Exact path for the refresh-in-savepoint repro:

```
rollback to s1
  → runtime/emit/transaction.ts  (case 'rollback', plan.savepoint set)
  → db._rollbackToSavepointBroadcast('s1')                  database.ts:1337
      for (const connection of getAllConnections())
        await connection.rollbackToSavepoint(depth)         ← NO per-connection try/catch
  → StoreConnection.rollbackToSavepoint(0)                  store-connection.ts:53
  → TransactionCoordinator.rollbackToSavepoint(0)           transaction.ts:274
      targetDepth(0) >= savepointStack.length(0)  → throw NOTFOUND   transaction.ts:275-277
```

`replaceContents` cleared the stack a few statements earlier:

```
refresh materialized view mv
  → StoreBackingHost.replaceContents(...)                   backing-host.ts:247
      if (coordinator.isInTransaction()) await coordinator.commit();   ← commit-first (DDL-commits)
  → coordinator.commit() finally { clearTransaction() }     transaction.ts:238,294-301
      savepointStack = []                                   transaction.ts:299
```

Note the broadcast loop has **no per-connection `try/catch`** (unlike
`database-transaction.ts` `rollbackTransaction`, which wraps each connection).
So when the backing connection throws mid-fan-out, sibling connections already
iterated (e.g. the source table `src`, whose own coordinator still holds `s1`)
have already rolled back — partial state plus a user-visible NOTFOUND. Each
store table owns a *separate* coordinator (`StoreModule.coordinators` keyed by
`schema.table`), so only the DDL-committed backing's coordinator has the empty
stack; the source coordinator rolls back normally.

The memory arm survives the identical scenario: `MemoryTableConnection`'s
`replaceBaseLayer` drains in-flight layers (its DDL-commit analogue) and a later
`rollbackToSavepoint` on the out-of-range depth **warns and returns**
(`connection.ts:182-186`), citing "failed savepoint replay" as the anticipated
cause. Final post-commit state converges in both arms (refresh persists, source
insert rolled back) — once the store stops throwing.

### Corollary: `releaseSavepoint` pads-and-corrupts

`TransactionCoordinator.releaseSavepoint` (transaction.ts:269-271) is
unguarded:

```ts
releaseSavepoint(targetDepth: number): void {
  this.savepointStack.length = targetDepth;   // pads with `undefined` when targetDepth > length
}
```

After a DDL-commit clear (`savepointStack = []`), a nested `release s2` at
`targetDepth = 1` sets `length = 1` on an empty array, inserting one
`undefined` slot. That silently corrupts subsequent `rollback-to` / `release`
index lookups. Memory guards exactly this (`connection.ts:164-172`, "Setting
`Array.length` to a value larger than the current length pads with undefined
slots, corrupting subsequent … lookups"). The ticket symptom only exercised
`rollback-to` (single savepoint), but the release path is the same defect and
must be fixed in lockstep.

## Scope (pre-existing, not introduced by the backing host)

`renameTable` (`store-module.ts`, ~L1475-1480) has taken this identical
commit-first posture all along — its comment correctly notes that *subsequent*
`commit()`/`rollback()` calls no-op when not in a transaction, but that
reasoning does NOT extend to `rollbackToSavepoint`/`releaseSavepoint`, which
assume the stack survived. `replaceContents` (refresh / create-fill) inherits
the posture and widens exposure: `alter table rename` inside a savepoint was
obscure; `refresh materialized view` inside a savepoint is plausible. The fix
sits in the coordinator, so it covers both DDL-commit sites uniformly.

## Chosen fix — Option 1: memory parity (warn-and-return)

Of the three options surveyed in the fix ticket, **Option 1 (memory parity)**
is the right call:

- It is the cheapest and matches the store module's *documented* DDL-commits
  posture — `backing-host.ts:230-246` already frames `replaceContents`'
  commit-first as "the store analogue of memory's `replaceBaseLayer`", and the
  existing parity test (`mv-store-backing.spec.ts:295-325`) already asserts
  store ≡ memory for refresh-in-transaction. Extending that parity to
  refresh-in-savepoint is the natural continuation.
- A post-DDL-commit `rollback to savepoint` then degrades to "the DDL and
  everything committed before it stays committed" — exactly what DDL-commits
  means — and the residual imperfection (maintenance ops queued *after* the
  DDL-commit ride a fresh empty stack and a later rollback-to won't discard
  them) is **shared with the memory arm**, so it stays within the parity bar
  and out of scope here.
- The parity test required below validates the fix by construction: it asserts
  the store arm produces byte-identical observable output to the memory arm.

Option 2 (re-seed the stack to the engine's current depth) is more faithful but
needs the coordinator to learn the engine's savepoint depth it does not
currently track — not worth it for behavior memory itself does not provide.
Option 3 (reject DDL inside savepoints) changes user-visible semantics and
diverges from memory, which accepts it.

### Implementation shape

Mirror the memory connection's two guards. The store package has **no
`createLogger`** in scope (`@quereus/quereus` exports only
`enableLogging`/`disableLogging`/`isLoggingEnabled`, not `createLogger`), and
the package's established convention for these warnings is `console.warn` with a
bracketed prefix (see `store-module.ts:1949,2073,2078,2265`). Use
`console.warn('[TransactionCoordinator] …')` to match.

`rollbackToSavepoint` (transaction.ts:274-292) — replace the throw:

```ts
rollbackToSavepoint(targetDepth: number): void {
  if (targetDepth >= this.savepointStack.length) {
    // The coordinator's transaction was committed out from under this savepoint
    // (a store DDL-commit: replaceContents / renameTable cleared the stack) while
    // the engine still broadcasts the savepoint. Warn-and-return mirrors the memory
    // connection (vtab/memory/layer/connection.ts) and degrades to DDL-commits
    // semantics: the committed DDL and everything before it stays committed.
    console.warn(
      `[TransactionCoordinator] rollback-to savepoint depth ${targetDepth} out of range `
        + `(stack size: ${this.savepointStack.length}); transaction was committed out from under it`,
    );
    return;
  }
  // … unchanged truncate + rebuild + preserve-target …
}
```

`releaseSavepoint` (transaction.ts:269-271) — add the matching guard (note the
strict `>`, same as memory: `targetDepth === length` is a legal no-op
truncation, only `targetDepth > length` would pad):

```ts
releaseSavepoint(targetDepth: number): void {
  if (targetDepth > this.savepointStack.length) {
    console.warn(
      `[TransactionCoordinator] release savepoint depth ${targetDepth} out of range `
        + `(stack size: ${this.savepointStack.length}); transaction was committed out from under it`,
    );
    return;
  }
  this.savepointStack.length = targetDepth;
}
```

Keep the `QuereusError`/`StatusCode` import only if still otherwise used in the
file (it is — `put`/`delete`/`getStore` throw MISUSE), so no import churn.

## Tests to pin the behavior

### Coordinator unit tests (`transaction.spec.ts`)

Direct, fast, no engine. Add a `describe('savepoint ops after a commit clear')`:

- `begin → createSavepoint(0) → commit` (clears the stack), then
  `rollbackToSavepoint(0)` does **not** throw (the regression assertion).
- Same setup, then `releaseSavepoint(1)` does **not** pad: after the call,
  `getPendingOpsForStore()` and a fresh `begin → createSavepoint → …` round-trip
  still behave (i.e. no lingering `undefined` slot). The cleanest observable is
  that a follow-up `createSavepoint`/`rollbackToSavepoint` sequence on the same
  coordinator works correctly.
- A genuinely out-of-range depth *within* a live transaction
  (`begin → createSavepoint(0) → rollbackToSavepoint(5)`) also warns-and-returns
  rather than throwing — confirming the guard is depth-uniform, matching memory.

### Engine parity test (`mv-store-backing.spec.ts`)

Mirror the existing `refresh inside an explicit transaction … (DDL-commits
parity)` test (L295-325): same `run(usingClause)` two-arm harness, but the
scenario is

```sql
begin;
savepoint s1;
insert into src values (2, 20);
refresh materialized view mv;   -- DDL-commits: clears the backing coordinator's stack
rollback to s1;                 -- must NOT throw; degrades to DDL-commits semantics
commit;
```

Assert the store arm's `{ mv, src }` deep-equals the memory arm's (parity by
construction). Before the fix, the store arm throws NOTFOUND at `rollback to
s1`; after, both arms converge.

### Plain-table pre-existing-posture case

Add a `renameTable`-in-savepoint case for the pre-existing posture — a
store-backed plain table, `begin; savepoint s1; insert …; alter table t rename
to t2; rollback to s1; commit`, asserting no throw and a sane final state.
`mv-store-backing.spec.ts` is fine for co-location with the parity test, or
`alter-table.spec.ts` if a store-vs-memory rename harness already lives there —
implementer's choice; do not duplicate an existing rename harness.

## TODO

- [ ] `transaction.ts` `rollbackToSavepoint`: replace the NOTFOUND throw with a
      `console.warn` + early return when `targetDepth >= savepointStack.length`
      (keep the truncate/rebuild/preserve-target body unchanged below the guard).
- [ ] `transaction.ts` `releaseSavepoint`: add a `targetDepth > savepointStack.length`
      guard (`console.warn` + return) before the `length = targetDepth` truncation.
- [ ] Update the doc comments on both methods to state the DDL-commit-clears-the-stack
      rationale and the memory-parity reference (point at `vtab/memory/layer/connection.ts`).
- [ ] `transaction.spec.ts`: add the coordinator-level unit tests (rollback-to /
      release after a commit-clear, plus an in-transaction out-of-range depth).
- [ ] `mv-store-backing.spec.ts`: add the refresh-in-savepoint store-vs-memory
      parity test (mirror the L295-325 harness).
- [ ] Add the `alter table rename`-in-savepoint plain-table case (mv-store-backing.spec.ts
      or alter-table.spec.ts).
- [ ] `yarn workspace @quereus/quereus-store test` (and `yarn workspace @quereus/quereus-store run lint`
      if the package has a lint script — only `packages/quereus` is confirmed to).
- [ ] Spot-run `yarn build` for the store package to confirm types.
