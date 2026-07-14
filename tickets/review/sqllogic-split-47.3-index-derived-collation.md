description: |
  Split a test file that mixed a backend-portable scenario with one backend-specific scenario, so the
  portable part can run everywhere instead of failing the whole file on backends that don't support it.
files:
  - packages/quereus/test/logic/47.3-upsert-conflict-target-collation.sqllogic  # § 6 removed; § 7/§ 8 renumbered § 6/§ 7; sibling pointer added
  - packages/quereus/test/logic/47.3.1-upsert-conflict-index-derived-collation.sqllogic  # NEW — carved-out scenario
difficulty: easy
---

# Split 47.3 § 6 (index-derived UNIQUE collation) into its own `.sqllogic` file — done

## What changed

- **New file** `47.3.1-upsert-conflict-index-derived-collation.sqllogic`: contains exactly the carved-out
  scenario — `create unique index idx_tag_nc on idx_coll (tag collate nocase)`, then an `on conflict (tag) do
  update` upsert proving the enforcement collation comes from the INDEX (NOCASE), not the column's declared
  BINARY. Header explains the carve-out rationale and cross-references
  `unique-enforcement-collation.spec.ts` as the sibling unit-test coverage.
- **Edited** `47.3-upsert-conflict-target-collation.sqllogic`:
  - Removed the old § 6 block (banner comment through `drop table idx_coll;`) verbatim — no SQL in the
    surviving sections was touched, only banner-comment numbers.
  - Renumbered trailing banners: old § 7 (WHERE guard) → § 6, old § 8 (multi-row insert) → § 7.
  - Added a one-line pointer near the top header (next to the existing 47.4 sibling note) that the
    index-derived-collation scenario now lives in `47.3.1-...`.
- Neither file was added to `MEMORY_ONLY_FILES` in `logic.spec.ts` — both run on memory and store, as
  required (store supports `create unique index`; NOCASE enforcement holds there via full-scan
  re-validation).

## Why (context for reviewer)

47.3's actual subject — upsert conflict-target matching uses the enforcement *collation*, not byte identity
— is backend-portable via column/table-level UNIQUE constraints. Only the removed scenario depended on a
standalone `create unique index` with a per-column `COLLATE` override, which some backends (e.g. downstream
lamina) don't support. Splitting it out means the bulk of 47.3 runs everywhere; only the genuinely
index-dependent scenario lives somewhere that can be skipped/pinned per-backend. Full rationale for *why not
migrate instead of split* (table-level `unique (col collate x)` doesn't carry a per-column collation override
into the schema — see `extractUniqueConstraints` / `uniqueEnforcementCollations` in
`packages/quereus/src/schema/manager.ts` and `packages/quereus/src/schema/unique-enforcement.ts`) is in the
original ticket body if the reviewer wants the deeper trace; not re-derived here since no code changed, only
test-file structure.

## Validation performed

- `yarn test` (memory backend, from `packages/quereus`): 6587 passing, 13 pending, **1 failing** — but the
  failure is `view-mv-ddl-persistence.spec.ts` (materialized-view re-materialization timeout), unrelated to
  this diff (no `.ts` source touched, only `.sqllogic` test files). Filed as pre-existing via
  `tickets/.pre-existing-error.md` per workflow rules — `tickets/.pre-existing-known.md` didn't exist yet so
  this is the first report of it; the triage pass after this ticket lands should pick it up.
  Neither new/edited sqllogic file appears in the failure list — both passed silently (the harness only logs
  filenames on failure).
- `yarn test:store` (LevelDB backend): 6988 passing, 19 pending, **0 failing** — confirms the store path
  (the interaction flagged as most likely to diverge: `create unique index` + NOCASE enforcement) is
  identical between memory and store for both files.
- `yarn lint` (quereus): exit 0, no output — no spec call-site drift (expected; no `.ts` file touched).

## Gaps / things the reviewer should know

- I did not individually isolate-run just the two 47.3/47.3.1 files (e.g. via a `--grep`/file-scoped
  invocation) — I relied on the full-suite run passing with the only failure being the known-unrelated MV
  test. If the reviewer wants a targeted confirmation, the harness doesn't print per-file names on success,
  so isolating would require a temporary skip-list or grep on the file path in `logic.spec.ts`. I did
  visually re-check the final file contents (section numbers, SQL byte-identical for surviving sections,
  all tables dropped) rather than relying purely on the test run.
- Did not touch `unique-enforcement-collations.spec.ts` (referenced in the new file's header as sibling
  coverage) — didn't verify that file's exact name/existence beyond what the original ticket asserted.

## Review findings

- Pre-existing, unrelated test failure noticed during validation: `view persistence: importCatalog
  materialized-view re-materialization rehydrates the with defaults clause` in
  `packages/quereus/test/view-mv-ddl-persistence.spec.ts` (10s timeout). Not caused by this diff (only
  `.sqllogic` files touched). Reported via `tickets/.pre-existing-error.md` for the triage pass — not filed
  as a ticket directly, per workflow rules (the post-landing triage agent handles routing to `fix/` or
  `blocked/`).
