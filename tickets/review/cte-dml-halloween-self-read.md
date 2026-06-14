description: Review the CTE-name DML target self-read (Halloween) implementation — split planning context (target-excluded body + target-included eager capture) so `with t as (…) update t set … where id in (select id from t)` produces a Halloween-safe positive write instead of the prior clean reject. Verify the scope-transform enablers, the gating, and the out-of-scope deferrals.
files:
  - packages/quereus/src/planner/mutation/scope-transform.ts        # cteNodes-source resolution + alias-shadow threading
  - packages/quereus/src/planner/mutation/single-source.ts          # buildCteSelfCapture, makeViewScope alias-shadow, descendCtx threading, MutableViewLike.cteTarget
  - packages/quereus/src/planner/building/dml-target.ts             # cteTarget flag, needsSelfCapture AST scan
  - packages/quereus/src/planner/building/view-mutation-builder.ts  # withCteCapture, self-read gating + wiring (descendCtx, identityCapture)
  - packages/quereus/src/planner/mutation/propagate.ts              # forward descendCtx to rewriteViewUpdate/Delete
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic         # replaced the reject block with positive-write assertions (~L3196)
  - docs/view-updateability.md                                      # § Common Table Expressions self-reference rewrite (~L676/685)
difficulty: medium
----

# Review: CTE-name DML target self-read (Halloween) — split context + eager capture

## What changed (and why it's correct)

The prior v1 boundary rejected a user-predicate self-read of a CTE-name DML target
(`with t as (…) update t set … where id in (select id from t)`) with
`unsupported-subquery-correlation` ("cannot be proven correlated"), because the target
name is **shadowed out of its own body's scope** (`contextForCteTarget` deletes it from
`cteNodes` so the load-bearing shadow case `with base as (select … from base) update base`
reaches the **real** base table). That same shadowing made the user-clause self-read
unresolvable.

The fix threads **two** contexts through the single-source spine:

- **`ctxBody`** (the incoming, target-**excluded** ctx) plans the body (`analyzeView`) and
  builds the capture source (`buildCteSelfCapture`), so `from base` in the body reaches the
  real table.
- **`ctxSelfRead`** = `ctxBody` with the target name **re-added** to `cteNodes`, resolving to
  a context-backed key relation over an **eager capture of the full (unfiltered) body
  relation** (`withCteCapture` → `makeMultiSourceKeyRef`, keyed under the CTE name, not
  `__vmupd_keys`). It drives the view-column descend (`makeViewColumnDescend`) **and** the
  lowered base op's re-plan (`buildBaseOp`), so `from t` binds to the frozen snapshot.

The capture rides `ViewMutationNode.identityCapture` — the **existing** emitter path
materializes it **once before any base op runs** (no runtime changes), so the base op's
`select id from t` reads the pre-mutation snapshot. Halloween-safe by construction.

Two scope-transform enablers (the shared backward path — reused by lens / multi-source /
single-source):
1. `tableSourceColumnNames` now resolves a FROM source whose unqualified name is in
   `ctx.cteNodes` to that node's columns — a clean **shadowing** local source instead of a
   taint. (Strictly reduces spurious taint; a same-named schema object still resolves first.)
2. An **alias-shadow** set threaded parallel to the column-name shadow set through
   `transformScopedQuery`; `makeViewScope`'s view-qualified branch leaves `t.id` local when
   `t` is a locally-shadowed FROM alias (the `select t.id from t` self-read) — so it binds the
   capture column, never a de-correlated `__vm_self`-qualified base term.

Gating (`view-mutation-builder.ts`): ephemeral **CTE-name** target (`view.cteTarget`, set only
by `resolveCteTarget` — an inline subquery already round-trips) **+** single-source (`!isJoinBody`)
**+** UPDATE/DELETE **+** `needsSelfCapture` (an AST scan for an unqualified FROM source named
the target in any where / assignment value / RETURNING subquery). Absent a self-read the plan
is byte-identical to before (no capture, no extra materialization).

## How to validate

`yarn build` ✅, `yarn workspace @quereus/quereus test` ✅ (6216 passing, 0 failing),
`yarn workspace @quereus/quereus lint` ✅ (eslint + test-file typecheck). All run clean.

Positive-write coverage is in `93.4-view-mutation.sqllogic` (the block that replaced the old
reject, ~L3206+), mirroring the inline-subquery `isq_hw`/`isq_hwk` tests:
- **bare self-read** (`where id in (select id from t)`) → positive write;
- **key-mutating self-read** (`set id = id + 10 where id in (select id from t)`) → 1→11, 2→12
  (the Halloween core — frozen `{1,2}` drives the predicate);
- **shadow case × self-read combo** (`with base as (select … from base) update base … where id
  in (select id from base)`) → writes the **real** base (all three name-resolutions distinct);
- **DELETE** variant (with a subquery WHERE, discriminating: only `id<>2` deleted);
- **RETURNING self-read** (`returning (select count(*) from t)` → 2 = pre-mutation count);
- **alias-shadow discriminator** — `set color = cast((select sum(t.id) from t) as text)` → `6`
  (a silent de-correlation would correlate `t.id` to the single outer row and sum `1+1+1 = 3`);
  also in a RETURNING subquery (`sum(t.id)` → 6);
- **scalar-subquery** SET value, **exists**-form, **mixed self-read + genuine outer correlation**
  (WHERE `from t` + SET `(select c from oth where oth.k = id)`), **sibling-CTE** in predicate and
  in SET value, **composite-PK** body, **`t(a,b)` rename**, and a **no-self-read** CTE-target case
  (asserts the unchanged plain-write path);
- **out-of-scope deferrals** keep current behavior: INSERT-source self-read errors
  `Table 't' not found`; join-bodied (multi-source) CTE self-read errors `cannot be proven
  correlated`.

Reject parity for unsupported body shapes WITH a self-read present was hand-verified (aggregate
/ distinct / limit / recursive all reject cleanly via `buildCteSelfCapture`'s `analyzeView`, no
crash) — the existing no-self-read reject tests (~L3165–3194) are unchanged.

## Known gaps / things to scrutinize (treat tests as a floor)

- **No isolated scope-transform unit spec.** The two enablers are covered by *discriminating
  integration* tests (alias-shadow via the `sum(t.id)` 6-vs-3 probe; cteNodes-no-taint via the
  sibling-CTE-in-predicate + self-read tests) rather than a synthetic `ScopeContext` unit test
  (constructing one in isolation is artificial and weaker than the end-to-end discrimination).
  If the reviewer wants isolated coverage of `collectFromColumnNames` / `transformScopedQuery`,
  that's the gap to fill. **The `93.4` file runs as a single sqllogic test**, so a regression in
  any one assertion fails the whole file — consider whether finer-grained `.spec.ts` coverage is
  warranted for the alias-shadow corner specifically.
- **Double/triple body plan.** A self-read UPDATE/DELETE plans the body in `buildCteSelfCapture`
  (`analyzeView` + a second `buildSelectStmt` for the capture projection) AND in `propagate`'s
  `rewriteViewUpdate` (`analyzeView`). Deliberate localization tradeoff (the body is a cheap
  single-source projection-filter); confirm it's acceptable and not a correctness risk (the two
  plans are independent subtrees with their own attribute ids — the capture's descriptor ties
  the readers to the materialized rows, not to plan-node identity).
- **`needsSelfCapture` window-frame-bound under-detection.** The AST scan covers window-fn args /
  partitionBy / orderBy but NOT frame-bound value expressions. A self-read buried in a window
  frame bound would be missed → no capture → falls back to the current taint/reject (a safe
  under-detection, never a silent wrong write). Confirm that's an acceptable boundary.
- **Mixed self-read + outer correlation — SQL-scoping subtlety.** The implemented behavior is
  principled (shadow accumulates through nesting; a bare view-column name inside a `from t`
  subquery binds to the capture by innermost-scope rules, NOT the outer row). The 93.4 "mixed"
  test uses the *sibling* form (outer correlation in a subquery whose FROM is `oth`, not `t`) to
  keep the two unambiguously distinct. A reviewer may want a test that pins the *nested* form's
  binding too (the ticket's `where exists (select 1 from t where t.color = (select color from oth
  where oth.k = id))` shape) — verify the engine's binding there matches intent.
- **Alias-shadow blast radius.** `ScopeContext.makeSubstitute` gained a third `aliasShadowed`
  param; the other implementers (`makeBaseQualifyScope`, `makeSideQualifyScope`,
  lens-enforcement) ignore it (fewer-param arrows satisfy the wider type). Confirm none of them
  silently *needed* alias shadowing (they don't take the self-read path — no own-name to shadow).
- **Follow-up backlog candidate (optional):** INSERT-source self-read
  (`with t as (…) insert into t … select … from t`) currently table-not-founds. The ticket
  flags it as a possible future improvement; file a `tickets/backlog/` item only if deemed
  worth it (the CTE-name INSERT already covers the common "insert through a derived relation"
  need).

## Out of scope (unchanged, verified): recursive CTE target (rejected up front), set-op /
aggregate / distinct / limit bodies (existing body-shape rejects), inline-subquery self-read
(already a positive write via the real base table).
