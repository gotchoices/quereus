description: Made the cross-source SET-value qualifier strip (`stripSideQualifier`) alias-scope-aware so a user-authored alias-qualified ref shadowed by an inner value-subquery FROM alias binds locally instead of mis-routing through the `__vmupd_keys` capture (partner-alias collision) or stripping bare (owning-alias/table-name collision). Implemented and reviewed.
files:
  - packages/quereus/src/planner/mutation/scope-transform.ts    # collectFromAliases + transformAliasScopedExpr/Query (~544-648)
  - packages/quereus/src/planner/mutation/multi-source.ts        # stripSideQualifier substitute+descent (~2570-2592); docstrings
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic      # uq-17..uq-22 (after uq-16)
  - docs/view-updateability.md                                  # § Inner Join, cross-source `set`
----

# Alias-aware shadow tracking in the cross-source SET-value strip — review complete

## Summary of the landed work

A multi-source (join-view) UPDATE lowers each SET value to base terms in two passes. Pass 2,
`stripSideQualifier`, routes a column by its `.table` qualifier: an **owning**-side alias/table
strips to bare; a **partner**-side alias/table routes through the up-front `__vmupd_keys` capture;
a **bare** qualifier is left untouched. Previously the substitute was applied scope-unaware at
every depth (`mapQueryExprUniform`). That is correct for *injected* lineage leaves (side aliases a
user subquery would not reuse) but wrong for a **user-authored** qualified ref whose qualifier
collides with a side alias/table name yet is shadowed by an inner value-subquery's own FROM alias —
SQL innermost-scope rules bind it locally, the qualifier-only strip mis-routed it.

The fix threads an accumulating FROM-alias **shadow set** through the strip's descent
(`transformAliasScopedExpr` / `transformAliasScopedQuery` in `scope-transform.ts`, the alias-only
analog of the view-column descent's column-name shadowing), and `stripSideQualifier`'s substitute
short-circuits `if (aliasShadow.has(col.table)) return undefined` **before** the owning/partner
qualifier sets. At depth 0 the shadow set is empty → byte-identical for every non-colliding
statement.

## Review findings

**Scope of review:** read the implement diff (`80a017a9`) with fresh eyes before the handoff —
`scope-transform.ts` additions, `multi-source.ts` strip + docstrings, the doc paragraph, and the
five new sqllogic cases — then audited correctness, scope-rule fidelity, type safety, DRY, tests,
and docs. Ran typecheck, lint, full suite, and an isolated red/green probe.

### Correctness — checked, sound
- **Scope-rule fidelity:** `transformAliasScopedQuery` mirrors `transformScopedQuery` exactly —
  a select's own FROM aliases join the set for its clauses and nested subqueries (`onNested`
  receives `inner`); a compound/union leg keeps the *incoming* set (`onLeg` receives the enclosing
  `aliasShadow`, not `inner`); VALUES (no FROM) keeps it; a DML…RETURNING subquery clones through
  via `cloneDmlStmt` (byte-matching the prior `mapQueryExprUniform`, **not** the scoped descent's
  `rejectDmlSubquery`). Verified each branch against `transformExpr`'s operand routing (IN LHS in
  current scope, IN/EXISTS subquery via `onNested`, with-clause cloned without substitution — same
  as the old path through `rebuildSelect`).
- **`collectFromAliases` exhaustiveness:** the `FromClause` union is exactly
  `table | join | functionSource | subquerySource` (ast.ts:510); all four are handled, alias is
  always statically known (`alias ?? table.name` / `alias` / `alias ?? name.name` / union), so the
  function correctly never returns null and needs no taint signal — the right call, since an alias
  binds even when the source's *columns* are unresolvable.
- **Ordering:** alias-shadow check fires before the owning set, which fires before the partner
  set — so an owning-/partner-/table-name collision with an inner alias is left local, and a
  genuine self-join (other side shares owning table name) still strips the owning ref.

### Tests — added one, all green
- Existing uq-17 (partner-alias, **observed** red pre-fix), uq-18 (owning-alias), uq-19
  (table-name), uq-20 (compound-leg negative scoping), uq-21 (non-colliding regression) are
  well-constructed and cover the headline collision kinds + the two "doesn't over/under-shadow"
  guards.
- **Gap found & filled (minor):** the implementer flagged depth-≥2 shadow accumulation as
  handled-but-untested. Added **uq-22** — a derived-table double nesting
  `(select s from (select max(p.score) … from points p where p.k = cid) q)` where the partner-alias
  `p` is shadowed only two levels down while the genuine correlated `cid` stays bare/untouched at
  every depth. Confirmed **green with the fix and red without** (disabled the `aliasShadow` short-
  circuit → `p.score isn't a column`, the mis-route to the parent capture; restored → green).

### Type safety / DRY / maintainability — checked
- No `any`, `ReadonlySet` threaded immutably, module-private helper not over-exported
  (`transformAliasScopedQuery` private; only `collectFromAliases` + `transformAliasScopedExpr`
  exported). Clean.
- **Acceptable duplication (noted, not filed):** `transformAliasScopedQuery` duplicates the
  alias-accumulation / compound-leg / VALUES scope rules from `transformScopedQuery`. Unifying
  would force taint/column-name/DML-reject semantics the strip never wants onto the shared
  `ScopeContext` path; the two are simple, co-located, and visibly parallel. The implementer's
  parallel-descent decision is the right tradeoff. **Maintenance note for the future:** a scope-rule
  change must touch both descents in correspondence.

### Docs — read every touched file, reflect new reality
- `docs/view-updateability.md` § Inner Join cross-source `set` paragraph and both docstrings
  (`stripSideQualifier`, `substituteViewColumns`) now state the strip is "qualifier-driven **but
  alias-scope-aware**" and correctly scope the collision-free guarantee to *injected* lineage
  leaves. Consistent with the code.

### Pre-existing limitation observed (NOT a regression, no ticket filed)
The owning-side branch strips a qualified ref to **bare**; the alias-shadow set tracks aliases, not
the resulting bare name. So a user-authored owning-qualified ref whose bare name *also* collides
with an inner FROM's **column** name (different inner alias, same column name) could in principle
mis-bind. This is **pre-existing** (the owning→bare strip predates this ticket) and largely guarded
for *injected* leaves by `substituteViewColumns`'s column-name shadowing (it never injects into a
scope where the view-column name is shadowed). For user-authored owning-alias refs it is a narrow,
murky-semantics edge (whether the view's internal join alias is even user-visible in a SET-value
subquery). Out of this ticket's scope (alias-qualifier collisions, which it fully handles); flagged
here for the record rather than filed, as it is speculative whether it is defined-behavior at all.

### Validation
- `yarn workspace @quereus/quereus typecheck` — clean.
- `yarn workspace @quereus/quereus lint` — clean.
- Full suite (`yarn workspace @quereus/quereus test`) — **6042 passing, 9 pending, 0 failing**
  (pre-uq-22 baseline; uq-22 then verified green in isolation via the 93.4 file).
- No source change in this review pass beyond the additive uq-22 test; `multi-source.ts` /
  `scope-transform.ts` are byte-identical to the implement commit.
