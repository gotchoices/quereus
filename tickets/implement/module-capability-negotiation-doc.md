description: Write the VirtualTableModule capability-negotiation inventory + the agreed single negotiation pattern into docs/module-authoring.md, and refresh that doc's stale `SchemaChangeInfo` section. This is the findings/recommendation deliverable of the module-capability-consistency-audit survey — pure documentation, no engine code changes.
files: docs/module-authoring.md, packages/quereus/src/vtab/module.ts, packages/quereus/src/vtab/capabilities.ts, packages/quereus/src/runtime/emit/alter-table.ts, packages/quereus/src/planner/nodes/reference.ts, packages/quereus-store/src/common/store-module.ts, packages/quereus/src/vtab/memory/module.ts, packages/quereus-isolation/src/isolation-module.ts
----

## Why

The `module-capability-consistency-audit` survey found that the `VirtualTableModule`
contract signals capability three different ways with no single rule, and that the
unsupported-path handling ranges from clean negotiated rejection to **silent divergence**
(the store's PK-column `SET COLLATE` no-op). This ticket records the inventory and the
agreed negotiation pattern in the authoring guide so future module authors and reviewers
have one reference, and fixes the guide's `SchemaChangeInfo` section, which is materially
out of date.

The survey is fully resolved — the inventory and recommendation below are the finished
research, not a starting point. This ticket only transcribes them into docs.

## Background: the three signaling styles (as-found)

| Signaling | Members | Engine consults it? |
| --- | --- | --- |
| **Method presence** | `supports`/`executePlan`, `getBestAccessPlan`, `getMappingAdvertisements`, `createIndex`/`dropIndex`, `alterTable`, `renameTable`, `beginSchemaBatch`/`endSchemaBatch`, `notifyLensDeployment`, `shadowName` | yes, per call site (varies) |
| **Static field** | `concurrencyMode`, `expectedLatencyMs` | yes, before dispatch (the clean model) |
| **`getCapabilities()` flag** | `delegatesNotNullBackfill`, `permitsGrandfatheredCheckViolators` (live); `isolation`, `savepoints`, `persistent`, `secondaryIndexes`, `rangeScans` (informational) | only the first two |

## Inventory to transcribe into docs/module-authoring.md

Add a new top-level section **"Capability negotiation surface"** with this table.
Classification legend:
- **Negotiated rejection** — engine consults presence (or catches a thrown `UNSUPPORTED`)
  and turns the unsupported case into a clean, sited error before/at dispatch.
- **Engine-side fallback** — absence has a defined behavior the engine substitutes.
- **Silent divergence** — module no-ops a mandate it cannot meet; the engine never learns. ← the bug class.
- **Data-dependent throw** — module throws `CONSTRAINT`/`MISMATCH` per the arm's contract (correct).

| Surface | Signaling | Unsupported-path | memory | store | isolation | leveldb / indexeddb |
| --- | --- | --- | --- | --- | --- | --- |
| `create` / `connect` / `destroy` | required | n/a | ✓ | ✓ | wraps underlying | via store |
| `getBestAccessPlan` | presence | engine-side fallback (default full-scan; isolation returns a default plan when underlying lacks it — `isolation-module.ts:427`) | ✓ | ✓ | forwards | via store |
| `supports` / `executePlan` | presence (pair) | engine-side fallback (index path) — isolation **deliberately suppresses** it so the overlay sees every row | — | — | suppressed | — |
| `getMappingAdvertisements` | presence | engine-side fallback (name-match only) | ✓ tags | ✓ tags | forwards | via store |
| `createIndex` / `dropIndex` | presence | negotiated rejection (`manager.ts:2016` "does not support CREATE INDEX") | ✓ | ✓ | forwards (instance-level preferred) | via store |
| `shadowName` | presence | **dead** — declared on the interface (`module.ts:225`) but **never called anywhere** | — | — | — | — |
| `alterTable` (method present) | presence | negotiated rejection (each `run*` throws sited `UNSUPPORTED` if absent) | ✓ | ✓ | forwards (throws if underlying lacks) | via store |
| `renameTable` | presence | engine-side fallback (schema-only rename) | ✓ | ✓ physical move | forwards + rekeys maps | via store |
| `beginSchemaBatch` / `endSchemaBatch` | presence | engine-side fallback (per-DDL commits) | n/a | ✓ | forwards | via store |
| `notifyLensDeployment` | presence | engine-side fallback (no-op) | n/a | n/a | forwards | n/a |
| `concurrencyMode` | static field | engine-side fallback (`'serial'`) | `reentrant-reads` | `serial` (default) | computed: `clamp(weaker(under, overlay))` | via store |
| `expectedLatencyMs` | static field | engine-side fallback (`0`) | 0 | 0 | forwards underlying | via store |
| `getCapabilities().delegatesNotNullBackfill` | flag (live) | engine-side gate (`alter-table.ts:297` skips `validateNotNullBackfill`) | off | off | inherits underlying | off |
| `getCapabilities().permitsGrandfatheredCheckViolators` | flag (live) | engine-side gate (`reference.ts` skips CHECK lift) | off | off | inherits underlying | off |
| `getCapabilities().{isolation,savepoints,persistent,secondaryIndexes,rangeScans}` | flag (informational) | **never consulted by engine** — asserted only in tests; isolation augments `isolation`/`savepoints` but nothing reads them | varies | varies | augments | varies |

### `alterTable` sub-arms — the fine-grained mandate layer (the divergence hazard)

`alterTable` presence is **one bit covering ~12 `SchemaChangeInfo` arms**, each with its own
mandate. This mismatch is why a module can be "ALTER-capable" yet silently fail one arm.
Document this sub-table:

| Arm | Mandate | memory | store |
| --- | --- | --- | --- |
| `addColumn` | append column; backfill; NOT-NULL gated by `delegatesNotNullBackfill` | ✓ | ✓ |
| `dropColumn` | remove slot + reindex | ✓ | ✓ |
| `renameColumn` | schema-only | ✓ | ✓ |
| `alterPrimaryKey` | re-key in place **or throw `UNSUPPORTED`** | throws `UNSUPPORTED` → engine `runAlterPrimaryKey` catches → **generic rebuild** | in-place re-key |
| `addConstraint` | materialize + validate (unique/fk) | ✓ | ✓ unique/fk; throws `UNSUPPORTED` for others |
| `dropConstraint` / `renameConstraint` | schema rewrite | ✓ | ✓ |
| `alterColumn.setNotNull` | backfill from default or throw `CONSTRAINT` | ✓ | ✓ |
| `alterColumn.setDataType` | physical convert or throw `MISMATCH` | ✓ | ✓ |
| `alterColumn.setDefault` | schema-only | ✓ | ✓ |
| `alterColumn.setCollation` (non-PK UNIQUE) | re-validate uniqueness under new collation | ✓ | ✓ |
| `alterColumn.setCollation` (**PK column**) | re-key / re-validate PK under new collation (`module.ts:412-415`) | ✓ re-keys | **✗ silent no-op → SILENT DIVERGENCE** (the known gap; see `store-pk-collate-module-capability`) |

The `alterPrimaryKey` row is the model: **try native → on `UNSUPPORTED` apply a defined fallback**.

## The agreed pattern to document

Add a **"Recommended capability-negotiation pattern"** subsection stating these rules:

1. **Presence-signaling is reserved for purely-additive optional hooks** whose absence is
   already a clean engine-side fallback (`getMappingAdvertisements`, the batch / lens
   lifecycle notifications). Absence there means a documented no-op — it can never diverge.

2. **Any contract point where the engine assumes a behavior must be declared and consulted
   before dispatch.** `concurrencyMode` is the template: a defaulted, queryable value the
   engine reads to choose its path. Generalize toward this, not toward more presence bits.

3. **`getCapabilities()` is the single home for binding capability gates.** Mark the five
   informational flags (`isolation`, `savepoints`, `persistent`, `secondaryIndexes`,
   `rangeScans`) explicitly as advisory/non-binding (the engine does not consult them), so
   authors are not misled into thinking toggling them changes engine behavior. (Actual
   removal/relocation is a separate code ticket — here, document the distinction only.)

4. **Hard contract — no silent divergence.** A module that cannot honor an invoked
   `alterTable` arm MUST throw `QuereusError(StatusCode.UNSUPPORTED)` with a sited message —
   **never silently no-op**. The engine maps `UNSUPPORTED` to a defined fallback (generic
   rebuild, schema-only, or engine-side logical enforcement) or surfaces it as a clean user
   error. This promotes the existing `alterPrimaryKey` protocol to a universal rule.

5. **Fine-grained ALTER negotiation.** Because `alterTable` presence is one coarse bit, a
   module advertises per-arm support the engine consults at the relevant `run*` call site
   (the surface `store-pk-collate-module-capability` introduces, e.g. resolving a PK-column
   `setCollation` to `native | logical-enforce | reject`). New arms adopt the same shape as
   needs arise — incremental, not a giant up-front descriptor.

## Refresh the stale `SchemaChangeInfo` section

`docs/module-authoring.md` § "Schema Changes (`SchemaChangeInfo`)" (currently ~L409-425) is
wrong on two counts and must be rewritten:
- It says the engine calls `VirtualTable.alterSchema(changeInfo)`. The real entry point is
  **`VirtualTableModule.alterTable(db, schemaName, tableName, change)`** returning the
  updated `TableSchema` (see `runtime/emit/alter-table.ts` and `module.ts:262-267`).
- It lists only 4 arms. The union (`module.ts:360-423`) now has: `addColumn` (with optional
  `backfillEvaluator`), `dropColumn`, `renameColumn`, `alterPrimaryKey`, `addConstraint`,
  `dropConstraint`, `renameConstraint`, `alterColumn` (`setNotNull` / `setDataType` /
  `setDefault` / `setCollation`). Document each arm's mandate (reuse the sub-table above)
  and the "throw `UNSUPPORTED`, never no-op" rule.

## Edge cases & interactions

- **Keep the doc faithful to current code, not aspirational.** The PK-collation cell is a
  *current* silent divergence; document it as the known gap with a pointer to
  `store-pk-collate-module-capability`, do not describe it as already fixed.
- **`shadowName` is dead code** (declared, never called). Note it as deprecated/unwired in
  the inventory rather than documenting it as a working hook; do not invent a contract for it.
- **Isolation wrapper asymmetry** is intentional and must be preserved in prose: it forwards
  `getBestAccessPlan` / `getMappingAdvertisements` / batch+lens hooks / `renameTable` /
  `alterTable`, but **suppresses** `supports` and caps `concurrencyMode`/`expectedLatencyMs`
  at conservative defaults. Cross-link the existing `quereus-isolation/README.md` paragraph
  rather than restating it divergently.
- **Don't contradict existing sections.** The doc already has a "Concurrency Mode" section
  (L197-261) — the new negotiation section should reference it as the exemplar, not duplicate
  the table.
- **No engine behavior changes in this ticket** — if writing the doc surfaces a place where
  code and the agreed pattern disagree, capture it as a note for the harness ticket, do not
  fix code here.

## TODO

- Add a "Capability negotiation surface" section to `docs/module-authoring.md` with the
  surface table + the `alterTable` sub-arm table above.
- Add a "Recommended capability-negotiation pattern" subsection with rules 1-5.
- Rewrite the "Schema Changes (`SchemaChangeInfo`)" section: correct the entry point to
  `module.alterTable`, enumerate all current arms and their mandates, state the
  no-silent-divergence rule, and keep the `alterPrimaryKey` rebuild-fallback note.
- Mark the five informational `ModuleCapabilities` flags as advisory (not engine-consulted)
  and `shadowName` as unwired, in both the doc and a one-line comment in `capabilities.ts` /
  `module.ts` (comment-only; no behavior change).
- Cross-link `store-pk-collate-module-capability` (first adopter) and the isolation README.
