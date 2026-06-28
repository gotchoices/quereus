description: Re-applying a database's schema with seed data on reopen used to crash with a duplicate-key error; seed application is now idempotent (upsert) so a reopen reseeds cleanly. Reviewed and verified.
prereq:
files:
  - packages/quereus/src/runtime/emit/schema-declarative.ts            # the fix — emitApplySchema seed branch (L265-296) + formatSeedValue helper (L27)
  - packages/quereus-store/test/seed-reopen-idempotent.spec.ts          # in-repo regression harness (4 cases)
  - packages/quereus/test/logic/50-declarative-schema.sqllogic          # in-engine upsert-semantics section (EOF)
  - docs/schema.md                                                      # ### Seed Data — upsert contract
---

## What shipped

`apply schema X with seed` previously did **DELETE-then-INSERT** per seeded table,
skipping the `DELETE` only for tables it judged "freshly created" by diffing the
declared tables against the **in-memory** Quereus catalog. On a reopen where the
host does not rehydrate that catalog (row data lives in a host-backed vtab, not
the catalog), the catalog is empty → an already-seeded table is misclassified as
fresh → the wipe is skipped → bare `INSERT`s collide with the persisted rows →
`UNIQUE constraint failed: <table> PK`.

The fix removed the `freshlyCreatedTables` heuristic and the `DELETE` wipe
entirely. Each seed row is now `INSERT OR REPLACE INTO <table> VALUES (…)`,
batched one-exec-per-table. Value-literal escaping was extracted into a
`formatSeedValue` helper (behavior-preserving). Net behavior: seed PKs are
upserted (seed values win on conflict); non-seed rows are left in place (a reopen
must not destroy user data).

## Review findings

### Scope checked
Read the full implement diff (`c4f7a6a6`) with fresh eyes before the handoff
summary: the emitter change, both new tests, the docs update. Traced the engine
write-path for `INSERT OR REPLACE` conflict resolution (`isolated-table.ts`
`update`/`checkMergedPKConflict`, `store-table.ts` `update` insert arm) to confirm
the point-key-probe (not full-scan) reasoning the fix rests on. Searched for every
other consumer of seed data (`withSeed` / `getAllSeedData` / `setSeedData`) and for
stale seed-DELETE references across `docs/` and package READMEs.

### Verification run (all green)
- `@quereus/quereus` `yarn test` → **6397 passing / 0 failing / 9 pending**
- `@quereus/store` `yarn test` → **675 passing / 0 failing**
- `@quereus/quereus` `yarn lint` (eslint + `tsc -p tsconfig.test.json`) → **clean**
- Targeted: store `seed-reopen-idempotent.spec.ts` → **4/4**; sqllogic
  `50-declarative-schema` → **1/1**.
- **Regression has teeth (adversarial check):** temporarily reverted
  `INSERT OR REPLACE` → plain `INSERT`, rebuilt, re-ran the store spec → **3 of 4
  cases failed with the exact `UNIQUE constraint failed: tablemetadata PK`** crash
  (cases a/b/d); the genuinely-fresh case (c) still passed. Restored the fix and
  confirmed `git diff` against HEAD is empty (source unchanged). This proves the
  harness actually reproduces the reported bug rather than passing vacuously.

### Findings & dispositions

- **Correctness — confirmed sound.** The fix resolves the reported crash and the
  semantics (upsert seed PKs, preserve non-seed rows) are pinned by both the store
  spec and the in-engine sqllogic case. No correctness issue found.

- **MAJOR (filed, needs dev call) — `OR REPLACE` cascade on referenced seed
  parents.** `OR REPLACE` is delete-then-insert on a conflicting row, so re-seeding
  a parent referenced by `ON DELETE CASCADE` children fires that cascade on every
  reopen even when the replaced values are unchanged. This is a real product
  tradeoff (re-assert seed truth vs. avoid cascade churn / preserve user edits) the
  original ticket explicitly deferred to the dev. Not fixed inline because the
  alternative (`INSERT OR IGNORE`) changes documented+tested semantics (case d) and
  needs a human decision. **Filed `tickets/backlog/seed-reseed-or-replace-cascade-tradeoff.md`**
  with the one-line swap + test/doc deltas if the dev chooses to change it.

- **RESIDUAL (out-of-repo, documented) — host `asOf` pre-commit fault not
  exercisable in-repo.** The fix's safety argument for a *host-backed* freshly
  created table (Lamina) — that `INSERT OR REPLACE`'s point-probe reads the
  live/pending image and so avoids the `asOf(ep.startedAt)` read-snapshot fault
  that the old `DELETE` full-scan hit — is sound and matches the vtab `update()`
  contract, and is corroborated by the in-repo store/isolation point-lookup code.
  But this repo has no `asOf` read-snapshot path, so it cannot be proven here; it
  must be confirmed against the host (a Lamina unit test or a SiteCAD reload). The
  SiteCAD defense-in-depth fix (`withSeed: false` on reopen) is filed separately
  against that repo. No in-repo action remains; flagged so host validation isn't
  forgotten. If the host probe turns out not to be live/pending-safe, fall back to
  the original ticket's "option 1" (surface a real `create` vs `connect`
  pre-existed bit and key the wipe/skip off that).

- **MINOR (noted, not changed) — DRY: `formatSeedValue` duplicates existing
  literal formatters.** A canonical `sqlValueToLiteral` (`util/sql-literal.ts`) and
  two more copies (`ddl-generator.ts` `formatSqlLiteral` / `formatTagValue`) already
  exist. The implementer only *extracted* the pre-existing inline logic into a
  helper (no new duplication introduced), and consolidating is behavior-risky (the
  formatters disagree on booleans → `1/0` vs `TRUE/FALSE`, and on the JSON/object
  fallback) and broader than this ticket. Left as-is; consolidation is a separate
  cleanup if ever wanted.

- **MINOR (noted, pre-existing) — defensive `'NULL'` fallback / unquoted table
  name.** `formatSeedValue` maps an object/JSON `SqlValue` to `'NULL'`, but seed
  values can only originate from literal tokens (`getSyncLiteral` over a `'literal'`
  AST in `parser.ts declareSeedItem`), so a JSON-object seed value is not
  producible and the branch is effectively unreachable. Separately,
  `qualifiedTableName` is interpolated into the generated SQL unquoted, so a
  reserved-word/special-char table name would break — both behaviors are unchanged
  from the pre-fix code and out of scope here.

- **Behavior change vs. old full-reset — confirmed harmless.** The old correctly
  detected pre-existing path did a full reset (non-seed rows removed); the upsert
  leaves them. Strictly better for reopen. Confirmed via a full `withSeed` /
  `getAllSeedData` reference sweep that **no other code path and no spec relies on
  the truncate-to-exactly-seed-rows behavior** — the only other prior `with seed`
  specs are first-time seeds on fresh tables, which are unaffected.

- **Docs — current.** `docs/schema.md` § Seed Data was rewritten to the upsert
  contract (incl. the cascade caveat). Swept `docs/` and package READMEs for other
  stale seed-DELETE references — none found; this was the only doc describing seed
  application.

### Net
Ship as-is. One major design tradeoff handed to the dev via a backlog ticket; one
out-of-repo host-validation step flagged; no in-repo defects. Build, full test
suites, and lint all green.
