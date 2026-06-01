description: Live child-side FK enforcement at the lens write boundary — a logical `enforced-fk` obligation is realized as a deferred, basis-term synthesized `EXISTS` existence check, routed through the same `extraConstraints` pipeline the row-local class uses, gated by the `foreign_keys` pragma. Implemented, reviewed, and shipped.
files: packages/quereus/src/planner/mutation/lens-enforcement.ts, packages/quereus/src/planner/building/foreign-key-builder.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/test/lens-enforcement.spec.ts, docs/lens.md, packages/quereus/src/schema/lens.ts, packages/quereus/src/schema/lens-prover.ts
----

## What shipped

For each lens prover `enforced-fk` obligation, `collectLensForeignKeyConstraints`
(`planner/mutation/lens-enforcement.ts`) synthesizes a child-side existence check

```
( NEW.<basisChild1> IS NULL OR … OR
  EXISTS( SELECT 1 FROM <logicalSchema>.<parent>
          WHERE <parent>.<refCol1> = NEW.<basisChild1> AND … ) )
```

routed through the existing `extraConstraints` seam
(`view-mutation-builder.ts` → `buildBaseOp` → `buildInsertStmt`/`buildUpdateStmt`
→ `buildConstraintChecks`), the same path the row-local class rides. The
synthesis is shared with the physical child-side FK builder via the extracted
`synthesizeFKExistsExpr` (`foreign-key-builder.ts`).

Matches physical child-side FK semantics by construction: the contained `EXISTS`
makes `buildConstraintChecks` auto-defer the check to commit, and collection is
gated on the `foreign_keys` pragma exactly like `buildChildSideFKChecks`. v1
double-enforces (always synthesizes, even when the basis carries an equivalent
FK); skip-when-redundant is deferred to backlog `lens-fk-basis-redundancy-elision`.

See the implement-stage commit (`ticket(implement): lens-fk-enforcement-wiring`)
for the full mechanism write-up; this file records the review disposition.

## Review findings

### Checked

- **Read the implement diff with fresh eyes** before the handoff summary: all six
  source files + the test + the three doc surfaces (`docs/lens.md`, `lens.ts`,
  `lens-prover.ts`).
- **Mechanism trace** — confirmed the synthesized `EXISTS` flows through
  `extraConstraints` → `buildConstraintChecks`, and that `containsSubquery`
  auto-defers it (verified the deferred-across-statements test passes), so the
  timing genuinely matches physical child-side FK rather than relying on a hand-set
  `deferrable` flag.
- **Schema resolution** — confirmed the FROM is qualified with the *logical* schema
  (`fk.referencedSchema ?? slot.logicalTable.schemaName`) so it resolves to the
  registered logical parent view even though the routed constraint is built under
  the basis schema path; the parent-column qualifier resolves to the FROM source's
  implicit alias.
- **DRY** — the `synthesizeFKExistsExpr` extraction is clean; the physical
  `synthesizeExistsCheck` correctly delegates and the lens collector reuses it with
  basis-rewritten child names + logical parent names.
- **Gating parity** — `lensForeignKeyConstraints` gates on `foreign_keys` (matching
  physical); `lensRowLocalConstraints` correctly does not (CHECK always fires).
  Both correctly excluded for `delete`.
- **Type safety / cleanup** — no `any`, every test closes its `Database` in a
  `finally`.
- **Tests run** — `build` clean (exit 0); `eslint` clean on all changed files;
  `lens-enforcement.spec` 21 passing; `lens-prover.spec` 17 passing; full
  `packages/quereus` suite **4190 passing** (exit 0). No `.pre-existing-error.md`
  needed.

### Minor — fixed inline this pass

- **Untested common idiom (test gap).** Every implement-stage FK test used an
  *explicit* parent column list (`references parent(id)` / `references
  parent(px, py)`), so the **PK-fallback** branch of
  `resolveLogicalReferencedColumns` — which fires for the *common* bare
  `references parent` idiom (the parser leaves `referencedColumnNames` empty, per
  `parser.ts foreignKeyClause`) — was entirely unexercised. Added a test
  (`a bare 'references parent' (no column list) falls back to the parent PK`) with
  distinct PK/non-PK parent column names so the fallback must resolve the actual PK
  (`pk_id`); confirmed the fallback resolves correctly and enforces (dangling
  aborts, satisfied succeeds). The ticket undersold this path as a "backstop"; it
  is a primary path.

- **Missing count-mismatch guard (robustness/parity).** When parent columns cannot
  be resolved to the child arity (an unresolvable parent ⇒ `[]`, or a malformed FK),
  the collector would synthesize an `EXISTS` with `undefined` parent column names
  (`parentColumns[i]` out of range) — a malformed AST that throws a confusing error
  downstream rather than degrading cleanly. The physical builder guards this exact
  case (`if (parentColIndices.length !== fk.columns.length) continue;`). Added the
  symmetric guard in `collectLensForeignKeyConstraints` (skip + `log`), plus the
  `createLogger` import. Defensive (the prover validates FK arity at deploy), but
  now at parity with the physical path.

- **Stale doc — `lens-prover.ts`.** The `enforced-fk` member of the
  `ConstraintObligation` union (line 141) still described enforcement as
  "cross-relation existence, commit-time `DeltaExecutor`" — the implementer updated
  the file header but missed this inline comment. Rewrote it to the synthesized-
  `EXISTS` reality.

- **Stale doc — `docs/lens.md` advisory table.** The "No backing index for a
  set-level constraint" advisory parenthetically claimed FK existence is enforced
  by the "O(n) commit-time `DeltaExecutor` scan". Verified the prover emits
  `lens.no-backing-index` **only for set-level** (key) constraints, never for
  `enforced-fk` (`classifyConstraint` returns `{ kind: 'enforced-fk' }` with no
  warning). Corrected the row to scope it to set-level and note the FK path is the
  synthesized `EXISTS` with optimizer pushdown.

### Major — filed new ticket

- **Parent-side lens FK enforcement is unenforced.** Deleting/updating a logical
  *parent* row through the lens does not run any RESTRICT existence check (or
  cascade) against the logical children: the physical parent-side machinery
  (`buildParentSideFKChecks`, `runtime/foreign-key-actions.ts`) discovers FKs by
  scanning basis `TableSchema.foreignKeys`, but a logical FK lives only on the
  logical child slot — so a logical-parent delete can orphan logical children. This
  is the exact mirror of the child-side gap this ticket closed. Filed
  `backlog/lens-parent-side-fk-enforcement.md`. (The implementer flagged parent-side
  as out-of-scope but filed no tracking ticket; now tracked.)

### Verified acceptable — no action

- **Multi-source / decomposition logical tables don't route FK (or row-local)
  extras.** Inherited single-source-spine limitation (the decomposition / join
  insert paths early-return before `buildBaseOp`; multi-source put is write-rejected
  upstream). Matches the documented row-local behavior — same general limitation,
  not introduced here, already tracked across the lens multi-source tickets. No new
  ticket.
- **Optimizer pushdown asserted behaviorally, not structurally.** The tests confirm
  the enforcement guarantee (dangling aborts / satisfied passes), not that an index
  seek vs. full scan actually occurs. The guarantee is what matters for correctness;
  a plan-level seek assertion is a nice-to-have, not a gap. No ticket.
- **v1 double-enforcement.** Deliberate and sound; the skip-when-redundant
  optimization is tracked in `backlog/lens-fk-basis-redundancy-elision` (confirmed
  present). No action.
- **Explicitly-nullable FK columns in the MATCH-SIMPLE-NULL tests.** Verified
  correct: `default_column_nullability` defaults to `not_null` (Third Manifesto), so
  FK columns are declared `null` in both basis and logical schemas to exercise the
  null-guard path — a faithful nullable-FK scenario.

### Net change this pass

- `+2` tests intent (1 new test file entry; total spec 21 passing).
- `lens-enforcement.ts`: count-mismatch guard + logger import.
- `lens-prover.ts`, `docs/lens.md`: doc-accuracy corrections.
- `backlog/lens-parent-side-fk-enforcement.md`: new tracking ticket for the major
  finding.
