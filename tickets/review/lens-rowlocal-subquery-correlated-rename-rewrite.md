description: |
  Review the scope-aware rewrite of row-local lens CHECK constraints. `rewriteToBasisTerms`
  (planner/mutation/lens-enforcement.ts) is now scope-aware: a write-row logical column
  **correlated from inside a subquery** is rewritten to its basis spelling, fixing the
  `Column not found: <logicalName>` crash at constraint build when logical≠basis (e.g.
  `docKey`→`doc_key`) — the residual the per-op metadata gate (`lens-decomp-row-local-subquery-metadata-gate`)
  deliberately left out. Subquery-LOCAL and foreign refs are left untouched; an
  unresolvable (`select *`/TVF/CTE) tainted subquery correlating a logical column is
  rejected with `unsupported-subquery-correlation` rather than mis-rewritten.
prereq:
files:
  - packages/quereus/src/planner/mutation/lens-enforcement.ts        # makeLensRewriteScope (new) + scope-aware rewriteToBasisTerms; collectLensRowLocalConstraints now takes ctx
  - packages/quereus/src/planner/mutation/scope-transform.ts         # transformScopedExpr / ScopeContext (reused, unchanged)
  - packages/quereus/src/planner/mutation/single-source.ts           # makeViewScope / makeBaseQualifyScope (mirrored, unchanged)
  - packages/quereus/src/planner/building/view-mutation-builder.ts   # lensRowLocalConstraints forwards ctx (only production caller)
  - packages/quereus/test/lens-enforcement.spec.ts                   # ctx helper (makeCtx) + 3 migrated call sites + 1 new single-source test
  - packages/quereus/test/lens-put-fanout.spec.ts                    # makeCtx/slotX helpers + 4 new decomposition tests
  - docs/lens.md                                                     # § Constraint Attachment: rewrite is now scope-aware
----

# Review: scope-aware row-local lens CHECK rewrite (correlated subquery rename)

## What changed

### Production (`lens-enforcement.ts`)
- **`rewriteToBasisTerms(expr, map)` → `rewriteToBasisTerms(ctx, expr, map, logicalTableName)`**, now
  riding `transformScopedExpr(ctx, makeLensRewriteScope(map, logicalTableName), expr)` — the *same*
  shared shadow/taint descent (`scope-transform.ts`) the single-source view-column rewrite uses.
  Previously it called `transformExpr` with **no** `descend` arg, so subquery operands passed through
  verbatim and a correlated bare write-row ref kept its logical spelling.
- **New `makeLensRewriteScope(map, logicalTableName)` `ScopeContext`** (modeled on `makeViewScope`):
  - qualified by the logical table + mapped ⇒ bare basis column (qualifier dropped);
  - any other qualifier (`Allowed.name`, a subquery FROM source) ⇒ untouched;
  - bare + shadowed by a (this-or-enclosing) subquery FROM ⇒ untouched (subquery-local);
  - bare + mapped + unshadowed ⇒ bare basis column (correlated write-row ref);
  - `unresolvableScope: 'taint'` + reject a tainted bare *logical-column* ref via
    `raiseMutationDiagnostic({reason:'unsupported-subquery-correlation', …})`; `rejectDmlSubquery`
    likewise. A foreign/qualified ref in a tainted scope is still left untouched.
  - The old "strip the qualifier of an *unmapped* qualified column" top-level behavior is **dropped**
    (the prover errors at deploy on a CHECK over a non-reconstructible column, so every referenced
    logical column maps cleanly, and a top-level CHECK qualifier can only name the logical table).
- **`collectLensRowLocalConstraints(slot)` → `collectLensRowLocalConstraints(ctx, slot)`**; passes
  `slot.logicalTable.name`. `referencedWriteRowColumns` (the gate metadata via
  `rowLocalReferencedBasisColumns`) is **unchanged** — it already over-collects every mapped logical
  column, so it stays consistent with the now-scope-aware expression.
- `transformExpr` import removed (no longer used); `transformScopedExpr`/`ScopeContext`,
  `raiseMutationDiagnostic`, `PlanningContext` imported.

### Caller (`view-mutation-builder.ts`)
- `lensRowLocalConstraints(ctx, view)` forwards its existing `ctx` to the collector. Sole production
  caller; verified via `find_references`.

### Tests / docs
- `lens-enforcement.spec.ts`: added a `makeCtx(db)` helper; migrated the 3 direct
  `collectLensRowLocalConstraints` call sites (now `(makeCtx(db), slot(db,'t'))`).
- 5 new tests total (see below).
- `docs/lens.md` § Constraint Attachment row-local bullet now states the rewrite is scope-aware.

## Behavior to verify

- **Pre-fix repro**: a decomposition (or single-source) lens with `docKey`→`doc_key` rename and a
  CHECK whose subquery correlates `docKey` crashes at constraint build with `Column not found: docKey`
  (`constraint-builder.ts:108` → `buildSelectStmt` → `resolveColumn`). Post-fix it builds in basis
  terms (`doc_key`) and enforces.
- **Same-named gate tests unaffected**: the existing `setupSubqueryCheck` cases (correlating same-named
  `title`/`note`) still build and enforce — logical==basis means the rewrite is a no-op there.
- **Existing rename row-local tests unaffected** (`speed as maxSpeed`, `lo as a`/`hi as b`, swap
  `q as a`/`p as b`): bare top-level refs, entered at the outermost (NO_SHADOW, untainted) scope, map
  exactly as before.

## Test coverage added (the floor — extend as you see fit)

`lens-enforcement.spec.ts`:
- **single-source rename** — `select id, speed as maxSpeed`, CHECK
  `exists (select 1 from y.Allowed where Allowed.cap = maxSpeed)`: allow-listed value inserts,
  non-listed ABORTs; asserts the collected constraint spells `speed` (not `maxspeed`) and keeps the
  foreign `Allowed` ref. Proves the fix is independent of decomposition.

`lens-put-fanout.spec.ts` (reusing `surrogateOptionalAd`, `docKey`→`doc_key`):
- **decomposition rename, builds+enforces** — `exists (select 1 from Allowed where Allowed.name = docKey)`,
  `update x.Doc set title=… where docKey=…`: pre-fix crashed; post-fix an allow-listed `k1` passes and a
  non-listed `k2` ABORTs at commit (the CHECK gates onto the `doc_key`-owning Doc_core anchor).
- **decomposition rename, AST + metadata** — asserts the collected constraint's `astToString` contains
  `doc_key`, not `docKey`, keeps `Allowed.name`, and `referencedWriteRowColumns === ['doc_key']`.
- **shadow guard (over-rewrite negative)** — a subquery FROM that aliases a source column to `docKey`:
  the bare subquery-local `docKey` is left spelled `docKey` (NOT rewritten to `doc_key`).
- **taint reject** — a `select *` subquery correlating `docKey` makes `collectLensRowLocalConstraints`
  throw `unsupported-subquery-correlation` rather than mis-rewrite.

## Validation run

- `yarn build` (packages/quereus) — EXIT 0.
- Targeted `lens-put-fanout.spec.ts` + `lens-enforcement.spec.ts` — **209 passing**, 0 failing.
- Full `yarn test` (repo root) — EXIT 0 (4991 + workspace suites passing, 9 pending unchanged).
- `yarn workspace @quereus/quereus run lint` — EXIT 0.

NB: the targeted-run command in the original ticket (`node --import ./register.mjs … from packages/quereus`)
**does not work** — `register.mjs` sets `TS_NODE_PROJECT=./packages/quereus/tsconfig.test.json`, a
repo-root-relative path. Run from the **repo root** instead:
`node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus/test/lens-put-fanout.spec.ts" "packages/quereus/test/lens-enforcement.spec.ts" --reporter spec`.

## Known gaps / reviewer attention

- **Single-source test column qualification**: a *schema*-qualified column ref in the CHECK subquery
  (`y.Allowed.cap`) does **not** resolve (`… isn't a column`) — a pre-existing resolver limitation,
  not introduced here. The test works around it with a *table*-qualified column (`Allowed.cap`) under a
  schema-qualified FROM (`from y.Allowed`). Worth a glance to confirm this is expected resolver behavior
  and not a latent bug to file separately.
- **Shadow-guard test has no co-located correlated ref**: the over-rewrite-negative test's CHECK has no
  *genuine* correlated ref (the bare `docKey` is shadowed), so it proves "subquery-local is preserved"
  but not "correlated-is-rewritten" in the *same* constraint. The two directions can't coexist in one
  scope (the FROM either introduces `docKey` or it doesn't); the correlated-rewrite direction is covered
  by the behavioral decomposition + single-source tests. Acceptable, but flagging the split.
- **INSERT-through-decomposition with a renamed subquery CHECK** is covered only transitively (same
  `collectLensRowLocalConstraints` rewrite + `constraintsForOp` gate as UPDATE; INSERT-fanout shares the
  seam via `buildDecompositionInsert`). The new behavioral tests exercise UPDATE; a dedicated
  decomposition-INSERT rename case (`insert into x.Doc (docKey,title,body) values (…)` with the
  `docKey`-correlated CHECK) would be belt-and-suspenders if the reviewer wants it.
- **Taint reject only exercised via `select *`**; the TVF and CTE taint variants hit the identical
  `collectFromColumnNames === null` path but are untested here.
- **Diagnostic wording** for the two new `unsupported-subquery-correlation` raises is new; confirm it
  reads consistently with the parallel `makeViewScope` messages (it intentionally parallels them).
