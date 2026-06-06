description: Review the per-key metadata-tag ergonomics on ALTER TABLE — `ADD TAGS (k = v)` (merge) and `DROP TAGS (k)` (delete keys) at the table / column / named-constraint sites, layered over the v1 whole-set `SET TAGS`.
files:
  - packages/quereus/src/parser/ast.ts                            # setTags gained `mode`; new `dropTags` action
  - packages/quereus/src/parser/parser.ts                         # parseTagKeys() + ADD/DROP TAGS wiring at 3 sites; `(` look-ahead guard
  - packages/quereus/src/planner/nodes/alter-table-node.ts        # plan-side mode + dropTags; toString
  - packages/quereus/src/planner/building/alter-table.ts          # thread mode; build dropTags (no reserved validation)
  - packages/quereus/src/runtime/emit/alter-table.ts              # dispatch merge/drop; 6 new run* fns; note text
  - packages/quereus/src/schema/manager.ts                        # mutateTagRecord core + per-site update*Tags + merge*/drop* setters
  - packages/quereus/src/emit/ast-stringify.ts                    # round-trip ADD/DROP TAGS + tagKeysBodyToString
  - packages/quereus/test/logic/50-metadata-tags.sqllogic         # Phases 25–30 (ADD/DROP at all sites + edge cases)
  - packages/quereus/test/schema-manager.spec.ts                  # unit tests for merge*/drop* setters
  - packages/quereus/test/parser.spec.ts                          # parse + round-trip coverage incl. column-named-`tags`
  - docs/sql.md                                                   # §2.7 SET TAGS subsection → SET/ADD/DROP TAGS
prereq:
----

# Review — ALTER TABLE … ADD TAGS / DROP TAGS (per-key tag ergonomics)

## What shipped

Two **additive, imperative-only** tag verbs over the existing catalog-only `SET TAGS`
(whole-set replace), at all three sites (table / column / named constraint):

```sql
alter table t add tags (audit = true);                       -- merge: set/overwrite `audit`, keep the rest
alter table t alter column c add tags (searchable = true);
alter table t alter constraint uq add tags (msg = 'dup');
alter table t drop tags (audit, legacy);                     -- delete keys (NOTFOUND, atomic, if any absent)
alter table t alter column c drop tags (searchable);
alter table t alter constraint uq drop tags (msg);
```

AST/plan model (settled in the plan ticket — implemented as written):
- `setTags` gained `mode: 'replace' | 'merge'`. `SET TAGS` → `replace`, `ADD TAGS` → `merge`.
  Every existing `setTags` construction site now sets `mode` explicitly.
- New sibling action `dropTags { target, keys: string[] }` (bare key list, no `= value`).
- Both unions are mirrored independently in `parser/ast.ts` and `planner/nodes/alter-table-node.ts`.

The read-modify-write lives in `SchemaManager` and reads the **live** tags at execution time
(via `getTable(name)`), not the plan-time snapshot — correct for prepared-statement reuse and
back-to-back ALTERs. DRY core: `mutateTagRecord(current, {op})` + three private per-site
`update*Tags(name, compute, schema?)` helpers shared by the replace/merge/drop public setters.
`freezeTags` still owns the empty→`undefined` collapse.

Catalog-only, exactly like `SET TAGS`: no `module.alterTable`; fires `table_modified` via
`commitTagUpdate`. The differ is **unchanged** (still emits whole-set `SET TAGS`); ADD/DROP are
not emitted by `generateMigrationDDL`.

## Validation performed (all green)

- `yarn workspace @quereus/quereus run build` → EXIT 0 (no tsc errors).
- `yarn workspace @quereus/quereus run test` (memory-backed default) → **4971 passing, 9 pending, 0 failing**.
- `yarn workspace @quereus/quereus run lint` → EXIT 0 (clean).
- Targeted: `parser.spec.ts` + `schema-manager.spec.ts` (148 passing); `50-metadata-tags.sqllogic` passing.

## Resolved-design invariants the reviewer should confirm are honored

- **DROP of an absent key → NOTFOUND, atomic.** Every listed key validated *before* any
  mutation; a partial/typo'd drop leaves the catalog untouched. Implemented in
  `mutateTagRecord` (collect `missing`, throw before deleting). For the constraint site the
  compute runs inside the array `.map()` *before* `commitTagUpdate`, so a throw never commits.
  Covered: sqllogic Phase 26/27/28 (NOTFOUND + survivor assertions) and schema-manager.spec
  "atomic" cases (table/column/constraint).
- **DROP-to-empty → `tags IS NULL`** (collapses via `freezeTags`). Covered.
- **Empty list is a no-op for ADD/DROP** (`add tags ()` / `drop tags ()` change nothing),
  deliberately distinct from `set tags ()` (clears). Covered (sqllogic + schema-manager.spec).
- **ADD with null value stores key-present-null** (distinct from drop). Asserted via
  `json_type(tags,'$.k')` = `'null'` vs SQL `null` for absent. Covered (sqllogic Phase 25).
- **Case-sensitive / verbatim keys** on both merge and drop. Covered (schema-manager.spec
  `Audit` vs `audit`).
- **ADD validates reserved keys** at the matching site (same `validateReservedTags` +
  `raiseStmtTagDiagnostics` as SET, since both carry `stmt.action.tags`); **DROP does NOT**
  (removes by key — dropping a reserved override is legitimate). Covered (sqllogic Phase 29,
  schema-manager.spec drop-reserved case).
- **Column-named-`tags` disambiguation at the table level.** Only `ADD TAGS (` / `DROP TAGS (`
  (TAGS immediately followed by `(`, via `checkNext(1, LPAREN)`) routes to a tag op;
  `ADD tags integer` / `DROP [COLUMN] tags` still parse as column ops. (`TAGS` is a contextual
  keyword = plain identifier, so the `(` guard is load-bearing.) At the column / constraint
  levels TAGS is unambiguous after `ADD|SET|DROP`, so no guard there. Covered (parser.spec +
  sqllogic Phase 30).
- **Named-constraint resolution** (NOTFOUND / ambiguous via `resolveNamedConstraintClass`),
  **column NOTFOUND**, **schema-hash neutrality** (tags excluded) — all inherited from the
  shared per-site cores / existing infra.

## Known gaps / things to scrutinize (your work is a floor, not a finish line)

- **Store persistence not exercised in-ticket.** Per the plan ticket this was explicitly *not*
  a gate. ADD/DROP ride the identical `commitTagUpdate → table_modified` path that `SET TAGS`
  uses, and the generic store re-persists catalog DDL off that event, so they *should* survive
  reconnect on a store table — but I did not run `yarn test:store`. A store-side spec or a
  `test:store` pass would close this. (Index/view/MV tag persistence remains pending per the
  pre-existing backlog tickets, unaffected here.)
- **`getLogicalAttributes` not changed explicitly.** It spreads `...this.action`, so `mode`
  (on setTags) and `keys` (on dropTags) already surface in EXPLAIN attributes. Intentional —
  but verify you're comfortable with the implicit pass-through vs. an explicit projection.
- **`ast-stringify` round-trip.** `setTags` now renders `add tags` when `mode==='merge'`
  (else `set tags`); new `dropTags` renders `drop tags (k, …)` via the added
  `tagKeysBodyToString`. A parser round-trip test (`parse → astToString → parse`, compare
  `.action`) guards all six forms. The differ only ever builds `mode:'replace'` setTags, so its
  emitted SQL is unchanged — worth a glance to confirm no differ path can emit `merge`/`dropTags`.
- **No `IF EXISTS` form** for DROP TAGS (parked by design — a typo must fail loudly). If a
  follow-up wants soft-delete ergonomics, that's a new ticket.
- **`mutateTagRecord` merge does a shallow object spread.** Tag values are scalars
  (`SqlValue`), so shallow is correct; flagged only so you don't expect deep-merge semantics
  for any future nested-value tag.

## Suggested adversarial checks

- A drop where the SAME key is listed twice (`drop tags (a, a)`): currently the first delete
  removes it, the second is a redundant `delete` on an already-deleted key — no error (the
  presence check ran against the original set where `a` existed once). Decide whether that's
  acceptable (it is harmless) or should dedup/reject.
- Merge then drop in one batch across a prepared statement; confirm live-read semantics hold
  (sqllogic Phase 25 covers back-to-back merge; extend to merge-then-drop if you want belt-and-suspenders).
- Ambiguous constraint name with ADD/DROP (not just SET) — should reject as ambiguous
  identically (shares `resolveNamedConstraintClass`); add a sqllogic line if you want it pinned.
