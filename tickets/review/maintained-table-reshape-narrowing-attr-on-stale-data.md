description: Refresh reshape applied narrowing attribute shifts (retype/recollate/tighten-NOT-NULL) to the PRE-reconcile stale backing, throwing a spurious MISMATCH/CONSTRAINT on a reshape the fresh body satisfies (and diverging the catalog from the module's live schema on the partial throw). Fixed by splitting the reshape into a pre-reconcile structural batch and a post-reconcile data-validating batch, so the throwing ops validate the reconciled body rows, not the discarded backing.
prereq:
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts          # THE FIX — ReshapeColumnOp / ReshapePlan (preReconcileOps + postReconcileOps), classifyBackingReshape routing, reshapeOpToChange tightenNotNull arm, reshapeBackingInPlace two-phase exec
  - packages/quereus/test/materialized-view-refresh-reshape.spec.ts          # memory regression test (narrowing retype on stale backing + convergence)
  - packages/quereus-store/test/mv-store-backing.spec.ts                     # durable store-path parity test
  - docs/materialized-views.md                                              # §Shifted shape reshape bullet — rewritten for the two-phase split + corrected recoverability
  - tickets/.pre-existing-error.md                                          # pre-existing MV-DDL-stringify failures (NOT this diff)
  - tickets/backlog/maintained-table-reshape-pk-column-retype-unreachable-path.md  # spun-out follow-up
difficulty: medium
----

# Reshape: validate data-narrowing ops against the reconciled body, not the discarded backing

## What changed (the fix)

`reshapeBackingInPlace` used to apply *all* `alterTable` ops (renames, adds,
attribute shifts, drops) in one loop **before** the data reconcile, then defer
only NOT NULL *tightenings* to a post-reconcile pass. The attribute shifts that
can **throw on data** — a narrowing `retype` (physical convert → MISMATCH) and a
`recollate` (re-key + unique re-validate → CONSTRAINT) — ran against the
pre-reconcile backing rows, which `rebuildBacking` is about to discard. When the
table was **stale** (so an earlier source data-fix was never maintained into the
backing), those discarded rows still held pre-narrowing values, and the reshape
threw a spurious MISMATCH/CONSTRAINT on a delta the fresh body satisfies. The
mid-loop throw additionally **diverged** the catalog `TableSchema` (still old) from
the module's already-mutated live schema (the `schema.addTable` ran only after the
whole loop), corrupting the table (phantom `col_2`) and never converging.

The fix generalizes the existing deferral into a **two-phase plan** split by
whether an op can throw on the data it touches:

- `ReshapePlan` now carries `preReconcileOps` (renames, adds, NOT NULL
  *loosenings*, drops — none throw on data) and `postReconcileOps` (retype,
  recollate, NOT NULL *tightenings* — all data-validating). A new
  `{ kind: 'tightenNotNull' }` `ReshapeColumnOp` folds the former
  `tightenNotNull: string[]` into the unified post-reconcile list; `reshapeOpToChange`
  lifts it to `{ type: 'alterColumn', setNotNull: true }`.
- `classifyBackingReshape` routes `retype`/`recollate`/tighten into
  `postReconcileOps`; `loosenNotNull` and the structural ops stay pre-reconcile.
- `reshapeBackingInPlace` now: apply pre-reconcile ops → **re-register** the
  reshaped structural schema (`schema.addTable`) → reconcile (`rebuildBacking`) →
  apply post-reconcile ops → re-register the final schema → fire one
  `table_modified`.

Soundness rests on the reconcile's insert paths **not** validating values against
the column schema (`MemoryTable.replaceBaseLayer` PK-extracts + inserts raw; the
store `replaceContents` puts serialized rows by keyed diff), so a body value
conforming to the NEW attribute enters the still-OLD-typed column unvalidated, and
the post-reconcile op then converts/re-keys/asserts the clean body data. Because
only structural (non-throwing) ops run before the schema re-registers, the
catalog/module divergence window is closed.

Docstrings on `ReshapeColumnOp` / `ReshapePlan` / `classifyBackingReshape` /
`reshapeBackingInPlace` and the `docs/materialized-views.md` reshape bullet were
rewritten for the two-phase split and corrected recoverability story.

## Validation done

- `materialized-view-refresh-reshape.spec.ts` — **11 passing** (incl. the new
  regression). `mv-store-backing.spec.ts` — **18 passing** (incl. the new store
  parity test).
- Full `yarn workspace @quereus/quereus test` — **5665 passing, 1 failing**; the
  one failure is pre-existing MV-DDL-stringify (`view-mv-ddl-persistence.spec.ts`,
  `generateMaintainedTableDDL`), reproduced on a clean `git stash` — see
  `tickets/.pre-existing-error.md`.
- `tsc --noEmit` clean; `eslint` on the changed source + memory spec clean.
- `dist` rebuilt with the fix (the store suite imports `@quereus/quereus` from
  `dist`, not `src` — re-`yarn workspace @quereus/quereus build` if you re-touch
  the engine before running store tests, or the store run will silently use stale
  code).

## Use cases to exercise / re-verify (reviewer: this is a floor, not a ceiling)

- **Primary regression (the reproduction).** `select *` MV over `t(id, v text)='abc'`;
  `alter t add column w` to go stale (so the data-fix below is unmaintained);
  `update t set v='5'`; `alter t alter column v set data type integer`; `refresh`.
  Expect: no MISMATCH, columns exactly `[id, v, w]` (no phantom `col_2`), `v` schema
  type INTEGER, `read(MV) == eval(body)`, only `table_modified`, and a second
  refresh hits the fast path (converged). Covered for both memory and store.
- **Existing reshape suite must stay green** — trailing add, NOT NULL trailing add
  (deferred tighten), drop, non-PK recollate, MV-over-MV cascade, interleave/PK
  sited errors, explicit-column count-shift error.

## Known gaps / things to scrutinize (honest)

- **The two "engineered genuine-throw" tests in the original ticket (recollate
  stale-collision; convergence-after-a-real-mid-sequence-throw) were NOT added —
  they are not constructible via supported SQL.** Root cause discovered during
  implementation: **every source narrowing is uniformly gated by the source's own
  `alterColumn`** (`set data type` re-validates source rows → MISMATCH on
  non-convertible; `set not null` rejects existing NULLs; `set collate` re-validates
  the source's UNIQUE under the new collation → CONSTRAINT), and DML is type-checked
  at the storage boundary (`performInsert`/`validateAndParse`). So the re-derived
  **body is always clean** by the time refresh runs — which is precisely *why the
  deferral is sound and a spurious throw cannot recur*, but also why a post-reconcile
  op that genuinely throws "even the body can't satisfy" cannot be produced from
  supported operations. The coherence/convergence property is instead asserted via
  the constructible success path (the reproduction: no `col_2` divergence, exactly
  `[id,v,w]`, second-refresh fast-path). **If the reviewer wants a genuine-throw
  test, it needs a test-only module/hook that injects body data violating a
  post-reconcile attribute (or a multi-source body decoupling attribute lineage from
  value lineage) — out of scope here; flag if you consider it required.**
- **PK-column type-change sub-case → filed to backlog** (`maintained-table-reshape-pk-column-retype-unreachable-path`).
  `describePhysicalPkChange` permits a PK-column type change (routes a retype to
  post-reconcile), but `alter column set data type` on a PK column is **rejected at
  the source** ("Cannot SET DATA TYPE on PRIMARY KEY column"), so no supported ALTER
  can reach that branch — it is dead today, and if ever reachable the reconcile keys
  body rows under the OLD PK comparator (untested mis-key hazard). The backlog ticket
  asks for an explicit reject-or-support decision + test.
- **Value-representation nuance.** `set data type` is **metadata-only** in the memory
  module (it validates convertibility but does not rewrite the stored representation —
  `t.v` stays the text `'5'` under an INTEGER logical type), while the **store** module
  *does* physically convert (`mapRowsAtIndex`). The tests therefore assert the schema
  narrowed (logical type → INTEGER) and `read(MV) == eval(body)` rather than a specific
  JS value type, to stay representation-agnostic across both backings. A reviewer
  comparing memory vs store outputs should expect this difference; it is pre-existing
  engine behavior, not introduced here.
- **Pre-existing red, not this diff:** the MV-DDL-stringify/rehydrate subsystem is
  broken at HEAD — `view-mv-ddl-persistence.spec.ts` (`generateMaintainedTableDDL`),
  plus the store `mv-rehydrate-adopt.spec.ts` (14) and `view-mv-persistence.spec.ts`
  (8). All reproduce on a clean tree/dist; documented in `tickets/.pre-existing-error.md`.
  Do not chase inside this review.

## Suggested review focus

1. The deferral's soundness claim: confirm neither base-layer insert path validates
   values (so a NEW-typed body value can enter an OLD-typed column unvalidated before
   the post-reconcile convert). `manager.ts` `replaceBaseLayer`, store `replaceContents`.
2. Op **ordering within** each batch: pre-reconcile keeps renames+adds-before-drops;
   post-reconcile is retype/recollate/tighten in discovery order — confirm a column
   that is both retyped and tightened gets retype-before-tighten (it does;
   `recordAttrShift` pushes in that order).
3. The unconditional `schema.addTable(live)` after the (possibly empty) pre-reconcile
   batch — correct for a pure-retype reshape (no structural ops) so `rebuildBacking`
   resolves the derivation-carrying schema; verify it doesn't double-register
   spuriously.
