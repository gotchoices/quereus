description: Restore cross-source routing of a bare-projected partner column referenced inside a nested value subquery of a join-view `set`, by side-alias-qualifying bare lineage leaves at substitution time (the multi-source analog of single-source `baseQualify`) instead of resolving bare names inside the strip. Reverts `stripSideQualifier` to a purely qualifier-driven (scope-independent, hence sound) rule.
files:
  - packages/quereus/src/planner/mutation/multi-source.ts        # substituteViewColumns (~2402), stripSideQualifier (~2454), resolveColumnSide (~2828); call sites 1504/1568/2196/2385
  - packages/quereus/src/planner/mutation/single-source.ts       # makeViewColumnDescend baseQualify hook (~361), makeBaseQualifyScope (~247) — the pattern to mirror
  - packages/quereus/src/planner/mutation/scope-transform.ts     # transformScopedExpr / ScopeContext (already exported; no changes expected)
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic      # uq-1..uq-9 (~731-872); e1/e2/f (~1515-1566); add uq-10..uq-14
  - docs/view-updateability.md                                   # § Inner Join, cross-source `set` (~149) — top-level-only restriction paragraph
difficulty: hard
----

# Side-alias-qualify bare lineage leaves; revert the strip to qualifier-only

## Settled design (and why not the strip-side alternative)

The plan ticket suggested making `stripSideQualifier`'s descent scope-aware so a bare
leaf at depth could be resolved against the view sides when provably not shadowed.
Research found a strictly better shape. The SET-value lowering is **two sequential
walks** over the same tree:

1. `substituteViewColumns` — **already scope-aware** (`makeViewColumnDescend` /
   `makeViewScope`): a nested view-column ref is substituted to its base-term lineage
   only when not shadowed by the subquery's own FROM; tainted scopes reject
   per-reference.
2. `stripSideQualifier` — scope-UNAWARE (`mapQueryExprUniform`): strips owning-alias
   qualifiers, routes partner-alias refs through the `__vmupd_keys` capture.

The whole problem is that walk 1 injects **bare** lineage when the view body projected
a partner column unqualified (`select c.cid as cid, cval, pv from c join p …` →
`viewColToBaseRef['pv']` is the bare leaf `pv`), and walk 2 then cannot distinguish that
lineage product from a user-authored local name. Resolving bare names in walk 2 (the
plan ticket's sketch) has two flaws the research surfaced:

- **Encapsulation leak**: a user-authored bare ref nested in a value subquery that is
  NOT a view column (e.g. `psecret`, hidden by the view) and not locally bound would be
  resolved against the sides and silently routed through the capture — reading a
  concealed partner base column through the view, violating the project's documented
  `unknown-view-column` encapsulation stance. Walk 2 cannot tell a lineage leaf from a
  user leaf post-hoc.
- **Residual silent-wrong**: a computed view column `pc` with lineage `(pv * 2)` (body
  wrote `pv` bare), referenced nested where the inner FROM also has a `pv` column —
  walk 1 substitutes `pc` (not shadowed) and the injected bare `pv` then rebinds to the
  inner source by innermost-scope rules. A shadow test in walk 2 would *leave* it
  (shadowed), preserving the silent wrong value. Lineage leaves are body-scope names;
  shadowing does NOT make them local.

**The fix**: qualify bare lineage leaves with their owning side's alias **at injection
time**, inside `substituteViewColumns` — exactly the `baseQualify` hook
`makeViewColumnDescend` already exposes and the single-source spine already uses
(`makeBaseQualifier` / `makeBaseQualifyScope`, docs § "View columns nested inside a
predicate / assigned-value subquery"). The multi-source spine currently passes
`undefined` on the premise "its base terms are already alias-qualified" — false
precisely for bare-projected bodies. After injection-qualification:

- Every lineage leaf reaching walk 2 is side-alias-qualified (`p.pv`), so the strip's
  existing **qualified** rule routes it at ANY depth — the restored case rides the
  already-proven machinery, scope decisions stay in walk 1 where they belong.
- `stripSideQualifier` reverts to the single qualifier-only substitute threaded
  uniformly (delete `substituteTop`; the `substituteTop`/`substituteQualified` split
  disappears). A bare leaf reaching the strip is now only ever a user-authored
  local/unknown name — left untouched, binding locally or failing loudly at build.
- The computed-lineage rebind hazard above is fixed (qualified leaves cannot rebind).
- The same hazard in the **user-WHERE** path (bare lineage injected into a nested
  predicate subquery via `buildIdentifyingPredicate`) is fixed for free — `p.pv`
  correlates correctly to the join body.
- The ticket's residual top-level note (bare outer-correlated name colliding with a
  partner column) dissolves: `guardTopLevelScope` already restricts top-level refs to
  view columns, and all view-column lineage now arrives qualified, so the strip's
  bare-resolution branch (the only thing that could mis-route it) is gone.

## Change list

**`multi-source.ts`:**

- New `makeSideQualifyScope(sides: readonly JoinSide[]): ScopeContext` mirroring
  single-source `makeBaseQualifyScope`: for a bare, non-shadowed leaf, resolve via
  `resolveColumnSide`; when it pins exactly one side, qualify with `sides[i].alias`;
  otherwise leave (a name on no side is a lineage-internal correlated/local name; a
  name on 2+ sides was already rejected as ambiguous at body planning — see the
  existing "Preference 2" comment rationale, which moves here). Shadowing within the
  lineage expression's own nested subqueries is handled by the shared descent
  (`transformScopedExpr`). `unresolvableScope: 'reject'` with the same
  `unsupported-subquery-correlation` framing as `makeBaseQualifyScope` (an
  unprovable lineage scope must not over-/under-qualify silently);
  `rejectDmlSubquery` likewise.
- `substituteViewColumns` gains a `sides` parameter; builds
  `sideQualify = (repl) => transformScopedExpr(ctx, makeSideQualifyScope(sides), repl)`,
  applies it to the replacement in its own top-level substitute closure AND passes it
  as `makeViewColumnDescend`'s `baseQualify` argument. Update the function docstring
  (the "no baseQualify is threaded" paragraph is now wrong) and the corresponding note
  in `makeViewColumnDescend`'s docstring in single-source.ts.
- All four call sites pass `analysis.sides` (1504 non-preserved SET value, 1568
  `lowerValueOntoSide`, 2196 RETURNING projection, 2385 identifying predicate). All
  evaluate the result over the join body (aliases in scope) or through the strip, so
  qualification is uniformly correct.
- `stripSideQualifier`: delete `substituteTop` and the bare-resolution branch; restore
  `transformExpr(expr, substitute, q => mapQueryExprUniform(q, substitute))` with the
  single qualified-only substitute. Rewrite the docstring: the strip is again purely
  syntactic; bare-projection routing is owned by injection-qualification upstream.
  Keep `routePartnerRead`, both gates, and the owning-quals-first self-join ordering
  unchanged.

**Tests (`93.4-view-mutation.sqllogic`):**

- uq-10 (restored headline): body projects partner `pv` bare; nested value subquery
  reads the view column — `update v set cval = (select sum(tv) from t where tv <= pv)
  where cid = 2` with pv=200 for the target row and t values (100, 150, 300) → cval
  250; other rows and the partner base unchanged.
- uq-11 (computed-lineage collision — the silent-wrong this design fixes): body has
  `(pv * 2) as pc` with `pv` written bare; nested subquery FROM a table that ALSO has
  a `pv` column; `set cval = (select max(tv) from t where tv < pc)` must evaluate `pc`
  against the captured partner `pv` (qualified lineage), not the inner table's `pv`.
- uq-12 (tainted scope): nested view-column bare ref under a `select *` subquery source
  → reject `unsupported-subquery-correlation` (multi-source analog of case (f),
  ~line 1553; walk 1's existing taint policy, now reachable for bare-projected
  partner columns).
- uq-13 (nested cardinality): the uq-7 1:many shape with the bare partner read moved
  inside a value subquery → still rejected at plan time
  (`cross-source-ambiguous-cardinality`; `gateCrossSourceCardinality` fires at the
  rewrite site, which covers depth).
- uq-14 (encapsulation guard): nested bare ref to a partner base column the view does
  NOT project (and absent from the inner FROM) → build error (Column not found), NOT
  silently routed.
- Update uq-9's comment block (the descent rationale changed: scope decisions live in
  the view-column substitution; the strip is qualifier-only) — the assertion itself
  must keep passing unchanged (regression guard for the original silent mis-route).
- Optional: a WHERE-path variant — bare-projected partner column referenced inside an
  EXISTS in the user WHERE (`… where exists (select 1 from allow where lab = pv)`) —
  the e1 analog for bare projection, exercising the free fix.

**Docs (`view-updateability.md` § Inner Join, cross-source `set`, ~149):** replace the
top-level-only sentences ("This unqualified resolution applies at the **top level** …
must be projected **qualified** (`p.pv`) to ride the capture") with: bare lineage
leaves are side-alias-qualified when the view-column substitution injects them
(mirroring the single-source correlation-qualification of substituted terms), so a
bare-projected partner column rides the capture at any nesting depth; whether a nested
*reference* is substituted at all remains the scope-aware shadowing decision of the
view-column descent (an inner-scope-shadowed name binds locally; an unprovable scope
rejects `unsupported-subquery-correlation`).

## Edge cases & interactions

- **uq-9 collision (regression guard)**: user-authored bare `psecret` nested, present
  on the inner FROM — never substituted by walk 1 (not a view column), never touched by
  the strip (no bare resolution) → binds locally. Must still read 777, not 888.
- **uq-5 srcN dedup**: bare `pvu` lineage now qualifies to `p.pv` at injection, so the
  capture dedup key matches the qualified `pvq` read structurally — one `srcN` minted;
  the test's value assertion must hold.
- **uq-6 authored inverse**: `new.<bare-projected partner col>` resolves to the forward
  read image (still view terms) then flows through `lowerValueOntoSide` → same
  injection-qualification path; must keep passing.
- **Self-joins**: `resolveColumnSide` on a bare name uses unique column ownership — a
  self-join's shared table means no bare name is uniquely owned across its two aliases
  unless only one side has it; qualification uses `sides[i].alias` (the distinct
  alias), never the table name. Existing self-join suites must stay green.
- **USING joins / equi-key columns on 2+ sides**: `resolveColumnSide` → `undefined` →
  lineage leaf stays bare (unchanged behavior; such a bare projection is either the
  ambiguity body planning rejects, or evaluated over the join body where it planned).
- **Lineage containing its own correlated subquery**: the side-qualifier's scoped walk
  must qualify only non-shadowed leaves inside the lineage (`(select x from oth where
  fk = cid)` → `cid` qualifies, `x`/`fk` shadowed by `oth` stay) — exactly
  `makeBaseQualifyScope`'s documented behavior; covered by existing computed-column
  suites if any project such lineage, otherwise trust the shared descent.
- **WHERE / RETURNING / non-preserved paths**: all four `substituteViewColumns` callers
  now emit qualified lineage; each evaluates over the join body (`analysis.joinScope`)
  where the side aliases resolve. Watch the outer-join suites (ojv*, rojv*, skv, fofv)
  and `returning *` (which clones lineage WITHOUT substitution — intentionally
  untouched, bare lineage is unambiguous over the body).
- **Tainted scopes** (`select *` source, TVF, CTE name): walk 1 rejects a
  view-column-named bare ref per-reference (existing `makeViewScope` policy) — for
  bare-projected partner columns this turns today's confusing `Column not found` into
  the structured diagnostic; assert it (uq-12). Qualified refs (`p.pv`) in tainted
  scopes keep routing via the strip (syntactic, unchanged).
- **DML subqueries in a SET value**: already rejected by walk 1's scoped descent before
  the strip runs; the new side-qualifier's `rejectDmlSubquery` is belt-and-braces for
  lineage-internal DML (unreachable today — body planning would have rejected).
- **Legacy no-carrier path** (`registerCrossSource` undefined): a routed partner read
  still raises `cross-source-assignment` — now also for nested bare-projection reads
  (previously `Column not found`); acceptable diagnostic improvement, but confirm no
  legacy-path test asserts the old message for this shape.
- **Known residual hazards (parked, do NOT chase here)**: (a) the capture subquery's
  bare owning-PK correlation refs can rebind to a same-named inner-FROM column when
  nested (backlog `multi-source-capture-correlation-alias-collision`); (b) an inner
  FROM **alias** colliding with a side alias mis-routes qualified refs in the strip's
  uniform descent (backlog `cross-source-strip-side-alias-shadowing`).

## TODO

- Add `makeSideQualifyScope` + wire `sideQualify` through `substituteViewColumns`
  (new `sides` param, top-level closure + `baseQualify` arg) and its four call sites.
- Revert `stripSideQualifier` to the single qualifier-only substitute; delete
  `substituteTop`; rewrite both functions' docstrings.
- Update `makeViewColumnDescend` / `makeViewScope` docstrings in single-source.ts
  (the "multi-source passes undefined" note).
- Add uq-10..uq-14 (+ optional WHERE-path variant); refresh uq-9's comment.
- Update docs/view-updateability.md § Inner Join cross-source `set` paragraph.
- `yarn build`, `yarn lint` (quereus package), `yarn test` — full logic suite green,
  with particular eyes on 93.4 (uq-*, e1/e2/f/g, ax_*, oj*), and the multi-source
  plan/optimizer suites.
