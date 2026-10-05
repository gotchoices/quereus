----
description: When a new version of a declared schema adds a CHECK or UNIQUE rule without giving it a name to a table that already exists, "apply schema" silently does nothing, so a database upgraded from the old version never gets the rule while one created fresh at the new version enforces it.
files:
  - packages/quereus/src/schema/schema-differ.ts   # collectDeclaredNamedConstraints — skips unnamed and `_`-prefixed constraints; computeTableAlterDiff — diffs only that named set
repro: verified
severity: wrong-result
reported-from: optimystic (tickets/blocked/quereus-differ-ignores-unnamed-constraint-additions)
----

# Declarative differ ignores added unnamed constraints

Reported from the optimystic repository, where it makes an upgraded database's stored catalog
differ from a freshly created one. Reproduced here on the memory backend against v4.20.0.

## Repro

```sql
declare schema s { table t { id integer primary key, a integer null, b integer null } }
apply schema s;
insert into s.t values (1, 5, 5);
-- v2, one of:
declare schema s { table t { id integer primary key, a integer null, b integer null, check (a > 0) } }   -- (A) unnamed table CHECK
declare schema s { table t { id integer primary key, a integer null check (a > 0), b integer null } }   -- (B) column CHECK
declare schema s { table t { id integer primary key, a integer null, b integer null, unique (a) } }     -- (C) unnamed table UNIQUE
declare schema s { table t { id integer primary key, a integer null, b integer null, constraint pos check (a > 0) } }  -- (D) named control
diff schema s;
apply schema s;
insert into s.t values (2, -1, 0);   -- (C uses (2, 5, 0))
```

## Observed

| case | `diff schema s` | apply | violating insert |
|---|---|---|---|
| A unnamed table CHECK | `[]` | ok (no-op) | succeeds |
| B column CHECK | `[]` | ok (no-op) | succeeds |
| C unnamed table UNIQUE | `[]` | ok (no-op) | succeeds |
| D named CHECK (control) | `ALTER TABLE s.t ADD constraint pos check (a > 0)` | ok | `CHECK constraint failed: pos (a > 0)` |

## Expected

A–C should produce a migration step that adds the rule (or the apply should refuse loudly that
it cannot migrate an unnamed constraint). Silent no-op makes the outcome depend on install history.

## Where

`collectDeclaredNamedConstraints` in `packages/quereus/src/schema/schema-differ.ts` returns early
for a constraint with no name, and also drops `_`-prefixed (engine-synthesized) names to stay
symmetric with the catalog's `namedConstraints`. A column-level `check` gets a synthesized name
like `_check_a` on fresh create, so it is excluded on both sides. `computeTableAlterDiff` diffs
constraints only through that named map (renames / drops / adds / tag changes), so an unnamed or
auto-named constraint has no identity and never reaches `constraintsToAdd`. Unnamed constraints
need to be matched by canonical body (`constraintBodyToCanonicalString`) — body present in
declared but absent from actual → add; and the reverse decides whether removal should drop.

## TODO
- Pin the four cases above in a spec / sqllogic (memory and store).
- Decide body-identity matching for unnamed constraints (adds, and symmetric drops) vs. an explicit error.
- Implement in the differ; confirm a fresh apply and an upgrade produce identical catalogs.
