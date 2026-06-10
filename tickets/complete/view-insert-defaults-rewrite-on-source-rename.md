description: COMPLETE — `insert defaults` clauses (plain views AND MVs) rewrite during ALTER TABLE RENAME COLUMN / RENAME TO propagation; clause-only rewrites fire view_modified / materialized_view_modified. Review fixed a cross-schema false-rewrite regression in the FROM-table scoping.
files:
  - packages/quereus/src/schema/rename-rewriter.ts              # collectFromTableNames (now schema-aware), renameTableInInsertDefaults, renameColumnInInsertDefaults
  - packages/quereus/src/schema/schema-differ.ts                # imports collectFromTableNames (passes target schema)
  - packages/quereus/src/runtime/emit/alter-table.ts            # plain-view loops: bodyChanged|clauseChanged gating
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts  # MV propagations: clause rewrite + gating; applyMaterializedViewRewrite post-override hash/DDL
  - packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic       # sections 18–22 (22 added in review)
  - packages/quereus/test/logic/53.2-materialized-view-rename-propagation.sqllogic  # sections 7–9
  - packages/quereus/test/view-mv-ddl-persistence.spec.ts       # 2 view + 2 MV RENAME event/DDL/bodyHash tests
  - docs/view-updateability.md, docs/materialized-views.md, docs/sql.md, docs/schema.md
----

# Complete: `insert defaults` clause rewrite on source rename propagation

## What landed (implement stage)

All three reproduced failure modes from the fix ticket pass and are pinned in tests:

1. **Plain view, `d.column` stale after RENAME COLUMN** (dominant projected-away
   case) — clause target rewrites; insert through the view lands the default in
   the renamed base column (41.3 §18, §21).
2. **`d.expr` subquery table/column refs stale after RENAME TO / RENAME COLUMN**
   — expr subqueries rewrite via the table walker / plain scope-aware column
   walker (41.3 §19, §20; 53.2 §9).
3. **Clause-only skip** — plain-view loops and MV propagations gate on
   `bodyChanged || clauseChanged`, so a view/MV whose body never mentions the
   renamed name still rewrites, re-hashes, regenerates DDL, and fires exactly
   one `view_modified` / `materialized_view_modified` (53.2 §7–8; four spec
   tests pin the event/DDL/bodyHash contract).

Design: `renameTableInInsertDefaults` / `renameColumnInInsertDefaults` in
`schema/rename-rewriter.ts` (forward mirrors of the differ's inverse
reconciliation — seeded CHECK walk when the renamed table is a FROM table,
plain scope-aware walk otherwise; exprs mutated in place, fresh array only for
`column` string swaps). `collectFromTableNames` moved from the differ to
rename-rewriter and shared. `applyMaterializedViewRewrite` overrides widened
with `insertDefaults`; `bodyHash` and regenerated DDL read the POST-override
clause; `renamedColumns: bodyChanged` keeps `renameShiftedBackingColumns` off
the clause-only path. Pre-stale MV discipline untouched.

## Review findings

**Read the implement diff first (f96e8447), then audited helpers against the
body walkers' scoping, the gating/event semantics, hash/DDL agreement,
staleness discipline, and every `insertDefaults` surface in src/ (18 files
enumerated — parser, stringify, DDL generator, differ, write-through,
view_info, create paths, the two propagation files; no missed rewrite site).**

### Found and fixed in review (minor → fixed inline)

- **Cross-schema false-rewrite regression (real bug, reproduced live).**
  `collectFromTableNames` was schema-UNAWARE while the body walkers are
  schema-aware: a view over `temp.t` with `insert defaults (created = …)` got
  its clause target rewritten when an unrelated same-named `main.t` had
  `created` renamed — breaking inserts through the view
  (`'insert defaults (created_at = …)' names column 'created_at'…`). This was
  a new bug vector introduced by the forward clause rewrite (pre-ticket the
  clause was never touched, so the scenario worked). Fixed by making
  `collectFromTableNames` schema-aware (`defaultSchemaName` param, qualifier
  filtered via `schemaMatches`); all three callers updated — including the
  differ, keeping forward propagation and inverse reconciliation aligned on
  the same scoping. Regression pinned in 41.3 §22.
- **docs/schema.md change-events table** said `view_modified` fires when a
  rename "rewrites a dependent view body" — now also covers a clause-only
  rewrite; the `materialized_view_modified` row didn't mention rename
  propagation at all (pre-existing omission). Both rows updated.

### Found, verified benign, documented (no code change)

- **CTE shadowing a same-named real table** is still collected as a FROM table
  (no WITH-scope tracking), so a rename of the shadowed real table's column
  rewrites the dormant clause. Verified live: such a view is non-insertable
  (`is_insertable_into = NO`), so the clause never resolves; the differ shares
  the same blind spot, so the two directions stay in agreement. Documented in
  the helper's doc comment.

### Major findings → tickets filed

- **backlog/differ-insert-defaults-expr-nonfrom-rename-drift** — the differ's
  inverse clause-expr pass iterates only FROM tables' column renames, while the
  forward helper also rewrites non-FROM-table refs in `d.expr` subqueries
  (41.3 §20). A declarative diff with that shape sees spurious drift →
  drop+recreate (MV: rebuild churn). Verified the end state stays correct (the
  clause resolves lazily at write-through plan time, so the early-emitted
  recreate does not fail at apply) — efficiency/parity gap, not a correctness
  bug; backlog severity.

### Checked, nothing found

- **Gating/event semantics**: body+clause combined change fires exactly one
  event (single `if`); `renameTableInInsertDefaults` returning the same array
  (in-place expr mutation) is consistent with the body's handling — the MV
  table-rename path correctly omits the override since hashing reads
  `mv.insertDefaults`.
- **Hash/DDL agreement**: `bodyHash` and `generateMaterializedViewDDL` both
  read the post-override clause; the spec test cross-checks against
  `computeBodyHash(viewDefinitionToCanonicalString(...))` — what the differ
  recomputes.
- **Staleness discipline**: `wasPreStale` gate untouched;
  `renamedColumns: bodyChanged` correctly keeps the backing-column rename off
  clause-only changes.
- **Spec test regexes**: `\baudit\b` does not match `audit2` (no word
  boundary before `2`) — the negative assertions are sound.
- **Threading**: `resolveColumnInSource` built once in
  `propagateColumnRename`, threaded to the MV propagation (single caller).
- **Aliased FROM tables**: collection uses the real table name, so the clause
  gate works regardless of aliases.

### Pre-existing notes from the handoff, confirmed and deliberately left

- Differ refactor of `reconciledDeclaredViewDefinition` onto the forward
  helpers skipped per ticket guidance (inverse per-table rename-map shape
  doesn't map onto the single-rename signature); `collectFromTableNames` is
  the shared piece.
- Plain-view `sql` field stays body-only `astToString` (store re-persistence
  uses `generateViewDDL`, which the tests assert against).
- Same-schema gate on the view/MV loops (cross-schema dependents get neither
  body nor clause rewrite) predates the ticket.

## Validation (review pass)

- `yarn test` (root): all 12 workspace suites green — 5590 passing in
  @quereus/quereus (including new 41.3 §22), 0 failing.
- Targeted: full logic suite (231 files), view-mv-ddl-persistence,
  schema-differ, declarative-equivalence, mv-rename-propagation specs.
- `yarn workspace @quereus/quereus lint` and `typecheck`: clean.
- No pre-existing failures encountered (no `.pre-existing-error.md`).
