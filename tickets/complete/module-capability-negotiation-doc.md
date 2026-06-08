description: Documentation of the VirtualTableModule capability-negotiation surface — new "Capability negotiation surface" section + "Recommended capability-negotiation pattern" + rewritten "Schema Changes (SchemaChangeInfo)" in docs/module-authoring.md, plus comment-only annotations in capabilities.ts (5 advisory flags) and module.ts (shadowName unwired). Pure documentation; no engine behavior changed. Reviewed.
files: docs/module-authoring.md, packages/quereus/src/vtab/capabilities.ts, packages/quereus/src/vtab/module.ts, packages/quereus/src/runtime/emit/alter-table.ts, packages/quereus/src/planner/nodes/reference.ts, packages/quereus/src/schema/manager.ts, packages/quereus-store/src/common/store-module.ts, packages/quereus/src/vtab/memory/module.ts, packages/quereus-isolation/src/isolation-module.ts, packages/quereus-isolation/README.md
----

## What landed (implement)

The documentation deliverable of the `module-capability-consistency-audit` survey. No
engine code changed — only docs and comment-only `.ts` edits.

- **`docs/module-authoring.md`:** new "Capability negotiation surface" section (Signaling
  styles / Classification legend / Surface inventory / `alterTable` sub-arms / Recommended
  capability-negotiation pattern rules 1–5); rewritten "Schema Changes (`SchemaChangeInfo`)"
  correcting the entry point to `VirtualTableModule.alterTable(...)` and the union to its
  current 8 arms, with a per-arm mandate table.
- **`capabilities.ts`** (comment-only): the five informational flags marked advisory /
  non-binding / not engine-consulted; the two live gates contrasted.
- **`module.ts`** (comment-only): `shadowName` marked unwired / dead.

## Review findings

Adversarial pass over the implement diff (commit `d0b8eb6a`), read first with fresh eyes
against the cited code. The deliverable is prose + inert comments, so "faithful to code" is
the entire correctness surface; I re-verified every load-bearing claim against source rather
than trusting the handoff.

### Checked and confirmed faithful (no change needed)

- **`SchemaChangeInfo` union** — doc's 8-arm union matches `module.ts:366-429` verbatim
  (arm names + optional fields, comments stripped).
- **`alterTable` signature** — `(db, schemaName, tableName, change): Promise<TableSchema>`
  matches `module.ts:268-273`; the old `VirtualTable.alterSchema` entry point is indeed gone.
- **`run*` UNSUPPORTED rejection** — `runAddColumn` / `runDropColumn` / `runDropConstraint`
  / `runRenameConstraint` / `runAlterColumn` each throw a sited `UNSUPPORTED` when
  `module.alterTable` is absent (`alter-table.ts` 279, 620, 673, 729, 833).
- **`alterPrimaryKey` try-native-then-rebuild** — `runAlterPrimaryKey` catches exactly
  `StatusCode.UNSUPPORTED` → `rebuildTableWithNewShape`, which special-cases
  `MemoryTableModule` (`alter-table.ts` 1019-1052, 1071); any other error propagates.
- **`createIndex` rejection** — `SchemaManager.createIndex` throws "does not support CREATE
  INDEX" (`manager.ts`).
- **`delegatesNotNullBackfill` gate** — `runAddColumn` skips `validateNotNullBackfill`
  (`alter-table.ts:297`).
- **`permitsGrandfatheredCheckViolators` gate** — `TableReferenceNode.computePhysical` swaps
  in `EMPTY_CHECK_EXTRACTION` (`reference.ts:139-143`).
- **Advisory-flags claim** — the *only* engine consumers of `getCapabilities()` are
  `reference.ts` (`permitsGrandfatheredCheckViolators`) and `alter-table.ts`
  (`delegatesNotNullBackfill`). A repo-wide grep for `.isolation/.savepoints/.persistent/
  .secondaryIndexes/.rangeScans` in `packages/quereus/src` returns only the memory layer's
  unrelated `secondaryIndexes` Map — no engine code reads the five informational flags as a
  gate. Claim is sound.
- **`shadowName` is dead** — the only literal `shadowName` hits are an unrelated local var in
  the rebuild path (`${tableName}__rekey_…`) and the interface declaration; no `.shadowName(`
  invocation exists. "Unwired" is correct.
- **Isolation hook forwarding** — `isolation-module.ts` implements/forwards
  `getMappingAdvertisements` (367), `beginSchemaBatch`/`endSchemaBatch` (389/397),
  `notifyLensDeployment` (413), `getBestAccessPlan` (422), `alterTable` (650), `renameTable`
  (773); does **not** implement `supports` (suppressed). Doc's enumeration is accurate (and
  more complete than the isolation README, which omits renameTable/alterTable/lens).
- **Store PK-collation silent no-op** — `store-module.ts:1105-1120` applies a PK-column
  `setCollation` schema-only (physical key bytes keep the fixed table-level collation); the
  tracking ticket `store-pk-collate-module-capability` exists in `plan/`. Doc describes it as
  a current gap, not fixed. Correct.
- **Inventory cells** — memory `concurrencyMode='reentrant-reads'` (verified); store has no
  `concurrencyMode`/`supports`/`executePlan` (→ serial default, "—"); memory omits
  `supports` (→ "—"). All match.
- **Intra-doc anchors** — all four resolve under GitHub's slug algorithm:
  `#3-concurrency-mode-parallel-runtime`, `#recommended-capability-negotiation-pattern`,
  `#schema-changes-schemachangeinfo`, and `#altertable-sub-arms--the-fine-grained-mandate-layer`
  (the double hyphen from the em-dash is correct). Cross-link to the isolation README
  "Transparent hook forwarding" paragraph resolves.

### Findings fixed inline (minor)

1. **Doc over-generalized the `alterTable` unsupported-path** (surface inventory). It read
   "each `run*` … throws a sited `UNSUPPORTED` if absent" — but `runRenameColumn` degrades to
   an engine-side schema-only rename when `alterTable` is absent (`alter-table.ts:220-230`),
   it does not throw. **Fixed:** cell now carves out the `renameColumn` exception.

2. **`module.ts` `alterTable` interface doc-comment was stale.** It listed only "(ADD COLUMN,
   DROP COLUMN, RENAME COLUMN)" — contradicted by the now-documented 8-arm union in the same
   file. **Fixed:** expanded to the full arm set and cross-linked the "Schema Changes" doc
   section; also noted the `renameColumn` schema-only degrade.

3. **`concurrencyMode`/`expectedLatencyMs` mischaracterized for the isolation wrapper — in
   *two* places.** The doc block-quote AND the isolation README both claimed the wrapper
   "caps … at conservative defaults (`serial` / `0`)". The code does neither:
   `IsolationModule.concurrencyMode` returns `clampToReentrantReads(weakerMode(underlying,
   overlay))` and `expectedLatencyMs` returns `this.underlying.expectedLatencyMs ?? 0`
   (`isolation-module.ts:184-208`) — and the doc's *own* surface-inventory row already states
   this correctly, so the block-quote contradicted itself. The README was stale (predates the
   concurrency-forwarding feature); the implement pass copied its wording. **Fixed both:** the
   doc block-quote and the README now say `concurrencyMode` is the weaker of underlying/overlay
   capped at `reentrant-reads`, and `expectedLatencyMs` forwards the underlying's hint.

4. **Dangling ticket slug in store code comment.** `store-module.ts:1109` deferred the PK
   physical re-key to `store-set-collate-pk-physical-rekey`, which exists in no stage folder;
   the live tracking ticket (and the doc's reference) is `store-pk-collate-module-capability`.
   **Fixed:** repointed the comment to the live slug so code and doc agree.

### Judgment calls (checked, deliberately not changed)

- **`supports` / `executePlan` paired under "Method presence".** `supports()` is a
  `VirtualTableModule` member but `executePlan()` is a `VirtualTable` member (`table.ts:106`),
  reached only after `supports()` assents (`remote-query.ts:33`). Listing them as a pair under
  the module-contract table is a mild imprecision, but it faithfully models the two-step
  negotiation and the surface inventory already labels it "presence (pair)". Adding an
  object-location caveat would clutter prose for no behavioral gain — left as-is.
- **Line numbers omitted from doc tables** (implementer's call). Concur: filenames + symbol
  names are stable/greppable; line numbers rot. The doc stays at filename granularity.

### Majors / new tickets

None. No correctness, architecture, or scope gap warranting a `fix`/`plan`/`backlog` ticket
surfaced — this was a documentation deliverable and every finding was a localized prose/comment
inaccuracy fixable in this pass. The one real *engine* gap the doc describes (store PK-collation
silent divergence) is already tracked by `store-pk-collate-module-capability` in `plan/`; this
ticket correctly documents it as open rather than re-filing it.

### Validation

- `yarn typecheck` (`tsc --noEmit`) in `packages/quereus` — **passes** (covers the
  comment-only `module.ts` edit).
- `eslint` on `module.ts` + `capabilities.ts` — **passes clean**.
- `yarn test:single …/check-fold-gated-by-capability.spec.ts` — **4 passing**; exercises the
  `permitsGrandfatheredCheckViolators` gate the doc describes, confirming documented behavior.
- Full suite not run: the deliverable is prose + inert comments (the only `.ts` edits are
  comments) with no runtime surface; the targeted gate spec is the meaningful behavioral check.
  README + Markdown edits have no compile/lint surface.
