description: Validate reserved `quereus.*` tags on the direct CREATE TABLE / CREATE INDEX paths at plan-build, mirroring the ALTER `SET TAGS` arm and the declarative differ, so a misspelled or mis-sited reserved key fails loudly at create time instead of being silently stored.
files:
  - packages/quereus/src/planner/building/ddl.ts                 # buildCreateTableStmt / buildCreateIndexStmt — ADD validation here
  - packages/quereus/src/planner/building/alter-table.ts         # setTags arm — the exact pattern to mirror (lines ~122-140)
  - packages/quereus/src/schema/reserved-tags.ts                 # validateReservedTags + TagSite (reference)
  - packages/quereus/src/schema/reserved-tags-policy.ts          # raiseReservedTagDiagnostics (reference)
  - packages/quereus/src/schema/schema-differ.ts                 # lines ~217-257 — the differ's per-surface validation this mirrors
  - packages/quereus/src/parser/ast.ts                           # CreateTableStmt / ColumnDef / TableConstraint / CreateIndexStmt `tags` fields
  - packages/quereus/test/logic/50-metadata-tags.sqllogic        # add CREATE-time reserved-tag rejection cases
----

# Validate reserved `quereus.*` tags on the direct CREATE TABLE / CREATE INDEX paths

## Why

`ALTER TABLE … SET TAGS` (`planner/building/alter-table.ts`, the `setTags` arm),
the declarative differ (`schema/schema-differ.ts`), the lens compiler
(`schema/lens-compiler.ts`), and the view-mutation path all route their
`quereus.*` tags through `validateReservedTags(tags, site)` and raise via
`raiseReservedTagDiagnostics`. A misspelled or mis-sited reserved key
(`"quereus.update.taget"`, `"quereus.bogus"`, a `logical-table`-only key on a
physical object) fails loudly on those paths.

The **direct** `CREATE TABLE … WITH TAGS` and `CREATE INDEX … WITH TAGS` paths
were left out and do **not** validate — confirmed:

```sql
create table t (id integer primary key) with tags ("quereus.bogus" = 1);             -- ACCEPTED (should reject)
create table t2 (id integer primary key, x integer with tags ("quereus.bogus" = 1)); -- ACCEPTED (should reject)
create index ix on t (x) with tags ("quereus.bogus" = 1);                            -- ACCEPTED (should reject)
```

So the same key the differ / `SET TAGS` reject is silently stored by the most
common authoring path. A typo'd reserved key enters the catalog and never
surfaces (a table/index tag has **no** lazy re-validation path — unlike a view
tag, see Scope below). This ticket closes that hole for physical objects.

## Design (resolved)

**Validate at the planner build site** (`planner/building/ddl.ts`), mirroring
`alter-table.ts`'s `setTags` arm — this is where the AST (and its source
location) is in hand, exactly as the ALTER path does it. `SchemaManager`'s
`buildTableSchemaFromAST` is the catch-all but runs without AST location and is
also reached by the catalog-import (load) path, which must **not** start
rejecting already-persisted schemas (see Scope). So the planner site is correct.

Mirror the **same three surfaces the differ validates** for a declared table
(`schema-differ.ts:217-257`), at the matching sites:

| Surface (AST)                          | TagSite               |
|----------------------------------------|-----------------------|
| `stmt.tags` (table-level `WITH TAGS`)  | `physical-table`      |
| each `stmt.columns[].tags`             | `physical-column`     |
| each `stmt.constraints[].tags`         | `physical-constraint` |

and for `CREATE INDEX`:

| `stmt.tags` (index-level `WITH TAGS`)  | `physical-index`      |

Accumulate every surface's diagnostics into one list per statement and raise
**once** via `raiseReservedTagDiagnostics`, threading the statement's source
location (`stmt.loc?.start`) so the error is sited, with a no-op `log` sink for
warnings (warnings never block — matches the ALTER arm and the differ).

Free-form (non-`quereus.*`) tags are skipped by `validateReservedTags` itself,
so nothing else is affected.

### Sketch (illustrative — match surrounding style, tabs)

```ts
import { validateReservedTags, type TagSite } from '../../schema/reserved-tags.js';
import { raiseReservedTagDiagnostics } from '../../schema/reserved-tags-policy.js';

function raiseCreateTableTagDiagnostics(stmt: AST.CreateTableStmt): void {
  const diagnostics = [
    ...validateReservedTags(stmt.tags, 'physical-table'),
    ...stmt.columns.flatMap(c => validateReservedTags(c.tags, 'physical-column')),
    ...(stmt.constraints ?? []).flatMap(c => validateReservedTags(c.tags, 'physical-constraint')),
  ];
  raiseReservedTagDiagnostics(diagnostics, {
    loc: stmt.loc ? { line: stmt.loc.start.line, column: stmt.loc.start.column } : undefined,
    log: () => { /* warnings (e.g. empty ack rationale) never block */ },
  });
}
// call it at the top of buildCreateTableStmt, before constructing CreateTableNode.
// CREATE INDEX: validateReservedTags(stmt.tags, 'physical-index') in buildCreateIndexStmt.
```

## Scope decisions (resolved — do not re-litigate)

- **CREATE VIEW / CREATE MATERIALIZED VIEW are intentionally OUT of scope.**
  View `WITH TAGS` is already validated **lazily, at mutation time** by the
  view-mutation path, and `test/logic/93.4-view-mutation.sqllogic` (lines
  ~1160-1192) deliberately codifies that a removed/typo'd reserved key on a view
  DDL surfaces *when the view is mutated*, not at `CREATE VIEW`
  (e.g. `create view bvu_v … with tags ("quereus.update.policy" = 'strict')`
  succeeds; the error fires on the subsequent `insert`). Adding eager validation
  at `buildCreateViewStmt` / `buildCreateMaterializedViewStmt` would **break
  those tests and contradict the deliberate design.** A view tag is meaningful
  only for mutation, so views are not a silent-storage hole the way tables /
  indexes are. Do **not** touch `create-view.ts` / `materialized-view.ts`. The
  "eager vs lazy timing for view tags" question is parked (see backlog ticket
  `reserved-tag-validation-inline-constraint-and-view-eager`).

- **Catalog import / load path is OUT of scope.** `SchemaManager.importTable`
  (and `importCatalog`) re-load already-persisted DDL via
  `buildTableSchemaFromAST`. Validation is an **authoring-time** gate (matching
  how `createTable`'s determinism checks are create-only and skipped on import);
  failing a load could brick an openable database. Do not add validation there.

- **Inline named column-constraint tags are OUT of scope** (parity-preserving).
  The differ validates `ColumnDef.tags` and table-level `TableConstraint.tags`
  but **not** `ColumnDef.constraints[].tags` (an inline *named* column
  constraint's `WITH TAGS`). Mirroring the differ's three surfaces keeps CREATE
  and the differ symmetric — which is this ticket's actual goal. Closing the
  inline-named-constraint gap (in *both* differ and CREATE together, to avoid a
  new asymmetry) is parked in the backlog ticket above. The ticket's
  "named-constraint `WITH TAGS`" requirement is satisfied by the **table-level**
  named-constraint surface (`stmt.constraints[].tags`), which is in scope.

## Edge cases & interactions

- **Free-form tags unaffected** — `with tags (display_name = 'x', audit = true)`
  and any non-`quereus.*` key still create cleanly (existing Phases 1-10 of
  `50-metadata-tags.sqllogic` must continue to pass). `validateReservedTags`
  skips keys not under the `quereus.` prefix.
- **Valid rename hints accepted** — `quereus.id` / `quereus.previous_name` are
  legal at `physical-table` / `physical-column`, so
  `create table widget (…) with tags ("quereus.id" = 'tbl-thing')`
  (`50.2-declare-schema-renames.sqllogic:44`, a *direct* create) must still
  succeed. Verify this does not regress.
- **Mis-sited valid key** — e.g. `quereus.lens.access.<col>` (legal only at
  `logical-table`) or `quereus.update.default_for.<col>` (legal at
  `view-ddl`/`projection`/`dml-stmt`) on a physical CREATE TABLE column ⇒
  `tag-not-allowed-here` error.
- **Multiple offending tags in one statement** — diagnostics accumulate across
  table → columns (in order) → constraints (in order); the *first* `error`
  diagnostic is raised (deterministic ordering). Cover at least one statement
  with a bad table tag + a bad column tag and assert it errors.
- **IF NOT EXISTS** — build-time validation fires regardless of whether the
  object already exists (matches ALTER's build-time semantics): a malformed
  reserved tag is rejected even when the create would otherwise be skipped at
  runtime. Acceptable / intended; note it in a test comment.
- **`nondeterministic_schema` option** — does not gate tag validation (tags are
  not expressions); validation runs unconditionally in both modes.
- **Empty / cleared tags** — `with tags ()` and absent `tags` produce no
  diagnostics (`validateReservedTags(undefined, …)` returns `[]`).
- **CREATE INDEX with a valid hint** — `create index … with tags ("quereus.id"
  = 'idx-x')` is legal at `physical-index` and must succeed; a bogus key rejects.

## Regression risk (call out)

This **starts rejecting** schemas that previously parsed — the intended
correctness fix. Before finishing, grep tests/samples for direct
`create table … with tags ("quereus.…")` / `create index … with tags
("quereus.…")` and confirm none carry a now-invalid key. Known create-time
`quereus.*` usages reviewed at plan time:
- `50.2-declare-schema-renames.sqllogic:44` — direct create, `quereus.id` ⇒ valid, no regression.
- `50-metadata-tags.sqllogic` — all create-time tags are free-form ⇒ unaffected.
- `53-reserved-tags.sqllogic`, the `} with tags (…)` blocks in `50.2` — these are
  inside `DECLARE SCHEMA` (differ path), **not** the direct create path ⇒ unaffected.
- `93.4-view-mutation.sqllogic` create-time `quereus.*` are on **views/DML** ⇒ out of scope (lazy path), unaffected.

## Error-message assertion strings (for the sqllogic `-- error:` lines)

`validateReservedTags` messages (see `reserved-tags.ts`):
- unknown key  → `Unknown reserved tag '…' on …` — assert with `-- error: reserved tag`
  (lowercase `reserved tag` is a substring of `Unknown reserved tag`; this is what
  the existing ALTER Phase 14/21 tests use).
- mis-sited    → `Reserved tag '…' is not allowed on …` — assert with
  `-- error: not allowed` (capital `Reserved`, so `reserved tag` is NOT a substring).

## TODO

- [ ] In `planner/building/ddl.ts`, add a `raiseCreateTableTagDiagnostics(stmt)`
      helper (table/column/constraint surfaces) and call it at the top of
      `buildCreateTableStmt` before constructing `CreateTableNode`.
- [ ] In `buildCreateIndexStmt`, validate `stmt.tags` at `physical-index` and
      raise the same way (inline or a tiny shared helper — keep DRY).
- [ ] Thread `stmt.loc?.start` into `raiseReservedTagDiagnostics` for a sited error.
- [ ] Add a new phase to `test/logic/50-metadata-tags.sqllogic` covering:
      - table-level bogus key rejected; column-level bogus key rejected;
      - table-level **named-constraint** bogus key rejected
        (`constraint c check (x>0) with tags ("quereus.bogus" = 1)`);
      - mis-sited valid key rejected (e.g. `quereus.lens.access.id` at table);
      - `CREATE INDEX … with tags ("quereus.bogus" = 1)` rejected;
      - valid `quereus.id` on table / column / index **accepted** and
        round-tripping through `schema()` / `table_info()` / `index_info()`;
      - a free-form `with tags` still creates cleanly (guard against over-rejection).
- [ ] Confirm no existing test/sample direct CREATE carries a now-invalid
      `quereus.*` tag (grep per Regression risk above).
- [ ] `yarn workspace @quereus/quereus run build`, then
      `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/tags-test.log; tail -n 80 /tmp/tags-test.log`
      and lint (single-quote globs on Windows).
