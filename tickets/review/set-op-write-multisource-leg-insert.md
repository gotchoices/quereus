description: Review the shipped INSERT-through into a multi-source (INNER join) leg/branch of a set-op view write — a per-leg shared-surrogate envelope (`buildMultiSourceInsert`) spliced as a nested `ViewMutationNode` child of the outer set-op write node. Lifts the three clean insert deferrals (membership `set <flag>=true`, flag-less consistent-leg INSERT, VALUES insert-through) and flips `is_insertable_into` to YES for a body whose join legs are all insertable.
files: packages/quereus/src/planner/mutation/set-op.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/func/builtins/schema.ts, packages/quereus/src/core/database.ts, docs/view-updateability.md, packages/quereus/test/logic/93.4-view-mutation.sqllogic, packages/quereus/test/logic/93.6-set-op-flagless-write.sqllogic
difficulty: hard
----

## What shipped

INSERT-through into an INNER-join leg/branch of a set-op view is now supported (was a clean
deferral in `set-op-write-multisource-leg-compose`). The compose ticket made a join leg writable for
UPDATE / DELETE / membership-`=false`; this ticket completes the trio with INSERT.

A multi-source INSERT is **not** an AST `BaseOp` — it needs the plan-level shared-surrogate envelope
(`analyzeMultiSourceInsert` + `buildMultiSourceInsert`). The chosen route (Route B — **nested
splice**, resolved in the plan ticket): each active join leg's insert is routed to
`buildMultiSourceInsert` and the resulting envelope-backed `ViewMutationNode` is spliced as a nested
child of the outer set-op write node's `baseOps`. The runtime emitter already drains each base op via
`emitCallFromPlan` (its own self-contained sub-program), so a nested `ViewMutationNode` materializes
its own envelope under its own fresh identity descriptor and tears it down in its own `finally` — two
join legs never collide, and the outer node's optional capture is untouched.

### Phase 1 — dynamic splice (`set-op.ts` + `view-mutation-builder.ts`)
- New `JoinLegInsert` carrier (`{ view, stmt }`) + `joinLegInserts?` on `SetOpWritePlan`.
- The three reject sites now push a per-leg descriptor instead of `propagate` (which raises the
  internal `unsupported-multisource-insert` for a join body):
  - `buildInsertThrough` (membership VALUES route) — self-contained VALUES source.
  - `buildFlaglessInsert` (flag-less consistent-leg) — self-contained VALUES source; the
    empty-`baseOps` "no writable leg" guard now also passes on a non-empty `joinLegInserts`.
  - `buildBranchMembershipInsert` (`set <flag>=true` flip) — threads a `joinLegInserts` accumulator
    from `buildUpdate`; pushes the existing `from __vmupd_keys k where not k.<flag>` SELECT-sourced
    insert (composed data assignments already folded via `qualifyDataRefsWithCapture`) and returns
    `[]` (no base op of its own).
- `buildSetOpMutation` builds each descriptor via `buildMultiSourceInsert(opCtx, …)` and appends the
  node to `children`. `opCtx` is the capture-injected context, so a membership-flip leg's
  `from __vmupd_keys` envelope source resolves against the OUTER set-op capture (which the outer node
  materializes first as its `identityCapture`, shared via `rctx`). `buildMultiSourceInsert` records no
  view dependency (that happens once in `buildViewMutation`), so building it on a synthetic branch
  view is safe.

### Phase 2 — static surface (`schema.ts` + `database.ts`)
- New `setOpJoinLegsInsertable(ctx, view)` in `set-op.ts`: re-derives the branches the same way the
  write path does (membership via `analyzeSetOpView`, else `analyzeFlaglessSetOpView`) and probes each
  `isMultiSource` leg with `analyzeMultiSourceInsert` under a synthetic implicit (empty-column)
  `InsertStmt`, in try/catch — a leg that throws ⇒ `false`. A structural inner-vs-outer predicate is
  insufficient: an inner equi-join leg can still reject with `unsupported-decomposition-key`
  (composite key), `unsupported-join` (non-equi), `no-default` (key neither supplied nor defaulted),
  or `no-default` for an **uncovered NOT NULL** non-key-side base column.
- New `Database._buildProbeContext()` — extracted from `_buildPlan` (DRY), returns a fresh throwaway
  `PlanningContext` whose `schemaDependencies` are discarded.
- Both `is_insertable_into` gates (membership + flag-less) now call
  `setOpJoinLegsInsertable(db._buildProbeContext(), viewAsMutable)`. Removed the now-unused
  `setOpHasMultiSourceLeg` + `operandHasJoinLeg`.

### Phase 3 — docs + tests
- `docs/view-updateability.md` § Set Operations (both membership + flag-less passages, and the static
  insertability gate) and § Inner Join — Inserts updated: join-leg INSERT is SHIPPED via the nested
  envelope splice; `is_insertable_into = YES` iff every join leg is insertable.

## Use cases to validate (reviewer: treat the tests as a floor)

Dynamic path (all green):
- **JV / DV** (93.6, flag-less) — discriminator routes the VALUES insert into the join leg; shared key
  `id` supplied ⇒ jv1/dv1 + jv2/dv2 both land. View `where color='red'` is NOT consulted on insert.
- **MV** (93.4, membership) — `insert into MV (…, inL, inR) values (5,50,true,false)` lands the join
  branch (mj1+mj2), `inR=false` omits the plain branch.
- **TWO** (93.4) — `insert … values (7,70,true,true)` lands BOTH join branches via TWO distinct nested
  envelope descriptors (proves no envelope-context collision — the insert dual of the compose's
  distinct `__vmupd_keys$N`).
- **MF** (93.4, new fixture) — `set inJ=true` membership FLIP via UPDATE: a captured-absent row
  inserts into the join branch's base tables (nested envelope reads the OUTER `__vmupd_keys`); a row
  already present is a clean no-op (`where not k.inJ`). Halloween-safe (outer capture frozen first).
- **MXV** (93.6, new fixture) — mixed body: a discriminator-omitting INSERT routes to BOTH a join leg
  (nested envelope) and a plain leg (single-source base op); both land in fan order.

Reject path (probe ⇒ NO + dynamic clean reject):
- **CV** (93.6) — composite-PK join leg ⇒ `unsupported-decomposition-key`.
- **SJ** (93.6) — self-join shared key `emp.mgr` neither supplied nor defaulted ⇒ `no-default`.
- **OJV / NEV** (93.6) — outer-join / non-equi-in-non-discriminated body never reach the probe
  (drop out of the writable route upstream) ⇒ conservative all-`NO` (unchanged).

Commands (both green at handoff): `yarn workspace @quereus/quereus test` (6314 passing, 9 pending,
0 failing) and `yarn workspace @quereus/quereus lint` (exit 0). `tsc --noEmit` clean.

## Known gaps / deviations from the plan ticket — REVIEW THESE

1. **Fixture nullability fix (load-bearing).** Quereus treats a bare `integer` column as **NOT NULL**
   (verified: `insert into t(id) values(5)` with `y integer` → `NOT NULL constraint failed: t.y`; the
   test files already write `text null` for nullable columns). The plan ticket's expected results
   (`jv2`/`mj2`/`dv2` get `(5,null)`) therefore required the non-key side's extra column to be
   nullable. Changed `jv2.y` / `dv2.y` / `mj2.y` from `integer` → `integer null`. This is faithful to
   the ticket's intent — it even lists "uncovered NOT NULL ⇒ false" as a probe-reject reason — but the
   reviewer should confirm this is the desired surface (vs. leaving them NOT NULL and reporting the
   join leg non-insertable, which would make JV/MV/DV report `is_insertable_into = NO`). The current
   choice ships the positive INSERT path the ticket asked for.

2. **Error-assertion substrings.** The sqllogic harness matches the error **message** (case-insensitive
   substring), NOT the reason code (`raiseMutationDiagnostic` puts only the human message on
   `Error.message`). So the CV / SJ assertions use message fragments — `composite shared key`
   (the `unsupported-decomposition-key` message) and `neither supplied nor declares a default` (the
   `no-default` message) — rather than the reason-code slugs the plan ticket wrote literally. Behavior
   is identical; only the assertion text differs.

3. **Combined data-fan + join-flip in one UPDATE** (`set x=…, inJoin=true`) is supported by
   construction (nestedCaptures from the data fan + joinLegInserts from the flip coexist on the plan;
   the data assignment folds into the flip's projection via `qualifyDataRefsWithCapture`) but has **no
   dedicated test** — it falls outside the plan ticket's explicit test list. Worth an adversarial
   probe if the reviewer wants belt-and-suspenders coverage.

4. **`on conflict` / upsert through a join leg** threads `stmt.onConflict` into each per-leg
   `InsertStmt` (unchanged), but there is **no explicit `insert or ignore` through a join-leg test**.
   The plan ticket flagged this as "confirm a basic `insert or ignore` behaves (no new gating
   needed)" — a candidate for a reviewer-added case.

5. **Probe cost.** `setOpJoinLegsInsertable` re-plans the body (via `analyzeSetOpView` /
   `analyzeFlaglessSetOpView`) and probes each join leg on every `view_info` read — same re-plan-on-read
   posture as the rest of `deriveViewInfo` (`deriveBackingShape`), so no new caching was added, but it
   is strictly more work than the retired `setOpHasMultiSourceLeg` AST peek. Acceptable per the
   existing surface contract; note it.
