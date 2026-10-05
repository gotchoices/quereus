description: "Apply schema" used to silently ignore CHECK, UNIQUE and FOREIGN KEY rules written without a name, so an upgraded database could end up with different rules than a freshly created one. It now matches unnamed rules by what they say and adds or drops them, refusing loudly when a rule was stored with no name and so cannot be dropped.
architecture: docs/schema-rename-detection.md#unnamed-constraint-lifecycle-body-matched
files:
  - packages/quereus/src/schema/catalog.ts            # CatalogTable.unnamedConstraints; catalogConstraints() named/unnamed split
  - packages/quereus/src/schema/catalog-rendering.ts  # renderUnnamedConstraint arm (fast-path + restore-check rendering)
  - packages/quereus/src/schema/schema-differ.ts      # collectDeclaredConstraints (~1930), diffUnnamedConstraints + helpers (~2160-2310), wiring in computeTableAlterDiff (~2545), UndoRenderer.readdConstraint (~3596)
  - packages/quereus/test/declarative-upgrade-equivalence.spec.ts  # new: fresh-vs-upgrade / downgrade property spec (39 cases)
  - packages/quereus/test/logic/50-declarative-schema.sqllogic     # new section at end: "Unnamed CHECK / UNIQUE / FOREIGN KEY constraints are diffed by body"
  - packages/quereus/test/apply-schema-restore.spec.ts             # new: "unnamed CHECK: the old rule is back under its stored auto-name"
  - packages/quereus/test/schema/catalog.spec.ts                   # roundtrip test extended to unnamedConstraints
  - packages/quereus/test/schema-differ.spec.ts, test/schema/differ-alter-column.spec.ts, test/schema/differ-undo-plan.spec.ts  # hand-built catalogs gained `unnamedConstraints: []`
  - docs/schema-rename-detection.md, docs/sql-ddl.md, docs/schema-undo-plan.md
----
# Declarative differ: unnamed constraints diffed by body (complete)

Reported from optimystic: a new version of a declared schema that added or removed an unnamed CHECK / UNIQUE / FOREIGN KEY produced an empty `diff schema`, so upgraded databases never gained (or lost) the rule. Fixed, plus the adjacent bug where a *named* column-level constraint on a column the diff adds was emitted twice (inline in `ADD COLUMN` and again as `ADD constraint`), failing the apply.

## What changed

- **Catalog** (`catalog.ts`): `CatalogTable` has a new required `unnamedConstraints: Array<{ kind, name?, tags?, definition, bodyAst? }>` — every CHECK / UNIQUE / FK that `namedConstraints` leaves out (no stored name, or a `_`-prefixed auto-name). `derivedFromIndex` UNIQUE stays in neither list. `catalog-rendering.ts` renders it (sorted, name omitted, tags kept).
- **Declared side** (`collectDeclaredConstraints`, replacing `collectDeclaredNamedConstraints`): one walk returns `{ named, unnamed }`. A column-level clause on a column the diff **adds** is skipped entirely (named or not) — `ADD COLUMN` already carries it inline. This is the adjacent duplicate-ADD fix.
- **Matching** (`diffUnnamedConstraints`): declared unnamed vs actual unnamed as a multiset by canonical body, using `reconciledDeclaredBody` (renames inverse-applied; identity without renames). Among same-body actuals the nameless one is consumed first, so the leftover is the droppable one.
  - declared unmatched → `ADD constraint <reserved name> <body>`: column CHECK `_check_<col>`, table CHECK `_check_<n>` (n from actual CHECK count, bumped until free), FK `_fk_<table>_<cols>`, UNIQUE `_uc_<cols>`, or the `_`-name the declaration wrote; disambiguated via `disambiguateAutoConstraintName` against `constraintNamesAtAddTime` (live names − dropped + declared user names + over-approximated ADD COLUMN mints + nameless UNIQUE backing names).
  - actual unmatched with a stored name → `DROP CONSTRAINT <name>`.
  - actual unmatched with **no** stored name → skipped if a dropped column prunes it (UNIQUE/FK over a dropped column), else a `QuereusError` at diff time: `Cannot drop unnamed constraint '<body>' from table '<schema>.<table>': … created without a name, so no statement can drop it …`. Suppressed when the table is being recreated for a backing-module move (`refuseUndroppable: !diff.maintainedModuleMigration`).
  - Unnamed adds/drops are excluded from `require-hint` counts. Tags on unnamed constraints are not diffed (`NOTE:` on `diffUnnamedConstraints`).
- **Undo**: `UndoRenderer.readdConstraint` also looks up `unnamedConstraints` by stored name, so dropping `_check_a` in a failed apply is restored (pinned by the new restore spec; mutation-checked — reverting the lookup makes it fail with "could not be restored").

## Observed behaviour (memory, verified)

| v2 adds | `diff schema` | violating insert after apply |
|---|---|---|
| `check (a > 0)` | `ADD constraint _check_0 check (a > 0)` | fails `CHECK constraint failed: _check_0` |
| `a … check (a > 0)` | `ADD constraint _check_a …` | fails |
| `unique (a)` / `a … unique` | `ADD constraint _uc_a unique (a)` | fails `UNIQUE constraint failed` |
| `foreign key (b) references p(id)` | `ADD constraint _fk_t_b …` | fails |

Removal of upgrade-added ones emits `DROP CONSTRAINT <name>`; removal from a **fresh** create errors for table-level CHECK and any UNIQUE (stored nameless), drops for column CHECK / FK. Re-diff is `[]` in every case. Moving an unnamed CHECK between column-level and table-level spelling is not a change (same body).

## Validation run

- `yarn workspace @quereus/quereus run lint` — clean (eslint + test typecheck).
- `yarn test` (all workspaces, after `tsc -b tsconfig.build.json`) — all green; quereus 10764 passing, 25 pending. No pre-existing spec churned from the new unnamed comparison.
- Store backend: `QUEREUS_TEST_STORE=true mocha packages/quereus/test/logic.spec.ts` — 365 passing, 8 pending (store-skipped files), 0 failing; includes the new sqllogic section. I did **not** run the full `yarn test:store` wrapper (it re-runs every spec, and only `logic.spec.ts` / `numeric-canonical.spec.ts` read the store flag).

## Known gaps / for the reviewer

- **Byte-identity residual (accepted, documented in the rename-detection doc):** fresh create stores a table-level unnamed CHECK / any unnamed UNIQUE with no name; upgrade stores `_check_<n>` / `_uc_<cols>`. Filed `backlog/feat-create-table-names-every-unnamed-constraint` to close it at CREATE TABLE (which would also retire the refusal).
- **Refusal granularity:** the undroppable error is thrown per table from `computeTableAlterDiff`, so one such table blocks the whole `diff schema` / `apply schema`. That is the decided design (silent no-op was the bug), but a reviewer may want to confirm the wording and `StatusCode.ERROR`.
- **Not covered by tests:** unnamed FK across schemas; an unnamed FK whose *parent table* is renamed in the same diff (goes through the same `reconciledDeclaredBody` FK arm the named path tests, but no unnamed-specific case); `_`-prefixed explicit declared names (`constraint _x check …`) — treated as unnamed and ADDed under `_x` (disambiguated), untested; a hand-built catalog lacking `bodyAst` for a nameless UNIQUE over a dropped column would throw instead of skipping (only hand-built test catalogs lack `bodyAst`).
- **Mint collision prediction** for names `ADD COLUMN` will mint is a deliberate over-approximation (`_check_<newcol>`, `_fk_<table>_<newcol>`, `_uc_<newcol>` all reserved); only affects contrived column names like a new column `a_b` beside an FK on `(a, b)`.
- **One-time churn:** a CHECK added imperatively unnamed (`alter table … add check (…)` → user-class `check_<n>`) and then declared unnamed is dropped and re-added as `_check_<n>` once.
- `schema-differ.ts` is now 3,872 lines (`wc -l`); noted on `backlog/debt-oversized-source-files` with the new helpers as a natural "table constraints" cut.
- The adjacent undo bug (`bug-apply-undo-of-add-column-with-inline-constraint-fails`, backlog) is untouched.

## Review findings

Read the implement diff (6b64e38e3) first, then the handoff. Probed the untested arms with a scratch spec (since deleted) before deciding what to pin.

- **Correctness — checked, no defect found.** Multiset matching (nameless actual consumed first); DROP CONSTRAINT phase runs before DROP COLUMN, so a stored-name constraint over a dropped column drops cleanly; `prunedByColumnDrop` matches engine behaviour (memory `shiftSchemaIndicesForDrop` removes every UNIQUE containing the column, any arity); `refuseUndroppable` suppression covers the only alter-diff-discarding path (`maintainedModuleMigration`; MV-sugar returns before constraints); the applied-state fast path (`renderCatalogForComparison`) safely omits the stored name — the name only matters when the diff is non-empty, and snapshots are only recorded on a verified no-op. Probed and observed correct: unnamed FK (column- and table-level) across a hinted parent-table rename → rename only; child-table rename + new unnamed FK → `_fk_<newname>_b`; declared `constraint _x check …` → ADD `_x`, then body-matched against `check (…)`; tag-only edit on an unnamed constraint → no-op (documented `NOTE:`); dropping a column whose fresh-created table-level CHECK is no longer declared → the refusal (previously an apply-time DROP COLUMN failure; now a clearer diff-time one).
- **DRY — fixed.** `uniqueBackingName` in the differ re-spelled the `_uc_<cols>` rule that `catalog.ts` documents as having exactly one in-package spelling (`implicitIndexNameForColumns`). Exported that helper and routed the differ through it. (The `_fk_` / `_check_` mint spellings are already duplicated across engine sites — pre-existing, not this ticket's invariant.)
- **Type safety / fragility — fixed.** `UnnamedConstraintDiffContext.declaredNames` took `Iterable<string>` and was passed a one-shot `Map.keys()` iterator; now `readonly string[]`, materialized at the call site.
- **Tripwire — parked.** `constraintNamesAtAddTime` derives a nameless UNIQUE's backing name from pre-rename columns while a same-diff RENAME COLUMN moves it; only reachable via a `_`-joined spelling clash and refused loudly by the engine. `NOTE:` on the function.
- **Test coverage — extended.** Added to `50-declarative-schema.sqllogic`: unnamed FK across a hinted parent-table rename (diff is the table rename only, re-diff empty); a declared reserved `_pos` name (ADDed under it, body-matched afterwards, body edit drops `_pos` and ADDs `_check_1`, enforced). Still untested: unnamed FK across schemas (same `reconciledDeclaredBody` arm as the named path, which is tested); hand-built catalogs lacking `bodyAst` (only test fixtures).
- **Refusal granularity / wording — reviewed, kept.** One undroppable constraint blocks the whole `diff schema`; that is the decided design (silent no-op was the bug), the message names table + body + remedy, and `feat-create-table-names-every-unnamed-constraint` (backlog) retires it at the source.
- **Error handling / resource cleanup / performance — nothing to do.** No resources held; the extra `schemaConstraintToTableConstraint` per unnamed constraint at catalog collection is linear in constraint count.
- **Docs — checked.** `schema-rename-detection.md`, `sql-ddl.md`, `schema-undo-plan.md` reflect the new behaviour; `catalog.ts`'s `implicitIndexNameForColumns` comment updated to name the differ as a caller.
- **Source size.** `schema-differ.ts` is ~3,880 lines; already recorded on `backlog/debt-oversized-source-files`.

Validation: `yarn workspace @quereus/quereus run lint` clean; `yarn workspace @quereus/quereus test` 10764 passing / 25 pending; `QUEREUS_TEST_STORE=true` mocha `logic.spec.ts` 365 passing / 8 pending.
