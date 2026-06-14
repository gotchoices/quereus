description: Make a CTE-name DML target's user-predicate self-read of the target name (`with t as (…) update t set … where id in (select id from t)`) resolve to an eager up-front capture of the CTE body and produce a Halloween-safe positive write, instead of the current clean reject. Split planning context: the CTE body is planned target-excluded (so a same-named base FROM reaches the real table — the load-bearing shadow case), while the user WHERE/SET/RETURNING is planned target-included with `t` resolving to a materialized capture threaded through `ViewMutationNode.identityCapture` (reusing the multi-source / set-op eager-capture substrate).
prereq:
files:
  - packages/quereus/src/planner/building/dml-target.ts            # contextForCteTarget (target-excluded ctx); add self-read detection helper
  - packages/quereus/src/planner/building/view-mutation-builder.ts # buildViewMutation: detect self-read, build capture + ctxSelfRead, thread into propagate + buildBaseOp + identityCapture; withKeyCapture pattern
  - packages/quereus/src/planner/mutation/single-source.ts         # rewriteViewUpdate/Delete: descendCtx param; buildCteSelfCapture (mirror buildSetOpCapture, unfiltered); SELF_ALIAS machinery
  - packages/quereus/src/planner/mutation/propagate.ts             # forward descendCtx to rewriteViewUpdate/Delete
  - packages/quereus/src/planner/mutation/scope-transform.ts       # collectFromColumnNames/tableSourceColumnNames: resolve a cteNodes-backed FROM source; thread alias-shadow for the view-qualified self-read corner
  - packages/quereus/src/planner/mutation/set-op.ts                # buildSetOpCapture (capture-shape reference); MS_UPDATE_KEYS_CTE / withKeyCapture pattern
  - packages/quereus/src/planner/mutation/multi-source.ts          # MultiSourceKeyCapture, makeMultiSourceKeyRef, MS_UPDATE_KEYS_CTE
  - packages/quereus/src/runtime/emit/view-mutation.ts             # identityCapture materialize-before-base-ops (generic; no change expected)
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic        # replace the "Halloween / self-reference" reject block (~L3196) with positive-write assertions
  - docs/view-updateability.md                                     # § Common Table Expressions… → rewrite the v1 self-reference boundary bullet (~L685)
difficulty: hard
----

# CTE-name DML target: self-reference in the user predicate (Halloween)

## Background

`cte-name-dml-write-target` (landed) makes a leading `with t as (…)` a real DML write
target routed through the view-mutation substrate via an ephemeral `MutableViewLike`
(`resolveCteTarget`). To make the **load-bearing shadow case**

```sql
with base as (select id, color from base) update base set color = 'x'
```

write the REAL `base` table, the target CTE's own name is **excluded** from its body's
scope: `contextForCteTarget` deletes the target name from `cteNodes` so the body's
`from base` resolves to the outer base table (a non-recursive CTE cannot see itself).

A consequence: a user-predicate self-read of the target name

```sql
with t as (select id, color from hw) update t set color = 'x' where id in (select id from t)
```

does NOT resolve `t` to the CTE. Today it is **rejected cleanly** (`unsupported-subquery-correlation`,
"cannot be proven correlated") — pinned in `93.4-view-mutation.sqllogic` (the "Halloween /
self-reference" block) and documented as a v1 boundary. The base table is left unchanged;
it is never a Halloween-unsafe plan.

The equivalent **inline-subquery** target already does the right thing (it is a positive,
Halloween-safe write — see the `isq_hw` / `isq_hwk` tests at ~L3338) because its predicate
names the REAL base table directly (`from isq_hw`), with no own-name collision. The CTE
case fails purely because the self-read names `t` (= the view name), which the target
exclusion shadows out and the view-column descend then cannot prove correlated.

## The design (split context + eager capture)

The body and the user predicate want **opposite** `cteNodes` treatment of the target name
in the same statement:

| Position                          | Wants target name… | Why |
|-----------------------------------|--------------------|-----|
| CTE body FROM (`from base`)       | **excluded** (→ real base table) | shadow case |
| User WHERE/SET/RETURNING self-read| **included** (→ an eager capture) | Halloween-safe self-read |

So the substrate threads **two** contexts:

- **`ctxBody`** — the existing target-excluded context (`contextForCteTarget`). Used by
  `analyzeView` (body planning) **and** the capture-source build, so `from base` reaches
  the real base table.
- **`ctxSelfRead`** — `ctxBody` with the target name **re-added** to `cteNodes`, resolving
  to a context-backed capture relation (mint via `makeMultiSourceKeyRef`, keyed under the
  CTE name rather than `MS_UPDATE_KEYS_CTE`). Used by the view-column descend
  (`makeViewColumnDescend` in `rewriteViewUpdate`/`Delete`/`rewriteViewReturning`) **and**
  the lowered base-op re-plan (`buildBaseOp`), so `from t` resolves to the frozen snapshot.

The **capture** is the FULL CTE body relation (all view columns, **unfiltered** — the
self-read `from t` means the whole relation, exactly a materialized CTE), built like
`buildSetOpCapture` minus the user-WHERE filter, over the body planned under `ctxBody`. It
rides `ViewMutationNode.identityCapture`, which the emitter (`runtime/emit/view-mutation.ts`,
the generic `captureIdx`/`captureDescriptor` wrapper at ~L188) **materializes once before
any base op runs** — so the base op's `select id from t` reads the pre-mutation snapshot,
Halloween-safe by construction. No new runtime substrate is needed: the emitter's
identity-capture path already wraps the single-source RETURNING branch.

### Why the re-plan target and the self-read FROM don't collide

In `with base as (…) update base … where id in (select id from base)`, the lowered base op
targets **`main.base`** (schema-qualified — `tableIdentifier(baseTable)` sets `schema`), so
the UPDATE target resolves through the schema manager, never `cteNodes`. The predicate's
**unqualified** `from base` resolves through `cteNodes` to the capture ref. Same name, two
resolution paths, no conflict. (`resolveCteTarget` on the lowered stmt is also a no-op: the
lowered statement carries no `withClause`.)

### Scope-transform enablers (shared backward path)

`scope-transform.ts` currently has two gaps that block the self-read:

1. `collectFromColumnNames` / `tableSourceColumnNames` resolve a FROM source's columns only
   from schema tables/views; a CTE/context-backed source returns `null` → the scope is
   **tainted**, and a bare view-column name (`id`) in a tainted self-read scope is **rejected**
   (`unsupported-subquery-correlation` — the current v1 reject). Fix: resolve a FROM source
   whose name is in `ctx.cteNodes` to that node's column names, so `from t` over the capture
   is a clean shadowing local source (its `id` is shadowed, hence left local — no taint, no
   reject).

2. The view-column descend (`makeViewScope`) rewrites a **view-name-qualified** ref
   (`t.id`) to a base term unconditionally — correct for a genuine outer correlation
   (`where exists (select 1 from oth where oth.k = t.id)`), but **wrong** when `t` is the
   self-read FROM source (`select t.id from t`): there `t.id` is the capture's column, not an
   outer correlation, and silently rewriting it to a `__vm_self`-qualified base term
   de-correlates the predicate. Fix: thread an **alias-shadow** set through
   `transformScopedQuery` (parallel to the column-name `shadowed` set, built from
   `collectFromAliases(sel.from)`) and make `makeViewScope`'s view-qualified branch return
   `undefined` (leave local) when the qualifier is a locally-shadowed alias. Other
   `ScopeContext` implementers ignore the new param.

### Detection / gating

Build the capture + `ctxSelfRead` **only** when the user clauses self-read the target name —
an AST scan for a FROM source named `view.name` (unqualified) anywhere in the UPDATE/DELETE
`where` / assignment values / RETURNING subqueries (`needsSelfCapture`). Absent a self-read,
the path is byte-identical to today (no extra materialization). Gate to:

- **ephemeral CTE targets only** (`view.ephemeral` + the resolver was `resolveCteTarget`,
  not `resolveSubqueryTarget`); an inline subquery has no own-name and already works.
- **single-source bodies + UPDATE/DELETE**. A join-bodied CTE self-read (multi-source) and
  INSERT-source self-read are **out of scope** (keep current behavior; see Edge cases).

## Acceptance

- `with t as (<single-source body>) update t set … where <col> in (select … from t)` resolves
  the self-read against the eager capture and produces a Halloween-safe positive write (the
  predicate sees the pre-mutation row set), matching the equivalent inline-subquery /
  view self-reference behavior. The key-mutating variant (`set id = id + 10 where id in
  (select id from t)`) mutates every captured row deterministically (1→11, 2→12), never the
  Halloween feedback bug.
- The load-bearing shadow case (`with base as (select … from base) update base …`) STILL
  writes the real `base` table — not regressed — INCLUDING combined with a self-read
  (`… where id in (select id from base)`: target = real `base`, self-read = capture).
- The DELETE variant and a RETURNING self-read resolve the same way.
- A view-name-qualified self-read ref (`select t.id from t`) resolves to the capture column
  (alias-shadow), not a de-correlated base term.
- Sibling-CTE reads in body / predicate / source still resolve.
- INSERT-source self-read and join-bodied CTE self-read keep their current behavior (no
  silent-wrong plan); the new capture path is not taken for them.
- Replace the v1-boundary "rejected cleanly" assertions in `93.4-view-mutation.sqllogic` and
  the `docs/view-updateability.md` § Common Table Expressions… self-reference bullet with the
  new positive-write behavior.

## Edge cases & interactions

- **Shadow case × self-read (the combo).** `with base as (select id, color from base) update
  base set color='x' where id in (select id from base)` — body FROM and self-read FROM and the
  target all name `base`. Verify: body planned under `ctxBody` reads real base; capture built
  under `ctxBody` snapshots real base; lowered target is schema-qualified `main.base` → real
  base; predicate `from base` → capture. All three resolve correctly and the write lands on
  real `base`.
- **Key-mutating self-read (Halloween core).** `set id = id + 10 where id in (select id from t)`
  — the predicate column is itself rewritten by the SET. The capture must be materialized
  **before** the base op, so the frozen `{1,2}` drives the predicate; assert 1→11, 2→12 (not a
  skipped/re-matched row). This is the regression the eager capture exists to prevent.
- **View-name-qualified self-read (`select t.id from t`).** Must resolve to the capture's `id`
  via alias-shadow, NOT a `__vm_self`-qualified base term. Add a test; a silent de-correlation
  here would be a wrong write. (Without the alias-shadow fix this is silently wrong — do not
  ship the bare-form path without closing this.)
- **Mixed self-read + genuine outer correlation in one subquery.** e.g. `where exists (select 1
  from t where t.color = (select color from oth where oth.k = id))` — `from t` is the self-read
  (local capture), the bare `id` deep inside is an outer view-column correlation (→ base term,
  SELF_ALIAS-qualified). The descend must keep them distinct (shadow vs. not-shadowed).
- **Self-read with a non-`in` predicate** — `where exists (select 1 from t where t.id = id)`
  and `where color = (select color from t where id = …)` (scalar subquery). The capture +
  descend must hold for `exists` / scalar-subquery / `in` operand forms alike.
- **RETURNING self-read** — `update t set g='x' where id=1 returning (select count(*) from t)`.
  `rewriteViewReturning` must thread `ctxSelfRead`; the capture is materialized before the base
  op and the RETURNING re-projection (single-source embeds RETURNING on the base op) reads the
  frozen snapshot.
- **Sibling CTE still resolves** in body, predicate subquery, and (for completeness) the SET
  value — siblings stay in `cteNodes` in BOTH contexts (only the target name toggles).
- **Composite-PK CTE body** — the capture exposes all view columns; a multi-column self-read
  predicate resolves per the composite key, same as the inline-subquery composite-PK test.
- **`t(a,b)` column-rename CTE** — the capture's columns honor the rename (`deriveViewColumns(…,
  view.columns)`), so `from t` exposes the renamed names.
- **No-self-read statements unchanged** — a CTE-target UPDATE/DELETE whose predicate does NOT
  self-read pays nothing (no capture built, byte-identical plan). Verify an existing CTE-target
  test still produces the same plan.
- **INSERT-source self-read** (`with t as (…) insert into t … select … from t`) — out of scope;
  confirm it keeps its current behavior (not silently wrong). Park a follow-up backlog ticket if
  it currently rejects in a way worth improving.
- **Join-bodied CTE self-read** — multi-source; out of scope. Confirm it does not take the new
  single-source capture path and keeps current behavior.
- **Recursive CTE target** — still rejected up front by `resolveCteTarget` (`recursive-cte`);
  unaffected.
- **Set-op-bodied / aggregate / distinct / limit CTE bodies** — still reach their existing
  body-shape rejects; the self-read path is gated to single-source projection-and-filter bodies.
- **Shared scope-transform blast radius** — `collectFromColumnNames` and `transformScopedQuery`
  are shared by the lens / multi-source / single-source backward paths. The cteNodes-source
  resolution only *reduces* spurious taint (a previously-`null` CTE source now resolves); the
  alias-shadow param defaults empty for callers that ignore it. Re-run the full view-mutation /
  lens / multi-source sqllogic + planner specs to confirm no drift.

## TODO

### Phase 1 — scope-transform enablers (shared backward path)
- In `scope-transform.ts`, teach `tableSourceColumnNames` (and thereby `collectFromColumnNames`)
  to resolve a FROM source whose lowercased name is a key of `ctx.cteNodes` to that node's
  column names (`node.getType().columns` / `getAttributes()`), so a context-backed CTE/capture
  source shadows instead of tainting. Keep the existing schema-table/view resolution first.
- Add an **alias-shadow** set threaded through `transformScopedQuery` (parallel to `shadowed`,
  built per scope from `collectFromAliases(sel.from)`, accumulated for nested scopes, kept for
  sibling legs). Extend `ScopeContext.makeSubstitute` with the new `aliasShadowed` param;
  `transformScopedExpr` passes an empty set.
- In `makeViewScope` (single-source.ts), the view-qualified branch returns `undefined` (leave
  local) when `aliasShadowed.has(lcView)`. Other `ScopeContext` implementers
  (`makeBaseQualifyScope`, lens-enforcement, multi-source) accept and ignore the param.
- Unit-test the scope-transform changes (planner/ or a focused spec): a cteNodes source no
  longer taints; a view-qualified ref shadowed by a same-named local alias stays local.

### Phase 2 — the eager capture + split context (single-source spine)
- Add `buildCteSelfCapture(ctxBody, view)` in `single-source.ts`: plan the body
  (`buildSelectStmt`) under `ctxBody`, project ALL view columns (names/types from
  `deriveViewColumns(sel, baseTable, view.columns)`), `preserveInputColumns=false`, no WHERE
  filter; return a `MultiSourceKeyCapture` (`{ source, descriptor: {}, keyColumns }`). Mirror
  `buildSetOpCapture`. (Accepts a second body-plan distinct from `analyzeView`'s; document this
  minor double-plan as a deliberate localization tradeoff — the body is a cheap single-source
  projection-filter.)
- Add a `needsSelfCapture(stmt, targetName)` AST scan (in `dml-target.ts` or `view-mutation-builder.ts`):
  true iff a FROM source named `targetName` (unqualified) appears in any `where` / assignment
  value / RETURNING subquery.
- In `view-mutation-builder.ts` `buildViewMutation`, for `view.ephemeral` single-source
  UPDATE/DELETE with `needsSelfCapture`:
  - build `capture = buildCteSelfCapture(ctxBody, view)` (where `ctxBody` is the incoming `ctx`,
    already target-excluded by the builder's `contextForCteTarget`);
  - build `ctxSelfRead = withCteCapture(ctxBody, view.name, capture)` — a `withKeyCapture` analog
    that sets `cteNodes[view.name.toLowerCase()] = makeMultiSourceKeyRef(scope, capture)`;
  - pass `ctxSelfRead` to `propagate` (as a new optional `descendCtx`) AND to `buildBaseOp`
    (the op re-plan ctx);
  - thread `capture` into `ViewMutationNode.identityCapture` (the existing `{ source, descriptor }`
    side input — reuse the `identityCapture` variable path).
  Absent `needsSelfCapture`, behavior is unchanged (`identityCapture` stays undefined, contexts
  unchanged).
- `propagate.ts`: forward an optional `descendCtx?: PlanningContext` to `rewriteViewUpdate` /
  `rewriteViewDelete` (ignored for insert/join/decomposition/set-op).
- `single-source.ts`: `rewriteViewUpdate` / `rewriteViewDelete` / `rewriteViewReturning` accept
  `descendCtx?`; use `descendCtx ?? ctx` for `makeViewColumnDescend` (and the RETURNING descend),
  while `analyzeView` continues to use the body `ctx`. The lowered target stays
  `tableIdentifier(analysis.baseTable)` (schema-qualified — load-bearing).

### Phase 3 — tests + docs
- Rewrite the `93.4-view-mutation.sqllogic` "Halloween / self-reference" reject block
  (~L3196) into positive-write assertions mirroring the inline-subquery tests: bare self-read,
  key-mutating self-read, shadow-case×self-read combo, DELETE variant, RETURNING self-read,
  view-name-qualified self-read, sibling-CTE-in-predicate, composite-PK, `t(a,b)` rename. Keep
  a no-self-read CTE-target case asserting unchanged behavior.
- Update `docs/view-updateability.md` § Common Table Expressions and the CTE-name DML target:
  replace the "Self-reference in the user predicate (Halloween)" v1-boundary bullet (~L685) with
  the new behavior (split context + eager capture via `identityCapture`), and note the remaining
  deferrals (INSERT-source self-read, join-bodied CTE self-read).
- Run `yarn build` then `yarn workspace @quereus/quereus test` (stream with `tee`); run
  `yarn lint` (single-quote globs on Windows). Fix any drift in the shared backward-path specs.
