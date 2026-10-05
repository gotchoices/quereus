description: When a new version of a declared schema adds or removes a CHECK, UNIQUE or FOREIGN KEY rule that has no name, "apply schema" silently does nothing, so a database upgraded from the old version never gets (or never loses) the rule while one created fresh at the new version does. Make the schema comparison match unnamed rules by what they say, and add or drop them accordingly.
architecture: docs/schema-rename-detection.md
files:
  - packages/quereus/src/schema/schema-differ.ts   # collectDeclaredNamedConstraints (~1903), computeTableAlterDiff constraint block (~2265-2365), reconciledDeclaredBody (~2006), generateMigrationPlan constraint emission (~3088-3113), UndoRenderer.readdConstraint / dropAddedConstraint (~3390-3426)
  - packages/quereus/src/schema/catalog.ts         # CatalogTable.namedConstraints (~61), isAutoConstraintName (~204), table catalog build (~335-375)
  - packages/quereus/src/schema/catalog-rendering.ts # renderCatalogForComparison / renderNamedConstraint — new catalog field needs a rendering arm (feeds apply-schema unchanged fast path + restore check)
  - packages/quereus/src/schema/table.ts           # disambiguateAutoConstraintName, collectTableConstraintNames (reuse for minting)
  - packages/quereus/src/schema/constraint-builder.ts # mintCheckConstraintName — ALTER ADD unnamed CHECK mints user-class `check_<n>` (context only; do not change)
  - packages/quereus/test/declarative-equivalence.spec.ts, packages/quereus/test/util/schema-equivalence.ts # fresh-vs-direct harness; model a fresh-vs-upgrade test on it
  - packages/quereus/test/logic/50-declarative-schema.sqllogic # sqllogic home for the pinned cases
  - docs/schema-rename-detection.md                # line ~17 and ~41 say unnamed constraints are out of scope — update
  - docs/schema-undo-plan.md
repro: verified
----
<!-- resume-note -->
RESUME: A prior agent run on this ticket did not complete.
  Prior run: 2026-10-05T04:42:10.092Z (agent: claude)
  Log file: C:\projects\quereus\tickets\.logs\declarative-differ-ignores-unnamed-constraint-additions.implement.2026-10-05T04-42-10-090Z.log
Read the log to see what was done. Resume where it left off.
If the prior run hit a timeout or repeated error, be cautious not to rush into the same situation.
<!-- /resume-note -->

# Declarative differ ignores unnamed constraints

Reported from optimystic (their `tickets/blocked/quereus-differ-ignores-unnamed-constraint-additions.md`): an upgraded database ends up with a different rule set than a freshly created one.

## Reproduced (memory backend, HEAD ad2a8add8)

Start: `declare schema s { table p { id integer primary key } table t { id integer primary key, a integer null, b integer null } }`, apply, insert `(1, 5, 5)`. Then redeclare `t` with one of:

| case | v2 table body addition | `diff schema s` | violating insert after apply |
|---|---|---|---|
| A | `check (a > 0)` (table-level, unnamed) | `[]` | succeeds |
| B | `a integer null check (a > 0)` (column-level, unnamed) | `[]` | succeeds |
| C | `unique (a)` (table-level, unnamed) | `[]` | succeeds |
| E | `foreign key (b) references p(id)` (unnamed) | `[]` | succeeds |
| F | `a integer null unique` (column-level, unnamed) | `[]` | succeeds |
| D (control) | `constraint pos check (a > 0)` | `ALTER TABLE s.t ADD constraint pos check (a > 0)` | fails `CHECK constraint failed: pos` |

The **removal** direction is equally silent: fresh-create at v2 (any of A–F), redeclare at v1, `diff schema s` → `[]` (the control D emits `DROP CONSTRAINT pos`).

### Adjacent bug at the same site (verified, fold in here)

A **named** column-level constraint on a column the diff is *adding* is emitted twice — once inline in `ADD COLUMN`, again as `ADD constraint` — and apply fails:

```
declare schema s { table t { id integer primary key } }   -- apply
declare schema s { table t { id integer primary key, c integer null constraint cpos check (c > 0) } }
diff schema s → ALTER TABLE s.t ADD COLUMN c integer null constraint cpos check (c > 0)
                ALTER TABLE s.t ADD constraint cpos check (c > 0)
apply → Cannot add constraint 'cpos' to table 't': a constraint with that name already exists
```

Cause: `collectDeclaredNamedConstraints` collects column-level named constraints regardless of whether their column is in `columnsToAdd`, and `columnDefToString` already renders them inline. The unnamed fix would hit the exact same duplicate (`_check_c` added inline, then body-matched as missing), so both must skip column-level constraints on columns being added.

(The same repro also shows the failed apply's undo `DROP COLUMN c` failing because a CHECK references `c` — that is a different site, filed as `bug-apply-undo-of-add-column-with-inline-constraint-fails` in backlog.)

## Root cause

`computeTableAlterDiff` diffs constraints only through name-keyed maps. Declared side: `collectDeclaredNamedConstraints` drops a constraint with no name and drops `_`-prefixed names. Actual side: `collectSchemaCatalog` (catalog.ts) puts into `namedConstraints` only constraints whose name is present and not `_`-prefixed (`isAutoConstraintName`). An unnamed / auto-named constraint therefore has no identity on either side and never reaches `constraintsToAdd` / `constraintsToDrop`.

## How unnamed constraints are actually stored today (measured)

Ran CREATE / ALTER on memory and read `checkConstraints` / `uniqueConstraints` / `foreignKeys` names:

| declaration | CREATE TABLE stores | `ALTER TABLE ADD …` (unnamed) stores |
|---|---|---|
| column-level CHECK on `a` | `_check_a` | n/a (ADD COLUMN inline: `_check_<col>`) |
| table-level CHECK | `undefined` (no name) | `check_0` (`mintCheckConstraintName` — **not** `_`-prefixed, so user-class) |
| UNIQUE (column or table) | `undefined` | `undefined` |
| FOREIGN KEY on `b` | `_fk_t_b` | `_fk_t_b` |

`DROP CONSTRAINT` resolves by stored name only: `_check_a`, `_fk_t_b`, `check_0` are droppable; an `undefined`-named CHECK or UNIQUE is not (`Named constraint '_uc_b' not found` — the `_uc_*` spelling is only the backing index name).

## Design (decided)

**Identity of an unnamed constraint = its canonical body**, compared as a multiset (two identical unnamed CHECKs are two entries). "Unnamed" means: declared side — no name, or a `_`-prefixed name; actual side — `name` undefined or `isAutoConstraintName`. PRIMARY KEY and `derivedFromIndex` UNIQUE stay excluded exactly as today. The named lifecycle is unchanged.

- **Catalog**: add a sibling list to `CatalogTable`, e.g. `unnamedConstraints: Array<{ kind: 'check' | 'unique' | 'foreignKey'; name?: string; definition: string; bodyAst?: AST.TableConstraint }>` — `name` is the stored auto-name when there is one (needed to DROP and for undo), `definition` via the same `constraintToCanonicalDDL` the named list uses. Add a rendering arm in `catalog-rendering.ts` (the comparison render feeds the apply-unchanged fast path; omit `name` from that render, since names here are not identity).
- **Declared**: collect unnamed constraints from table-level and column-level clauses through the existing `columnConstraintToTableConstraint`. Reuse `DeclaredNamedConstraint` with `name` made optional (or a sibling type) so `reconciledDeclaredBody` can be reused unchanged.
- **Skip column-level constraints (named and unnamed) whose column is being added** (`!colRenames.pairs.has(col)`) — `ADD COLUMN` carries them inline. This fixes the adjacent duplicate-ADD bug. Table-level constraints referencing a new column are *not* carried by ADD COLUMN and still go through the add path (which already runs after column adds).
- **Matching key**: declared → `reconciledDeclaredBody(...)` (inverse-applies in-diff column/table renames, so a rename alone never churns; identity when there are no renames); actual → `definition`. Consume one actual per match.
- **Add** (declared unmatched): emit an `ADD constraint <reserved-name> <body>` fragment with an explicit `_`-prefixed name so the result lands in the auto class (stable on re-diff) and is droppable/undoable:
  - column-level CHECK on `c` → `_check_<c>` (identical to what CREATE TABLE mints);
  - table-level CHECK → `_check_<n>`, n = actual `checkConstraints.length` bumped until free (mirrors the `_check_<index>` label `row-constraints.ts` `generateDefaultConstraintName` already shows for unnamed CHECKs). Do **not** emit it unnamed: the engine would mint user-class `check_<n>`, which the next diff would DROP and re-ADD forever;
  - FK → `_fk_<table>_<cols>` (what both engine paths already mint);
  - UNIQUE → `_uc_<cols>` (matches the backing structure name both paths already use, so no structure-name collision; check `assertUniqueConstraintIndexNameFree` accepts it).
  Disambiguate every minted name with `disambiguateAutoConstraintName` against `collectTableConstraintNames`-equivalent names from the actual catalog plus names minted earlier in this diff. Tags from the declaration ride on the fragment.
- **Drop** (actual unmatched): stored name present → `DROP CONSTRAINT <name>`. Stored name `undefined` (CREATE-time table-level CHECK, any CREATE- or ALTER-time UNIQUE) → there is no statement that removes it; **throw a `QuereusError` at diff time** naming the table and the constraint body, telling the user to name the constraint or rebuild the table. Silent no-op is the bug being fixed; a loud refusal is what the ticket asked for.
- **require-hint**: unnamed adds/drops are not rename candidates; do not count them toward `enforceRequireHint`.
- **Tags** on unnamed constraints: not diffed (no name to `SET TAGS` against). Leave a `NOTE:` at the site.
- **Undo plan**: `readdConstraint` must also look up the new unnamed list by stored name (otherwise dropping `_check_a` gets `NOTHING_TO_UNDO` — a silently non-restorable step). `dropAddedConstraint` works unchanged because every emitted add carries a name.

### Known residual (accept, document)

Upgrade and fresh create now enforce the same rules and both re-diff to `[]`, but are not byte-identical in two ways: a table-level unnamed CHECK is `undefined`-named on fresh create and `_check_<n>` on upgrade; an unnamed UNIQUE is `undefined` on fresh create and `_uc_<cols>` on upgrade. Constraint array order (and so persisted DDL order) already differs between append-on-upgrade and declaration-order-on-create even for named constraints, so byte identity was never achievable through ALTER. Making CREATE TABLE mint the same reserved names for unnamed table-level CHECK / UNIQUE would close the naming gap and make every constraint droppable, but changes persisted DDL and some error text — if the implementer agrees it is worth doing, file it as a `feat-` backlog ticket rather than widening this one. A table whose CHECK was added imperatively (`alter table … add check (…)` → user-class `check_0`) and is then declared unnamed will see one-time churn (drop `check_0`, add `_check_<n>`); acceptable.

## Tests to add

- sqllogic in `50-declarative-schema.sqllogic` (runs on memory via `yarn test` and on store via `yarn test:store`): cases A–F above — diff shows the ADD, apply, violating insert fails, re-diff `[]`; removal direction for the droppable kinds (column CHECK, FK, upgrade-added table CHECK/UNIQUE) emits DROP and re-diff `[]`; removal of a CREATE-time unnamed table CHECK / UNIQUE errors with the new message; the named-constraint-on-new-column case applies cleanly; a column rename touching an unnamed CHECK/UNIQUE/FK produces no constraint churn; two identical unnamed CHECKs → adding a third identical one emits exactly one ADD.
- spec (alongside `declarative-equivalence.spec.ts`): **fresh-vs-upgrade property** — for each case, DB1 = apply v2 fresh; DB2 = apply v1, then apply v2; assert both re-diff `[]`, both reject the same probe rows, and `collectSchemaCatalog` `unnamedConstraints` match by `(kind, definition)` multiset.
- Guard against churn: every existing sqllogic/spec that applies a declared schema and then expects `diff schema` `[]` now also exercises the unnamed comparison — any canonical-body mismatch between a declared unnamed constraint and its stored form shows up there as a spurious DROP/ADD. Run the full `yarn test` and `yarn test:store` (the store path round-trips constraints through persisted DDL).

## TODO

- Add `unnamedConstraints` to `CatalogTable` + build it in `catalog.ts`; render arm in `catalog-rendering.ts`.
- Declared-side collector for unnamed constraints; skip column-level constraints (named + unnamed) on columns in `columnsToAdd`.
- Body-multiset matching in `computeTableAlterDiff` using `reconciledDeclaredBody` / `definition`; reserved-name minting for adds; DROP by stored name; diff-time error for undroppable removals.
- Extend `UndoRenderer.readdConstraint` to the unnamed list.
- Pin cases in sqllogic (memory + store) and the fresh-vs-upgrade spec.
- Update `docs/schema-rename-detection.md` (lines ~17 and ~41 currently say unnamed constraints are out of scope) and the undo table in `docs/schema-undo-plan.md` if it changes.
- `yarn workspace @quereus/quereus run lint`, `yarn test`, `yarn test:store`.
