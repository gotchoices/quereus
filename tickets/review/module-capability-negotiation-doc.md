description: Review the VirtualTableModule capability-negotiation docs added to docs/module-authoring.md (new "Capability negotiation surface" section, "Recommended capability-negotiation pattern" rules, rewritten "Schema Changes (SchemaChangeInfo)" section) plus comment-only annotations in capabilities.ts (5 advisory flags) and module.ts (shadowName unwired). Pure documentation — verify faithfulness to code; no engine behavior changed.
files: docs/module-authoring.md, packages/quereus/src/vtab/capabilities.ts, packages/quereus/src/vtab/module.ts, packages/quereus/src/runtime/emit/alter-table.ts, packages/quereus/src/planner/nodes/reference.ts, packages/quereus/src/schema/manager.ts, packages/quereus-store/src/common/store-module.ts, packages/quereus/src/vtab/memory/module.ts, packages/quereus-isolation/src/isolation-module.ts, packages/quereus-isolation/README.md
----

## What landed

This was the documentation deliverable of the resolved `module-capability-consistency-audit`
survey. No engine code changed — only docs and two comment-only `.ts` edits.

**`docs/module-authoring.md`:**
- New top-level section **"Capability negotiation surface"** (inserted after the Concurrency
  Mode subsection, before "Runtime Execution Modes"), containing:
  - a **Signaling styles** table (method-presence / static-field / `getCapabilities()` flag),
  - a **Classification legend** (negotiated rejection / engine-side fallback / silent
    divergence / data-dependent throw),
  - the **Surface inventory** table (15 surfaces × signaling / unsupported-path / 4 module
    columns),
  - the **`alterTable` sub-arms** table (the one-bit-covers-~12-arms hazard),
  - block-quote notes on `shadowName` being unwired and the intentional isolation-wrapper
    asymmetry (cross-linking the isolation README rather than restating),
  - a **Recommended capability-negotiation pattern** subsection with rules 1–5.
- Rewrote **"Schema Changes (`SchemaChangeInfo`)"**: corrected the entry point from the
  stale `VirtualTable.alterSchema(changeInfo)` to `VirtualTableModule.alterTable(db,
  schemaName, tableName, change): Promise<TableSchema>`; replaced the old 4-arm union with
  the current 8-arm union (incl. `addColumn.backfillEvaluator`, `addConstraint`,
  `dropConstraint`, `renameConstraint`, `alterColumn.{setNotNull,setDataType,setDefault,
  setCollation}`); added a per-arm mandate table; added the no-silent-divergence rule; kept
  the `alterPrimaryKey` rebuild-fallback note.

**`capabilities.ts`** (comment-only): marked the five informational flags (`isolation`,
`savepoints`, `persistent`, `secondaryIndexes`, `rangeScans`) as advisory / non-binding /
not engine-consulted, contrasted with the two live gates.

**`module.ts`** (comment-only): marked `shadowName` as unwired / dead.

## Validation done (this is the floor, not the ceiling)

- `yarn typecheck` (tsc --noEmit) in `packages/quereus` — **passes** (comment-only `.ts`
  edits cannot change types, but confirmed).
- `eslint` on `capabilities.ts` + `module.ts` — **passes clean**.
- No test suite run: there is no runtime behavior to exercise. The deliverable is prose plus
  inert comments.

Every table cell was cross-checked against code before writing. Key anchors verified:
- `alterTable` absent → sited `UNSUPPORTED`: each `run*` in `runtime/emit/alter-table.ts`.
- `alterPrimaryKey` try-native-then-rebuild: `runAlterPrimaryKey` catches `StatusCode.UNSUPPORTED`
  → `rebuildTableWithNewShape` (special-cases `MemoryTableModule`); store re-keys natively.
- `createIndex` rejection: `SchemaManager.createIndex` ("does not support CREATE INDEX").
- `delegatesNotNullBackfill` gate: `alter-table.ts` `runAddColumn` (skips `validateNotNullBackfill`).
- `permitsGrandfatheredCheckViolators` gate: `reference.ts` `computePhysical` (skips CHECK lift).
- PK-column `setCollation` silent no-op in store: `store-module.ts` `alterColumn` branch
  (fixed table-level key collation; schema-only, not re-keyed). Tracked by
  `store-pk-collate-module-capability` (plan).
- Advisory-flags claim: grep of `getCapabilities` consumers in `packages/quereus/src/`
  returns ONLY `reference.ts` + `alter-table.ts` (the two live flags); the five informational
  flags are read nowhere in the engine. Confirmed.
- Isolation forwarding/suppression + `concurrencyMode = clampToReentrantReads(weakerMode(...))`:
  `isolation-module.ts` + its README "Transparent hook forwarding" paragraph.

## What a reviewer should check

1. **Faithfulness spot-check.** Pick a handful of inventory/sub-arm cells and re-verify
   against the cited code — the value of this doc is that it is accurate, not aspirational.
   In particular re-confirm the SchemaChangeInfo union in the doc matches `module.ts`
   verbatim (arm names + optional fields).
2. **Anchor links resolve.** The doc uses several intra-doc anchors
   (`#3-concurrency-mode-parallel-runtime`, `#recommended-capability-negotiation-pattern`,
   `#schema-changes-schemachangeinfo`,
   `#altertable-sub-arms--the-fine-grained-mandate-layer` — note the double hyphen from the
   em-dash in that header). Confirm they point where intended.
3. **Advisory claim is sound.** Confirm the comment in `capabilities.ts` ("the engine does
   not consult these five") is not contradicted by any consumer (incl. dynamic/string
   access). I checked `packages/quereus/src`; the isolation package augments
   `isolation`/`savepoints` but does not read them as a gate, and tests assert them — flag if
   you find an engine consumer I missed.
4. **No contradiction with existing sections.** The new section references the existing
   "Concurrency Mode" section (L197+) as the exemplar rather than duplicating its table;
   confirm tone/claims are consistent with the Update-results, Mutation-statements, and
   Event-system sections.

## Honest gaps / judgment calls

- **Line numbers deliberately omitted from the doc tables.** The source ticket's inventory
  tables carried exact line numbers (e.g. `isolation-module.ts:427`, `manager.ts:2016`,
  `module.ts:412-415`). I kept **filename-level** references in the doc and dropped the
  volatile line numbers (docs rot against shifting line numbers; filenames + symbol names are
  stable and greppable). If the reviewer prefers strict line fidelity to the ticket, that is a
  conscious tradeoff to revisit — but I'd argue against re-adding line numbers to prose docs.
- **Doc references ephemeral ticket slugs** (`store-pk-collate-module-capability`). This
  matches existing precedent in the same doc (it already cites `store-secondary-index-persistence`
  / `store-view-mv-persistence`), so it is consistent, but slugs are not permanent artifacts —
  acceptable, but worth a sanity check.
- **No engine code touched on purpose.** The ticket scoped code fixes out (the PK-collation
  silent divergence is fixed by `store-pk-collate-module-capability`, not here). The doc
  describes the PK-collation cell as a *current* gap, not as fixed — verify it reads that way
  and does not over-promise.
- **`shadowName` "never called anywhere":** verified by reference search across the indexed
  source; if a non-indexed path (e.g. a plugin package outside the index) calls it, the
  "dead" label would be too strong. I believe it is correct for the core engine.
