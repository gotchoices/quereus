----
description: The core query runtime has a hard-coded branch that only knows how to hand a shared connection to the built-in in-memory table type; replace it with a neutral hook any storage plugin can implement so third-party tables get the same treatment and the runtime stops depending on the memory module.
prereq:
files: packages/quereus/src/runtime/utils.ts, packages/quereus/src/vtab/table.ts, packages/quereus/src/vtab/memory/table.ts, packages/quereus/src/vtab/connection.ts, docs/module-authoring.md
difficulty: medium
----

`getVTable` in the module-agnostic runtime (`runtime/utils.ts:135-152`) special-cases
`tableSchema.vtabModuleName === 'memory'`, downcasts the registered connection to
`MemoryVirtualTableConnection` and the fresh vtab instance to `MemoryTable`, checks manager
identity, then calls `memoryTable.setConnection(...)` to inject the existing connection. Two
memory-specific imports (`utils.ts:8-9`) exist only to serve this branch. This bakes one
module's internals into generic runtime code and denies the same connection injection to any
other module.

## Design (resolved — build exactly this)

**Hook surface.** Add an optional method to the `VirtualTable` abstract class
(`vtab/table.ts`), alongside the existing `createConnection` / `getConnection`:

```typescript
/**
 * (Optional) Offered an existing, already-registered connection for this table so the
 * instance can reuse it instead of opening its own. The runtime calls this on a freshly
 * connected instance when a connection for the same qualified table name is already
 * registered; it passes the registered VirtualTableConnection and ignores the result.
 *
 * The module decides whether to adopt: it should downcast to its own connection type,
 * reject connections it did not create (instanceof / brand check) and connections whose
 * backing state no longer matches this instance (e.g. a stale connection from a
 * dropped-then-recreated table), and silently do nothing when it declines.
 *
 * Ownership is NOT transferred: the adopted connection remains owned by the database
 * connection registry that registered it. Adopting it must not make this instance
 * responsible for closing it beyond the module's existing disconnect contract. The hook
 * must be safe to call more than once on the same instance.
 */
adoptConnection?(connection: VirtualTableConnection): MaybePromise<void>;
```

Rationale for placing it on `VirtualTable` (not the module or the connection): it mirrors the
existing `setConnection` / `getConnection` / `createConnection` surface, and the runtime
already holds the vtab instance at the call site. The module, being a stateless factory,
holds no per-instance connection; the connection injecting itself would invert the direction.

**Runtime call site.** Replace the memory-specific block in `getVTable` with a neutral call
and delete the two memory imports (`utils.ts:8-9`):

```typescript
const qualifiedName = `${tableSchema.schemaName}.${tableSchema.name}`;
const existingConnections = ctx.db.getConnectionsForTable(qualifiedName);
if (existingConnections.length > 0) {
	await vtabInstance.adoptConnection?.(existingConnections[0]);
}
```

The runtime keeps taking `existingConnections[0]` (unchanged from today). It has no knowledge
of any concrete module and does nothing when the hook is absent.

**Memory implementation.** Add `adoptConnection` to `MemoryTable` (`vtab/memory/table.ts`)
that reproduces the current guard exactly, then delegates to the existing `setConnection`:

```typescript
adoptConnection(connection: VirtualTableConnection): void {
	if (!(connection instanceof MemoryVirtualTableConnection)) return;
	const existingMemConn = connection.getMemoryConnection();
	if (existingMemConn.tableManager === this.manager) {
		this.setConnection(existingMemConn);
		logger.debugLog(`Adopted existing connection into VirtualTable for table ${this.tableName}`);
	} else {
		logger.debugLog(`Skipped stale connection adoption for table ${this.tableName} (manager mismatch)`);
	}
}
```

This is behavior-preserving: the old runtime block did the same `getMemoryConnection` +
`tableManager === manager` check before `setConnection`. `setConnection` stays as-is (it is
also used elsewhere). Ownership is unchanged — an adopted `MemoryTableConnection` is the
manager/registry's; `disconnect()` still detaches it from the manager while the DB registry
entry survives and later reuse re-attaches it (`table.ts:76-129` documents this contract).

**Prepared-statement-overhead ticket interaction (`runtime-prepared-statement-overhead`).**
That ticket wants the nested-loop-join inner to stop reconnecting per outer row. This hook is
the module-neutral seam it will reuse, not a competing mechanism: this ticket does not change
how often `getVTable` is called, only how injection is expressed. The two are complementary.
The `adoptConnection` contract above is written to be idempotent (safe to call repeatedly) so
that inner-loop connection reuse can lean on it later. No coupling change is made here; do not
try to solve the per-inner-row reconnect in this ticket.

## Edge cases & interactions

- **No registered connection** — `existingConnections` empty → hook not called. Parity with today.
- **Module without the hook** — optional-chain no-op. Every non-memory in-tree module (e.g.
  `quereus-store` tables) behaves exactly as before, since the old branch never fired for them.
- **Stale connection (manager mismatch)** — memory's guard skips + logs; must match the old
  `manager` identity check so a dropped-then-recreated table never adopts the old connection.
- **Wrong connection subtype** — `instanceof MemoryVirtualTableConnection` guard rejects a
  connection some other module registered under the same qualified name (cross-module safety).
- **Committed-snapshot / `readCommitted` memory instance** — the old name-check ran for these
  instances too; keep parity so committed-snapshot reads are unaffected. Verify a
  committed-snapshot table still reads committed state after the refactor (do not silently add
  a `readCommitted` guard that the old code lacked).
- **Idempotency** — calling `adoptConnection` twice on one instance must be safe (second call
  re-sets the same connection). Needed for future NLJ reuse.
- **Multiple registered connections** — runtime uses `[0]`, unchanged.
  `// NOTE: getVTable adopts existingConnections[0]; if covering-connection semantics ever`
  `// matter here (cf. isCovering in connection.ts / DeferredConstraintQueue), prefer the`
  `// covering connection.` Record this as a code comment at the call site, not a ticket.

## TODO

- Add `adoptConnection?(connection: VirtualTableConnection): MaybePromise<void>` to the
  `VirtualTable` abstract class in `packages/quereus/src/vtab/table.ts`, documented as above.
- In `packages/quereus/src/runtime/utils.ts`: delete the memory imports (lines 8-9), replace
  the `=== 'memory'` block (lines 140-151) with the neutral `await vtabInstance.adoptConnection?.(...)`
  call, and add the `isCovering` NOTE comment at the call site.
- Implement `adoptConnection` on `MemoryTable` in `packages/quereus/src/vtab/memory/table.ts`
  (guard + delegate to existing `setConnection`).
- Grep-verify no `=== 'memory'` remains in `runtime/`, and `utils.ts` no longer imports
  `MemoryVirtualTableConnection` / `MemoryTable`.
- Update `docs/module-authoring.md` § Connection Registration / "Connection reuse pattern"
  (~lines 646-727) to document the `adoptConnection` hook: what it receives, that the module
  owns the accept/reject decision (instanceof + state-match), that ownership is not
  transferred, and that it must be idempotent.
- Run `yarn build`, then `yarn test` (memory-backed) and `yarn lint` in `packages/quereus`.
  Transaction-reuse and isolation logic tests exercise the injection path; they must stay
  green. Add or confirm a test that two references to the same memory table inside one
  statement share a connection, and a committed-snapshot read test.
