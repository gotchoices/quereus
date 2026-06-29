description: When a database is seeded, a seed row that violates a table rule (like a CHECK or NOT NULL constraint) is now silently dropped instead of reporting an error, so a typo in seed data can vanish without warning.
prereq:
files:
  - packages/quereus/src/runtime/emit/schema-declarative.ts   # seed insert uses INSERT OR IGNORE
  - packages/quereus/src/runtime/emit/constraint-check.ts      # IGNORE skips CHECK/NOT NULL rows (skip:true)
difficulty: medium
---

## Background

Ticket `seed-reseed-or-replace-cascade-tradeoff` switched declarative seed
application from `INSERT OR REPLACE` to `INSERT OR IGNORE` (one statement per
seed row, in `emitApplySchema`). This correctly stops a reopen reseed from
firing `ON DELETE CASCADE` on unchanged seed parents, and preserves user edits.

## The concern

`OR IGNORE` in Quereus follows SQLite semantics: it silently skips a row on
**any** constraint failure, not just PK/UNIQUE. `constraint-check.ts` returns
`{ skip: true }` for an `IGNORE` action on a failing CHECK (line ~376) and on a
NOT NULL violation, and the FK existence check is built as a CHECK as well.

That means a **malformed seed row** — one that violates a table `CHECK`, a
`NOT NULL` column, or a child-side FK — is now **silently dropped on the very
first apply** (fresh table), with no error surfaced to the schema author. Under
the previous `OR REPLACE`, those same violations still aborted (REPLACE only
relaxes UNIQUE/PK and NOT-NULL-with-default; CHECK/FK still threw), so a
typo'd seed row produced a visible `CHECK constraint failed: …` wrapped by the
seed error handler in `emitApplySchema`.

So the cascade fix traded away seed-data error visibility. For trusted,
hand-authored seed data this is usually fine, but a silently-vanishing seed row
is a real footgun: the table simply comes up missing a row with no diagnostic.

## Possible direction (not a mandate)

A more surgical formulation would avoid **both** problems at once — keep the
cascade-avoidance of `OR IGNORE` while restoring constraint-error visibility:

```sql
insert into <table> (<pk-cols>, …) values (…)
  on conflict (<pk-cols>) do nothing
```

`ON CONFLICT (<target>) DO NOTHING` only suppresses the *named* uniqueness
conflict (the seed PK already present) and lets CHECK / NOT NULL / FK / untargeted
UNIQUE violations abort as usual. Quereus already supports
`on conflict … do nothing` (see `47-upsert.sqllogic` and the store
`ON CONFLICT DO NOTHING` tests). The cost is that the emitter must know the
table's PK column list and emit an explicit column list + conflict target,
rather than the current bare `VALUES (...)` form.

Decide whether the added complexity is worth it, or whether silently-skipped
malformed seed rows are an acceptable property of trusted seed data (in which
case close this with a documented rationale in `docs/schema.md`).

## Acceptance

- A seed row that violates a `CHECK` / `NOT NULL` / child FK either (a) raises a
  clear error on first apply, or (b) is documented as intentionally skipped.
- Whichever path is chosen, the cascade-avoidance and user-edit-preservation
  behavior pinned by `50-declarative-schema.sqllogic` (the `decl_seed_idem` and
  `decl_seed_cascade` sections) and `seed-reopen-idempotent.spec.ts` must still hold.
- A test pins the chosen first-apply behavior for a malformed seed row.
