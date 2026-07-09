---
description: When a storage table reports its own name in a fully-qualified form, writes committed through the isolation layer are silently thrown away instead of saved — reads on the same connection still show the data, so the loss is invisible until something else tries to read it.
prereq:
files: packages/quereus-isolation/src/isolated-table.ts (constructor ~line 77), packages/quereus-isolation/src/isolation-module.ts (create ~640, connect ~661, createBacking ~221, commitConnectionOverlays ~418, makeConnectionOverlayKey ~516), packages/quereus/src/vtab/table.ts (VirtualTable.tableName field ~line 53), packages/quereus-isolation/test/isolation-layer.spec.ts, docs/design-isolation-layer.md
difficulty: medium
---

# Isolation overlay must be keyed off the connect-time table name, not the underlying's self-reported name

## What goes wrong

`IsolationModule` stages every uncommitted write in a per-connection *overlay* table, and
flushes that overlay into the real storage table at commit. It keeps two maps:

| map | key |
|---|---|
| `underlyingTables` | `"<schema>.<table>"` from the `connect()` / `create()` arguments |
| `connectionOverlays` | `"<dbId>:<schema>.<table>"` from `IsolatedTable.schemaName` / `.tableName` |

`IsolatedTable` takes its own `schemaName` / `tableName` from the *underlying table object*:

```ts
// isolated-table.ts:84
super(db, module as any, underlyingTable.schemaName, underlyingTable.tableName);
```

`VirtualTable.tableName` is supposed to be the **bare** table name. If an underlying module
instead reports a qualified name there (`"store.widget"` rather than `"widget"`), the two maps
disagree:

- `underlyingTables` key → `store.widget`
- `connectionOverlays` key → `1:store.store.widget`   ← schema doubled

At commit, `commitConnectionOverlays` strips the `<dbId>:` prefix and looks the remainder up in
`underlyingTables`. The lookup misses, and:

```ts
const underlyingState = this.underlyingTables.get(underlyingKey);
if (!underlyingState) continue; // no underlying to flush (defensive)
```

…the `continue` fires, the overlay is never applied, and the loop at the bottom of the method
clears every overlay for the db anyway. The staged rows are dropped. **The commit reports
success.**

The comment calls that `continue` "defensive". It is not defensive — it is the mechanism by
which committed data is discarded without a word.

## Confirmed reproduction

Verified in-repo. An underlying module whose tables report a schema-qualified `tableName` is
enough; nothing about the downstream lamina/SiteCAD stack is required. The test below fails on
`main` (0 rows in storage) and passes with the fix:

```ts
/** Wraps a VirtualTable so it self-reports a schema-qualified tableName. */
function qualify(table: VirtualTable): VirtualTable {
	return new Proxy(table, {
		get(target, prop, receiver) {
			if (prop === 'tableName') return `${target.schemaName}.${target.tableName}`;
			const v = Reflect.get(target, prop, receiver);
			return typeof v === 'function' ? v.bind(target) : v;
		},
	}) as VirtualTable;
}

// A module that delegates to MemoryTableModule but hands back `qualify(table)`
// from create()/connect(), and keeps the raw tables in a `tables` map.
class QualifiedNameModule implements VirtualTableModule<VirtualTable, BaseModuleConfig> { /* … */ }

it('committed insert lands in the underlying table', async () => {
	await db.exec(`create table widget (id integer primary key, name text) using isolated`);
	await db.exec(`insert into widget values (1, 'a')`);

	// Read through the isolation layer (overlay merge) — this sees the row.
	const viaIso = await asyncIterableToArray(db.eval(`select * from widget`));
	expect(viaIso.map(r => r.id)).to.deep.equal([1]);

	// Read the underlying directly — this is where the row must actually be.
	const underlying = underlyingModule.tables.get('main.widget')!;
	const rows: Row[] = [];
	for await (const row of underlying.query!(makeFullScanFilterInfo())) rows.push(row);
	expect(rows, 'row reached the underlying storage').to.have.lengthOf(1);   // ← fails on main: 0
});
```

Observed on `main`: `visible via isolation layer` passes, `row reached the underlying storage`
fails with `0` vs expected `1`. Consequences: a second `Database` over the same storage sees
nothing; the storage's own derived relations (materialized views, basis-member relations) see
nothing; the data is gone once the `Database` closes.

Originally surfaced downstream in SiteCAD, where a logical (lens) view over a lamina basis table
returned zero rows even though the basis row was countable — see
`SiteCAD/tickets/blocked/bug-lamina-scope-logical-view-roundtrip-miss.md`. `lamina-quereus` is
not in this repo; it deliberately stores the qualified name in `LaminaTable.tableName` because it
uses that field as a catalogue/projector lookup key.

## Fix

**Verified working.** `IsolationModule.connect()` / `.create()` already hold the authoritative
`(schemaName, tableName)` — the very pair `underlyingTables` is keyed by. Thread that pair into
`IsolatedTable`'s constructor and let it key its overlay off that, instead of off
`underlyingTable.schemaName` / `underlyingTable.tableName`:

```ts
constructor(
	db: Database,
	module: IsolationModule,
	schemaName: string,
	tableName: string,
	underlyingTable: VirtualTable,
	readCommitted: boolean = false
) {
	super(db, module as any, schemaName, tableName);
	// …
}
```

…and update the three construction sites in `isolation-module.ts`:

- `createBacking` (~line 225) → `new IsolatedTable(db, this, tableSchema.schemaName, tableSchema.name, underlyingTable)`
- `create` (~line 649) → same
- `connect` (~line 689) → `new IsolatedTable(db, this, schemaName, tableName, state.underlyingTable, readCommitted)`

This keeps both maps on one identity by construction, and tolerates any underlying that reports a
non-bare `tableName`. With this change the full isolation suite passes (147 tests) plus the new
regression test.

Rejected alternative: key off `underlyingTable.tableSchema.schemaName` / `.name`. It happens to
be bare for lamina, but `IsolatedTable`'s own constructor notes that `tableSchema` "may be
populated lazily by the underlying module" — so this reintroduces the same class of bug for any
underlying with a lazily-populated schema.

Note this changes the `IsolatedTable` constructor signature, which `index.ts` re-exports. Per
AGENTS.md we are not maintaining backwards compatibility yet, so that is acceptable — but the
test suite constructs `IsolatedTable` directly in places, so update those call sites.

## The `VirtualTable.tableName` contract

The engine treats this field as **bare** throughout — it builds qualified names by
`` `${schemaName}.${tableName}` `` in ~20 places (`database-events.ts`, `key-filter.ts`,
`alter-table.ts`, `manager.ts`, …). Declare bare as the contract and document it on the field in
`packages/quereus/src/vtab/table.ts`. lamina's overload of the field is then a (downstream)
contract violation, but the isolation layer must not respond to it by discarding committed rows —
after this fix it does not, because it no longer reads that field for identity.

## Follow-on

The missing-underlying `continue` in `commitConnectionOverlays` should become a loud INTERNAL
error, but **not in this ticket** — it is reachable today via `destroy()` and `renameTable()`,
so turning it into a throw before those are fixed converts silent data loss into spurious commit
failures. That work is `iso-orphaned-overlay-drop-rename`, which depends on this ticket.

## TODO

- Add `schemaName` / `tableName` parameters to the `IsolatedTable` constructor, ahead of
  `underlyingTable`, and pass them to `super()` instead of the underlying's self-reported names.
- Update the three construction sites in `isolation-module.ts` (`createBacking`, `create`,
  `connect`) and any direct `new IsolatedTable(...)` in the test suite.
- Document the bare-name contract on `VirtualTable.tableName` in
  `packages/quereus/src/vtab/table.ts`.
- Add the regression test above to `isolation-layer.spec.ts`: an underlying whose `tableName` is
  schema-qualified; a committed insert must be visible **through the underlying**, not merely
  through the overlay merge.
- Audit the other identity-keyed paths now that `IsolatedTable`'s names are authoritative, and
  confirm each is consistent: the connection name in `buildConnection` /
  `getConnectionsForTable` (which came out doubled — `registerConnection(store.store.widget)`),
  `getPreOverlaySavepoints`, `coalesceConnectionBuild`, and the `` `:${schemaName}.${tableName}` ``
  suffix scans at `dropIndex` (~785), `alterTable` (~865), and `rekeyConnectionScopedMap` (~1011).
- Note the decided contract in `docs/design-isolation-layer.md`.
- `yarn test` (whole workspace) must stay green.
