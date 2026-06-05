description: When a NOT NULL column's DEFAULT is a column reference (e.g. `b not null default (new.a)`) and the referenced sibling resolves to NULL during the REPLACE NOT-NULL substitution path, the resulting NOT NULL constraint violation is reported against the *referenced* column (`a`) instead of the column actually being defaulted/checked (`b`). The statement still correctly rejects — this is a misleading-message issue only.
files: packages/quereus/src/planner/building/constraint-builder.ts, packages/quereus/src/runtime/emit/constraint-check.ts, packages/quereus/src/runtime/emit/dml-executor.ts
----

## Symptom

This became reachable once column-reference DEFAULTs landed (`new.<column>` in a
DEFAULT — `tickets/complete/1-default-new-column-ref.md`). Before that, a DEFAULT
could not reference a column at all, so a NOT-NULL default never traced back to a
sibling attribute.

```sql
create table c1 (id integer primary key, a integer, b integer not null default (new.a));
insert or replace into c1 (id, b) values (1, null);
-- error: NOT NULL constraint failed: c1.a        ← should name c1.b
insert into c1 (id, b) values (1, null);
-- error: NOT NULL constraint failed: c1.a        ← same
```

Here `b` is the NOT NULL column whose explicit NULL triggers the REPLACE
default substitution; its default is `new.a`; `a` is omitted/NULL, so the
substituted value is NULL and `b` fails its NOT NULL check. The diagnostic names
`c1.a` (the column the substituted value's attribute traces to) rather than
`c1.b` (the column being enforced).

When the referenced sibling is non-NULL the path is correct:

```sql
create table c3 (id integer primary key, a integer, b integer not null default (new.a));
insert or replace into c3 (id, a, b) values (1, 5, null);
select a, b from c3 where id = 1;   -- → a=5, b=5  (correct)
```

## Why this is backlog (not a feature gap)

- No data corruption: the statement still rejects in exactly the cases it
  should; only the column named in the message is wrong.
- The fix lives in the NOT-NULL/REPLACE substitution + constraint-check
  reporting machinery (the `fix-or-conflict-clause-semantics` subsystem), not in
  the `new.`-default row-expansion path. Threading the *enforced* column's
  identity (rather than the failing value's source attribute) into the NOT NULL
  diagnostic is the likely fix.

## Note for the implementer

This is distinct from, and should not be conflated with, the deliberate
row-expansion-vs-REPLACE timing difference documented in
`buildNotNullDefaults` (REPLACE substitution operates on the fully-materialised
row, so `new.<col>` there can read any column; row-expansion exposes only
INSERT-supplied columns). That divergence is intentional; this error-attribution
is the only defect.
