---
description: When an isolation-wrapped table's storage reports its own name in a fully-qualified form, committed writes are silently thrown away instead of being saved — reads on the same connection still show the data, so the loss is invisible until something else tries to read it.
prereq:
files: packages/quereus-isolation/src/isolation-module.ts (commitConnectionOverlays ~line 418, makeConnectionOverlayKey ~516, setUnderlyingState/getUnderlyingState ~310-330), packages/quereus-isolation/src/isolated-table.ts (constructor ~line 77), packages/quereus-isolation/test/isolation-layer.spec.ts
difficulty: medium
---

# quereus-isolation: commit flush is silently skipped when the underlying table's `tableName` is schema-qualified

## Symptom

Every write through `IsolationModule` over such a table stays in the per-connection
overlay **forever**. Nothing throws. Reads on the same `Database` merge the overlay,
so the data looks present. But:

- a second `Database` over the same storage sees **nothing**,
- the storage's own derived relations (materialized views, per-column basis member
  relations, anything reading the underlying directly) see **nothing**,
- the data is gone after the `Database` is closed.

Discovered downstream in SiteCAD: a logical (lens) view over a lamina basis table
returned zero rows even though the basis row was countable. See
`SiteCAD/tickets/blocked/bug-lamina-scope-logical-view-roundtrip-miss.md` for the
originating report; the lens miss is only the most visible face of it.

## Root cause — two different keys for the same table

`IsolationModule` keeps two maps:

| map | key built from |
|---|---|
| `underlyingTables` | the `(schemaName, tableName)` that `connect()` / `create()` were called with (`setUnderlyingState`, line ~310) |
| `connectionOverlays` | `` `${dbId}:${this.schemaName}.${this.tableName}` `` on the **`IsolatedTable`** (`makeConnectionOverlayKey`, line ~516) |

`IsolatedTable`'s own `schemaName` / `tableName` are taken from the *underlying table
object*, not from the connect arguments:

```ts
// isolated-table.ts:84
super(db, module as any, underlyingTable.schemaName, underlyingTable.tableName);
```

`VirtualTable.tableName` is expected to be the **bare** name. lamina's `LaminaTable`
deliberately stores the **qualified** name there (`packages/lamina-quereus/src/table.ts`,
`new LaminaTable({ tableName: collectionHandle.name, ... })` — the comment says
"`LaminaTable.tableName` is the catalogue/projector lookup key — must carry the
qualified name (`s1.items`) … The bare name lives on `tableSchema.name`").

So for a lamina table in schema `store` named `widget`:

- `underlyingTables` key → `store.widget`
- `connectionOverlays` key → `1:store.store.widget`   ← schema doubled

`commitConnectionOverlays` (line ~418) strips the `<dbId>:` prefix and looks the
remainder up in `underlyingTables`:

```ts
const underlyingKey = key.slice(prefix.length);      // "store.store.widget"
const underlyingState = this.underlyingTables.get(underlyingKey);
if (!underlyingState) continue;   // no underlying to flush (defensive)  ← silently skips
```

The lookup misses, the `continue` fires, the overlay is never applied — and then the
loop at the bottom **clears every overlay for the db anyway**, so the staged rows are
dropped. The commit reports success.

That `continue` is commented "defensive". It is not defensive; it is the mechanism by
which committed data is discarded without a word.

## Reproduction

Verified against a real lamina basis (SiteCAD's `openScope` + `IsolationModule`), but
it needs nothing from lamina — any underlying `VirtualTable` whose `tableName` getter
returns `"<schema>.<table>"` reproduces it. Minimal shape:

- Stand up a `Database`, register `new IsolationModule({ underlying: M })` where `M`'s
  tables report `tableName = 'store.widget'` and `schemaName = 'store'`.
- `insert into store.widget …` (autocommit or explicit `begin`/`commit` — both).
- Read `store.widget` on the same db → the row appears (overlay merge).
- Read the same storage through a *second* `Database` (or inspect the underlying
  directly) → empty.

Instrumenting the module confirms `IsolatedConnection.commit()` runs and
`commitConnectionOverlays()` is entered, but the underlying table's `begin()` /
`update()` are never called. Mirroring each `underlyingTables` entry under the doubled
key makes the flush land and the row appear everywhere — a one-line confirmation of the
diagnosis.

## Hypotheses for the fix

Preferred: **stop deriving the overlay key from the underlying table's self-reported
name.** `IsolationModule.connect()` / `.create()` already know the authoritative
`(schemaName, tableName)` — the same pair `underlyingTables` is keyed by. Thread that
pair into `IsolatedTable`'s constructor and let it key its overlay off that, rather
than off `underlyingTable.schemaName` / `underlyingTable.tableName`. This keeps both
maps on one identity by construction, and it tolerates any underlying that reports a
non-bare `tableName`.

Alternative (weaker): key off `underlyingTable.tableSchema.schemaName` / `.name`, which
is bare for lamina. This works but reintroduces the same class of bug for any underlying
whose `tableSchema` is populated lazily (the `IsolatedTable` constructor already notes
`tableSchema` "may be populated lazily by the underlying module").

Independent of which: **the `if (!underlyingState) continue` must become a loud
`QuereusError(..., StatusCode.INTERNAL)`.** A staged overlay with `hasChanges` and no
resolvable underlying is an invariant violation, and silently dropping the rows is the
worst possible response. The same applies to the overlay-clearing loop at the bottom —
it must not clear an overlay that was never applied.

Also worth a look while in here: the connection names registered for these tables come
out doubled too (`registerConnection(store.store.widget)`), which suggests the qualified
`tableName` leaks into other identity-sensitive paths.

## Whose contract is wrong?

Arguable. lamina knowingly overloads `VirtualTable.tableName` to carry the qualified
name. If `VirtualTable.tableName` is contractually bare, lamina should be corrected and
this ticket becomes "make isolation fail loudly instead of silently". If the field is
tolerant, isolation must not use it as an identity key. Either way, isolation should not
respond to the mismatch by discarding committed rows — decide the contract, document it
on `VirtualTable.tableName`, and make the violation an error rather than data loss.

## TODO

- Decide + document the `VirtualTable.tableName` contract (bare vs. qualified).
- Thread the connect-time `(schemaName, tableName)` into `IsolatedTable` and key
  `connectionOverlays` off it, so it cannot diverge from `underlyingTables`.
- Turn the missing-underlying `continue` in `commitConnectionOverlays` into an INTERNAL
  error; ensure no overlay is cleared unless it was applied (or was empty).
- Audit the other identity-keyed paths for the same divergence (connection names,
  `getConnectionsForTable`, savepoint sets, the `:${schemaName}.${tableName}` suffix
  scans at lines ~785, ~865, ~1011).
- Regression test in `isolation-layer.spec.ts`: an underlying whose `tableName` is
  schema-qualified — a committed insert must be visible through the underlying, not
  merely through the overlay.
