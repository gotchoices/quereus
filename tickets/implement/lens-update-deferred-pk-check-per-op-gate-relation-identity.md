description: |
  Updating a non-key column through a logical (lens) view can throw an internal "no row context"
  error at commit and lose the update, when the underlying storage backs two columns with
  same-named basis columns. The deferred uniqueness check is being attached to the wrong storage
  table; the fix is to attach it by the table it actually belongs to, not just by column name.
prereq:
files:
  - packages/quereus/src/planner/building/view-mutation-builder.ts   # constraintsForOp + writeRowColumns — the per-op resolvability gate (ROOT CAUSE)
  - packages/quereus/src/planner/mutation/lens-enforcement.ts        # collectLensSetLevelConstraints / FK / row-local — synthesize the deferred constraints + their referenced-column metadata
  - packages/quereus/src/schema/table.ts                             # RowConstraintSchema.referencedWriteRowColumns (extend / add relation-qualified metadata)
  - packages/quereus/src/schema/lens.ts                              # LensSlot.advertisement.storage.members + LensRelationBacking (owning basis relation per logical column)
  - packages/quereus/src/planner/mutation/propagate.ts              # BaseOp.table : TableReferenceNode (op's target basis relation = .tableSchema.schemaName/.name)
  - packages/quereus/test/lens-put-fanout.spec.ts                    # home for the new regression tests (surrogate-keyed decomposition fixtures live here)
difficulty: medium
---

# Lens non-key UPDATE crashes the deferred `lens:pk` count-check: the per-op gate routes it by bare column name, not owning basis relation

## Summary of the fix-stage investigation

The bug from the originating fix ticket is **reproduced, fully localized, and re-diagnosed**. The
fix-stage hypothesis (a get-join scoping / runtime context-shadowing problem in `join.ts` /
`context-helpers.ts`) is **not** where the bug lives. The get-join evaluates correctly. The actual
root cause is the **per-op resolvability gate** in `planner/building/view-mutation-builder.ts`
(`constraintsForOp`), which decides *which member op of a decomposition fan-out carries each
lens-synthesized constraint* by matching **bare basis-column names** — ambiguous when two
decomposition members back their logical columns with same-named basis columns.

## Exact reproduction (pure Quereus, no Lamina)

A name-match per-column decomposition: each logical column lives in its own `(rowId, value)`
member, joined on a surrogate `rowId`, with **both members' value columns named `val`**. The logical
PK `id` is a value column (not the surrogate) ⇒ no basis covering structure ⇒ commit-time
`enforced-set-level` ⇒ the lens synthesizes the deferred `lens:pk` count CHECK.

Storage (via a `MappingAdvertisement` from a test `AdvertisingModule`, exactly as the
`surrogate-keyed optional-member UPDATE` block in `lens-put-fanout.spec.ts` sets up):

```
members:
  w_id   (anchor, mandatory): logical id   ← basis w_id.val      , surrogate key w_id.rowId
  w_name (        mandatory): logical name ← basis w_name.val    , surrogate key w_name.rowId
sharedKey: surrogate, keyColumnsByRelation { w_id:[rowId], w_name:[rowId] }
logical:  app.widget { id integer primary key, name text }

create table w_id   (rowId integer primary key default (coalesce((select max(rowId) from w_id),0)+mutation_ordinal()), val integer) using mod
create table w_name (rowId integer primary key, val text) using mod
insert into main.w_id   (rowId,val) values (1,1),(2,2),(3,3)
insert into main.w_name (rowId,val) values (1,'a'),(2,'b'),(3,'c')
```

| Operation through `app.widget` | Result |
| --- | --- |
| `insert into app.widget (id,name) values (4,'d')` | works |
| `delete from app.widget where id = 3` | works |
| `update app.widget set id = 22 where id = 2` (key col) | **works** (CHECK rides the `w_id` op, fires correctly) |
| `update app.widget set id = 1  where id = 2` (key→dup) | **ABORTs** `CHECK constraint failed: lens:pk` (correct) |
| `update app.widget set name = 'B' where id = 2` (non-key) | **THROWS** `No row context found for column rowId` at commit; update lost |

## Root cause — confirmed by a 4-way variant matrix

I varied two factors independently and ran the non-key `set name='B'` UPDATE for each:

| value-column names | surrogate-key spelling | `set name` UPDATE |
| --- | --- | --- |
| **collide** (`val`,`val`) | identical (`rowId`,`rowId`) | **FAILS** — "No row context found for column rowId" |
| distinct (`idval`,`nameval`) | identical (`rowId`,`rowId`) | passes |
| **collide** (`val`,`val`) | distinct (`rid_a`,`rid_b`) | **FAILS** — "No row context found for column rid_b" |
| distinct (`idval`,`nameval`) | distinct (`rid_a`,`rid_b`) | passes |

The **only** factor that determines the crash is whether the two members' **value columns collide
by name**. The surrogate spelling (the `rowId` the error names) is irrelevant to *whether* it fails
— it only changes *which* column name appears in the error text. So the originating ticket's
"identical `rowId` spelling" framing was a red herring; the trigger is the colliding *value* column
name.

### Mechanism

1. `collectLensSetLevelConstraints` (`lens-enforcement.ts`) synthesizes
   `(select count(*) from app.widget as _u where _u.id = NEW.val) <= 1`, masked `INSERT|UPDATE`.
   The `NEW.val` side is the **basis column backing logical `id`** — which is `w_id.val`.
2. The lens write decomposes into per-member base ops. A `set name='B'` produces **only a `w_name`
   UPDATE op** (id is unchanged, so no `w_id` op runs).
3. `constraintsForOp` (`view-mutation-builder.ts`) decides whether the `lens:pk` CHECK rides the
   `w_name` op by testing whether every referenced write-row column resolves on the op's target
   table — using a **bare lowercased name set** (`opCols.has(col)`). The CHECK references `val`;
   `w_name` *also has a column named `val`* (its own `name` value) ⇒ the gate **wrongly threads the
   `id`-uniqueness CHECK onto the `name`-only UPDATE op.**
4. At commit the deferred CHECK re-evaluates with the `w_name` member's OLD/NEW row context active.
   The count subquery's get-join (`w_id ⋈ w_name` on the surrogate) then evaluates its ON
   condition, and the *other* member's surrogate-key column reference resolves to no populated row
   context ⇒ `resolveAttribute` throws `No row context found for column rowId`. The episode rolls
   back, so the update is silently lost.

When the value names are **distinct** (variant 2/4): `w_name` has no column named after `id`'s basis
column, so the gate threads the CHECK onto **no** op ⇒ it is silently dropped for the `set name`
fan-out. That is the **correct** outcome — a name-only update cannot introduce an `id` duplicate, so
the id-uniqueness check legitimately does not fire. So the fix's target behavior is already
demonstrated by the distinct-name variants.

The get-join is **not** buggy: the key-column UPDATE (`set id=22`) and the duplicate-key UPDATE
(`set id=1`) both ride the correct `w_id` op and evaluate the same get-join cleanly (pass / ABORT
respectively). Only the *mis-gated* evaluation crashes.

### Why this is a general gate bug, not just a set-level one

`constraintsForOp` gates **all** lens-synthesized constraint classes the same way: set-level
(`lens:pk` / `lens:unique`), child-FK, parent-FK, and the row-local CHECK. The FK/set-level classes
use the `writeRowColumns(expr)` AST-walk (bare names); the row-local CHECK uses prover-supplied
`referencedWriteRowColumns` (still bare names). **Any** single-member lens constraint can be
mis-routed onto a sibling member that happens to share a basis-column name. The shipped Doc fixtures
only avoided it by giving every member distinct basis-column names. The name-match per-column
decomposition (every value column named `val`) is the realistic shape that exposes it.

## The fix — gate by owning basis relation, not bare column name

`constraintsForOp` must match a referenced write-row column against the op's **target basis
relation identity** (`op.table.tableSchema.schemaName` + `.name`), not merely "some op whose table
carries a column of that name". The lens collectors know the owning basis relation for every
referenced basis column:

- The slot's `advertisement.storage.members` (`mapping-advertisement.ts`) maps each
  `logicalColumn → DecompositionMember.relation {schema, table}`; and/or
- `logicalToBasisColumnMap(slot)` + the member lookup, or the `LensRelationBacking` records
  (`lens.ts`), give `(basisRelation, basisColumn)` per logical column.

### Suggested shape (implementer's discretion)

Carry, on the synthesized `RowConstraintSchema`, the **owning basis relation(s)** of its referenced
write-row columns — e.g. extend the transient metadata to relation-qualified entries
(`{ schema, table, column }`) rather than bare `column` strings — and have `constraintsForOp` keep a
constraint on `op` iff every referenced `(schema, table, column)` matches the op's target relation
(`op.table.tableSchema`). Update **all** lens collectors that currently leave
`referencedWriteRowColumns` undefined (set-level, child-FK, parent-FK) to populate the
relation-qualified metadata, so the gate stops falling back to the ambiguous `writeRowColumns` walk
for them. Keep the row-local CHECK class consistent (it already supplies basis names; add the owning
relation).

Constraints:
- **Single-source (non-decomposition) lens writes must be unaffected.** There is exactly one base
  op whose target relation owns every referenced basis column, so relation-qualified matching keeps
  threading the full set onto it (no behavior change). Pin this with the existing
  `lens-enforcement.spec.ts` single-source set-level/FK/CHECK tests staying green.
- **Cross-member constraints stay deferred** (resolve on no single op) — unchanged contract; the
  trace `log(...)` for an un-ridden constraint must still fire.
- A constraint whose referenced columns span the op's relation **and** a sibling relation that
  shares a column name must NOT falsely match — that is the precise bug, so the regression must
  cover it.

### Watch-outs

- `referencedWriteRowColumns` is documented (table.ts:536-548) as "row-local CHECK only" and
  "undefined on FK/set-level". Extending it to all classes means updating that doc comment and the
  `constraintsForOp` / `writeRowColumns` doc comments that describe the two-source split.
- The FK / set-level synthesizers reference basis columns via `NEW.*` / `OLD.*` (and the parent-FK
  UPDATE guard references `OLD.*`). The owning relation for a child-FK / set-level NEW column is the
  *write target's* basis relation (the member that owns the mapped logical column). The parent-FK
  `NOT EXISTS` references the **parent** slot's basis relation on its OLD/NEW side — confirm the
  relation attributed is the one whose op the constraint is meant to ride (the parent write's basis
  relation), not the logical child named inside the subquery FROM.
- Confirm `op.table.tableSchema` carries `schemaName` (it is a `TableReferenceNode`); match
  case-insensitively, consistent with the existing lowercased name comparisons.

## Acceptance

- A non-key lens UPDATE (`set name='B'`) through a name-match per-column decomposition (colliding
  basis value-column names) **commits** and reads back through both the lens view and the basis —
  no `No row context found` throw, no lost update. Autocommit and explicit-tx (`begin; update; commit`).
- A key-changing lens UPDATE still enforces the deferred `lens:pk`: a genuine logical-PK duplicate
  ABORTs (`CHECK constraint failed: lens:pk` / unique), a unique re-key commits.
- DELETE and INSERT over the same fixture remain correct (INSERT duplicate still ABORTs at commit;
  the existing `enforces the commit-time set-level key on INSERT` test stays green).
- No regression to the `INSERT|UPDATE` masking (DELETE still skips the set-level check) or to the
  cross-member deferral contract.
- All existing `lens-enforcement.spec.ts` and `lens-put-fanout.spec.ts` tests stay green
  (single-source unaffected; distinct-named decomposition unaffected).

## TODO

- [ ] In `lens-enforcement.ts`, have each lens collector (set-level, child-FK, parent-FK, row-local
      CHECK) attach the **owning basis relation** of every referenced write-row column to the
      synthesized `RowConstraintSchema` (relation-qualified metadata). Source it from
      `slot.advertisement.storage.members` / `logicalToBasisColumnMap` / `LensRelationBacking`.
- [ ] Extend `RowConstraintSchema` (`schema/table.ts`) with the relation-qualified field (or
      generalize `referencedWriteRowColumns`); update its doc comment (no longer "row-local only").
- [ ] Rewrite `constraintsForOp` (`view-mutation-builder.ts`) to match each referenced column
      against the op's target relation identity (`op.table.tableSchema.schemaName` + `.name`,
      case-insensitive) **and** column name — not the bare-name `opCols.has(col)` set. Update
      `writeRowColumns` / its doc comments accordingly (and decide whether the AST-walk fallback is
      still needed once all classes carry metadata).
- [ ] Add regression tests in `packages/quereus/test/lens-put-fanout.spec.ts` using a name-match
      per-column decomposition with **colliding `val` value-column names** (mirror the repro above):
      non-key UPDATE commits + round-trips; key-update duplicate ABORTs; key-update unique commits;
      DELETE/INSERT unaffected; explicit-tx commit path. (Optionally also add a row-local CHECK and
      a child-FK over the colliding-name fixture to pin the general gate fix, not just set-level.)
- [ ] Run `yarn workspace @quereus/quereus test` and `yarn workspace @quereus/quereus lint`.
- [ ] If the Lamina board's skipped e2e (`lens-committed-update-readback-e2e.test.ts`) is reachable
      from this tree, confirm it flips green; otherwise note it as the downstream verification.

## Reproduction harness (for the regression test author)

The fix-stage repro was a standalone spec (since deleted) built from the `AdvertisingModule` /
`colMap` / `keyMap` helpers already in `lens-put-fanout.spec.ts`. Re-create the `perColumnAd()` +
`setup()` shown under "Exact reproduction" above; the 4-variant matrix table documents the exact
fixtures that fail vs pass, which double as the positive/negative regression assertions.
