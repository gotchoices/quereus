---
description: When a parent table's key is case-insensitive, inserting a child that refers to it with different letter case is accepted, but deleting the parent then does not notice that child, so the delete succeeds and leaves an orphaned child row behind.
files:
  - packages/quereus/src/planner/building/foreign-key-builder.ts   # buildChildSideFKChecks (accepts the case-variant child) vs buildParentSideFKChecks / getBatchableRestrictFks (miss it on delete)
  - packages/quereus/src/runtime/foreign-key-actions.ts             # statement-end batched RESTRICT enforcement — candidate site for the parent-delete comparison
  - packages/quereus/src/planner/analysis/comparison-collation.ts   # resolveComparisonCollation — what each synthesized `=` resolves to
repro: verified
severity: corruption
likelihood: unusual
tradeoffs: It needs a child value that differs from its parent key only in case (or trailing spaces under RTRIM), which most schemas never store; a maintainer might also decide the right fix is to reject the mixed-collation FK at CREATE time rather than to make both checks agree, which is a semantics call.
---

# FK parent delete misses a case-variant child under a NOCASE parent key

Filed from the lamina board (found while reviewing `feat-collated-pk-point-lookup-via-implicit-backing`). Reproduces on native Quereus with the in-memory module, so it is not a lamina module defect.

## Repro (native `Database`, quereus as published to lamina 2026-10-10)

```sql
pragma foreign_keys = true;
create table p (name text collate nocase primary key, w integer);
insert into p values ('alice', 10);
create table c (id integer primary key, ref text references p(name));
insert into c values (1, 'ALICE');        -- accepted: the child-side check compares under NOCASE
delete from p where name = 'alice';       -- ACCEPTED: c(1, 'ALICE') is now an orphan
```

With the child stored as `'alice'` (same case) the delete is rejected as expected.

## Expected

The two sides of one foreign key must use the same equality. Either both compare under the parent key's collation (SQLite's rule: the parent key's collation governs FK matching), so the delete above is rejected; or the FK whose child column collation differs from the parent's is rejected at CREATE, as the engine already does for a conflicting *explicit* child/parent collation (`docs/determinism.md`, "conflicting child/parent collation").

## Notes

- The child-side check is `exists(select 1 from p where p.name = new.ref)` and resolves NOCASE (parent column declared, child column defaulted). The parent-side check is `not exists(select 1 from c where c.ref = old.name)` or the statement-end batched RESTRICT path; one of them evidently compares under BINARY. Which one fires for this `delete` was not traced.
- `on delete cascade` / `set null` likely have the same mismatch (cascade would leave the case-variant child untouched). Not checked.
