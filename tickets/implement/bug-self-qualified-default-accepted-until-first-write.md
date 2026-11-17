description: A column default that names a sibling column through its own table name, such as `default (t.b)`, is accepted when the table is created or altered and then makes every insert that uses the default fail. Such a default can never work, so it should be refused when it is declared, with the existing message that points at `new.<column>`.
architecture: docs/sql-ddl.md#262-mutation-context-table-level-parameters
files:
  - packages/quereus/src/schema/manager.ts  # validateOneDefault, rejectIllegalReferences, validateDefaultDeterminism, validateAlterColumnDefault, validateAddColumnDefault, validateDdlDefault
  - packages/quereus/src/schema/generated-column-refs.ts  # collectGeneratedColumnRefs / classifyQualified — the scope-aware reference classifier to reuse
  - packages/quereus/src/schema/table.ts  # unboundQualifierError — the generated-column equivalent of this gate, for message shape
  - packages/quereus/src/planner/building/alter-table.ts  # validateAddColumnDefault call site (needs schema name)
  - packages/quereus/src/runtime/emit/alter-table.ts  # validateAlterColumnDefault call site (needs schema name)
  - packages/quereus/test/logic/46-mutation-context.sqllogic
  - packages/quereus/test/logic/03.4-defaults.sqllogic
repro: verified
----

## What is wrong

At INSERT time a column DEFAULT can read only: `new.<column>` (a value the INSERT supplies), mutation-context variables (bare `who` or `context.who`), and columns of a source that a FROM clause *inside* the DEFAULT selects from. A table-qualified reference to the row being written (`t.b`, `main.t.b`) never resolves, and neither does a qualifier nothing binds (`zz.x`, `old.x`). `docs/sql-ddl.md` §2.6.2 already says "A column DEFAULT reads a sibling only as `new.<column>` and does not accept `<table>.<column>`."

The declaration-time gate, `validateOneDefault` in `packages/quereus/src/schema/manager.ts`, misses these in two ways:

- `rejectIllegalReferences` rejects top-level (outside any subquery) column references other than `new.` only when the table declares **no** mutation context (`rejectColumns: !hasMutationContext`). The exemption exists because a *bare* name may be a context variable. It also lets through every *qualified* name, none of which can be a variable except `context.<name>`.
- It skips every column reference inside a subquery (`subqueryDepth > 0`), because such references usually bind the subquery's own FROM. A correlated `t.who` inside `(select … from u where k = t.who)` binds no inner FROM and is missed on **every** table, with or without context.

After the gate, the build attempt fails (no table scope at DDL time) and the failure is deliberately tolerated when the table has context or the DEFAULT embeds a subquery, so the bad default is stored.

## Reproduction (dist build, memory module, this session)

Every case below is accepted at CREATE / ALTER and fails at the first INSERT that uses the default, with `<qualifier>.<name> isn't a column`:

| DEFAULT | Table |
|---|---|
| `default (d.b)` | has context |
| `default (d.who)`, column and variable both `who` | has context |
| `default (d.v)`, `v` a variable and not a column | has context |
| `default (main.d.who)` | has context |
| `default (zz.x)` (qualifier names nothing) | has context |
| `default ((select max(k) from u where k = t.who))` | has context |
| `default ((select max(k) from u where k = t.who))` | **no** context |
| `alter table d alter column c set default (d.b)` | has context |
| `alter table d alter column c set default ((select max(k) from u where k = d.b))` | **no** context |

`alter table d add column c integer default (d.b)` on a context table is already refused at ALTER time, but only incidentally — the backfill build fails with `d.b isn't a column`, even on an empty table. The new gate gives it the proper message.

These already behave correctly and must keep doing so: bare `who` and `context.who` reading a variable, `new.b`, `(select max(t.k) from t)` (a FROM inside the DEFAULT binds `t`), and the self-referencing allocator `coalesce((select max(rid) from t), 0) + mutation_ordinal()`.

`d.v` (a variable that is no column) is included deliberately: the §2.6.2 sentence "A `<table>.<name>` whose name is a variable and not a column reads the variable" describes CHECK constraints; a DEFAULT does not resolve it today (verified above), and the "does not accept `<table>.<column>`" sentence governs DEFAULT. Refusing it at declaration matches current runtime behaviour, it doesn't narrow it.

## Fix

Reuse the scope-aware classifier generated columns already use — `collectGeneratedColumnRefs` in `packages/quereus/src/schema/generated-column-refs.ts`. It walks the expression with the FROM-frame stack and labels each qualified reference `'own'` (names the owning table or `new`), `'foreign'` (bound by an inner FROM, or under a sealed view frame), `'unbound'` (nothing binds the qualifier), or `'unknown'` (an opaque subquery / function / CTE source was crossed, so it can't tell).

In `validateOneDefault`, after the bind-parameter / bare-column pre-walk, run the collector and, for each reference with a qualifier (`originalQualifier !== undefined`, shape `'column'`):

- qualifier `context` with no schema, on a table that declares context → allowed (always reaches the variable, even on a table named `context`; check this **before** looking at the binding, since the classifier reports `context.x` on a table named `context` as `'own'`);
- `'own'` with unschema'd qualifier `new` → allowed;
- `'own'` otherwise (`t.b`, `main.t.b`) → refuse with the existing `new.<column>` message. The current text says "may not reference a bare column", which is wrong for `t.b`; either name the reference (e.g. `may not reference 't.b'; use 'new.<column>' to read a value supplied by the INSERT, or a generated column instead.`) or reword to cover both. Keep the substring `new.<column>` — existing tests match `bare column` for the bare case, so keep that wording for bare names;
- `'unbound'` → refuse (nothing can resolve it), with a message naming the reference — `unboundQualifierError` in `packages/quereus/src/schema/table.ts` is the shape to mirror;
- `'foreign'` and `'unknown'` → leave alone (the existing deferral still applies).

The collector only consults its `resolveColumnInSource` argument for unqualified names, which this gate ignores, so the resolver choice is not load-bearing; passing the catalog resolver the generated-column path uses (see `resolveWithInFlightColumns` in `table.ts`) is fine, as is a resolver that answers `false` with a comment saying why.

Plumbing: the collector needs the owning schema name. `validateDefaultDeterminism` is called from `createTable` with `baseTableSchema` in hand (`manager.ts` ~line 3027); `validateAlterColumnDefault` and `validateAddColumnDefault` receive only `tableSchema.name` — add the schema name at both call sites (`runtime/emit/alter-table.ts` ~1618, `planner/building/alter-table.ts` ~123).

Once the scope walk handles qualified references, the top-level qualified arm in `rejectIllegalReferences` (`table?.toLowerCase() !== 'new'`) becomes redundant for DEFAULT; it may be narrowed to bare columns only. `rejectIllegalReferences` is also used by the CHECK validator with `rejectColumns: false`, so that caller is unaffected either way.

Catalog reload does not run `validateDefaultDeterminism` (it is called from `createTable`, not `buildTableSchemaFromAST`), so a store holding such a default still opens; its inserts fail as before. No backwards-compatibility concern.

Tidy while there: the doc comment describing `validateDefaultDeterminism` (manager.ts ~2222–2235) sits above `defaultEmbedsSubquery`, not the method it documents; move it, and update it and the `validateOneDefault` / ALTER validator comments to say qualified own-row references are rejected regardless of context.

`docs/sql-ddl.md` §2.6.2 already states the rule; no doc change needed beyond, optionally, noting that the refusal happens at declaration time.

## Tests

One sqllogic reproduction per distinct path, not one per table row above:

- `46-mutation-context.sqllogic`: on a context table, `create table … c integer default (d.b) … with context (…)` → error mentioning `new.<column>`; `default (main.d.who)` → same; `default (zz.x)` → error; `alter … set default (d.b)` → error. A case that must stay legal (`default (context.who)` or `(select max(t.k) from t)`) only if not already covered — check first.
- `03.4-defaults.sqllogic`: no-context table with `default ((select max(k) from u where k = t.b))` → error at CREATE.

## TODO

- Add the schema name parameter to `validateOneDefault` / `validateDefaultDeterminism` / `validateDdlDefault` / `validateAlterColumnDefault` / `validateAddColumnDefault` and both ALTER call sites.
- In `validateOneDefault`, classify qualified references with `collectGeneratedColumnRefs` and refuse own-row (non-`new`) and unbound qualifiers per the rules above, allowing `context.<name>` on context tables.
- Fix the error message wording for qualified references; keep `bare column` for the bare case.
- Optionally narrow `rejectIllegalReferences`' column arm to bare names; move/update the misplaced doc comment.
- Add the sqllogic cases above; run `yarn workspace @quereus/quereus test` and `yarn workspace @quereus/quereus lint`.
