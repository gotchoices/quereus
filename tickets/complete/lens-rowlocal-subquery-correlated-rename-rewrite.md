description: |
  Scope-aware rewrite of row-local lens CHECK constraints. `rewriteToBasisTerms`
  (planner/mutation/lens-enforcement.ts) is now scope-aware: a write-row logical column
  correlated from inside a subquery is rewritten to its basis spelling (qualified `NEW.<basis>`),
  fixing the `Column not found: <logicalName>` crash at constraint build when logical≠basis
  (e.g. `docKey`→`doc_key`). Subquery-LOCAL and foreign refs are left untouched; an
  unresolvable (`select *`/TVF/CTE) tainted subquery correlating a logical column is rejected
  with `unsupported-subquery-correlation`. Review hardened the rewrite to qualify the
  write-row replacement `NEW.<basis>` (was bare), closing a silent mis-binding when a renamed
  column's basis spelling collides with a subquery-FROM source column.
files:
  - packages/quereus/src/planner/mutation/lens-enforcement.ts        # makeLensRewriteScope + scope-aware rewriteToBasisTerms; resolve() now qualifies NEW.<basis>
  - packages/quereus/src/planner/mutation/scope-transform.ts         # transformScopedExpr / ScopeContext (reused, unchanged)
  - packages/quereus/src/planner/mutation/single-source.ts           # makeViewScope / makeBaseQualifyScope (mirrored, unchanged)
  - packages/quereus/src/planner/building/view-mutation-builder.ts   # lensRowLocalConstraints forwards ctx (sole production caller)
  - packages/quereus/src/planner/building/constraint-builder.ts      # registers new.<col> + bare <col> for INSERT/UPDATE checks (why NEW resolves)
  - packages/quereus/test/lens-enforcement.spec.ts                   # makeCtx helper + migrated call sites + single-source + NEW-collision tests
  - packages/quereus/test/lens-put-fanout.spec.ts                    # makeCtx/slotX helpers + decomposition rename/shadow/taint tests
  - docs/lens.md                                                     # § Constraint Attachment: rewrite is scope-aware, NEW-qualified
----

# Review (complete): scope-aware row-local lens CHECK rewrite (correlated subquery rename)

The implement-stage work made `rewriteToBasisTerms` scope-aware by riding the shared
`transformScopedExpr` descent over a new `makeLensRewriteScope` `ScopeContext`, mirroring the
single-source view-column descent (`makeViewScope`). A correlated write-row logical column inside
a CHECK subquery is now rewritten to its basis spelling (fixing the `Column not found` crash when
logical≠basis), while subquery-local and foreign refs are preserved and an unresolvable tainted
subquery correlating a logical column is rejected. Build, full test suite, and lint pass.

## Review findings

### Checked — code correctness & design
- **Scope-aware descent reuse** — correctly rides `transformScopedExpr`/`transformScopedQuery`
  (no new walker), entered at the outermost scope so top-level refs behave as before. Shadow/taint
  semantics are owned by the shared descent; `makeLensRewriteScope` only supplies the per-column
  rule. DRY and faithful to the `makeViewScope` sibling.
- **Substitution rule** — qualified-by-logical-table ⇒ rewrite; other qualifier ⇒ untouched
  (foreign-ref guard); bare+shadowed ⇒ untouched (subquery-local); bare+mapped+unshadowed ⇒
  rewrite; bare+mapped+tainted ⇒ reject. Matches the design and the prover's deploy-time guarantee
  that every referenced logical column maps cleanly.
- **`ctx` threading** — `collectLensRowLocalConstraints(ctx, slot)` and the sole production caller
  `lensRowLocalConstraints` (view-mutation-builder.ts) verified via reference search; no other
  production callers.
- **Gate metadata (`referencedWriteRowColumns`)** — `rowLocalReferencedBasisColumns` is unchanged
  and remains consistent with the now-scope-aware expression (over-collects mapped logical columns;
  the decomposition gate routes onto the owning member). Confirmed unaffected by the NEW qualifier.
- **Diagnostic reason** — `unsupported-subquery-correlation` is a valid `MutationDiagnosticReason`;
  wording parallels the `makeViewScope` raises.
- **Type safety / cleanup / error handling** — no `any`; pure functions (no resources); structured
  diagnostics, no swallowed exceptions.

### Found & FIXED in this pass (minor) — silent mis-binding of the correlated write-row ref
- The implement version rewrote a correlated write-row ref to a **bare** basis column. Inside a
  correlated subquery, a bare basis column re-binds to a same-named column the subquery's own FROM
  introduces (innermost SQL scoping) instead of the write row — **silently** changing the CHECK's
  meaning when a renamed logical column's basis spelling collides with a subquery-source column
  (e.g. logical `maxSpeed`→basis `speed`, with a subquery `from Allowed` where `Allowed` also has a
  `speed` column). This is exactly the failure the single-source descent's `makeBaseQualifier`
  exists to prevent; the lens path mirrored `makeViewScope`'s *structure* but dropped its
  qualify-the-replacement step.
- **Fix**: `makeLensRewriteScope.resolve` now qualifies the replacement `NEW.<basis>` — the write-row
  correlation name `building/constraint-builder.ts` registers (`new.<col>` for every basis column on
  an INSERT/UPDATE check; row-local lens checks are INSERT|UPDATE only). At top level `NEW.<basis>`
  resolves to the write row identically to the prior bare form, so behavior is unchanged except in
  the collision corner. Mirrors the FK / set-level synthesizers, which already qualify their
  write-row side `NEW.*`.
- **Regression test** (lens-enforcement.spec.ts) — a single-source lens where the renamed column's
  basis spelling (`speed`) collides with a subquery-FROM source column (`Allowed.speed`). Verified
  the test **fails pre-fix** (the buggy `Allowed.cap = Allowed.speed` reading wrongly admits a
  non-listed `maxSpeed=8`) and **passes post-fix**. Doc comments + `docs/lens.md` updated to state
  the rewrite is NEW-qualified and why.

### Found — no action (out of scope / pre-existing, documented)
- **Schema-qualified column ref in a CHECK subquery (`y.Allowed.cap`) does not resolve** — a
  pre-existing resolver limitation, not introduced here; tests work around it with a table-qualified
  ref under a schema-qualified FROM. Not a regression of this ticket. *Not filed* — a latent
  resolver nicety unrelated to lens rewrite; surface separately if it bites a real schema.
- **Test helper duplication** — `makeCtx` is duplicated across lens-enforcement.spec.ts and
  lens-put-fanout.spec.ts. Test-only, low value to extract across files; left as-is.

### Coverage gaps accepted (same code path, behaviorally covered elsewhere)
- **Taint reject exercised only via `select *`** — the TVF and CTE variants hit the identical
  `collectFromColumnNames === null` path; not separately tested. Acceptable (one path).
- **INSERT-through-decomposition rename** — covered transitively (same collector + gate as UPDATE;
  INSERT-fanout shares the seam via `buildDecompositionInsert`). The new behavioral tests exercise
  UPDATE (decomposition) and INSERT (single-source).
- **Shadow-guard and correlated-rewrite directions cannot co-exist in one CHECK** — the FROM either
  introduces the name or it doesn't; each direction is covered by a separate test. Inherent, not a
  gap.

### Validation
- `yarn workspace @quereus/quereus run build` — EXIT 0.
- Targeted `lens-put-fanout.spec.ts` + `lens-enforcement.spec.ts` — **210 passing**, 0 failing
  (209 from implement + 1 new NEW-collision regression).
- Full `yarn test` (repo root) — all suites green (quereus core **4993 passing**, 0 failing).
- `yarn workspace @quereus/quereus run lint` — EXIT 0.

NB (targeted-run command): run from the **repo root**:
`node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus/test/lens-put-fanout.spec.ts" "packages/quereus/test/lens-enforcement.spec.ts" --reporter dot`
(the `from packages/quereus` form in the original ticket fails — `register.mjs` sets a
repo-root-relative `TS_NODE_PROJECT`).

## End
