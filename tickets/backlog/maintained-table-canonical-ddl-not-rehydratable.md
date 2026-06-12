----
description: Canonical maintained-table DDL emits the `create table … maintained as <body>` form, but the engine cannot consume it — `buildCreateTableStmt` ignores the `maintained` clause, so the generated DDL re-parses as a plain `createTable` and rehydrates as a plain (non-maintained) table. Round-trip is broken; 15 quereus + 22 quereus-store tests fail. Root cause: the timed-out ticket 6.2 (`maintained-table-attach-detach-verbs`) switched the DDL form ahead of landing its build/emit path.
difficulty: medium
files:
  - packages/quereus/src/schema/ddl-generator.ts                 # generateMaintainedTableDDL emits `create table … maintained as` (switched by ae7c7fc2)
  - packages/quereus/src/planner/building/ddl.ts                 # buildCreateTableStmt — drops stmt.maintained on the floor (no build path)
  - packages/quereus/test/view-mv-ddl-persistence.spec.ts        # 14 failing
  - packages/quereus/test/mv-rename-propagation.spec.ts          # 1 failing
  - packages/quereus-store/test/view-mv-persistence.spec.ts      # 22 failing (catalog rehydrate)
----

# Canonical maintained-table DDL is emitted but not re-consumable

## Symptom

`generateMaintainedTableDDL(table)` now renders the unified table form, e.g.

```
CREATE TABLE "main"."mv" ("id" INTEGER NOT NULL PRIMARY KEY, "v" INTEGER NOT NULL) maintained as select id, v from base WITH TAGS (purpose = 'live')
```

`parse(...)` returns `type: 'createTable'` with a populated `maintained` key.
But **executing that DDL produces a plain table, not a maintained one** — the
`maintained as` clause is silently discarded. Verified directly:

```
exec OK
getMaintainedTable('main','mv') → undefined
getTable('main','mv')           → present (no derivation)
select id, v from mv            → []        (empty; no backing, no fill)
```

So the canonical DDL no longer round-trips: generate → parse → exec does not
reconstruct the maintained table.

## Failing tests (reproduced at HEAD `13391069`)

`yarn workspace @quereus/quereus test` (run without `--bail`):

- `packages/quereus/test/view-mv-ddl-persistence.spec.ts` — **14 failing**
  - `generateMaintainedTableDDL fixed point › re-parses and is a fixed point: …`
    (the 9-row matrix at line 652 — `expect(parse(once).type).to.equal('createMaterializedView')`;
    actual `createTable`. The fixed-point leg also throws in `mvSchemaFromDDL`
    (line 554), which rejects any non-`createMaterializedView` parse.)
  - `generateMaintainedTableDDL fixed point › always emits a fully-qualified … MV name`
    (line 627, `^create materialized view` regex)
  - `generateMaintainedTableDDL fixed point › emits the USING clause … fixed point`
    (line 635)
  - `generateMaintainedTableDDL fixed point › emits USING with args …` (line 642)
  - `generators over LIVE-created schemas › generateMaintainedTableDDL on a live
    CREATE MATERIALIZED VIEW rehydrates faithfully` (line 706 — and the body's
    `dst.exec(ddl)` + `rehydrated.tags` check below it would also fail, since
    exec does not rehydrate the derivation)
  - `RENAME rewrites an MV body … › table rename fires one materialized_view_modified …`
    (line 875)
- `packages/quereus/test/mv-rename-propagation.spec.ts` — **1 failing**
  - `MV rename propagation: derived fields and events › TABLE rename re-keys
    sourceTables/bodyHash/sql and fires materialized_view_modified` (line 70)
- `packages/quereus-store/test/view-mv-persistence.spec.ts` — **22 failing**
  - `StoreModule view / materialized-view persistence` — catalog persist →
    closeAll → reopen → `rehydrateCatalog` re-parses/execs the canonical DDL,
    which (per above) rehydrates the MV as a plain table. Same root cause; the
    isolated single-file run shows 8 failing, the full store suite 22.

Representative assertion diff:

```
regenerated DDL re-parses
  -createTable          (actual)
  +createMaterializedView   (expected)
```

## Root cause

The canonical DDL form was switched to `create table … maintained as` by the
**timed-out** ticket-6.2 run (commit `ae7c7fc2`, "tess: timed out on
maintained-table-attach-detach-verbs"). That commit landed the *producer* side
(parser `maintained as` clause, `ast.ts` `CreateTableStmt.maintained`,
`ast-stringify`, `generateMaintainedTableDDL`, store-module/catalog wiring) but
NOT the *consumer* side: `packages/quereus/src/planner/building/ddl.ts`
(`buildCreateTableStmt`) is absent from that commit and still drops
`stmt.maintained` — it wraps the statement into a plain `CreateTableNode` with
no derivation. The emit/runtime path likewise has no maintained-clause arm for
`createTable`.

Ticket 6.2 (`tickets/implement/6.2-maintained-table-attach-detach-verbs.md`,
prereq met, still in `implement/`, carries a resume note) explicitly owns both
sides: its `files:` list names `building/ddl.ts # buildCreateTableStmt — build
path for the maintained clause` and `ddl-generator.ts # canonical DDL: create
table … maintained as for ALL maintained tables`. The producer half landed
early; the consumer half did not. The tree is therefore in a mid-migration
state where it emits a DDL form it cannot read back.

## Proper resolution

Finish ticket 6.2's build/emit path so `create table … maintained as …` (and
the `createTable` AST with a `maintained` clause) registers a maintained table
— shape-derive, backing build/fill, row-time maintenance registration — mirroring
`buildCreateMaterializedViewStmt` / the `materialized-view` emitter. Once the
table form is consumable, every test above round-trips and the `createTable`
expectation is correct. The 15 + 22 failures are the natural "producer landed,
consumer didn't" gap and should clear when 6.2 completes.

## Ruled out / not done here

- **Updating the test expectations to `createTable`** (the direction the
  `.pre-existing-error.md` report suggested) is *wrong* on its own: the failures
  are not a cosmetic keyword mismatch. The round-trip is genuinely broken — the
  live-rehydrate test (`view-mv-ddl-persistence.spec.ts:695`) and the entire
  store persistence suite exec the generated DDL and depend on a maintained
  table coming back. Flipping the keyword would make the `parse().type` lines
  pass while the rehydration bodies still fail (or, worse, mask a real regression
  by gutting the rehydrate checks). The tests correctly pin a property the engine
  does not yet satisfy.
- **Reverting `generateMaintainedTableDDL` to the `create materialized view`
  form** would make all 37 tests pass with a one-function change and restore a
  functional round-trip — but it un-does part of ticket 6.2's in-progress,
  resume-pending work and would leave 6.2's other partial changes (parser,
  ast-stringify, store-module, catalog) inconsistent with a reverted generator,
  conflicting with the agent that resumes 6.2. Deliberately NOT done so this
  triage does not interfere with active in-progress ticket work. If 6.2 will be
  parked for a while, a temporary revert is a viable stopgap — call it out to the
  6.2 owner rather than landing it blind.

## Repro

```
node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js \
  "packages/quereus/test/view-mv-ddl-persistence.spec.ts" \
  "packages/quereus/test/mv-rename-propagation.spec.ts" --no-bail --reporter min
# → 49 passing / 15 failing

node --import ./packages/quereus-store/register.mjs node_modules/mocha/bin/mocha.js \
  "packages/quereus-store/test/view-mv-persistence.spec.ts" --no-bail --reporter min
# → 12 passing / 8 failing (single file); 22 failing across the full store suite
```
