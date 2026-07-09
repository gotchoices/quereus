---
description: Fixed a bug where a transaction's writes were silently thrown away at commit when a storage module reported its own table name in a fully-qualified form; the isolation layer now takes a table's identity from the name it was connected under.
prereq:
files: packages/quereus-isolation/src/isolated-table.ts, packages/quereus-isolation/src/isolation-module.ts, packages/quereus/src/vtab/table.ts, packages/quereus-isolation/test/isolation-layer.spec.ts, docs/design-isolation-layer.md
difficulty: medium
---

# Isolation overlay keyed off the connect-time table name

## What was wrong

The isolation layer keeps two maps and the commit flush crosses between them:

| map | keyed by |
|---|---|
| `underlyingTables` | `"<schema>.<table>"`, from the `create()` / `connect()` arguments |
| `connectionOverlays` | `"<connectionId>:<schema>.<table>"`, from `IsolatedTable.schemaName` / `.tableName` |

`IsolatedTable` took its own names from the underlying table object
(`super(db, module, underlyingTable.schemaName, underlyingTable.tableName)`). `VirtualTable.tableName`
is contracted bare, but a storage module that reports a schema-qualified name there made the two maps
disagree (`main.widget` vs `1:main.main.widget`). At commit, `commitConnectionOverlays` strips the
connection-id prefix, looks the remainder up in `underlyingTables`, misses, and hits a `continue`
labelled "defensive" — staged rows dropped, commit reports success.

## What changed

- **`isolated-table.ts`** — constructor now takes `schemaName` / `tableName` ahead of `underlyingTable`
  and passes them to `super()`. All four qualified-name compositions inside the class (connection
  registration and `IsolatedConnection` naming, ~268/282/312/327) follow from `this.schemaName` /
  `this.tableName`, so they are corrected at a stroke; the last of them was previously registering
  the doubled `main.main.widget` with the database.
- **`isolation-module.ts`** — all three construction sites pass the connect-time pair: `createBacking`
  (~225) and `create` (~651) pass `tableSchema.schemaName` / `tableSchema.name`; `connect` (~693)
  passes its own arguments.
- **`packages/quereus/src/vtab/table.ts`** — `VirtualTable.tableName` documented as bare, never
  schema-qualified, naming the real consumers that compose the qualified form.
- **`docs/design-isolation-layer.md`** — new subsection "Table identity: the connect-time name is
  authoritative" under *Per-Connection Overlay Architecture*.
- **`isolation-layer.spec.ts`** — new `describe('schema-qualified tableName (underlying-advertised)')`
  with a `QualifiedNameMemoryModule` whose tables are Proxy-wrapped to report `main.widget` as their
  `tableName`, keeping the raw tables in a `rawTables` map so tests can read storage directly,
  bypassing the overlay merge.

## Review findings

### Checked

Read the implementation diff before the handoff summary. Verified: every `IsolatedTable` construction
site (grep — three, all fixed); every identity-keyed lookup in the module (`getPreOverlaySavepoints`,
the three `connectionOverlay` accessors, `clearPreOverlaySavepoints`, `coalesceConnectionBuild`,
the four qualified-name compositions in `isolated-table.ts`) — all read `this.schemaName` /
`this.tableName`, so all follow from the constructor fix; no site derives identity independently.
Case handling agrees: both maps lowercase their keys, and the fix leaves the original case on the
fields. The suffix scans in `dropIndex` / `alterTable` / `rekeyConnectionScopedMap` key off the
module-level arguments, which were always correct. Confirmed no remaining read of
`underlyingTable.schemaName` / `.tableName` anywhere in the package; the surviving reads of
`underlyingTable.tableSchema` are column-layout reads, not identity.

Reran the implementer's bite-check: with the old `super(...)` line restored, three of the four new
tests fail. They do test the fix.

### Found and fixed in this pass

- **The new doc comment on `VirtualTable.tableName` named the wrong files.** It claimed the engine
  composes `` `${schemaName}.${tableName}` `` at "~20 sites: database-events.ts, key-filter.ts,
  alter-table.ts, schema/manager.ts". None of those read `VirtualTable.tableName` — they qualify
  names sourced from `TableSchema`, the AST, or event payloads. A reader following the comment finds
  nothing. Rewrote it against the actual consumers: `vtab/memory/table.ts` and
  `quereus-store/src/common/store-table.ts` name the `VirtualTableConnection` they register, and
  `runtime/deferred-constraint-queue.ts` matches that name against `<schema>.<table>` when resolving a
  connection — so a doubled name never matches. Plus the isolation layer's own overlay keys.

- **`createBacking` was fixed but uncovered**, as the handoff flagged. Added
  `createBacking keys the wrapper off the tableSchema, not the underlying qualified name`: gives the
  qualifying test module a `createBacking`, calls the forward directly, and asserts both that the
  wrapper reports the bare name and that `getUnderlyingState('main', 'src_backing')` resolves — i.e.
  that the wrapper's identity and the map key the same call registered actually agree. Verified it
  bites: reverting that one site to the underlying's names fails it with
  `expected 'main.src_backing' to equal 'src_backing'`.

### Found and filed as a new ticket

- **`tickets/fix/iso-rename-in-txn-never-flushes-staged-rows.md`** — the handoff noted that the silent
  `continue` in `commitConnectionOverlays` was left in place, that this ticket only removed the
  isolation layer's own way of reaching it, and that the remaining reachability (`destroy()`,
  `renameTable()`) belonged to a follow-up ticket named `iso-orphaned-overlay-drop-rename`. **That
  ticket was never filed** — it exists nowhere on the board. So the data-loss mechanism was live and
  untracked.

  Reproduced it, since a claimed-reachable path deserves a repro rather than a handoff sentence:
  `begin; insert; alter table t rename to t2; commit` reports success, `select … from committed.t2`
  returns zero rows, and the abandoned staging area is left in `connectionOverlays` where it keeps
  merging into subsequent reads — so a plain `select` on the writing connection still shows the row
  and hides the loss. `renameTable` evicts the storage handle for the old name and never registers one
  under the new name; if nothing reconnects before commit, the crossover lookup misses. Reachable
  today, three distinct symptoms (write lost, commit lies, loss masked). Filed into `fix/` with the
  repro, the mechanism, and the two candidate fix shapes.

### Recorded as a tripwire, not a ticket

- **Nothing enforces the bare-`tableName` contract at runtime.** Every in-repo module complies, so
  this is conditional, not a defect. Parked as a `NOTE:` on the field's doc comment in
  `packages/quereus/src/vtab/table.ts` — if third-party modules start violating it, assert bareness in
  the `VirtualTable` constructor rather than hardening each consumer.

### Considered and deliberately not actioned

- **The cross-`Database` test the source ticket asked for** ("a second `Database` over the same storage
  module sees committed rows") remains unwritten. The handoff's reasoning holds: the second
  `CREATE TABLE` throws from the memory module's own registry before the isolation layer is reached.
  The direct-storage reads in the other tests assert the same invariant (the row is in storage, not
  merely staged), so this buys nothing that is not already covered.

- **The downstream `lamina-quereus` repro is still unverified**, because that package is not in this
  repo. Unchanged from the handoff; someone with that tree should confirm. The in-repo Proxy test
  reproduces the mechanism faithfully, which is as far as this repo can go.

- **The `IsolatedTable` constructor signature change** is a breaking change for external consumers
  (the class is re-exported from `index.ts`). Sanctioned by AGENTS.md § "Backwards compat: don't worry
  yet". No in-repo caller outside `isolation-module.ts` constructs it.

## Validation

- `yarn workspace @quereus/isolation run test` → 151 passing, 0 failing (146 before this ticket's
  tests, +4 from implement, +1 from review).
- `npx tsc -p tsconfig.json --noEmit` and `npx tsc -p tsconfig.test.json --noEmit` in
  `packages/quereus-isolation` → both exit 0. Needed explicitly: that package's `lint` is an
  `echo 'No lint configured'` no-op and its mocha run uses Node's type-stripping, so neither
  `yarn lint` nor `yarn test` typechecks it.
- `yarn build`, `yarn lint`, `yarn test` at the workspace root → all clean. The one `failing` match in
  the test log is a fixture named `failingKv` in the sync package, not a failure.
