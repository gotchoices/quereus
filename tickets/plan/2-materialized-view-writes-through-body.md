description: Accept INSERT / UPDATE / DELETE (and RETURNING) directly against a materialized-view name and propagate to its source table via view updateability. Under the row-time-only model every MV body is a single-source, row-preserving projection-filter (the eligibility shape) — exactly the view-updateability Phase-1 shape — so write-through is: rewrite the MV-targeted DML to target the source `T`, then let the existing row-time maintenance hook bring the backing into sync automatically (reads-own-writes). Replaces the current read-only write boundary (`assertNotMaterializedView`).
prereq: materialized-view-rowtime-only-consolidation
files: packages/quereus/src/planner/building/view-mutation.ts, packages/quereus/src/planner/mutation/propagate.ts, packages/quereus/src/planner/building/insert.ts, packages/quereus/src/planner/building/update.ts, packages/quereus/src/planner/building/delete.ts, packages/quereus/src/schema/view.ts, packages/quereus/src/func/invertibility.ts, packages/quereus/src/runtime/emit/dml-executor.ts, docs/materialized-views.md, docs/view-updateability.md
----

## Why this is now easy (and why it belongs here)

The `materialized-view-rowtime-only-consolidation` work narrows every MV to a
**single source `T` (with PK), row-preserving linear body
(`TableReference → optional Filter → Project → optional Sort`), projection of
passthrough or deterministic-invertible expressions including all of `T`'s PK,
optional single-row `WHERE`**. That is precisely the **view-updateability Phase 1**
shape (single-source projection-and-filter, shipped — see
[view-updateability.md](../../docs/view-updateability.md) § Status), extended only by
deterministic expression columns, which view updateability already handles through
its scalar-invertibility profile (invertible ⇒ writeable, opaque ⇒ read-only).

So write-through to an MV is **not a new subsystem** — it is wiring the MV name into
the propagation path plain views already use, plus one happy composition with
row-time maintenance.

> **Coordination — AST-rewrite retirement.** Write-through reuses the Phase-1 AST
> rewrite (`building/view-mutation.ts`). `view-mutation-plan-node-substrate` **retires**
> that rewrite in favour of the plan-node substrate, so write-through ships on the AST
> rewrite now (the cheap, already-shipped path) and **migrates to the substrate when that
> ticket lands** — same single-source propagation, no behavior change. That call-site
> migration is listed in the substrate ticket's retire step.

## What it does

`insert` / `update` / `delete` (with optional `returning`) against an MV name:

1. **Rewrite to the source.** The MV body is the "view body": reuse
   `planner/building/view-mutation.ts` to rewrite the MV-targeted DML to target `T`
   and re-plan through the ordinary base-table builder — the same AST-level rewrite
   Phase-1 view mutation performs. All constraint / conflict / FK / mutation-context
   machinery is reused verbatim.
2. **Backing syncs for free.** The rewritten write hits `T`, which fires the existing
   row-time maintenance hook (`Database._maintainRowTimeCoveringStructures` from the
   DML write boundary). The backing table is brought into sync **inside the same
   statement/transaction** — so a subsequent read of the MV sees the write
   (reads-own-writes), and a rollback reverts source + backing in lockstep. **No new
   backing-write path is introduced**; write-through rides source maintenance.

The current `assertNotMaterializedView` rejection in the three DML builders is
replaced by this route (an ineligible/over-MV case still rejects — see Scope).

## Reuse map (almost everything)

- **DML rewrite:** `view-mutation.ts` (single-source projection-filter → base op),
  gated by `planner/mutation/propagate.ts`.
- **Omitted-column defaults:** constant-FD defaulting already supplies a column
  pinned by the body's `WHERE` (`create materialized view m as select id, x from t
  where color = 'green'`; `insert into m (id, x) …` defaults `color = 'green'`), plus
  base-column defaults — identical to the view path.
- **Expression columns:** `func/invertibility.ts` profiles decide per-column
  writeability. `select id, x + 1 as y` writes `y` through the inverse `y → x = y-1`;
  an opaque expression column is `computed` (read-only) and a write to it raises the
  existing `no-inverse` diagnostic. Reads of either are unaffected.
- **RETURNING:** projected through the **MV's** column list, evaluated against
  post-mutation state — the view-updateability RETURNING rule unchanged.

## Per-operator behavior (inherited from view updateability)

- **Insert.** Values flow to `T`; the body `WHERE` is conjoined into the existence
  predicate (an insert provably contradicting it is rejected; otherwise it proceeds
  and visibility is decided by data). Missing columns fill via constant-FD / base
  default / `null`.
- **Update.** Assignments route per-column to `T` (through inverses for expression
  columns). An update that carries a row **out of the body `WHERE`** succeeds in `T`
  and the row leaves the MV — and the row-time maintenance **update arm already
  handles the predicate-scope transition** (delete old image / upsert new image), so
  the backing follows correctly with no extra work.
- **Delete.** Row-identifying predicate built from `T.pk` (the projection always
  includes it), so the base delete is exact; maintenance removes the backing row.

## The row-time composition (the point)

Because the MV is row-time maintained, write-through and maintenance compose with
**zero** extra maintenance code: the MV write becomes a source write, the source
write triggers the existing per-statement maintenance flush, and reads-own-writes
falls out of the shared backing connection. A write-through to an MV is observably
identical to writing the source and reading the MV — which is the whole "MV ≡ faster
view" contract the consolidation establishes, now closed in the write direction too.

## Scope / non-goals

- **MV-over-MV write-through is out of scope**, consistent with the consolidation's
  decision to defer MV-whose-source-is-an-MV maintenance. If/when cascade lands, a
  write-through to a dependent MV propagates to the upstream MV recursively; not now.
- **No `with check option`, no `instead of` triggers** — same stance as view
  updateability (the body `WHERE` is a read-time filter, not a write-time invariant;
  use a base CHECK / `create assertion` for the converse).
- **Non-deterministic / opaque expression columns** are read-only at the column
  level (write rejected, read fine) — not a regression, the view rule.
- This ticket does **not** alter the eligibility gate (owned by the consolidation);
  it assumes the single-source shape that gate guarantees.

## Interaction with divergence/self-heal (now moot)

The earlier `materialized-view-cascading-divergence-propagation` design coupled
write-through with a divergence "self-heal" and a lens-world enforcement self-heal.
Under row-time-only there is **no divergence** (maintenance is transactional and
never re-reads the source), so that coupling is gone: write-through is purely the
view-updateability application above. A row-time covering MV used for UNIQUE
enforcement is always consistent, so write-through through it enforces normally with
no special-casing beyond the existing `stale` gate.

## Key tests (TDD targets for implement)

- `insert` / `update` / `delete` into `create materialized view m as select id, x
  from t` propagates to `t`, and a same-transaction `select … from m` reflects it
  (reads-own-writes); a rollback reverts both.
- Filtered MV (`… where color = 'green'`): insert omitting `color` defaults it via
  constant FD; an update moving a row out of `where` scope removes it from the MV
  (maintenance predicate-scope transition).
- Expression projection (`select id, x + 1 as y from t`): writing `y` propagates via
  the inverse; an opaque-expression column rejects the write with `no-inverse` but
  still reads.
- `returning` through the MV column list returns post-mutation rows projected to the
  MV's columns.
- Write-through to a **row-time covering MV** that enforces a UNIQUE constraint
  resolves conflicts correctly (the backing stays consistent within the statement).
- MV-over-MV write-through is rejected with a clear "source is itself a materialized
  view" diagnostic (until cascade lands).
- Bulk multi-row write-through produces correct backing contents under the
  per-statement maintenance batching the consolidation introduces.

## TODO (implement phase)

- Replace `assertNotMaterializedView` in the insert/update/delete builders with a
  route into `view-mutation.ts`, using the MV's body AST as the view body.
- Confirm the MV eligibility shape is a strict subset of what `propagate.ts` accepts;
  add the one MV-specific rejection (source-is-an-MV) and a clear diagnostic.
- Verify expression-column write-through against `func/invertibility.ts` (the
  consolidation adds expression projections to the eligible shape; ensure invertible
  ones are writeable and opaque ones are read-only per the view rule).
- Confirm RETURNING-through-MV reuses the view RETURNING path.
- Add the sqllogic + unit coverage above (extend `53`/`54`; new write-through cases).
- Docs: update `docs/materialized-views.md` § Write boundary (no longer read-only —
  write-through propagates to sources, backing syncs via maintenance) and
  `docs/view-updateability.md` § Status (the "Write-through materialized views remain
  read-only … future ticket gated on this one" note now resolves to *delivered*).
