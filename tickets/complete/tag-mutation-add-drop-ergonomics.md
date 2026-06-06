description: Per-key metadata-tag ergonomics on ALTER TABLE — `ADD TAGS (k = v)` (merge) and `DROP TAGS (k)` (delete keys) at the table / column / named-constraint sites, layered over the v1 whole-set `SET TAGS`. Reviewed and completed.
files:
  - packages/quereus/src/parser/ast.ts                            # setTags gained `mode`; new `dropTags` action
  - packages/quereus/src/parser/parser.ts                         # parseTagKeys() + ADD/DROP TAGS wiring at 3 sites; `(` look-ahead guard
  - packages/quereus/src/planner/nodes/alter-table-node.ts        # plan-side mode + dropTags; toString
  - packages/quereus/src/planner/building/alter-table.ts          # thread mode; build dropTags (no reserved validation)
  - packages/quereus/src/runtime/emit/alter-table.ts              # dispatch merge/drop; 6 new run* fns
  - packages/quereus/src/schema/manager.ts                        # mutateTagRecord core + per-site update*Tags + merge*/drop* setters
  - packages/quereus/src/emit/ast-stringify.ts                    # round-trip ADD/DROP TAGS + tagKeysBodyToString
  - packages/quereus/test/logic/50-metadata-tags.sqllogic         # Phases 25–31 (ADD/DROP at all sites + edge/adversarial cases)
  - packages/quereus/test/schema-manager.spec.ts                  # unit tests for merge*/drop* setters
  - packages/quereus/test/parser.spec.ts                          # parse + round-trip coverage incl. column-named-`tags`
  - docs/sql.md                                                   # §2.7 SET/ADD/DROP TAGS
  - docs/schema.md                                                # tag-drift store-persistence + reserved-validation reconciliation
prereq:
----

# Complete — ALTER TABLE … ADD TAGS / DROP TAGS (per-key tag ergonomics)

## What shipped

Two additive, imperative-only tag verbs over the existing catalog-only `SET TAGS`
(whole-set replace), at all three sites (table / column / named constraint):

```sql
alter table t add tags (audit = true);                       -- merge: set/overwrite `audit`, keep the rest
alter table t alter column c add tags (searchable = true);
alter table t alter constraint uq add tags (msg = 'dup');
alter table t drop tags (audit, legacy);                     -- delete keys (NOTFOUND, atomic, if any absent)
alter table t alter column c drop tags (searchable);
alter table t alter constraint uq drop tags (msg);
```

- `setTags` gained `mode: 'replace' | 'merge'` (`SET TAGS` → replace, `ADD TAGS` → merge);
  new sibling action `dropTags { target, keys[] }` (bare key list).
- Read-modify-write lives in `SchemaManager`, reading **live** tags at execution time via
  a DRY core `mutateTagRecord(current, {op})` + three private per-site `update*Tags` helpers
  shared by the replace / merge / drop setters; `freezeTags` owns the empty→`undefined` collapse.
- Catalog-only: no `module.alterTable`; fires `table_modified` via `commitTagUpdate`. The differ
  is unchanged (emits whole-set `SET TAGS` only).

## Review findings

Adversarial pass over the implement commit `c26c598a`. Build, lint, and the full quereus
test suite were re-run after my changes: **`build` EXIT 0, `lint` EXIT 0, `test` 4971 passing /
9 pending / 0 failing**.

### Checked — clean (no action)

- **DRY / modular core.** `mutateTagRecord` + the three `update*Tags` helpers collapse what
  would have been nine near-duplicate setters into a clean compute-then-commit shape. Each
  public setter is a one-liner. Good factoring; nothing to simplify.
- **Atomicity of DROP.** `mutateTagRecord` collects `missing` and throws **before** any
  `delete`; for the constraint site `compute(c.tags)` runs inside the array rebuild prior to
  `commitTagUpdate`, so a drop-of-absent NOTFOUND never commits. Verified across all three sites.
- **Type-safety enforces the invariant.** The discriminated union makes `mode` mandatory on
  every `setTags` and `keys` on every `dropTags`; the build passing proves every construction
  site (all in the parser) sets them. The differ (`schema-differ.ts`) only ever computes a
  whole `desiredTagSet` and emits `SET TAGS` — it never builds `merge`/`dropTags`. Confirmed by
  reference sweep + reading `schema-differ.ts`.
- **Parser disambiguation.** The `checkNext(1, LPAREN)` guard at the table level correctly
  routes `ADD/DROP TAGS (` to the tag op while `ADD tags integer` / `DROP [COLUMN] tags` stay
  column ops (`TAGS` is a contextual keyword). `parseTagKeys` mirrors `parseTags`' key
  consumption exactly. No guard needed at column/constraint sites (grammar is fixed there).
- **Reserved-tag validation.** `ADD TAGS` shares the `setTags` plan-build case, so it validates
  `quereus.*` keys identically to `SET TAGS`; `DROP TAGS` (removes by key) does not — correct.
- **`getLogicalAttributes`.** Spreads `...this.action`, so `mode` / `keys` surface in EXPLAIN.
  Acceptable as-is.
- **Round-trip.** `ast-stringify` renders `add tags` (merge) / `drop tags (…)` via the new
  `tagKeysBodyToString` (quotes keys, so `"quereus.id"` round-trips); parser round-trip test
  covers all six forms.

### Found + fixed inline (minor)

- **Stale, self-contradictory store-persistence docs (`docs/schema.md`).** The implementer
  correctly de-staled `docs/sql.md` to say tag mutations survive reconnect on store tables
  (the generic store subscribes to `table_modified` and re-persists catalog DDL — verified in
  `quereus-store/src/common/store-module.ts` `onEngineSchemaChange`/`persistCatalogIfChanged`,
  and the referenced `tag-mutation-store-persistence` ticket is in `complete/`). But the
  parallel passage in `docs/schema.md` § Tag-drift detection still claimed it was *not* persisted
  and pointed at that (now-complete) ticket as backlog — a direct contradiction. **Fixed**:
  reconciled schema.md to the verified behavior and noted ADD/DROP ride the same in-place path.
- **Incomplete reserved-validation doc (`docs/schema.md`).** The imperative-validation paragraph
  named only `SET TAGS`. **Fixed**: now states `SET TAGS` *and* `ADD TAGS` validate (shared
  build case) and `DROP TAGS` does not.
- **Adversarial edge cases were noted in the handoff as "decide / optionally pin" but had no
  test.** **Fixed**: added sqllogic Phase 31 pinning three of them:
  - ambiguous constraint name rejected on **ADD** and **DROP** (not just SET) — shares
    `resolveNamedConstraintClass`;
  - `DROP TAGS (a, a)` (same key twice) is harmless — removes the key, keeps the rest, no error;
  - merge-then-drop across separate statements composes on the live tag set.
  (One sqllogic line of mine initially used `temp` as a tag key, which is a contextual keyword
  `parseTags` rejects unquoted — a *test* bug, not a product bug; corrected to a plain key.)

### Major findings → new tickets

**None.** The implementation is correct, well-factored, and well-covered; no new fix/plan/backlog
tickets were warranted.

### Deliberately not done (with reason)

- **No `test:store` run in-ticket.** Out of scope per the plan ticket, and the store re-persist
  path is already covered by `quereus-store/test/tag-persistence.spec.ts` (which exercises
  `SET TAGS` through the same `table_modified` → catalog-rewrite path ADD/DROP ride). A
  store-side spec specific to ADD/DROP would be belt-and-suspenders, not a gate.
- **No `IF EXISTS` form for DROP TAGS.** Parked by design (a typo must fail loudly); a future
  soft-delete ergonomic would be a new ticket.
- **No pre-existing test failures** surfaced — nothing written to `.pre-existing-error.md`.
