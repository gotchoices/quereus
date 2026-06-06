description: Review the deploy-time guard that rejects a decomposition whose member stitch key (columnar) or EAV `(entity, attribute)` conflict target is not a declared PRIMARY KEY / non-partial UNIQUE. Corner #1 of view-write-decomposition-optional-update hardening. NOTE: this branch's diff also restores the entire `packages/quereus` engine that a prior commit deleted — see "⚠ Diff scope" first.
files: packages/quereus/src/schema/lens-compiler.ts (validatePrimaryAdvertisement + resolveColumnIndices/indicesFormDeclaredUnique helpers), packages/quereus/src/planner/mutation/decomposition.ts (buildOptionalMaterializeInsert / buildEavMaterializeInsert doc comments), packages/quereus/test/lens-put-fanout.spec.ts (describe 'stitch-key uniqueness guard'), docs/lens.md (§ The put fan-out), tickets/.pre-existing-error.md
----

## ⚠ Diff scope — read this first

This ticket's commit touches **~900 files**, but only **4** carry the ticket's logic.
The other ~896 are a **verbatim restoration** of the `packages/quereus` engine, which a
prior commit deleted by accident.

- Commit `1cf7326c` ("ticket(plan): view-write-decomposition-optional-update-hardening")
  — the plan-stage transition that produced this ticket — also deleted the **entire**
  `packages/quereus` package: 901 files, ~250,548 deletions. `packages/quereus/` was empty
  and untracked at HEAD; the package is intact on `main`, `dev`, and the parent commit
  `3a5a7ef5`.
- I restored it with `git checkout 3a5a7ef5 -- packages/quereus`; `git diff 3a5a7ef5 --
  packages/quereus` (excluding my 3 edited files) is empty — the restoration is byte-identical
  to the pre-deletion state.
- **To review only the ticket logic**, diff the four files against `3a5a7ef5`:
  `git diff 3a5a7ef5 -- packages/quereus/src/schema/lens-compiler.ts
  packages/quereus/src/planner/mutation/decomposition.ts
  packages/quereus/test/lens-put-fanout.spec.ts docs/lens.md`
  → **+239 lines, 0 deletions** (lens-compiler +69, decomposition +12, spec +156, docs +2).
- `tickets/.pre-existing-error.md` documents the deletion for the runner's triage pass. Triage
  should find nothing to fix (already restored) — it exists to alert a human that a *plan*-stage
  runner emitted a 250k-line deletion, which may recur.

## What the change does (the actual ticket)

A deployed decomposition lens materializes absent optional/EAV component rows on UPDATE with an
`insert … on conflict (<target>) do nothing`. That `do nothing` is what partitions the affected
rows between the matched UPDATE (component exists) and the materialize INSERT (component absent):
the runtime only fires `do nothing` on a declared **PK / UNIQUE** violation, so if the conflict
target is not a declared unique, matched rows are **double-inserted** instead of ceded. The same
uniqueness underwrites the **read** side (a non-unique columnar stitch key multiplies the
equi-join; a non-unique `(entity, attr)` makes the EAV correlated subquery multi-valued).

Added a **deploy-time** guard in `validatePrimaryAdvertisement` (runs at `apply schema`, the only
gate that governs both read and write directions and fires once rather than per-mutation):

- **columnar member** — the stitch key columns
  (`sharedKey.keyColumnsByRelation.get(member.relationId)`) must equal a declared PK or
  non-partial UNIQUE on the member basis. An **empty** stitch key (`primary key ()` singleton) is
  skipped (no stitch, no materialize path).
- **EAV pivot member** — the conflict target is `(entityColumn, attributeColumn)` — **not** the
  stitch key (`entity` alone, deliberately one-to-many). That pair must equal a declared PK /
  non-partial UNIQUE.
- The **anchor** is validated too (its own stitch key must be 1:1 for the logical-PK / surrogate
  identity).
- "Equal a declared unique" = **exact set-equality** with a PK column set or a UNIQUE whose
  `predicate === undefined` (a partial `unique … where` is excluded — it only guarantees
  uniqueness within its scope). Two private helpers: `resolveColumnIndices` (names→indices, returns
  `undefined` on an unresolved name so an already-reported missing column isn't double-reported)
  and `indicesFormDeclaredUnique` (set-equality vs PK / non-partial UCs).

Errors are plain strings pushed to the existing `errors[]` and aggregated into the existing
`QuereusError` (`lens: advertisement for logical table '…' is invalid: …`) — consistent with the
sibling deploy-time checks (no `raiseMutationDiagnostic` / reason code at deploy).

Doc comments on `buildOptionalMaterializeInsert` / `buildEavMaterializeInsert` now state the
conflict target is deploy-time-guaranteed unique (so the plan-time builders rely on it, no
redundant plan-time check). `docs/lens.md` § The put fan-out documents the invariant.

## Use cases / validation (tests are a floor — extend them)

New `describe('lens decomposition put: stitch-key uniqueness guard')` in
`test/lens-put-fanout.spec.ts` (4 tests; full quereus suite **4911 passing / 9 pending**, lint
clean, `tsc` build clean):

- **reject (columnar)** — member `U_c (rid integer primary key, id integer, c integer)`, stitch
  key `['id']` (a plain non-unique column; PK is the unrelated `rid`). `apply schema` throws
  `/stitch key.*not a declared|1:1 stitch/i`.
- **reject (EAV)** — `Ev_eav (rid integer primary key, eid integer, attr text, val integer)`,
  pivot `(eid, attr)` not unique. `apply schema` throws `/EAV pivot.*conflict target.*not a
  declared/i`.
- **accept (UNIQUE not PK) + round-trip** — `W_c (rid integer primary key default (high-water
  mark), id integer unique, c integer)`, stitch `['id']`. Deploys (guard matches the UNIQUE, not
  the PK); a matched UPDATE cedes via `on conflict (id) do nothing`, an absent UPDATE materializes
  (with `rid` auto-filled), `count(*)` confirms no double-insert.
- **accept (singleton)** — `singletonAd` (`primary key ()`) deploys; the empty stitch key is
  skipped, not rejected.

Regression coverage already in the file (would fail if the guard wrongly rejected these): every
PK-stitch fixture (`split`, `multiSplit`, `eavSplit`, surrogate, `nonIdentityAd`), the
self-decomposition deploy+read (`setupSelfDecomposition`), and the empty-schema vehicle
(`setupEmptySchema`, member with `relation.schema: ''` resolved against basis). All pass.

### Reviewer attention / known gaps

- **Why the accept-case needs a default on `rid`.** PK columns in Quereus are NOT NULL with no
  auto-rowid (confirmed: `id INTEGER NOT NULL PRIMARY KEY`). The ticket's literal `(rid integer
  primary key, id integer unique, c integer)` would make the materialize INSERT (which inserts only
  `(stitchKey, value)`) trip `assertNoMissingNotNull` on the omitted `rid`. I added a high-water-mark
  `default` to `rid` (mirroring the surrogate fixture) so the round-trip genuinely exercises the
  materialize path. This is a faithful adaptation, not a deviation from intent — worth a sanity check.
- **Partial UNIQUE not directly tested.** The `predicate !== undefined` skip is asserted only by
  construction/code-read (the ticket marked a fixture hard to build through the lens and the test
  optional). A reviewer wanting belt-and-suspenders could add a `create unique index … where …`-derived
  partial UC on a stitch column and assert it is still rejected.
- **Anchor-stitch rejection not independently pinned.** All fixtures give the anchor a PK stitch, so
  the "anchor included" branch is exercised only on the accept side. A targeted reject vehicle (anchor
  stitch non-unique) would lock it.
- **Exact-set-equality semantics.** The guard requires the conflict-target column set to *exactly*
  equal a declared key — a superset/subset UNIQUE does not qualify (mirrors how `on conflict (cols)`
  resolves). Confirm this matches the runtime `on conflict` resolver's matching rule
  (`dml-executor.ts` `matchUpsertClause`); if the runtime allows a prefix/permutation match the guard
  could be marginally stricter than necessary (safe direction, but note it).
- **Coverage scope.** Validated against the in-memory vtab path only (`yarn test`). Not run under
  `yarn test:store` (LevelDB) — the guard is pure schema-shape validation independent of the storage
  module, so store divergence is unlikely, but it was not exercised.
