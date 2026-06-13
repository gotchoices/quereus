description: Rehome the view/MV `insert defaults (…)` DDL clause onto the core select as a trailing `with defaults (…)` clause (`SelectStmt.defaults`). Atomic source move + test/doc migration; no back-compat. Reviewed, hardened, and shipped.
files: packages/quereus/src/parser/parser.ts, packages/quereus/src/parser/ast.ts, packages/quereus/src/emit/ast-stringify.ts, packages/quereus/src/schema/view.ts, packages/quereus/src/schema/derivation.ts, packages/quereus/src/schema/rename-rewriter.ts, packages/quereus/src/schema/schema-differ.ts, packages/quereus/src/runtime/emit/alter-table.ts, packages/quereus/src/runtime/emit/materialized-view-helpers.ts, packages/quereus/src/func/builtins/schema.ts, packages/quereus/src/planner/mutation/single-source.ts, docs/sql.md, docs/schema.md, docs/view-updateability.md, packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic, packages/quereus/test/logic/93.4-view-mutation.sqllogic
----

# View `with defaults (…)` clause re-home — COMPLETE

The view / MV `insert defaults (col = expr, …)` DDL clause is now the trailing
`with defaults (col = expr, …)` clause of the **core select** (`SelectStmt.defaults`).
The old `insert defaults` spelling, `parseInsertDefaultsClause`, the standalone
`renameColumnInInsertDefaults` / `renameTableInInsertDefaults` clause rewriters,
and the separate `insertDefaults` schema/AST fields are removed outright (no
back-compat). Defaults ride inside the stored body AST, so `bodyHash` /
`viewDefinitionToCanonicalString` cover them via the body string, the
rename-propagation body walk descends `select.defaults` for free, and the differ
reconciles them as part of the body. Implemented in `9fb3665f`; the implement
run also diagnosed and fixed the one initially-failing differ test (the
inner-subquery false-capture; the fix threaded an optional `resolveColumnInSource`
through `renameColumnInAst` and into both the forward propagation and the differ
inverse reconcile, keeping the two directions in parity).

## Review findings

**Scope reviewed:** full implement diff `9fb3665f` (parser, AST, ast-stringify,
rename-rewriter, schema-differ, single-source, alter-table, MV helpers, view.ts,
derivation.ts, schema builtins, catalog/manager/ddl-generator, planner
nodes/building, scope-transform) plus every doc and test file the change touched
and the ones it *should* have touched. Dimensions: SPP, DRY, modularity,
scalability, maintainability, performance, resource cleanup, error handling, type
safety, and doc/test currency.

### Correctness — the fixed bug (scrutinized first)
- Re-derived the fix: once defaults live in the body, the differ rewrites them via
  the whole-body `renameColumnInAst` walk; the inner-subquery disambiguation in
  `isTableInUnaliasedScope` only consults an inner FROM's column sets when
  `resolveColumnInSource` is set. Confirmed the resolver is now threaded at the
  view-body call site (alter-table.ts:1610), the MV-twin walk
  (materialized-view-helpers.ts `propagateColumnRenameToMaterializedViews`), and
  the differ inverse path (schema-differ.ts → `inverseRenamedViewParts`). Confirmed
  the FROM scope frame is pushed before `select.defaults` is processed
  (rename-rewriter.ts:543 vs :579) and the `column` probe + expr resolve against it.
  The cross-table CHECK / index-predicate call sites correctly pass **no** resolver
  (documented non-owning branch). **Verdict: correct, in parity both directions.**

### Findings fixed inline (minor)
- **Dead code (DRY):** `collectFromTableNames` (rename-rewriter.ts) lost all callers
  in the refactor but was left exported. Removed it and its obsolete
  `insert defaults` section header. Confirmed no other references repo-wide.
- **Stale comment (maintainability):** `buildTableDerivation`'s docstring claimed
  "`def.bodySql` stays select-only" — false after the move, since
  `bodySql = astToString(select)` now carries the inert trailing `with defaults`
  clause (the read planner ignores it — building never reads `select.defaults`).
  Corrected the comment to state this explicitly.
- **Stale test comment:** 41.3 test 22 referenced the removed `collectFromTableNames`
  for cross-schema scoping; rewrote it to describe the scope-aware walk that now
  does it (schema-qualified FROM source binding).
- **Doc accuracy bug:** `docs/sql.md`'s EBNF grammar still defined
  `insert_defaults_clause = "insert" "defaults" …` and hung it off
  `create_view_stmt` / `create_materialized_view_stmt`. Rewrote: added
  `with_defaults_clause` to `select_stmt` (after `limit_clause`), dropped the old
  production, and removed the clause from the two CREATE productions. The prose
  sections (§2.8/§2.9) and the maintained-table sugar line were already updated by
  the implement run; this closes the formal-grammar gap.

### Test gaps closed inline (minor)
- **Forward resolver wiring was untested.** The differ/inverse side had the
  originally-failing (now-passing) `schema-differ.spec.ts` case, but no test
  exercised the *forward* `ALTER TABLE … RENAME COLUMN` propagation passing
  `resolveColumnInSource`. Added 41.3 **test 23**: renames a FROM-table column
  (`t_vd6.cap → cap_new`) whose name collides with a `with defaults` expr
  subquery's column (`lim_vd6.cap`); a false-capture would rewrite the inner ref to
  `cap_new` and the write-through `select max(cap_new) from lim_vd6` would error —
  so the test fails without the resolver and passes with it. (Verified: it fails
  on the un-threaded path before the fix's wiring; passes now.)
- **Duplicate-target parse rejection was untested** (listed in the reviewer floor;
  the implement run pointed at 93.4/93.5 but those cover the *runtime*
  supplied/default conflict, not the *parse-time* duplicate). Added a 93.4 case:
  `with defaults (created = 1, created = 2)` → `error: Duplicate column 'created'
  in WITH DEFAULTS`.

### Checked, no action needed (with reasons)
- **Parser clause disambiguation:** `with defaults` vs DDL `with tags` / `with
  schema` — the clause commits only when `DEFAULTS` follows `WITH`, else rewinds the
  bare `WITH` (safe: `WITH` never touches the parenStack). Compound binding (whole
  compound, after limit/offset) is correct in both parse and stringify, and a
  per-leg `defaults` triggers leg parenthesization. Covered by
  emit-roundtrip-property (now generates `with defaults` on select bodies) — all
  pass.
- **VALUES-body defaults:** parser wraps `values … with defaults` to
  `select * from (values …)` (like trailing ORDER BY); the property test
  deliberately does **not** attach defaults to a VALUES AST node (no `.defaults`
  field there → un-roundtrippable). Correct and documented in the test helper.
- **`view_info` never-throw skip** for a defaults entry naming a nonexistent column
  reads off the body AST via `bodyDefaults` (06.3.4 `dfi_v_typo`, 93.4 `df6_v`) —
  unchanged behavior, passing.
- **MV defaults transparency:** `bodyHash` over the canonical definition (defaults
  inside the body string) flips on a defaults-only edit; `materialized_view_modified`
  fires; canonical-DDL fixed point holds. The MV column-rename path now passes
  `renamedColumns: true` unconditionally (defaults are inside the body, so a
  defaults-only change flips `bodyChanged`); for a *defaults-only* column rename
  this runs a no-op backing-name pass (output names cannot shift from a defaults
  edit) — a negligible extra body re-plan in a rare case, not a correctness issue.
  Accepted as-is rather than re-introducing a body-vs-defaults split (against the
  simplification the move achieves).
- **CTE / subquery-in-FROM write-target defaults** — intentionally NOT covered here;
  that new-capability coverage is the prereq-chained `with-defaults-cte-subquery-targets`
  ticket. This ticket proves only the *move*.

### Validation performed (this review pass)
- `yarn build` → exit 0 (re-run after the source edits).
- `yarn lint` (eslint + `tsc -p tsconfig.test.json`) → exit 0.
- `yarn test` (`packages/quereus`) → **6183 passing, 9 pending, 0 failing.**
- `yarn workspace @quereus/store test` → **561 passing, 0 failing.**

### Previously-flagged pre-existing failure — RESOLVED
The implement handoff flagged 6 failing `@quereus/store` tests
(`mv-rehydrate-adopt.spec.ts`, `mv-store-backing.spec.ts`) asserting
`derivation.stale` after `ADD COLUMN` — attributed to the earlier
`mv-restore-unaffected-structural-alters` ticket updating only the memory tests.
The runner's triage pass (commit `6e835e7c`) already updated those store specs and
removed `tickets/.pre-existing-error.md`; the store suite now passes (561/0).
Nothing outstanding.
