description: Closes the same-base-table self-reference corner in single-source view-mutation. The lowered single-source UPDATE/DELETE target now carries a synthesised collision-proof correlation alias (`__vm_self`), and substituted subquery-descent base terms are qualified with that alias instead of the bare base table name — so a correlation-qualified base term binds the outer target row even when the user subquery FROM names the same base table the view lowers to. Previously this silently de-correlated into a wrong write. UPDATE/DELETE only (INSERT has no target-row scan to collide with). Orthogonal to the deep scope-aware qualification (whether vs which-name).
files: packages/quereus/src/parser/ast.ts, packages/quereus/src/planner/mutation/single-source.ts, packages/quereus/src/planner/building/update.ts, packages/quereus/src/planner/building/delete.ts, packages/quereus/src/planner/scopes/aliased.ts, packages/quereus/src/emit/ast-stringify.ts, docs/view-updateability.md, packages/quereus/test/logic/93.4-view-mutation.sqllogic

## What landed

The single-source view-mutation rewriter qualified a substituted base *term* emitted
inside a subquery operand with the **base table name** (`p1_t.lbl`), because the lowered
single-source statement named its target by the bare base table with no alias. When the
user subquery FROM names the *same* base table the view lowers to, ordinary innermost-scope
SQL bound `p1_t.lbl` to the **inner** `p1_t` (the subquery's own FROM), not the outer
UPDATE/DELETE target row — the EXISTS silently de-correlated → a **silent wrong write**.

The fix synthesises a reserved, `__`-prefixed alias on the lowered target and qualifies
substituted subquery-descent terms with that alias. The alias cannot collide with any
user-introduced FROM source, so `__vm_self.lbl` always binds the outer target row.

### The three seams

**Phase 1 — AST + builders (the alias plumbing):**
- `parser/ast.ts`: optional `alias?: string` on `UpdateStmt` / `DeleteStmt`, documented as
  internal (parser never produces it — there is no `UPDATE t AS x` user syntax in scope).
- `building/update.ts` + `building/delete.ts`: the target's `AliasedScope` is now
  registered as `AliasedScope(tableColumnScope, tableName, correlationName)` where
  `correlationName = stmt.alias?.toLowerCase() ?? tableName`. The standard
  `UPDATE t AS x` semantics: `__vm_self.col` resolves to the target via the alias; the
  bare base-table name no longer matches the alias and falls through to bind the inner
  same-named subquery source; unqualified `col` still resolves to the target (the parent
  `RegisteredScope` is unchanged). Ordinary UPDATE/DELETE never set `stmt.alias`, so
  `correlationName === tableName` and the AliasedScope is **byte-identical** to before
  (alias===parentName means `t.col` still resolves `col` against the parent).

**Phase 2 — single-source qualifier (use the alias):**
- `single-source.ts`: module-level `const SELF_ALIAS = '__vm_self';` (the same internal-name
  convention as `__vmupd_keys` / `__shared_key`). `makeBaseQualifier` /
  `makeBaseQualifyScope` / `rewriteViewReturning` are parameterised on the qualifier name
  (default `baseTable.name`, so INSERT and the multi-source spine are unchanged).
  `rewriteViewUpdate` / `rewriteViewDelete` set `alias: SELF_ALIAS` on the lowered
  statement, build the where/set/assignment descend with
  `makeBaseQualifier(ctx, baseTable, SELF_ALIAS)`, and thread `SELF_ALIAS` into their
  `rewriteViewReturning` call (a RETURNING subquery can correlate to the target row the
  same way a WHERE subquery can). `rewriteViewInsert` is untouched.

**Phase 3 — stringify + docs + tests:**
- `emit/ast-stringify.ts`: `updateToString` / `deleteToString` render `... as <alias>` when
  `stmt.alias` is set. **Debug/plan-explain fidelity only** — see the load-bearing note below.
- `docs/view-updateability.md` § Selection: the "Known corner (unfixed)" note is rewritten
  to describe the fix.
- `test/logic/93.4-view-mutation.sqllogic`: blocks (p) (UPDATE) and (q) (DELETE).

## The load-bearing invariants the reviewer should attack

1. **The stringify form is NOT round-trippable through the parser.** `updateToString`
   now emits `update <t> as <alias> set ...`, but the parser has no `UPDATE t AS x`
   production. This is safe ONLY because the lowered op is handed to the builder as an
   **AST** (`view-mutation-builder.ts` → `buildBaseOp` → `buildUpdateStmt(ctx, stmt, ...)`),
   never stringified-then-reparsed. Confirmed there is no stringify→reparse path for the
   lowered UPDATE/DELETE. Reviewer: re-confirm — if any path round-trips a lowered op
   through SQL text, the synthesised alias would fail to parse. (The view-mutation
   substrate is plan→AST→re-plan via the *builders*, not via SQL text, so this holds.)

2. **A single module-level `__vm_self` constant suffices.** This relies on the invariant
   that two lowered-target aliases can never be in scope simultaneously: view-over-view,
   MV-over-MV, and view-over-MV are all rejected by `analyzeView`, and a user subquery is a
   plain SELECT that never re-lowers. Reviewer: confirm there is no recursive write-lowering
   path that could nest two `__vm_self`-aliased targets (the multi-source RETURNING
   re-query reads the view by name via `buildSelectStmt` — a READ, not a write-lowering, so
   it does not re-enter the target-alias path).

3. **`SELF_ALIAS` qualifies the lineage, not the user subquery's FROM.** The base-qualify
   transform runs over the *replacement expression* (the column-map lineage), with its own
   empty shadow set — independent of the user subquery's FROM. So a renamed base column
   (`note` → `lbl`) becomes `__vm_self.lbl` even though `lbl` IS a column of the same-named
   subquery source: the shadowing that matters is `note` against the subquery FROM (and
   `note` is not a column of `sr_t`, so it is not shadowed and IS substituted). Reviewer:
   confirm this reasoning against block (p)'s rewrite.

4. **Inert outside view-mutation.** Ordinary non-view UPDATE/DELETE with a correlated
   subquery referencing the target by table name must still resolve (no `stmt.alias` ⇒
   `correlationName === tableName`). Covered by the unchanged full suite, but a targeted
   check is cheap.

## Tests / validation (the floor, not the ceiling)

- `yarn workspace @quereus/quereus run build` — green (tsc clean; type-checks the AST +
  builder + stringify changes).
- `yarn workspace @quereus/quereus run lint` — clean (exit 0).
- `yarn workspace @quereus/quereus test` — **4330 passing, 9 pending**, 0 failing.
  - Targeted: `93.4-view-mutation.sqllogic` blocks (a)–(q) pass.
  - Block (p) UPDATE and (q) DELETE assert the same-base-table self-reference writes/deletes
    only the correlated row. Pre-fix these would write/delete BOTH rows (uncorrelated EXISTS
    true for every outer row) — confirming the corner was a silent wrong write the alias
    closes, and that the test genuinely distinguishes the fix.
  - The deep-rebind guards (k)/(l)/(m)/(n)/(o) — whose user subqueries FROM a *different*
    table — stay green: with the alias the substituted term is `__vm_self.col` instead of
    the old `<base>.col`; both resolve to the target identically, so correlation is
    preserved with no regression.

### Known gaps / high-value spots the reviewer should probe (this surface is a floor)

- **RETURNING-subquery same-base-table correlation is threaded but NOT directly tested.**
  `SELF_ALIAS` is passed into `rewriteViewReturning` so a RETURNING subquery that correlates
  to the target via the same base table would also bind the outer row — but no block
  exercises a same-base-table correlated subquery *inside a RETURNING clause* on the
  UPDATE/DELETE path. Worth a targeted block (e.g. `update sr_v set ... returning
  (select count(*) from sr_t where sr_t.k = note)` shape) to lock the RETURNING seam.
- **Computed-lineage + same-base-table together.** Blocks (p)/(q) use a *renamed* base
  column (`lbl as note`). A view column whose lineage is a computed correlated scalar
  subquery, combined with a user subquery FROM = the same base table, would exercise the
  deep qualifier AND the alias at once — currently only their orthogonal halves are tested
  separately ((o) for the deep shadow logic, (p)/(q) for the alias).
- **`in (select ... from <base>)` form.** Blocks (p)/(q) use `exists`. The `in`-subquery
  descent path with a same-base-table FROM is not separately covered.
- **Ordinary non-view UPDATE/DELETE self-correlation** is covered only implicitly by the
  unchanged suite; a one-line explicit assertion that `update t set ... where x in (select
  ... from t2 where t.k = ...)` still resolves would make the inert-path guarantee explicit.

No pre-existing failures were observed; `tickets/.pre-existing-error.md` was not written.
