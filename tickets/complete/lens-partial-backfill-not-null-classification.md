description: NOT-NULL-aware classification of engine-generated `partial` lens backfill skeletons. When a key-only skeleton would omit a NOT-NULL, no-default basis column with no value source, the classifier emits `backfill_sql = null` (the app owns the insert) while keeping the `partial`/`re-decomposition` category + reconstructible-column record. Reviewed and completed.
files: packages/quereus/src/schema/lens.ts, packages/quereus/src/schema/lens-compiler.ts, packages/quereus/src/schema/basis-backfill.ts, packages/quereus/test/lens-backfill.spec.ts, docs/lens.md
----

## What shipped

The engine-generated `partial` backfill previously emitted a key-only skeleton
`insert into M (id) select id from (<prior get>)` that relied on the basis to
mint every omitted column from its declared default. Because Quereus columns are
**NOT NULL by default**, that skeleton failed an unguarded NOT NULL constraint
whenever a missing column was NOT NULL with no default — the documented
"run `backfill_sql`, then `UPDATE`" contract was un-runnable for the common case.

The fix surfaces basis-column nullability/default in the deployment snapshot and
nulls out any skeleton that cannot run, **keeping** the category + reconstructible
record so the app still learns which columns are recoverable.

### Final shape (relation-level)

- **`lens.ts`** — `LensRelationBacking.requiredBasisColumns: readonly string[]`:
  the member's basis columns that are `notNull && defaultValue === null && !generated`.
- **`lens-compiler.ts`** — `requiredBasisColumnsOf(table)` walks the member's
  **full** `TableSchema.columns` (catching required columns the lens maps to *no*
  logical column). Populated in `deriveRelationBacking`'s `add` closure on first
  backing creation.
- **`basis-backfill.ts`** — `classifyRelation` computes
  `skeletonRunnable = requiredBasisColumns ⊆ generated` (case-insensitive). When
  `generated.length > 0 && !skeletonRunnable`, `backfillSql = null` and a NOT-NULL
  clause naming the unsatisfied column(s) is appended to `reason`. Category /
  `generatedColumns` / `missingColumns` unchanged.
- **`docs/lens.md`** § Classification — Known-limitation call-out replaced with
  the shipped NOT-NULL rule; `backfill_sql` TVF-table row and Sequencing-contract
  step 3 updated.

The contract defended: **any emitted (non-null) `backfill_sql` never fails an
unguarded NOT NULL constraint**, because the skeleton inserts exactly the
`generated` columns and is emitted only when every required column is among them.

## Review findings

Adversarial pass over the implement diff (commit `ae718eb5`). Read every changed
file verbatim (`lens.ts`, `lens-compiler.ts`, `basis-backfill.ts`,
`lens-backfill.spec.ts`, `docs/lens.md`) plus `column.ts` for the predicate's
type contract.

### Soundness of the runnability predicate — verified sound and total

- **The predicate is exactly right.** `buildBackfillInsert` inserts precisely the
  `generated` (reconstructible) basis columns. `skeletonRunnable` is
  `requiredBasisColumns ⊆ generated`, i.e. "the skeleton supplies a value for
  every required column." A required column is `notNull && defaultValue === null
  && !generated` — the only columns with **no** value source (nullable → NULL,
  defaulted → default, generated → computed all have one). So the emitted skeleton
  can never omit a required column. Sound and total over all column kinds.
- **The mapped-but-not-reconstructible case is handled.** A required column mapped
  to a logical column that is *new* (not in the prior get-body) lands in `missing`,
  not `generated`, so it correctly blocks — this is exactly the `color` case.
- **No false negatives.** A required column mapped to a *reconstructible* logical
  column is in `generated`, so it does not block. The PK `id` (NOT NULL, no
  default, non-generated → it *is* in `requiredBasisColumns`) is satisfied by
  being reconstructible (in `generated`).
- **Type contract verified:** `column.ts` declares `notNull: boolean`,
  `defaultValue: AST.Expression | null` (so `=== null` is the correct "no default"
  test, not `undefined`), `generated: boolean`. The predicate is type-sound; the
  passing nullable/defaulted/NOT-NULL tests confirm the three branches.
- **Casing:** `requiredBasisColumns` and `generated` are compared lowercased;
  captured names are original-case. No mixed-case leak.

### Edge cases / tests — one gap closed inline

- **Unmapped-required edge had no test (minor — fixed inline).** The relation-level
  form was chosen so a NOT-NULL no-default basis column the lens maps to *no*
  logical column still blocks, but no test exercised it in isolation (the existing
  surrogate test uses a *defaulted* unmapped column, which does not block). Added
  `lens backfill: re-decomposition blocked by an unmapped NOT-NULL no-default
  column`: a member with an unprojected `required_extra text`. It asserts
  `category === 're-decomposition'`, `missing_columns === ''`, `backfill_sql ===
  null`, and that `reason` names the NOT-NULL block + `required_extra`. This also
  locks the "re-decomposition totality" edge the handoff flagged. It is a real
  regression guard — pre-fix the classifier would have emitted a skeleton omitting
  `required_extra`.
- Existing 12 tests reviewed (happy-path nullable, NOT-NULL no-default, defaulted,
  surrogate omission, merge/split/rename, drift, arg guards, nothing-to-do) — all
  genuinely assert behavior (round-trips actually execute the emitted SQL).

### Minor observations (not defects; no action)

- **`reason` wording for the re-decomposition-blocked case** reads "pure
  re-decomposition: every column … is reconstructible …; cannot emit a runnable
  skeleton: …". The "every column" refers to *mapped* columns while the block is an
  *unmapped* one — slightly contradictory phrasing but accurate; the new test pins
  the substantive assertions. Left as-is.
- **Pathological `not null default (null)`** would be classified as non-required
  (the literal-null is an AST node, so `defaultValue !== null`) yet fail at insert.
  Inherent limit of static classification (any default expression can evaluate to
  NULL); degenerate and out of scope.

### Docs — verified current

`docs/lens.md` §§ Classification, the `backfill_sql` TVF-table row, and the
Sequencing-contract step 3 now describe the NOT-NULL rule; the prior
known-limitation call-out is gone. Matches shipped behavior.

### Validation

- `test:single packages/quereus/test/lens-backfill.spec.ts` — 13 passing (12 prior + 1 added).
- `yarn workspace @quereus/quereus run typecheck` — exit 0.
- `yarn workspace @quereus/quereus run lint` — exit 0 (clean).

### Disposition

No major findings → no new tickets filed. One minor gap (missing unmapped-required
test) fixed inline. Implementation is sound, total, well-tested, and documented.
