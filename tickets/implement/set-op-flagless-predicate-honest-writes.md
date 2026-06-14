description: Make a flag-less set-op body (a flat `union all` of literal-discriminator legs) writable via predicate-honest branch dispatch — the regular-projected-column idiom (`'red' as kind`, ordinary columns read by ordinary predicates), the preferred surface over `exists`-pseudo-column membership writes. Reuses the membership substrate (capture + recursive `propagate` + fan helpers); the per-leg branch oracle is the leg's σ + literal-discriminator predicate via `checkSatisfiability` instead of a runtime membership probe. FD gap closed with the localized Option B (read leg-AST literal discriminators directly — projected literals do NOT emit a constant FD, verified). Coexists with the shipped `exists`-membership path; no unification this pass.
prereq:
files: packages/quereus/src/planner/mutation/set-op.ts, packages/quereus/src/planner/mutation/propagate.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/planner/analysis/sat-checker.ts, packages/quereus/src/planner/nodes/filter.ts, packages/quereus/src/func/builtins/schema.ts, docs/view-updateability.md, docs/sql.md
difficulty: hard
----

## Context (verified against live code in the plan pass)

The human greenlit this build (appetite check, 2026-06-13): regular projected columns are the
**preferred** write surface going forward; the shipped `exists`-membership path (`set-op-membership-write`)
is **not** to be retired — the two coexist this pass, sharing the `__vmupd_keys` Halloween-safe
capture and per-branch recursive `propagate`, so unification stays open as a deliberate follow-up.

All five plan-pass findings were re-verified against the current tree before this ticket was emitted:

- **Hook sites (Finding 2) confirmed.** `propagate.ts:256-264` fires its set-op guard **only** when
  `compound.existence.length > 0`; a flag-less body falls through to the single-source spine and
  rejects `unsupported-set-op`. `view-mutation-builder.ts:99-101` intercepts **only**
  `isSetOpMembershipBody(view.selectAst)`. These are the two interception points.
- **FD behaviour (Finding 4) confirmed FALSE-as-feared and is the reason Option B is chosen.**
  `ProjectNode.computePhysical` (`project-node.ts:326`) calls `projectConstantBindings`
  (`fd-utils.ts:1779`), which only *forwards* the child's existing bindings through the source→output
  column `map`. A pure-literal projection (`'red' as kind`) has **no source attribute** in `map`, so
  **no constant binding is synthesized** for the output column. (Corroborated by the aggregate-node
  comment "aggregate-output columns get none — they are computed expressions, not in the
  column-mapping", and by `tryBranchColumnNames`, which today *rejects* `rc.expr.type !== 'column'`.)
  By contrast `where color='red'` DOES emit `∅ → color='red'` (a constant binding + FD) via
  `FilterNode.computePhysical` / `extractEqualityFds`, so omitted-base-column **insert defaulting
  already works** off the `where`-derived FD. **Only the routing discriminator (`kind='red'` proving
  leg-consistency) does not fall out free** — hence the localized Option B below. The "falls out for
  free" framing of the original ticket is wrong and must not survive into the docs (see TODO).
- **Branch-consistency oracle (Finding 3) confirmed.** `checkSatisfiability(conjuncts, domains,
  bindings, attrIndex, getCollation?)` (`sat-checker.ts:85`) returns `'sat' | 'unsat' | 'unknown'`
  and **never a false `unsat`**. The unit test `binding x=5 ∧ x=7 → unsat`
  (`predicate-contradiction.spec.ts`) is exactly the routing reasoning Option B needs: feed each leg's
  literal-discriminator bindings as `bindings` and the leg σ ∧ mutation predicate as `conjuncts`;
  `unsat ⇒ skip the leg, sat ⇒ fan, unknown ⇒ include` (honest fan-out over silent suppression).
  `rule-filter-contradiction.ts` is its existing caller — reuse the function, do not re-author the
  reasoning. (Note compound-op naming in the AST: `'union' | 'unionAll' | 'intersect' | 'except' |
  'diff'`; `'diff'` is excluded throughout.)
- **Discriminator read-only posture (Finding 5) confirmed.** A projected literal is `computed`
  lineage, so `update U set kind = …` already surfaces `no-inverse` through the normal lineage walk —
  no special handling, just a test.

## Architecture

A flag-less `union [all]` / `intersect` / `except` body becomes writable for INSERT (existence-
predicate dispatch), DELETE (fan-out to consistent legs), and UPDATE of *data* columns (fan-out), by
**reusing the membership substrate** (`set-op.ts` `buildSetOpWrite` / `buildSetOpCapture` /
`buildBranch` / `fanBranchDelete` / `fanBranchDataUpdate` / `buildInsertThrough`) with a different
per-leg branch oracle:

```
view-mutation-builder.buildViewMutation
  ├─ isSetOpMembershipBody?        → buildSetOpMutation  (existing; runtime membership-probe oracle)
  └─ isSetOpFlaglessWritableBody?  → buildSetOpMutation  (new; σ + literal-discriminator oracle)   ← add
```

The capture, recursive `propagate`, and fan helpers are the membership path's. The differences are
exactly:

- **No `__vmupd_keys` membership-probe flags** in the capture (there are no flags). The capture is
  `Project_{data cols}(Filter_{userWhere}(setOpRoot))` — data columns only.
- **Branch eligibility is decided at plan time per leg** by `checkSatisfiability` over
  (leg σ conjuncts ∧ leg literal-discriminator bindings ∧ the mutation's predicate):
  - INSERT: existence predicate = `∧ cᵢ = vᵢ` over supplied values; a leg is a target iff consistent
    (`!= unsat`). Omitted base columns recovered by the existing `where`-constant FD insert-defaulting
    (already works — Finding 4).
  - DELETE / data-UPDATE: the user `where` ∧ leg σ; fan to every consistent (`!= unsat`) leg, skip
    `unsat` legs, include `unknown` legs. The member-exists capture correlation restricts each leg op
    to its resident rows exactly as the membership path does (minus the flag gate).
- **Insert source is VALUES only in v1** (literal existence predicate), matching the membership path's
  VALUES restriction. A SELECT/DML-source insert's per-row routing is deferred with a clean
  `unsupported-source` diagnostic.

### Option B (localized FD-gap closure — the chosen approach; do NOT do Option A here)

The flag-less dispatch reads each leg's literal-discriminator projections **directly from the leg
AST** (a projection where `rc.expr.type === 'literal'`, peeling Cast/Collate via `constantValueOf`
from `fd-utils.ts`, aliased to a view column), builds the per-leg discriminator binding map itself,
and feeds those as `bindings` into `checkSatisfiability` alongside the leg's σ conjuncts. **No
physical-path change.** The reasoning stays inside the mutation module, mirroring how the membership
path already reads leg ASTs (`branchColumnNames` / `tryBranchColumnNames`). This is lower blast radius
than the FD-framework enhancement (Option A) and does not touch the hot `ProjectNode.computePhysical`
path. If a future dev wants the optimizer-wide win of projected-literal constant bindings, that is a
separate `project-node-projected-literal-constant-fd` ticket — out of scope here.

## TODO

- Add `isSetOpFlaglessWritableBody(selectAst)` to `set-op.ts` — the flag-less shadow of
  `isSetOpBranchWritable`: a flag-less (`!existence?.length`), non-`diff` compound, no outer
  LIMIT/OFFSET, every leg a projection of plain columns **or literals** (admitting literal
  projections as discriminators, unlike `tryBranchColumnNames` which rejects them). Must be mutually
  exclusive with `isSetOpMembershipBody` (a body carrying any `exists … as <flag>` takes the
  membership path).
- Add the dispatch branch in `view-mutation-builder.ts` next to line 99. Reuse `buildSetOpMutation`,
  or factor a shared `buildSetOpMutationCore` taking the per-leg oracle (membership-probe vs σ/literal
  predicate) so the capture, recursive `propagate`, and fan helpers are not duplicated.
- Implement Option B: per-leg literal-discriminator binding extraction from the leg ASTs
  (`constantValueOf`-peeled `LiteralNode` projections), fed with the leg σ conjuncts and the mutation
  predicate into `checkSatisfiability` (`sat-checker.ts`) to classify each leg `sat`/`unsat`/`unknown`.
  Build the `attrIndex` mapper from the planned branch body's attributes (the same body `buildBranch`
  plans) and a `getCollation` from those attributes (mirror `rule-filter-contradiction.ts`).
- Open the matching guard in `propagate.ts:256-264` so a nested / recursively-reached flag-less
  branch body is handled rather than mis-rejecting — parity with the membership guard. (A directly
  reached flag-less body is intercepted in `view-mutation-builder.ts` before `propagate`; the guard
  here catches the recursive `propagate`-on-a-branch case.)
- INSERT: build per-target-leg base ops over the consistent legs; lower each through `propagate`
  against the synthetic branch view-like (reuse `buildBranch`); rely on the existing `where`-constant
  FD insert-defaulting for omitted base columns (do not re-implement it).
- DELETE / data-UPDATE: reuse `fanBranchDelete` / `fanBranchDataUpdate` with the σ-consistency gate
  replacing the membership-flag gate; share the one up-front (flag-less) capture.
- Discriminator write rejection: confirm `update U set kind = …` surfaces `no-inverse` via the normal
  lineage walk; add a targeted test (no new code expected — Finding 5).
- Static surfaces (`func/builtins/schema.ts`): extend `view_info` / `column_info` to report the
  flag-less writable shape (`is_insertable_into` / `is_deletable` / data-col `is_updatable` = YES;
  discriminator `is_updatable` = NO), gated on `isSetOpFlaglessWritableBody` (mirror the existing
  `isSetOpMembershipBody && isSetOpBranchWritable` gating in `deriveViewInfo` / the column_info walk).
  Keep all-`NO` for the rejected boundary cases. Mirror the static-surface gating discipline so the
  static and dynamic answers cannot drift.
- Docs: rewrite the `set-op-flagless-predicate-honest-writes` paragraph in `docs/view-updateability.md`
  (§ Set-operation membership writes, ~lines 561-563, and the § Union All / Intersect / Except
  aspirational blocks) to describe the **shipped** flag-less path, the read-only-discriminator
  boundary, the σ-consistency oracle, and that it **coexists** with (is the preferred surface over)
  the `exists`-membership path. Note in `docs/sql.md` that a flat literal-discriminator `union all` is
  writable. **Correct the "falls out for free" claim**: state that discriminator routing uses Option B
  (localized leg-AST read of literal projections), and that only the `where`-constant omitted-column
  recovery is pre-existing — projected literals do **not** emit a constant FD today.

## Edge cases & interactions (tests up front)

- **Literal discriminator drives routing.** `insert into U (id,x,kind,src) values (1,9,'red','B')` →
  exactly the `B where color='red'` leg; assert the other three legs are skipped (`kind='large'` and
  `src='A'` legs are `unsat`). `insert … 'large','A'` → only the `A where size='large'` leg.
- **Omitted base column recovered.** The insert above omits `color`/`size`; assert the
  `where color='red'` constant FD supplies it (this half is pre-existing — guards against a regression
  where the flag-less path bypasses the single-source insert-defaulting).
- **Provably-inconsistent skip vs unknown include.** A leg with a literal σ contradicting the
  predicate is skipped; a leg with a σ the sat-checker can't decide (function call, correlated,
  OR-tree, `LIKE`) is **included** (honest fan-out). Assert both, and assert **no false `unsat`** ever
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
- **Mixed shapes / rejections.** Outer LIMIT/OFFSET on the compound → reject (`unsupported-limit`, a
  write would escape the window — parity with `analyzeSetOpView`); a `select *` or computed
  (non-literal, non-column) leg → reject; a SELECT-source insert → `unsupported-source` (v1 VALUES
  only). RETURNING through the flag-less write → reject (parity with the membership path).
- **Coexistence with membership writes.** A body with `exists … as <flag>` still routes to the
  membership path; only a genuinely flag-less body takes the new path. Assert a flagged body's plan is
  byte-unchanged, and that the two recognizers (`isSetOpMembershipBody` /
  `isSetOpFlaglessWritableBody`) are mutually exclusive.
- **`intersect` / `except` semantics.** `intersect`: insert fans to every leg (else the row is not in
  the view), delete fans to every leg by default; `except` (`A except B`): insert into the left,
  delete from the left by default — assert these match § Intersect / § Except.
- **Static-surface agreement.** `view_info` / `column_info` for a flag-less writable body report the
  writable shape; for each rejected boundary body they report all-`NO`, agreeing with the dynamic
  reject (no over-claim from "it's a set-op" alone).

## Validation

- `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/setop.log; tail -n 80 /tmp/setop.log` (memory
  vtab; the default). Add `.sqllogic` coverage under `test/logic/` for the routing/fan/reject cases
  above and unit coverage where a `checkSatisfiability` classification needs pinning.
- `yarn workspace @quereus/quereus lint` (eslint + `tsc -p tsconfig.test.json`; single-quote globs on
  Windows). Do not run `test:store` / `test:full` inside the ticket (store path is slower and not
  exercised by this change).
