description: Review the NOT-NULL-aware classification of engine-generated `partial` lens backfill skeletons — when a key-only skeleton would omit a NOT-NULL, no-default basis column, the classifier now emits `backfill_sql = null` (app owns the insert) while keeping the `partial` category + reconstructible-column record. Verify the runnability predicate is sound and total, including the unmapped-required edge.
files: packages/quereus/src/schema/lens.ts, packages/quereus/src/schema/lens-compiler.ts, packages/quereus/src/schema/basis-backfill.ts, packages/quereus/test/lens-backfill.spec.ts, docs/lens.md
----

## What changed

The engine-generated `partial` backfill emitted a key-only skeleton `insert`
(`insert into M (id) select id from (<prior get>)`) that relied on the basis to
mint every omitted column from its declared default. Because Quereus columns are
**NOT NULL by default**, that skeleton failed an unguarded NOT NULL constraint
whenever a missing column was NOT NULL with no default — the documented
"run backfill_sql, then UPDATE" contract was un-runnable for the common case.

The fix surfaces basis-column nullability/default in the deployment snapshot and
nulls out any skeleton that cannot run, **keeping** the `partial` category so the
app still learns which columns are reconstructible.

### Implementation (relation-level form, as the ticket preferred)

- **`lens.ts`** — `LensRelationBacking` gains `requiredBasisColumns: readonly string[]`:
  the member's basis columns that are `notNull && defaultValue === null && !generated`.
- **`lens-compiler.ts`** — new pure helper `requiredBasisColumnsOf(table)` walks
  the member's **full** `TableSchema.columns` (so it catches required columns the
  lens maps to *no* logical column — they never appear in the `columns` pairs).
  Populated in `deriveRelationBacking`'s `add` closure when a backing is first created.
- **`basis-backfill.ts`** — `classifyRelation` computes a runnability predicate:
  the skeleton is runnable iff every `requiredBasisColumns` entry is among the
  reconstructible (`generated`) basis columns (compared case-insensitively). When
  `generated.length > 0` **and** not runnable, `backfillSql = null` and a NOT-NULL
  clause is appended to `reason` naming the unsatisfied column(s). Category /
  `generatedColumns` / `missingColumns` are unchanged. `NewRelationGroup` threads
  `requiredBasisColumns` from the backing.
- **`docs/lens.md`** § Classification — replaced the Known-limitation call-out with
  the shipped **NOT-NULL rule**; updated the `backfill_sql` TVF-table row and the
  Sequencing-contract step 3.

## Use cases / behavior to validate

The contract being defended: **any emitted (non-null) `backfill_sql` never fails
an unguarded NOT NULL constraint.** Validation cases (all in
`packages/quereus/test/lens-backfill.spec.ts`, 12 passing):

- **NOT-NULL no-default new column** (`CarColor { id, color text }`): `category ===
  'partial'`, `generated_columns === 'id'`, `missing_columns === 'color'`,
  **`backfill_sql` is `null`**, `reason` names the NOT-NULL block; the
  re-decomposition members' SQL all run and the app supplies the CarColor insert →
  relation round-trips.
- **Nullable happy path** (`color text null`, the prior end-to-end test): skeleton
  still emitted and runnable — the regression guard.
- **Defaulted new column** (`color text default ('?')`): NOT NULL but defaulted →
  skeleton emitted, basis default mints `color`, round-trips. Pins that a
  value-source short-circuits the block.
- **Surrogate omission** (existing): `sk integer default (-1)` is unmapped but
  defaulted → not required → still runnable (re-decomposition).
- The pre-existing "new column needs application data" test was updated: it
  asserted the *old buggy* skeleton SQL for `color text`; it now asserts
  `backfill_sql` is `null`.

## Reviewer attention / known gaps

- **Soundness of the predicate.** Confirm `notNull && defaultValue === null &&
  !generated` is the correct definition of "must be supplied by the skeleton".
  Note `generated` columns and defaulted columns are deliberately treated as
  having a value source. The PK column (`id`) is `notNull` no-default but *is*
  reconstructible, so it's in `generated` → does not block — verify this holds for
  composite/surrogate keys too.
- **Unmapped-required edge.** The relation-level form was chosen specifically so a
  NOT-NULL no-default basis column that the lens maps to *no* logical column (absent
  from `columns`) still blocks. There is **no dedicated test** exercising an
  unmapped required column in isolation (the existing surrogate test uses a
  *defaulted* unmapped column, which does not block). A reviewer may want to add one
  (e.g. a member with an extra `required_extra text` column the lens never projects)
  to lock the edge the per-pair form would have missed.
- **re-decomposition totality.** A `re-decomposition` row that is somehow not
  runnable (an unmapped required column with all *mapped* columns reconstructible)
  also gets `backfillSql = null` + the NOT-NULL reason via the same `generated.length
  > 0 && !skeletonRunnable` branch. In practice re-decomposition rows are runnable;
  this just keeps the invariant total. Worth a sanity check that the reason text
  reads sensibly for a `re-decomposition` category (it appends the NOT-NULL clause
  to the "pure re-decomposition" sentence).
- **Casing.** `requiredBasisColumns` and `generated` basis columns are compared
  lowercased; the captured names are original-case. Confirm no mixed-case basis
  column slips through.

## Validation run (all green at handoff)

- `test:single packages/quereus/test/lens-backfill.spec.ts` — 12 passing.
- `yarn workspace @quereus/quereus run typecheck` — exit 0.
- `yarn workspace @quereus/quereus run lint` — exit 0.
- `yarn test` — full suite passing (3958 + workspace suites; no failures; the
  "boom"/"failed" log lines are intentional error-handling fixtures).
