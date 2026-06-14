description: APPETITE GRANTED (build it — see decision at end of file). Make a flag-less set-op body (a flat `union all` of literal-discriminator legs) writable via predicate-honest branch dispatch — the "projected-attribute idiom" (regular projected columns, the preferred surface over exists-pseudo-columns). Design fully resolved below; ready to emit implement tickets.
prereq:
files: packages/quereus/src/planner/mutation/propagate.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/planner/mutation/set-op.ts, packages/quereus/src/planner/analysis/sat-checker.ts, packages/quereus/src/planner/rules/predicate/rule-filter-contradiction.ts, packages/quereus/src/planner/nodes/project-node.ts, packages/quereus/src/planner/util/fd-utils.ts, packages/quereus/src/planner/nodes/filter.ts, docs/view-updateability.md, docs/sql.md
difficulty: hard
----

## Why this is blocked (the decision the human must make)

The plan pass resolved the technical design (below) and confirmed feasibility. It is parked
here for **one decision only** — the appetite call the ticket flagged — because it has no
defensible default:

> **Do we want a flat `union all` of literal-discriminator legs to be *writable* by
> predicate-honest branch dispatch, given the membership-column path already serves the
> nested/flagged spelling of set-op writes?**

This re-opens, in part, a decision the engine made deliberately: membership columns
(`set-op-membership-write`) *replaced* predicate-honest routing-tag dispatch, and the
`quereus.update.*` routing-tag surface was *removed* (`remove-update-routing-tag-surface`).
`docs/view-updateability.md` frames the projected-attribute path as "the reuse-aligned
alternative" but repeatedly notes the membership path already covers the use case, and the
sibling product-coordinate merge ships "only if a use case needs writable membership over a
non-literal σ-guard". The dev's original redirect — *"explore if we can accomplish the same
thing using projected attributes, since this would add to the predicate"* — is an **explore**
directive, not a build commitment. So the plan stage will not emit an implement ticket on a
guess.

**What the human needs to weigh** (everything else is settled):

- **For building it.** It is the engine's foundational predicate-rules idiom (Bancilhon–Spyratos;
  § "Philosophy: Predicates Rule") applied to *plain* SQL: the discriminator is an ordinary
  column read by ordinary predicates, with **no bespoke `exists … as <flag>` syntax**. It reuses
  the entire membership substrate (capture, recursive `propagate`, fan-out). It is the spelling a
  user reaches for without knowing the membership-column feature exists.
- **Against building it.** It is functionally redundant with membership columns for the same
  end (route writes per branch). It is not free: the "literal discriminators fall out for free"
  premise is **false as the FD framework stands today** (see Finding 4) — it needs either a
  localized AST read of leg literals or a real FD-framework enhancement. It widens the set-op
  write surface to a second recognizer/dispatch the reviewer and future maintainers must hold.

**Recommended resolution (if the human says go):** build it, **sharing the membership substrate**,
and close the FD gap with the **localized** option (read each leg's literal-discriminator
projections directly in the flag-less dispatch — Finding 4, Option B) rather than the broad
FD-framework change, unless the dev also wants projected-literal constant bindings for the
optimizer at large. Scope to the **honest fan-out** (insert/delete/data-update); keep
discriminators read-only (Finding 5). On a "no", move this file to `backlog/` (or delete) and the
membership path remains the single set-op write surface.

When unblocked with a "go", promote back to `plan/` (or straight to `implement/`): the
"Implement plan (ready to promote)" section below is the implement ticket body, edge cases
included.

## Use case

```sql
create view U as
  select id, x, 'red'   as kind, 'A' as src from A where color = 'red'
    union all
  select id, x, 'red'   as kind, 'B' as src from B where color = 'red'
    union all
  select id, x, 'large' as kind, 'A' as src from A where size  = 'large'
    union all
  select id, x, 'large' as kind, 'B' as src from B where size  = 'large';
```

`kind` / `src` are projected literals read by ordinary predicates (`select … from U where
src = 'A'`). The intent is that writes route by them:
`insert into U (id, x, kind, src) values (…, 'red', 'B')` lands in `B where color='red'`;
`delete from U where kind = 'large'` fans out to every leg whose σ is consistent.

## Findings from the plan-pass research (design is resolved on these)

**Finding 1 — the membership substrate is the reuse target and is mature.**
`planner/mutation/set-op.ts` `buildSetOpWrite` already implements predicate-honest per-branch
fan-out, gated on the presence of `exists … as <flag>` membership columns. Its substrate is
discriminator-agnostic:
- Up-front Halloween-safe capture `Project_{all view cols}(Filter_{userWhere}(setOpRoot))`
  materialized once into `__vmupd_keys` (`buildSetOpCapture`).
- Each branch is treated as its own view body and lowered through a **recursive `propagate`**
  against a synthetic branch view-like (`buildBranch` → `SetOpBranch.view`), so each leg's own
  σ, renames and base routing are honored by its own single-source spine.
- Data-column UPDATE fan-out (`fanBranchDataUpdate`), DELETE fan-out (`fanBranchDelete`),
  insert-through routing (`buildInsertThrough`), nested subtrees, left-wrap unwrap.
- Wired into the plan via `view-mutation-builder.ts` `buildSetOpMutation` (lines 524-533), which
  rides the existing `ViewMutationNode.identityCapture` side-input — **no new runtime substrate**.

The flag-less path is "the same fan-out, but the branch oracle is the leg's σ/literal predicate
instead of a runtime membership probe." It shares the capture, the recursive `propagate`, and the
fan helpers almost verbatim.

**Finding 2 — flag-less bodies reject today at two precise points (the hook sites).**
- `propagate` (`propagate.ts:256-264`): the explicit set-op guard fires **only** when
  `compound.existence?.length > 0`; a flag-less body falls through to the single-source spine and
  rejects `unsupported-set-op`. The inline comment already says "A plain (flag-less) set-op body
  is NOT intercepted — it falls through … and rejects `unsupported-set-op` as before".
- `view-mutation-builder.ts:99-101`: intercepts **only** `isSetOpMembershipBody(view.selectAst)`.
  A flag-less body is not intercepted here.

The new dispatch hooks in at `view-mutation-builder.ts` next to the membership check, gated on a
new `isSetOpFlaglessWritableBody(view.selectAst)` recognizer (a flag-less, non-`diff` compound of
plain-column-or-literal legs, no outer LIMIT/OFFSET — the flag-less shadow of
`isSetOpBranchWritable`).

**Finding 3 — branch-consistency machinery exists and maps cleanly onto § "Branch Consistency".**
`planner/analysis/sat-checker.ts` `checkSatisfiability(conjuncts, domains, bindings, attrIndex,
getCollation?)` returns `'sat' | 'unsat' | 'unknown'` and never emits a false `unsat`. That is
exactly the trichotomy the design wants: **`unsat` ⇒ skip the leg, `sat` ⇒ fan, `unknown` ⇒
include (honest fan-out over silent suppression).** It already understands `=`/`!=`/`<`/`<=`/`>`/
`>=`/`BETWEEN`/`IN`-list against literals + domain + constant bindings; everything else marks the
touched columns `sawUnknown` (→ `unknown`, the safe include). The leg's accumulated σ predicate is
available from the planned branch body's `FilterNode` chain (the same body `buildBranch` already
plans). `rule-filter-contradiction` is its existing caller — reuse the function, do not re-author
the reasoning.

**Finding 4 — LOAD-BEARING, and FALSE as built: a projected literal does NOT emit a constant FD.**
The ticket flagged this as unconfirmed. Confirmed: it is **not** emitted.
- `ProjectNode.computePhysical` (`project-node.ts:321`) computes
  `projectConstantBindings(sourcePhysical?.constantBindings ?? [], map)` — it only *forwards* the
  child's existing bindings through the source→output column `map`. A pure literal projection
  (`'red' as kind`) has **no source attribute** in `map`, so no binding is synthesized for the
  output column. There is no code path that says "output column K is bound to literal v because its
  projection expression is the literal v."
- By contrast `where color='red'` **does** emit `∅ → color = 'red'` (a constant binding + FD) via
  `FilterNode.computePhysical` / `fd-utils.ts` `extractEqualityFds` (the `lIsCol && rConst` branch,
  ~`fd-utils.ts:1040`). So the **omitted-base-column recovery on insert works** (the existing
  constant-FD insert-defaulting reads the `where`-derived FD; § Projection insert rule). It is only
  the **routing discriminator** (`kind='red'` proving leg-consistency) that does not fall out free.

Consequence: routing an insert/delete *by* a projected-literal discriminator needs one of:
- **Option A (FD-framework enhancement):** make `ProjectNode.computePhysical` emit a constant
  binding (and `∅ → out` FD) for a projection whose expression is a compile-time constant
  (`LiteralNode`, peeling Cast/Collate — reuse `constantValueOf` from `fd-utils.ts`). This is a
  *general* improvement (sat-checker, join-elimination, filter-contradiction all benefit) but
  touches a hot, well-tested physical-property path and needs its own FD-soundness review (it must
  be `kind:'determination'`, never claimed as a key — same posture as the `where`-pin FD).
- **Option B (localized, RECOMMENDED for first cut):** the flag-less dispatch reads each leg's
  literal-discriminator projections directly from the leg AST (a projection `rc.expr.type ===
  'literal'` aliased to a view column), building the per-leg discriminator map itself and feeding
  those as `bindings` into `checkSatisfiability` alongside the leg's σ conjuncts. No physical-path
  change; the reasoning stays inside the mutation module, mirroring how the membership path already
  reads leg ASTs (`branchColumnNames`/`tryBranchColumnNames`). Lower blast radius; does not improve
  the optimizer broadly.

Either way, the "for free" framing in the original ticket is **wrong** and must not survive into
the implement ticket. Pick Option B unless the dev wants the optimizer-wide win of Option A.

**Finding 5 — discriminator columns must stay read-only (not directly assignable).**
A projected literal is `computed` lineage (`classifyProjectionExpr` → `{kind:'computed'}` for any
non-column expr; `scalar-invertibility.ts:167`), so `update U set kind = …` already surfaces
`no-inverse` through the normal lineage walk and needs no special handling. "Moving a row between
legs" is expressed by INSERT+DELETE, never by assigning the discriminator. This is the deliberate
read-only-discriminator posture; document it as a boundary (distinct from the membership-flag flip,
which *is* writable because a flag carries an `existence` site).

## Implement plan (ready to promote on sign-off)

> Promote this whole section as the body of `tickets/implement/set-op-flagless-predicate-honest-writes.md`
> once the appetite is signed off. It is sized to one agent run **if** Option B is chosen; if the
> dev picks Option A, split the FD-framework change into a prereq-chained
> `project-node-projected-literal-constant-fd` implement ticket first.

### Architecture

A flag-less `union [all]` / `intersect` / `except` body becomes writable for INSERT (existence-
predicate dispatch), DELETE (fan-out to consistent legs), and UPDATE of *data* columns (fan-out),
by **reusing the membership substrate** with a different per-leg branch oracle:

```
view-mutation-builder.buildViewMutation
  ├─ isSetOpMembershipBody?      → buildSetOpMutation  (existing; runtime probe oracle)
  └─ isSetOpFlaglessWritableBody? → buildSetOpMutation  (new; σ/literal-predicate oracle)   ← add
```

The fan, capture, and recursion are the membership path's. The differences are exactly:
- **No `__vmupd_keys` membership-probe flags** in the capture (there are no flags). The capture is
  `Project_{data cols}(Filter_{userWhere}(setOpRoot))` — data columns only.
- **Branch eligibility** is decided at *plan time* per leg by `checkSatisfiability` over
  (leg σ conjuncts ∧ leg literal-discriminator bindings ∧ the mutation's predicate):
  - INSERT: existence predicate = `∧ ci = vi` over supplied values; a leg is a target iff
    consistent (`!= unsat`). Omitted base columns recovered by the existing `where`-constant FD
    insert-defaulting (Finding 4 — that half already works).
  - DELETE / data-UPDATE: the user `where` ∧ leg σ; fan to every consistent (`!= unsat`) leg,
    skip `unsat` legs, include `unknown` legs. The member-exists capture correlation restricts each
    leg op to its resident rows exactly as the membership path's `buildMemberExists` does (minus the
    flag gate).
- **Insert source** may be VALUES (literal existence predicate) — match the membership path's VALUES
  restriction in v1; a SELECT/DML source's per-row routing is deferred with a clean diagnostic.

### TODO

- Add `isSetOpFlaglessWritableBody(selectAst)` to `set-op.ts` — flag-less, non-`diff` compound, no
  outer LIMIT/OFFSET, every leg a plain-column-or-literal projection (the flag-less shadow of
  `isSetOpBranchWritable`/`tryBranchColumnNames`, admitting literal projections as
  discriminators).
- Add the dispatch branch in `view-mutation-builder.ts` next to line 99 (reuse `buildSetOpMutation`,
  or factor a shared `buildSetOpMutationCore` taking the per-leg oracle).
- Implement Option B: per-leg discriminator-binding extraction from leg ASTs, fed with leg σ into
  `checkSatisfiability` (`sat-checker.ts`) to classify each leg sat/unsat/unknown for the given
  mutation predicate. (Option A instead: emit projected-literal constant bindings in
  `project-node.ts` — separate prereq ticket.)
- INSERT: build per-target-leg base ops over the consistent legs; lower each through `propagate`
  against the synthetic branch view-like (reuse `buildBranch`); rely on the existing `where`-constant
  FD insert-defaulting for omitted base columns.
- DELETE / data-UPDATE: reuse `fanBranchDelete` / `fanBranchDataUpdate` with the σ-consistency gate
  replacing the membership-flag gate; share the one up-front (flag-less) capture.
- Discriminator write rejection: confirm `update U set kind = …` surfaces `no-inverse` via the
  normal lineage walk; add a targeted test (no new code expected — Finding 5).
- Static surfaces: extend `view_info` / `column_info` to report the flag-less writable shape
  (`is_insertable_into` / `is_deletable` / data-col `is_updatable` = YES; discriminator
  `is_updatable` = NO), gated on `isSetOpFlaglessWritableBody`. Keep all-`NO` for the rejected
  boundary cases below. Mirror `set-op.ts`'s static-surface gating discipline so the static and
  dynamic answers cannot drift.
- Docs: rewrite the `set-op-flagless-predicate-honest-writes` paragraph in
  `docs/view-updateability.md` (§ Set-operation membership writes, ~lines 561-563 and the § Union
  All / Intersect / Except aspirational blocks) to describe the **shipped** flag-less path, the
  read-only-discriminator boundary, and the σ-consistency oracle. Note in `docs/sql.md` that a
  flat literal-discriminator `union all` is writable. **Correct the "falls out for free" claim** —
  state that the discriminator routing uses the chosen Option (A/B), and that only the
  `where`-constant omitted-column recovery is pre-existing.

### Edge cases & interactions (tests up front)

- **Literal discriminator drives routing.** `insert into U (id,x,kind,src) values (1,9,'red','B')`
  → exactly the `B where color='red'` leg; assert the other three legs are skipped (the `kind='large'`
  and `src='A'` legs are `unsat`). `insert … 'large','A'` → only the `A where size='large'` leg.
- **Omitted base column recovered.** The insert above omits `color`/`size`; assert the `where
  color='red'` constant FD supplies it (this half is pre-existing — guards against a regression that
  the flag-less path bypasses the single-source insert-defaulting).
- **Provably-inconsistent skip vs unknown include.** A leg with a literal σ contradicting the
  predicate is skipped; a leg with a σ the sat-checker can't decide (function call, correlated,
  OR-tree, `LIKE`) is **included** (honest fan-out). Assert both, and assert no false `unsat` ever
  drops a leg.
- **DELETE / data-UPDATE fan-out.** `delete from U where kind='large'` removes from both `size='large'`
  legs (A and B), leaves the `kind='red'` legs; `update U set x = x+1 where src='A'` fans to the two
  `src='A'` legs only.
- **Discriminator not assignable.** `update U set kind='large' where …` → `no-inverse` (NOT silently
  routed); `update U set src='B'` likewise.
- **`union all` bag identity.** Duplicate data tuples in a leg fan a delete/data-update to all copies
  (the same v1 limitation the membership path documents; a count variant stays deferred — document,
  don't fix).
- **Non-literal / σ-guard-only leg.** A leg discriminating purely by a non-literal σ (no projected
  literal, e.g. `where f(color)`) routes by "include on unknown" but cannot recover omitted base
  columns on insert — characterize and document (matches the FD framework's existing boundary).
- **Mixed shapes / rejections.** Outer LIMIT/OFFSET on the compound → reject (`unsupported-limit`,
  a write would escape the window — parity with `analyzeSetOpView`); a `select *` or computed
  (non-literal, non-column) leg → reject; a SELECT-source insert → `unsupported-source` (v1 VALUES
  only). RETURNING through the flag-less write → reject (parity with the membership path).
- **Coexistence with membership writes.** A body with `exists … as <flag>` still routes to the
  membership path; only a genuinely flag-less body takes the new path. Assert a flagged body's plan
  is byte-unchanged, and that the two recognizers are mutually exclusive.
- **`intersect` / `except` semantics.** `intersect`: insert fans to every leg (else the row is not in
  the view), delete fans to every leg by default; `except` (`A except B`): insert into the left,
  delete from the left by default — assert these match § Intersect / § Except.
- **Static-surface agreement.** `view_info`/`column_info` for a flag-less writable body report the
  writable shape; for each rejected boundary body they report all-`NO`, agreeing with the dynamic
  reject (no over-claim from "it's a set-op" alone).

## End

---

## Appetite check (2026-06-13, human sign-off): BUILD IT — regular columns are the preferred surface

Greenlit. The dev confirmed this is the regular-projected-columns approach their
6.4 redirect asked for (`'red' as kind`, ordinary columns that feed the
predicate), as opposed to the `exists`-pseudo-column spelling — and explicitly
prefers regular columns over `exists` pseudo-columns. So:

- **Build the flag-less predicate-honest write path** (INSERT / DELETE / UPDATE-
  of-data via the existing sat-checker / FD branch-consistency pipeline). This is
  the "Predicates Rule" idiom applied to plain set-op bodies, not the shelved
  product-coordinate novelty.
- **Coexist-vs-unify steer:** regular columns are the **preferred** surface going
  forward. Do **not** retire the shipped `exists`-membership write path (6.1)
  preemptively — let the two coexist while the regular-column path proves out
  (they share the `__vmupd_keys` Halloween-safe capture and per-branch recursive
  `propagate`, so unification stays open). Whether/when to deprecate the
  `exists`-pseudo-column spelling in favor of regular columns is a deliberate
  follow-up once this lands, not part of this ticket. Weight the design toward
  regular-columns-primary.
- The plan pass still owns: confirming the FD framework emits a constant FD from
  a **projected literal** (not only a `where col=const` predicate) — load-bearing
  for insert default recovery — and the non-literal / `unknown`-σ honest-fan-out
  characterization already noted.
