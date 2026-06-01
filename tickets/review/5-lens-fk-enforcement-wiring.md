description: Review the live child-side FK enforcement at the lens write boundary — a logical `enforced-fk` obligation is now realized as a deferred, basis-term synthesized `EXISTS` existence check, routed through the same `extraConstraints` pipeline the row-local class uses, gated by the `foreign_keys` pragma. Implementation complete; build + full test suite green.
prereq:
files: packages/quereus/src/planner/mutation/lens-enforcement.ts, packages/quereus/src/planner/building/foreign-key-builder.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/test/lens-enforcement.spec.ts, docs/lens.md, packages/quereus/src/schema/lens.ts, packages/quereus/src/schema/lens-prover.ts
----

## What landed

The lens prover already classified every logical FK as `{ kind: 'enforced-fk' }`
but it was **classified, not enforced** — a write through a lens-backed logical
table that introduced a dangling logical FK reference was silently accepted
unless the basis tables happened to carry the same FK. This ticket closes that
gap by synthesizing a child-side existence check at the lens write boundary.

### Mechanism (synthesized EXISTS, not a bespoke DeltaExecutor)

For each `enforced-fk` obligation, `collectLensForeignKeyConstraints(slot,
schemaManager)` (`planner/mutation/lens-enforcement.ts`) builds a
`RowConstraintSchema` whose `expr` is:

```
( NEW.<basisChild1> IS NULL OR … OR
  EXISTS( SELECT 1 FROM <logicalSchema>.<parent>
          WHERE <parent>.<refCol1> = NEW.<basisChild1> AND … ) )
```

- **FROM** is the schema-qualified referenced **logical** relation
  (`fk.referencedSchema ?? slot.logicalTable.schemaName` + `fk.referencedTable`),
  so it resolves to the registered logical view even though the routed constraint
  is built under the basis schema path.
- **Child (NEW) columns** are rewritten logical→basis via the slot's
  reconstructible projection (`logicalToBasisColumnMap`); the **parent side stays
  logical** (resolves against the logical view).
- **Parent referenced column names** come from `fk.referencedColumnNames` (set for
  every declared FK), falling back to the parent logical table's PK column names.
- Tagged `quereus.lens.boundary.attached`, ops `INSERT | UPDATE`, name
  `lens:fk:<name>`.

The synthesis is **shared** with the physical child-side FK builder: I extracted
`synthesizeFKExistsExpr` in `foreign-key-builder.ts` (and extended
`synthesizeFKSubquery` to take an optional FROM-schema), and refactored the
physical `synthesizeExistsCheck` to delegate to it — so the assembly lives in one
place.

### Why this matches physical-FK semantics by construction

- The constraint contains an `EXISTS`, so `buildConstraintChecks`'
  `containsSubquery` rule **auto-defers it to commit** — same timing as physical
  child-side FK (`deferrable/initiallyDeferred/needsDeferred`).
- Routed through the existing `extraConstraints` seam in `view-mutation-builder.ts`
  → `buildBaseOp` → `buildInsertStmt`/`buildUpdateStmt` → `buildConstraintChecks`,
  the same path the row-local class rides, so FK composes with row-local checks.
- Gated on `ctx.db.options.getBooleanOption('foreign_keys')` exactly like
  `buildChildSideFKChecks` (only collected for non-delete ops), so the lens never
  adds enforcement the physical path would not.

### Key decisions (carried from the plan ticket)

- **No bespoke `DeltaExecutor`** — the set-level commit-time DeltaExecutor
  substrate does not exist yet, and the synthesized-EXISTS path is the cheaper,
  DRYer landing that matches physical gating + timing. The optimizer pushes the
  equality predicate into a basis index seek when a covering structure answers it
  and degrades to an O(n) scan otherwise — the "covering structure is optional"
  guarantee the DeltaExecutor framing also converges on.
- **v1 double-enforces** — always synthesize the lens FK check even when the basis
  carries an equivalent FK. Skip-when-redundant needs a row-set-equivalence proof
  (a wrong "equivalent" verdict would silently drop enforcement) and is deferred
  to backlog `lens-fk-basis-redundancy-elision` (confirmed present).

## Validation performed

- `yarn workspace @quereus/quereus run build` — clean (exit 0).
- `eslint` on the three changed source files — clean.
- `lens-enforcement.spec.ts` — **20 passing** (10 new FK tests + the 10
  pre-existing row-local tests).
- `lens-prover.spec.ts` — 17 passing.
- Full `yarn test` across all workspaces — **green** (4189 + others passing,
  exit 0). No `.pre-existing-error.md` written (no unrelated failures surfaced).

### New tests (test/lens-enforcement.spec.ts, "child-side FK existence" describe)

Each uses a basis schema with **no** FK and a logical schema that declares it, so
only the lens can enforce it:

- core gap: dangling FK insert ABORTs (basis directly accepts the same dangling
  row);
- satisfying insert succeeds once the parent exists;
- NULL FK column allowed (MATCH SIMPLE), no parent lookup;
- `pragma foreign_keys = off` ⇒ dangling insert accepted (gating parity);
- UPDATE to a dangling value ABORTs, to a valid value succeeds;
- rename override rewrites the child column to basis terms (`basis_pid`), still
  ABORTs dangling, and `astToString(expr)` references the basis column not the
  logical one;
- no FK obligation ⇒ collector returns `[]`, plain insert unaffected;
- composition: a logical table with both a row-local `check` and an FK — each
  class fires independently, both-satisfied succeeds;
- deferred semantics: child inserted **before** its parent in one
  `begin…commit` transaction commits successfully (the EXISTS defers to commit);
- composite (multi-column) FK: dangling ABORTs, matching succeeds, any-NULL
  component allowed;
- unit: `collectLensForeignKeyConstraints` returns one boundary-tagged `EXISTS`
  over the qualified logical parent with basis-term child refs.

## Reviewer focus / known gaps (treat tests as a floor)

- **Column nullability gotcha.** `default_column_nullability` defaults to
  `not_null` (Third Manifesto), so FK columns used in the MATCH-SIMPLE-NULL tests
  are declared **explicitly `null`** in both basis and logical schemas. Worth a
  sanity check that this faithfully represents the intended nullable-FK scenario.
- **Optimizer pushdown is asserted behaviorally, not structurally.** The tests
  confirm the *guarantee* (dangling aborts, satisfied passes), not that an index
  seek (vs. a full scan) actually occurs when a covering structure exists. If the
  reviewer wants a plan-level assertion that the equality predicate pushes into a
  basis seek, that is an additional test, not covered here.
- **Single-source spine only.** FK extras ride `buildBaseOp` on the single-source
  spine — the same path/limitation as the row-local class. The decomposition
  insert and multi-source join insert paths early-return in `buildViewMutation`
  and do **not** route lens FK (or row-local) extras; multi-source put fan-out is
  write-rejected upstream. So a lens FK on a multi-source / decomposition logical
  table is not enforced at the lens boundary (inherited gap, not introduced here).
  Verify this is acceptable and matches the documented row-local behavior.
- **Parent-side out of scope.** Deleting/updating a logical *parent* row does not
  run the synthesized child-side check; parent-side cascade/restrict through the
  lens is explicitly deferred (no backlog ticket filed yet — consider whether one
  is warranted).
- **Parent resolution fallback.** When `fk.referencedColumnNames` is empty (bare
  `references parent`), the collector falls back to the parent logical table's PK
  names via the parent's lens slot (or `findTable`). If neither resolves, it
  returns `[]` parent columns — the synthesized WHERE would then be degenerate.
  Declared FKs always populate `referencedColumnNames`, so this is a backstop, but
  worth confirming there is no path that reaches it with a real FK.
- **Docs updated:** `docs/lens.md` (§ Constraint Attachment FK bullet, the
  maturity note, the shipped-status note) + the `lens.ts` `obligations` comment +
  the `lens-prover.ts` header now mark `enforced-fk` **live**. Confirm the prose
  matches the implementation.
