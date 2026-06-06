description: Review the additive reserved-tag (`quereus.*`) validation now wired onto the two imperative `ALTER TABLE … ADD CONSTRAINT … WITH TAGS` and `ALTER TABLE … ADD COLUMN … WITH TAGS` arms at plan-build, plus the shared `columnTagDiagnostics` / `raiseStmtTagDiagnostics` extraction it shares with the direct CREATE path. Closes the last asymmetric authoring-surface gap (a typo'd / mis-sited reserved key was silently stored only via ALTER … ADD).
files:
  - packages/quereus/src/planner/building/tag-diagnostics.ts          # NEW shared helper module (columnTagDiagnostics + raiseStmtTagDiagnostics)
  - packages/quereus/src/planner/building/alter-table.ts              # addConstraint/addColumn arms now validate; setTags routed through shared helper
  - packages/quereus/src/planner/building/ddl.ts                      # raiseCreateTableTagDiagnostics reuses columnTagDiagnostics; local raiseStmtTagDiagnostics deleted (moved to shared module)
  - packages/quereus/src/schema/reserved-tags.ts                      # validateReservedTags + TagSite (reused as-is, unchanged)
  - packages/quereus/src/schema/reserved-tags-policy.ts               # raiseReservedTagDiagnostics (unchanged)
  - packages/quereus/test/logic/50-metadata-tags.sqllogic             # NEW Phase 24: ALTER-ADD reserved-tag cases
  - docs/schema.md                                                    # § Reserved-tag validation — documented the ADD arms + shared helper
----

# Review: ALTER TABLE ADD CONSTRAINT / ADD COLUMN reserved-tag validation

## What changed (and why)

Reserved-tag shape/site validation already fired on every CREATE-time authoring
surface and on `ALTER … SET TAGS`, but **not** on the two imperative `ALTER … ADD`
arms — so a typo'd or mis-sited `quereus.*` key (e.g. `quereus.bogus`, or a view-only
`quereus.update.default_for.<col>` placed on a physical constraint) was silently stored
when introduced via `ALTER … ADD CONSTRAINT/COLUMN`, even though the identical column /
constraint hard-errors at CREATE / `apply schema` / SET TAGS. This change closes that
gap. Pure additive validation: no behavior change for well-formed schemas — only a new
hard error at plan-build for a previously-silent typo/mis-site.

### Implementation

- **New `planner/building/tag-diagnostics.ts`** exports:
  - `columnTagDiagnostics(column)` — a column's own tags (`physical-column`) + each
    inline constraint's tags (`physical-constraint`), no `cc.name` guard (unnamed
    inline constraints carry no tags — the parser defers them to the column — so the
    constraint leg is a no-op for them).
  - `raiseStmtTagDiagnostics(diags, stmt)` — first-error-wins raise threading
    `stmt.loc`; warnings no-op. **Moved verbatim** out of `ddl.ts`.
- **`ddl.ts`**: `raiseCreateTableTagDiagnostics` now reuses `columnTagDiagnostics` for
  its per-column leg and imports the shared `raiseStmtTagDiagnostics`; the local copy
  was deleted. Table-level + table-constraint legs stay inline.
- **`alter-table.ts`**:
  - `addConstraint` arm validates `stmt.action.constraint.tags` at `physical-constraint`
    **before** constructing `AddConstraintNode`.
  - `addColumn` arm validates `columnTagDiagnostics(column)` **before** any
    backfill/check compilation (fail-fast).
  - `setTags` arm was **routed through the shared `raiseStmtTagDiagnostics`** (author's
    call — see "Decisions" below).

## Test coverage (this is a floor, not a ceiling)

Added **Phase 24** to `test/logic/50-metadata-tags.sqllogic` (mirrors Phase 23). All
green via `node test-runner.mjs` (full quereus suite: **4904 passing, 9 pending**).
Cases:

- ADD CONSTRAINT: typo'd key → `error: reserved tag`; mis-sited
  `quereus.update.default_for.id` → `error: not allowed`; valid
  `quereus.expose_implicit_index=true` on `ADD CONSTRAINT … UNIQUE` round-trips via
  `unique_constraint_info`; free-form tag round-trips (over-rejection guard).
- ADD COLUMN: typo'd **column** tag → `error: reserved tag`; typo'd **inline named
  constraint** tag → `error: reserved tag`; valid `quereus.id` on the column
  round-trips via `table_info`; valid `quereus.id` on an inline **named** constraint is
  **accepted** (column added); **unnamed** inline constraint's trailing `WITH TAGS`
  lands on the column and round-trips via `table_info`; free-form tags round-trip.

### Suggested reviewer attention / things I'd double-check

- **Multi-error ordering on CREATE changed (benign, please confirm).** Folding the
  per-column leg into `columnTagDiagnostics` interleaves a column's own-tag and its
  inline-constraint diagnostics, so the CREATE accumulation order went from
  `table → all-col-own → table-cons → all-col-cons` to
  `table → per-col(own+cons) → table-cons`. Under first-error-wins this only matters if
  one statement carries **both** an unknown-key (`reserved tag`) and a mis-sited key
  (`not allowed`) at sites whose relative order flipped — no existing test exercises
  that, and the `RsvMulti` test (table + column bad tags) still raises the table-level
  error first in both orderings. I judged it behavior-neutral; a reviewer may want to
  confirm nothing downstream depends on the exact diagnostic array order.
- **Adversarial cases worth adding** (I did not, to keep Phase 24 focused): an
  *unnamed* `ADD CONSTRAINT` form (`ALTER … ADD UNIQUE (col) WITH TAGS (…)` with no
  `CONSTRAINT <name>`) carrying a bad tag; a bad tag on an `ADD CONSTRAINT … FOREIGN
  KEY … WITH TAGS`; multiple bad tags in one ADD COLUMN (column + inline constraint) to
  pin down which error wins; a warning-severity tag (empty `quereus.lens.ack` rationale)
  to confirm it does **not** block on these arms (it shouldn't — but `lens.ack` is
  `logical-*` only, so on these physical sites it would actually `not allowed` first).

## Known gap (flagged honestly — NOT papered over)

The ticket's enumerated "valid `quereus.id` on ADD COLUMN's inline **named** constraint
→ round-trip via `unique_constraint_info`" case does **not** round-trip on the memory
module, because the module's ADD COLUMN path materializes only the column: `inline
UNIQUE is dropped (`columnDefToSchema` no-ops `unique`), and inline CHECK becomes a
row-constraint (`extractColumnLevelCheckConstraints`) not surfaced by
`unique_constraint_info`. This is a **persistence asymmetry orthogonal to this
validation ticket** — the *validation* (the deliverable) fires correctly regardless, so
Phase 24 asserts the inline-named-constraint case is **accepted** (column added, no
over-rejection) and covers the constraint-tag round-trip via the table-level
`ADD CONSTRAINT … UNIQUE` case instead. If the project wants ADD COLUMN inline
constraints to be first-class (materialized + tag-bearing), that is a separate
implement/backlog item, not a fix to this validation change. Reviewer's call whether to
spin a backlog ticket.

## Decisions

- **`setTags` routed through the shared helper** (the ticket left this author's call).
  It now threads `stmt.loc` into the sited error (previously the inline
  `raiseReservedTagDiagnostics` call did not), unifies all build-path tag surfaces on
  one policy site, and drops the now-unused `raiseReservedTagDiagnostics` import from
  `alter-table.ts`. No test asserted on the absence of `loc`, and the suite is green.
  Strict improvement + DRY; flagged here so the reviewer can veto if a location-less
  error was somehow intended.

## Validation status

- `yarn workspace @quereus/quereus build` — **clean** (exit 0).
- `node test-runner.mjs` (memory vtab) — **4904 passing, 9 pending**, exit 0.
- `eslint` on the three touched `src` files — **clean**.
- `test:store` **not run** — by construction this is a plan-build-time check (before any
  module write), so the store path is unaffected (per the ticket's own risk note); it is
  also the slower path. A reviewer wanting belt-and-suspenders can run `yarn test:store`.

## Risk

Low. Additive plan-build validation; no schema-hash / stored-row / physical-layout
effect. The only new observable behavior is a hard error for a previously-silent
typo/mis-site on the two ALTER … ADD arms, plus the (intended) addition of source
location to `ALTER … SET TAGS` sited errors.
