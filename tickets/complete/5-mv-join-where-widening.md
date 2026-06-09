description: Widen the 1:1 `'join-residual'` MV arm to accept a partial `WHERE`. The arm classifies the body WHERE by which base table(s) it references: a `T`-only predicate just relaxes the gate (forward residual carries it; lookup side stays upsert-only); a predicate referencing the lookup `P` (or both sides) switches the lookup side to a **delete-capable** reverse residual (WHERE-stripped membership residual deletes every currently-referencing `T.pk` backing key, then the in-scope residual re-upserts the survivors). Inner/cross + 1:1 only; outer/fanning still floor. Reviewed and complete.
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/test/incremental/maintenance-equivalence.spec.ts, packages/quereus/test/logic/53-materialized-views-rowtime.sqllogic, docs/incremental-maintenance.md, docs/materialized-views.md
----

## What landed

`buildJoinResidualPlan` (`database-materialized-views.ts`) no longer blanket-rejects a body `WHERE`. After `T`/`P` are identified and the forward (`T`) + in-scope reverse (`P`) residuals are compiled, the body WHERE is:

1. **Determinism-gated** — `bodyWhereIsNonDeterministic` walks the analyzed body's `FilterNode` predicates; a volatile WHERE → `return null` → the floor's pragma-gated whole-body determinism reject (preserves the pre-widening behavior: rejected without `pragma nondeterministic_schema`, accepted as a wholesale rebuild with it).
2. **Classified** — `bodyWhereReferencesLookup` resolves every `ColumnReferenceNode` attribute id inside any `FilterNode` predicate against `T`'s attribute→source-column map. Conservative: a reference that does not provably resolve to `T` ⇒ lookup-referencing.
3. **Routed** — `T`-only ⇒ lookup side stays upsert-only (`lookupMembershipResidualScheduler` absent). `P`-referencing (or both-sides) ⇒ `compileLookupMembershipResidual` builds the delete-capable residual (WHERE stripped at AST level, body re-built + re-analyzed, `injectKeyFilter` on `P`). `applyLookupResidual` then delete-then-upserts per affected `P` key: membership residual `delete-key`s every currently-referencing `T.pk`, then the in-scope residual `upsert`s the survivors (deletes ordered before upserts so an unchanged in-scope row is refreshed).

The forward (`T`) path is unchanged — it already embeds the full WHERE, so a `T` write / FK-move that flips scope recomputes to zero rows and the delete-without-upsert removes the backing row.

## Review findings

Adversarial pass over commit `b89bb6ca`. Read the implement diff (source, tests, docs, sqllogic) with fresh eyes before the handoff.

### Soundness — checked, holds

- **The classification linchpin (the one genuine soundness risk).** Misclassifying a `P`-referencing WHERE as `T`-only would be unsound (upsert-only when a delete pass is needed). This can happen only if a `P`-referencing predicate fails to surface as a `FilterNode` in the analyzed plan (e.g. absorbed into an access-node constraint). **Verified at the source:** `optimizer.optimizeForAnalysis` runs `executeUpTo(PassId.Structural)` (`optimizer.ts:1051`); `PassId.Structural` is order 10 and physical access-path selection is `PassId.Physical` order 20 (`framework/pass.ts:63-152`). Structural pushdown *relocates* Filters but does not convert them to access constraints (that is a Physical concern), so the body WHERE always remains a `FilterNode`. Empirically confirmed by the white-box plan-selection test: the sargable predicate `p.score > 5` stays a Filter and builds a membership residual. The conservative direction (over-building delete-capable) is harmless; the unsound direction is closed.
- **A genuine `P` reference cannot resolve to a `T` column.** A base-table `P` column's `ColumnReferenceNode` carries `P`'s attribute id, absent from `T`'s `attrToCol` and from `producingByAttrId` (it is not a produced/output attr), so `resolveTransitiveSourceCol` returns `undefined` ⇒ counted as lookup-referencing. Verified by reading the resolver + the producing-expr collector.
- **Delete-key layout.** The membership residual is the WHERE-stripped body — same SELECT list ⇒ same projected output column order as the backing table — so `row[backingPkDefinition[i].index]` extracts `T.pk`, matching live backing keys. Each `T.fk` → exactly one `P`, so a membership delete never touches another `P`'s rows; a delete of an absent key is a layer no-op.
- **`P` insert/delete under RI.** A `P` delete is RI-admissible only when no `T` references it (membership residual returns ∅; nothing to delete). A `P` insert has no pre-existing referencing `T` (an FK to a not-yet-inserted `P` would violate RI), so ∅. Consistent with the no-WHERE arm.
- **Both-sides WHERE** classifies as delete-capable; the `T`-portion rides the forward path, the `P`-portion the reverse delete-capable path. Covered by an equivalence property suite and §24.5 (FK-move re-evaluating the `P`-side predicate).
- **Rebuild-suppression consistency.** Both body-plan builds (`buildMaintenancePlan` and `compileLookupMembershipResidual`) wrap in `withSuppressedMaterializedViewRewrite` so the residual reads sources, not the backing. Verified.

### Tests — run, pass, adequate

- `yarn typecheck` — clean. `yarn lint` (`src/**` + `test/**`) — clean.
- `maintenance-equivalence.spec.ts` — **51 passing**, including the 3 new `read(MV) == evaluate(body)` property suites (T-only / P-ref / both-sides, 80 runs each), the deterministic membership-flip edges (out-of-scope removes, into-scope adds, in-scope payload refreshes), and the white-box plan-selection block (T-only ⇒ no membership residual; P-ref / both-sides ⇒ present; volatile WHERE ⇒ declined → floor → UNSUPPORTED "non-deterministic").
- Full `logic.spec.ts` — **230 passing**, including `53-materialized-views-rowtime.sqllogic` §24.5 (T-side scope flips, P-side membership flips, FK-move re-evaluation, mid-txn flip + rollback) and the corrected §7 `ok_join_where` comment.
- Coverage spans happy path, edge cases (boundary-straddling predicate columns), error path (volatile reject), regression (all prior MV/covering/optimizer specs green), and interactions (in-txn reads-own-writes + rollback lockstep).

### Docs — read every touched file, accurate

- `docs/incremental-maintenance.md` § join-residual — rewritten WHERE-handling + delete-capable reverse residual; matches the implementation.
- `docs/materialized-views.md` — the eligibility-shape-4 paragraph (~132) and the detail-section `WHERE handling` paragraph (~304) read and confirmed accurate against the code (membership residual = `select T.pk … where P.pk = :pk0` **no WHERE**, delete-then-upsert). The reverse-path line (294) made precise. No stale text remains.

### Minor (noted, not blocking; no inline change warranted)

- **MV-over-MV cascade over a `P`-referencing-WHERE source is not *directly* tested.** The delete-capable path emits `delete-key` + `upsert` ops through the same `applyMaintenanceToLayer` → `BackingRowChange[]` cascade path that the forward path's delete-then-upsert uses, and that cascade *is* exercised by the existing MV-over-MV join suites — so the mechanism is covered, just not with this specific source shape. Left as a coverage observation.

### Known gaps carried from implement (reviewed; none are regressions, none filed)

- **`P` PK-changing updates** are not specially handled — consistent with the pre-existing no-WHERE join arm (under RI such a change either violates integrity or requires ON UPDATE CASCADE, which fires the forward path via the `T.fk` write). Unexercised, not a regression.
- **Compound-PK `P` lookups** are supported in principle (`pPkCols` is multi-column-capable) but suites use single-column PKs only.
- **Re-planning cost** — `compileLookupMembershipResidual` re-builds + re-optimizes the stripped body once at registration (one-time, per P-referencing-WHERE MV).
- `yarn test:store` not run (memory-backed default; the logic lives in the shared `Database`/manager path).

No major findings → no new fix/plan/backlog tickets filed. Minor findings handled inline (none required a code change).
