description: Made a column's comparison-collation rank a function of the current catalog column, not its creation history. `ALTER COLUMN ... SET COLLATE` now marks the collation explicit (rank 2 'declared') uniformly across the memory and store modules, including `SET COLLATE binary`, via a provenance-aware idempotence guard that performs a metadata-only flag flip (no physical re-sort/re-key) when only the flag changes. The session-default→declared rank upgrade on DDL reload is accepted (option a) and documented, not persisted. Reviewed and completed.
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts            # alterColumn setCollation branch (~1708) — memory-side provenance-aware guard
  - packages/quereus-store/src/common/store-module.ts            # alterColumn setCollation branch (~1372) — store-side mirror
  - packages/quereus/src/schema/column.ts                        # ColumnSchema.collationExplicit doc comment
  - packages/quereus/src/planner/type-utils.ts                   # columnSchemaToScalarType — collationExplicit → 'declared'|'default' (consumer)
  - packages/quereus/src/planner/analysis/comparison-collation.ts # the lattice (consumer)
  - packages/quereus/test/logic/06.4.4-comparison-collation-precedence.sqllogic  # § 11 SET COLLATE provenance
  - packages/quereus-store/test/rehydrate-catalog.spec.ts        # NEW reopen test locking option (a) rank-1→declared upgrade
  - docs/types.md                                                # § Comparison collation resolution — provenance-stability + BINARY-downgrade exception
  - docs/sql.md                                                  # § 9.2.4 default_collation — reload provenance-upgrade note

# Complete: collation provenance stable across SET COLLATE

## What landed

The provenance-ranked comparison lattice ranks a column's collation from
`ColumnSchema.collationExplicit`: explicit ⇒ rank 2 (`declared`), defaulted ⇒
rank 1 (`default`). Before the fix, `collationExplicit` was set only at CREATE
(`columnDefToSchema`); `ALTER COLUMN ... SET COLLATE` left it untouched, so the
rank a `SET COLLATE` produced depended on the column's *creation history*, not
the statement issued.

Both `alterColumn` setCollation branches (memory `manager.ts`, store
`store-module.ts`) were changed identically:

- The idempotence short-circuit is now provenance-aware: it early-returns only
  when the collation name matches **AND** `oldCol.collationExplicit` is already
  true.
- A name match on a not-yet-explicit column performs a **metadata-only flip**
  (`collationExplicit: true`, `collationChanged = false`): the collation bytes
  are unchanged, so no physical re-sort / re-key / UNIQUE re-validation runs, but
  the schema is re-registered (and store-side DDL re-persisted) so the planner
  sees the new rank.
- A name change takes the existing full re-key/re-validate path AND sets the flag.

The reload story is **option (a)**: the rank-1→rank-2 upgrade a defaulted
non-BINARY collation undergoes when its (always-explicit) DDL re-parses is
intended, fail-louder-only, and documented — not persisted as a distinct bit.

## Review findings

Read the implement diff (`ec166a14`) with fresh eyes before the handoff. The
implementation is correct and well-scoped; the handoff summary was accurate and
honest about its one gap. Detailed checks:

### Correctness (checked — no issues)

- **Both edits are structurally identical and sound.** The guard
  `nameMatches && oldCol.collationExplicit` correctly treats `undefined` as
  falsy; `collationChanged = !nameMatches` correctly routes name-changes to the
  physical path and flag-only flips to the metadata path.
- **`collationChanged === false` invariant holds on both sides.** Memory skips
  the `rebuildAllSecondaryIndexesStrict` / `rebuildPrimaryTreeStrict` block;
  store skips both `validateUniqueOverExistingRows` and `rekeyRows`. Bytes are
  unchanged, so no collision is possible and no scan is wasted — verified the
  skip is sound (a metadata flip cannot introduce a UNIQUE/PK collision).
- **Re-register correctness.** Memory `alterColumn` returns void but sets
  `this.tableSchema = finalNewTableSchema`; its wrapping `alterTable` returns
  `manager.tableSchema`, which `runAlterColumn` feeds to `schema.addTable`. Store
  returns `updatedSchema` directly. Both reach the planner — confirmed via the
  data-flow trace and the passing 11d/11e assertions (which require the flag to
  arrive).
- **Idempotence after first flip** (`set collate nocase; set collate nocase`):
  the second call early-returns via the name-matches-AND-explicit guard. 41.7 § 5
  still passes.
- **DDL emission keys off the collation *value*** (`col.collation &&
  normalizeCollationName(col.collation) !== 'BINARY'`), NOT the flag — confirmed
  in `ddl-generator.ts:460`, `alter-table.ts:1274/1700`. This is what makes the
  option-(a) reload story exact: a defaulted NOCASE persists `COLLATE NOCASE`
  (reloads rank 2); `set collate binary` persists byte-identical BINARY-elided
  DDL (reloads rank 1).
- **No adverse `collationExplicit` consumers.** The only behavioral consumers are
  `type-utils.ts:147` (the intended provenance source) and
  `store-module.ts:2477` `reconcilePkCollations` — and the latter is CREATE-path
  only (the load path does not reconcile), so ALTER never routes through it.
  `materialized-view-helpers.ts` and `table.ts` are setters, unaffected.

### Findings fixed inline (minor)

- **Missing reopen round-trip coverage for option (a).** The handoff flagged
  this as the one prose-only-covered behavior. Added
  `default_collation-derived collation upgrades rank 1 → declared across reopen
  (fail-louder)` to `rehydrate-catalog.spec.ts`: a column that inherits NOCASE
  from session `default_collation` resolves silently against a declared RTRIM
  operand **in-session** (rank-2 RTRIM wins, returns the row), then after
  `rehydrateCatalog` the re-parsed `COLLATE NOCASE` makes it rank 2 and the same
  comparison is an **ambiguous-collation error**. Locks the persistence-boundary
  upgrade with a real assertion. Passes.
- **Docs understated the BINARY-elision *downgrade* direction.** `docs/types.md`
  prominently states the reload upgrade is "fail-louder only … never silently
  different results", scoped to the rank-1→rank-2 case. But the `collate binary`
  direction is rank 2 → rank 1 across reopen, so an in-session ambiguous-collation
  error involving a `collate binary` operand (which § 11e of 06.4.4 explicitly
  pins) resolves *silently* after reopen — the opposite of fail-louder. Added a
  sentence to `docs/types.md` calling this out as the documented exception
  (and noting it matches CREATE-time `collate binary` either way, so it is not a
  regression introduced by this ticket — create-time `collate binary` already
  round-trips rank 2 → rank 1).

### Major findings → new tickets

- **None.** No design or correctness issues warranting a fix/plan/backlog ticket
  surfaced from this diff. (Pre-existing, separately-ticketed cross-module
  collation concerns — `unique-enforcement-collation-cross-module-audit`,
  `fk-collation-conflict-create-time-validation` — are out of scope and untouched
  by this change.)

### Other categories

- **Type safety / error handling / resource cleanup:** clean. No `any`, the
  latch/try-catch rollback structure in both modules is unchanged by this edit,
  and the metadata-only path adds no new resources.
- **Honest residual:** `saveTableDDL` on the metadata-only BINARY flip is a real
  catalog write of byte-identical DDL (BINARY elided) — harmless and a no-op on
  reload, accepted as in the original ticket. `collationExplicit` is now set in
  two places (`columnDefToSchema` + both `alterColumn` sites); a future
  `ColumnSchema`-mutating ALTER path that re-resolves collation must decide the
  flag deliberately (no central helper enforces it) — noted in the doc comment.

## Validation performed

- `yarn workspace @quereus/quereus run lint` — clean (exit 0).
- `yarn workspace @quereus/store run typecheck` — clean (the new test compiles).
- Targeted sqllogic `06.4.4` + `41.7` — pass under **both** memory and store.
- `rehydrate-catalog.spec.ts` — **19 passing** (18 prior + the new reopen test).
- Implementer's full-suite results stand (memory 5977 / store 5973 passing); this
  review made no production-code changes — only a docs sentence and a new test —
  so the engine behavior is unchanged.

No pre-existing failures encountered; `.pre-existing-error.md` not written.
