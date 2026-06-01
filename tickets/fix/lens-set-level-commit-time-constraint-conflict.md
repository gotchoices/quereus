description: A commit-time lens set-level key (`enforced-set-level{mode:'commit-time'}`) whose UNIQUE/PK constraint carries a **constraint-level** `on conflict replace` / `ignore` (`UniqueConstraintSchema.defaultConflict`, or a PK column's `defaultConflict`) is not caught by the conflict-resolution rejection added in `lens-set-level-commit-time-enforcement`. That rejection (`rejectLensSetLevelConflictResolution`) inspects only the **statement-level** `req.stmt.onConflict` / `upsertClauses`, so a plain `insert` of a duplicate into such a table silently ABORTs at commit instead of honoring the declared REPLACE/IGNORE. Sound (it over-aborts; it never admits a duplicate) but violates the declared conflict action — the exact failure mode the rejection exists to prevent, reached through the constraint-level channel.
prereq: lens-set-level-commit-time-enforcement
files: packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/planner/mutation/lens-enforcement.ts, packages/quereus/src/schema/lens-prover.ts, packages/quereus/src/schema/table.ts, docs/lens.md
----

## The bug

`lens-set-level-commit-time-enforcement` enforces a logical `unique`/PK with no
basis covering structure via a deferred `(select count(*) … ) <= 1` count CHECK
that can only **ABORT** at commit. Because a commit-time scan cannot replace or
skip the offending row, the builder rejects conflict-resolution writes up front
(`rejectLensSetLevelConflictResolution` in `view-mutation-builder.ts`).

That rejection only looks at the **statement**:

```ts
if (req.stmt.onConflict === ConflictResolution.REPLACE) reject('insert or replace');
if (req.stmt.onConflict === ConflictResolution.IGNORE) reject('insert or ignore');
if (req.stmt.upsertClauses?.length) reject('upsert (on conflict do …)');
```

But Quereus also honors a **constraint-level** default conflict action (three-tier
resolution: statement OR > per-constraint `defaultConflict` > ABORT — see
`resolveEffective` / `checkUniqueConstraints` in `vtab/memory/layer/manager.ts`
and `quereus-isolation/src/isolated-table.ts`). A logical declaration like

```sql
declare logical schema x {
  table u (id integer primary key, email text null, unique (email) on conflict replace)
}
```

populates `UniqueConstraintSchema.defaultConflict = REPLACE` (see
`schema/manager.ts` ~lines 1001/1022 for table/column UNIQUE, and a PK column's
`defaultConflict`). With no covering structure the key classifies
`enforced-set-level{commit-time}`. A plain `insert into x.u … (duplicate email)`
then hits the synthesized count CHECK and **ABORTs at commit** — the declared
`on conflict replace` (which the physical path *would* honor) is silently ignored,
and the up-front rejection never fires because there is no statement-level OR clause
or upsert.

This is sound (no duplicate is ever admitted) but it is the precise
"silently ABORTing at commit instead of replacing/skipping" outcome the rejection
was added to prevent.

## Expected behavior

A commit-time set-level key that declares a REPLACE/IGNORE conflict action it
cannot honor should fail loudly with the same clear diagnostic, not silently
over-abort. The fix needs a design decision on **where** to surface it:

- **Deploy-time (prover) — preferred.** Extend `classifyKeyConstraint` /
  the `lens.no-backing-index` advisory so that a `commit-time` set-level key whose
  constraint carries `defaultConflict ∈ {REPLACE, IGNORE}` raises an **error** (or a
  louder advisory) at `apply schema`: "declares `on conflict replace`/`ignore` but
  has no basis covering structure, so the action cannot be honored — add a covering
  MV (row-time) or drop the conflict action." This catches it once, at the schema
  boundary, rather than per-write.
- **Write-time (wiring).** Have `rejectLensSetLevelConflictResolution` also consult
  each commit-time set-level constraint's `defaultConflict`. Note this would reject
  **every** insert into such a table (the default applies to all inserts), which is
  arguably correct but is effectively a read-only/append-rejected verdict — better
  expressed at deploy.

Prefer the deploy-time route (consistent with how the prover already blocks/advises
unsound schemas); the write-time rejection is a fallback if a constraint-level
default can be introduced after deploy.

## Secondary (lower reachability) — partial-predicate UNIQUE

The synthesized count CHECK (`synthesizeUniqueCountExpr`) counts **all** logical
rows matching the key; it does not replicate a partial-UNIQUE
(`UniqueConstraintSchema.predicate`) scope. A partial commit-time unique would
**over-count** and falsely ABORT a valid (out-of-predicate-scope) duplicate. This
is currently **not reachable** — a logical-schema UNIQUE cannot carry a `predicate`
(that field is only synthesized from `CREATE UNIQUE INDEX … WHERE`, which the
logical-schema declaration path does not use). If partial logical uniques ever
become expressible, scope the count by the predicate (or route through the
row-time covering structure, which already handles partial scope in
`checkUniqueByScanning`). Fold a guard/test in here so the gap is closed before it
is reachable.

## Notes

- The row-time sibling (`lens-set-level-rowtime-enforcement`) unlocks conflict
  resolution **through the covering structure** and threads the statement-level
  action; it does **not** address the commit-time constraint-level `defaultConflict`
  gap. This ticket is specific to the commit-time (no-covering-structure) class.
- Documented as a known gap in `docs/lens.md` § Constraint Attachment (set-level
  bullet) during the review of the prereq ticket.
