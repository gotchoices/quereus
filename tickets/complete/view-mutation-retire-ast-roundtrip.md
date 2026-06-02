description: Retired the plan→AST→re-plan double-plan in the multi-source `update`/`delete` substrate. Row identification + RETURNING now ride the already-planned join body (plan nodes — the derived backward walk), not a re-planned cloned-AST body. Reviewed; behavioral parity held except one DELETE-RETURNING regression (computed columns) now tracked by a fix ticket.
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, docs/view-updateability.md

## What landed

The two-table inner-join `update`/`delete` substrate now plans the join body **once**
(`analyzeJoinView`) and builds every backward decision (row identification + RETURNING)
as plan nodes over the planned body, retiring the `cloneFromClause` + `buildSelectStmt`
re-plan that previously ran inside each identifying subquery, the key capture, and the
RETURNING re-query. Mechanism, validation, and risk surface are in the implement commit
(`2ceacfb1`) and the prior review ticket body. `cloneFromClause` /
`buildIdentifyingSubquery` / `qualifyDomainToSide` deleted; `analyzeJoinView` threaded
once from `buildViewMutation` through `decompose*` + `buildIdentityCapture` +
`buildMultiSourceReturning`.

## Review findings

**Diff read first, fresh, before the handoff.** Reviewed `multi-source.ts`,
`view-mutation-builder.ts`, `docs/view-updateability.md`, and the touched/should-touch
test files. Ran `yarn workspace @quereus/quereus run lint` (clean) and
`yarn workspace @quereus/quereus test` (**4349 passing, 9 pending, 0 failing**) before
and after my test additions.

### Major — filed as a new ticket

- **Multi-source DELETE RETURNING of a body-COMPUTED view column throws an internal
  `No row context found` error (REGRESSION).** Discovered by adding the missing test:
  a join view with a computed output column (`c.note || '!' as banner`) deleted with
  `returning ... banner` (or `returning *`) crashes at runtime. **Root cause:** the new
  `buildDeleteReturning` / `buildViewOutputScope` references the planned body `root`'s
  *output* attribute ids; a computed column's fresh intermediate attr id is collapsed by
  the optimizer's project-merge, so the stacked outer reference dangles. Pass-through
  base columns survive (their output id == the leaf base id), which is why the
  implementer's base-column-only tests stayed green. The pre-refactor `select <returning>
  from <view>` re-query recomputed the column and worked — so this is a behavioral
  regression. Multi-source **UPDATE** RETURNING is unaffected (it recomputes in base
  terms via `buildReturningProjection`, the model for the fix). Tracked by
  **fix/view-mutation-multisource-delete-returning-computed-column** (full repro + fix
  direction: build DELETE RETURNING in base terms over `joinNode` timed `pre`,
  consolidating the duplicated DELETE-side helpers onto the UPDATE-side machinery).

### Minor — fixed inline (this pass)

- **Coverage gap (parity #3): single-side update to a SIMPLE-PK side with a
  COMPOSITE-PK *untouched* side was untested.** The refactor preserves this via
  `capturedSideIndices` (only the touched side's PK backs the capture, so the untouched
  composite key is never required), but nothing locked it in — a future change could
  silently regress it. Added `ax_jv_simpside` to `93.4-view-mutation.sqllogic` (passes).
- Added a placeholder note in `93.4` § `(c)` pointing at the computed-column fix ticket
  so the gap is visible at the test site.

### Checked and clear (explicitly, with reasons)

- **Shared `joinNode` between the `pre` capture and the `post` UPDATE-RETURNING re-query
  (implementer risk #1).** Not a stale-cache hazard: test `(d)` (line 1208) updates a
  predicate column and asserts the **post-mutation** value in RETURNING — it would
  return the stale `pre` value if the two occurrences folded to one cached scan. Green ⇒
  two independent scans. Confirmed.
- **Single-side identification timing (live → captured-`pre`, risk #2).** Equivalent for
  a lone op (nothing mutates before it; the capture is an uncorrelated set evaluated
  once). Nested-subquery-descent cases (e1/e2/g/h, 93.4) green.
- **`tags` threading on the new direct-`decompose*` path** (bypassing `propagate`):
  `tags` passed to `decompose*` equals the merged map `propagateMultiSource` would have
  read off `withTags(req, tags).tags` — `withTags` only sets `tags`. Equivalent.
- **No double-plan via the builder:** `buildViewMutation` computes `msAnalysis` once and
  calls `decompose*` directly; `propagate`/`propagateMultiSource` (which still calls
  `analyzeJoinView`) serves only the standalone `view-info.spec.ts` caller. `analyzeJoinView`
  runs exactly once per view mutation (down from twice for update-with-returning).
- **Key-column name/position alignment** across `capturedSideIndices` → `keyColumns`
  (`k0`/`k1` by `MS_UPDATE_KEY_COLUMNS[i]`) → `buildCapturedKeySubquery` → the context key
  ref: resolution is by column **name**, not numeric suffix, so a single-element
  `[k1]`-only capture resolves correctly.
- **Composite-PK requirement parity:** single-side write requires a single-column PK only
  on the touched side; an UPDATE-with-RETURNING forces both (its EXISTS needs `(k0,k1)`) —
  both match the retired path. The touched-composite-side rejection still fires
  (`ax_jv_comp`, line 301).
- **`inverse`-profile `domain` not threaded (risk #3):** unreachable today (no shipped
  domain-bearing profile); flagged in code. No behavior change.
- **Docs:** `docs/view-updateability.md` updated consistently across the phase table,
  Inner Join, `returning` Clauses, the lineage note, and the source-map bullets — read
  in full; reflects the new reality. (One residual inaccuracy: the `returning` Clauses
  delete bullet describes the `root`-projection path as the shipped DELETE-RETURNING
  mechanism; once the computed-column fix lands it should be re-described as the base-term
  `joinNode`-`pre` projection. Left for that ticket to keep docs honest with code.)

### Not done (deferred, with reason)

- `yarn workspace @quereus/quereus test:store` (LevelDB store path) — not run here; the
  change is planner-only but the store path exercises a different base-write code path.
  Left for CI / a human (store-mode run is the suggested check in the implement handoff).
- Expanding `property.spec.ts` View Round-Trip Laws to generate a computed output column
  on the delete-returning path — folded into the fix ticket's acceptance (it is the
  harness gap that let the regression through).
