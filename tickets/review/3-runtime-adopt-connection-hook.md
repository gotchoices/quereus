description: The query runtime no longer special-cases the built-in in-memory table type when handing an existing shared connection to a freshly-connected table; instead it offers the connection through a neutral hook any storage plugin can implement, so third-party tables get the same connection reuse.
prereq:
files: packages/quereus/src/runtime/utils.ts, packages/quereus/src/vtab/table.ts, packages/quereus/src/vtab/memory/table.ts, packages/quereus/src/vtab/memory/connection.ts, packages/quereus/src/vtab/connection.ts, docs/module-authoring.md
difficulty: medium
----

## What changed

Removed the `vtabModuleName === 'memory'` branch from `getVTable`
(`runtime/utils.ts`) and the two memory-only imports it needed. Replaced it with a
module-neutral hook the runtime calls on a freshly-connected instance when a connection
for the same qualified table name is already registered.

**New optional hook** on the `VirtualTable` abstract class (`vtab/table.ts`), alongside
`createConnection` / `getConnection`:

```typescript
adoptConnection?(connection: VirtualTableConnection): MaybePromise<void>;
```

- Runtime holds the vtab instance at the call site, so the hook lives on `VirtualTable`
  (not the module — a stateless factory — nor the connection).
- Module owns the accept/reject decision: downcast to its own connection type, reject
  connections it didn't create and connections whose backing state no longer matches this
  instance, silently no-op when it declines.
- Ownership is **not** transferred — the connection stays owned by the DB connection
  registry. Hook must be idempotent (safe to call twice).

**Runtime call site** (`runtime/utils.ts:133-143`), unchanged semantics — still takes
`existingConnections[0]`, does nothing when the hook is absent:

```typescript
const existingConnections = ctx.db.getConnectionsForTable(qualifiedName);
if (existingConnections.length > 0) {
	await vtabInstance.adoptConnection?.(existingConnections[0]);
}
```

An `isCovering` NOTE comment is parked at the call site (see Tripwires below).

**Memory implementation** (`vtab/memory/table.ts`, `adoptConnection` after
`setConnection`). Behavior-preserving: reproduces the old runtime guard exactly, then
delegates to the existing `setConnection`. The `instanceof MemoryVirtualTableConnection`
guard is strictly stronger than the old `memoryConnection.getMemoryConnection &&
memoryTable.setConnection` truthy checks — it guarantees both methods exist.

```typescript
adoptConnection(connection: VirtualTableConnection): void {
	if (!(connection instanceof MemoryVirtualTableConnection)) return;
	const existingMemConn = connection.getMemoryConnection();
	if (existingMemConn.tableManager === this.manager) {
		this.setConnection(existingMemConn);
		...
	} else { ... }
}
```

**Docs**: `docs/module-authoring.md` § Connection Registration gained an "Adopting a
runtime-offered connection (`adoptConnection`)" subsection after the existing
"Connection reuse pattern" — push vs. pull framing, the accept/reject contract,
ownership-not-transferred, idempotency.

## Why it's behavior-preserving

The old branch did `getMemoryConnection()` + `tableManager === manager` check before
`setConnection`; the new memory hook does the identical check + delegate. Same guard, same
`setConnection`, same stale-connection skip + log. `setConnection` untouched (used
elsewhere). Committed-snapshot (`readCommitted`) instances hit the same name-check as
before — no new `readCommitted` guard was added (the old code lacked one; parity kept).

## Validation done

- `yarn build` (quereus) — EXIT=0, clean.
- `yarn test` (quereus, memory-backed) — **6879 passing, 9 pending, 0 failing**.
- `yarn lint` (quereus: eslint + `tsc -p tsconfig.test.json`) — EXIT=0, clean.
- Grep-verified: no `=== 'memory'` and no `MemoryVirtualTableConnection`/`MemoryTable`
  reference remains in `runtime/utils.ts`. (Unrelated `MemoryTableModule` references
  survive in `runtime/emit/alter-table.ts` + `materialized-view-helpers.ts` — the ALTER
  TABLE rebuild path, never the connection-injection branch this ticket touched.)

### Coverage — where the injection path is exercised

The refactored path (`getVTable` → `adoptConnection`) fires when a statement materializes a
second `VirtualTable` instance for a table that already has a registered connection — i.e.
self-joins / correlated references reading in-flight transaction state, and transaction
reuse. These are exercised by the existing green suite:

- `test/logic/04-transactions.sqllogic`, `test/logic/101-transaction-edge-cases.sqllogic`
  — transaction reuse / read-your-own-writes.
- `test/logic/23-self-joins-duplicates.sqllogic`, `test/logic/26-join-edge-cases.sqllogic`
  — same table referenced twice in one statement.
- `test/logic/42-committed-snapshot.sqllogic` — committed-snapshot reads (verifies the
  `readCommitted` instance still reads committed state after the refactor).
- `test/vtab/concurrency-mode.spec.ts` — memory-vtab shared-connection scan smoke.

## Known gaps / where to push (reviewer: treat tests as a floor)

- **No focused unit test was added for `adoptConnection` in isolation.** Coverage is
  transitive through the logic suite above. A reviewer wanting tighter guards should add a
  direct unit test on `MemoryTable.adoptConnection` asserting the three contract points
  that are currently only implied: (a) a foreign `VirtualTableConnection` (non-memory
  subtype) is rejected — no-op, no throw; (b) a manager-mismatch connection is skipped
  (stale, dropped-then-recreated table); (c) **idempotency** — calling it twice with the
  same connection re-sets cleanly. Idempotency in particular is the property the future
  `runtime-prepared-statement-overhead` (NLJ inner-loop reuse) ticket will lean on, and
  nothing asserts it at unit granularity today.
- **Store path not run.** Validation was memory-only (`yarn test`, not `yarn test:store`).
  `quereus-store` tables do not implement `adoptConnection`, so they fall to the runtime's
  optional-chain no-op — parity with the old branch, which never fired for non-memory
  modules. Worth a reviewer confirming a store-backed self-join/transaction still behaves
  (should be unaffected by construction, but unexercised here).
- **Two pre-existing editor hints, not introduced by this diff, not touched:**
  `runtime/utils.ts` `disconnectVTable(ctx, …)` flags `ctx` unused (the original function
  never used it either; the parameter is part of the call signature), and
  `vtab/memory/table.ts` `rename` flags `await` has no effect on `manager.renameTable`.
  Both are hint-level (`★`), pre-date this ticket, and pass build+lint. Left as-is to keep
  the diff scoped; flag if you'd prefer them cleaned in a follow-up.

## Tripwires (parked, not tickets)

- **Multiple registered connections at the call site.** Runtime adopts
  `existingConnections[0]`, unchanged from before. Parked as a `// NOTE:` code comment at
  `runtime/utils.ts:139-141`: if covering-connection semantics ever matter here (cf.
  `isCovering` on `VirtualTableConnection` in `vtab/connection.ts`, used by
  `DeferredConstraintQueue`), prefer the covering connection over `[0]`. Fine now — no
  in-tree path registers multiple connections under one qualified name where `[0]` is the
  wrong pick.
