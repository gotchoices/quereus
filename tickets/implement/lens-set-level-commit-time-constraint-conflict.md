description: A commit-time lens set-level key (`enforced-set-level{mode:'commit-time'}`, no basis covering structure) whose UNIQUE/PK carries a **constraint-level** `on conflict replace`/`ignore` (`UniqueConstraintSchema.defaultConflict`, `TableSchema.primaryKeyDefaultConflict`, or a PK column's `ColumnSchema.defaultConflict`) silently ABORTs a plain duplicate insert at commit instead of honoring the declared action. The write-time gate (`rejectLensSetLevelConflictResolution`) inspects only the *statement-level* `req.stmt.onConflict`/`upsertClauses`, so the constraint-level channel is never caught. Fix: raise a **deploy-time error** (`lens.unenforceable-conflict-action`) in the prover so the unsound schema is rejected at `apply schema`, not silently over-aborted per-write.
prereq: lens-set-level-commit-time-enforcement
files: packages/quereus/src/schema/lens-prover.ts, packages/quereus/src/planner/mutation/lens-enforcement.ts, packages/quereus/src/schema/table.ts, packages/quereus/src/schema/column.ts, packages/quereus/src/common/constants.ts, packages/quereus/test/lens-prover.spec.ts, packages/quereus/test/lens-enforcement.spec.ts, docs/lens.md
----

## Reproduction (confirmed)

A throwaway spec confirmed the bug on the current branch:

```sql
declare schema y { table u (id integer primary key, email text null) }
apply schema y
declare logical schema x { table u (id integer primary key, email text null, unique (email) on conflict replace) }
apply schema x

insert into x.u (id, email) values (1, 'a@x')
insert into x.u (id, email) values (2, 'a@x')   -- plain insert of a duplicate email
```

Observed: the second (plain) insert throws `CHECK constraint failed: lens:unique` and `x.u` is left as `[{id:1, email:'a@x'}]`. Expected under the declared `on conflict replace`: row 1 replaced, leaving `[{id:2, email:'a@x'}]`. The declared conflict action is silently not honored — sound (no duplicate admitted) but violates declared semantics, the exact failure `rejectLensSetLevelConflictResolution` exists to prevent.

The repro fires because:
- The basis has **no covering structure** for `email`, so the prover classifies the logical `unique(email)` as `enforced-set-level{mode:'commit-time'}` and `collectLensSetLevelConstraints` synthesizes the deferred `(select count(*) … ) <= 1` count CHECK (`packages/quereus/src/planner/mutation/lens-enforcement.ts`).
- The count CHECK can only ABORT. `rejectLensSetLevelConflictResolution` (`packages/quereus/src/planner/building/view-mutation-builder.ts`) only rejects *statement-level* `req.stmt.onConflict ∈ {REPLACE,IGNORE}` / `req.stmt.upsertClauses`. A **plain** insert carries none, so the gate declines and the count CHECK ABORTs — even though the constraint's own `defaultConflict = REPLACE` says replace.

## Root cause

Quereus resolves a conflict action three-tier: statement-level OR > constraint-level `defaultConflict` > ABORT. The lens commit-time path honors only the statement tier. The constraint tier is populated for a logical declaration:
- table/column UNIQUE → `UniqueConstraintSchema.defaultConflict` (`schema/manager.ts` `extractUniqueConstraints`, ~lines 1001/1022),
- table-level PK → `TableSchema.primaryKeyDefaultConflict` (`findPKDefinition` in `schema/table.ts`),
- column-level PK → `ColumnSchema.defaultConflict` (`columnDefToSchema` in `schema/table.ts`).

These survive into the lens slot via `buildLogicalConstraints` (`schema/lens.ts`) as `LogicalConstraint`. Note `LogicalConstraint` for a PK carries only `{ kind:'primaryKey'; columns }` — the PK's effective conflict action must be read off `ctx.table` (the logical `TableSchema`), **not** the `LogicalConstraint` node.

## Fix — deploy-time error (preferred route)

Raise a blocking prover error so a commit-time set-level key that declares a conflict action it can never honor is rejected once, at the schema boundary, rather than over-aborting per write. This is consistent with how the prover already blocks unsound schemas (`lens.unrealizable-constraint` etc.) and makes the existing write-time gate's constraint-level hole unreachable (a commit-time key with a REPLACE/IGNORE default can no longer deploy).

Only `REPLACE` and `IGNORE` are unhonorable. `ABORT`/`FAIL`/`ROLLBACK` (and no declared action) are fine — they ABORT, consistent with detection-only — and must NOT error.

### Where

`classifyKeyConstraint` in `packages/quereus/src/schema/lens-prover.ts` (~line 549). The function already reaches the commit-time branch (no covering structure, `!readOnly`) where it emits the `lens.no-backing-index` warning (~line 595). Add the error in that same `!readOnly` block, just before/after the warning. Gating on `!readOnly` matches the warning: a read-only logical table never writes, so its conflict action is moot — no spurious error.

### Effective-default resolution

Add a small helper that returns the key's effective constraint-level default conflict:
- `unique` → `constraint.constraint.defaultConflict`
- `primaryKey` → `ctx.table.primaryKeyDefaultConflict ?? (first PK column's `ctx.table.columns[pk.index].defaultConflict`)` (mirrors the precedence documented on `TableSchema.primaryKeyDefaultConflict`)

If the result is `ConflictResolution.REPLACE` or `ConflictResolution.IGNORE`, push:

```ts
errors.push({
  code: 'lens.unenforceable-conflict-action',
  severity: 'error',
  site: { table: ctx.table.name, constraint: label },
  message: `lens: ${label} on '${ctx.table.name}' (${columnNames.map(c => `'${c}'`).join(', ')}) declares 'on conflict replace/ignore' but has no basis covering structure, so the action cannot be honored (a commit-time scan can only ABORT). Add a basis covering materialized view (order by the key columns) to upgrade to row-time enforcement, or drop the conflict action.`,
});
```

(The thrown message embeds the code via `formatProveErrors` → `[lens.unenforceable-conflict-action]`, so tests can match on the code.)

### Type wiring

- Add `'lens.unenforceable-conflict-action'` to the `LensErrorCode` union (`lens-prover.ts` ~line 64). It is an **error** code, NOT an advisory — do **not** add it to `ADVISORY_CODE_LIST` (error codes are deliberately excluded from ack/escalation governance).
- Import `ConflictResolution` (a runtime enum, value import) from `../common/constants.js` into `lens-prover.ts`.

### Why not the write-time route

The ticket lists a write-time fallback (have `rejectLensSetLevelConflictResolution` also consult each commit-time constraint's `defaultConflict`). It is **redundant** once the deploy-time error lands: a constraint-level default is fixed at logical-declaration / `apply schema` time (re-declaring re-runs the prover), so no deployed commit-time key can carry a REPLACE/IGNORE default past the new error. Keep the fix DRY — deploy-time only. (If a future feature can introduce a constraint-level default *after* deploy without re-proving, revisit then.)

## Secondary — partial-predicate UNIQUE guard (close-before-reachable)

`synthesizeUniqueCountExpr` counts **all** logical rows matching the key; it does not scope by a partial-UNIQUE predicate (`UniqueConstraintSchema.predicate`). A partial commit-time unique would over-count and falsely ABORT an out-of-scope duplicate. This is **not currently reachable**: `predicate` is only synthesized from `CREATE UNIQUE INDEX … WHERE`, which the logical-schema declaration path does not use. Add a defensive guard so the gap is closed before it can open:
- In `collectLensSetLevelConstraints` (or `classifyKeyConstraint`), if a commit-time set-level `unique` obligation's `constraint.predicate` is set, raise a clear "partial logical UNIQUE not supported for commit-time enforcement" error rather than synthesizing an unscoped count.
- Add a test asserting a logical `unique` declaration yields `predicate === undefined` on the slot's attached constraint (locks the current invariant).

## Docs

Update `docs/lens.md` § Constraint Attachment — the set-level bullet (~line 157) currently documents this as a *Known gap* (`lens-set-level-commit-time-constraint-conflict`). Replace that parenthetical with a "resolved" note: a constraint-level `on conflict replace`/`ignore` on a commit-time set-level key is now a deploy-time error (`lens.unenforceable-conflict-action`) — add a covering MV or drop the action.

## Verification

- Re-run the reproduction shape: `apply schema x` now **throws** `/lens\.unenforceable-conflict-action/` (the unsound schema never deploys).
- `yarn test` (from `packages/quereus`, via the runner) stays green.
- `yarn lint` clean (single-quote globs on Windows).

## TODO

- [ ] Add `'lens.unenforceable-conflict-action'` to `LensErrorCode` in `lens-prover.ts`; import `ConflictResolution` from `common/constants.js`.
- [ ] Add the effective-default helper (unique → `defaultConflict`; PK → `primaryKeyDefaultConflict` ?? first PK column's `defaultConflict`).
- [ ] In `classifyKeyConstraint`'s commit-time `!readOnly` block, push the `lens.unenforceable-conflict-action` error when the effective default is `REPLACE`/`IGNORE`. Leave `ABORT`/`FAIL`/`ROLLBACK`/none untouched.
- [ ] Add the partial-predicate defensive guard (commit-time set-level `unique` with `predicate` set ⇒ error) in `collectLensSetLevelConstraints` / `synthesizeUniqueCountExpr` path.
- [ ] `lens-prover.spec.ts`: deploy-time error tests — constraint-level `unique(email) on conflict replace` and `… on conflict ignore` over a no-covering-structure basis throw `/lens\.unenforceable-conflict-action/`; the PK channels (table-level `primary key (...) on conflict replace` and column-level `<col> primary key on conflict replace`, both forced commit-time by declaring the key on a non-basis-key, body-unproven column) throw too.
- [ ] `lens-prover.spec.ts`: negative tests — `on conflict abort` (and no action) on a commit-time key deploys clean; `on conflict replace` on a **row-time** key (covering MV present) deploys clean (row-time honors it).
- [ ] `lens-enforcement.spec.ts` (or prover spec): assert a logical `unique` declaration yields `predicate === undefined` on the slot constraint (locks the partial-UNIQUE invariant).
- [ ] Update `docs/lens.md` § Constraint Attachment set-level bullet (~line 157): flip the Known-gap note to resolved.
- [ ] Run `yarn test` + `yarn lint`; confirm green.
