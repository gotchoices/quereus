description: Engine-emitted backfill DDL for lens basis re-decompositions — the persisted/hash-coded lens deployment snapshot, the re-decomposition classifier/generator, and the `quereus_basis_backfill(logical_schema)` introspection TVF. Reviewed and completed.
files: packages/quereus/src/schema/lens.ts, packages/quereus/src/schema/declared-schema-manager.ts, packages/quereus/src/schema/lens-compiler.ts, packages/quereus/src/schema/basis-backfill.ts, packages/quereus/src/func/builtins/explain.ts, packages/quereus/src/func/builtins/index.ts, packages/quereus/test/lens-backfill.spec.ts, docs/lens.md
----

## What landed

Second-phase lens deployment polish: the engine-dischargeable half of the
basis-evolution backfill obligation (pure re-decompositions — split / merge /
rename), with genuinely-new-information backfills left to the application.

- **Deployed representation** (`lens.ts`, `declared-schema-manager.ts`,
  `lens-compiler.ts`): `LensDeploymentSnapshot` / `LensTableSnapshot` /
  `LensRelationBacking` captured by `deployLogicalSchema` after a successful
  catalog mutation and **rotated** (`previous ← current`) in
  `DeclaredSchemaManager`. `deriveRelationBacking` walks the compiled body's
  projection **plus shared join-key threading** so a columnar-split member that
  carries the key but doesn't project it is still backfillable.
- **Classifier + generator** (`basis-backfill.ts`): pure
  `computeBasisBackfill(prev, current, liveBasisHash?)` diffs the snapshot pair,
  finds new basis relations, classifies each column reconstructible vs new, emits
  `insert … select … from (<prior get>)` as an AST → `astToString`, and detects
  basis-hash drift. Categories `re-decomposition` / `partial` / `needs-data`.
- **TVF** (`explain.ts`, `index.ts`): `quereus_basis_backfill(logical_schema)`
  (logical-schema guard mirroring `quereus_effective_lens`), recomputes the live
  basis hash for drift detection, yields the classified rows.
- **Docs** (`docs/lens.md` § The deployed basis representation).

## Validation status (all green)

- `yarn workspace @quereus/quereus test` → **3919 passing, 9 pending, 0 failing**
  (3916 → 3919: +3 review-added tests; see below).
- `yarn typecheck` clean; lint clean on all changed files + the new test.

## Review findings

Adversarial pass over the implement diff (commit `22b23635`). Checked from every
aspect angle; verified the snapshot/rotation/diff path, the threading, drift,
generated-SQL validity (every emitted `backfill_sql` is exec'd and round-trips in
tests), TVF guards, and docs-vs-reality.

### Major (filed as new ticket)

- **`partial` skeleton insert is un-runnable in the NOT-NULL-default case.**
  `partial` emits a key-only skeleton `insert into R (<reconstructible>) select …`
  leaving the new column NULL for the app to UPDATE. **Quereus columns are NOT
  NULL by default** (verified directly: `insert into T (id) values (1)` →
  `NOT NULL constraint failed: T.color` for `color text`). So running the
  generated `partial` `backfill_sql` verbatim fails at runtime for the common
  case — the documented "run it then UPDATE" contract is impossible (you can't
  seed the skeleton row first). The implementer flagged skeleton-insert as an open
  design question (reviewer-focus #1); review **confirms it is a real runtime
  failure**, latent only because the existing `partial` test asserts classification
  but never *runs* the backfill. Root cause: the classifier has no visibility into
  basis-column nullability/defaults (the snapshot's `relationBacking` carries only
  `basisColumn → logicalColumn`). Filed → **`fix/lens-partial-backfill-not-null-classification.md`**
  (reclassify / null-out `backfill_sql` / synthesize defaults — design call +
  snapshot metadata capture). A docs caveat was added inline in the interim
  (docs/lens.md § Classification).

### Minor (fixed inline this pass)

- **Test floor raised** (`test/lens-backfill.spec.ts`, 7 → 10 cases):
  - `partial backfill runs end-to-end` — actually *runs* the skeleton insert
    (nullable new column), confirms the inner join then yields a row per logical
    tuple with the new column NULL, the app `UPDATE`s it, and the relation
    round-trips. This is the test that surfaced the NOT-NULL major finding above
    (it had to use `null` columns to be runnable).
  - `rename re-decomposition` — the ticket title scopes "split / merge / **rename**"
    but no test covered a pure single-relation rename; added (basis `Src` →
    `Vehicle`, retain source, re-point lens, backfill round-trips).
  - `argument guards` — the TVF error paths were untested; added coverage for
    non-logical schema, `main`, unknown schema, and a non-string argument.
- **Docs caveat** added to docs/lens.md § Classification documenting the
  NOT-NULL-default limitation of `partial` `backfill_sql` pending the fix ticket.

### Checked — no change needed (with reasons)

- **Index alignment in `deriveRelationBacking`** (`nonHidden[i]` ↔ `body.columns[i]`):
  verified sound for both body producers — `compileOverrideBody` pushes one
  `composed` entry per non-hidden logical column in declaration order (hidden are
  `continue`d before the push but still added to provenance), and
  `compileDefaultBody` + its provenance both iterate `logicalTable.columns` with
  no hidden, so the filtered-provenance order matches the projection order.
- **SELECT-by-logical-name from the prior-get subquery**: sound. Override bodies
  alias each projected column to the logical name; default bodies are name-match
  (basis name ≡ logical name, case-insensitive), so `select <logicalName> from
  (<prior get>)` resolves either way. Confirmed by every round-trip test exec'ing
  the generated SQL.
- **Join-key threading** (`collectJoinKeyEquivalences`): the columnar-split path
  threads the shared key into the non-anchor member so its NOT NULL PK is
  backfilled — without it the split member's insert would omit the key and fail.
  Exercised by the split + partial tests (`using` path).
- **Basis-hash drift is live-vs-current, not prev-vs-current** (reviewer-focus #3):
  correct — prev ≠ current is true for *every* normal re-decomposition; the
  meaningful signal is "basis drifted out-of-band since the last lens deploy",
  i.e. recomputed-live vs recorded-current. Test `snapshot rotation + basis-hash
  drift` covers both the no-drift and drift cases.
- **Snapshot captured after catalog mutation** (atomic): an aborted re-apply
  leaves the prior snapshot intact — the rotate call is the last statement of
  `deployLogicalSchema`, after the clear-and-rebuild.

### Checked — known deferrals, untested but sound (left as-is)

- **Multi-member surrogate split deferral** (reviewer-focus #4): dormant defensive
  code — the v1 body producer never synthesizes the advertisement join, so
  `relationBacking` never lists advertisement members as new relations and the
  `deferSurrogate` branch is unreachable today. No test can set it up until
  `lens-multi-source-decomposition` lands; left as documented defensive code.
- **Computed (non-column) projections get no basis backing** (reviewer-focus #5):
  correct for pure split/merge/rename (plain column refs only); a computed logical
  column is omitted from `relationBacking` and plays no part in classification.
  Acceptable for v1.
- **ON-condition key threading is best-effort** (reviewer-focus #6): only
  AND-conjoined `col = col` equalities thread; `using (...)` is the exercised
  path. Complex ON predicates won't thread keys → such split members classify
  `partial`/`needs-data`. Acceptable for v1.
- **No enforcement of the sequencing contract** (reviewer-focus #7): by design
  (ingredient model) — the engine generates DDL, the app retains prior members and
  orders the steps. Unguarded, documented in docs/lens.md § Sequencing contract.

### Other boundaries noted (no action)

- A reconstructible/new column added to an **existing** basis relation (not a new
  relation) emits **no** backfill row — the classifier only treats *new* relations
  as sites, and an in-place add needs an `UPDATE`, not an `INSERT`. This is an
  ALTER-shaped scenario outside the split/merge/rename scope; noted as a boundary,
  not a defect.

## Known deferrals (unchanged from implement)

- Multi-member **surrogate** split threading → `lens-multi-source-put-fanout`.
- Echoing the backfill summary into the prover's `LensDeployReport` → later ticket.
- GC of detached prior basis storage → app-driven, out of scope.
