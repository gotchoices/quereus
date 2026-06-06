description: Make generateTableDDL emit table-level UNIQUE / FOREIGN KEY / CHECK constraints so store-backed tables retain (and keep enforcing) their constraints across closeAll() + reopen + rehydrateCatalog. Confirmed bug: generateTableDDL serializes only columns/PK/USING/tags; the store persists that string and re-parses it on open, so all table constraints silently vanish on reconnect. Fix reuses the existing AST→SQL emitter (tableConstraintsToString) via the already-present schema→AST lift, so the two DDL paths cannot drift. Excludes CREATE-UNIQUE-INDEX-derived UNIQUE constraints (round-trip via their index) to preserve declarative-differ idempotency.
prereq:
files:
  - packages/quereus/src/schema/ddl-generator.ts                # generateTableDDL (add constraint emission); schemaConstraintToTableConstraint (make full-fidelity)
  - packages/quereus/src/emit/ast-stringify.ts                  # tableConstraintsToString — full-fidelity emitter (name prefix + body + WITH TAGS suffix); reuse, do NOT re-implement
  - packages/quereus/src/schema/table.ts                        # RowConstraintSchema / UniqueConstraintSchema / ForeignKeyConstraintSchema shapes; maskToOps
  - packages/quereus/src/schema/catalog.ts                      # tableSchemaToCatalog → ddl = generateTableDDL(...,db); namedConstraints (separate channel — unchanged); isAutoConstraintName
  - packages/quereus-store/src/common/store-module.ts          # saveTableDDL → generateTableDDL; rehydrateCatalog/loadAllDDL (re-parse on open) — the lossy round-trip
  - packages/quereus-store/test/rehydrate-catalog.spec.ts      # store reopen harness (createInMemoryProvider; db1+mod1 → insert → db2+mod2 → rehydrate) — add enforcement-survival cases here
  - packages/quereus-store/test/ddl-generator.spec.ts          # generateTableDDL unit tests — add per-constraint-class round-trip asserts
  - packages/quereus/test/ddl-generator-roundtrip-positions.spec.ts  # generator parse-back reserved-word suite — sibling for a quereus-side constraint round-trip
  - packages/quereus/test/declarative-equivalence.spec.ts      # idempotency guards (derived-from-index UNIQUE, unnamed auto-name) — must stay green
----

# Store DDL round-trip drops table constraints — emit them in generateTableDDL

## Confirmed diagnosis

`generateTableDDL(tableSchema)` (`packages/quereus/src/schema/ddl-generator.ts:47`) emits **only** column
defs + (composite/singleton) `PRIMARY KEY` + `USING` + `WITH TAGS`. It never emits UNIQUE, FOREIGN KEY,
or CHECK. Reproduced directly: a table created with three named constraints

```sql
create table t (
  id integer primary key, email text, qty integer, pref integer,
  constraint uq_email unique (email),
  constraint chk_qty  check (qty > 0),
  constraint fk_pref  foreign key (pref) references parent (pid)
)
```

has `schema.uniqueConstraints=[uq_email]`, `schema.foreignKeys=[fk_pref]`,
`schema.checkConstraints=[chk_qty]`, yet `generateTableDDL(schema)` returns:

```
CREATE TABLE "main"."t" ("id" INTEGER NOT NULL PRIMARY KEY, "email" TEXT NOT NULL,
  "qty" INTEGER NOT NULL, "pref" INTEGER NOT NULL) USING memory
```

The store calls `generateTableDDL` in `saveTableDDL` (`store-module.ts:1345`), persists the string in the
catalog store, and on open re-parses it via `loadAllDDL` → `rehydrateCatalog` → `importCatalog`
(`store-module.ts:1358-1406`). Because the persisted string has no constraints, the rehydrated
`TableSchema` has none — so a UNIQUE / FK / CHECK declared at CREATE TABLE, added via
`ALTER TABLE ADD CONSTRAINT` (10.25), or renamed (10.2x) is **silently dropped on reconnect**. This is a
data-integrity regression for the store backend; memory is unaffected (it keeps the live `TableSchema`
and never round-trips through `generateTableDDL`).

## Why the existing green tests miss it

- `declarative-equivalence` round-trips use the **AST→SQL** path (`createTableToString` /
  `tableConstraintsToString` in `emit/ast-stringify.ts`), which *does* emit constraints — a different
  emitter from the store's **schema→DDL** `generateTableDDL`. The catalog's per-constraint diffing also
  rides a **separate** channel: `tableSchemaToCatalog` builds `namedConstraints` independently via
  `constraintToCanonicalDDL` (`catalog.ts:223-230`), so the differ stays correct even though the `ddl`
  field is constraint-free. Nothing exercised re-parsing `generateTableDDL`'s output for constraints.
- 10.25 / 10.2x suites assert in-session enforcement only; none close + reopen a store DB.

## Fix design — reuse the AST emitter, don't write a second one

`tableConstraintsToString(constraints: AST.TableConstraint[])` (`ast-stringify.ts:1203`) already renders a
**full-fidelity** table constraint: `constraint <name> ` prefix (when named) + the body
(`unique (...)` / `check [on ops] (...)` / `foreign key (...) references ...`) + `conflictToString` +
`tagsClauseToString(c.tags)` suffix. It is the same code the declarative path uses, so routing the store
DDL through it guarantees the two DDL paths cannot drift in constraint syntax.

`ddl-generator.ts` already has the schema→AST lift: `schemaConstraintToTableConstraint(kind, constraint,
tableSchema)` (`ddl-generator.ts:132`), used today by `constraintToCanonicalDDL`. **It currently drops
`name`, `tags`, and FK deferrability** because the canonical-body consumer strips them anyway
(`constraintBodyToCanonicalString` does `{ ...tc, name: undefined, tags: undefined }` and
`canonicalForeignKeyClause` drops the deferrable clause — `ast-stringify.ts:1290,1261`). So you can make the
single lift **full-fidelity** (preserve name + tags; map FK `deferred` → `deferrable`/`initiallyDeferred`)
**without** affecting `constraintToCanonicalDDL` — both the strip happens downstream in the canonical path.
Keep one lift function; do not fork a parallel one.

### What `generateTableDDL` must additionally emit

Inside the existing `columnDefs` paren list (alongside the composite-PK clause already appended at
`ddl-generator.ts:60-67`), append table constraints in a **deterministic order** (byte-stable catalog DDL
matters for the differ and for diff-on-disk). Suggested order: CHECK, then UNIQUE, then FOREIGN KEY, each
in stored-array order. For each:

- **CHECK** — every entry in `tableSchema.checkConstraints`. (These are real declared CHECKs only;
  synthetic FK-enforcement `_fk_*` checks are built at *plan* time in `foreign-key-builder.ts` and are
  **not** stored in `checkConstraints`, so there is nothing synthetic to filter here.) Emit `c.name` when
  set (column-level CHECKs carry the auto `_check_<col>`; table-level unnamed carry `undefined` — both
  re-parse stably and `_`-names stay excluded from `namedConstraints`).
- **UNIQUE** — every entry in `tableSchema.uniqueConstraints` **except** those with `derivedFromIndex`
  set. Those are synthesized from a `CREATE UNIQUE INDEX` and must round-trip via their index, not as a
  table constraint, or the declarative differ churns a spurious DROP CONSTRAINT (guarded by the existing
  test "a CREATE UNIQUE INDEX-derived constraint does not churn a DROP CONSTRAINT" in
  `declarative-equivalence.spec.ts`).
- **FOREIGN KEY** — every entry in `tableSchema.foreignKeys`. The lift maps child column indices → names,
  `referencedColumnNames` → the `references parent(cols)` list (omit the list when
  `referencedColumnNames` is undefined → bare `references parent`, re-parse defers to parent PK), plus
  `onDelete`/`onUpdate` and deferrability.

`generateTableDDL`'s no-`db` (persistence) and `db`-context (catalog readability) branches should emit
constraints identically — constraints have no session-default elision.

## Edge cases & decisions

- **Naming fidelity** — emit `c.name` whenever present (user names *and* engine `_`-auto-names). User
  names are required for DROP/RENAME CONSTRAINT durability; `_`-names re-parse fine and remain excluded
  from the differ's `namedConstraints` via `isAutoConstraintName`, so idempotency holds either way.
- **CHECK `on <ops>`** — `schemaConstraintToTableConstraint` already maps the op mask via `maskToOps`.
  `tableConstraintsToString` emits `check on insert, update (...)` for the default mask. That is verbose
  but re-parses correctly (parser accepts the `on` clause). Acceptable; do not special-case the default
  mask in the persistence emitter (canonicalization is only for the *differ* body-compare, not for
  persistence). Confirm the parser accepts `check on insert, update (...)` — it must, since the AST path
  emits it.
- **Cross-schema FK** — `AST.ForeignKeyClause.table` is an unqualified name; `ForeignKeyConstraintSchema`
  carries `referencedSchema`. If a FK references a parent in a *different* schema, the unqualified
  `references <table>` cannot encode the schema. Check whether the parser/`ForeignKeyClause` supports a
  schema-qualified reference; if not, this is a **pre-existing** fidelity gap (cross-schema FKs are
  already excluded from `referencedTables` drop-ordering in `catalog.ts:188`). Do **not** expand scope —
  if unsupported, leave same-schema FKs correct and note the cross-schema limitation in a code comment +
  the review handoff.
- **Idempotency** — the catalog `ddl` field (`tableSchemaToCatalog`, `catalog.ts:170`) now carries
  constraints. The differ's add/drop/rename still rides `namedConstraints` (unchanged). Verify the full
  `declarative-equivalence` + `catalog` suites stay green; watch specifically the two idempotency tests
  (unnamed-auto-name CHECK; index-derived UNIQUE).
- **Singleton/heap tables** — constraint emission is independent of the `PRIMARY KEY ()` singleton path;
  don't disturb it.

## Reconcile the downstream 10.3 note

`tickets/implement/10.3-alter-constraint-body-change-drop-add.md` (≈line 45) claims `ddl-generator.ts`
"already serializes constraints inside `generateTableDDL`." That premise was false before this fix and
becomes true after it. If that ticket is still pending when this lands, update its wording so it no longer
asserts the false premise (its persistence assumption now actually holds).

## Tests

- **`packages/quereus-store/test/rehydrate-catalog.spec.ts`** — add reopen-survival cases using the
  existing `createInMemoryProvider` + two-Database harness already in the file (db1+mod1 → CREATE +
  enforcing write to persist DDL → db2+mod2 → `rehydrateCatalog`):
  - UNIQUE: after reopen, a duplicate insert on the unique column still fails with CONSTRAINT.
  - CHECK: after reopen, a CHECK-violating insert still fails with CONSTRAINT.
  - FOREIGN KEY: after reopen (with `foreign_keys` pragma on), an orphan child insert still fails;
    a valid one succeeds. (See `fk-cascade.spec.ts` for the FK-pragma setup pattern.)
  - Also assert `result.errors` is empty (the re-parsed constraint DDL must itself parse cleanly).
- **`packages/quereus-store/test/ddl-generator.spec.ts`** — add `generateTableDDL` unit asserts that the
  emitted string contains the expected `unique (...)` / `check (...)` / `foreign key (...) references ...`
  clauses (and the constraint name for named ones), plus a negative assert that a `derivedFromIndex`
  UNIQUE is **not** emitted as a table constraint.
- **quereus-side parse-back round-trip** — add a focused test (sibling to
  `ddl-generator-roundtrip-positions.spec.ts`, or extend the `catalog.spec.ts` "DDL roundtrip" describe)
  that builds a table with one of each constraint class, runs `generateTableDDL`, re-`parse()`s it, and
  asserts the reconstructed constraint set is equivalent (names + columns + FK actions + CHECK expr).

## TODO

- Make `schemaConstraintToTableConstraint` full-fidelity: preserve `name` and `tags` on the lifted
  `AST.TableConstraint`; for `foreignKey`, map `deferred` → `deferrable`/`initiallyDeferred` (and carry
  `referencedSchema` if/when the AST can encode it). Confirm `constraintToCanonicalDDL` output is
  unchanged (the canonical path strips name/tags/deferrable downstream) — keep its existing tests green.
- In `generateTableDDL`, after the PK clause, append table constraints via `tableConstraintsToString`
  over the lifted CHECK / UNIQUE(non-derived) / FK schema constraints, in a deterministic order, inside
  the column-def paren list. Apply the `derivedFromIndex` filter for UNIQUE.
- Verify the parser round-trips the emitted forms (named/unnamed, `check on <ops>`, FK actions,
  deferrable, bare `references parent`). Add the parse-back test above.
- Add the store reopen-survival tests (UNIQUE/CHECK/FK) and the `generateTableDDL` unit asserts.
- Run `yarn workspace @quereus/quereus test` (declarative-equivalence + catalog + ddl-generator suites)
  and `yarn workspace @quereus/store test` (rehydrate-catalog). Stream output with `tee`.
- Run `yarn workspace @quereus/quereus lint` (single-quoted globs on Windows).
- If cross-schema FK fidelity is unsupported by the AST, document the limitation in code + handoff;
  do not expand scope.
- Reconcile the 10.3 ticket's false "already serializes constraints" premise if it is still pending.
