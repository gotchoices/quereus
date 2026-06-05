description: |
  Extended the `new.<col>` row-context binding to the multi-member decomposition (and
  multi-source) INSERT fan-out. Each member/side insert's default-build scope now parents
  on the produced logical row's NEW context (every supplied logical column registered as
  `new.<col>` over the shared envelope attributes), so a member's column default can
  correlate on a sibling logical column the member's own base table does not carry — the
  key case being an anchor surrogate `default (select … where parent.key = new.<fk>)`.
  Before this, the engine's own fan-out threw `new.<col> isn't a column` from
  `buildDecompositionMemberInsert` → `buildInsertStmt` → `buildNotNullDefaults` /
  `createRowExpansionProjection` → `resolveColumn`.
files:
  - packages/quereus/src/planner/building/view-mutation-builder.ts   # buildMemberDefaultRowScope + threading into the decomposition + multi-source fan-outs
  - packages/quereus/src/planner/building/insert.ts                  # buildInsertStmt defaultRowContextScope param → createRowExpansionProjection + buildNotNullDefaults
  - packages/quereus/src/planner/building/constraint-builder.ts      # buildNotNullDefaults parent-scope param (the throw site)
  - packages/quereus/src/planner/building/default-scope.ts           # buildRowDefaultScope (reused, unchanged)
  - packages/quereus/test/logic/03.4-defaults.sqllogic               # decomposition fan-out cross-member new.<col> case
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic          # NEW block (k): multi-source cross-SIDE new.<col> default (review-added)
  - packages/quereus/test/property.spec.ts                           # Family C: deployParentSurrogate + PutGet (surrogate, parent-resolving default)
  - docs/view-updateability.md                                       # § Mutation Context — member/side site resolves against the produced logical row
----

## What shipped

A lens logical-view INSERT lowering to an n-member decomposition fan-out (and the dual
multi-source inner-join fan-out) now threads the **produced logical row's NEW context**
into every member/side base insert. `buildMemberDefaultRowScope` (view-mutation-builder.ts)
builds it once per fan-out via the existing `buildRowDefaultScope` — each supplied logical
column registered as `new.<col>` (and the bare form, unless shadowed) over the shared
envelope attributes — and it is threaded as a new optional `defaultRowContextScope`
parameter of `buildInsertStmt`, which parents BOTH default-build sites on it:
`createRowExpansionProjection` (omitted-column expression defaults) and `buildNotNullDefaults`
(the NOT NULL / `or replace` substitution default — the original throw site). The member's
own supplied columns + mutation-context variables register on the inner scopes and shadow
the threaded names, so single-source behaviour is byte-identical (`defaultRowContextScope`
is `undefined` there). Full mechanism detail is in the implement commit `ab23b979`.

## Review findings

**Verdict: accepted.** The fix is correct, minimal, and well-reasoned; the load-bearing
runtime-binding claim holds; docs reflect the new reality. The decomposition path was
already tested both directions; I added the one genuinely-missing coverage (the
multi-source **cross-side** case the handoff flagged as gap 2) inline, and verified it is
non-vacuous. One residual lens-deploy inconsistency the implementer surfaced is filed as a
backlog ticket. No major findings.

### Checked — and what was found

- **The load-bearing runtime-binding claim (handoff's primary scrutiny target): SOUND.**
  Traced the runtime path: `emitColumnReference` resolves purely by `attributeId`
  (`resolveAttribute` in `runtime/context-helpers.ts`), and the member's narrowing envelope
  `ProjectNode` keeps its `sourceSlot` set (the envelope attribute ids) while suspended at
  its `yield` — closed only in the generator's `finally`, after the whole downstream
  member-insert pipeline (Project → Insert → ConstraintCheck) has drained the row. So the
  envelope `new.<col>` refs resolve at both default sites at runtime, exactly as the
  single-source path already relies on. The threaded scope's `index` arg is metadata only
  (not used in resolution), so no index/id mismatch.

- **Scope threading & shadowing precedence: CORRECT.** `contextScope` and both default
  scopes parent on `defaultRowContextScope` and re-register member-own names as children, so
  a name the member carries itself wins (WITH CONTEXT precedence preserved). `undefined` on
  the single-source path ⇒ unchanged chain (`contextScope ?? defaultRowContextScope ?? ctx.scope`).

- **Envelope index alignment with a minted key: CORRECT.** `buildRowDefaultScope` iterates
  `suppliedColumns` (the leading envelope columns) and indexes `envelopeAttrs` by position;
  the trailing `__shared_key` (present only when minting) is never referenced.

- **Multi-source path — was threaded but UNEXERCISED (handoff gap 2): NOW COVERED.** The
  pre-existing test (j) in `93.4-view-mutation.sqllogic` reads only *same-side* `new.<col>`
  (both the anchor-key `new.seq` and the member `new.email` live on their own side), so it
  never exercised the multi-source threading. Added block **(k)**: a join view whose FK-child
  side carries a NOT NULL column `derived integer not null default (new.pv * 10)` where `pv`
  is a **parent-side** supplied column the child's base table does not carry. Single- and
  multi-row inserts assert per-row cross-side resolution (`derived` = 70 / 30 / 90). Verified
  **non-vacuous**: temporarily dropping `sideNewRowScope` from `buildMultiSourceInsert` makes
  it throw the exact `resolveColumn` failure at plan build (then restored).

- **Bare-form registration (handoff gap 3): NO SURPRISE.** `buildMemberDefaultRowScope`
  registers the bare `<col>` form too, matching the single-source / `buildKeyDefault`
  precedent. A member default's subquery referencing a base-table column resolves against the
  subquery's own (innermost) table scope first; only a truly unqualified name with no closer
  binding reaches the envelope bare form — identical to single-source semantics. Full logic
  suite (217 files) confirms no resolution regression.

- **Docs: ACCURATE.** `docs/view-updateability.md` § Mutation Context now describes the
  member/side site resolving against the produced logical row (the "one mechanism, three
  sites" framing extended), and the decomposition-anchor parent-resolving-default paragraph
  matches the new 03.4 test. Both decomposition and multi-source claims are now test-backed.

- **Tests run (all green):** `yarn typecheck`, `yarn lint` (clean); full `*.sqllogic` suite
  217 passing; `03.4-defaults` + `93.4-view-mutation` (incl. new block k) passing; property
  `PutGet (surrogate, parent-resolving default)` passing (50 runs).

### Findings carried forward (not fixed in this pass — with reasons)

- **Gap 1 (suspension-based binding is fragile to a future materialization barrier):**
  documented latent risk only — no optimizer rule today inserts a cache/materialization
  barrier between the envelope projection and a member's `ConstraintCheckNode`, and the
  single-source path shares the identical dependency. Not actionable now; left as the
  implementer's standing note for any future caching-rule work to respect.

- **Gap 4 (REPLACE re-substitution not asserted in CI):** the `buildNotNullDefaults`
  evaluator only fires at runtime when the user supplied NULL for a NOT NULL column. For the
  minted/threaded surrogate (the cross-member key case) the value is never user-NULL, so the
  substitution path is not naturally reachable through the lens with a meaningful assertion;
  the plan-build resolution (the actual former throw) IS pinned. Low value vs. contrivance —
  left documented rather than adding a synthetic test.

- **Gap 5 (lens no-PK nullability inconsistency):** a genuine, pre-existing lens-*deploy*
  inconsistency unrelated to this change — filed as `tickets/backlog/lens-no-pk-nullable-column-deploy-mismatch.md`.

## Downstream (cross-repo, informational)

Unblocks Lamina's parent-fk shared-rowId **identity** through the lens (sibling repo
`../lamina`). Building `dist/` and Lamina-side adoption remain out of scope here; the
Lamina-side proof is `pk-is-fk-anchor-default-e2e.test.ts` (skipped, pending), with
dependents `tickets/blocked/{1-lamina-lens-write-path-adoption,
4-lamina-retire-rowidsource-physical-machinery}.md`.
