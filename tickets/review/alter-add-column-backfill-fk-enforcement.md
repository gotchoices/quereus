description: Review — column-level FOREIGN KEY added via ALTER TABLE ADD COLUMN now validates the existing (backfilled) rows against the referenced parent, for both default kinds, reverting the column add on a violation. NOTE a significant in-flight design change vs the plan ticket: the shared FK existing-row validator had to switch from `not exists` to a `LEFT JOIN … IS NULL` left-anti-join to dodge a newly-discovered engine bug (spawned fix ticket `altered-column-not-exists-antijoin-misread`).
files: packages/quereus/src/runtime/emit/alter-table.ts, packages/quereus/src/schema/constraint-builder.ts, packages/quereus/test/logic/41.4-alter-add-column-constraints.sqllogic, docs/runtime.md, tickets/fix/altered-column-not-exists-antijoin-misread.md
----

## What was implemented

`ALTER TABLE … ADD COLUMN c <type> REFERENCES parent(pk) [DEFAULT …]` now validates
the **existing (backfilled) rows** against the referenced parent — closing the gap
where an orphan backfilled value was silently admitted (forward INSERT/UPDATE were
already enforced via the merged table-level FK).

Mechanism (in `runAddColumn`, `runtime/emit/alter-table.ts`): after the module
appends the column and the enhanced schema is registered, for each new column-level
FK we call the shared `validateForeignKeyOverExistingRows(rctx.db,
enhancedTableSchema, fk)`. This runs **for all default kinds** (literal AND per-row
evaluator) and lives in the **same try/revert region** as the existing literal-default
CHECK post-scan, so a single revert path (drop column + restore original catalog
entry) serves a failing CHECK or FK. The stale `FOLLOW-UP:` comment was removed.

Behavior: MATCH SIMPLE (a fully-non-NULL backfilled value with no matching parent
aborts; a NULL value satisfies the FK), pragma-gated (`pragma foreign_keys = false`
skips it), parent-absent aware (any fully-non-NULL backfilled row is an orphan),
self-referential safe (parent == child), composite/bare-`REFERENCES` (PK fallback)
covered. No module code changed — the scan goes through `db.prepare`, backend-agnostic.

## ⚠️ Significant deviation from the plan ticket (review this first)

The plan said "reuse `validateForeignKeyOverExistingRows` as-is." During implementation
I discovered that the validator's `not exists` subquery **misreads a CHILD column added
in the same ALTER statement** — the hash-anti-join reports *no orphans*, so the post-scan
silently admitted violations (the exact bug the ticket set out to fix). This affects
**both** default kinds. The plan's "verified empirically that the post-scan sees the
per-row backfilled values" only held because that probe never ran the validator *during*
the ALTER.

Root cause is an engine/decorrelation bug, not FK-specific. I confirmed `select *`,
`EXISTS`, scalar `count(*)`, `IN`, `NOT IN`, inner `JOIN`, and a `LEFT JOIN … WHERE
parent IS NULL` left-anti-join all read the freshly-added column **correctly** — only
`NOT EXISTS` is wrong (and running it once persistently corrupts later anti-joins on
that table).

**Fix applied here:** `validateForeignKeyOverExistingRows` (parent-present branch) now
emits `LEFT JOIN … WHERE <first parent col> IS NULL` instead of `not exists`. The two
are logically equivalent under MATCH SIMPLE; the LEFT JOIN takes a plan path that reads
the column correctly. This is shared with `ADD CONSTRAINT` (memory + store) — verified
no regression (test `41.8`, memory and store).

**Spawned fix ticket:** `tickets/fix/altered-column-not-exists-antijoin-misread.md`
captures the full repro/diagnosis and the suggestion to fix the engine at source and
then deliberately re-decide the validator's query shape.

### Reviewer judgement calls to weigh
- **Modifying the shared validator** (vs. a dedicated ADD-COLUMN-only check) was chosen
  for DRY and because the LEFT JOIN is a strictly-equivalent, more-robust formulation.
  Trade-off: it changes the working `ADD CONSTRAINT` path's SQL shape (verified passing).
  Alternative considered and rejected: re-implementing parent-resolution / MATCH SIMPLE /
  parent-absent in the emitter (more code, drift risk).
- The validator now relies on referenced parent columns being non-NULL (PK/UNIQUE) so a
  non-match leaves `<first parent col>` NULL. Argued correct for composite and
  nullable-referenced edge cases in the code comment — **worth a second look.**

## Use cases / test coverage (extended `41.4` section 2, cases 2a–2l)

All run on memory (`yarn test`) and store (`yarn test:store`). Conventions: `-- error:
foreign key` asserts the ADD COLUMN validator (message "FOREIGN KEY constraint
failed"); bare `-- error:` asserts forward-INSERT enforcement (matches existing style).

- 2a NULL backfill allowed + forward enforcement fires (pre-existing, kept).
- 2b Literal-default **orphan** → abort; column NOT added (`table_info` count 0); plain
  insert over original shape still succeeds (FK never installed).
- 2c Literal-default **satisfied** → succeeds; backfilled; `foreign_key_info` shows it;
  forward orphan insert rejected.
- 2d Per-row default `(new.a + 100)` **orphan** → abort; `select *` shows table unchanged.
- 2e Per-row default **satisfied** → succeeds (per-row backfilled values); forward
  enforcement active.
- 2f / 2g **Self-referential** FK satisfied / orphan.
- 2h / 2i **Bare `REFERENCES parent`** (PK fallback) satisfied / orphan.
- 2j `pragma foreign_keys = false` → orphan ADD COLUMN succeeds (validator no-ops).
- 2k **Parent absent**: non-NULL backfill → abort; NULL backfill → succeeds.
- 2l **Empty table** → succeeds; forward enforcement still installed.

### Suggested additional coverage for the reviewer (gaps / floor, not ceiling)
- **Cross-schema** parent (e.g. `references otherschema.parent`) — `41-fk-cross-schema`
  exists for ADD CONSTRAINT but ADD COLUMN cross-schema FK backfill is untested here.
- **Composite parent via a named UNIQUE (non-PK) referenced column** through ADD COLUMN
  — column-level FK is single-child-column, but a named multi-col parent UNIQUE target
  is only argued in comments.
- **Both a new CHECK and a new FK on the same ADD COLUMN, each failing** — the shared
  try/revert is asserted structurally but not with a combined-failure case.
- **Revert atomicity under store** beyond pass/fail (e.g. catalog re-persist across a
  store reconnect after a reverted ADD COLUMN).

## Validation performed

- `yarn workspace @quereus/quereus run build` → exit 0
- `yarn workspace @quereus/quereus run lint` → exit 0
- Full **memory** logic suite (`logic.spec.ts`, 222 files) → **222 passing**
- Full **spec** suite (`test/**/*.spec.ts`) → **4853 passing**
- **Store** mode (`QUEREUS_TEST_STORE=true`): `41.4`, `41.8`, `41-foreign-keys` → passing
- Did NOT run the *entire* store logic suite (`yarn test:store`) or `yarn test:full`
  (slow); only the FK-relevant files in store mode. A reviewer/CI store full-run is
  advisable since the shared validator change touches every ADD CONSTRAINT FK path.

## Known gaps / honesty notes

- The underlying engine anti-join bug is **worked around, not fixed** — see the spawned
  fix ticket. If that fix lands, revisit the validator's query-shape choice.
- Pre-existing, untouched-by-me: `rebuildViaShadowTable` in `alter-table.ts` has an
  unused `schema` parameter (TS-LSP `noUnusedParameters` hint only; eslint/build are
  clean — it predates this ticket at `145400dd`). Not addressed.
- Temp probe scripts used during diagnosis were deleted; no stray files remain.
