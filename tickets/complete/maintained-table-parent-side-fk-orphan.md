description: Parent-side referential enforcement wired into the maintained-table maintenance write path — a maintenance delete/key-update of a maintained table that is an FK PARENT now fires RESTRICT / CASCADE / SET NULL / SET DEFAULT instead of silently orphaning child rows. Engine reused as-is; new entry point + tests + docs. COMPLETE (reviewed).
files:
  - packages/quereus/src/core/database-materialized-views.ts        # enforceParentSideReferentialActions + 2 call sites
  - packages/quereus/src/runtime/foreign-key-actions.ts             # reused engine (UNCHANGED)
  - packages/quereus/src/core/database-external-changes.ts          # precedent caller the hook mirrors (UNCHANGED)
  - packages/quereus/test/runtime/maintained-parent-fk.spec.ts      # 18-case matrix (15 from implement + 3 aggregate-arm added in review)
  - docs/materialized-views.md                                      # § Parent-side referential enforcement
  - docs/incremental-maintenance.md                                 # write-through ordering note
  - tickets/backlog/maintained-parent-fk-reverse-index.md           # parked perf optimization
  - tickets/backlog/maintained-parent-fk-residual-arm-coverage.md   # parked remaining test coverage (filed in review)
----

# Parent-side referential enforcement for maintained-table maintenance writes — COMPLETE

## What landed

A maintained table `M` can be the **parent** (FK target) of an FK declared on an ordinary
table `C` (`create table C (… references M(col) …)`). Previously a source write that drove
maintenance to **delete** or **key-update** the referenced `M` row applied the backing delta
with **no parent-side FK enforcement**, silently orphaning `C`.

The fix wires the already-shared parent-side referential-action engine
(`runtime/foreign-key-actions.ts`) into the maintenance write path as a third entry point
(the DML executor and `database-external-changes.ts` are the other two) via a new private
`MaterializedViewManager.enforceParentSideReferentialActions(plan, changes)`, called after
`validateDerivedChanges` at **both** backing-write sites (`maintainRowTime` bounded-delta arms
and `flushDeferredRebuilds` full-rebuild floor). Per delete/update `BackingRowChange` it runs
`assertTransitiveRestrictsForParentMutation` then `executeForeignKeyActionsAndLens` —
byte-for-byte the external-changes call shape (`lensRouted = false`, RESTRICT walked
post-application). Inserts skip; a `foreign_keys`-pragma early-return gates the off path. The
hook operates on the `BackingRowChange[]` the apply arms return, so it is **arm-agnostic** —
no per-arm code. **No engine changes.**

## Review findings

Adversarial pass over commit `4e127961`. The implementation is sound, DRY (genuine engine
reuse — no third copy), and the call shape matches the `database-external-changes.ts`
precedent exactly. Lint clean; full `@quereus/quereus` suite green (**6060 passing**, 9
pending — up from 6057 with the 3 tests added below).

### Checked — correctness / architecture

- **Engine reuse is real, not a fork.** `enforceParentSideReferentialActions` imports and calls
  the same two exported functions the external-changes seam uses, with the identical argument
  shape (`op`, `oldRow`, `newRow`, default `lensRouted = false`). The `change.op === 'insert'`
  skip + the two calls are the external path's `if (applyForeignKeyActions && change.op !== 'insert')`
  block re-expressed. ✔ no drift risk beyond the two callers already documented.
- **`BackingRowChange` discriminated-union narrowing.** After the `insert` skip, `change` narrows
  to delete|update; `change.oldRow` is `Row` in both, `change.newRow` is `Row | undefined` — both
  accepted by the engine signatures. Type-safe, no `any`, no non-null assertions. ✔
- **No double-fire across the MV-over-MV cascade.** Each maintenance level resolves `parent` as
  *its own* backing table; the engine matches an FK only when `fk.referencedTable === parent.name`,
  so level `m1` enforces only FKs referencing `m1` and level `m2` only those referencing `m2`.
  The parent-side subtree and the MV-over-MV cascade subtree are orthogonal. ✔ (now also
  pinned by the MV-over-MV intermediate-parent tests).
- **RESTRICT post-application timing.** The backing delta is already in the pending layer when
  enforce runs; the RESTRICT walk keys off child rows that still exist (cascade not yet run), so
  a surviving RESTRICT correctly throws. Identical to the external-changes seam. ✔
- **`this.ctx as unknown as Database` cast.** Matches the established pattern used ~20× elsewhere
  in this file (e.g. `validateDerivedRowImage`, `buildDerivedRowValidator`). ✔ not a new smell.
- **`if (!parent) return` is dead-defensive** — `applyMaintenancePlan` already resolves and writes
  the same backing (throwing INTERNAL if absent) before this runs, so `parent` is never undefined
  on the reached path. Other sites in the file `throw` on a missing backing rather than return;
  this one returns. Trivially inconsistent but harmless (and arguably safer than throwing mid-
  enforcement). Left as-is — not worth a behavioral change.
- **Docs.** `docs/materialized-views.md` § "Parent-side referential enforcement (M as an FK
  target)" and the `docs/incremental-maintenance.md` ordering note both read accurately against
  the landed code (entry points, ordering, gate, cost, no-op cases). The stale out-of-scope line
  was correctly trimmed to just the still-open `maintained-table-refresh-revalidation`. ✔

### Found + fixed inline (minor)

- **Aggregate (`residual-recompute`) arm untested as a parent — the highest-value of the
  implementer's flagged "arms not directly tested" gaps.** The aggregate arm realizes an emptied
  group as a backing `delete-key` (count → 0) — a structurally *different* apply path from the
  inverse-projection arm, the only other arm with delete coverage. Added a 3-case block
  (`residual-recompute (aggregate) arm as an FK parent`, white-box-asserting `kind ===
  'residual-recompute'`): **CASCADE** removes the child when its group empties; **RESTRICT** blocks
  the group-emptying delete and rolls the source write back; and a **non-emptying decrement**
  (`n` 2→1, an upsert/REPLACE at the same backing key with the referenced PK column unchanged)
  correctly fires **no** action via the UPDATE referenced-column short-circuit. All pass. This
  promotes the "arm-agnostic" claim from one proven arm to two genuinely-distinct apply paths.

### Found + deferred (filed, low risk)

- **Remaining arm / backend coverage** → `tickets/backlog/maintained-parent-fk-residual-arm-coverage.md`.
  The `join-residual` (1:1 join) and `prefix-delete` (lateral-TVF) arms, cross-schema FK
  (`fk.referencedSchema`), and the store backend (`yarn test:store`, incl. the SET DEFAULT
  rowid-chained caveat) remain covered only structurally / by the engine's own suites. Low risk
  — the hook is arm-agnostic and now proven on two distinct delete-producing arms — but genuinely
  untested on the maintenance seam. Parked rather than left silent.

### Reviewed + accepted (no change)

- **PK-move ON UPDATE semantics** (implementer-flagged): when the referenced column **is** `M`'s
  backing PK, a maintenance key-update decomposes to delete+insert and observes an ON **DELETE**
  action, not ON UPDATE. This is **consistent** with an ordinary `update M set <pk> = …` (also
  delete+insert under key-based addressing — the engine has no rowid), so it is the intended,
  non-regressive semantics, not a defect. The spec's ON UPDATE cases deliberately use a non-PK
  UNIQUE column (the only shape yielding a single backing `update`). Accepted; documented in the
  subtleties, no ticket warranted.
- **Perf** (`O(catalog)` referencing-FK scan per change) — parity with `delete from M`, already
  parked as `tickets/backlog/maintained-parent-fk-reverse-index.md`.
- **Adversarial cascade-cycle backstop** — the engine's existing `visited`-set +
  `assertCascadeDepth` / `assertFlushRounds` are exercised across the broader suite; the
  converging-feedback-loop test covers the realistic data-converging case. A pathological
  structural cycle is the engine's responsibility, not this seam's. Accepted.

## How it was validated

```
yarn workspace @quereus/quereus run test:single packages/quereus/test/runtime/maintained-parent-fk.spec.ts   # 18 passing
yarn workspace @quereus/quereus run lint                                                                      # clean
yarn workspace @quereus/quereus test                                                                          # 6060 passing, 9 pending
```

`yarn test:store` not run in this pass (see the deferred-coverage backlog ticket).

## End
