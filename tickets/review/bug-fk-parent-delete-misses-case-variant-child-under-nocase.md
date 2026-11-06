---
description: When a parent table's key is case-insensitive, a child that refers to it with different letter case was accepted, but deleting or re-keying the parent did not notice that child, so an orphan was left behind. Every parent-side check and action now compares the same way the child-side check does; review the fix and the related decision on case-only renames.
architecture: docs/sql-constraints.md#76-foreign-key-constraint
files:
  - packages/quereus/src/planner/analysis/comparison-collation.ts   # resolveForeignKeyColumnCollation, foreignKeyColumnComparison (new)
  - packages/quereus/src/runtime/foreign-key-actions.ts             # FkColumnMatch helpers; every runtime-built probe / action routed through them; referencedKeyValueChanged
  - packages/quereus/src/runtime/row-constraints.ts                 # plan-time parent-side check's UPDATE skip now uses referencedKeyValueChanged
  - packages/quereus/src/planner/building/foreign-key-builder.ts    # buildParentSideFKChecks sets referencedKeyEqualities
  - packages/quereus/src/planner/nodes/constraint-check-node.ts     # ConstraintCheck.referencedKeyEqualities
  - packages/quereus/src/runtime/emit/dml-executor.ts               # createParentRestrictBatch / accumulateParentRestrictKeys signature changes
  - packages/quereus/src/schema/constraint-builder.ts               # validateForeignKeyCollations now calls the shared resolver
  - packages/quereus/test/logic/41.1-fk-collation-conflict.sqllogic # new § 11
  - packages/quereus/test/logic/41.9-fk-restrict-batched.sqllogic   # crbn_* section expectation reversed (see decision)
  - docs/sql-constraints.md                                         # § 7.6 new *Collation* paragraph, RESTRICT bullet
  - docs/runtime-dml.md                                             # § Batched RESTRICT: collation + stale re-coercion wording
---

# FK parent-side probes and actions compare under the FK's resolved collation

## What was wrong

A foreign key's child-side check (`exists(select 1 from p where p.k = NEW.ref)`) compares column to column, so the comparison collation resolves over both columns: a declared `collate nocase` on the parent key beats a defaulted child column, and the child `'ALICE'` is admitted against parent `'alice'`. Every SQL string the runtime builds in `runtime/foreign-key-actions.ts` instead bound the parent value as a parameter (`<child col> = ?`). A parameter carries no collation, so these compared under the child column alone (BINARY) and missed that child: RESTRICT let the delete or re-key through, and CASCADE / SET NULL / SET DEFAULT left the child untouched. The result was an orphaned child row.

## The fix

- `comparison-collation.ts`: `resolveForeignKeyColumnCollation(childCol, parentCol)` is the single FK column-pair rule (the lattice over `columnSchemaToScalarType` of both columns). `validateForeignKeyCollations` (CREATE-time) now calls it. `foreignKeyColumnComparison` unpacks it for enforcement into three fields: `collation`, `childNeedsCollate` (true when the child alone would resolve differently), and `keyEquality` (the collation an old and a new parent value must be equal under to count as the same key; only set when the FK is non-BINARY and both column types are collation-aware, i.e. `text` / `any`). It throws `collationConflictError` on a same-rank conflict. That can only come from a legacy persisted schema or a forward-declared parent (41.1 § 10), and matches the plan-time behaviour.
- `foreign-key-actions.ts`: the `FkColumnMatch` helpers (`fkColumnMatch`, `physicalFkColumnMatches`, `lensFkColumnMatches`, `fkMatchWhere`) render the child operand as `<col> collate <name>` only when that changes the answer. The common case keeps byte-identical SQL. All six physical sites and both lens sites go through them: the batch flush, the transitive pre-walk step 2, the per-row RESTRICT pre-check, `executeSingleFKAction`, `issueLensFkAction` and `assertNoLensChildReferences`. Batch entries now carry `matches`, so `createParentRestrictBatch` takes the parent table and `accumulateParentRestrictKeys` takes `db`.
- `executeSingleFKAction` lost its unused `parentTable` / `_visited` parameters. CASCADE UPDATE's duplicate WHERE builder was folded into the shared one.

## Decision: case-only parent re-key (ticket's preferred option, implemented)

Under a NOCASE FK, `update p set name = 'Alice' where name = 'alice'` is now **not a key change**: RESTRICT does not fire, and CASCADE / SET NULL / SET DEFAULT do not run. An ON UPDATE CASCADE child keeps its old spelling and still matches. The reason: every child that matched the old key still matches the new one under the FK's equality, so nothing is orphaned. This matches SQLite, whose FK action triggers fire on `old.k IS NOT new.k` under the parent column's collation.

- Implemented as `referencedKeyValueChanged` (value identity, widened by `keyEquality` for two strings). It is used by `anyReferencedColumnChanged` (all runtime sites, including lens) and by the plan-time `NOT EXISTS` skip in `row-constraints.ts`, which gets `ConstraintCheck.referencedKeyEqualities` from `buildParentSideFKChecks`. Without the row-constraints half, the per-row route's plan-time check would still have rejected the rename.
- This **reverses** an existing pin in `41.9-fk-restrict-batched.sqllogic` (`crbn_*`). That test asserted a case-only NOCASE rename must flush a violating probe. Its reasoning ("the child's own match runs under the CHILD column's collation") was exactly the bug fixed here. The section now pins the new behaviour. The old `anyReferencedColumnChanged` doc comment carrying that reasoning was rewritten. A reviewer who disagrees with the decision should revert both together.
- `serializeKeyTuple` batch de-dup stays BINARY: two NOCASE-equal keys cost a redundant probe, never a missed one.
- Not changed: the lens plan-time RESTRICT check (`lens-enforcement.ts` `buildParentSideUpdateGuard`) has its own `OLD.k IS NEW.k` guard. That guard compares under the parent basis column's collation, not the FK's. It agrees with the new rule whenever the NOCASE comes from the parent side. It would disagree only for a lens FK whose NOCASE is declared on the child column alone. I did not test or change it.

## Ticket premise corrected

The ticket expected the non-batched RESTRICT route to report the runtime `FOREIGN KEY constraint failed` message. It does not: on that route the plan-time `NOT EXISTS` (`ConstraintCheckNode`) runs before the executor's runtime pre-check, so it always reports `CHECK constraint failed: _fk_…`. That check was already correct. To make the runtime pre-checks observable, the test uses the upsert DO UPDATE arm, whose per-row runtime pre-check is its only parent-side enforcement on a batchable table, and a cascade→restrict chain for the transitive pre-walk.

## Store module (verified, not just static)

With a throwaway logic file under `yarn test:store`, a plain `text primary key` parent with a plain `text` child admits `'ALICE'` against `'alice'`, and the parent delete is now rejected. Under memory the child insert is rejected. So on store this bug hit ordinary schemas. It also means ordinary text FKs on store now emit `collate nocase` probes, which a default BINARY child index cannot serve. Parked as a `NOTE:` tripwire on `fkColumnMatch`. The per-row plan-time `NOT EXISTS` already had this property.

## Tests

`41.1-fk-collation-conflict.sqllogic` § 11 (runs under memory and store). Each assertion was confirmed to fail with the fix disabled (operand fix and key-equality toggled separately):
- 11.1 batched RESTRICT: delete rejected; re-key to `'bob'` rejected; upsert DO UPDATE re-key rejected (the per-row runtime pre-check `assertNoRestrictedChildrenForParentMutation`).
- 11.2 per-row route (second inbound cascade FK): a case-only re-key is accepted (the `row-constraints.ts` skip).
- 11.3 ON DELETE CASCADE deletes the case-variant child.
- 11.4 ON DELETE SET NULL nulls it.
- 11.5 ON UPDATE CASCADE re-points it, and a later case-only re-key does not propagate.
- 11.6 transitive pre-walk: parent → cascade child (case-variant) → RESTRICT grandchild, rejected with the runtime message (`DELETE on 'nt_c' violates RESTRICT from 'nt_g'`).

`41.9-fk-restrict-batched.sqllogic` `crbn_*`: case-only re-key on the batched route is accepted (reversed expectation, see above).

No lens test was added. No existing lens FK test made a case-variant scenario a one-liner, so the lens sites are covered only by review and by the existing lens suite passing.

## Validation run

- `yarn workspace @quereus/quereus lint`: clean.
- `yarn workspace @quereus/quereus test`: 11097 passing, 26 pending.
- `yarn test:store`: 11090 passing, 33 pending.

## Review focus

- Whether the case-only re-key decision is right for CASCADE (child keeps old casing) as well as for RESTRICT / SET NULL.
- The `keyEquality` gate on `isCollationAware` for both columns: JSON and the temporal types keep identity, which is the safe direction.
- `foreignKeyColumnComparison` throws inside `createParentRestrictBatch`, i.e. on every DELETE/UPDATE of a parent with a conflicting legacy FK, even when zero rows match. That is consistent with the plan-time check, but now applies on the batched route too.
