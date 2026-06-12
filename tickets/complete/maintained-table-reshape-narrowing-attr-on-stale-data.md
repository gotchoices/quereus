description: Refresh reshape applied narrowing attribute shifts (retype/recollate/tighten-NOT-NULL) to the PRE-reconcile stale backing, throwing a spurious MISMATCH/CONSTRAINT on a reshape the fresh body satisfies (and diverging the catalog from the module's live schema on the partial throw). Fixed by splitting the reshape into a pre-reconcile structural batch and a post-reconcile data-validating batch, so the throwing ops validate the reconciled body rows, not the discarded backing.
prereq:
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts          # ReshapeColumnOp / ReshapePlan (preReconcileOps + postReconcileOps), classifyBackingReshape routing, reshapeOpToChange tightenNotNull arm, reshapeBackingInPlace two-phase exec (+ review fix: per-op post-reconcile catalog re-register)
  - packages/quereus/test/materialized-view-refresh-reshape.spec.ts          # memory regression test (narrowing retype on stale backing + convergence)
  - packages/quereus-store/test/mv-store-backing.spec.ts                     # durable store-path parity test
  - docs/materialized-views.md                                              # §Shifted shape reshape bullet — two-phase split + recoverability
  - tickets/backlog/maintained-table-reshape-pk-column-retype-unreachable-path.md  # spun-out follow-up
  - tickets/backlog/maintained-table-canonical-ddl-not-rehydratable.md       # tracks the pre-existing MV-DDL-stringify failure (NOT this diff)
difficulty: medium
----

# Reshape: validate data-narrowing ops against the reconciled body, not the discarded backing

## What changed (the fix)

`reshapeBackingInPlace` used to apply *all* `alterTable` ops in one loop **before**
the data reconcile, deferring only NOT NULL *tightenings*. The attribute shifts
that can **throw on data** — a narrowing `retype` and a `recollate` — ran against
the pre-reconcile backing rows, which `rebuildBacking` discards. When the table
was **stale**, those discarded rows held pre-narrowing values, so the reshape
threw a spurious MISMATCH/CONSTRAINT on a delta the fresh body satisfies, and the
mid-loop throw diverged the catalog `TableSchema` (still old) from the module's
already-mutated live schema (corrupting the table with a phantom `col_2`).

The fix splits the reshape into a **two-phase plan** by whether an op throws on
the data it touches:

- `ReshapePlan` carries `preReconcileOps` (renames, adds, NOT NULL *loosenings*,
  drops — none throw on data) and `postReconcileOps` (retype, recollate, NOT NULL
  *tightenings* — all data-validating). A new `{ kind: 'tightenNotNull' }`
  `ReshapeColumnOp` folds the former `tightenNotNull: string[]` into the unified
  post-reconcile list; `reshapeOpToChange` lifts it to `{ type: 'alterColumn',
  setNotNull: true }`.
- `classifyBackingReshape` routes `retype`/`recollate`/tighten into
  `postReconcileOps`; `loosenNotNull` and the structural ops stay pre-reconcile.
- `reshapeBackingInPlace`: apply pre-reconcile ops → re-register the reshaped
  structural schema → reconcile (`rebuildBacking`) → apply post-reconcile ops →
  fire one `table_modified`.

Soundness rests on the reconcile's insert paths **not** validating values against
the column schema (`MemoryTable.replaceBaseLayer` PK-extracts + inserts raw, only
a PK-dup CONSTRAINT check; the store `replaceContents` puts serialized rows by
keyed diff), so a body value conforming to the NEW attribute enters the still-OLD-
typed column unvalidated, and the post-reconcile op then converts/re-keys/asserts
the clean body data.

## Review findings

Read the implement diff (`4ffff3b4`) with fresh eyes before the handoff summary.

### Checked

- **Deferral soundness (the central claim).** Confirmed `MemoryTable.replaceBaseLayer`
  (`vtab/memory/layer/manager.ts:1233`) PK-extracts each row and inserts raw with
  only a PK-duplicate CONSTRAINT check — no type / NOT NULL / non-PK-unique
  validation against the column schema. So a NEW-typed body value enters an
  OLD-typed column unvalidated, and the post-reconcile op validates the clean body.
  The store path is exercised by the passing store parity test. Soundness holds.
- **Op ordering within each batch.** Pre-reconcile is `[...renames, ...adds,
  ...loosens, ...drops]` (renames first so later ops use new names; adds before
  drops). Post-reconcile is retype → recollate → tighten in `recordAttrShift` push
  order, so a column both retyped and tightened gets retype-before-tighten.
  Confirmed correct.
- **`classifyBackingReshape` alignment.** Survivor/rename/drop/add/reorder-rejection
  logic unchanged; only the routing buckets changed (data-validating ops →
  `postReconcileOps`). Correct.
- **`reshapeOpToChange` `tightenNotNull` arm + add-NULLABLE.** Added columns ride
  in with their full new type but `notNull:false, primaryKey:false`; the tighten
  defers. Correct.
- **Pre-reconcile unconditional `schema.addTable`.** For a pure-retype reshape
  (`preReconcileOps` empty) `current` stays `backing`, so the registered `live` is
  `{...backing, derivation}` with the shape-updated derivation — exactly what
  `rebuildBacking` needs. This `addTable` was already unconditional in the old code;
  no double-register regression.
- **Tests.** Memory regression (narrowing retype on stale backing, no `col_2`
  divergence, exactly `[id,v,w]`, INTEGER logical type, `read(MV)==eval(body)`,
  only `table_modified`, second-refresh fast-path convergence) and the store
  parity analogue both green. Existing reshape suite (trailing add, deferred-tighten
  add, drop, non-PK recollate, MV-over-MV cascade, interleave/PK sited errors,
  explicit-column count-shift error) stays green.
- **Docs.** `docs/materialized-views.md` §Shifted-shape bullet rewritten for the
  two-phase split and reads accurately. No other doc describes the reshape flow
  (the `reshape` hits in `optimizer.md` are unrelated relational-identity usage).
- **Validation.** `yarn workspace @quereus/quereus test` → 5665 passing, 1 failing;
  the one failure is the pre-existing `generateMaintainedTableDDL fixed point`
  (`view-mv-ddl-persistence.spec.ts`), an MV-DDL-stringify subsystem this diff never
  touches, already tracked in `tickets/backlog/maintained-table-canonical-ddl-not-rehydratable.md`.
  Store backing spec → 18 passing. `eslint` + `tsc --noEmit` clean.

### Found & fixed in this pass (minor)

- **Post-reconcile catalog re-registration on a mid-batch throw.** The
  post-reconcile loop mutated the module schema **per op** (`current = await
  module.alterTable(...)`) but re-registered the catalog `live` only **once after
  the whole loop**. Because post-reconcile ops are precisely the data-validating
  ops that *can* throw, a throw on op N>1 would leave ops 1..N-1 applied to the
  module while the catalog still held the pre-post-op schema — the exact
  catalog/module divergence the two-phase split exists to eliminate, and
  contradicting the docstring/doc claim that a post-reconcile failure "throws after
  the catalog is consistently re-registered with the reconciled body." (Pre-existing
  shape: the old `tightenNotNull` loop had the same single-post-loop register; this
  diff widened the batch with retype/recollate and added the recoverability claim.)
  **Fixed** by re-registering the catalog after **each** post-reconcile op, so the
  catalog always tracks the module and a mid-batch failure leaves a coherent,
  re-runnable table — making the documented guarantee true. All reshape/store/full
  suites re-run green after the change.

### Major findings (filed, not fixed here)

- **PK-column type-change reshape is dead + untested** → already spun out to
  `tickets/backlog/maintained-table-reshape-pk-column-retype-unreachable-path.md`.
  `describePhysicalPkChange` permits a PK-column retype (routes to post-reconcile),
  but `alter column set data type` on a PK column is rejected at the source, so the
  branch is unreachable today; if ever reachable, the reconcile keys body rows under
  the OLD PK comparator (mis-key hazard). The backlog ticket asks for an explicit
  reject-or-support decision + test. Verified well-formed.

### Known gaps (acknowledged, acceptable)

- **Genuine-throw post-reconcile tests not constructible.** Every source narrowing
  is uniformly gated by the source's own `alterColumn` (re-validates source rows),
  and DML is type-checked at the storage boundary, so the re-derived body is always
  clean by refresh time — which is *why the deferral is sound*, but also why a
  post-reconcile op that genuinely throws "even the body can't satisfy" cannot be
  produced from supported SQL. The coherence/convergence property is asserted via
  the constructible success path. A genuine-throw test would need a test-only
  module/hook injecting body data that violates a post-reconcile attribute — out of
  scope; not filed (no product behavior depends on it, and the per-op re-register
  fix above already makes the partial-throw path coherent regardless).
- **Value-representation nuance.** `set data type` is metadata-only in the memory
  module (validates convertibility, does not rewrite the stored representation)
  while the store module physically converts. Tests assert the schema narrowed
  (logical type → INTEGER) and `read(MV) == eval(body)` rather than a specific JS
  value type, staying representation-agnostic. Pre-existing engine behavior, not
  introduced here.

### Not chased (pre-existing red)

- The MV-DDL-stringify/rehydrate subsystem is broken at HEAD
  (`view-mv-ddl-persistence.spec.ts` `generateMaintainedTableDDL`, plus store
  `mv-rehydrate-adopt` / `view-mv-persistence`). Outside this diff; tracked in
  `tickets/backlog/maintained-table-canonical-ddl-not-rehydratable.md`. The
  implement-stage `.pre-existing-error.md` was consumed and triaged by the runner
  (commit `abde4438`).
