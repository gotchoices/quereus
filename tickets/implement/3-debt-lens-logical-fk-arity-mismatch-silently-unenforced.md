---
description: A foreign key declared on a logical (lens) table that cannot be checked — because its column count does not match the parent's key, or because the parent table does not exist — is quietly ignored instead of being reported. Refuse such keys when the logical schema is applied, and fail the write when the problem only appears later.
architecture: docs/lens-constraints.md#foreign-key
files:
  - packages/quereus/src/schema/lens-fk-discovery.ts          # resolveLogicalReferencedColumns (~50), findLogicalParentFkRefs (~235), buildLensBasisFkGate (~291), basisFksOverriddenByDivergentLensFk (~355)
  - packages/quereus/src/schema/lens-compiler.ts              # deployLogicalSchema (~52) — the compile-first loop and the atomic proveErrors throw (~238)
  - packages/quereus/src/planner/mutation/lens-enforcement.ts # collectLensForeignKeyConstraints (~1088, the skip at ~1104); collectLensParentSideForeignKeyConstraints (~1249)
  - packages/quereus/src/runtime/foreign-key-actions.ts       # executeLensFkActionsForParentSlot (~924), assertLensRestrictsForParentSlot (~1111)
  - packages/quereus/src/schema/table.ts                      # resolveReferencedColumnsForEnforcement (~1297) — owns the physical message wording
  - packages/quereus/src/planner/building/foreign-key-builder.ts # absent-parent null-guard check + violationMessage (~225), the physical model for arm B
  - packages/quereus/test/logic/41.16-fk-unenforceable.sqllogic # the physical corpus for this class; add a lens section
  - packages/quereus/test/lens-enforcement.spec.ts            # imports findLogicalParentFkRefs directly — update if its return shape changes
  - docs/lens-constraints.md                                  # § Foreign key
  - docs/lens-prover.md                                       # § Coverage checklist, "Constraint realizability" row
  - docs/sql-constraints.md                                   # § "When a foreign key cannot be enforced"
difficulty: medium
---

# The defect

A foreign key on a *logical* table (a table a lens projects over real "basis" tables, deployed by `apply schema`) is enforced in two places: the child side (a synthesized `EXISTS` against the logical parent when a child row is written) and the parent side (RESTRICT checks and CASCADE / SET NULL / SET DEFAULT propagation when a logical parent row is deleted or re-keyed). Both look up the parent's key columns by name through `resolveLogicalReferencedColumns`. When the lookup's column count does not equal the FK's child column count, every site writes a debug-log line and skips the key:

- child side — `collectLensForeignKeyConstraints`, `lens-enforcement.ts` ~1104
- parent side — `findLogicalParentFkRefs`, `lens-fk-discovery.ts` ~254; everything parent-side reads its output, so a skipped key vanishes from the RESTRICT collector, the runtime RESTRICT pre-check, and the cascade walker.

The count disagrees in two situations, and both are currently silent:

- **Arity mismatch.** `references <parent>` with no column list defaults to the parent's primary key; if that key has a different column count, the key cannot be checked. (An explicit wrong-length list is already refused at declaration by `SchemaManager.extractForeignKeys`, so only the defaulted form reaches here.)
- **Absent parent.** The parent does not resolve at all; the lookup returns `[]`, which is also "a count mismatch", so the same skip swallows it.

The physical (ordinary table) path fails the statement in both situations (`docs/sql-constraints.md` § *When a foreign key cannot be enforced*; corpus `test/logic/41.16-fk-unenforceable.sqllogic`).

## Reproductions (verified, run against HEAD)

Arity, same logical schema — everything succeeds:

```sql
declare schema y { table parent (px integer, py integer, name text, primary key (px, py)); table child (id integer primary key, pid integer null) }
apply schema y;
declare logical schema x { table parent (px integer, py integer, name text, primary key (px, py)); table child (id integer primary key, pid integer null, constraint fk_pid foreign key (pid) references parent on delete restrict) }
apply schema x;                                   -- OK (should be refused)
insert into x.parent (px, py, name) values (1, 1, 'a');
insert into x.child (id, pid) values (10, 1);
insert into x.child (id, pid) values (11, 999);   -- OK: orphan accepted
delete from x.parent where px = 1;                -- OK: RESTRICT bypassed
```

The physical equivalent (`create table cc (..., p integer null references pp)` against a two-column-PK `pp`) fails the insert with `Foreign key '_fk_cc_p' on table 'main.cc': 1 column(s) reference the primary key of 'main.pp', which has 2 column(s).`

Arity, appearing later through a parent redeploy in another logical schema — enforcement works, then silently stops:

```sql
declare schema yb { table parent (px integer, py integer, primary key (px)); table child (id integer primary key, pid integer null) }
apply schema yb;
declare logical schema b { table parent (px integer, py integer, primary key (px)) }
declare lens for b over yb {}
apply schema b;
declare logical schema a { table child (id integer primary key, pid integer null, constraint fk_pid foreign key (pid) references b.parent on delete restrict) }
declare lens for a over yb {}
apply schema a;
insert into b.parent values (1, 1);
insert into a.child values (10, 1);
insert into a.child values (12, 777);   -- correctly rejected: CHECK constraint failed: lens:fk:fk_pid
delete from b.parent where px = 1;      -- correctly rejected: violates RESTRICT
declare logical schema b { table parent (px integer, py integer, primary key (px, py)) }
apply schema b;                         -- parent key is now two columns
insert into b.parent values (2, 2);
insert into a.child values (13, 2);
insert into a.child values (14, 888);   -- OK: orphan accepted (should raise the arity error)
delete from b.parent where px = 2;      -- OK: RESTRICT bypassed (should raise the arity error)
```

Absent parent — the orphan is accepted:

```sql
-- (any basis schema y applied)
declare logical schema x { table child (id integer primary key, pid integer null, constraint fk_pid foreign key (pid) references nothere) }
apply schema x;                                   -- OK
insert into x.child (id, pid) values (11, 999);   -- OK: should be rejected naming the missing table
```

# Expected behaviour

Two layers. Decide at deploy whatever is decidable at deploy; whatever only becomes wrong later fails the write at the enforcement site, never skips.

## Layer 1 — `apply schema` refuses what it can decide

`deployLogicalSchema` (`lens-compiler.ts`) already compiles every slot first, aggregates prover errors into `proveErrors`, and throws once before any catalog mutation. Add one pass **after the compile loop, before that throw**, over every compiled slot's `enforced-fk` obligations:

- Resolve the parent. If the FK's referenced schema (`fk.referencedSchema ?? <this logical schema>`) is the schema being deployed, resolve it against **this deploy's `compiled` set** by name (case-insensitive) — *not* the registered catalog, which still holds the previous deploy's slots (or none on a first deploy). Otherwise resolve against the registered catalog exactly as `resolveLogicalReferencedColumns` does today (lens slot's logical table, then `findTable` backstop).
- Parent found and the referenced column count ≠ the child column count → push an error diagnostic.
- Parent is in **this** schema and not found → push an error diagnostic: the logical schema is applied whole, so a same-schema parent that is not in this declaration cannot appear without redeploying this same schema.
- Parent is in **another** schema and not found → no diagnostic (a forward reference to a schema not yet deployed is legal, as on the physical side); layer 2 covers it.

Diagnostic code: reuse `lens.unrealizable-constraint` — its documented meaning is "neither provable nor attachable as an enforced boundary constraint", which is exactly this; error codes are not ack/escalation-governable, so no vocabulary change is needed. Site `{ table: <child logical table>, constraint: <fk name> }`. Message text: the same wording the physical path uses, so one malformed key reads the same wherever it is met — extract the message builder out of `resolveReferencedColumnsForEnforcement` (`table.ts`) into a small exported function both call. For the absent-parent diagnostic, name the qualified parent the lookup used (as the physical `referenced table '<schema>.<parent>' does not exist` text does).

Deliberately **not** done at deploy: checking *inbound* logical FKs from other, already-deployed logical schemas when a parent schema is redeployed. Refusing `apply schema b` because of a key declared in schema `a` would deadlock a legitimate change (a's fix can't deploy against the old b, b's change can't deploy against the old a). Layer 2 owns that case. Record this reasoning in the doc text, not as a code comment.

## Layer 2 — enforcement raises instead of skipping

Introduce a strict logical resolver in `lens-fk-discovery.ts` (the logical counterpart of `resolveReferencedColumnsForEnforcement`). Suggested split of today's `resolveLogicalReferencedColumns` so the deploy pass and the enforcement sites share one lookup:

- `resolveLogicalFkParent(fk, referencedSchema, schemaManager): TableSchema | undefined` — the lens-slot-then-`findTable` lookup.
- the referenced names for a found parent (explicit `referencedColumnNames`, else the parent's PK column names) — unchanged logic.

Then, per site:

- **Child side (`collectLensForeignKeyConstraints`).** Parent found, arity mismatch → throw the shared arity error (this runs at plan time for a write through the logical child — the same seam as the physical `buildChildSideFKChecks`, which also throws there). Parent absent → mirror the physical builder (`foreign-key-builder.ts` ~225): emit the MATCH SIMPLE null-guards-only check (admits a row with any NULL FK column, rejects every other row) with a `violationMessage` naming the missing qualified table, instead of skipping. Check that the lens constraint path carries `violationMessage` through to the failure text (`lens-enforcement.ts` ~457/~495 and `view-mutation-builder.ts` ~1226 suggest it does).
- **Parent side.** Do **not** make `findLogicalParentFkRefs` throw: `buildLensBasisFkGate` calls it for every lens slot on the first basis write after a deploy, and `basisFksOverriddenByDivergentLensFk` is called unconditionally by the plan-time `buildParentSideFKChecks` — even for a basis-direct write, which bears no logical FK semantics (`docs/lens-constraints.md` § basis-direct writes) — so a throw there would fail unrelated writes. Instead keep `LogicalParentFkRef` always well-formed (`parentLogicalColumns` aligned with `fk.columns`) and return the malformed keys separately, e.g. `{ refs, unenforceable: Array<{ childSlot, fk, message }> }`. Then:
  - `buildLensBasisFkGate` counts both lists (the gate may over-report; it must not hide a malformed key from the enforcement path).
  - `basisFksOverriddenByDivergentLensFk` ignores `unenforceable` (no basis FK can be structurally equivalent to a key whose columns do not line up; nothing goes unenforced because the lens-routed write's own collector raises).
  - `collectLensParentSideForeignKeyConstraints` (plan-time RESTRICT), `assertLensRestrictsForParentSlot` (runtime RESTRICT pre-check) and `executeLensFkActionsForParentSlot` (cascade walker) each throw the entry's message for an `unenforceable` key **whose op-action is the one that site handles** — the same action filter each already applies to well-formed refs, matching the physical sites (RESTRICT sites raise for RESTRICT keys, the cascade walker for cascade / set null / set default keys).
  - The absent-parent case does not arise on the parent side (discovery starts from an existing parent slot).

A correctly-shaped logical FK — including the defaulted `references <parent>` form against a one-column parent PK — must behave exactly as today (already pinned by `lens-enforcement.spec.ts` "a bare `references parent` (no column list) falls back to the parent PK" and the parent-side suites).

## Docs

- `docs/lens-constraints.md` § Foreign key: a short paragraph — a logical FK that cannot be checked is refused at `apply schema` when decidable there (arity against a parent in this deploy or an already-deployed schema; a same-schema parent missing from the declaration), otherwise the write fails with the physical-path message; never skipped. Include the no-inbound-check-at-redeploy reasoning.
- `docs/lens-prover.md` § Coverage checklist, "Constraint realizability" row: add the FK arity / same-schema-missing-parent refusal (note it runs post-loop in the compiler, not in per-slot `proveLens`, because the parent may be declared after the child).
- `docs/sql-constraints.md` § *When a foreign key cannot be enforced*: one sentence that logical (lens) tables follow the same rule, refused at `apply schema` where decidable.

# Tests

One reproduction per behaviour, added as a lens section (C) in `test/logic/41.16-fk-unenforceable.sqllogic` (the corpus for this exact class; follow its `-- error:` style). Use the reproductions above:

- C1: same-schema defaulted arity mismatch → `apply schema x` errors (`lens.unrealizable-constraint`, message names the FK, the child, the parent, both counts).
- C2: cross-schema parent redeployed to a composite PK → the non-NULL child insert through `a.child` errors with the arity message, and `delete from b.parent …` errors with it too. (The child-side throw is plan-time, so like the physical path it fails any write through `a.child`, NULL FK value or not — mirror what 41.16 case B asserts for the physical equivalent.)
- C3: same-schema absent parent → `apply schema` errors naming the missing table.
- C4: cross-schema absent parent (references a schema with no deployed lens) → deploy succeeds; a NULL-FK insert is admitted; a non-NULL insert fails with `referenced table '<schema>.<parent>' does not exist`.

No new test for the well-formed path (already covered). Update `lens-enforcement.spec.ts` call sites of `findLogicalParentFkRefs` if its return shape changes.

# TODO

- Extract the physical arity message builder from `resolveReferencedColumnsForEnforcement` (`table.ts`) into an exported helper; keep the physical wording byte-identical (41.16 case B asserts it).
- Split `resolveLogicalReferencedColumns` into parent lookup + referenced-name resolution in `lens-fk-discovery.ts`.
- Add the post-compile-loop deploy pass in `deployLogicalSchema` (resolve same-schema parents from `compiled`), pushing `lens.unrealizable-constraint` diagnostics into `proveErrors` before the atomic throw.
- Child side: replace the skip in `collectLensForeignKeyConstraints` — throw on arity mismatch; emit the null-guards-only check with a missing-table `violationMessage` on absent parent.
- Parent side: return malformed keys separately from `findLogicalParentFkRefs`; count them in `buildLensBasisFkGate`; ignore them in `basisFksOverriddenByDivergentLensFk`; throw (after the action filter) in `collectLensParentSideForeignKeyConstraints`, `assertLensRestrictsForParentSlot`, `executeLensFkActionsForParentSlot`.
- Update the stale doc comments that describe the skip ("Applies the same count-mismatch guard … skip" on `findLogicalParentFkRefs`; "skip rather than synthesize" in `collectLensForeignKeyConstraints`; the `resolveReferencedColumnsForEnforcement` note listing "lens FK discovery" among non-enforcing callers).
- Add corpus section C to `41.16-fk-unenforceable.sqllogic`.
- Update the three docs listed above.
- Run `yarn workspace @quereus/quereus test` and `yarn workspace @quereus/quereus lint`; consider `yarn test:store` for the 41.16 corpus since apply-schema paths differ on the store module.
