---
description: When a parent table's key is case-insensitive, a child that refers to it with different letter case was accepted, but deleting or re-keying the parent did not notice that child, so an orphan was left behind. Every parent-side check and action now compares the same way the child-side check does, and a case-only rename of the parent key counts as no change.
architecture: docs/sql-constraints.md#76-foreign-key-constraint
files:
  - packages/quereus/src/planner/analysis/comparison-collation.ts
  - packages/quereus/src/runtime/foreign-key-actions.ts
  - packages/quereus/src/runtime/row-constraints.ts
  - packages/quereus/src/planner/building/foreign-key-builder.ts
  - packages/quereus/src/planner/nodes/constraint-check-node.ts
  - packages/quereus/src/planner/mutation/lens-enforcement.ts
  - packages/quereus/src/runtime/emit/dml-executor.ts
  - packages/quereus/src/schema/constraint-builder.ts
  - packages/quereus/test/logic/41.1-fk-collation-conflict.sqllogic
  - packages/quereus/test/logic/41.9-fk-restrict-batched.sqllogic
  - docs/sql-constraints.md
  - docs/runtime-dml.md
---

# FK parent-side probes and actions compare under the FK's resolved collation

## What was wrong

The child-side FK check compares column to column, so its collation is resolved over both columns: with a declared `collate nocase` on the parent key and a defaulted child column, the child `'ALICE'` is admitted against parent `'alice'`. Every parent-side SQL statement the runtime builds (`runtime/foreign-key-actions.ts`) bound the parent value as a parameter (`<child col> = ?`). A parameter carries no collation, so these compared under the child column alone (BINARY) and missed that child. RESTRICT let the parent delete or re-key through, and CASCADE / SET NULL / SET DEFAULT left the child untouched, so the child row was orphaned. On the store module a plain `text primary key` parent reconciles to NOCASE, so ordinary schemas hit this.

## What landed (`ticket(implement): bug-fk-parent-delete-misses-case-variant-child-under-nocase`)

- `resolveForeignKeyColumnCollation` (`comparison-collation.ts`) is the single FK column-pair collation rule. CREATE-time validation uses it, and so do the plan-time and runtime parent-side sites. `foreignKeyColumnComparison` returns the resolved collation, whether the child operand needs an explicit `collate`, and the key equality used by the UPDATE short-circuit.
- Every runtime-built parent-side statement goes through the `FkColumnMatch` helpers, which add `collate <name>` to the child operand only when the result would otherwise differ. This covers the batched RESTRICT flush, the transitive pre-walk, the per-row RESTRICT pre-check, the CASCADE / SET NULL / SET DEFAULT statements, and the lens action and RESTRICT sites.
- Case-only re-key (decision): under a NOCASE FK, renaming `'alice'` → `'Alice'` is not a key change. RESTRICT does not fire and the propagating actions do not run, which matches SQLite's `old.k IS NOT new.k` action guard. `referencedKeyValueChanged` implements this for all runtime sites and for the plan-time `NOT EXISTS` skip in `row-constraints.ts`. The `crbn_*` pin in `41.9` was reversed to match.

## Review findings

**Diff read first, then the handoff.** Checked every changed site in `foreign-key-actions.ts` for operand/parameter alignment: `matches` is indexed by FK column and lines up with `parentColIndices` and the lens `basisIndices`. Checked that no bare `<col> = ?` WHERE clause is left (the remaining `= ?` strings are SET clauses, which are correct without a collation). Checked that lens `childLogicalColumns` and the logical table column names used by `lensFkColumnMatches` come from the same source (`lens-fk-discovery.ts`), so the generated SQL is unchanged when no collate is needed. Checked for an import cycle from `row-constraints.ts` → `foreign-key-actions.ts`: there is none (`foreign-key-actions.ts` does not import `row-constraints.ts`).

**Decision on case-only re-keys:** reviewed and agreed, including for ON UPDATE CASCADE. The child keeps its old spelling, but it still matches the parent under the FK's equality, and the deferred child-side check agrees with that. This is the SQLite behaviour.

**Fixed inline (minor, type safety / representation):** the implementation added `referencedKeyEqualities` to `ConstraintCheck` / `ConstraintMetadataEntry` as an array kept parallel to `referencedColumnIndices`, and `fkParentKeyChanged` took the metadata and the indices separately. These are now one array, `referencedKeyColumns: ReadonlyArray<ReferencedKeyColumn>` (`{ index, keyEquality }`, defined in `constraint-check-node.ts`), so the two can no longer get out of sync. `fkParentKeyChanged` takes just that array. The stale comment in `foreign-key-builder.ts` was updated.

**Tripwire parked (NOTE at `buildParentSideUpdateGuard`, `lens-enforcement.ts`):** the lens plan-time RESTRICT UPDATE guard compares `OLD.p = NEW.p` under the parent basis column's collation, not the FK's. The two diverge only when the NOCASE is declared on the logical child column alone. In that case the lens route rejects a case-only rename that the physical route accepts. That is over-rejection, never an orphan, so it is conditional rather than a defect.

**Tripwire already parked by the implementer (NOTE at `fkColumnMatch`):** on store, ordinary text FKs now emit `collate nocase` probes, and a default child index cannot serve them. I left it as written.

**Noticed, not filed (pre-existing, not a regression):** with NOCASE declared only on the child column and a BINARY parent key, the parent can hold both `'alice'` and `'ALICE'`, and a child `'Alice'` matches both. Deleting one of them cascades or restricts even though the other still satisfies the child. The probe here used the child's own collation before this change too, so behaviour is unchanged. SQLite avoids this by using the parent column's collation. This would be a semantics decision, not a bug at a single site. Recorded here only.

**Efficiency:** `foreignKeyColumnComparison` runs per parent row per FK at the per-row runtime sites (cascade actions, per-row RESTRICT pre-check, transitive walk). Those sites already build an SQL string per row, so the extra lattice resolution adds little. No change.

**Error handling:** `foreignKeyColumnComparison` throws on a same-rank collation conflict, now also when the batch is created for DELETE/UPDATE. A conflict is only reachable from a legacy persisted schema or a forward-declared parent, and the plan-time check already throws the same error, so this is consistent. No change.

**Tests:** the new `41.1` § 11 cases each pin a separate enforcement site (batched flush, upsert per-row pre-check, plan-time skip, cascade delete, set null, update cascade, transitive pre-walk). The handoff says each was confirmed to fail without the fix. None restates the implementation, so I kept all of them and added none. Lens sites have no case-variant test. I added none, because the lens action code shares the same `fkMatchWhere` helper, and the one known lens divergence is now a tripwire.

**Docs:** `docs/sql-constraints.md` § 7.6 (*Collation* paragraph, RESTRICT bullet) and `docs/runtime-dml.md` § Batched RESTRICT match the code. The stale "re-coerces … deliberately BINARY" wording was removed. No doc names the renamed `ConstraintCheck` field, so no doc change was needed for the refactor.

**Validation (after review edits):** `yarn workspace @quereus/quereus lint` is clean. `yarn workspace @quereus/quereus test`: 11097 passing, 26 pending. `yarn test:store`: 11090 passing, 33 pending.
