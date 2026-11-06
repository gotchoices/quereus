---
description: When a parent table's key is case-insensitive, a child that refers to it with different letter case is accepted, but deleting or re-keying the parent does not notice that child — the restrict check lets the delete through, and cascade / set-null leave the child untouched — so an orphaned child row is left behind. Make every parent-side check and action compare the same way the child-side check does.
architecture: docs/sql-constraints.md#76-foreign-key-constraint
files:
  - packages/quereus/src/runtime/foreign-key-actions.ts             # every runtime-built `<child col> = ?` predicate (sites listed below) — the fix site
  - packages/quereus/src/planner/analysis/comparison-collation.ts   # resolveComparisonCollation — the rule both sides must share
  - packages/quereus/src/planner/type-utils.ts                      # columnSchemaToScalarType — the column → ScalarType bridge the resolver reads
  - packages/quereus/src/schema/constraint-builder.ts               # validateForeignKeyCollations — the CREATE-time use of the same rule (reference only)
  - packages/quereus/src/schema/lens-fk-discovery.ts                # LogicalParentFkRef — gives the lens sites their child/parent logical columns
  - packages/quereus/test/logic/41.1-fk-collation-conflict.sqllogic # add the regression section here (runs under memory and store)
  - docs/sql-constraints.md                                         # §7.6 enforcement bullets — state the shared collation rule
repro: verified
---

# FK parent-side runtime probes compare under the child column's collation, not the FK's

## Reproduction (native `Database`, memory module, `dist` built from HEAD)

```sql
pragma foreign_keys = true;
create table p (name text collate nocase primary key, w integer);
insert into p values ('alice', 10);
create table c (id integer primary key, ref text references p(name));
insert into c values (1, 'ALICE');        -- accepted: child-side check compares under NOCASE
delete from p where name = 'alice';       -- ACCEPTED: c(1,'ALICE') is now an orphan
```

Measured with a scratch script against `dist` (all with the child stored as `'ALICE'`):

| parent op | FK action | result today | expected |
|---|---|---|---|
| `delete` | restrict (default) | accepted, orphan left | rejected |
| `update p set name='bob'` | restrict | accepted, orphan left | rejected |
| `delete` | `on delete cascade` | accepted, child **not** deleted | child deleted |
| `delete` | `on delete set null` | accepted, child **not** nulled | child `ref` NULL |
| `update p set name='bob'` | `on update cascade` | accepted, child still `'ALICE'` | child `ref = 'bob'` |
| `delete` with a second inbound cascade FK (non-batched route) | restrict | rejected — but by the plan-time `NOT EXISTS` (`CHECK constraint failed: _fk_c_ref …`), meaning the runtime pre-check before it **missed** | rejected |

Control: child declared `collate nocase`, parent default BINARY → delete correctly rejected (the child column's own collation already is the resolved one).

## Root cause

The engine's comparison rule (`resolveComparisonCollation`, `docs/types.md` § Comparison collation resolution) resolves an FK column pair by looking at **both** columns: a declared collation on one side beats a defaulted one on the other. So for `p.name collate nocase` vs `c.ref` (defaulted), the FK's equality is NOCASE. This one-sided case is deliberately accepted at CREATE (`validateForeignKeyCollations`, pinned in `41.1-fk-collation-conflict.sqllogic` §4), so rejecting it at CREATE is not the fix — the two sides must agree.

Plan-time checks get it right because they compare column to column:
- child-side `exists(select 1 from p where p.name = NEW.ref)` → NOCASE;
- parent-side per-row `not exists(select 1 from c where c.ref = OLD.name)` → NOCASE (the `OLD.name` reference carries the parent column's type, `foreign-key-builder.ts` `buildParentSideFKChecks`);
- the ALTER existing-row orphan scan (`constraint-builder.ts` `foreignKeyOrphanScan`) → column to column, correct.

Every **runtime-generated** SQL string in `runtime/foreign-key-actions.ts` instead binds the parent's old key as a parameter: `<child col> = ?` / `<child col> in (?, …)`. A parameter carries no collation, so the comparison resolves to the child column alone — BINARY here. Sites (line numbers at HEAD):

- `flushParentRestrictBatch` (~163–183) — the statement-end batched RESTRICT probe; this is the path the plain repro takes (single inbound RESTRICT FK ⇒ batchable).
- `assertTransitiveRestrictsForParentMutation` step 2 child scan (~444–449) — the transitive pre-walk through cascading children.
- `assertNoRestrictedChildrenForParentMutation` (~579–584) — the per-row runtime RESTRICT pre-check.
- `executeSingleFKAction` (~638–688) — CASCADE DELETE, CASCADE UPDATE's `where`, SET NULL, SET DEFAULT.
- `issueLensFkAction` (~889) and `assertNoLensChildReferences` (~1050) — the lens (logical FK) duals, same shape over logical column names.

## Fix

One shared helper in `foreign-key-actions.ts` that renders the child-side match operand for FK column `i`:

- resolve `resolveComparisonCollation(columnSchemaToScalarType(childCol), columnSchemaToScalarType(parentCol))` — exactly the call `validateForeignKeyCollations` makes, so CREATE-time validation, plan-time checks and runtime probes share one rule;
- if the resolved name differs from what the child column alone resolves to (`resolveComparisonCollation(childType, {})`, i.e. its own non-default contribution or BINARY), emit `"<col>" collate <NAME>`; otherwise emit the bare quoted column.
- A `conflict` result cannot occur for a live FK (CREATE rejects it); if it does (legacy persisted schema), throw `collationConflictError` rather than silently picking one — matches the plan-time behaviour the doc describes ("still surfaces at DML").

Emitting `collate` only when it changes the answer keeps the common case (matching or defaulted collations) byte-identical SQL, so existing cached statement shapes and child-index use are unchanged. Verified on `dist` that `"ref" collate NOCASE in (?, ?)`, `= ?` and `delete … where "ref" collate NOCASE = ?` all match case-variants correctly.

Lens sites: the child column is `ref.childSlot.logicalTable.columns[fk.columns[i]]`; the parent column is the parent slot's logical table column named `ref.parentLogicalColumns[i]` (the caller already holds `parentSlot`). Thread whatever the helper needs; keep it one helper for both physical and lens.

Not affected / leave alone:
- `anyReferencedColumnChanged` stays BINARY identity (its comment explains why: a spurious "changed" costs one redundant probe; a NOCASE-equal re-key like `'alice'`→`'ALICE'` now probes and, correctly, still finds the child referencing a NOCASE-equal key — for RESTRICT that would *reject* a case-only rename). Check that last point while implementing: under NOCASE a case-only rename of the parent key leaves every child still matching, so RESTRICT ideally should not fire. If the fix makes `update p set name = 'ALICE' where name = 'alice'` start failing under RESTRICT, that is a behaviour change worth deciding — preferred: make the UPDATE short-circuit compare under the FK's resolved collation too (a NOCASE-equal re-key is "unchanged" for that FK), since the child-side check would accept every child afterwards. Record what you chose in the review handoff.
- `serializeKeyTuple` batch de-dup stays BINARY — `'alice'` and `'ALICE'` as two keys just means a redundant probe.

## Store module note (static, not run)

Under `yarn test:store`, an implicit-default text primary key reconciles to the store's NOCASE at default rank (see the header of `41.1-fk-collation-conflict.sqllogic`), and a default-rank NOCASE *does* contribute to resolution. If so, every plain `text primary key` FK under the store already compares NOCASE child-side, and this bug hits ordinary schemas there, not just explicitly `collate nocase` ones. The new sqllogic section running under store will confirm.

## Test

One new section in `test/logic/41.1-fk-collation-conflict.sqllogic` (declared NOCASE parent PK, defaulted child column, case-variant child), one statement per row of the table above: batched RESTRICT delete rejected; RESTRICT update rejected; non-batched RESTRICT (add a second inbound cascade FK) rejected with the runtime `FOREIGN KEY constraint failed` message (proves the runtime pre-check, not just the plan-time check); cascade delete removes the child; set null nulls it; cascade update re-points it. Plus the case-only-rename case per the decision above. Lens sites: no new test unless an existing lens FK test file makes it a one-liner.

## TODO

- Add the shared child-match-operand helper in `runtime/foreign-key-actions.ts` (resolve via `resolveComparisonCollation` over `columnSchemaToScalarType` of child and parent columns; emit `collate` only when it changes the result; throw on conflict).
- Route all six physical sites and both lens sites listed above through it.
- Decide and implement the case-only parent re-key behaviour for RESTRICT/cascade UPDATE (preferred: short-circuit under the FK's resolved collation); note it in the handoff.
- Add the regression section to `41.1-fk-collation-conflict.sqllogic`.
- Update `docs/sql-constraints.md` §7.6 enforcement bullets: parent-side runtime probes and propagating actions compare under the same resolved FK collation as the child-side check (and fix the `select 1 from <child> where <fk> = ? limit 1` description accordingly).
- Run `yarn workspace @quereus/quereus test` and `yarn test:store` (store path is where the default-NOCASE PK makes this most reachable), and `yarn workspace @quereus/quereus lint`.
