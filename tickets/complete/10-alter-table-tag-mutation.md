description: ALTER TABLE … SET TAGS — whole-set metadata-tag mutation at the table / column / named-constraint sites, plus declarative tag-drift detection that emits SET TAGS. Catalog-only (no module round-trip). Implemented, reviewed, and complete.
files:
  - packages/quereus/src/parser/ast.ts
  - packages/quereus/src/parser/parser.ts
  - packages/quereus/src/planner/nodes/alter-table-node.ts
  - packages/quereus/src/planner/building/alter-table.ts
  - packages/quereus/src/runtime/emit/alter-table.ts
  - packages/quereus/src/schema/manager.ts
  - packages/quereus/src/schema/schema-differ.ts
  - packages/quereus/src/emit/ast-stringify.ts
  - docs/sql.md
  - docs/schema.md
  - packages/quereus/test/logic/50-metadata-tags.sqllogic       # Phases 11–16 (16 added in review)
  - packages/quereus/test/schema-manager.spec.ts
  - packages/quereus/test/declarative-equivalence.spec.ts
  - packages/quereus/test/emit-roundtrip.spec.ts
  - tickets/backlog/tag-mutation-add-drop-ergonomics.md          # filed (per-key ADD/DROP TAGS)
  - tickets/backlog/tag-mutation-store-persistence.md            # filed (store re-persist of catalog-only swaps)
  - tickets/backlog/create-reserved-tag-validation.md            # filed in review (CREATE-path reserved-tag parity)
----

# ALTER TABLE … SET TAGS (table / column / named-constraint tag mutation) — COMPLETE

`ALTER TABLE … SET TAGS` is the SQL surface for whole-set replacement of metadata
tags after creation, at the three sites under `ALTER TABLE`:

```sql
alter table t set tags (display_name = 'Orders', audit = true);   -- replace table tags
alter table t set tags ();                                        -- clear all table tags
alter table t alter column c set tags (searchable = true);        -- replace column c's tags
alter table t alter constraint uq_email set tags (msg = 'dup');   -- replace constraint tags
```

Whole-set replacement is the single primitive (empty list = clear). The mutation
is **catalog-only**: the SchemaManager setter swaps the in-memory `TableSchema`,
re-registers it, and fires `table_modified` — no `module.alterTable` round-trip.
The declarative differ detects tag drift at all three sites (rename hints
excluded from the compare) and emits the matching `SET TAGS` forms after the
structural ALTER phases. See `docs/sql.md` §2.7 and `docs/schema.md` for the full
behavior contract.

## Review findings

Adversarial pass over the implement diff (`25064ff2`). Read the full diff with
fresh eyes before the handoff summary; scrutinized parser/planner/runtime/differ/
stringify/manager + docs + tests.

### Validation (all green)
- `yarn workspace @quereus/quereus run typecheck` → clean.
- `yarn workspace @quereus/quereus test` → **4759 passing, 9 pending, 0 failing**.
  (Count unchanged after adding Phase 16 — each `.sqllogic` file is a single
  mocha `it`, so a new block inside `50-metadata-tags.sqllogic` adds assertions,
  not test cases. Verified the file passes in isolation with the new block.)
- `eslint` over the 11 ticket-touched `src/` + `test/` files → clean.

### Findings & disposition

**MINOR — fixed in this pass:**
- **Gap #4 (ambiguous constraint name was implemented but untested).**
  `setConstraintTags` rejects a name present in >1 constraint class, but the path
  was unverified and the implementer was unsure it was even constructible.
  Confirmed by probe that a cross-class duplicate name **is** constructible —
  `CONSTRAINT dup UNIQUE (x)` + `CONSTRAINT dup CHECK (x > 0)` on one table is
  accepted (no create-time dedup across classes) — and that
  `ALTER CONSTRAINT dup SET TAGS (…)` then correctly raises "ambiguous". Added
  **Phase 16** to `test/logic/50-metadata-tags.sqllogic` covering this (`-- error:
  ambiguous`). The path is reachable and correct.

**MAJOR — filed as new ticket(s):**
- **Gap #2 (CREATE vs ALTER reserved-tag asymmetry) — confirmed real, filed
  `backlog/create-reserved-tag-validation`.** Probed: `create table t (…) with
  tags ("quereus.bogus" = 1)` and the column-level equivalent are both **accepted**
  (silently stored), while the equivalent `SET TAGS` rejects them. The direct
  CREATE path never routes tags through `validateReservedTags`, so a typo'd
  reserved key enters the catalog through the most common authoring path. Fixing
  it means routing CREATE-time tags through the registry across table/column/
  constraint (and arguably index/view) sites and *starts rejecting* previously-
  accepted schemas — too broad and behavior-changing for an inline fix. Filed.

**NOTED — acceptable as-is / already filed, no action:**
- **Gap #1 (store persistence) — decided: does NOT block complete.** `SET TAGS`
  is catalog-only by design; store-backed tables re-persist DDL only from
  `module.alterTable`, which tag-only swaps bypass, so a tag change is not
  re-persisted across reconnect. This is a **pre-existing** gap that the
  programmatic `setTableTags` already had — the new SQL surface only makes it
  reachable. The engine change is module-agnostic and the store path is untouched,
  so `yarn test:store` was not required for this ticket. Already filed
  `backlog/tag-mutation-store-persistence` (with the recommended `table_modified`
  subscription fix) and documented in `docs/schema.md` / `docs/sql.md`.
- **Gap #3 (constraint rename + tag change combined).** Differ emits constraint
  tag changes for name-matched constraints only; a renamed-and-retagged constraint
  won't get its tags updated. Bounded by a pre-existing limitation —
  `generateMigrationDDL` emits no constraint rename primitive at all (named-
  constraint renames fall through to the drop+recreate buckets, where a recreate
  carries the declared tags anyway). Acceptable for v1.
- **Gap #5 (`setTableTags` now fires `table_modified`).** Additive behavior change,
  shared via the new `commitTagUpdate` helper (mirrors `add-constraint.ts`'s
  existing pattern). Full suite green — no schema-change listener misbehaves on a
  tag-only swap.
- **Gap #6 (logical/lens tables).** `ALTER TABLE` on a logical table errors via the
  generic table-not-found path in `buildTableReference` (logical tables register
  as views). Generic, clean.
- **Gap #7 (emit-roundtrip property generator).** Does not synthesize `setTags`
  actions; the four explicit string round-trips (incl. empty `()`) added by the
  implementer exercise the empty≡absent equivalence. The comparator handles the
  `tags` key generically — no comparator change needed.
- **Pre-existing lint noise (out of scope).** `yarn workspace @quereus/quereus run
  eslint` (whole-package) reports ~8100 `no-undef` errors, but **all** are in
  untouched root `.mjs` scripts (`test-runner.mjs`, `register*.mjs`,
  `mutation-subsystem.mjs`) lacking node globals in the eslint config — not in any
  file this ticket touched. The 11 ticket-touched files lint clean. Flagging as a
  pre-existing config gap, not a regression; not chased here.

### Correctness aspects checked (no issues)
- **Differ push-guard** widened correctly; a tags-only column change is already
  covered by the existing `columnsToAlter.length > 0` arm, and table/constraint
  tag-only changes by the two new arms.
- **DDL phase ordering** — tag phase emits *after* rename/add/alter/pk/drop, so a
  `SET TAGS` on a renamed column/constraint targets the post-rename name
  (`columnName` is the declared/new name). Verified against `generateMigrationDDL`.
- **Rename-hint exclusion** — `quereus.id` / `quereus.previous_name` stripped from
  the order-independent `stableStringify` drift compare (so a hint-only declaration
  doesn't churn a `SET TAGS` post-rename); behavioral reserved tags are compared.
  Covered by the new declarative-equivalence tests.
- **Catalog-only setters** re-fetch the live schema by name (stale captured schema
  is not a hazard); attribute preservation (nullability/type/default/PK) holds for
  `setColumnTags`; `freezeTags` collapses empty→`undefined` so `tags IS NULL` and
  the differ's "no tags" both hold.
- **Doc accuracy** — `check_constraint_info()` / `unique_constraint_info()` TVFs
  referenced by the docs/tests exist and surface a `tags` column; `docs/sql.md`
  EBNF + §2.7 and `docs/schema.md` tag-drift section reflect the shipped behavior.
- **Node plumbing** — `AlterTableNode.toString` has an exhaustive `setTags` arm;
  `getLogicalAttributes` / `computePhysical` are generic and need no per-action
  change; runtime `note` arm present.
