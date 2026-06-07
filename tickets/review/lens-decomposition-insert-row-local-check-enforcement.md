description: |
  Review the enforcement of single-member-resolvable lens obligations (row-local CHECK,
  child-side FK, commit-time set-level uniqueness) on the decomposition (multi-member
  primary-storage) INSERT path. Previously `buildDecompositionInsert` built each member
  insert with NO extra constraints (hard-coded `[]`), so a lens-synthesized logical CHECK
  that one base member fully resolves never fired on an INSERT through the logical view —
  even though the UPDATE path and the single-source INSERT path both enforced it. This
  threads the same `constraintsForOp` per-op resolvability gate the decomposition UPDATE
  path uses onto the INSERT member fan-out. Cross-member obligations stay DEFERRED (the
  documented, deliberately-weaker contract).
files:
  - packages/quereus/src/planner/building/view-mutation-builder.ts  # buildDecompositionInsert, buildDecompositionMemberInsert, constraintsForOp, buildBaseOp doc
  - packages/quereus/test/lens-put-fanout.spec.ts                   # setupSurrogateWithChecks cluster — 5 new INSERT cases
  - docs/lens.md                                                    # § Enforcement by constraint class (L286, L291 reconciled)
----

## What changed

### `view-mutation-builder.ts`

- **`buildDecompositionInsert`** now collects the three INSERT-applicable lens constraint
  classes (`lensRowLocalConstraints`, `lensForeignKeyConstraints`, `lensSetLevelConstraints`),
  gates each per member op via `constraintsForOp(op, extraConstraints, ridden)` (reusing ONE
  `ridden` set across all member ops), and runs the cross-member trace loop (a `log(...)` for
  any constraint that rode no member op) — mirroring the UPDATE path in `buildViewMutation`.
  Parent-side FK is intentionally NOT collected (DELETE/UPDATE-only; an INSERT cannot orphan a
  child).
- **`buildDecompositionMemberInsert`** gained an `extraConstraints` param, passed to
  `buildInsertStmt` in place of the old hard-coded `[]`. `lensRouted` stays `false` (a
  decomposition parent has no single basis spine for the runtime parent-side cascade
  reverse-map — unchanged, deliberate).
- **`constraintsForOp`** `op` param widened from `BaseOp` to `Pick<BaseOp, 'table'>` so a
  `DecompInsertOp` (which carries the member's `TableReferenceNode`) satisfies it structurally.
  No per-member column-resolution rewrite needed — the gate reads `op.table.tableSchema.columns`
  for either op shape. Stale doc comments updated (`constraintsForOp` + the "multi-source put
  fan-out … write-rejected upstream" claim in `buildBaseOp`).
- **Added `rejectLensSetLevelConflictResolution(ctx, view, {op:'insert', stmt})`** at the top of
  `buildDecompositionInsert`. This is a correctness consequence of newly threading the
  commit-time set-level count CHECK: the decomposition INSERT early-returns from
  `buildViewMutation` *before* that gate runs (line ~68, gate at line ~96), so without this an
  `insert or replace`/`or ignore`/upsert through a commit-time set-level decomposition would
  silently ABORT-at-commit instead of emitting the documented up-front diagnostic. Surgical: only
  this path is touched; the multi-source insert path (which threads no set-level constraints)
  keeps its pre-existing harmless bypass.

### `docs/lens.md` § Enforcement by constraint class

- L286 paragraph: generalized "threading site (`buildViewMutation`)" to cover
  `buildDecompositionInsert` too (both in `view-mutation-builder.ts`, sharing the one
  `constraintsForOp` gate), noted INSERT reaches the fan-out, and that parent-side FK is not
  collected on INSERT.
- L291: the parenthetical that implied the INSERT path defers the WHOLE class was rewritten to
  state INSERT and UPDATE run the SAME per-op gate (single-member ⇒ enforced, cross-member ⇒
  deferred).

## How to validate / use cases

Fixture: `setupSurrogateWithChecks` (`lens-put-fanout.spec.ts` ~L1586) — surrogate
`Doc_core`(title)/`Doc_body`(body)/`Doc_meta`(note) decomposition with logical `x.Doc`
declaring `xmember check (title <> note)` (cross-member, write-row {title, note}) and
`titlelen check (length(title) < 5)` (single-member on title→Doc_core). Logical PK `docKey`
has NO basis UNIQUE ⇒ commit-time set-level.

New cases (all passing):
- **single-member CHECK ENFORCED on INSERT** — `insert into x.Doc … values ('kX','toolong','bX')`
  ABORTs and persists nothing in `main.Doc_core` (atomic; pins the regression).
- **single-member CHECK PASSES a valid INSERT** — a short-title insert succeeds + round-trips
  (guards against over-deferral / false ABORT).
- **INSERT boundary** — a too-long title that ALSO equals note: the single-member CHECK ABORTs
  even while the cross-member one is deferred.
- **commit-time set-level on INSERT** — a duplicate `docKey` INSERT ABORTs at commit (the count
  CHECK rides the anchor op and auto-defers).
- **conflict-resolution rejection** — `insert or replace into x.Doc …` is rejected up front
  (pins the gate added above).

Existing `decomposition INSERT parity` (cross-member CHECK deferred on INSERT) kept unchanged.

Commands:
- `node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus/test/lens-put-fanout.spec.ts" --reporter spec` → 71 passing
- `yarn test` → all workspaces pass (quereus 4987 passing, 9 pending; others green)
- `yarn workspace @quereus/quereus run lint` → clean

## Known gaps / things for the reviewer to probe

- **Defaulted-but-CHECK-referenced column not explicitly pinned.** The ticket flagged verifying a
  CHECK that references a basis column the INSERT does NOT supply (so the member insert defaults
  it) still resolves. This follows from the design — the gate keys off `op.table.tableSchema.columns`
  (the full member schema, not just projected columns), and the member insert runs the ordinary
  `buildInsertStmt` default+constraint pipeline that exposes the full NEW row to checks (same as the
  single-source spine). It is NOT covered by a dedicated test because the surrogate fixture has no
  defaulted column that a CHECK references (`title` has no default; `length(NULL) < 5` is NULL ⇒
  vacuously passes anyway). A reviewer wanting belt-and-suspenders could add a fixture with a
  CHECK on a member column carrying a non-null default and confirm a violating default ABORTs.
- **Child-side FK INSERT enforcement not exercised by a dedicated test.** The class is collected and
  gated (so a single-member-resolvable logical FK would ride its member insert), but the surrogate
  fixture declares no logical FK, so only row-local + set-level are empirically pinned on INSERT.
  Child-side FK enforcement is covered on other paths; if cheap, a reviewer could add a
  decomposition-INSERT FK case.
- **`rejectLensSetLevelConflictResolution` scope.** Added only to `buildDecompositionInsert` (the
  path that now threads set-level). The multi-source-join INSERT path (`buildMultiSourceInsert`)
  still bypasses it AND threads no set-level constraints — a pre-existing, deliberately-untouched
  gap, not a regression here. Worth a glance if the reviewer wants a unified gate location.
- **Double-enforcement when a basis column name coincides across members.** If a referenced basis
  column name happens to exist on more than one member table, the gate rides the constraint onto
  each — sound (redundant), matching the UPDATE path. Not expected in practice (each logical column
  routes to one member) but worth noting.
