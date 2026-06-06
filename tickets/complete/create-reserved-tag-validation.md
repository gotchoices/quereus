description: Create-time reserved-`quereus.*`-tag validation on the direct CREATE TABLE / CREATE INDEX paths (mirrors the ALTER SET TAGS arm and the declarative differ), plus registering the previously-unlisted `quereus.expose_implicit_index` behavioral tag. Reviewed and completed.
files:
  - packages/quereus/src/planner/building/ddl.ts                 # create-time validation (table/column/constraint + index surfaces)
  - packages/quereus/src/schema/reserved-tags.ts                 # registered quereus.expose_implicit_index + 'boolean' value schema
  - packages/quereus/src/planner/building/alter-table.ts         # the setTags arm this mirrors (reference)
  - packages/quereus/src/schema/reserved-tags-policy.ts          # raiseReservedTagDiagnostics (reference)
  - packages/quereus/src/schema/schema-differ.ts                 # the differ's per-surface validation this mirrors (reference)
  - packages/quereus/src/schema/catalog.ts                       # sole consumer of quereus.expose_implicit_index (reference)
  - packages/quereus/src/planner/building/block.ts               # single dispatch point for createTable/createIndex (reference)
  - packages/quereus/test/logic/50-metadata-tags.sqllogic        # Phase 23: create-time reserved-tag cases
  - packages/quereus/test/schema/reserved-tags.spec.ts           # expose_implicit_index unit tests; count 16→17
  - packages/quereus/test/lens-advertisement.spec.ts             # malformed-decomp test → now create-time rejection
  - docs/schema.md                                               # direct-CREATE validation path (implement)
  - docs/sql.md                                                  # §2.6 reserved-tag soft-warning contradiction fixed (review)
----

# Create-time reserved-tag validation on direct CREATE TABLE / CREATE INDEX

Direct `CREATE TABLE … WITH TAGS` and `CREATE INDEX … WITH TAGS` now validate
reserved `quereus.*` tags at plan-build (`planner/building/ddl.ts`), exactly as
`ALTER … SET TAGS` and the declarative differ already did. A misspelled or
mis-sited reserved key on the most common authoring path is now a hard error
instead of being silently stored. Closing the hole surfaced and fixed a latent
registry gap: `quereus.expose_implicit_index` (a real behavioral tag read by
`catalog.ts` and compared by the differ) was never in `RESERVED_TAG_SPECS`; it is
now registered at the `physical-constraint` site with a new `'boolean'` value
schema.

## Review findings

**Verdict: APPROVED.** The implementation is correct, mirrors its reference paths
faithfully, and is well-tested. One minor doc-correctness bug was found and fixed
inline; no major issues, so no new tickets were filed.

### What was checked

- **Full implement diff** (`ddl.ts`, `reserved-tags.ts`, the three test files,
  `docs/schema.md`) read with fresh eyes before the handoff summary.
- **Dispatch completeness** — `block.ts` is the *single* entry point for both
  `createTable` and `createIndex`; no CTAS / alternate builder bypasses the new
  validation. The intentionally-excluded paths (catalog import/load,
  `CREATE VIEW … WITH TAGS`, inline named column-constraint tags) are real and
  documented; matching the differ's surfaces exactly (`schema-differ.ts:220-236`).
- **Mirror fidelity** — the new `raiseStmtTagDiagnostics` matches the ALTER
  `setTags` arm (`alter-table.ts:122-140`) and additionally threads `stmt.loc`
  for a sited error (a strict improvement). Accumulation order
  table → columns → constraints is deterministic; the first error is raised, as
  the multi-offending-tag test asserts.
- **The `'boolean'` value schema** — verified `SqlValue` includes `boolean`
  (`common/types.ts:23`) and the parser maps SQL `true`/`false` to JS booleans
  (`parser.ts:4042-4046`), so the strict `typeof === 'boolean'` check is sound and
  round-trips through JSON to `catalog.ts`'s strict `=== true`
  (`catalog.ts:284`). Confirmed `validateTagValue` is the only exhaustive switch
  over `TagValueSchema`; the new union member breaks nothing.
- **`expose_implicit_index` siting** — `physical-constraint`-only is correct: the
  exposure flag is read from `uc.tags` (a UNIQUE-constraint-only physical
  concept), and that site is the shared position of the direct-create named
  constraint, `ALTER … ALTER CONSTRAINT … SET TAGS`, and the differ's declared
  constraint. Registration is additive and **fixes a latent bug** — the differ
  and ALTER paths would *already* have rejected this real tag as
  `unknown-reserved-tag`; that path was simply never exercised. The two existing
  direct-create consumers (`covering-structure.spec.ts:894`,
  `schema-manager.spec.ts:333`) both use a table-level named constraint
  (`physical-constraint`) and continue to pass. `RENAME_HINT_KEYS` is unchanged
  (it remains a behavioral, *compared* tag), so diff/rename behavior is untouched.
- **Regression sweep** — searched the whole test corpus for direct
  `create table/index … with tags ("quereus.…")`; every other reserved-tag usage
  is on the `declare … apply schema` (already-validated) path, a view, or a
  DML mutation — none regress. Confirmed by the green full suite.
- **Test coverage** — happy path, edge cases (multi-offending accumulation order,
  `IF NOT EXISTS` build-time gating, mis-site vs unknown-key, free-form
  over-rejection guard), round-trips at all four physical surfaces, and the unit
  registry tests are a solid floor. The `lens-advertisement.spec.ts` behavior
  change is justified — only the one tag-driven test moved to create-time; the
  apply-time **structural** resolution errors (anchor-not-in-members, missing
  member relation, missing basis column, two-primary-storage, surrogate arity,
  unbacked column, sparse-override conflict) remain fully covered at lines
  187-350, so that error class did not lose coverage.

### Findings

- **MINOR (fixed inline)** — `docs/sql.md` §2.6 stated *"Unrecognized `quereus.*`
  keys are accepted with a soft warning so future versions may add new keys
  without breaking older parsers."* This is now flatly false (and was already
  stale from the prior hard-error work; this ticket makes it globally false by
  extending the hard error to the most common authoring path). Rewrote the
  paragraph to state the hard-error posture across all authoring paths, note the
  registry is the source of truth (listing `expose_implicit_index` /
  `quereus.update.*` / `quereus.lens.*` as a non-exhaustive subset), and clarify
  that only non-reserved free-form keys are accepted untouched. No other doc
  carried the stale claim (grepped `soft warning` / `silently stored` /
  `without breaking older parser`).

### Observations (no action — correct by design)

- The no-op warning sink in `ddl.ts` (`raiseStmtTagDiagnostics`) is currently
  *unreachable* on direct-create surfaces: the only warning-schema tag
  (`quereus.lens.ack.*`, `required-nonempty-rationale`) is sited at
  `logical-table` / `logical-constraint`, never at a physical-create site — so an
  ack tag on a physical `CREATE TABLE` is a `tag-not-allowed-here` *error*, not a
  warning. The sink is forward-defensive and matches the ALTER arm verbatim;
  intentionally left as-is. (This also means no create-time warning-path test is
  missing — the path can't be hit today.)
- The three intentional scope exclusions remain tracked in backlog ticket
  `reserved-tag-validation-inline-constraint-and-view-eager` (eager view-tag
  validation + inline named column-constraint tags) and are not regressions.

### Validation (re-run during review, all green)

- `yarn workspace @quereus/quereus run build` → clean (tsc, exit 0)
- `yarn workspace @quereus/quereus run lint` → clean (exit 0)
- `yarn workspace @quereus/quereus test` → **4853 passing, 0 failing, 9 pending**
- `yarn test:store` (LevelDB path) **not run** — create-time validation lives in
  the module-agnostic planner, so the store path is unaffected by construction;
  Phase 23 round-trips were exercised only against the memory module. Low risk,
  left to CI (slow / out-of-band), as the implementer flagged.
