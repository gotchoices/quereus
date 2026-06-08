description: Fixed `relationTypeFromTableSchema` which previously marked TEMP TABLE relations as `isReadOnly`, conflating them with views. The disjunction now consults the explicit `tableSchema.isReadOnly` field instead of `tableSchema.isTemporary`. A new sqllogic test exercises the full DML lifecycle of a `CREATE TEMP TABLE`.
files:
  packages/quereus/src/planner/type-utils.ts
  packages/quereus/test/logic/08.2-temp-table-edge-cases.sqllogic
----

## Change

`packages/quereus/src/planner/type-utils.ts:62` — the OR disjunction now reads:

```ts
isReadOnly: !!(tableSchema.isView || tableSchema.isReadOnly),
```

`TableSchema.isView` stays in the disjunction defensively — current code never sets `isView: true` on a TableSchema (views go through a separate `ViewSchema` retrieved via `Schema.getAllViews()`), but the field exists for a future path that models views as TableSchemas with INSTEAD OF triggers; the field then remains the right gate for read-only at the relation-type level.

This is preventative: no DML builder (`insert.ts`, `update.ts`, `delete.ts`) currently inspects `RelationType.isReadOnly` to reject writes, so there is no observable runtime failure today. The conflation would have surfaced once any planner pass started using that flag for write-gating.

## Test

New file `packages/quereus/test/logic/08.2-temp-table-edge-cases.sqllogic` exercises the full lifecycle of a temp table — `create temp table`, `insert`, `select`, `update`, `delete`, re-`insert`, `count`, and `drop`.

## Review findings

### Verified

- **Code change (type-utils.ts:62)** — diff is exactly the swap described; no collateral changes. The function `relationTypeFromTableSchema` is otherwise untouched. ColumnDef construction and key derivation logic are unaffected.
- **Schema producers reviewed for the assertion that `isReadOnly` is set correctly per kind:**
  - `SchemaManager` CREATE TABLE path (`schema/manager.ts:997-1018`) sets `isTemporary` from the AST but never sets `isReadOnly`. Default-undefined → falsy → temp tables now correctly produce `isReadOnly: false` at the relation-type level.
  - `createBasicSchema` (`schema/table.ts:287-304`) and the test-only `quereus-store/src/common/store-module.ts` fallback both set `isTemporary: false` and don't touch `isReadOnly`. Behavior unchanged for those paths.
  - Grep across `packages/quereus/src` for `isTemporary: true` returned no schema-construction call sites, ruling out any hidden builder that was relying on the old conflation to also flag the table as read-only. The implementer's known-gap concern is therefore moot.
- **`withGeneratedColumnGraph` (table.ts:579)** and the ANALYZE schema refresh (`runtime/emit/analyze.ts`) both spread `tableSchema` into the new object, so `isReadOnly` is preserved across schema replacements. Confirmed by reading.
- **No doc claims the conflation.** `docs/types.md`, `docs/change-scope.md`, `docs/schema.md`, `docs/sql.md` — none describe temp tables as read-only. No doc updates required.
- **Test coverage** — the new sqllogic covers create / insert / select / update / select / delete / select / insert / count / drop. That's a real lifecycle, not just a smoke test; the `→`-asserted result rows make every DML stage observable. Fine for a behavior-level test of a fix whose internal flag is currently unread.

### Tests & lint

- `yarn workspace @quereus/quereus run lint` → exit 0, clean.
- `yarn workspace @quereus/quereus run test` → 3413 passing, 9 pending, 0 failing (~42s). No regressions.
- `yarn test:store` not run — fix is in the planner type-utils layer, not the storage path; the change cannot regress store-backed behavior independently of memory-backed behavior. Skip is consistent with the project's "memory-backed tests are the default for agents" guidance.

### Minor things considered, none acted on

- **A direct planner-level assertion that `RelationType.isReadOnly` is false for temp tables and true for views** would catch a future regression more directly than the lifecycle test. Not added: no consumer reads the flag today, so the assertion would be testing internal state with no behavior wire-up. The lifecycle test is what currently exercises the writable code path; if a planner pass starts gating on `RelationType.isReadOnly` in the future, that's the right moment to add the direct assertion alongside it.
- **`isView` left in the disjunction.** Considered removing it since no current code sets `isView: true` on a TableSchema. Left in place: the field is part of the public `TableSchema` shape and the disjunction is the right gate if a future view-as-table path ever lands. Removing it now would just trade one preventative branch for another and lose intent.

### Major findings

None. The fix is a one-line correction with adequate behavior-level test coverage, no doc impact, and no other schema-construction site that depended on the old conflation.

## Out of scope

Per-connection scoping of temp objects (whether two connections sharing a database see each other's temp tables) — punt to a separate ticket if it ever comes up.
