description: Compose INSERT-through into a multi-source (INNER join) leg/branch of a set-op view write by splicing a per-leg shared-surrogate envelope (`buildMultiSourceInsert`) as a nested `ViewMutationNode` child of the outer set-op write node. Lifts the three clean `set-op-write-multisource-leg-insert` deferrals (membership `set <flag>=true`, flag-less consistent-leg INSERT, VALUES insert-through) and flips `is_insertable_into` to YES for a body whose join legs are all insertable.
prereq:
files: packages/quereus/src/planner/mutation/set-op.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/func/builtins/schema.ts, packages/quereus/src/core/database.ts, packages/quereus/src/planner/nodes/view-mutation-node.ts, packages/quereus/src/runtime/emit/view-mutation.ts, docs/view-updateability.md, packages/quereus/test/logic/93.4-view-mutation.sqllogic, packages/quereus/test/logic/93.6-set-op-flagless-write.sqllogic
difficulty: hard
----

## Background

`set-op-write-multisource-leg-compose` (complete) made an INNER-join leg/branch of a set-op view
writable for UPDATE / DELETE / membership-`=false` by composing an **inner per-branch base-PK
capture** (`__vmupd_keys$N`) chained off the outer set-op capture. INSERT into a join leg was a
clean deferral because all three insert routes —

- membership `set <flag> = true` (`buildBranchMembershipInsert`),
- a flag-less consistent-leg INSERT (`buildFlaglessInsert`), and
- a VALUES insert-through (`buildInsertThrough`),

— lowered to `propagate(ctx, branchView, {op:'insert'})`, which for a join body raises the internal
`unsupported-multisource-insert` ("must be built via buildMultiSourceInsert"). A multi-source INSERT
is **not** an AST `BaseOp`: it needs the plan-level shared-surrogate envelope
(`analyzeMultiSourceInsert` + `buildMultiSourceInsert`) — a materialized augmented source the sibling
base inserts fan out from, with the shared join key minted from the anchor key column's declared
`default` and threaded via the equivalence class.

## Design resolution — nested-splice (the core design question, resolved)

The set-op fan builds AST `BaseOp[]` that `buildSetOpMutation` re-plans under the injected captures;
`buildMultiSourceInsert` produces a whole `PlanNode` (an envelope-backed `ViewMutationNode`), not a
`BaseOp`. Resolution: **route each active join leg's insert to `buildMultiSourceInsert` and splice
its `ViewMutationNode` into the outer set-op `ViewMutationNode.baseOps` as a child PlanNode** (Route
B — nested splice). Rationale, verified against the substrate:

- `ViewMutationNode.baseOps` is `readonly PlanNode[]`; the runtime emitter (`emitViewMutation`)
  emits each via `emitCallFromPlan(op, ctx)` (a self-contained sub-program) and drains it
  sequentially. A child that is itself a `ViewMutationNode` runs its own sub-program — materializing
  its own envelope into `rctx.tableContexts` under its own fresh `descriptor: {}` and tearing it down
  in its own `finally` — so two join legs never collide (distinct identity descriptors) and the
  outer node's optional capture is untouched.
- An envelope per join leg, sourced from the supplied row. For insert-through / flag-less VALUES the
  envelope source is self-contained (no outer capture). For the membership `set <flag>=true` flip the
  envelope source is the existing `from __vmupd_keys k where not k.<flag>` SELECT — it reads the
  **outer** set-op capture, which the outer `ViewMutationNode` materializes first (its
  `identityCapture`) and the nested child reads back via the shared `rctx`. Passing the
  capture-injected `opCtx` (already built in `buildSetOpMutation`) to `buildMultiSourceInsert` makes
  the nested envelope source's `from __vmupd_keys` resolve.
- The single `ViewMutationNode.envelope` slot stays the OUTER node's (always undefined for a set-op
  write); each nested join-leg insert carries its OWN envelope. No new `ViewMutationNode` field is
  needed for the nested-insert case (it reuses `baseOps`). `nestedCaptures` is unrelated and unchanged.

The alternative (carrying per-leg envelope sub-plans the outer node sequences) has the same
observable contract but would add a new `ViewMutationNode` field and emitter branch; the nested
splice reuses `baseOps` + `emitCallFromPlan` verbatim, so it is the chosen route.

### Seam / layering

`set-op.ts` (planner/mutation) cannot call `buildMultiSourceInsert` (planner/building) without a
layering inversion. So the **building layer** performs the splice: the set-op insert builders record
a per-leg descriptor; `buildSetOpMutation` (which lives beside `buildMultiSourceInsert`) turns each
descriptor into a nested `ViewMutationNode`.

New carrier on the write plan (set-op.ts):

```ts
/** One active join-leg INSERT to build via the shared-surrogate envelope and splice as a
 *  nested ViewMutationNode child of the outer set-op write node. */
export interface JoinLegInsert {
	readonly view: MutableViewLike;     // the synthetic `__setop_*` / `__setop_legN` join-leg view-like
	readonly stmt: AST.InsertStmt;      // the per-leg insert (VALUES self-contained, or a SELECT over `__vmupd_keys`)
}

export interface SetOpWritePlan {
	readonly baseOps: BaseOp[];
	readonly capture?: MultiSourceKeyCapture;
	readonly nestedCaptures?: MultiSourceKeyCapture[];
	readonly joinLegInserts?: JoinLegInsert[];   // NEW — built into nested envelopes by buildSetOpMutation
}
```

Consumer (`buildSetOpMutation`, view-mutation-builder.ts):

```ts
const { baseOps, capture, nestedCaptures, joinLegInserts } = writeFn(ctx, view, req);
let opCtx = capture ? withKeyCapture(ctx, capture) : ctx;
for (const inner of nestedCaptures ?? []) opCtx = withKeyCapture(opCtx, inner);
const children = baseOps.map(op => buildBaseOp(opCtx, op, [], false));
// Splice each active join-leg insert as a nested envelope-backed ViewMutationNode child. Pass
// opCtx (capture-injected) so a membership-flip leg's `from __vmupd_keys` source resolves.
for (const jli of joinLegInserts ?? []) children.push(buildMultiSourceInsert(opCtx, jli.view, jli.stmt));
// ... identityCapture / nested side inputs unchanged.
```

`buildMultiSourceInsert` is a function declaration later in the same file (hoisted ⇒ callable). It
records no view dependency (that happens once in `buildViewMutation`), so calling it on a synthetic
branch view is safe.

### Lifting the three reject sites (set-op.ts)

Replace each `branch.isMultiSource` / `analysis.branches.some(b => b.isMultiSource)` *reject* with a
descriptor push. The synthetic `InsertStmt` is the SAME one each route already builds for the plain
(non-join) leg propagate path — only the routing changes (record a descriptor instead of
`propagate`).

- **`buildInsertThrough`** (membership VALUES route): drop the up-front
  `analysis.branches.some(b => b.isMultiSource)` reject. In the per-branch loop, when
  `branch.isMultiSource`, push `{ view: branch.view, stmt: insertStmt }` (the VALUES insert already
  built at the loop body) to a local `joinLegInserts` instead of `propagate`. Self-contained (no
  capture). Return `{ baseOps, joinLegInserts: joinLegInserts.length ? joinLegInserts : undefined }`.
- **`buildFlaglessInsert`**: drop the up-front `legs.some(l => l.branch.isMultiSource)` reject. In
  the per-leg loop, when `leg.branch.isMultiSource`, push the per-leg insert (the one built at
  lines ~1870–1879, targeting `leg.branch.view.name` with the supplied plain columns) to
  `joinLegInserts` instead of `propagate`. Adjust the final `baseOps.length === 0` "no writable leg"
  guard to also pass when `joinLegInserts.length > 0`.
- **`buildBranchMembershipInsert`** (`set <flag>=true` flip): drop the `branch.isMultiSource` reject.
  Thread a `joinLegInserts: JoinLegInsert[]` accumulator from `buildUpdate` into this function (mirror
  the `fan` threading). When `branch.isMultiSource`, push `{ view: branch.view, stmt: insertStmt }`
  (the existing `from __vmupd_keys k where not k.<flag>` SELECT-sourced insert — composed data
  assignments already folded into its projection via `qualifyDataRefsWithCapture`) and return `[]`
  (no BaseOps). `buildUpdate` returns `joinLegInserts` on its `SetOpWritePlan`. The outer capture is
  already built for every UPDATE, so `opCtx` carries `__vmupd_keys` for the nested envelope source.

A nested (subtree) operand insert stays the `set-op-membership-nested` reject (it never sets
`isMultiSource`; `isNested` and `isMultiSource` are mutually exclusive). An OUTER (left/right/full) /
cross join leg is still rejected at `buildBranch` classification (membership) or falls out of the
flag-less route (`isWritableLeafLeg`).

### Static surface flip (schema.ts) — reuse the dynamic analysis (exact match)

`is_insertable_into` must match the dynamic accept/reject **exactly per shape**. A purely structural
inner-vs-outer predicate is **insufficient**: an inner equi-join leg can still reject dynamically
with `unsupported-decomposition-key` (composite shared key — the CV shape), `unsupported-join`
(non-equi ON), or `no-default` (the shared key is neither supplied nor defaulted — e.g. the SJ
self-join, whose anchor key `emp.mgr` has no default). So the static probe **reuses the dynamic
insertability analysis** in a try/catch.

Add an exported probe to set-op.ts:

```ts
/** True iff EVERY multi-source (INNER join) leg of this set-op body would accept an implicit
 *  INSERT through the shared-surrogate envelope. Re-derives the branches (via analyzeSetOpView /
 *  analyzeFlaglessSetOpView — the same dynamic entry) and probes each `isMultiSource` leg with
 *  `analyzeMultiSourceInsert` under a synthetic implicit (empty-column) InsertStmt, in try/catch:
 *  a leg that throws (composite key, non-equi, no-default, uncovered NOT NULL, …) ⇒ false. A body
 *  with no join leg returns true (the single-source legs are the existing insert-through path). */
export function setOpJoinLegsInsertable(ctx: PlanningContext, view: MutableViewLike): boolean
```

- It dispatches membership vs flag-less (`isSetOpMembershipBody`) and gets the branch view-likes
  (the `isMultiSource` ones) the same way the write path does. The synthetic stmt is
  `{ type:'insert', table:{type:'identifier', name: branch.view.name}, columns: [], source: {type:'values', values: []}, ... }`
  — empty `columns` ⇒ `analyzeMultiSourceInsert` uses the implicit supply set; an inner join leg has
  no existence columns, so the empty `values` is never read.
- It is only ever reached after `isSetOpBranchWritable` / `isSetOpFlaglessWritableBody` already
  passed (an outer-join branch / non-flagless body short-circuits to the conservative all-`NO` row
  upstream — never reaching this probe), so `analyzeSetOpView` / `analyzeFlaglessSetOpView` will not
  throw on the body shape; only the per-leg `analyzeMultiSourceInsert` probe may.

`deriveViewInfo` needs a `PlanningContext` for the probe. Add `Database._buildProbeContext()` —
refactor `_buildPlan` to build its `ctx` via this helper (DRY) and return a fresh throwaway ctx
(its `schemaDependencies` are discarded, as the read TVF already discards the body plan's). Wire the
two set-op gates:

```ts
// membership body (~line 792):
const isInsertableInto = !setOpHasSubtreeOperand(view.selectAst)
	&& setOpJoinLegsInsertable(db._buildProbeContext(), viewAsMutable);
// flag-less body (~line 809):
const isInsertableInto = setOpJoinLegsInsertable(db._buildProbeContext(), viewAsMutable);
```

`setOpHasMultiSourceLeg` becomes unused — remove it (and its `operandHasJoinLeg` helper) to stay
DRY, OR keep only if still referenced (grep confirms schema.ts is its sole consumer). `view` here is
a `ViewSchema`; build a `MutableViewLike` (`{ name, schemaName, selectAst }`) the same shape
`deriveBackingShape` / the write path use.

## Edge cases & interactions

- **Single active join leg only** — `baseOps` empty, `children = [nestedViewMutationNode]`. The outer
  `ViewMutationNode` requires ≥1 base op; one nested child satisfies it.
- **Mixed body (one join leg + one plain leg active)** — `children = [plainBaseOp, nestedVMN]`,
  sequenced in fan order. INSERT has no cross-leg FK ordering; both run.
- **Two join legs active in one statement** (insert-through with both flags true into two join
  branches; the `TWO` view shape) — two nested `ViewMutationNode`s, each with a DISTINCT envelope
  descriptor (`{}` identity). Prove no envelope-context collision (the dual of the compose's distinct
  `__vmupd_keys$N`).
- **Membership `set <flag>=true` into a join branch** — the nested envelope source reads the OUTER
  `__vmupd_keys` capture (`where not k.<flag>`), materialized by the outer node first and shared via
  `rctx`. Composed same-statement data assignments (`set x=…, inJoin=true`) flow into the nested
  insert's projection (already via `qualifyDataRefsWithCapture`). A `set <joinFlag>=true` with a
  same-statement `= false` on the other branch is unaffected (the false-flip + data-assignment
  contradiction guard is independent).
- **Composite-PK join leg** (CV) — `extractJoinKeyColumns` rejects `unsupported-decomposition-key`
  (the envelope threads a single-column key). Inherited; static probe ⇒ `is_insertable_into = NO`.
- **No-default shared key** (SJ self-join: key `emp.mgr` neither supplied nor defaulted) — inherited
  `no-default` reject; static probe ⇒ NO.
- **Non-equi inner join leg in a discriminated flag-less body** — dynamic `unsupported-join` (no ON
  equality for `extractJoinKeyColumns`); static probe ⇒ NO. (NEV is a SEPARATE all-`NO` shape: it has
  no literal discriminator, so it is not flag-less-writable at all and never reaches the probe.)
- **Outer (left/right/full) / cross join leg** — membership: `buildBranch` classification reject ⇒
  `isSetOpBranchWritable` false ⇒ conservative all-`NO`. Flag-less: `isWritableLeafLeg` false ⇒ body
  drops out of the flag-less route ⇒ conservative all-`NO`. Neither reaches the probe. (OJV.)
- **`on conflict` / upsert through a join leg** — `stmt.onConflict` already threads into the per-leg
  `InsertStmt` and on through `buildMultiSourceInsert` to each side insert. Confirm a basic
  `insert or ignore` through a join leg behaves (no new gating needed).
- **RETURNING through a set-op insert** — already rejected up-front (`rejectReturning`); unchanged.
- **Halloween / ordering** — insert-through reads no existing state. The membership-flip insert reads
  the FROZEN outer capture (materialized before any base op), so it is Halloween-safe by construction
  (same guarantee as the compose).
- **Filtered join leg** (MV/JV legs carry `where … color='red'`) — `analyzeJoinView` does not consult
  the σ for an insert (it writes base rows); the inserted row need not satisfy the view predicate, as
  with any filtered insert-through. Tests assert base-table contents, not a JV re-read.
- **Probe is non-throwing** — `setOpJoinLegsInsertable` must catch every `analyzeMultiSourceInsert`
  throw and return false; it must not leak a structured diagnostic out of the read TVF.

## Docs

Update `docs/view-updateability.md` § Set Operations (the join-leg-insert deferral sentences, ~L642–646
and ~L680–683) and § Inner Join — Inserts: inner-join-leg INSERT through a set-op view is now SHIPPED
(nested envelope splice); `is_insertable_into = YES` for a body whose join legs are all insertable
(NO for an outer-join / composite-key / no-default leg or a subtree operand). Keep the wording timeless.

## Tests / validation

`93.6-set-op-flagless-write.sqllogic`:
- **JV** — flip the insert reject (L306–307) to positive coverage: `insert into JV (id, x, src)
  values (5, 50, 'a')` lands `(5,50,null)` in jv1 and `(5,null)` in jv2 (shared key `id` supplied);
  assert both base tables. Flip `view_info('JV')` (L285) `is_insertable_into` → `YES`.
- **DV** — flip the deep-join-leg insert reject (L343–344): `insert into DV (id, x, src) values
  (9, 90, 'c')` lands in dv1 and dv2. Flip `view_info('DV')` (L330) → `YES`.
- **CV** (composite-PK) — ADD `insert into CV (a, b, v, src) values (9, 9, 90, 'j')` → `-- error:
  unsupported-decomposition-key`. Do NOT add a `view_info('CV')` = YES assertion (the probe reports NO
  — if asserted, assert NO).
- **SJ** — keep `view_info('SJ')` (L386) at `NO` (the probe rejects the no-default self-join key); add
  `insert into SJ (...) values (...)` → `-- error: no-default` to pin the dynamic reject.
- **OJV** / **NEV** — `view_info` stays all-`NO` (unchanged); they never reach the join-leg path.
- A mixed body where insert-through activates one join leg + one plain leg, asserting BOTH land.

`93.4-view-mutation.sqllogic`:
- **MV** (membership) — flip the insert reject (L4020–4021) to positive coverage: `insert into MV
  (id, x, inL, inR) values (5, 50, true, false)` inserts into the join branch's base tables (mj1 gets
  `(5,50,null)`, mj2 gets `(5,null)`; inR=false omits the plain branch). Flip `view_info('MV')`
  (L3997) → `YES`.
- **TWO** (two join branches) — `insert into TWO (id, x, inL, inR) values (7, 70, true, true)` inserts
  into BOTH join branches' base tables (tba+tbc via one nested envelope, tbb+tbd via the other) —
  proves distinct nested envelope descriptors. Flip `view_info('TWO')` (L4044) → `YES`.
- A `set <joinFlag> = true` membership FLIP via UPDATE (reads the outer capture): a captured-absent
  row inserts into the join branch's base tables; a row already present is a clean no-op (`where not
  k.<flag>`).

Run `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/t.log; tail -n 60 /tmp/t.log` and
`yarn workspace @quereus/quereus lint` (single-quote globs on Windows). Any pre-existing unrelated
failure → `tickets/.pre-existing-error.md` per the runner rules; do not chase it here.

## Out of scope

- OUTER (left/right/full) / cross / non-equi join legs (a separate compose deferral — they reject
  cleanly at classification today).
- Composite shared-key insert envelope (stays `unsupported-decomposition-key`).
- A SELECT/DML-source set-op insert-through into a join leg beyond what `buildMultiSourceInsert`
  already supports (VALUES + SELECT envelope sources).

## TODO

Phase 1 — dynamic splice (set-op.ts + view-mutation-builder.ts)
- Add `JoinLegInsert` interface + `joinLegInserts?` on `SetOpWritePlan` (set-op.ts).
- `buildInsertThrough`: drop the multi-source reject; push the per-branch VALUES insert to
  `joinLegInserts` when `branch.isMultiSource`.
- `buildFlaglessInsert`: drop the multi-source reject; push the per-leg insert to `joinLegInserts`;
  adjust the empty-`baseOps` guard to also accept a non-empty `joinLegInserts`.
- `buildUpdate` / `buildBranchMembershipInsert`: thread a `joinLegInserts` accumulator; push the
  `from __vmupd_keys`-sourced insert for a `set <joinFlag>=true` flip; return it on the plan.
- `buildSetOpMutation`: build each `joinLegInserts` entry via `buildMultiSourceInsert(opCtx, …)` and
  append to `children`.

Phase 2 — static surface (schema.ts + database.ts)
- Add `setOpJoinLegsInsertable(ctx, view)` to set-op.ts (try/catch over `analyzeMultiSourceInsert`
  per `isMultiSource` leg).
- Add `Database._buildProbeContext()` (refactor `_buildPlan` to use it).
- Wire the membership + flag-less `is_insertable_into` gates to `setOpJoinLegsInsertable`; remove the
  now-unused `setOpHasMultiSourceLeg` (+ `operandHasJoinLeg`).

Phase 3 — docs + tests
- Update `docs/view-updateability.md` (§ Set Operations, § Inner Join — Inserts).
- Flip / add the 93.6 (JV, DV, CV, SJ, mixed) and 93.4 (MV, TWO, membership-flip) cases above.
- `yarn ... test` + `yarn ... lint` green (or `.pre-existing-error.md` for an unrelated failure).
