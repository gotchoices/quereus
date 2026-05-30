description: The engine-generated `partial` lens backfill emits a key-only skeleton `insert` that omits the genuinely-new columns, leaving them to their basis-column default. Because Quereus columns are NOT NULL by default, that skeleton insert fails an unguarded NOT NULL constraint whenever a missing column is NOT NULL with no default — the documented "run backfill_sql, then UPDATE" contract is impossible for the common case. Surface basis-column nullability/default in the deployment snapshot and have the classifier null out (not emit) any skeleton insert that cannot run, while keeping the `partial` category so the app still learns which columns are reconstructible.
files: packages/quereus/src/schema/lens.ts, packages/quereus/src/schema/lens-compiler.ts, packages/quereus/src/schema/basis-backfill.ts, packages/quereus/test/lens-backfill.spec.ts, docs/lens.md
effort: medium
----

## Confirmed reproduction

A `partial` re-decomposition into a member with a NOT-NULL, no-default new column
emits this `backfill_sql` (verified by running the existing differ):

```
insert into y.CarColor (id) select id from (select id as id, vin as vin, speed as speed from y.Src) as __lens_prior
```

Running it verbatim throws `NOT NULL constraint failed: CarColor.color` — `color`
is a NOT NULL, no-default basis column the skeleton omits, so the basis cannot
mint it. The "seed the skeleton, then UPDATE color" contract from
docs/lens.md § Sequencing contract is un-runnable for this (default) case. The
existing `partial` test only asserts *classification* (never runs the SQL); the
review-added end-to-end test deliberately declares `color text null` to dodge the
failure. The NOT-NULL-default path is the gap this ticket closes.

## Root cause

`classifyRelation` (`src/schema/basis-backfill.ts`) builds the skeleton insert
over the **reconstructible** (`generated`) basis columns only, omitting every
`missing` column and relying on the basis to mint a value for each omitted column
from its declared default. That is sound **iff every omitted column is nullable
or defaulted** (or generated). It is unsound when an omitted column is NOT NULL
with no default — and NOT NULL is Quereus's default (`createDefaultColumnSchema`,
"Third Manifesto: default to NOT NULL"), so this is the common case, not an edge.

The classifier cannot detect this today: the snapshot's
`LensRelationBacking.columns` carries only `{ basisColumn, logicalColumn }` pairs
— no nullability or default. `deriveRelationBacking`
(`src/schema/lens-compiler.ts`) is where the basis `TableSchema` (hence each
basis `ColumnSchema` with `notNull` / `defaultValue` / `generated`) is in hand,
so the metadata must be captured there to preserve the "snapshot, not live
catalog, is the source of truth" invariant.

## Chosen behavior (decided — see tradeoff below)

**Keep `partial`, but emit `backfill_sql = null` when the skeleton cannot run.**
A `partial` relation whose skeleton would omit a NOT-NULL, no-default basis
column is reclassified to *unrunnable*: `backfillSql = null`, category stays
`partial`, `generatedColumns` / `missingColumns` stay populated, and `reason`
explains the NOT-NULL block and that the application must own the whole insert.

Why this over the alternatives:

- **vs. downgrade to `needs-data`** — `needs-data` semantically means "no column
  is reconstructible" (its rows carry an empty `generatedColumns`). Here the
  join key *is* reconstructible; emitting `needs-data` would either lie about the
  category or discard the reconstructible-column info the app can still use. `partial`
  + `null` SQL is the least-lossy honest signal.
- **vs. synthesize defaults** — no synthesis is needed: the skeleton already
  relies on basis-column defaults for the omitted columns. The only question is
  *whether the omission is sound*. When it is (every missing col nullable or
  defaulted), the current skeleton is already correct and must keep emitting —
  this is exactly the existing `color text null` happy path. When it is not, no
  default exists to synthesize, so the row must be `null`-SQL.

This mirrors the existing deferred-multi-member-surrogate precedent, which also
emits a `null`-SQL row with an explanatory `reason` rather than an unsound insert.

Acceptance #1 ("any emitted `backfill_sql` never fails an unguarded NOT NULL")
strictly also covers a basis column that maps to **no** logical column and is
NOT NULL with no default (e.g. a required member column the lens never fills) —
such a column is omitted by the skeleton but is **absent from
`relationBacking.columns`**, so per-pair flags alone won't catch it. Handle this
in the same pass (see TODO): the runnable test is best expressed at the relation
level as "every NOT-NULL, no-default, non-generated basis column of the member is
among the `generated` columns." This subsumes the mapped-missing case and the
unmapped case in one check, and leaves `re-decomposition` rows correct (they are
runnable exactly when no such omitted-required column exists).

## Snapshot metadata to capture

Extend `LensRelationBacking` (`src/schema/lens.ts`) so the classifier can decide
deterministically from the snapshot pair alone. Two viable shapes — implementer's
call, but prefer the relation-level form since it covers the unmapped case too:

- **Preferred (relation-level):** add
  `requiredBasisColumns: readonly string[]` — the member's basis columns that are
  `notNull && defaultValue === null && !generated` (original case). Populated in
  `deriveRelationBacking` from `src.table.columns` (the full member schema is in
  hand). The classifier emits runnable SQL iff `requiredBasisColumns` ⊆ the
  `generated` basis-column set; otherwise `backfillSql = null`.
- **Alternative (per-pair):** add `notNull: boolean` and `hasDefault: boolean`
  (`defaultValue !== null || generated`) to each `columns` pair. Directly drives
  the existing per-column missing/generated loop in `classifyRelation`, but only
  sees *mapped* columns — does not catch the unmapped-required case, so it under-
  satisfies acceptance #1 on that edge.

`hasDefault` must treat a generated column as "has a value source" (a generated
column never needs an inserted value).

## Where the metadata is available

`deriveRelationBacking` (`src/schema/lens-compiler.ts:254`) already resolves each
basis relation's `OverrideSource` (`.table: TableSchema`). For the relation-level
form, after the projection + join-key threading build each `LensRelationBacking`,
walk that source table's `columns` and collect the required ones. `ColumnSchema`
exposes `notNull`, `defaultValue` (`Expression | null`), and `generated`
(`src/schema/column.ts`).

Note `buildDeploymentSnapshot` builds the snapshot per-table via
`deriveRelationBacking`; the new field rides along on each backing, no extra
plumbing through `LensTableSnapshot` / `LensDeploymentSnapshot`.

## Classifier change

In `classifyRelation` (`src/schema/basis-backfill.ts:153`):

- Compute the skeleton-runnable predicate from the captured metadata (relation-
  level: `requiredBasisColumns` all present in `generated`).
- Keep the existing category derivation (`re-decomposition` / `partial` /
  `needs-data`) unchanged.
- When `generated.length > 0` **and** the skeleton is **not** runnable, set
  `backfillSql = null` and append a clear NOT-NULL-block clause to `reason`
  (e.g. `… cannot emit a runnable skeleton: basis column(s) [color] are NOT NULL
  with no default and are not reconstructible from the prior get-body, so the
  application must own the insert`). Otherwise emit the skeleton as today.
- A `re-decomposition` row that is somehow not runnable (an unmapped required
  column) likewise gets `backfillSql = null` with the same reason — preferable to
  emitting an insert that must fail. (In practice re-decomposition rows are
  runnable; this just keeps the invariant total.)

Do **not** change `generatedColumns` / `missingColumns` — they remain the honest
record of what is reconstructible vs. new even when the SQL is nulled.

## Tests

In `packages/quereus/test/lens-backfill.spec.ts`:

- **New test — NOT-NULL no-default new column.** Re-decompose into a `CarColor`
  member with `color text` (NOT NULL by default, no default). Assert the
  `y.carcolor` row: `category === 'partial'`, `generated_columns` contains `id`,
  `missing_columns` contains `color`, **`backfill_sql` is `null`**, and `reason`
  names the NOT-NULL block. Then assert running every non-null `backfill_sql`
  (the re-decomposition rows) and the app supplying the insert itself round-trips
  — i.e. no emitted SQL throws NOT NULL.
- **Keep green:** the existing `partial backfill runs end-to-end` test (`color
  text null`) must still emit a runnable skeleton and round-trip — this is the
  nullable-happy-path guard the fix must not regress.
- Consider a **defaulted-missing-column** variant (`color text default ('?')`)
  asserting the skeleton **is** emitted and runnable (default mints the value),
  to pin that `hasDefault` short-circuits the block.

## Docs

`docs/lens.md` § Classification (around line 250-260):

- Replace the **Known limitation** call-out (lines ~260) with the shipped rule:
  a `partial` row emits runnable `backfill_sql` **only when every omitted (missing
  / unmapped) basis column is nullable, defaulted, or generated**; otherwise
  `backfill_sql` is `null` and the application owns the insert (the NOT-NULL
  rule), with the reconstructible columns still listed in `generated_columns`.
- Update the `backfill_sql` row of the TVF column table (line ~271) and the
  Sequencing contract step 3 (line ~284) so they no longer imply a `partial`
  row's SQL is always runnable — `NULL` now also means "partial, but the skeleton
  would violate NOT NULL; app owns the insert."

## Validation

- `yarn workspace @quereus/quereus run test:single packages/quereus/test/lens-backfill.spec.ts`
  (stream with `2>&1 | tee /tmp/lens-bf.log; tail -n 80 /tmp/lens-bf.log`).
- `yarn workspace @quereus/quereus run typecheck`.
- `yarn workspace @quereus/quereus run lint` (single-quote globs on Windows).
- Full `yarn test` before handoff.

## TODO

- [ ] Capture required-column metadata in `deriveRelationBacking` (`lens-compiler.ts`) — prefer relation-level `requiredBasisColumns` on `LensRelationBacking` (`lens.ts`), computed from the member `TableSchema.columns` (`notNull && defaultValue === null && !generated`).
- [ ] In `classifyRelation` (`basis-backfill.ts`), compute the skeleton-runnable predicate; when not runnable, set `backfillSql = null` and explain the NOT-NULL block in `reason`. Leave category / `generatedColumns` / `missingColumns` as-is.
- [ ] Add the NOT-NULL no-default test (assert `backfill_sql` null + reason); keep the nullable end-to-end test green; optionally add the defaulted-column runnable variant.
- [ ] Update docs/lens.md § Classification: replace the Known-limitation call-out with the NOT-NULL rule; fix the `backfill_sql` / Sequencing-contract wording.
- [ ] Run test:single + typecheck + lint, then full `yarn test`; hand off honest about any gap (e.g. if only the per-pair form was implemented, note the unmapped-required edge remains).
