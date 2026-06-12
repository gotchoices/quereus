description: |
  Engine-level READONLY backstop for maintained tables at the runtime DML executor.
  The unified maintained-table model makes user DML naming a maintained table
  write-through by design (plan-time dispatch routes it to the body's base source);
  this added the defense-in-depth second net the plan ticket asked for — an emit-time
  guard (`assertNotMaintainedTableTarget`) in `emitDmlExecutor` that rejects any
  mutation plan whose target still carries a `derivation` (keyed structurally on
  `isMaintainedTable`, never on the table name). It converts a hypothetical plan-time
  mis-dispatch — a direct-write plan that would silently diverge the derived contents
  from the source — into a loud `QuereusError`/`READONLY` at emit time. Shipped with a
  diagnostic-noun fix (body-shape rejects name a maintained table a "materialized view"),
  the engine-owned reword of the "read-only to user DML" docs, and test pins.
files:
  - packages/quereus/src/runtime/emit/dml-executor.ts                          # the guard: assertNotMaintainedTableTarget + call site at emitDmlExecutor head
  - packages/quereus/src/schema/derivation.ts                                  # maintainedTableViewLike sets noun:'materialized view'
  - packages/quereus/src/planner/mutation/single-source.ts                     # MutableViewLike.noun; ALL analyzeView body-shape rejects now thread it (review-broadened)
  - packages/quereus/src/vtab/backing-host.ts                                  # header § Read-only to user DML — reworded engine-owned
  - docs/materialized-views.md                                                 # backing-host bullet + § Write boundary backstop sentence
  - packages/quereus/test/mv-dml-executor-backstop.spec.ts                     # direct guard exercise (3 cases)
  - packages/quereus/test/logic/53.1-materialized-view-write-through.sqllogic  # § 11 aggregate-body reject + § 12 subquery-FROM reject (review-added)
  - packages/quereus/test/logic/51.7-maintained-table-attach-detach.sqllogic   # § 4 strengthened direct-DML-after-detach pin
----

# Complete: maintained-table READONLY backstop at the DML executor

Reviewed the implement-stage diff (`2d852793`) adversarially with fresh eyes,
validated the funnel/structural-keying claims empirically, ran the full memory
**and** store suites, fixed one minor finding inline, and pinned it. The core
design — engine-level emit-time guard, structural keying on `derivation` presence,
single call site, no per-module guards — is sound and lands as the plan ticket
intended.

## What landed (as implemented)

1. **The guard** (`runtime/emit/dml-executor.ts`). `assertNotMaintainedTableTarget`
   throws `QuereusError`/`READONLY` (schema-qualified message) when
   `isMaintainedTable(tableSchema)`. Called once at the head of `emitDmlExecutor`.
   Emit-time, not per-row; re-checked on every re-plan via the `'table'`
   statement-cache dependency.

2. **Diagnostic noun.** Optional `noun` on `MutableViewLike` (default `'view'`),
   set to `'materialized view'` by `maintainedTableViewLike`, consumed by the
   `analyzeView` body-shape rejects so an unsupported-body MV reject names it a
   materialized view. **Review broadened this** from the single
   `classifyViewBody` site to all four body-shape branches (see findings).

3. **Docs** reworded module-owed → engine-owned in `vtab/backing-host.ts` and
   `docs/materialized-views.md`. Both new anchor links verified to resolve.

4. **Tests** — exported-guard spec (3 cases), 53.1 §§ 11–12, 51.7 § 4.

## Review findings

### Scrutinized & confirmed sound (no change)

- **Funnel completeness ("one call site is sufficient").** Verified every
  `vtab.update!()` under `src/runtime/` lives in `dml-executor.ts` (3 sites, all
  in the executor), and every `new DmlExecutorNode(...)` construction is in the
  three planner DML builders (`insert/update/delete.ts`) — the user-DML path the
  write-through dispatch front-runs. The privileged maintenance surface writes via
  other methods. The single emit-time call site is therefore sufficient.
- **Structural keying, not name-based.** `isMaintainedTable` narrows on
  `derivation !== undefined`; the spec's detach case proves the guard sheds with
  the derivation. Confirmed.
- **No end-to-end SQL forcing test, by design.** The backstop is unreachable from
  SQL on the supported path (plan-time dispatch routes every reachable spelling
  away). The exported-guard spec is the honest pin; agreed — a white-box
  `DmlExecutorNode`-over-maintained-`TableReferenceNode` test would only duplicate
  it. Empirically confirmed dispatch keeps the backstop dormant: a join-bodied MV
  INSERT routes through **multi-source write-through** to both base tables and the
  MV stays consistent (the executor guard never fires); a VALUES-bodied MV is
  rejected at CREATE (no provable unique key), so that branch is genuinely
  unreachable.
- **`READONLY` status (vs `INTERNAL`).** Settled in the source ticket and pinned by
  the spec; aligns with the engine-owned "read-only to user DML" framing. Accepted.
- **Docs.** Read every touched file; the engine-owned reword reflects the new
  reality and both `#write-boundary-write-through` / `#backing-host-capability`
  anchors resolve. `MutableViewLike.noun`'s doc comment ("only the analyzeView
  body-shape rejects consult it") stays accurate after the broadening.

### Minor — fixed inline

- **"Structurally unreachable" claim was wrong for the single-base-source branch.**
  The implement handoff justified leaving non-`classifyViewBody` `analyzeView`
  rejects on the default `'view'` noun by asserting "an MV body is always a
  single-source select", hence those branches are unreachable for a maintained
  table. **Disproven empirically:** a subquery-in-FROM MV
  (`create materialized view m as select id,v from (select id,v from t)`) **is**
  creatable and maintained, and write-through rejects it at the single-base-source
  branch (`single-source.ts:434`) — which was misnaming it `view 'm'`. The reject
  itself is correct; only the noun was wrong (cosmetic, never a write-through
  divergence). **Fix:** threaded `view.noun ?? 'view'` through all four body-shape
  reject branches in `analyzeView` (non-select body, no-relation, single-base-source,
  nested-view) so the whole cohort is consistent and the documented reasoning is
  now actually true. Plain views are unaffected (`noun` undefined → byte-identical
  `'view'`); confirmed no test pins any of the changed phrasings.
  **Pin added:** 53.1 § 12 exercises the subquery-FROM MV reject (insert/update/delete
  rejected at plan time naming "materialized view", MV contents untouched, source
  stays writable + maintained) in both memory and store suites.

### Accepted as scoped (not regressions; left for a possible follow-up)

- **Per-column rewrite diagnostics keep generic "view" framing** —
  predicate-contradiction (`insert into view 'x' …`), subquery-correlation
  (`cannot write through view 'x': …`). A larger, separate surface from the
  body-shape cohort; the implementer scoped the noun narrowly and that boundary is
  defensible. Broadening to *every* MV-facing diagnostic remains a cosmetic
  follow-up, not filed (low value, would touch already-pinned messages in 53.1).
- **MV-over-MV reject** (`single-source.ts:459`) names only the table, not a kind
  ("reads a materialized view"); already MV-aware, left as-is.

### Major — none

No correctness, resource-cleanup, type-safety, or error-handling defects found.
No new fix/plan/backlog tickets filed.

## Validation performed (all green)

- `yarn workspace @quereus/quereus run lint` / `typecheck` — clean (post-fix).
- Full memory suite (`yarn test`): **5925 passing**, 0 failing (count unchanged —
  the added 53.1 § 12 statements live inside the file's single `it`).
- Full store suite (`yarn test:store`): **5921 passing**, 0 failing.
- Targeted: `mv-dml-executor-backstop.spec.ts` (3/3), 53.1 and 51.7 each pass in
  **both** memory and store mode.

## Out of scope (unchanged by design)

- No per-module guards (module schemas are derivation-less; attach/detach are
  catalog-only flips). Memory module's `isReadOnly` flag untouched/unrelated.
- Nested-MV writes remain rejected at plan time in `single-source.ts`.
- Declared-constraint semantics on maintained tables stay tracked by
  `maintained-table-declared-constraint-semantics` (backlog).

## End
