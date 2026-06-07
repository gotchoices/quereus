description: |
  Enforce single-member-resolvable lens row-local CHECK (and child-FK / set-level) obligations on
  the decomposition (multi-member primary-storage) INSERT path, gated per member op by the SAME
  `constraintsForOp` resolvability rule the decomposition UPDATE path already uses. Today
  `buildDecompositionInsert` builds each member insert with NO extra constraints (`buildDecompositionMemberInsert`
  passes `[]` to `buildInsertStmt`), so a lens-synthesized logical CHECK that one base member fully
  resolves never fires on an INSERT through the logical view — even though the UPDATE path and the
  single-source INSERT path both enforce it. Confirmed empirically (see "Reproduction" below).

  Decision (made in fix stage): **enforce**, not document-the-gap. The UPDATE and single-source-INSERT
  paths already enforce; docs/lens.md § Enforcement (L286-291) already describes the per-op gate as the
  contract and even references "the decomposition INSERT path" as the deferral baseline; and the gate
  machinery (`constraintsForOp` + `referencedWriteRowColumns`) is already built for exactly this.
  Cross-member obligations stay DEFERRED (the documented deliberately-weaker contract) because they
  resolve on no single member op.
prereq:
files:
  - packages/quereus/src/planner/building/view-mutation-builder.ts  # buildDecompositionInsert ~L569; buildDecompositionMemberInsert ~L691 (passes [] today); constraintsForOp ~L887; lens*Constraints helpers ~L343-392; the main-path gate+trace ~L188-202
  - packages/quereus/src/planner/mutation/lens-enforcement.ts        # collectLensRowLocalConstraints / collectLensForeignKeyConstraints / collectLensSetLevelConstraints — the obligations to thread; referencedWriteRowColumns metadata
  - packages/quereus/src/planner/mutation/decomposition.ts           # DecompInsertOp shape (has .table: TableReferenceNode and .schema: TableSchema) ~L253-264
  - packages/quereus/src/planner/building/insert.ts                  # buildInsertStmt: extraConstraints + preBuiltSource compose independently (verified)
  - docs/lens.md                                                     # § Enforcement by constraint class L273, L286-291 (reconcile wording so the INSERT path is described as using the same gate, not as a blanket-deferral baseline)
  - packages/quereus/test/lens-put-fanout.spec.ts                    # setupSurrogateWithChecks ~L1586; "decomposition INSERT parity" ~L1643 — extend with a single-member INSERT enforcement case
----

## Root cause (confirmed)

`buildViewMutation` (`view-mutation-builder.ts` ~L68) routes a decomposition INSERT to
`buildDecompositionInsert` at an **early return**, BEFORE the `extraConstraints` collection (~L147)
and the per-op `constraintsForOp` gate (~L191) that thread lens obligations onto the base ops on the
single-source / multi-source-UPDATE / decomposition-UPDATE paths.

`buildDecompositionInsert` (~L569) builds each member insert via `buildDecompositionMemberInsert`
(~L691), which calls:

```ts
return buildInsertStmt(ctx, memberInsert, [], projectedSource, false, memberNewRowScope);
//                                        ^^ no lens constraints
```

So only each **basis** member table's own declared checks fire; the lens-synthesized logical checks
(`collectLensRowLocalConstraints` & siblings) are never consulted. The current code comment at ~L733
("Lens row-local CHECK enforcement on a decomposition insert is deferred … matches the multi-source
insert path") documents this as intentional — but it is the bug, and it contradicts both the UPDATE
path and docs/lens.md L273.

## Reproduction (verified during fix stage)

Against the surrogate `Doc_core`(title)/`Doc_body`(body) decomposition with a single-member CHECK
`check (length(title) < 5)` (title lives wholly on the anchor Doc_core):

- `insert into x.Doc (docKey, title, body) values ('k1', 'toolong', 'b1')` → **succeeds** and persists
  `title='toolong'` in `main.Doc_core` (BUG — should ABORT).
- `update x.Doc set title = 'toolong' …` → ABORTs with `CHECK constraint failed: lens:titlelen` (correct;
  the control case).

## Fix viability (confirmed)

- `buildInsertStmt(ctx, stmt, extraConstraints, preBuiltSource, lensRouted, rowScope)` accepts
  `extraConstraints` and `preBuiltSource` as **independent** params that already compose — the
  single-source spine threads constraints, the decomposition member insert threads a preBuiltSource;
  nothing prevents threading both. No change to `buildInsertStmt` needed.
- `constraintsForOp` reads ONLY `op.table.tableSchema.columns`. `DecompInsertOp.table` is a
  `TableReferenceNode` (same as `BaseOp.table`), so `op.table.tableSchema.columns` resolves the
  member table's columns directly. Widen the parameter type from `BaseOp` to a structural
  `{ readonly table: TableReferenceNode }` (or `Pick<BaseOp, 'table'>`) so both op shapes satisfy it —
  this is the "small adapter" the gate needs; no per-member column-resolution rewrite required.

## Why single-member-resolvable obligations land correctly

- **Row-local CHECK**: `collectLensRowLocalConstraints` rewrites the CHECK to basis terms and attaches
  `referencedWriteRowColumns` (basis names). For `length(title) < 5` that set is `{title}` (the basis
  column), which lives on `Doc_core`'s `tableSchema.columns` ⇒ rides the anchor member insert ⇒ fires.
  A cross-member CHECK (`title <> note`, write-row `{title, note}`) resolves on neither member op ⇒
  rides none ⇒ deferred (unchanged contract).
- **Child-side FK / set-level**: fall back to the AST walk (`writeRowColumns`) over `NEW.<basiscol>`;
  same per-member column resolution. The set-level logical-PK count CHECK references the key columns
  (e.g. `NEW.doc_key`), which live on the anchor ⇒ rides the anchor insert and defers to commit (the
  contained subquery auto-defers it), where the post-INSERT `x.Doc` reflects the full assembled row.

## Constraint classes to thread on INSERT

Collect the same three INSERT-applicable lens classes the main-path INSERT branch collects (reuse the
existing module-private helpers `lensRowLocalConstraints`, `lensForeignKeyConstraints`,
`lensSetLevelConstraints` in `view-mutation-builder.ts`):

- `lensRowLocalConstraints(ctx, view)`
- `lensForeignKeyConstraints(ctx, view)`  (pragma-gated inside the helper)
- `lensSetLevelConstraints(ctx, view)`

Parent-side FK is DELETE/UPDATE-only and its `operations` mask excludes INSERT, so it is **not**
collected here (an INSERT cannot orphan a child).

## Atomicity / ordering note

Decomposition INSERT fan-out is **anchor-first**. A single-member CHECK on the anchor fires during the
anchor member insert (first op); a deferred (subquery-bearing) CHECK fires at commit. A mid-fan-out
ABORT rolls the whole statement back — already covered by the existing atomicity test
(`lens-put-fanout.spec.ts` ~L756). Verify the new enforcement case leaves no partial member rows.

## TODO

- In `buildDecompositionInsert` (`view-mutation-builder.ts`): collect the three INSERT lens classes
  into an `extraConstraints` array (reuse `lensRowLocalConstraints` / `lensForeignKeyConstraints` /
  `lensSetLevelConstraints`). For a non-lens / plain decomposition these return `[]`, so the path
  pays nothing.
- Thread a per-op gated subset into each member insert: compute
  `constraintsForOp(op, extraConstraints, ridden)` per `plan.ops` entry and pass it through
  `buildDecompositionMemberInsert` into the `buildInsertStmt` call (replacing the hard-coded `[]`).
  Reuse the SAME `ridden: Set<RowConstraintSchema>` across all member ops, then run the existing
  cross-member trace loop (mirror `view-mutation-builder.ts` ~L198-202: `log(...)` each constraint no
  member op carried) so a deferred cross-member obligation stays visible in debug logs.
- Widen `constraintsForOp`'s `op` parameter type to a structural `{ readonly table: TableReferenceNode }`
  (or `Pick<BaseOp, 'table'>`) so a `DecompInsertOp` satisfies it. Update its doc comment, which today
  claims "multi-source put fan-out … is write-rejected upstream, so the constraints never reach an
  ambiguous fan-out here" — that is now stale; the decomposition INSERT fan-out DOES route per member.
- Update `buildDecompositionMemberInsert`: add an `extraConstraints: ReadonlyArray<RowConstraintSchema>`
  param, pass it to `buildInsertStmt` instead of `[]`, and rewrite the now-wrong ~L733 comment block
  ("Lens row-local CHECK enforcement on a decomposition insert is deferred …") to describe the per-op
  gate (single-member-resolvable ⇒ enforced; cross-member ⇒ deferred). Keep the separate `lensRouted =
  false` rationale in that comment — that is still correct (a decomposition parent has no single basis
  spine for the runtime parent-side cascade reverse-map; do NOT set it true).
- Verify a CHECK that references a basis column the INSERT does **not** supply (so the member insert
  defaults it) still resolves: the gate keys off `op.table.tableSchema.columns` (all member columns,
  not just projected ones), so it rides the op; confirm the member insert's NEW row exposes the
  defaulted column to the constraint check (same machinery as the single-source spine). Add a quick
  sanity check during implement; if it does NOT hold, note it — but it is expected to (the member
  insert goes through the ordinary `buildInsertStmt` default+constraint pipeline).

- Tests (`packages/quereus/test/lens-put-fanout.spec.ts`, the `setupSurrogateWithChecks` cluster
  ~L1586): the fixture already declares both `xmember check (title <> note)` (cross-member) and
  `titlelen check (length(title) < 5)` (single-member on title→Doc_core). Add cases:
  - **single-member CHECK ENFORCED on INSERT**: `insert into x.Doc (docKey, title, body) values
    ('kX', 'toolong', 'bX')` ABORTs (`/check|constraint|titlelen/i`) and persists nothing in
    `main.Doc_core` (atomic). This is the regression that pins the fix.
  - **single-member CHECK PASSES a valid INSERT**: a short-title insert through `x.Doc` still succeeds
    and round-trips (guards against over-deferral / false ABORT).
  - keep/extend the existing `decomposition INSERT parity` case (~L1643): a cross-member
    (`title == note`) INSERT remains DEFERRED — succeeds and persists the violation (unchanged contract).
    Optionally extend it to set a too-long title alongside, asserting the single-member CHECK still
    ABORTs even while the cross-member one is deferred (the precise boundary).
  - Consider a set-level / child-FK INSERT enforcement case if cheap (the surrogate fixture's logical
    PK `docKey` has no basis UNIQUE ⇒ commit-time set-level): a duplicate-docKey INSERT through
    `x.Doc` should ABORT at commit. If the fixture makes this awkward, document the gap rather than
    forcing it — row-local is the primary acceptance.

- Docs (`docs/lens.md`): reconcile § Enforcement by constraint class.
  - L273 ("fires on every insert/update through the lens even when the basis carries no such check")
    becomes accurate for single-member-resolvable CHECKs on the decomposition INSERT path — no change
    needed, but confirm it reads consistently with the gate description.
  - L286-291: the gate is described as applied "at the threading site (`buildViewMutation`)" and the
    L291 parenthetical "(matching the decomposition INSERT path, which also defers cross-member
    row-local / set-level enforcement)" currently implies the INSERT path defers the WHOLE class.
    Update so the INSERT path is described as using the SAME per-op gate (single-member ⇒ enforced,
    cross-member ⇒ deferred), and generalize the "threading site" wording to cover
    `buildDecompositionInsert` as well as `buildViewMutation` (both live in view-mutation-builder.ts).

- Validate: from repo root, `node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js
  "packages/quereus/test/lens-put-fanout.spec.ts" --reporter spec` (stream with `2>&1 | tee`), then
  the broader `yarn test` and `yarn workspace @quereus/quereus run lint` (single-quote globs on Windows).
