description: Live per-write enforcement of the lens prover's `enforced-fk` obligation — synthesize a child-side cross-relation existence check at the lens write boundary, rewritten to basis terms, threaded through the same `extraConstraints` pipeline the row-local class already uses. Gated by the `foreign_keys` pragma. ABORT on a dangling logical FK reference.
prereq:
files: packages/quereus/src/planner/mutation/lens-enforcement.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/planner/building/foreign-key-builder.ts, packages/quereus/src/planner/building/constraint-builder.ts, packages/quereus/src/schema/lens.ts, packages/quereus/src/schema/lens-prover.ts, packages/quereus/test/lens-enforcement.spec.ts, docs/lens.md
effort: high
----

## Context

The lens prover classifies every logical foreign key as the obligation
`{ kind: 'enforced-fk' }` (`lens-prover.ts` `classifyConstraint`, the
`foreignKey` arm — unconditional). It is **classified, not enforced**: a write
through a lens-backed logical table that introduces a dangling logical FK
reference is currently accepted, unless the *basis* tables themselves happen to
carry the same FK and the `foreign_keys` pragma is on (in which case the
re-planned basis write enforces it). This ticket closes that gap.

### What already exists (the substrate to reuse — verified during planning)

- **Physical child-side FK is a synthesized `EXISTS` check, not a bespoke scan.**
  `buildChildSideFKChecks` (`planner/building/foreign-key-builder.ts`)
  synthesizes, per FK, `EXISTS(SELECT 1 FROM parent WHERE parent.ref = NEW.fk …)`
  wrapped in MATCH SIMPLE null-guards (`<fkcol> IS NULL OR … OR EXISTS(…)`),
  packages it as a `RowConstraintSchema`, and pushes it into the constraint-check
  pipeline. It is called from `buildInsertStmt` / `buildUpdateStmt` **only when
  `ctx.db.options.getBooleanOption('foreign_keys')` is true** (`insert.ts:597`,
  `update.ts:196`).
- **The constraint pipeline auto-defers subquery checks.**
  `buildConstraintChecks` (`constraint-builder.ts:167`) sets
  `deferrable / initiallyDeferred / needsDeferred = true` for any check whose
  expression `containsSubquery(...)`. An `EXISTS` qualifies, so a synthesized FK
  existence check is **automatically deferred to commit** — the same timing the
  physical child-side FK uses (`foreign-key-builder.ts:173,242`). This is how
  this ticket realizes the doc's "enforced at commit" wording without a bespoke
  `DeltaExecutor` subscription.
- **The lens already threads extra constraints to the basis write.**
  `view-mutation-builder.ts` collects `lensRowLocalConstraints(ctx, view)` into
  `extraConstraints` and passes them to `buildBaseOp` →
  `buildInsertStmt`/`buildUpdateStmt` → `buildConstraintChecks` as
  `additionalConstraints`. The row-local collector
  (`collectLensRowLocalConstraints`, `lens-enforcement.ts`) rewrites each logical
  CHECK from logical-column terms into basis-column terms via the slot's
  reconstructible projection (`logicalToBasisColumnMap` / `rewriteToBasisTerms`).

### Design decision — mechanism (DeltaExecutor vs. synthesized EXISTS)

The plan-stage ticket and `docs/lens.md` § Constraint Attachment describe FK
enforcement as "cross-relation existence at commit via `DeltaExecutor` against
the referenced relation." **We do not build a bespoke `DeltaExecutor`
subscription.** Instead we synthesize a deferred `EXISTS` check and route it
through the existing constraint pipeline, because:

- It is byte-for-byte the mechanism physical child-side FK already uses, so it
  **matches physical-FK gating + timing semantics** (the explicit requirement) by
  construction — same `foreign_keys` pragma gate, same auto-deferral to commit.
- It reuses the `extraConstraints` seam the row-local class already rides, so FK
  composes with row-local checks (and any future set-level checks) on the same
  write for free.
- The `EXISTS` scans the referenced **logical** relation (a registered view); the
  optimizer pushes the equality predicate down into a basis index seek when a
  covering structure exists, and degrades to an O(n) scan otherwise — exactly the
  "covering structure is optional; lookup when present, scan when absent" behavior
  the ticket and doc call for. The DeltaExecutor framing and this one converge on
  the same observable guarantee.

The set-level commit-time `DeltaExecutor` substrate the plan ticket suggested
reusing **does not exist yet** (only the row-local class has been wired; see
`lens.ts` `obligations` doc-comment and `lens-prover.ts:36`). So there is nothing
to generalize from — and the synthesized-EXISTS path is the cheaper, DRYer
landing regardless.

### Design decision — redundancy with the basis FK (skip vs. double-enforce)

**Decision: double-enforce in v1** — always synthesize the logical FK check at
the lens boundary (gated by `foreign_keys`), even when the basis tables carry an
equivalent FK. Rationale:

- It is **always sound**. The skip optimization is only sound when the referenced
  *logical* relation's row set equals the referenced *basis* relation's row set
  (a faithful, non-row-reducing projection) **and** the child FK columns map
  value-preservingly to basis columns. Proving that row-set equivalence is
  non-trivial; a wrong "equivalent" verdict would silently drop enforcement (a
  soundness hole). Double-enforce has no such failure mode.
- The redundant cost is bounded and only paid in the faithful-passthrough case
  (basis FK present *and* logical FK present over the same relationship), where
  both checks resolve to the same basis lookup. Detection-and-skip is a pure
  performance optimization, deferred to a backlog follow-up
  (`lens-fk-basis-redundancy-elision`) where the row-set-equivalence proof can be
  done conservatively (skip only on *provable* equivalence; default to enforce).

## Approach

Add a sibling collector to `lens-enforcement.ts` that turns each `enforced-fk`
obligation into a basis-term `RowConstraintSchema`, and thread it into
`extraConstraints` in `view-mutation-builder.ts`, gated by the `foreign_keys`
pragma. The collector mirrors `synthesizeExistsCheck` but differs in two ways:

1. **FROM is the schema-qualified referenced *logical* relation**
   (`fk.referencedSchema ?? slot.logicalTable.schemaName`, table
   `fk.referencedTable`), not an unqualified basis table — because the routed
   constraint is built with `schemaPath = [basisSchemaName]`, so the parent must
   be qualified to resolve to the logical view. The subquery's WHERE references
   the parent's logical referenced-column **names** (`fk.referencedColumnNames`,
   or resolved from the parent logical `TableSchema` via
   `resolveReferencedColumns` when only indices are present).
2. **The child (NEW) column references are rewritten to basis terms** — each FK
   child column index → logical column name → basis column (via
   `logicalToBasisColumnMap`) → `{ type: 'column', name: basisCol, table: 'NEW' }`.
   The MATCH SIMPLE null-guards use the same basis-term child references.

The parent side stays in logical terms (it resolves against the logical view).
Result shape per FK:

```
( NEW.<basisChild1> IS NULL OR … OR
  EXISTS( SELECT 1 FROM <logicalSchema>.<parent>
          WHERE <parent>.<refCol1> = NEW.<basisChild1> AND … ) )
```

Returned as `RowConstraintSchema { name: 'lens:fk[:<name>]', expr, operations:
INSERT|UPDATE, tags: { [LENS_BOUNDARY_ATTACHED_TAG]: true } }`. No explicit
`deferrable` flag is needed — the pipeline auto-defers it because it contains an
`EXISTS`.

### Reuse / refactor

`synthesizeFKSubquery` (`foreign-key-builder.ts`) builds the `SELECT 1 FROM <name>
WHERE …` AST but only supports an unqualified FROM identifier. Extend it to
accept an optional schema for the FROM table (or factor the null-guard +
EXISTS-assembly into a small shared helper) so the lens collector and the
physical builder share the synthesis rather than duplicating it. Keep the helper
in `foreign-key-builder.ts` and import it from `lens-enforcement.ts`, or move the
shared core to a neutral spot — pick whichever keeps the dependency direction
clean (lens-enforcement already imports `transformExpr` from
`mutation/single-source.js`; importing a pure AST synthesizer from the FK builder
is acceptable, but avoid pulling planner-building state into the mutation layer).

### Wiring

In `view-mutation-builder.ts`, alongside the existing
`extraConstraints = req.op === 'delete' ? [] : lensRowLocalConstraints(ctx, view)`:

- For insert/update, also collect the FK constraints **only when
  `ctx.db.options.getBooleanOption('foreign_keys')`** and concatenate them into
  `extraConstraints`.
- The FK collector needs to resolve the parent's referenced column names, so pass
  it `ctx.schemaManager` (or `ctx.db`) — it resolves
  `fk.referencedSchema ?? slot.logicalTable.schemaName` + `fk.referencedTable`.
  Mirror `lensRowLocalConstraints`'s slot-resolution
  (`getSchema(view.schemaName)?.getLensSlot(view.name)`).
- Delete is unaffected (child-side FK is INSERT/UPDATE only — matches
  `buildChildSideFKChecks`'s early return). Parent-side cascade/restrict through
  the lens is out of scope (see Scope boundary).

## Scope boundary

Child-side FK existence only. Row-local and set-level are separate tickets.
Parent-side FK enforcement through the lens (ON DELETE/UPDATE RESTRICT/CASCADE/SET
NULL when a *parent* logical row is mutated) is explicitly **out of scope** —
deleting/updating a logical parent does not run the synthesized child-side check.
Where the basis tables carry the FK and the pragma is on, the basis write still
applies its own parent-side actions; the lens adds nothing parent-side here.
A backlog ticket should capture lens-mediated parent-side FK actions if/when
needed.

## Key tests (TDD — add to `test/lens-enforcement.spec.ts`, new describe block)

Each scenario: fresh `Database`, deploy through `apply schema`, with
`pragma foreign_keys = true` unless the test is the pragma-off case.

- **The core gap — dangling FK insert ABORTs.** Basis carries **no** FK; logical
  schema declares `child(… , foreign key (pid) references parent(id))`. Insert a
  `child` row whose `pid` has no matching `parent` → throws (FK / constraint).
  Today this is silently accepted — this test is red before the change.
- **Satisfying insert succeeds.** Insert the parent first (or in the same
  transaction — deferred), then the child referencing it → ok.
- **NULL FK column is allowed (MATCH SIMPLE).** Insert `child` with `pid = NULL`
  → ok, no parent lookup.
- **Pragma gates it.** With `pragma foreign_keys = off`, the dangling insert is
  accepted (no synthesized check) — confirms gating parity with physical FK.
- **UPDATE to a dangling value ABORTs.** Update an existing child's FK column to a
  value with no parent → throws; update to a valid value → ok.
- **Rename override rewrites the child column to basis terms.** Logical FK column
  is a renamed/projected logical column (e.g. `view child as select id, basis_pid
  as pid from y.child`); a dangling insert through the lens still ABORTs, and the
  synthesized constraint's `astToString(expr)` references the **basis** child
  column and not the logical one (mirror the existing row-local rename test).
- **No FK obligation → no extra constraint, no behavior change.** A logical table
  with no FK routes zero FK constraints; a plain insert is unaffected.
- **Composition.** A logical table with **both** a row-local `check` and an FK:
  a row violating the check ABORTs (check), a row with a dangling FK ABORTs (FK),
  a row satisfying both succeeds — both classes fire on the same write.
- **Deferred semantics.** Within one transaction, insert the child *before* the
  parent it references, then the parent, then commit → succeeds (the FK check
  deferred to commit). (If the test harness commits per `exec`, assert the
  same-statement / same-txn ordering that the deferral enables, or document why
  the timing is observationally equivalent.)
- **Multi-column FK** (composite `foreign key (a,b) references parent(x,y)`):
  dangling composite reference ABORTs; matching one succeeds; any-NULL component
  is allowed under MATCH SIMPLE.

Optional unit-level assertion (mirrors the row-local suite): call the new
collector directly on a resolved `LensSlot` and assert it returns one
boundary-tagged `RowConstraintSchema` whose `expr` is an `EXISTS` over the
qualified logical parent with basis-term child references.

## Docs

Update `docs/lens.md` § Constraint Attachment (and the maturity note at line 152
+ the `lens.ts` `obligations` doc-comment + `lens-prover.ts:36`) to reflect that
the `enforced-fk` class is now **live**, and that it is realized via a deferred
synthesized `EXISTS` check routed through the constraint pipeline (auto-deferred
to commit, optimizer-pushed to a basis lookup when a covering structure answers
it) rather than a bespoke `DeltaExecutor` subscription. Keep the "covering
structure is optional" framing — it remains true. Note the v1 double-enforce
decision and the `lens-fk-basis-redundancy-elision` backlog follow-up.

## TODO

- [ ] Extend `synthesizeFKSubquery` (`foreign-key-builder.ts`) to accept an
  optional FROM-schema, or factor a shared null-guard + EXISTS assembler; avoid
  duplicating the synthesis in `lens-enforcement.ts`.
- [ ] Add `collectLensForeignKeyConstraints(slot, schemaManager)` to
  `lens-enforcement.ts`: iterate `slot.obligations`, handle
  `kind === 'enforced-fk'`, resolve the parent's referenced-column names, rewrite
  child (NEW) columns to basis terms via `logicalToBasisColumnMap`, build the
  MATCH SIMPLE-guarded `EXISTS` against the schema-qualified logical parent, tag
  with `LENS_BOUNDARY_ATTACHED_TAG`, ops `INSERT | UPDATE`. Return `[]` when
  obligations are absent / no FK obligation present.
- [ ] In `view-mutation-builder.ts`, for non-delete ops, concatenate the FK
  constraints into `extraConstraints` **gated by
  `ctx.db.options.getBooleanOption('foreign_keys')`**.
- [ ] Add the `test/lens-enforcement.spec.ts` describe block above.
- [ ] Update `docs/lens.md`, the `lens.ts` `obligations` comment, and the
  `lens-prover.ts` header comment to mark `enforced-fk` live.
- [ ] `yarn workspace @quereus/quereus run build` and the lens enforcement +
  prover test suites; then full `yarn test`. Stream with `tee` per AGENTS.md.
- [ ] File / confirm the `lens-fk-basis-redundancy-elision` backlog ticket exists
  for the skip optimization.
