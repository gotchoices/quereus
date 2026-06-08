description: Engine-side support for persisting views and materialized views in a store-backed catalog — add `view_added`/`view_removed` schema-change events fired from the view DDL emitters, add `generateViewDDL` / `generateMaterializedViewDDL` schema→DDL helpers (tags included, re-parseable), and teach `SchemaManager.importCatalog`/`importDDL` to silently register a plain view from `createView` DDL. No store package changes here.
prereq:
files:
  - packages/quereus/src/schema/change-events.ts              # add ViewAddedEvent / ViewRemovedEvent to the union
  - packages/quereus/src/runtime/emit/create-view.ts          # fire view_added after schema.addView
  - packages/quereus/src/runtime/emit/drop-view.ts            # fire view_removed after schema.removeView
  - packages/quereus/src/schema/ddl-generator.ts              # generateViewDDL / generateMaterializedViewDDL (mirror generateTableDDL)
  - packages/quereus/src/emit/ast-stringify.ts                # createViewToString / createMaterializedViewToString (reuse; already export)
  - packages/quereus/src/schema/view.ts                       # ViewSchema / MaterializedViewSchema (inputs to the generators)
  - packages/quereus/src/schema/manager.ts                    # importDDL/importCatalog: accept createView (silent register); result gains views[]
  - packages/quereus/src/index.ts                             # export new event types + generators
  - packages/quereus/src/core/statement.ts                    # (verify only) if/else-if event mapping tolerates new types
----

# Engine support for view / materialized-view persistence

## Why

A store-backed database persists its catalog by re-writing canonical DDL into the
`__catalog__` store and rehydrating it on reopen. That machinery covers tables
(and bundled indexes) only. To extend it to views and materialized views the
**engine** must provide three things the store package (sibling ticket
`store-view-mv-catalog-persistence`) consumes:

1. **Lifecycle events for plain views.** A `CREATE VIEW` / `DROP VIEW` fires
   *no* schema-change event today — only `ALTER VIEW … SET TAGS` fires
   `view_modified` (see `change-events.ts` § View events, which documents the
   deliberate absence). The store learns of catalog changes by subscribing to the
   `SchemaChangeNotifier`; without create/drop events it can never persist a
   plain view incrementally. (Materialized views already fire
   `materialized_view_added` / `materialized_view_removed` from their emitters, so
   no new MV events are needed.)

2. **Schema → DDL serializers** that emit *current* tags, so a
   `view_modified` / `materialized_view_modified` (which swaps the in-memory
   schema but does **not** rewrite the stored `sql` text) round-trips. Mirrors
   `generateTableDDL`, which the table persistence path already uses for its
   regenerate-compare-write.

3. **A silent import path for plain views**, so rehydrate can register a view
   from its DDL without re-planning the body (deferring validation to query time,
   exactly as `importTable` defers via `connect`). This makes view rehydration
   order-independent — a view over another view, or over a materialized view,
   registers regardless of phase order.

Materialized-view rehydration is intentionally **not** done through
`importCatalog` in this pass — see the sibling store ticket and the deferred
backlog ticket `store-mv-rehydrate-via-importcatalog` for the rationale (the MV
backing must be re-materialized, which reuses the create emitter via `db.exec`
store-side rather than extracting the materialize core here).

## Design

### `view_added` / `view_removed` events

Add to the discriminated union in `change-events.ts`:

```ts
export type ViewAddedEvent   = SchemaObjectAdded<'view_added', ViewSchema>;
export type ViewRemovedEvent = SchemaObjectRemoved<'view_removed', ViewSchema>;
```

and include both in the `SchemaChangeEvent` union (next to `ViewModifiedEvent`).

Fire them **from the runtime emitters**, not from `Schema.addView` /
`Schema.removeView`. Firing at the emitter scopes the event to user-/declarative-
DDL views and deliberately **excludes** internally-registered views (lens
effective bodies, any other `schema.addView` caller) which must NOT be persisted
to the store catalog — they are re-derived, not stored. This mirrors how the MV
emitters fire `materialized_view_added`/`_removed` rather than the Schema object.

- `emitCreateView` (`create-view.ts`): after the successful `schema.addView(...)`,
  `rctx.db.schemaManager.getChangeNotifier().notifyChange({ type: 'view_added',
  schemaName, objectName: viewSchema.name, newObject: viewSchema })`. Must NOT
  fire on the `IF NOT EXISTS` no-op early-return.
- `emitDropView` (`drop-view.ts`): after the successful `schema.removeView(...)`,
  fire `view_removed` with `oldObject: existingView`. Must NOT fire on the
  `IF EXISTS` no-op. The existing MV-shadow guard already routes a materialized
  view to the DROP MATERIALIZED VIEW error before this point.

`statement.ts`'s schema-dependency listener maps event types with an
`if/else-if` chain ending in `else return` — `view_added`/`view_removed` fall
through to the default and are ignored, which is correct (a fresh plain CREATE/
DROP need not invalidate cached read plans here; that is unchanged behavior).
**Verify** there is no exhaustive `switch (event.type)` with a `never`
assertion anywhere that would now fail to compile (grep for `: never` near
`SchemaChangeEvent` handling). None found in the planning pass, but confirm after
adding the variants.

### `generateViewDDL` / `generateMaterializedViewDDL`

Add to `ddl-generator.ts`, alongside `generateTableDDL` / `generateIndexDDL`.
Implement by lifting the schema into the corresponding AST statement and calling
the existing `ast-stringify` emitter — the body is already an AST
(`selectAst`), so this is a thin, drift-free wrapper (the same schema→AST-lift
strategy `generateTableDDL` uses for constraints via `tableConstraintsToString`):

```ts
export function generateViewDDL(view: ViewSchema): string {
  const stmt: AST.CreateViewStmt = {
    type: 'createView',
    view: { type: 'identifier', name: view.name, schema: view.schemaName }, // qualified → re-parses into the right schema
    ifNotExists: false,
    columns: view.columns ? [...view.columns] : undefined,
    select: view.selectAst,
    tags: view.tags as Record<string, SqlValue> | undefined,
  };
  return createViewToString(stmt);
}
```

(Confirm the exact `view` identifier-node shape `createViewToString` expects —
it calls `expressionToString(stmt.view)`; build the node the parser would
produce for a `schema.name` reference so the schema qualifier survives.)

`generateMaterializedViewDDL(mv)` mirrors this with `createMaterializedViewToString`,
**omitting** `moduleName`/`moduleArgs` (the backing is always `memory` in v1, and
the `using` clause is informational only — on reopen the backing is rebuilt as a
memory table regardless). Include `mv.tags`.

Both MUST include current tags (so a SET TAGS round-trips) and MUST be
re-parseable to an equivalent statement (parse → generate → parse fixed point).

### `importCatalog` accepts `createView`

In `manager.ts`, `importDDL` currently dispatches `createTable` / `createIndex`
and throws on anything else. Add a `createView` arm that registers the view
**without planning the body** (defer validation to first reference, mirroring
how `importTable` uses `connect` to skip create-time work):

- Build a `ViewSchema` from the parsed `CreateViewStmt` (name, schemaName from
  `stmt.view.schema ?? currentSchema`, `selectAst: stmt.select`, `columns`,
  `tags`, and `sql` = the entry text or `createViewToString(stmt)`), then
  `schema.addView(viewSchema)`. Do **not** call `notifyChange` (import is silent,
  like `importTable`/`importIndex`).
- Extend the `importDDL` / `importCatalog` result to carry imported view names:
  add a `views: string[]` field to the returned `{ tables, indexes }` object
  (additive; update the type and the aggregation in `importCatalog`).
- `createMaterializedView` continues to throw the existing fail-loud "does not
  support statement type" error — MV rehydration does not go through
  `importCatalog` (the store execs it). Leave that arm as-is.

### Exports

From `packages/quereus/src/index.ts`, export the new event types
(`ViewAddedEvent`, `ViewRemovedEvent` as `type`) next to the existing
`TableModifiedEvent` export, and the two generators (`generateViewDDL`,
`generateMaterializedViewDDL`) next to `generateTableDDL`/`generateIndexDDL`.

## Edge cases & interactions

- **Internal (non-DDL) view registration must NOT fire `view_added`.** Lens
  effective-body views and any other direct `schema.addView` caller are excluded
  by firing only from `emitCreateView`. Confirm the lens path registers via
  `schema.addView` (or similar) and not by running `CREATE VIEW` through the
  emitter; if any internal path DOES route through the emitter, it would be
  persisted — flag it.
- **`IF NOT EXISTS` / `IF EXISTS` no-ops fire nothing.** Assert the early-return
  branches in both emitters are above the `notifyChange`.
- **CREATE-or-replace semantics.** If the parser/emitter supports replacing an
  existing view (re-create over an existing name), the replace path must fire
  `view_added` with the new schema so persistence overwrites. Check whether such
  a path exists; if not, no action.
- **Tag round-trip fidelity.** `view_modified`/`materialized_view_modified` swap
  the schema but leave `sql` stale; the generators read live `tags`. A
  parse→generate→parse fixed-point test must cover: no tags, single tag, multiple
  tags, reserved `quereus.update.*` tag keys (quoting), explicit column list,
  compound-SELECT body, VALUES body.
- **Schema qualification.** Persisted DDL must be fully qualified
  (`schema.name`) so rehydrate registers into the correct schema regardless of
  the session's current schema. Verify the lifted AST carries the schema.
- **MV `using` clause omission.** A re-parse of `generateMaterializedViewDDL`
  output (no `using`) must still build a valid MV whose backing defaults to
  memory (the v1 build only rejects *named* unsupported modules; absent module is
  allowed).
- **No `never`-exhaustiveness regression** from the two new union members.

## TODO

- Add `ViewAddedEvent` / `ViewRemovedEvent` to `change-events.ts` and the union.
- Fire `view_added` in `emitCreateView` (post-add, not on IF NOT EXISTS no-op).
- Fire `view_removed` in `emitDropView` (post-remove, not on IF EXISTS no-op).
- Implement `generateViewDDL` + `generateMaterializedViewDDL` in
  `ddl-generator.ts` via the AST-lift + `ast-stringify` emitters, tags included.
- Extend `importDDL`/`importCatalog` with a silent `createView` arm; add
  `views: string[]` to the result; keep `createMaterializedView` fail-loud.
- Export the new event types and generators from `index.ts`.
- Verify `statement.ts` and any other `SchemaChangeEvent` consumer tolerate the
  new variants (no `never`-assertion break).
- Tests (engine, `packages/quereus/test/`):
  - a `SchemaChangeNotifier` listener observes `view_added` on CREATE VIEW and
    `view_removed` on DROP VIEW; observes **nothing** on the IF [NOT] EXISTS
    no-ops.
  - `importCatalog(['create view v as select … '])` registers a queryable view
    (with tags) without planning the body; result `.views` names it; importing a
    view whose body references a not-yet-imported relation does not throw at
    import time.
  - parse → `generateViewDDL` / `generateMaterializedViewDDL` → parse fixed-point
    over the tag/column/body matrix above (extend `index-ddl-roundtrip.spec.ts`
    style or `ast-stringify.spec.ts`).
- `yarn workspace @quereus/quereus build`, `… test`, `… lint` green.
