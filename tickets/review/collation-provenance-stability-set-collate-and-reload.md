description: Review the fix making a column's comparison-collation rank a function of the current catalog column (not its creation history). SET COLLATE now marks the collation explicit (rank 2 'declared') uniformly across the memory and store modules, including SET COLLATE binary; the session-default→declared rank upgrade on DDL reload is accepted (option a) and documented, not persisted.
prereq:
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts            # alterColumn setCollation branch (~1708) — the memory-side fix
  - packages/quereus-store/src/common/store-module.ts            # alterColumn setCollation branch (~1372) — the store-side fix (mirror)
  - packages/quereus/src/schema/column.ts                        # ColumnSchema.collationExplicit doc comment (updated)
  - packages/quereus/src/planner/type-utils.ts                   # columnSchemaToScalarType — collationExplicit → 'declared'|'default' (unchanged consumer)
  - packages/quereus/src/planner/analysis/comparison-collation.ts # the lattice (unchanged consumer)
  - packages/quereus/test/logic/06.4.4-comparison-collation-precedence.sqllogic  # new § 11 SET COLLATE provenance section
  - packages/quereus/test/logic/41.7-alter-column-collate.sqllogic               # existing SET COLLATE semantics (regression — unchanged, still passes)
  - docs/types.md                                                # § Comparison collation resolution — provenance-stability paragraphs
  - docs/sql.md                                                  # § 9.2.4 default_collation — reload provenance-upgrade note
difficulty: medium
----

# Review: collation provenance must be stable across SET COLLATE

## What changed and why

The provenance-ranked comparison lattice (`comparison-collation.ts`) ranks a
column's collation from `ColumnSchema.collationExplicit`: explicit ⇒ rank 2
(`'declared'`), defaulted ⇒ rank 1 (`'default'`). Rank 2 same-rank conflicts
error at prepare; rank 1 conflicts silently resolve to BINARY and silently lose
to any rank-2 contribution.

Before this fix `collationExplicit` was set in exactly one place —
`columnDefToSchema` (the CREATE-time `COLLATE` clause). `ALTER COLUMN ... SET
COLLATE` did **not** set it (both `alterColumn` sites built
`{ ...oldCol, collation: normalized }`), so the rank a `SET COLLATE` produced
depended on the column's *creation history*, not the statement just issued. The
same `SET COLLATE NOCASE` was rank 1 when the column was created bare (silently
loses to a declared RTRIM) and rank 2 when it happened to be created with any
`COLLATE` clause (rank-2 conflict ⇒ error).

**Decision implemented (pinned in the original ticket):** `SET COLLATE` marks the
collation explicit (rank 2) **uniformly across both modules, including `SET
COLLATE binary`** — a `SET COLLATE` has exactly the standing of a CREATE-time
`COLLATE`. The reload story is **option (a)**: the rank-1→rank-2 upgrade a
defaulted collation undergoes on DDL persistence/reload is intended and
documented, **not** persisted (no catalog/DDL representation change). Every such
reload flip is fail-louder only (a silent resolution becomes a prepare-time
ambiguous-collation error — never silently different results).

## The two code edits (the heart of the review)

Both `alterColumn` setCollation branches were changed identically in shape:

- **Idempotence guard is now provenance-aware.** The old short-circuit fired on
  bare name equality (`normalized === (oldCol.collation || 'BINARY')`). It now
  fires **only when the name matches AND `oldCol.collationExplicit` is already
  true**. Otherwise:
  - **name matches, not yet explicit** → metadata-only flip:
    `newCol = { ...oldCol, collation: normalized, collationExplicit: true }` with
    `collationChanged = false`. The collation *bytes* are unchanged, so NO
    physical re-sort / re-key / UNIQUE re-validation runs — but the schema is
    re-registered (and, store-side, DDL re-persisted). This covers `set collate
    binary` on a defaulted-BINARY column and `set collate nocase` on a column
    whose NOCASE came from `default_collation`.
  - **name differs** → the existing full re-key/re-validate path, PLUS
    `collationExplicit: true` on `newCol`. (`collationChanged = !nameMatches`.)

- Memory (`manager.ts`): metadata-only flip flows through the normal tail
  (`updateSchema` + `this.tableSchema = …`); with `collationChanged === false`
  the `rebuildAllSecondaryIndexesStrict` / `rebuildPrimaryTreeStrict` block is
  skipped. The memory `alterColumn` returns void; its wrapping `alterTable`
  returns the registered schema.
- Store (`store-module.ts`): metadata-only flip skips both
  `validateUniqueOverExistingRows` (non-PK UNIQUE) and `rekeyRows` (PK), but
  still runs `table.updateSchema(updatedSchema)` + `saveTableDDL` and returns
  `updatedSchema`. The runtime (`alter-table.ts` runAlterColumn) does
  `schema.addTable(updatedTableSchema)`, so the flag reaches the planner.

## What to verify (use cases / validation)

Primary regression surface is the new **§ 11** of
`06.4.4-comparison-collation-precedence.sqllogic` (runs under BOTH memory and
store — see the 41.7 header). It pins:

- **11a** repro `r1`: `set collate nocase` on a bare column vs a declared RTRIM
  column ⇒ **ambiguous-collation error** (was silently RTRIM, returning a row).
- **11b** history independence: the SAME statement on a column created `collate
  binary` vs declared RTRIM ⇒ the identical ambiguous-collation error.
- **11c** rank-2 vs rank-2: `set collate nocase` vs a declared BINARY column ⇒
  ambiguous-collation error.
- **11d** rank-2 wins over no-contribution: `set collate nocase` vs a plain
  (defaulted-BINARY) column ⇒ resolves NOCASE, returns the case-folded match.
- **11e** `set collate binary` is rank 2 too: on a defaulted-BINARY column then
  vs a declared NOCASE column ⇒ ambiguous-collation error **in-session**.

Reviewer angles worth a skeptical pass:

- **The metadata-only flip's `collationChanged === false` invariant.** Confirm
  no physical work runs when only the flag flips (the whole point — the bytes
  are identical). Check the store side especially: `rekeyRows` and
  `validateUniqueOverExistingRows` must NOT run for `set collate binary` on a
  defaulted-BINARY PK or UNIQUE column (no collision risk, but also no wasted
  scan). A PK-member `set collate nocase` where the name DIFFERS still takes the
  full re-key path — that branch is unchanged and covered by
  41.7.1-alter-column-collate-unique (memory) and the store PK re-key tests.
- **Idempotence after the first flip.** `set collate nocase; set collate
  nocase` — the second call must now early-return via the
  name-matches-AND-explicit guard (41.7 § 5 still passes; the first call set the
  flag, the second sees it).
- **Re-register correctness.** Both modules must re-register the schema on the
  metadata-only path so the planner sees the flag; a missed re-register would
  show as 11d/11e NOT erroring/matching. Both modes pass, so this holds, but
  it's the subtle bit.

## Known gaps / honest flags

- **No store-reopen round-trip test.** The option-(a) reload upgrade (a
  defaulted non-BINARY column reloading as rank 2, and `set collate binary`
  reloading as rank 1 because BINARY is DDL-elided) is **documented but not
  asserted by a reopen test** — the original ticket explicitly waived a
  "reopen-preserves-rank" assertion because the change across the persistence
  boundary is deliberately accepted (fail-louder only). If the reviewer wants
  belt-and-suspenders coverage, a store reopen test asserting "defaulted NOCASE
  column → ambiguous-collation error after reopen" would lock option (a) in;
  this is a *potential add*, not a regression. Flagging because it's the one
  behavior with prose-only coverage.
- **`saveTableDDL` on the metadata-only BINARY flip is a no-op-on-reload but a
  real write.** `set collate binary` re-persists byte-identical DDL (BINARY
  elided). Harmless, but it IS an extra catalog write for a flag-only change;
  confirm that's acceptable (the original ticket says it is — "harmless but a
  no-op on reload").
- **`collationExplicit` is now set in two places** (`columnDefToSchema` and both
  `alterColumn` sites). The doc comment on `ColumnSchema.collationExplicit` was
  updated to say so. Anyone adding a third `ColumnSchema`-mutating ALTER path
  (e.g. a future SET DATA TYPE that re-resolves collation) must decide the flag
  deliberately — there's no central helper enforcing it.
- **Test grouping subtlety in 06.4.4 § 11a.** The sqllogic harness groups
  consecutive directive-less statements into one block; § 11a's setup is grouped
  with § 10's trailing `drop/drop/pragma`. The block is expected to error (at the
  `select`), which it does in both modes. Not a problem, but if a reviewer
  re-orders § 11, keep each error case's erroring statement as the last before
  its `-- error` directive.

## Validation performed

- `yarn workspace @quereus/quereus run lint` — clean (exit 0).
- `yarn workspace @quereus/quereus run build` + `yarn workspace @quereus/store
  run build` — clean. **Note:** `yarn test:store` imports the COMPILED
  `@quereus/store` from `dist/` (gitignored), so the store package MUST be
  rebuilt for store-mode runs to pick up `store-module.ts` edits. I rebuilt it;
  a fresh checkout / CI rebuilds dist anyway.
- `yarn test` (memory) — **5977 passing, 9 pending, exit 0.**
- `yarn test:store` (LevelDB store) — **5973 passing, 13 pending, exit 0.**
- Targeted: `06.4.4` and `41.7` pass under both memory and store.

No pre-existing failures encountered; `.pre-existing-error.md` not written.
