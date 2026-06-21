description: Add a reserved tag that lets the engine mark a table as engine-owned so the "apply schema" / "diff schema" comparison ignores it instead of trying to drop it.
files:
  - packages/quereus/src/schema/reserved-tags.ts
  - packages/quereus/src/schema/catalog.ts
  - packages/quereus/src/index.ts
  - packages/quereus/test/schema/reserved-tags.spec.ts
  - packages/quereus/test/schema/catalog.spec.ts
----

## Summary

Added the reserved tag `quereus.engine_managed` (boolean, `physical-table` site only). A
physical table carrying `quereus.engine_managed = true` is skipped entirely by
`collectSchemaCatalog`, so the declarative differ (`apply schema` / `diff schema`)
never sees it as an orphan to DROP nor as an object to CREATE. The table stays fully
resolvable via `getTable` / `getAllTables` for compile / introspection / servicing.

Motivating producer (cross-repo): Lamina's lens basis layer registers per-column
`(rowId, value)` member relations into the basis scope's `Schema`; before this marker a
bare in-place `apply schema <basis>` diffed them as orphan tables and emitted a
crashing `DROP TABLE` for each. This is the engine-managed-table sibling of the
`quereus.expose_implicit_index` implicit-covering-index exclusion.

The constant is re-exported from the package entry (`index.ts`) so the producing module
stamps the single source-of-truth literal rather than re-spelling it.

## Review findings

### Scope / diff reviewed
The implement commit (`1759c191`) only moved the ticket file; the actual code landed in
`e1b06c30`. Reviewed the live state of all five files plus every `collectSchemaCatalog`
and `ENGINE_MANAGED_TABLE_TAG` consumer.

### Correctness — no issues
- `isEngineManagedTable` reads `tags?.[ENGINE_MANAGED_TABLE_TAG] === true` — strict
  boolean match, exactly mirroring the established `expose_implicit_index` (`=== true`)
  and `sync.replicate` posture. A `= false` / absent / non-boolean value leaves the
  table differ-managed (and a non-boolean value is independently flagged
  `invalid-tag-value` by the registry).
- The `continue` is placed BEFORE the maintained / `isView` branches in
  `collectSchemaCatalog`, so an engine-managed table (plain OR maintained) is excluded
  unconditionally — the intended cut point.

### Consumer audit — exclusion is correctly scoped
- The ONLY production consumers of `collectSchemaCatalog` are `emitDiffSchema` and
  `emitApplySchema` (`runtime/emit/schema-declarative.ts`) — i.e. exactly the declarative
  differ paths the exclusion targets. No other code path loses visibility of the table.
- `emitApplySchema`'s seed-data fresh-table detection reads `actualCatalog.tables`, but
  only to decide whether a *declared* table is newly created; an engine-managed table is
  never a declared seed target, so its absence is harmless.
- The `schema()` TVF (`func/builtins/schema.ts`) iterates `getAllTables()` directly (NOT
  via the catalog) and therefore still lists engine-managed tables in introspection
  output. **Verified intentional** and consistent with the documented contract ("stays
  resolvable via getTable / getAllTables ... for introspection"). Not a regression.

### Docs — accurate, one clarification
- `reserved-tags.ts` and `catalog.ts` doc comments are thorough and correct, and the
  `unknownReservedTag` suggestion string lists the new key.
- The comments + implement handoff repeatedly state "`export_schema` omits it". There is
  **no `export_schema` implementing symbol** in the source today — it is a documented
  concept (`docs/view-updateability.md`) and the pre-existing `expose_implicit_index`
  comment uses the identical phrasing. So the claim is consistent with existing
  vocabulary, not false against current code; the handoff's noted "no export_schema test"
  gap is **moot** (nothing to test). No change required.

### Tests — adequate, no additions needed
- `reserved-tags.spec.ts`: accepts boolean at `physical-table`; rejects non-boolean
  (error); rejects column/constraint/index/logical-column sites (`tag-not-allowed-here`);
  flags a typo (`unknown-reserved-tag`); `RESERVED_TAGS` length 20 + key presence.
- `catalog.spec.ts`: `= true` excluded from catalog yet resolvable via `getTable`;
  `= false` stays included.
- Considered adding a differ-level (`computeSchemaDiff`) regression that re-proves "no
  DROP emitted", but since `collectSchemaCatalog` provably never hands the table to the
  differ, that test would only re-assert the already-tested catalog cut point. The true
  end-to-end (`apply schema` re-apply keeps members) lives in the lamina repo
  (`lens-basis-inplace-reapply-keeps-members-e2e.test.ts`). No quereus `apply schema` /
  `diff schema` SQL-level integration suite exists to extend. The catalog-layer unit test
  pins exactly the line that fixes the bug — left as-is.

### Type safety / lint / tests run
- `eslint 'src/**/*.ts' 'test/**/*.ts'` — clean.
- `tsc -p tsconfig.test.json --noEmit` — clean (catches spec call-site signature drift).
- `reserved-tags.spec.ts` + `catalog.spec.ts` + `schema-differ.spec.ts` +
  `exports.spec.ts` — **165 passing**.

### Disposition
- Minor findings: none requiring a fix (all considerations resolved or confirmed
  intentional).
- Major findings: none → no new tickets filed.
