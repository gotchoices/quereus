description: Engine-side support for persisting views / materialized views — view_added/view_removed lifecycle events from the view DDL emitters, generateViewDDL/generateMaterializedViewDDL schema→DDL helpers, and a silent createView arm in importCatalog. Store package intentionally NOT touched. Reviewed and completed.
prereq:
files:
  - packages/quereus/src/schema/change-events.ts              # ViewAddedEvent / ViewRemovedEvent in the union
  - packages/quereus/src/runtime/emit/create-view.ts          # fires view_added after schema.addView
  - packages/quereus/src/runtime/emit/drop-view.ts            # fires view_removed after schema.removeView
  - packages/quereus/src/schema/ddl-generator.ts              # generateViewDDL / generateMaterializedViewDDL
  - packages/quereus/src/schema/manager.ts                    # importView arm; views[] in importCatalog; getOrCreateSchema helper (review)
  - packages/quereus/src/index.ts                             # exports for the new event types + generators
  - packages/quereus/test/view-mv-ddl-persistence.spec.ts     # full spec; +2 live-schema round-trip tests (review)
  - packages/quereus/test/index-ddl-roundtrip.spec.ts         # additive views[] assertion
  - docs/schema.md                                            # event table, catalog-import, DDL-generation sections
----

# Complete: engine support for view / materialized-view persistence

Three engine primitives the sibling store ticket (`store-view-mv-persistence`, in plan)
will consume. No store code changed — `.views` on `importCatalog`'s result is additive.

1. **`view_added` / `view_removed` lifecycle events** — added to the `SchemaChangeEvent`
   union, fired from the runtime emitters (`emitCreateView` / `emitDropView`), not from
   `Schema.addView`/`removeView`, so internal views (lens bodies) are excluded.
2. **`generateViewDDL` / `generateMaterializedViewDDL`** — lift the stored schema into
   the equivalent AST and render via the shared `ast-stringify` emitters. Fully-qualified
   names, live tags, MV omits `using`, parse→generate→parse fixed point.
3. **Silent `createView` import arm** — `importDDL` dispatches `createView` to `importView`,
   registering without planning the body (deferred to first reference). `createMaterializedView`
   stays fail-loud.

## Review findings

**Process.** Read the implement-stage diff (`cf46187`) first with fresh eyes, then the
handoff. Verified every claim in the handoff's "known gaps" against the live code.

### Verified correct (the implementer's reasoning held up)
- **Event scoping.** `view_added`/`view_removed` fire only from the emitters; the lens
  compiler (`lens-compiler.ts`) registers via `schema.addView` directly and correctly
  fires nothing. The only current consumers of the new events are the tests — no engine
  code reacts to a plain create/drop, confirming the "fresh create/drop need not
  invalidate cached read plans" claim.
- **MV `selectAst` is the RAW parsed body, not the optimized form.** The implementer
  hedged that a live MV's `selectAst` might be the optimized body (and so the
  parser-derived test scaffolding might not exercise the real shape). It is not — the
  create emitter (`materialized-view.ts:73`) stores `plan.selectStmt` (the raw AST). The
  generators therefore see the identical shape live and from scaffolding. Closed this
  gap directly with two new live-schema round-trip tests (below).
- **`statement.ts` exhaustiveness.** Confirmed no `switch(event.type)`/`never` assertion
  over `SchemaChangeEvent` breaks when the two new variants fall through.
- **`importView` schema-creation deviation** (creates a missing schema, unlike
  `importIndex`'s fail-loud) is the right call for order-independent rehydration and now
  matches `importTable` exactly via a shared helper (below).
- **Build / lint / store-additive contract** all re-verified, not taken on faith.

### Minor — fixed inline this pass
- **DRY.** `importView` duplicated `importTable`'s 4-line "get-the-schema-or-create-it"
  block verbatim. Extracted `SchemaManager.getOrCreateSchema(name)` and routed both
  call sites through it (`manager.ts`). Pure refactor; full suite re-run green.
- **Live-schema generator coverage.** The implementer flagged that the generator matrix
  feeds *parser-derived* schemas, never a live one. Added two tests to
  `view-mv-ddl-persistence.spec.ts`: a live `CREATE VIEW` (with tags) and a live,
  row-time-maintainable `CREATE MATERIALIZED VIEW`, each `getView`/`getMaterializedView`
  → `generate*DDL` → re-parse, then rehydrated into a *fresh* `Database` and queried to
  prove byte-and-behavior fidelity (tags + rows survive). Both pass — closing the
  implementer's "may want one live round-trip" suggestion.

### Major — filed as a new ticket (not fixed here; needs a design decision)
- **`backlog/view-body-rewrite-fires-no-schema-event`.** `ALTER TABLE/COLUMN RENAME`
  propagation (`alter-table.ts`) rewrites dependent plain-view bodies in place via
  `schema.addView(updatedView)` but fires **no** schema-change event (the sibling table
  loop fires `table_modified`; the view loop fires nothing). Harmless for the optimizer
  cache today (cached view reads depend on the underlying table, which the rename *does*
  invalidate) but a correctness gap for the event-driven view persistence this ticket
  enables: after a rename the store is never told to re-persist, so close→reopen
  rehydrates a stale, now-broken view body. Filed rather than fixed because the fix
  requires deciding the event contract (reuse `view_modified`, today documented as
  SET-TAGS-only, vs. a new body-changed event) and re-checking cache-invalidation
  semantics. The ticket also flags a secondary scope question: MV bodies are not
  rewritten on rename at all.

### Scrutinized, no action needed
- **Transaction rollback** (event fires inside `run()` before any DDL rollback) — a
  pre-existing property of every emitter-fired event (`materialized_view_added`,
  table ops), not introduced here; the store consumer owns transactional reconciliation.
- **Blob/JSON tag-value fidelity** — `tagValueToString` falls back to `String(value)`;
  a pre-existing `ast-stringify` limitation, out of scope, no exotic tag values exercised
  by the persistence path.
- **`drop-view.ts` `if (removed && existingView)` guard** — `existingView` is provably
  truthy by the time control reaches it (the earlier no-op/throw arms cover the absent
  case); the guard is defensive, not load-bearing. Left as-is.
- **Docs** (`docs/schema.md`) — event table, catalog-import, and DDL-generation sections
  read against the new reality and are accurate. No other doc enumerates the event union.

### Empty categories
- **No regressions found** in the touched surface (full suite: 5267 passing / 9 pending /
  0 failing, up from 5265 by the 2 added tests; the `importTable` refactor changed no
  behavior).
- **No security/resource-cleanup findings** — these primitives allocate no resources
  beyond schema objects already managed by the catalog; `Database` close paths unchanged.

## Validation
- `yarn workspace @quereus/quereus build` — clean.
- `yarn workspace @quereus/quereus lint` — clean.
- `node test-runner.mjs` (full quereus suite) — **5267 passing, 9 pending, 0 failing.**
- Targeted: `view-mv-ddl-persistence.spec.ts` + `index-ddl-roundtrip.spec.ts` — 92 passing.

## Follow-ups
- `backlog/view-body-rewrite-fires-no-schema-event` — rename-propagation event gap (above).
- `store-view-mv-persistence` (in plan) — the store consumer of these primitives.
- `store-mv-rehydrate-via-importcatalog` (backlog) — the deferred MV-import alternative
  to today's fail-loud arm.
