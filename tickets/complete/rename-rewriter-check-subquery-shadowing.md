---
description: CHECK-aware rename rewriter now consults a schema-aware column-lookup callback so unqualified subquery refs whose inner FROM exposes a like-named column don't get false-positively rewritten to the renamed table's column.
files:
  - packages/quereus/src/schema/rename-rewriter.ts
  - packages/quereus/src/runtime/emit/alter-table.ts
  - packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic
---

# CHECK-rename rewriter respects inner-FROM shadowing

## What landed

1. `rename-rewriter.ts` — exported `ResolveColumnInSource` callback type;
   added `realSources` (lowercase `{schema, name}` records) to every scope
   frame, populated by `collectFromBindings` for real-table FROM sources
   (CTE-shadowed sources excluded via existing `break`); `isTableInUnaliasedScope`
   consults the callback at each inner frame (skipping the renamed table
   itself) before falling through to `unaliased.has`; `renameColumnInCheckExpression`
   gained an optional sixth parameter for the callback.
2. `alter-table.ts` — `propagateColumnRename` builds the closure once from
   `rctx.db.schemaManager` (`schemaManager.getSchema(s)?.getTable(t)?.columnIndexMap.has(col)`)
   and threads it through `propagateColumnRenameInSchema` →
   `rewriteTableForColumnRename` only to the `renameColumnInCheckExpression`
   call. The non-CHECK `renameColumnInAst` entry was intentionally not
   plumbed.
3. `41.3-alter-rename-propagation.sqllogic` — added cases 15 (CHECK subquery
   with like-named column on another table — must NOT rewrite) and 16
   (CHECK subquery with correlated outer ref — MUST rewrite). Case 17 (CTE
   shadow in CHECK) was documented as unconstructable because the parser
   only accepts `(SELECT ...)` as a scalar subquery, not `(WITH … SELECT …)`.

## Review findings

### Scope — out-of-scope changes reverted in this pass

The implement commit (`f00346b2`) and the prior fix commit (`0d5cfaf2`)
bundled an unrelated savepoint-broadcasting refactor into this ticket. The
review reverted those changes; they did not belong to the rename-rewriter
fix and they were causing test regressions:

- **`packages/quereus/src/runtime/emit/dml-executor.ts`** — added a
  statement-scope savepoint wrap for non-FAIL DML modes plus a per-connection
  broadcast of `createSavepoint(depth)` / `releaseSavepoint(depth)` /
  `rollbackToSavepoint(depth)`. Reverted to pre-ticket state (`HEAD~2` ==
  prior commit before the ticket's fix stage).
- **`packages/quereus/src/vtab/memory/layer/connection.ts`,
  `…/manager.ts`** — three `console.log('[DBG MEM …]')` debug instrumentation
  lines wrapped in `// eslint-disable-next-line no-console`. Reverted (the
  working tree already had two of them unstaged-removed; the third was in
  manager.ts).
- **`packages/quereus/src/core/database-transaction.ts`** — a single
  whitespace-only line deletion. Reverted for hygiene.

The savepoint-broadcast work is real engineering with a defensible motivation
(per-connection stacks getting offset by `Database.registerConnection`'s
depth-indexed replay), but it is **not** ready: it breaks tests. Filed as
`fix/dml-executor-statement-savepoint-broadcast` for re-implementation with
the bugs investigated first.

### Build / lint / tests

- `yarn workspace @quereus/quereus run build` — clean (silent success).
- `npx eslint 'src/**/*.ts'` (in `packages/quereus`) — clean, zero warnings.
- `yarn workspace @quereus/quereus run test` — **3175 passing, 0 failing**.
  - Note: the implement-stage handoff reported "701 passing, 1 failing
    (`95-assertions.sqllogic:202` pre-existing)". That was inaccurate. The
    pre-existing baseline (`HEAD~2`) was actually 3175 passing / 0 failing
    — `95-assertions.sqllogic` failure was introduced by the fix-stage
    `dml-executor.ts` change, and the implement-stage extension introduced
    a second failure (`01.5-insert-select.sqllogic`) that made mocha bail at
    521 of 3175. Reverting the out-of-scope changes restores the clean
    baseline.
- `41.3-alter-rename-propagation.sqllogic` (run isolated via mocha
  `--grep '41.3-alter'`) — passes with the new cases 15 and 16.
- `yarn test:store` not run (per the original ticket; the rename-rewriter is
  a pure-AST helper invoked during ALTER and has no store path).

### Rewriter logic — scrutinized

Reasoned through `isTableInUnaliasedScope`'s new branch case-by-case (with
`state.tableName` = renamed table name lowercased, `state.oldCol` = renamed
column old name):

| Scenario | Inner frame | Walk outcome | Rewrite? |
|---|---|---|---|
| `check ((select v from t_renamed) > 0)` (self-FROM) | `realSources = [{renamed}]`, `unaliased = {renamed}` | skip renamed; fall to `unaliased.has` → true | yes ✓ |
| `check ((select v from t_other) > 0)`, `t_other.v` exists | `realSources = [{other}]` | callback(other,v) → true → return false | no ✓ |
| `check ((select v from t_other where t_other.id < v) > 0)`, `t_other.v` absent | `realSources = [{other}]` | callback returns false; fall through; outer seed has unaliased → true | yes (correlated) ✓ |
| `check ((select v from t_renamed a) > 0)` (aliased self-FROM) | `realSources = [{renamed}]`, `unaliased = {}` (aliased), `aliasMap = {a→renamed}` | skip renamed; `unaliased.has` false; walk to outer seed → true | yes ✓ |
| `check ((select v from t_renamed a, t_other) > 0)`, `t_other.v` exists | `realSources = [{renamed}, {other}]` | skip renamed; callback(other,v) → true → return false | no ✓ (ambiguity, safe call) |

Cases above are reasoned-about, not all exercised by sqllogic. Cases 15 and
16 cover the two primary axes; the renamed-table-in-inner-FROM (line 1 of
table) is implicitly exercised by existing table-level CHECK tests in
`41.3` but worth pinning explicitly — added as a known gap rather than
fixed here (would need a new sqllogic case; the implementer flagged this
in their honest-handoff section).

### Modular / DRY / maintainable

- `realSources` is allocated for every column-rewrite scope walk, including
  the non-CHECK `renameColumnInAst` entry that never consults it. For a
  one-shot ALTER this is fine; if `renameColumnInAst` ever moves to a hot
  path the `push` could be gated on `state.resolveColumnInSource` being set.
  Not worth fixing now (implementer called this out).
- The "skip the renamed table itself" branch in the capture check uses
  `src.name === state.tableName && src.schema === state.defaultSchema`. The
  `realSources.push` records `schemaLower = (ts.table.schema ?? state.defaultSchema).toLowerCase()`,
  so the comparison is well-defined for cross-schema cases (the renamed table
  in a non-default schema would not match the skip condition, the callback
  would be asked, and would return true since the renamed table trivially
  has the old column — the walk returns false at the inner frame, preventing
  rewrite). This matches the seed-only-binds-default-schema semantics already
  in the rewriter — the renamed-table-in-default-schema is the only "implicit
  CHECK seed" case, so skipping only the default-schema variant is correct.

### Doc currency

`docs/schema.md` (ALTER section) does not mention the rewriter's internals
— it's an implementation detail. The rewriter's own JSDoc on
`renameColumnInCheckExpression` was updated in the implement commit to
describe the new behavior and the residual limitation. No other docs
needed updates.

### Aspects checked

- **Single-Purpose Principle**: the callback is the only new abstraction;
  it lives at the right seam (catalog lookup is the rewriter's only
  external dependency).
- **DRY**: no duplication introduced; `realSources.push` reuses the
  schemaLower already computed for `unaliased.add`.
- **Scalable**: O(real-sources-per-frame × frames) extra work per column
  ref. Bounded by FROM list length; not a concern for CHECK or ALTER
  invocations.
- **Maintainable**: clear JSDoc on type and the new conditional branch.
- **Performant**: see above — one-shot ALTER path.
- **Resource cleanup**: nothing to clean; pure data structures.
- **Error handling**: callback is total (returns boolean); no exception
  surface. The catalog lookup `getSchema(s)?.getTable(t)?.columnIndexMap.has(col)`
  is null-coalesced.
- **Type safety**: `ResolveColumnInSource` is a proper type alias; no
  `any` introduced. The `import('...').ResolveColumnInSource` form in
  `alter-table.ts` is consistent with neighboring inline imports there.

### Tests

- Happy path: cases 15, 16 + existing 6{a-p}, 12, 13, 14 alter-rename
  cases all pass.
- Edge cases: cross-schema is by-inspection (no sqllogic fixture for it;
  flagged in implement handoff and left as-is).
- Regression: the full test suite (3175 tests) passes.
- Aspects not pinned by sqllogic: renamed-table-in-inner-FROM self-FROM
  case; reviewed by code-walk only.

## Net result

Rename-rewriter fix lands; out-of-scope savepoint changes carved out into
`fix/dml-executor-statement-savepoint-broadcast`. Branch test baseline
restored to 3175/0.
