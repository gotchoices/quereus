description: A table-level CHECK or any UNIQUE rule written without a name is stored with no name at all, so no statement can ever drop it and a declared schema that stops listing it fails to apply. Give these rules the same kind of reserved automatic name the engine already gives column-level CHECKs and foreign keys, so every rule can be dropped and fresh and upgraded databases store identical names.
architecture: docs/schema-rename-detection.md#unnamed-constraint-lifecycle-body-matched
files:
  - packages/quereus/src/schema/manager.ts            # CREATE TABLE constraint extraction (~1764: column-level CHECK mint `_check_<col>`; table-level CHECK / UNIQUE keep `name: undefined`)
  - packages/quereus/src/schema/constraint-builder.ts # buildCheckConstraintSchema / mintCheckConstraintName — `ALTER … ADD CHECK` mints user-class `check_<n>`
  - packages/quereus/src/schema/catalog.ts            # implicitIndexNameForColumns (`_uc_<cols>` backing name), isAutoConstraintName
  - packages/quereus/src/schema/schema-differ.ts      # diffUnnamedConstraints — the "created without a name" refusal this would retire; mintUnnamedConstraintName
  - docs/sql-constraints.md, docs/sql-alter.md         # auto-naming conventions
tradeoffs: Changes persisted table DDL and some constraint-violation message text for every table with an unnamed table-level CHECK or UNIQUE, and already-stored databases keep their nameless constraints (the refusal stays reachable for them) unless an upgrade step renames them on open.
----

# Name every unnamed constraint at CREATE TABLE

## Today

How an unnamed constraint is stored depends on where it was written:

| declaration | `CREATE TABLE` stores | `ALTER TABLE … ADD` (unnamed) stores | declarative upgrade `ADD` stores |
|---|---|---|---|
| column-level CHECK on `a` | `_check_a` | n/a (ADD COLUMN inline: `_check_<col>`) | `_check_a` |
| table-level CHECK | *no name* | `check_<n>` (user-class — no `_` prefix) | `_check_<n>` |
| UNIQUE (column or table) | *no name* | *no name* | `_uc_<cols>` |
| FOREIGN KEY on `b` | `_fk_t_b` | `_fk_t_b` | `_fk_t_b` |

A constraint stored with no name cannot be removed by `DROP CONSTRAINT` (it resolves by stored name only; `_uc_<cols>` is just the hidden backing structure's name). Consequences:

- The declarative differ, which matches unnamed constraints by body, must **refuse** a declaration that stops listing one ("created without a name, so no statement can drop it") — the only remedy is rebuilding the table.
- A database created fresh at a schema version and one upgraded to it enforce the same rules but store different names for the same constraint (nameless vs `_check_<n>` / `_uc_<cols>`).
- The imperative `ALTER … ADD CHECK` mint `check_<n>` is user-class, so a declaration that later lists that CHECK unnamed churns once (drop `check_<n>`, add `_check_<n>`).

## Wanted

Every CHECK / UNIQUE / FOREIGN KEY the user leaves unnamed is stored under a reserved `_`-prefixed name, whichever statement created it:

- table-level CHECK → `_check_<n>` (`n` = its position among the table's CHECKs, bumped past any taken name — the label violation messages already show for a nameless CHECK);
- UNIQUE → `_uc_<cols>` (its backing-structure name already, so no new collision surface);
- `ALTER … ADD CHECK` unnamed → `_check_<n>` rather than user-class `check_<n>` (decide whether `check_<n>` stays accepted as a legacy spelling).

Expected outcome: every constraint is droppable by name; the differ's "created without a name" refusal becomes unreachable for tables created after the change; fresh and upgraded databases store byte-identical constraint names (constraint order still differs — `ADD CONSTRAINT` appends).

Open questions for whoever plans it: whether stored nameless constraints get named on load (store rehydrate / `importDDL`) or are left as-is; and which error texts change (not measured — a nameless CHECK's violation is labelled by `generateDefaultConstraintName` in `runtime/row-constraints.ts`; a UNIQUE violation observed during the differ work quoted the table and columns, `UNIQUE constraint failed: t (a)`, not a name).
