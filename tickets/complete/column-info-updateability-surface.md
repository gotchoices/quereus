description: The shipped `column_info(name)` TVF — the per-column updateability surface (`information_schema.columns.is_updatable`) covering every column of every base table and plain view, the column-granular companion to `view_info()`.
files: packages/quereus/src/func/builtins/schema.ts, packages/quereus/src/func/builtins/index.ts, packages/quereus/test/logic/06.3.5-column-info.sqllogic, docs/view-updateability.md
----

## What shipped

A `column_info(name)` table-valued function in
`packages/quereus/src/func/builtins/schema.ts`, registered in `index.ts` next to
`viewInfoFunc`. It resolves **either** a base table (`db._findTable`) **or** a
plain view (first `getView` hit across schemas, main→temp→attached) and emits one
row per output column: `schema`, `name`, `cid`, `column_name`, `is_updatable`
(`'YES'`/`'NO'` text), `base_table`, `base_column`. Base-table updateability is
`!col.generated`; view updateability is read from the logically-planned body's
backward `updateLineage` via the shared `baseSiteOf` / `buildTableRefsById`
helpers. Unknown name throws `'<name>' not found`; a body that fails to plan or
yields no relational output produces no rows (logged, never throws). See
`docs/view-updateability.md` § Per-column updateability for the full surface.

## Review findings

**Diff reviewed first, then the handoff.** The implement diff (`bcfc82c4`) was
read with fresh eyes against `deriveViewInfo`, `baseSiteOf`,
`hasNullExtendedLineage`, the `06.3.4-view-info` outer-join coverage, and the
open `view-info-non-inner-join-overreport` ticket before reading the handoff
summary.

### Fixed in this pass (minor)

- **Outer-join YES-when-NO over-report (the implementer's flagged highest-risk
  item — confirmed a real bug, fixed).** `deriveColumnInfo` ran `baseSiteOf` per
  attribute with no gate. `baseSiteOf` *unwraps* `null-extended`, so a
  LEFT/RIGHT/FULL outer-join view reported preserved- *and* non-preserved-side
  columns as `is_updatable='YES'` with a base trace — even though `propagate()`
  rejects the whole outer join wholesale (`collectInnerJoinSources` accepts only
  inner equi-joins), and `view_info()` short-circuits the same body to all-`NO`
  via `hasNullExtendedLineage`. Verified against `06.3.4-view-info`'s `oj_left`
  case (`update oj_left … → error: cannot write through view`). **Fix:** mirror
  `deriveViewInfo`'s Divergence-2 gate — compute `hasNullExtendedLineage(nodes)`
  once and force every column to `'NO'`/`null` when set (reusing the existing
  helper; no new mechanism). Added an `oj_left` case to
  `06.3.5-column-info.sqllogic` pairing the all-`NO` expectation with the real
  `update … → error: cannot write through view` rejection. Corrected
  `docs/view-updateability.md` § Per-column updateability, which had documented
  the `null-extended` unwrap as *intended* — removed that phrasing and added an
  "Outer-join gate (shared with `view_info`'s Divergence 2)" paragraph.

### Filed as new ticket (major)

- **Non-inner-join over-report (cross / comma / >2-table) →
  `tickets/fix/column-info-non-inner-join-overreport.md`.** The exact YES-when-NO
  class that `view-info-non-inner-join-overreport` already tracks for the
  view-level surface, but at column grain. These shapes carry **strict-`base`**
  lineage (no `null-extended`), so the outer-join gate fixed above does not catch
  them: `propagateMultiSource` accepts only two-table inner equi-joins, yet
  `column_info` resolves each passthrough column to a base ref and reports
  `'YES'`. The fix needs the same AST/plan shape-check the sibling ticket will
  build, so the new ticket carries `prereq: view-info-non-inner-join-overreport`
  to reuse that helper (the way `hasNullExtendedLineage` / `buildTableRefsById`
  are shared today). Major because it needs a new mechanism, not an inline tweak,
  and is best landed alongside the view-level fix.

### Checked, no change needed

- **Base-table path** (generated columns read-only with null trace, `cid` =
  column index matching `table_info.cid`, all-non-generated updatable tracing to
  self): correct and covered by `06.3.5` (`t`, `g`).
- **View resolution / precedence** (base table before view, first `getView`
  across schemas in `_findTable` order), **error posture** (unknown→throw,
  unplannable body→no rows logged), **MV not-found**: consistent with
  `view_info` / `table_info`; correct.
- **Non-null assertions** `ref!` / `bs!` are guarded by `updatable = !!(bs &&
  ref)`; no unsafe deref.
- **`relationalAdvertisement` key** `[[{index:2}]]` (`cid`) is genuinely unique
  per emitted row (single object, distinct ordinals).
- **Shared-helper extraction** (`buildTableRefsById`) is a clean DRY win with
  `deriveViewInfo`; no behavior change to `view_info` (goldens unchurned).
- **Docs sweep:** `view_info` is referenced only in `docs/view-updateability.md`
  among non-ticket docs; no other surface enumerates the introspection TVFs, so
  no further doc needed updating. `docs/view-updateability.md` § Implementation
  Surface already names `column_info`.
- **Re-plans on every call** (no caching) and **loose VALUES column-name
  assertions**: acceptable introspection-surface posture, matching
  `deriveViewInfo`; left as-is (the implementer's notes 3–4).
- **`test/quereus/` spec cross-check** (the implementer's optional note 2): not
  added — the sqllogic coverage is sufficient and was strengthened with the
  outer-join case; the invariant is locked behaviorally rather than via a
  separate unit spec.

### Validation

- `yarn workspace @quereus/quereus run build` — clean.
- `yarn workspace @quereus/quereus test` — **4236 passing, 9 pending** (full
  suite, includes the strengthened `06.3.5-column-info.sqllogic`; no
  `view_info` / `table_info` golden churn).
- `yarn workspace @quereus/quereus run lint` — clean.

No pre-existing test failures surfaced.
