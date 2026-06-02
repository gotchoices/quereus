description: Review the fix for multi-source (two-table inner-join) DELETE ... RETURNING of a body-COMPUTED view column. The DELETE RETURNING projection is now built in base terms over the planned `joinNode` (mirroring the UPDATE RETURNING path) instead of referencing the optimizer-eliminated intermediate output attribute id of the planned body `root`. The UPDATE and DELETE projection-lowering is consolidated onto a shared helper.
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, packages/quereus/test/property.spec.ts, docs/view-updateability.md

## What changed

**Root cause (validated in the fix stage).** `buildViewOutputScope` registered each
view-output column as a `ColumnReferenceNode` pointing at the planned body `root`'s
*output* attribute id. A pass-through projection (`c.cid as cid`) forwards the leaf base
attr id (survives project-merge → resolves); a computed projection (`c.note || '!' as
banner`) mints a fresh intermediate attr id at `root`'s ProjectNode that project-merge
collapses into an inline expression — so the outer DELETE RETURNING reference to it
dangles → `QuereusError: No row context found for column banner`. UPDATE RETURNING was
already green because it recomputes from base terms.

**Fix.** The multi-source DELETE RETURNING now mirrors the UPDATE path: project the
view-spelled RETURNING columns **recomputed in base terms** over the already-planned
`analysis.joinNode`, filtered by the identifying predicate (user WHERE → base ∧ body
WHERE), captured `pre`. Nothing references a fragile intermediate attribute id.

**Consolidation.**
- `multi-source.ts`: extracted `buildMultiSourceReturningProjection(ctx, view, analysis,
  filtered, returningCols)` — the projection-lowering both ops share, differing only in
  the `filtered` input relation. `buildMultiSourceUpdateReturning` now calls it.
- `multi-source.ts`: added/exported `buildMultiSourceDeleteReturning(ctx, view, stmt,
  analysis)` — builds the `pre` filter over `joinNode` via `buildIdentifyingPredicate`
  and delegates to the shared helper.
- `view-mutation-builder.ts`: the DELETE branch of `buildMultiSourceReturning` now calls
  `buildMultiSourceDeleteReturning`; the three now-dead helpers `buildDeleteReturning`,
  `buildViewOutputScope`, `buildViewReturningProjections` were deleted, and the new
  function added to the `../mutation/multi-source.js` import. No dangling imports
  (`RegisteredScope`/`ColumnReferenceNode`/`ProjectNode`/`Projection`/`FilterNode` all
  still used by the insert/decomposition paths).
- `docs/view-updateability.md` § RETURNING: the `delete` (`pre`) bullet rewritten to
  describe the base-term recomputation and why it fixes body-computed columns.

The encapsulation guard is inherited for free: `buildReturningProjection` already calls
`guardTopLevelScope` on each explicit RETURNING column, so a ref to a hidden base column
(not a view output) is still rejected.

## Use cases to validate (all green locally)

`93.4-view-mutation.sqllogic` section (c), `dr_p`/`dr_c`/`dr_jv` schema (the source-ticket
repro, computed col `banner = c.note || '!'`):
- `delete from dr_jv where cid = 1 returning cid, banner` → `[{"cid":1,"banner":"a!"}]`
  (the original repro — was throwing `No row context found`).
- `delete from dr_jv where cid = 2 returning *` → expands and computes `banner`.
- `delete from dr_jv where cid = 3 returning note || '+' as notex` → `[{"notex":"c+"}]`
  (computed RETURNING expr over a base-routed column).
- `delete from dr_jv where cid = 1 returning pref` → error `is not a column of the view`
  (hidden-base-column rejection — encapsulation-guard parity, fires at plan time).

`property.spec.ts` → "View Round-Trip Laws" → "multi-source inner join": new test
`delete RETURNING recomputes a body-computed view column from base terms` — view `jvc`
with `cvx = c.cv * 2`, fuzzed `delete ... where cc = K returning cc, cvx`, asserts the
returned rows recompute `cvx` from the pre-delete base value (60 runs).

## Validation run

- `yarn workspace @quereus/quereus test` → 4366 passing, 9 pending.
- `yarn workspace @quereus/quereus run lint` → clean.
- `yarn workspace @quereus/quereus run build` → clean.
- Targeted: `--grep "93.4"` (1 passing), `--grep "multi-source inner join"` (13 passing).

## Known gaps / reviewer attention

- **Scope is two-table single-column-PK inner joins.** A composite-PK *requested* side is
  rejected upstream (`unsupported-join`); `> 2`-table joins, self-joins, outer joins are
  Phase 2b+ (rejected at plan time). This fix does not widen that envelope — it only
  corrects the computed-column projection within the already-supported shape. Worth
  confirming the reviewer agrees no new shape was silently accepted.
- **DELETE timing is `pre`, UPDATE is `post`.** They now share the projection lowering but
  intentionally differ in filter + timing. The shared helper takes `filtered` as a param,
  so the two timings stay independent — verify the consolidation didn't accidentally
  couple them (e.g. the DELETE path must NOT use the EXISTS-over-capture filter, and the
  UPDATE path must keep it).
- **`store` path not run** (`test:store` is slow; per AGENTS.md it is for store-specific
  diagnosis). The change is purely planner-side projection construction, no storage code
  touched, so the memory-vtab run is representative — but a reviewer wanting belt-and-
  suspenders could run `yarn test:store` out-of-band.
- **`returning *` ordering.** The sqllogic `returning *` case asserts a single-row result;
  multi-row `returning *` ordering over a join delete is not separately asserted here
  (the UPDATE family covers multi-row ordering). Low risk, but not exhaustively pinned.
