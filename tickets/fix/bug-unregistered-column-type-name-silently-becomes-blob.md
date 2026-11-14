description: Declaring a column with a type name nothing has registered succeeds, and the column quietly becomes a binary column. A host that relies on a custom type and forgets to register it on one of its processes gets a different table there, with no error to say so.
architecture: docs/types.md
files:
  - packages/quereus/src/types/registry.ts  # inferType, about lines 128-165: an unknown name falls through the affinity keywords to BLOB with a debug log; getTypeOrDefault does the same
  - packages/quereus/src/schema/table.ts  # a caller of the lookup when a column is declared
  - packages/quereus/src/planner/building/alter-table.ts  # another, for ADD COLUMN
  - docs/types.md  # § Design Decisions, § Logical Types
repro: verified
----

# An unregistered column type name silently becomes BLOB

## What happens

Measured on 2026-11-13 against the published `@quereus/quereus` 5.4.0 from the SiteCAD tree:

```sql
create table U (id integer primary key, v volume) using memory;
```

On a database where nothing registered `VOLUME`, the statement succeeds and `table_info('U')` reports column `v` as `BLOB`. `TypeRegistry.inferType` tries an exact match, then the SQLite affinity keywords, then returns `BLOB_TYPE` with a debug-level log ("Unknown type 'volume', defaulting to BLOB"). Its comment gives the reason: SQLite behaviour.

Two related observations from the same measurement:

- **Registration is process-wide, not per database.** A second `Database` in the same process resolved `length` without registering it. So whether a name is known depends on what else ran in the process, which makes the fallback harder to notice in tests and easier to hit on a host that starts differently.
- **The affinity keywords match inside custom names.** A name that contains a keyword is mapped by it: a type meant as `POINT` contains `INT` and becomes INTEGER; `REALM` would become REAL. A registered name wins by the exact-match step, so this bites only when the registration is missing, which is the case in question.

## Why it matters

Quereus offers custom types as an extension point (`registerType`). A host that uses one declares the same tables on several processes: SiteCAD does on the browser, a sync server, a simulation server and in tests. If any one of them declares a table without having registered the type, it creates a different column from its peers and nothing fails. SiteCAD's investigation of a measure type (2026-11-13; `tickets/blocked/decide-how-a-stored-table-column-declares-its-measure.md` in that repository) listed this as the first of two changes it would need from Quereus before it could use custom types at all; the other is `bug-arithmetic-and-sums-drop-a-custom-numeric-type`.

## Expected behaviour

A host can make an unknown type name an error. The smallest form is a database option (off by default if SQLite compatibility of the default matters, though AGENTS.md says not to worry about backwards compatibility yet, so on by default is open): with it set, a column declared with a name that is neither registered nor an affinity spelling is refused at `create table` and `alter table … add column` with a message naming the type and the column.

Decide alongside it, and state in `docs/types.md`:

- whether the substring affinity rules stay (they are what makes `POINT` an integer), or narrow to whole-word matches when the strict option is on;
- whether registration should be per database, or stay process-wide and be documented as such.

## Notes

`getTypeOrDefault` has the same fallback and other callers (`schema-differ.ts`, `change-scope.ts`, `scalar.ts` for casts); check each for whether a silent BLOB is right there or the strict option should reach it too. A `cast(x as unknowntype)` is the same question for expressions.
