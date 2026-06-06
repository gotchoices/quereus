description: Review the regression tests + clarifying comments that pin the (already-correct) NOT NULL error attribution for column-reference DEFAULTs. No runtime behavior changed — this is tests + comments only. Verify the attribution semantics are correctly locked in so the "misattribution" concern is not re-filed.
files: packages/quereus/test/logic/03.4-defaults.sqllogic, packages/quereus/src/runtime/emit/constraint-check.ts, packages/quereus/src/planner/building/constraint-builder.ts
----

## What was implemented

The originally-suspected "misattribution" bug **does not exist** — the repro's
`c1.a` message is correct because the bare sibling column is itself implicitly
NOT NULL. This change codifies the real semantics with regression coverage and
two clarifying comments. **No runtime code path was changed.**

### Edits (3 files, all additive)

1. **`test/logic/03.4-defaults.sqllogic`** — new section
   `new.<column> NOT NULL default — error attribution`, inserted right after the
   `t_newref` section (the existing `new.<column>` material), before the VIEW
   section. Three temp tables, dropped at the end of each block.

2. **`src/runtime/emit/constraint-check.ts`** — a 6-line comment above the
   `for` loop in `checkNotNullConstraints` (the column-walk that builds the
   `NOT NULL constraint failed: <t>.<col>` message). States that attribution is
   the first NOT-NULL column in declaration order with a NULL effective value,
   independent of which column any DEFAULT references.

3. **`src/planner/building/constraint-builder.ts`** — extended the
   `buildNotNullDefaults` doc comment with a one-line note that error attribution
   is decided at *check* time by column index, not in the default builder.

## Why `c1.a` is the correct attribution (the crux)

- Engine default is `default_column_nullability='not_null'` (Third-Manifesto;
  see `test/logic/43-default-nullability.sqllogic`, and the option default in
  `core/database.ts`). A bare `a integer` is therefore itself NOT NULL.
- `checkNotNullConstraints` walks columns in **declaration order** and throws on
  the **first** NOT-NULL-violating column, naming it via `columns[i].name`. There
  is no "failing value's source attribute" tracing — attribution is purely
  index-based. So when the INSERT omits `a` (no DEFAULT → NULL), `a` (index 1)
  is reported before `b` (index 2). Correct.

## Test matrix added (all assert column names / stored values)

| Table  | Case | Form | Expected |
|--------|------|------|----------|
| `c1` (bare `a`, `b not null default (new.a)`) | omit `a`, `b`=null | `insert or replace` | error `c1.a` |
| `c1` | omit `a`, `b`=null | plain `insert` | error `c1.a` |
| `c2` (`a integer null`, `b not null default (new.a)`) | omit `a`, `b`=null | `insert or replace` | error `c2.b` |
| `c2` | `b`=null (explicit) | plain `insert` | error `c2.b` |
| `c2` | `a`=7, `b`=null | `insert or replace` | ok, **stored `b`=7** (substituted) |
| `c2` | `a`=null, `b`=null | `insert or replace` | error `c2.b` |
| `c2` | `b`=null, no usable default | `insert or ignore` | row skipped, `select id … = 5 → []` |
| `c_ord` (`b not null default (new.a)` declared **before** bare `a`) | both null | `insert or replace` | error `c_ord.b` (first violator wins) |

Key contrasts the reviewer should confirm read correctly:
- **REPLACE vs plain INSERT throw via different sites** (REPLACE: missing/NULL
  default substitution in `constraint-check.ts`; plain: `throwForAction`) yet
  name the **same** column — asserted for both `c1` and `c2`.
- **First-violator ordering**: `c1` names the *sibling* (declared first); `c_ord`
  names the *defaulted* column (declared first). Same rule, opposite outcome.
- All new cases ride the **materialised-row** (`buildNotNullDefaults`) path via
  OR REPLACE / explicit values — deliberately **not** the row-expansion
  `isn't a column` path that the nearby existing cases exercise. The two are kept
  distinct in the comments (per the original ticket's warning not to blur them).

## Validation performed

- `yarn workspace @quereus/quereus run test:single packages/quereus/test/logic.spec.ts --grep "03.4-defaults"` → **1 passing**.
- `yarn workspace @quereus/quereus test` (full memory-module suite) → **4853 passing, 9 pending, 0 failing**.
- `yarn workspace @quereus/quereus run lint` → **clean** (exit 0). (TS edits are
  comments only, so no lint surface changed.)

## Known gaps / reviewer follow-ups (honest floor, not a ceiling)

- **`test:store` parity was NOT run in-ticket** (out-of-band per the ticket;
  `test:store` is the slow LevelDB path). The constraint-check / NOT-NULL path is
  module-agnostic and the new cases use no memory internals, so they *should* pass
  identically — but this is **unverified**. A reviewer with time should run
  `yarn workspace @quereus/quereus test:store` (or the targeted equivalent) and
  confirm `03.4-defaults` passes under the store module.
- **`c_ord` asserts only the OR REPLACE form** of the ordering case (one assertion
  is enough to demonstrate first-violator; plain `insert` would name the same
  column via `throwForAction`). If desired, a plain-`insert` row could be added
  for symmetry with `c1`/`c2`.
- **No new assertion for the omit-both → `isn't a column` path on `c_ord`.** That
  row-expansion behavior is already covered by the existing `t_newref` /
  `sd_t` / `ac_t` cases; the comment notes why `c_ord` uses explicit NULLs to stay
  off that path. Reviewer should confirm this separation reads clearly rather than
  expanding coverage that would conflate the two paths.
- The IGNORE case asserts absence via `select id … = 5 → []` (clear and direct)
  rather than a `count(*)` — equivalent, but worth a glance if a stronger
  whole-table assertion is preferred.
