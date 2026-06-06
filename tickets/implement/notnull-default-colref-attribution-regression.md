description: Pin the (verified-correct) NOT NULL error attribution for column-reference DEFAULTs with regression tests and a clarifying comment. The originally-suspected "misattribution" bug does not exist — the repro's `c1.a` message is correct because the sibling column is itself implicitly NOT NULL. This ticket codifies the real semantics so the concern is not re-filed.
files: packages/quereus/test/logic/03.4-defaults.sqllogic, packages/quereus/src/runtime/emit/constraint-check.ts, packages/quereus/src/planner/building/constraint-builder.ts
----

## Background — why this is tests + a comment, not a code fix

The plan-stage investigation reproduced the original ticket's exact case and
traced the error to its source. The conclusion: **the error attribution is
already correct; there is no defect to fix.**

The original repro:

```sql
create table c1 (id integer primary key, a integer, b integer not null default (new.a));
insert or replace into c1 (id, b) values (1, null);   -- error: NOT NULL constraint failed: c1.a
insert into c1 (id, b) values (1, null);              -- error: NOT NULL constraint failed: c1.a
```

Why `c1.a` is the **correct** column to name:

- This engine defaults columns to **NOT NULL** (`default_column_nullability='not_null'`,
  the Third-Manifesto alignment — see `test/logic/43-default-nullability.sqllogic`).
  So a bare `a integer` is itself a NOT NULL column.
- The INSERT supplies `(id, b)` and **omits `a`**. `a` has no DEFAULT, so its value
  is NULL. That violates `a`'s *own* NOT NULL constraint.
- `checkNotNullConstraints` (`runtime/emit/constraint-check.ts`) walks columns in
  declaration order and throws on the **first** NOT-NULL-violating column, naming it
  via `tableSchema.columns[i].name`. Column `a` (index 1) is checked before `b`
  (index 2), so `a` is reported. This is purely index-based — there is **no**
  "failing value's source attribute" tracing of the kind the original ticket
  hypothesised, so the proposed "thread the enforced column's identity" fix would
  be changing code that already names the enforced column.

When the sibling is *explicitly nullable*, the defaulted column is named correctly
(confirmed in the investigation):

```sql
create table c2 (id integer primary key, a integer null, b integer not null default (new.a));
insert or replace into c2 (id, b) values (1, null);        -- error: NOT NULL constraint failed: c2.b  ✓
insert into c2 (id, b) values (2, null);                   -- error: NOT NULL constraint failed: c2.b  ✓
insert or replace into c2 (id, a, b) values (3, 7, null);  -- ok, b = 7 (default new.a substituted)     ✓
insert or replace into c2 (id, a, b) values (4, null, null);-- error: NOT NULL constraint failed: c2.b  ✓
```

The original ticket's own "correct" example (`c3`, sibling supplied non-NULL)
already passes for the same reason: `a` satisfies its NOT NULL check and `b`'s
default substitutes the supplied sibling value.

**Net:** the only thing the original repro demonstrates is that a bare column is
NOT NULL by default. The fix is to *document and pin* this, not to change runtime
attribution.

## Goal

1. Add sqllogic regression coverage that locks in the correct attribution across
   the nullable / not-null sibling matrix, including the original repro (asserting
   `c1.a` is intentionally correct).
2. Add a short clarifying comment at the NOT NULL check site so a future reader
   does not mistake the column-order-first-violator behaviour for misattribution.

## Edge cases & interactions (write these as tests / cover in review)

- **Sibling nullability is the whole story.** Cover both `a integer` (implicit
  NOT NULL → omitting it names `a`) and `a integer null` (omitting/explicit-NULL
  the defaulted column names the defaulted column `b`).
- **OR REPLACE vs plain INSERT throw via different sites.** REPLACE substitutes the
  default then rejects only if the *substituted* value is still NULL
  (`constraint-check.ts` REPLACE branch); plain INSERT/ABORT rejects directly via
  `throwForAction`. Both must name the same column. Assert both forms.
- **Successful substitution path.** Nullable sibling supplied non-NULL → the NOT
  NULL defaulted column takes the substituted sibling value (no error). Assert the
  stored value, not just the absence of an error.
- **Both sibling and defaulted column NULL** (nullable sibling, explicit NULL for
  both) → names the defaulted column `b` (the default resolves to NULL).
- **Column ordering — first violator wins.** A table where the NOT NULL *defaulted*
  column is declared *before* its referenced sibling, with both omitted: confirm the
  message names whichever NOT NULL column is first in declaration order with a NULL
  effective value (matches SQLite's first-violation reporting). Document the chosen
  expectation explicitly in the test.
- **IGNORE conflict action.** `insert or ignore` into the nullable-sibling table
  with the defaulted column NULL and no usable default → row is silently skipped
  (no row inserted, no error). Guards the IGNORE branch.
- **Store-module parity.** `03.4-defaults.sqllogic` also runs under `yarn test:store`.
  The constraint-check path is module-agnostic, so the new cases must pass
  identically there — do NOT add memory-only assertions or rely on memory internals.
  (Agent-run validation uses `yarn test` only; `test:store` is out-of-band — note it,
  don't run it in-ticket unless quick.)
- **Don't regress the existing `isn't a column` cases.** The nearby tests assert
  that referencing an *omitted* sibling in a row-expansion default raises
  `isn't a column`. The new NOT-NULL cases use OR REPLACE / explicit values, which
  exercise the `buildNotNullDefaults` (fully-materialised-row) path, NOT the
  row-expansion path — keep the two distinct and don't blur the comments.

## TODO

- Add a new `-- new.<column> NOT NULL default — error attribution` section to
  `packages/quereus/test/logic/03.4-defaults.sqllogic` (near the existing
  `new.<column>` section, ~line 40-65) with cases covering the matrix above:
  - implicit-NOT-NULL sibling omitted → `NOT NULL constraint failed: <t>.a`
    (with a comment: correct — the bare sibling is itself NOT NULL).
  - nullable sibling, `insert or replace` omitting the defaulted col, sibling NULL
    → names the defaulted column.
  - nullable sibling, plain `insert` with explicit NULL for the defaulted col,
    sibling NULL → names the defaulted column.
  - nullable sibling supplied non-NULL → substitution succeeds; assert stored value.
  - nullable sibling + explicit NULL for both → names the defaulted column.
  - defaulted-NOT-NULL-column-before-sibling ordering case → assert first-violator.
  - `insert or ignore` skip case → assert no row / no error.
  - DROP the temp tables at the end of the section (match file style).
- Add a 2-3 line comment in `checkNotNullConstraints`
  (`packages/quereus/src/runtime/emit/constraint-check.ts`, the
  `const message = \`NOT NULL constraint failed: ...\`` site) noting that
  attribution is the first NOT-NULL-violating column in declaration order and is
  independent of which column any DEFAULT references — i.e. a NULL sibling named by
  a `new.<col>` default is reported on its own merits, not threaded into the
  defaulted column's message.
- Optionally extend the `buildNotNullDefaults` doc comment in
  `packages/quereus/src/planner/building/constraint-builder.ts` with a one-line
  note that error attribution happens at check time by column index (so readers
  don't look for it in the default-builder).
- Validate: `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/nn.log; tail -n 40 /tmp/nn.log`
  and lint the touched TS:
  `yarn workspace @quereus/quereus run lint 2>&1 | tee /tmp/lint.log; tail -n 20 /tmp/lint.log`.
- If `yarn test` surfaces a failure clearly outside this diff, follow the
  pre-existing-error flag procedure rather than chasing it.
