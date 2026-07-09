---
description: Fixed a bug where writes were silently thrown away at commit when a storage table reported its own name in a fully-qualified form; the isolation layer now takes a table's identity from the name it was connected under.
prereq:
files: packages/quereus-isolation/src/isolated-table.ts, packages/quereus-isolation/src/isolation-module.ts, packages/quereus/src/vtab/table.ts, packages/quereus-isolation/test/isolation-layer.spec.ts, docs/design-isolation-layer.md
difficulty: medium
---

# Review: isolation overlay keyed off the connect-time table name

## What was wrong

`IsolationModule` keeps two maps that the commit flush crosses between:

| map | key |
|---|---|
| `underlyingTables` | `"<schema>.<table>"` from the `create()` / `connect()` arguments |
| `connectionOverlays` | `"<dbId>:<schema>.<table>"` from `IsolatedTable.schemaName` / `.tableName` |

`IsolatedTable` used to take its own names from the *underlying table object*
(`super(db, module, underlyingTable.schemaName, underlyingTable.tableName)`). `VirtualTable.tableName`
is supposed to be bare, but an underlying module that reports a qualified name there made the two
maps disagree (`main.widget` vs `1:main.main.widget`). At commit, `commitConnectionOverlays` strips
the `<dbId>:` prefix, looks the remainder up in `underlyingTables`, misses, and hits a `continue`
labelled "defensive". The overlay is then cleared with everything else. **Staged rows dropped; commit
reports success.**

## What changed

- **`isolated-table.ts`** — constructor takes `schemaName` / `tableName` ahead of `underlyingTable`
  and passes them to `super()`. Doc comment on the constructor explains why the underlying's
  self-reported names must never be used.
- **`isolation-module.ts`** — all three construction sites updated: `createBacking` (~225) and
  `create` (~651) pass `tableSchema.schemaName` / `tableSchema.name`; `connect` (~693) passes its own
  `schemaName` / `tableName` arguments.
- **`packages/quereus/src/vtab/table.ts`** — `VirtualTable.tableName` now documented as **bare, never
  schema-qualified**, naming the ~20 engine sites that compose `` `${schemaName}.${tableName}` ``
  themselves. `schemaName` got a one-line doc too.
- **`docs/design-isolation-layer.md`** — new subsection under *Per-Connection Overlay Architecture*:
  "Table identity: the connect-time name is authoritative". States the invariant, why the two maps
  must agree by construction, and why `underlyingTable.tableSchema` is *also* not a valid identity
  source (it may be populated lazily).
- **`isolation-layer.spec.ts`** — new `describe('schema-qualified tableName (underlying-advertised)')`
  with a `QualifiedNameMemoryModule` (a `MemoryTableModule` whose tables are Proxy-wrapped to report
  `main.widget` as their `tableName`), keeping the raw tables in a `rawTables` map so a test can read
  storage directly, bypassing the overlay merge.

## Audit of the other identity-keyed paths (TODO item)

All of them read `this.schemaName` / `this.tableName` off `IsolatedTable`, so the constructor fix
corrects every one at a stroke — confirmed by grep, no site derives identity independently:

`getPreOverlaySavepoints`, `getConnectionOverlay` / `setConnectionOverlay` / `clearConnectionOverlay`,
`clearPreOverlaySavepoints`, `coalesceConnectionBuild`, and the three `IsolatedConnection` qualified
names in `buildConnection` (~268) / ~282 / ~312 / ~327 — the last of which was previously registering
the doubled `main.main.widget` with the database. The `` `:${schemaName}.${tableName}` `` suffix scans
in `dropIndex` (~789), `alterTable` (~869) and `rekeyConnectionScopedMap` (~1011) key off the
*module-level* arguments, which were always correct; they now match the overlay keys they scan.

## Validation performed

- `yarn workspace @quereus/isolation run test` → **150 passing, 0 failing** (146 pre-existing + 4 new).
- **The regression tests were verified to bite.** With the old `super(...)` line temporarily restored,
  the suite goes to **147 passing, 3 failing** — 147 is exactly the baseline the source ticket cited.
  The three that fail are `row reached the underlying storage`, the explicit-COMMIT flush, and the
  bare-`tableName` assertion (`expected 'main.widget' to equal 'widget'`).
- `yarn build` (whole workspace) → clean.
- `yarn test` (whole workspace) → clean; no `failing` in output. The `Error: boom` /
  `batch write failed` / `socket write failed` lines in the sync package's output are deliberately
  injected failures inside its own test fixtures, not real failures.
- `yarn lint` → clean.
- `@quereus/isolation` ships an `echo 'No lint configured'` no-op **and** runs mocha under Node's
  native type-stripping, so neither `yarn lint` nor `yarn test` typechecks this package. Ran
  `npx tsc -p tsconfig.json --noEmit` and `npx tsc -p tsconfig.test.json --noEmit` explicitly —
  both exit 0.

## Use cases to exercise

1. **The core invariant.** Any underlying module whose tables self-report a schema-qualified
   `tableName` must still land committed rows in storage. Assert by reading the *underlying* table
   directly (`rawTables.get('main.widget').query(makeFullScanFilterInfo())`), never through
   `db.eval` — the overlay merge masks the bug on the writing connection.
2. Autocommitted single `INSERT`.
3. Explicit `BEGIN` … `COMMIT` mixing `INSERT` / `UPDATE` / `DELETE` (the delete exercises the
   tombstone flush).
4. `ROLLBACK` must still discard — this test passes both with and without the fix; it is a guard
   against over-correcting into "flush on rollback", not a regression test for this bug.
5. `IsolatedTable.tableName` is the bare connect-time name regardless of what the underlying reports.

## Known gaps — please probe these

- **`createBacking` is changed but not covered.** The construction site at `isolation-module.ts:225`
  got the same fix, but no test exercises it: it only exists when the underlying module implements
  `createBacking`, and `MemoryTableModule` does not. Untested by construction, correct by inspection.
- **A test from the source ticket was dropped.** "A second `Database` over the same underlying module
  sees committed rows" cannot be written against `MemoryTableModule`: the second `CREATE TABLE` throws
  `Memory table 'widget' already exists in schema 'main'` from the module's own manager registry,
  before the isolation layer is reached. That is memory-module semantics, not a property of this fix.
  The direct-underlying reads in tests 2–3 cover the same invariant (the row is in storage, not merely
  in the overlay), so the loss is small — but a reviewer wanting the cross-`Database` assertion would
  need a different underlying module, or an attach-existing path.
- **The downstream repro is not verified here.** `lamina-quereus` is not in this repo. The claim that
  this fixes `SiteCAD/tickets/blocked/bug-lamina-scope-logical-view-roundtrip-miss.md` rests on the
  in-repo Proxy standing in for lamina's qualified `LaminaTable.tableName`. Someone should confirm
  downstream.
- **The silent `continue` in `commitConnectionOverlays` (~line 434) is untouched, deliberately.** It is
  still reachable via `destroy()` and `renameTable()`, so turning it into a loud INTERNAL error now
  would convert silent data loss into spurious commit failures. That is `iso-orphaned-overlay-drop-rename`,
  which depends on this ticket. **This means the data-loss mechanism still exists** — this ticket only
  removed the way the isolation layer *triggered* it.
- **Nothing enforces the bare-`tableName` contract.** It is documented on the field and in the design
  doc, but a module can still violate it. The engine composes `` `${schemaName}.${tableName}` `` in
  ~20 places, each of which would silently double the schema. The isolation layer is now immune
  because it no longer reads the field for identity; the rest of the engine is not. Worth a reviewer's
  judgement on whether that deserves its own `debt-` ticket.
- **Breaking change, as sanctioned by AGENTS.md.** The `IsolatedTable` constructor signature changed
  and `index.ts` re-exports the class. No in-repo caller outside `isolation-module.ts` constructs it
  (grepped); external consumers will break. The source ticket anticipated test-suite call sites — there
  are none.
