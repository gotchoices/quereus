description: Validate declared CHECK and child-side FK constraints against rows the derivation writes (create-fill, attach-reconcile, steady-state row-time maintenance) on a `create table … maintained as` table, failing the writing statement with a table-attributed diagnostic. Implements Option 2 of the triage for CHECK + FK; secondary UNIQUE is the chained follow-on.
prereq:
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts        # attachMaintainedDerivation (create-fill / reconcile), createMaintainedTable, materializeView/rebuildBacking
  - packages/quereus/src/core/database-materialized-views.ts              # maintainRowTime, applyMaintenancePlan, flushDeferredRebuilds, registerMaterializedView, applyFullRebuild
  - packages/quereus/src/schema/constraint-builder.ts                     # validateForeignKeyOverExistingRows (reuse) + add validateChecksOverExistingRows
  - packages/quereus/src/planner/building/constraint-builder.ts           # buildConstraintChecks (CHECK compile, subquery auto-defer)
  - packages/quereus/src/planner/building/foreign-key-builder.ts          # buildChildSideFKChecks (FK EXISTS synthesis, MATCH SIMPLE)
  - packages/quereus/src/runtime/emit/constraint-check.ts                 # checkCheckConstraints reference (eval shape, deferred queue dispatch)
  - packages/quereus/src/runtime/deferred-constraint-queue.ts             # _queueDeferredConstraintRow / commit-time eval (subquery CHECK/FK deferral)
  - packages/quereus/src/vtab/memory/layer/manager.ts                     # applyMaintenanceToLayer (the bypass site — recordUpsert with no constraint check)
  - packages/quereus/src/vtab/backing-host.ts                             # BackingHost contract docstring (update "re-validates nothing" wording)
  - packages/quereus/test/logic/51.7-maintained-table-attach-detach.sqllogic   # attach/detach logic tests (sibling for new validation tests)
  - packages/quereus/test/maintained-table-attach-detach.spec.ts          # attach/detach spec (sibling)
  - docs/materialized-views.md                                            # § derived-row constraint validation (new)
difficulty: hard
----

# Declared CHECK / FK validation on maintained-table derivation writes

A `create table … maintained as <body>` table registers through the ordinary
`createTable` path, so its declared CHECK / FK / UNIQUE constraints are carried
on the backing `TableSchema` — but every derivation-driven write bypasses them.
The fill, the attach reconcile, and steady-state row-time maintenance all write
through the privileged backing surface (`BackingHost.applyMaintenance` /
`replaceContents`), and the memory host's `applyMaintenanceToLayer`
(`vtab/memory/layer/manager.ts`) records upserts/deletes directly via
`recordUpsert` / `recordDelete` with **no** `checkUniqueConstraints`, no CHECK,
no FK evaluation. So a declared constraint on a maintained table is decoration.

Per the triage (Option 2 — validate derived rows), declared constraints are
real claims over the derivation: the writing statement must fail when a row the
derivation writes violates a declared CHECK or child-side FK. Because the
writing statement targets a **different** table (a source write, or the
create/attach statement), the diagnostic must name the maintained table and the
constraint — attribution is load-bearing.

This ticket covers **CHECK** and **child-side FK existence** (the maintained
table referencing parents). Secondary UNIQUE is the prereq-chained follow-on
(`maintained-table-derivation-secondary-unique`); parent-side FK orphaning by a
maintenance delete/update is parked in backlog
(`maintained-table-parent-side-fk-orphan`).

## Scope: which tables, which constraints

Only the `create table … maintained as` (and `alter table … set maintained as`)
form ever declares constraints on a derivation-bearing table. The
`create materialized view` sugar builds its backing via
`buildBackingTableSchema`, which hard-codes `checkConstraints: []` and carries no
`foreignKeys` — so MV-sugar backings declare nothing and must stay **zero
overhead**. The validator is therefore gated on "the live backing schema
declares ≥1 CHECK or ≥1 FK"; the common case (no declared constraints, every
MV-sugar table) builds and runs nothing.

CHECK op-mask collapse: a derived row image is neither a user INSERT nor UPDATE
— whether maintenance realizes a change as an `insert` or `update`
`BackingRowChange` is an artifact of backing-key movement. A declared constraint
on a maintained table is a claim over the row's *presence in the derivation*, so
every written row image is validated against **every** CHECK whose `operations`
mask intersects `INSERT | UPDATE`. A `delete` delta writes no row image and is
not CHECK-validated. Document this collapse — it is a deliberate divergence from
the user-DML `on insert` / `on update` distinction.

FK pragma gate: child-side FK existence is evaluated **only when**
`db.options.getBooleanOption('foreign_keys')` is true, re-checked at evaluation
time (not cached at registration) — the pragma can flip between create and a
later source write. MATCH SIMPLE: a row with any NULL FK column is admitted
regardless of parent (mirror `buildChildSideFKChecks` / the null-guard chain).

## Design: two mechanisms, one semantic

The bulk-population paths and the steady-state path (re)write the backing at
fundamentally different granularities, so they validate differently — exactly
the bulk-vs-incremental split the MV subsystem already embodies (full-rebuild
floor vs bounded-delta arms).

### Bulk paths → whole-table SQL-scan validators (reuse the ALTER mechanism)

Create-fill and attach/re-attach reconcile land the *entire* derived row set
into the connection's pending transaction layer via one `'replace-all'`
`applyMaintenance` op inside `attachMaintainedDerivation`
(`materialized-view-helpers.ts`). After that op returns, run a whole-table
validation scan over the table's **effective** (pending-over-committed)
contents:

  - **FK**: reuse `validateForeignKeyOverExistingRows`
    (`schema/constraint-builder.ts`) verbatim per declared FK — it is already
    pragma-gated, MATCH-SIMPLE-correct, and decorrelates to an anti-join.
  - **CHECK**: add a sibling `validateChecksOverExistingRows(db, tableSchema,
    checks)` next to it, scanning `select 1 from <t> where not (<check_expr>)
    limit 1` per declared CHECK (mirror the ADD-COLUMN backfill scan
    `validateBackfillAgainstChecks` in `runtime/emit/alter-table.ts`, but
    table-wide and reusable). A subquery-bearing CHECK is just SQL here — no
    special deferral needed; the scan reads final pending state.

This validates **all** rows the table will hold post-reconcile (which, after
derived-wins reconcile, is exactly the derived set), so the
"attach-reconcile validates pre-existing rows → detach can never strand
violators" guarantee falls out for free: the table never commits a row that
fails a declared constraint, so `drop maintained` leaves an ordinary table whose
every row already satisfies its (now user-enforced) constraints. No special
detach handling is required.

Reads-own-writes: the scan must observe the pending reconcile writes. The attach
core already registers the backing connection (`resolveAttachConnection`) so "a
`select` from the table inside the same transaction observes them." Confirm the
validation `db.prepare(...).scan` reads the maintained table's backing contents
(it is a plain table read — not the read-side MV rewrite), and that no
rewrite-suppression context interferes. **Verify this explicitly** — if a
`select from mt` mid-attach re-derives instead of reading the backing, the scan
would validate the wrong thing.

`materializeView` / `rebuildBacking` use `replaceContents` (the MV-sugar
create/refresh primitive) and operate only on MV-sugar backings (empty
constraints), so they need no validation hook today. Add a defensive assertion
or comment that `replaceContents` callers carry no declared constraints, so a
future maintained-table path that adopts `replaceContents` is forced to revisit.

### Steady-state path → per-row maintenance evaluator (validate the delta only)

Scanning the whole table per source row is pathological, and unnecessary: every
row already in the backing was validated when it entered (inductive invariant
seeded by the bulk validation above). So steady-state validates only the rows a
maintenance delta *writes*. Each maintenance apply returns
`BackingRowChange[]`; for each change with `op ∈ {insert, update}`, validate its
`newRow`.

Build a per-maintained-table **derived-row constraint evaluator** once, in
`registerMaterializedView` (`database-materialized-views.ts`), only when the
backing declares ≥1 CHECK or ≥1 FK (else leave it `undefined` — the zero-overhead
gate). The evaluator holds:
  - compiled CHECK predicates over a single-row INSERT-shaped descriptor (OLD
    section = NULLs, NEW section = the row image) — reuse `buildConstraintChecks`
    with `operation = INSERT` and an OLD/NEW attribute pair, exactly as the DML
    pipeline builds them;
  - compiled child-side FK EXISTS checks — reuse `buildChildSideFKChecks`.

Validating a row image:
  - a **non-subquery** CHECK / FK evaluates inline against the row (the
    `checkCheckConstraints` truthy/NULL-pass rule: fail on `false`/`0`), throwing
    the attributed CONSTRAINT error immediately;
  - a **subquery-bearing** CHECK / FK (`needsDeferred` — the same auto-defer
    heuristic the DML path uses) routes to the existing deferred-constraint queue
    via `db._queueDeferredConstraintRow(...)`, so it validates at commit against
    final state, matching ordinary-table deferral semantics. The queued
    evaluator must carry the same attribution (see below).

Wire the per-row validation at the two steady-state apply sites in
`database-materialized-views.ts`:
  - `maintainRowTime` — after `applyMaintenancePlan` returns `backingChanges`,
    validate them against `plan.mv`'s evaluator **before** cascading to consumer
    MVs. (The bounded-delta arms: inverse-projection, residual-recompute,
    prefix-delete, join-residual.)
  - `flushDeferredRebuilds` — after `applyFullRebuild` returns its `'replace-all'`
    diff, validate the diff's insert/update images against `plan.mv`'s evaluator.

The MV-over-MV cascade validates each level naturally: the cascade re-enters
`maintainRowTime` per backing change, so each consumer MV's own evaluator runs on
its own deltas.

## Attribution diagnostic

A single shared helper produces the message for both mechanisms. It must name
the maintained table, the constraint, and make clear the row is derived (the
triggering statement targeted a different table). Shape:

```
CHECK constraint failed: <constraint-name> (<expr-hint>) — row derived into
maintained table 'main.mt' violates its declared constraint
```

```
FOREIGN KEY constraint failed: <constraint-name> — row derived into maintained
table 'main.mt' references a missing 'main.parent'
```

Keep the leading `CHECK constraint failed:` / `FOREIGN KEY constraint failed:`
prefixes (existing assertions and downstream consumers key off them — see
`constraint-check.ts`). Use `StatusCode.CONSTRAINT`.

## Edge cases & interactions

- **Zero-overhead common case**: an MV-sugar table and a maintained table that
  declares no CHECK/FK must build no evaluator and run no scan. Assert via a test
  that a no-constraint maintained table's per-row maintenance path is unchanged
  (no extra prepares).
- **Subquery CHECK / FK on a maintained table**: must defer to commit (steady
  state) and validate via the table scan (bulk). A deferred violation must still
  carry the maintained-table attribution at commit time, not the generic
  `deferred-constraint-queue.ts` message — thread the attributed name through
  the queued entry's `constraintName` or wrap the evaluator.
- **CHECK op-mask**: `check on insert (...)` and `check on update (...)` both
  apply to a derived row image (mask collapse). Add a test for each.
- **FK pragma off → on between writes**: a maintained table created with
  `foreign_keys` off (FK not validated) then a later source write with the pragma
  on must validate the new delta (re-check at eval time). Pre-existing rows are
  NOT retro-validated (matches ordinary tables — no retro-FK-check on pragma
  flip); document this.
- **MATCH SIMPLE NULL FK column**: a derived row with a NULL FK column is
  admitted regardless of parent presence.
- **Attach over a table with pre-existing (non-derived) rows that violate**: the
  reconcile is derived-wins (replace-all deletes non-derived rows), so the
  post-reconcile contents are exactly the derived set; the scan validates that
  set. A derived row that violates fails the attach (rolled back via
  `restorePrior`); a pre-existing violator that the derivation does not reproduce
  is simply deleted by reconcile and never validated (correct — it is gone).
- **Re-attach (`set maintained as` over an already-maintained table)**: same
  reconcile path; new body's derived rows validated; failure restores the prior
  derivation + plan (the existing `restorePrior` covers rollback — ensure the
  validation throw is inside the try that calls it).
- **Create-fill failure rollback**: `createMaintainedTable` drops the
  just-created table on any throw past registration; a validation failure must
  surface there and drop cleanly (no half-built maintained table).
- **MV-over-MV cascade**: a write to a base source that cascades into a consumer
  maintained table with its own declared CHECK/FK must validate the consumer's
  deltas with the consumer's evaluator. Add a two-level test (base → mt1 → mt2,
  mt2 declaring a CHECK that the cascaded row violates).
- **Full-rebuild floor**: a body maintained by the full-rebuild arm validates its
  rebuild diff at flush, not per source row (deferred-rebuild semantics
  preserved). A bulk source write that dirties a full-rebuild maintained table
  with a CHECK must fail at the end-of-statement flush.
- **REPLACE / conflict clauses**: derivation writes have no user `OR REPLACE`
  clause; a CHECK/FK violation is always a hard abort (no IGNORE/REPLACE masking
  — matches the DML rule that REPLACE never masks CHECK/FK).
- **Determinism**: declared CHECK/FK expressions are already determinism-gated at
  build (`validateDeterministicConstraint`); the derived-row evaluator reuses the
  same compiled expressions, so no new determinism surface.
- **`pragma nondeterministic_schema`**: respected transitively via the reused
  compile path.
- **Store module path** (`yarn test:store`): the maintained-table CHECK/FK
  validation must hold against the LevelDB store backing too (the store module
  also implements `applyMaintenance`). The bulk SQL-scan validators are
  backend-agnostic (engine-side `db.prepare`); confirm the per-row evaluator path
  is equally backend-neutral. Run `yarn test:store` for the new logic file if
  time permits, else document the deferral.

## Key tests & expected outputs

- The ticket's reproduction must now fail at the right point:
  ```sql
  create table src (id integer primary key, v text not null);
  insert into src values (1, 'bad');
  create table mt (id integer primary key, v text not null check (v <> 'bad'))
    maintained as select id, v from src;
  -- EXPECT: CONSTRAINT error attributed to mt's CHECK (create-fill validates)
  ```
  and steady-state:
  ```sql
  -- (with a non-violating create, then:)
  insert into src values (2, 'bad');
  -- EXPECT: CONSTRAINT error attributed to mt's CHECK (maintenance validates)
  ```
- Child-side FK on a maintained table, pragma on: a derived row referencing a
  missing parent fails create-fill and steady-state; with the pragma off it is
  admitted.
- Subquery CHECK on a maintained table defers and fails at commit with
  maintained-table attribution.
- Zero-overhead: a no-constraint maintained table and an MV-sugar table behave
  exactly as today (regression: existing 51.x / 53.x logic suites stay green).
- Detach: after a validated maintained table is `drop maintained`, every row
  satisfies the now-user-enforced constraints (no stranded violator) — a probe
  that a post-detach `update` honoring the constraint succeeds and a violating
  one fails.

Add a new logic file (e.g. `test/logic/51.8-maintained-table-declared-constraints.sqllogic`)
for the SQL-level behaviors and extend `maintained-table-attach-detach.spec.ts`
(or a new spec) for the cascade / deferred / zero-overhead assertions.

## TODO

Phase 1 — validator infrastructure + bulk paths
- Add `validateChecksOverExistingRows(db, tableSchema, checks)` to
  `schema/constraint-builder.ts` (sibling of `validateForeignKeyOverExistingRows`).
- Add a shared attribution-diagnostic helper (maintained-table CHECK / FK
  messages, CONSTRAINT status).
- Hook bulk validation into `attachMaintainedDerivation` after the reconcile
  `applyMaintenance`, inside the try that calls `restorePrior`; gate on
  "backing declares ≥1 CHECK or ≥1 FK".
- Verify the validation scan reads pending backing contents (reads-own-writes),
  not a re-derivation.
- Add the defensive comment/assert on the `replaceContents` callers.
- Tests: create-fill validation (CHECK + FK), attach/re-attach, detach-no-strand,
  rollback-on-failure.

Phase 2 — steady-state per-row evaluator
- Build the per-maintained-table derived-row evaluator in
  `registerMaterializedView` (compiled CHECK via `buildConstraintChecks`,
  INSERT-shaped descriptor; child-side FK via `buildChildSideFKChecks`); store on
  the plan/registry; `undefined` when no declared CHECK/FK.
- Validate insert/update `BackingRowChange` images in `maintainRowTime` (before
  cascade) and in `flushDeferredRebuilds` (after `applyFullRebuild`).
- Route subquery-bearing CHECK/FK to `_queueDeferredConstraintRow` with
  maintained-table attribution; inline-evaluate the rest.
- Tests: steady-state insert/update/cascade/full-rebuild/deferred/pragma-flip,
  zero-overhead regression.

Phase 3 — docs + validation
- Document the derived-row constraint validation (the two mechanisms, the CHECK
  op-mask collapse, the FK pragma gate, the detach guarantee) in
  `docs/materialized-views.md`; update the `BackingHost` "re-validates nothing"
  wording in `vtab/backing-host.ts` to "re-validates nothing structural; the
  engine validates declared CHECK/FK over derived rows at the maintenance
  boundary".
- `yarn build`, `yarn test` (stream with `tee`); `yarn lint` (single-quoted
  globs on Windows). Run `yarn test:store` for the new logic file or document the
  deferral.
