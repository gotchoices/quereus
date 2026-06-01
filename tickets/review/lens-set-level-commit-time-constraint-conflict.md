description: Review the deploy-time rejection of a commit-time lens set-level key whose UNIQUE/PK declares a constraint-level `on conflict replace`/`ignore` it can never honor. New blocking prover error `lens.unenforceable-conflict-action` (raised in `classifyKeyConstraint`) plus a defensive partial-UNIQUE guard. Replaces the prior silent over-ABORT-at-commit behavior.
files: packages/quereus/src/schema/lens-prover.ts, packages/quereus/src/planner/mutation/lens-enforcement.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/schema/table.ts, packages/quereus/src/schema/manager.ts, packages/quereus/src/common/constants.ts, packages/quereus/test/lens-prover.spec.ts, docs/lens.md
----

## What changed (implement summary)

The bug: a commit-time lens set-level key (a logical `unique`/PK with **no basis covering structure**) whose UNIQUE/PK carried a **constraint-level** `on conflict replace`/`ignore` silently ABORTed a plain duplicate insert at commit instead of honoring the declared action. The write-time gate `rejectLensSetLevelConflictResolution` (`view-mutation-builder.ts`) only inspects *statement-level* `req.stmt.onConflict`/upserts, so the constraint-level channel was never caught — sound (no duplicate admitted) but the declared semantics were silently dropped.

The fix is **deploy-time only** (preferred route in the source ticket — the write-time fallback was deliberately NOT added, kept DRY): the prover now rejects the unsound schema at `apply schema`, so no commit-time key carrying a REPLACE/IGNORE default can deploy.

Concretely, in `packages/quereus/src/schema/lens-prover.ts`:

- **`LensErrorCode`** gains `'lens.unenforceable-conflict-action'` (an *error* code — intentionally NOT added to `ADVISORY_CODE_LIST`; the drift guard in `lens-ack.spec.ts` still asserts exactly the four advisory codes and passes). Value-imported `ConflictResolution` from `../common/constants.js`.
- **`effectiveKeyDefaultConflict(ctx, constraint)`** helper resolves the effective constraint-level default:
  - `unique` → `constraint.constraint.defaultConflict`
  - `primaryKey` → `ctx.table.primaryKeyDefaultConflict ?? first-PK-column's `ctx.table.columns[idx].defaultConflict`` (PK action is NOT on the `LogicalConstraint` node — must be read off `ctx.table`).
- In **`classifyKeyConstraint`'s commit-time `!readOnly` block** (same block that emits the `lens.no-backing-index` warning): if the effective default is `REPLACE`/`IGNORE`, push the blocking `lens.unenforceable-conflict-action` error. `ABORT`/`FAIL`/`ROLLBACK`/none are left untouched. Gated on `!readOnly` (a read-only table never writes — moot).
- **Defensive partial-UNIQUE guard** (close-before-reachable) in the same block: a commit-time `unique` whose `constraint.predicate` is set → `lens.unrealizable-constraint` error (the O(n) count scan in `synthesizeUniqueCountExpr` cannot scope by a partial predicate). **Not reachable today** — `predicate` is only synthesized from `CREATE UNIQUE INDEX … WHERE`, which the logical-declaration path never uses; an invariant lock, not a live path.

`docs/lens.md` § Constraint Attachment: the prior "Known gap" parenthetical is flipped to "resolved" with the new error code documented.

The error code is surfaced via `formatProveErrors` (`lens-compiler.ts`) as `[lens.unenforceable-conflict-action] <message>`, so tests match on the code.

## How to exercise / validate

The original reproduction now **throws at `apply schema x`** (never deploys), instead of silently over-ABORTing per write:

```sql
declare schema y { table u (id integer primary key, email text null) }
apply schema y
declare logical schema x { table u (id integer primary key, email text null, unique (email) on conflict replace) }
apply schema x          -- throws /lens.unenforceable-conflict-action/
```

Eight new tests in `packages/quereus/test/lens-prover.spec.ts` (describe `lens prover: unenforceable conflict action (commit-time set-level)`):

- **Throws** (deploy blocked): commit-time `unique(email) on conflict replace`; `… on conflict ignore`; **table-level** `primary key (code) on conflict replace`; **column-level** `code text primary key on conflict replace` (PK channels forced commit-time by re-keying on a reconstructible, body-unproven, non-basis-key column).
- **Deploys clean** (negative): `on conflict abort` on a commit-time key (still classifies commit-time); no declared action; `on conflict replace` on a **row-time** key (covering MV present → classifies row-time, returns before the error block).
- **Invariant lock**: a logical `unique` declaration yields `predicate === undefined` on the slot's attached constraint.

Validation run (all green):
- `yarn typecheck` — clean
- `yarn lint` — clean (single-quoted globs)
- `yarn test` (memory-backed runner, from `packages/quereus`) — **4234 passing, 9 pending**; the two targeted specs (`lens-prover.spec.ts` + `lens-enforcement.spec.ts`) = 70 passing including the 8 new.
- `yarn test:store` (LevelDB path) was **not** run — this change is pure deploy-time schema validation (no storage/runtime code path), so the store module is not exercised; left to CI/human if a store-specific check is wanted.

## Reviewer focus / known gaps (treat tests as a floor)

1. **Row-time + logical constraint-level conflict action is untested and possibly a parallel gap.** The fix scopes strictly to commit-time. For a **row-time** key we deploy clean on the theory that "row-time can honor REPLACE/IGNORE." But row-time enforcement re-plans the lens write against the **basis** table, where conflict resolution is `statement-level OR > basis-UC defaultConflict > ABORT` — the *logical* constraint's `defaultConflict` is not consulted. So a logical `unique(email) on conflict replace` backed by a *plain* basis `unique(email)` (no action) would resolve to **ABORT**, not replace, at write time. This is the same class of "declared action silently not honored," but for row-time, and is **out of scope** for this ticket (which the source ticket scoped to commit-time). Not verified end-to-end. Worth a judgement call: file a follow-up, or confirm it's acceptable because row-time is at least *capable* (matching-basis declarations honor it — see existing `lens-enforcement.spec.ts` row-time `or replace` tests, which use statement-level OR).

2. **PK effective-conflict reads only the *first* PK column's `defaultConflict`.** The documented precedence on `TableSchema.primaryKeyDefaultConflict` says "column-level `defaultConflict` on **any** PK column." The reasoning that first-column suffices: a multi-column PK can only be declared **table-level** (`primary key (a, b)` → lands on `primaryKeyDefaultConflict`, checked first); column-level `<col> primary key` on more than one column is a "multiple primary keys" error. So column-level conflict on a *non-first* PK column is unreachable. Please sanity-check that argument against the parser/`findPKDefinition` (`schema/table.ts`).

3. **Deploy-time-only soundness rests on "constraint-level default is fixed at declaration time."** The write-time fallback was omitted as redundant: re-declaring a logical schema re-runs the prover (`apply schema` → `proveLens`), so no deployed commit-time key can acquire a REPLACE/IGNORE default past the new error. Confirm there is no path that mutates a deployed slot's constraint-level `defaultConflict` *without* re-proving (e.g. an ALTER-like path on a logical table). If one exists, the write-time gate hole reopens.

4. **Partial-UNIQUE guard is dead code today** (asserted unreachable). The invariant-lock test guards the assumption; if a future feature lets a logical declaration set `UniqueConstraintSchema.predicate`, the guard becomes live (and `synthesizeUniqueCountExpr` would need real partial-predicate scoping rather than an outright reject).

5. **No new write-time test** was added (the fix moved the failure earlier to deploy time). The existing `lens-enforcement.spec.ts` commit-time suite still covers the plain-insert ABORT behavior for keys *without* a declared conflict action — confirm that coverage is still the right floor.
