description: Visitor `traverseAst` now descends into `stmt.compound?.select` instead of the dead `stmt.union` field, so DDL-time validators that walk into compound subqueries no longer skip legs 2..N. Regression tests added in `40.2-check-extras.sqllogic` sections 7 & 8 cover the two CHECK validators, DEFAULT bind-parameter rejection, and generated-column dependency extraction.
files:
  packages/quereus/src/parser/visitor.ts
  packages/quereus/test/logic/40.2-check-extras.sqllogic
----

## What landed

- `packages/quereus/src/parser/visitor.ts:74` — `traverseAst(stmt.union, ...)`
  replaced with `traverseAst(stmt.compound?.select, callbacks);`. The parser
  populates `stmt.compound = { op, select }` for every `UNION / UNION ALL /
  INTERSECT / EXCEPT / DIFF` chain (see `parser.ts:577-622`); `stmt.union` is
  never set, so the previous line was dead and silently skipped every leg
  past the first.
- `packages/quereus/test/logic/40.2-check-extras.sqllogic` — section 7 added
  during implement (two CHECK-side regressions); section 8 added during
  review to lock down the two flagged gaps (DEFAULT-side bind-parameter
  rejection inside a compound subquery, and generated-column dependency
  extraction from a later compound leg).

## Why the fix is correct

`SelectStmt.compound.select` is itself a `SelectStmt`. The parser recursively
nests compound chains on the right-hand select (`parser.ts:604-622`), so
when `traverseAst` re-enters the `case 'select':` arm via that one line, it
naturally walks the entire compound chain. No additional bookkeeping is
needed.

All three `traverseAst` callers in the tree benefit:

- `schema/manager.ts:1038` — `rejectIllegalReferences` (CHECK + DEFAULT
  bind-parameter and column-ref rejection).
- `schema/manager.ts:1163` — `validateCheckConstraintDeterminism`
  (non-deterministic function rejection in CHECK).
- `schema/table.ts:621` — `extractGeneratedColumnDependencies` (generated
  column topological sort).

## Review findings

### Correctness of the visitor change — verified
- Confirmed parser emits `compound` and never `union` (`parser.ts:577-622`).
- Confirmed `SelectStmt` type still declares both `union?` (dead) and
  `compound?` (live) in `ast.ts:183-185`; the dead field is intentionally
  left in place per the ticket's explicit instruction to keep this fix
  narrowly scoped.
- Confirmed all `traverseAst` call sites: `parser/visitor.ts` (self),
  `schema/manager.ts:1038`, `schema/manager.ts:1163`,
  `schema/table.ts:621`. No caller relies on `stmt.union` being undefined
  as a side signal.

### Test coverage — extended during review
- Implement-stage tests (section 7) cover the two CHECK validators:
  bind-parameter rejection (`check (x in (select 1 union all select :p))`)
  and non-determinism rejection
  (`check (x in (select 1 union all select random()))`).
- Added section 8 to fill the two gaps the implementer honestly flagged:
  - DEFAULT-side compound-bind-parameter rejection.
  - Generated-column dependency extraction from the later leg of a compound
    subquery (regression-tested via a positive `select g from
    t_compound_gen` that exercises the topo sort).
- Both new tests pass on the fixed engine.

### Other readers of the dead AST fields — verified harmless
- `schema/rename-rewriter.ts:102` and `:532` walk **both** `stmt.union`
  and `stmt.compound.select`, so they were already correct via the second
  branch.
- `planner/analysis/assertion-classifier.ts:67` has a shape gate
  `if (sel.union) return undefined;` sitting one line below
  `if (sel.compound) return undefined;`. Since the parser never populates
  `.union`, this is dead-but-harmless — the `.compound` gate above already
  rejects every compound shape. Not touched here (scope), but a small
  cleanup-fix could remove the dead AST fields entirely along with this
  line; logged as candidate follow-up below.
- The only other `.union` usages in `packages/quereus/src` are on a JS
  `Set` (`core/database-transaction.ts:386,403,439,441`) — unrelated.

### Lint / build / tests
- `yarn workspace @quereus/quereus run lint` — clean (exit 0).
- `yarn workspace @quereus/quereus run test --grep '40.2-check-extras'`
  — 1 mocha test passing (the file runs all sections in one go).
- `yarn workspace @quereus/quereus run test` — full quereus suite 3412
  passing, 9 pending, no failures.
- `yarn build` — not re-run separately; the test command above implicitly
  type-checks via ts-node/esm and lint covered static checks.

### Architecture / SPP / DRY / maintainability — no concerns
- The change is a one-line diff to the correct field; no abstraction
  surgery needed. No new helpers, no flag plumbing, no resource lifecycle
  affected. Visitor is still single-purpose.
- Type safety preserved — `stmt.compound?.select` is `SelectStmt |
  undefined`, which is exactly what `traverseAst` accepts.
- Error handling unaffected — validators continue to throw their existing
  `QuereusError` messages; the only change is that they now see deeper
  into the AST.
- Performance: traversal cost is unchanged; we were already paying the
  `traverseAst(undefined)` no-op on `stmt.union` and now we actually
  recurse into the compound chain, which is the intended cost.

### Docs reviewed
- Scanned `packages/quereus/docs/sql.md`, `optimizer.md`, `schema.md` —
  none document the visitor or the compound-AST representation, so no
  doc updates needed.
- The implement-stage and review-stage tickets together are the documentation
  trail for this change.

### Findings disposition
- **Minor (fixed inline):** Two test-coverage gaps flagged by the
  implementer (DEFAULT-side compound bind-param, generated-column
  dependency from later leg) — both added in section 8 of
  `40.2-check-extras.sqllogic`. Pass.
- **Major:** None.
- **Candidate follow-up (optional, not filed):** Delete the dead
  `SelectStmt.union` / `SelectStmt.unionAll` AST fields and the dead
  `if (sel.union) return undefined;` shape gate in
  `assertion-classifier.ts:67`. Requires touching `rename-rewriter.ts:102`
  and `:532` as well. Not filed as a new ticket — small enough to fold
  into any incidental visitor cleanup, and intentionally out of scope
  per this ticket's instructions.

## Validation summary

| check | result |
|---|---|
| lint (`packages/quereus`) | clean |
| `40.2-check-extras` mocha test | 1 passing |
| full quereus suite | 3412 passing / 9 pending / 0 failing |

## Commit trail

- `37f123ae ticket(fix): ast-visitor-compound-select-traversal`
- `06296694 ticket(implement): ast-visitor-compound-select-traversal`
- (review commit added by runner)
