description: Relaxed the plan-time `mutual-fk-restrict-delete` reject so it fires only when the view's join provably correlates a mutual-FK edge; a join on non-FK columns now falls back to the fixed `[0,1]` fan-out and defers to runtime FK enforcement, fixing the data-independent over-rejection. Reviewed: design sound, validation green, one DRY extraction + one WHERE-correlation golden added inline.
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/mutation/single-source.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, docs/view-updateability.md
----

## What shipped (implement stage)

`decomposeDelete` (`multi-source.ts`) used to raise `mutual-fk-restrict-delete` at
plan time **whenever** `orderDeleteFanout(analysis.sides) === undefined` — a schema-only
predicate that never inspects the join or the rows, so a view over a mutual
`restrict`/`restrict` (or `restrict`/`cascade`) FK pair was rejected up front regardless
of the data, even when the specific joined rows do not cross-reference and the delete
would succeed.

The fix gates the reject on a new helper **`joinCorrelatesMutualFk(analysis)`**: when
`orderDeleteFanout` returns `undefined`, the reject now fires **only if** the join
provably correlates at least one mutual FK edge (its cross-side equalities — from the ON
condition *and* the body WHERE, flattened on `AND` — force a child's FK column(s) equal
to the parent's referenced column(s)). Otherwise the planner sets `order = [0, 1]` and
defers to runtime FK enforcement. `orderDeleteFanout` / `inboundDeleteAction` /
`deletableFirst` are unchanged. `flattenAnd` was exported from `single-source.ts` for reuse.

## Review findings

**Method:** read the implement diff (`56d729af`) cold before the handoff; traced the
gate against every existing fan-out golden (fo-a..fo-j) and the two new ones (fo-k/fo-l);
ran build + lint + full test suite (twice — baseline and after my edits).

### Correctness — no defects found
- **The "at least one edge ⇒ reject" gate is sound.** `orderDeleteFanout` returns
  `undefined` only for a genuine mutual-FK deadlock (both directions blocked under
  immediate enforcement). When an edge is correlated, that edge's child row *necessarily*
  references the joined parent, so deleting the parent provably trips a RESTRICT (or a
  cascade-into-RESTRICT) — the reject is justified. When *neither* edge is correlated, no
  RESTRICT is provable at plan time, so deferring to runtime FK enforcement is safe (the
  runtime pre-check is the same one a direct base delete gets).
- **Fallback never corrupts data.** Every relaxed path routes to the pre-existing `[0,1]`
  fan-out, whose per-base-op FK checks + commit-time deferred-constraint queue enforce
  integrity identically to a direct base delete. A referencing delete is rejected
  (atomically — confirmed by fo-l and the new fo-m, where the error fires and *both* base
  rows survive); only a non-referencing delete (NULL FK cols, MATCH SIMPLE) succeeds.
- **Edge-by-edge trace of fo-g/fo-h confirmed** they still correlate edge B (`on b.aref =
  a.aid`) and keep rejecting; fo-i/fo-j never reach the helper (valid order returned).
- The `(fo-l)` error-message deviation the implementer flagged (raw `CHECK constraint
  failed: _fk_l_b_aref` from the per-base-op parent-side FK NOT EXISTS check, rather than
  the ticket's anticipated runtime RESTRICT pre-check message) is **accepted as-is**: the
  net behavior is identical (delete rejected, both rows preserved, raw FK error instead of
  the actionable diagnostic), and pinning the exact constraint name is *better*
  documentation of which check fires. The sqllogic substring match makes it robust.

### Design / DRY — one cleanup applied inline
- **Extracted `fkTargetsSide(fk, child, parent)`** as the single source of truth for the
  FK-match predicate (`referencedTable` / `referencedSchema`, case-insensitive,
  defaulting an absent `referencedSchema` to the child's schema). It was duplicated
  *verbatim* across `fkChildIndex`, `inboundDeleteAction`, and the new `edgeCorrelated`
  (the implementer's doc comments explicitly noted the mirroring). Refactored all three
  call sites to use it — no behavior change, confirmed by the full suite staying green.

### Tests — one coverage gap closed inline
- **Added golden (fo-m): the WHERE-correlation branch.** The implementer flagged that
  `joinCorrelatesMutualFk` folds `analysis.sel.where` conjuncts into the cross-equality
  set (a supported path — `buildIdentifyingPredicate` confirms body-WHERE join views are
  real), but shipped no golden for it. fo-m is a `restrict`/`restrict` mutual FK whose
  join ON is on a non-FK column (`a.lbl = b.lbl`, correlating neither edge) but whose body
  WHERE (`b.aref = a.aid`) correlates edge B — so the plan-time reject must still fire.
  Verified it does (error `mutual foreign key`, both rows survive). This exercises the
  previously-uncovered `if (analysis.sel.where) …` branch of the gate. (Initial draft hit
  a circular insert-time FK chicken-and-egg — corrected to the established insert-NULL-
  then-back-fill pattern used by fo-g/fo-l.)
- Happy path (fo-k), residual raw-error path (fo-l), regressions (fo-g..fo-j), and now
  the WHERE-fold path (fo-m) are all covered. The 93.4 file is a single mocha case, so the
  suite total (4411 passing / 9 pending) is unchanged; the new golden was verified passing
  both in isolation and in the full run.

### Edge cases probed — left as documented residuals (no ticket warranted)
- **Ambiguous unqualified join column** (`resolveColumnSide` returns `undefined` when a
  name exists on both sides) → under-detect → fallback → raw runtime FK error instead of
  the actionable diagnostic. Conservative and *safe* (runtime enforcement is the
  backstop); views normally qualify join columns. Diagnostic-quality degradation only, in
  an exotic shape — documented in the implementer's known-gaps and in the helper docstring.
- **Qualifier matching both a side's `schema.name` and the other side's `alias`**
  (`findIndex` returns the first match): a table named identically to the other side's
  alias could mis-resolve. Extremely exotic; worst case is a wrong correlation verdict
  that still cannot corrupt data (runtime FK enforces either way). Not worth guarding.
- **Composite-PK / composite-FK:** the helper generalizes via all-pairs, but a composite-PK
  side is rejected downstream (`requireSingleColumnPk` → `unsupported-join`) on the
  non-correlated fallback path, or by the mutual-fk reject first on the correlated path —
  both safe rejects, no surprising non-rejecting outcome. No reachable shape produces data
  corruption; no golden added (composite-PK join views are rejected upstream regardless).

### Docs — verified current
- `docs/view-updateability.md` § Inner Join — Deletes documents the correlation gate, the
  non-FK-join fallback to runtime enforcement, and both directions of the accepted residual
  conservatism. Confirmed it reflects shipped behavior. No other doc references
  `mutual-fk-restrict-delete` (searched); `mutation-diagnostic.ts`'s reason-code comment is
  a general description and needs no change.

### Validation (all green, after my edits)
- `yarn workspace @quereus/quereus build` — exit 0.
- `yarn workspace @quereus/quereus lint` — exit 0.
- `yarn workspace @quereus/quereus test` — **4411 passing, 9 pending**. The
  `[property-planner] Rule '…' never fired` lines are pre-existing informational notes
  (suite exits 0), not failures.

**Disposition:** no major findings → no new tickets filed. Two minor improvements (DRY
extraction, WHERE-correlation golden) applied inline. Implementation is sound and ready.
