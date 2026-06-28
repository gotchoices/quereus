---
description: Re-applying a database's schema with seed data on reopen used to crash with a duplicate-key error; seed application is now idempotent (upsert) so a reopen reseeds cleanly. Review the fix and its two flagged residual risks.
prereq:
files:
  - packages/quereus/src/runtime/emit/schema-declarative.ts            # the fix — emitApplySchema withSeed branch (L234-291) + formatSeedValue helper (L27)
  - packages/quereus-store/test/seed-reopen-idempotent.spec.ts          # new in-repo regression harness (4 cases)
  - packages/quereus/test/logic/50-declarative-schema.sqllogic         # new memory-vtab upsert-semantics section (appended at EOF)
  - docs/schema.md                                                      # ### Seed Data updated to the upsert contract
difficulty: medium
---

## What changed

`apply schema X with seed` previously did **DELETE-then-INSERT** per seeded table, skipping
the `DELETE` only for tables it judged "freshly created" by diffing the declared tables
against the **in-memory** Quereus catalog (`collectSchemaCatalog`). That catalog is ephemeral:
on a reopen where the host rebuilds it lazily (or not at all — row data lives in a host-backed
vtab / persistent fact log, not the catalog), it is empty, so an **already-seeded** table is
misclassified as fresh → the wipe is skipped → bare `INSERT`s collide with the persisted rows
→ `UNIQUE constraint failed: <table> PK`.

The fix (`schema-declarative.ts`):

- Deleted the `freshlyCreatedTables` / `preApplyTableNames` heuristic and the `DELETE` wipe.
- Each seed row is now `INSERT OR REPLACE INTO <qualifiedTable> VALUES (…)` (one statement per
  row, batched into a single `_execWithinTransaction`). Value-literal escaping was extracted
  into a `formatSeedValue` helper (unchanged logic, incl. blob `X'…'` and boolean→0/1).
- Rewrote the comment block to explain the idempotent upsert and the `asOf` point-probe
  safety reasoning.
- Added a `rows.length === 0` guard (skip empty-seed tables — avoids an empty exec string).

Net behavior: seed PKs are upserted (seed values win on conflict); **non-seed rows are left in
place** (a reopen must not destroy user data). This is the documented `with seed` contract
("seed fires on creation; later opens use no seed") made safe under repeated `withSeed: true`.

## Why it's safe under the host `asOf` snapshot constraint

The original `DELETE`-skip existed because `DELETE FROM <fresh-table>` is a query-plan **full
scan** routed through the host snapshot resolver at `asOf(ep.startedAt)` — an HLC sampled
*before* the schema-batch fact-group commit, when the table doesn't yet exist in the fact log →
fault. `INSERT OR REPLACE` does **not** scan: conflict resolution is a **point-key probe**
against the live overlay / effective image, which reads pending writes from the current
transaction (incl. the `CREATE TABLE` applied in the same schema batch). In-repo evidence:
`store-table.ts` `getOverlayRow`/`checkUniqueConstraints` and `isolated-table.ts`
`getOverlayRow` are point lookups, not scans. This is the standard vtab `update()` write-path
contract.

## How to validate (what the reviewer should run / check)

Build the engine first (the emitter is in `@quereus/quereus`):

```
yarn workspace @quereus/quereus run build
```

Then:

- **Store regression (reproduces the crash in-repo):**
  `node --import ./packages/quereus-store/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus-store/test/seed-reopen-idempotent.spec.ts"`
  — 4 cases: (a) reopen **without** `rehydrateCatalog` reseeds without PK collision *(this is
  the exact bug; it threw pre-fix because the shared `InMemoryKVStore` provider still holds
  db1's rows, so db2's `CREATE TABLE` connects to a populated backing and the old bare INSERT
  collided)*, (b) reopen **with** `rehydrateCatalog` still passes, (c) genuinely-fresh first
  apply still seeds, (d) a non-seed user row + an edited seed row survive a reopen reseed
  (pins upsert-not-reset).
- **In-engine memory upsert semantics:**
  `node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus/test/logic.spec.ts" --grep "50-declarative-schema"`
  — appended section: re-`apply … with seed` on a memory table holding both seed rows and a
  non-seed user row re-asserts the seed values **and** keeps the user row (would have wiped it
  pre-fix).
- **Full suites (all green at handoff):** `packages/quereus` `yarn test` → 6397 passing / 0
  failing; `@quereus/store` `yarn test` → 675 passing / 0 failing; `packages/quereus` `yarn
  lint` → clean (eslint + test typecheck).

Seed syntax used: brace-form table body + sibling `seed <table> ((row),(row))` item; for the
store, `declare schema main using (default_vtab_module = 'store') { … }`.

## Known gaps / residual risks — review these adversarially

1. **Host `asOf` validation is NOT exercised in-repo (the one thing that can't be).** The
   in-repo store/isolation/memory paths have no `asOf` read-snapshot fault, so they prove
   idempotency and semantics but **not** that `INSERT OR REPLACE` on a freshly-created
   *host-backed* table (Lamina) avoids the `asOf(ep.startedAt)` pre-commit fault. The reasoning
   (point-probe reads live/pending image, not the read-snapshot) is sound and matches the vtab
   contract, but it must be confirmed against the host (a Lamina unit test or a SiteCAD reload).
   **If the host probe is not live/pending-safe, fall back to option 1** (surface a per-table
   "backing pre-existed this open" bit from `module.create` vs `module.connect` and key the
   wipe/skip off that real signal instead of the ephemeral catalog — see the original ticket's
   "Fallback — option 1"). Do not build option 1 unless host validation fails.

2. **`OR REPLACE` cascade on referenced seed parents.** `OR REPLACE` is delete-then-insert on a
   conflicting row, so re-seeding a parent row that is referenced by `ON DELETE CASCADE`
   children fires that cascade **even when the replaced values are identical** (every reopen, if
   the host keeps passing `withSeed: true`). Seed tables are commonly referenced parents (the
   SiteCAD case is `tablemetadata`), so this is a real consideration, not theoretical. The
   ticket's directive was "default to `OR REPLACE`; note the tradeoff and let the dev confirm."
   The no-cascade alternative is **`INSERT OR IGNORE`** (keep the existing row, skip the seed
   row — equivalent outcome when seed values are unchanged; loses the "seed values re-asserted
   over user edits" behavior that case (d) pins). If the dev confirms cascade-on-referenced-seed
   is unacceptable, this is a one-line swap (`OR REPLACE` → `OR IGNORE`) plus updating case (d)
   and the docs — file a fix ticket rather than fixing inline if it needs the dev's call.

3. **Behavior change vs. the old full-reset.** Today's correctly-detected pre-existing path did
   a *full reset* (non-seed rows removed); the upsert leaves them. Strictly better for reopen,
   and **no spec test pinned the old full-reset** (confirmed — the only prior `with seed` specs
   are first-time seeds on fresh tables, which are unaffected). Call out if any caller is found
   relying on `with seed` to truncate-to-exactly-the-seed-rows.

## Related

- SiteCAD passes `withSeed: true` on every open (the latent contract violation that turned this
  fatal). Filed separately against site-cad as defense-in-depth; this quereus fix is the
  root-cause fix and covers all hosts.
