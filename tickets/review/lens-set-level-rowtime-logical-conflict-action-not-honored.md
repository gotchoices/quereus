description: Review the deploy-time reject that closes the row-time channel for a logical set-level key whose declared `on conflict replace`/`ignore` the backing basis UC cannot honor. The row-time write path resolves the conflict action from the *basis* UC (`statement-OR ?? basis-uc.defaultConflict ?? ABORT`), never the logical key — so a logical constraint-level action the basis UC doesn't carry was being silently dropped to ABORT at write time. Now rejected at `apply schema` with `lens.unenforceable-conflict-action`, symmetric with the commit-time sibling.
files: packages/quereus/src/schema/lens-prover.ts, packages/quereus/test/lens-prover.spec.ts, packages/quereus/test/lens-enforcement.spec.ts, docs/lens.md
----

## What landed

A row-time set-level logical key (a `unique`/PK backed by a basis `UNIQUE` + non-stale covering MV) is enforced by re-planning the lens write against the **basis** table, where the conflict action resolves as `statement-level OR > basis-UC.defaultConflict > ABORT`. The **logical** key's own `defaultConflict` is never consulted in that re-plan. So a logical declaration like

```sql
declare schema y { table u (id integer primary key, email text null, unique (email)) }
apply schema y;
create materialized view y.ix_u_email as select email, id from y.u where email is not null order by email;
declare logical schema x { table u (id integer primary key, email text null, unique (email) on conflict replace) }
apply schema x;   -- previously deployed clean
```

deployed clean but then **silently ABORTed** a plain duplicate insert, dropping the declared `on conflict replace`.

The fix (option 2 from the source ticket — sound deploy-time floor, not true per-key honoring) rejects this at deploy in the **row-time branch** of `classifyKeyConstraint`, mirroring the existing commit-time `lens.unenforceable-conflict-action` block.

### Implementation (all in `schema/lens-prover.ts`)

- The row-time branch now resolves the covering via `findBasisCovering(ctx, logicalColumns)` (returns `{ ref, uc }`) instead of the thin `findBasisCoveringStructure` wrapper, so the **backing basis `UniqueConstraintSchema`** is in hand. The now-unused `findBasisCoveringStructure` wrapper was removed (its descriptive doc folded into `findBasisCovering`).
- New helper `rejectRowTimeConflictAction(...)` pushes `lens.unenforceable-conflict-action` (severity `error`) when **all** of:
  - `!readOnly` (a read-only table never writes — action moot, matches the commit-time gate),
  - `effectiveKeyDefaultConflict(ctx, constraint)` ∈ {REPLACE, IGNORE} (reuses the existing helper; `unique` → its `defaultConflict`, `primaryKey` → `resolvePkDefaultConflict(ctx.table)`),
  - the logical effective action `!==` `covering.uc.defaultConflict` (when they **match**, the basis UC already resolves the action for free → no reject).
  - The row-time obligation is still returned (errors block the deploy atomically; the obligation is recorded as before).
- New helper `conflictActionName(action)` renders the enum for the message (absent → `abort`), matching `ast-stringify`'s `ConflictResolution[res].toLowerCase()` idiom.
- `effectiveKeyDefaultConflict`'s doc comment was tightened to note it now backs both the commit-time and row-time rejects.

Truth table the condition satisfies (logical effective action / basis-UC action → verdict):

| logical | basis UC | verdict |
|---|---|---|
| REPLACE | none (ABORT) | **reject** (the reproduced gap) |
| IGNORE | none (ABORT) | **reject** |
| REPLACE | REPLACE | no reject (basis honors it — verified end-to-end) |
| REPLACE | IGNORE | **reject** (basis would IGNORE, not REPLACE) |
| IGNORE | REPLACE | **reject** |
| ABORT/FAIL/ROLLBACK / none | any | no reject (effective ∉ {REPLACE, IGNORE}) |

## Validation done

- `yarn workspace @quereus/quereus typecheck` → clean.
- Targeted: `lens-prover.spec.ts` + `lens-enforcement.spec.ts` → **77 passing**.
- Full memory-backed suite (`node packages/quereus/test-runner.mjs`) → **4242 passing, 9 pending, 0 failing**.
- `yarn workspace @quereus/quereus lint` → clean.

### Tests added / changed

- **`lens-prover.spec.ts`** — new describe block `unenforceable conflict action (row-time set-level)`: `on conflict replace` over a non-matching (no-action) basis UC → throws; same with `on conflict ignore` → throws; **matching** `replace`/`replace` → deploys clean (row-time, no errors); **mismatched** logical `replace` / basis `ignore` → throws; `on conflict abort` → deploys clean.
- **`lens-prover.spec.ts`** — **rewrote** the pre-existing test that encoded the buggy assumption (`'on conflict replace' on a row-time key ... deploys clean — row-time can honor it`). It used a no-action basis UC + logical `on conflict replace`, which the fix now *rejects*. Retitled to `... with a MATCHING basis-UC action deploys clean` and given a matching basis `on conflict replace`. **Reviewer: confirm this rewrite reflects intended semantics, not a test bent to pass.**
- **`lens-enforcement.spec.ts`** — new end-to-end test in the row-time describe block: matching basis-UC `on conflict replace` honors REPLACE on a **plain** duplicate insert (`[{id:2}]` in both `x.u` and `y.u`, count 1) — the verified remediation.

## Use cases for the reviewer to exercise

- Re-run the reproduction from the source ticket and confirm `apply schema x` now throws `/lens\.unenforceable-conflict-action/` instead of deploying-then-silently-ABORTing.
- Confirm the remediation: add the matching `on conflict replace` to the **basis** UC (`schema y`) and verify a plain duplicate insert REPLACEs (`[{id:2}]`).
- Confirm statement-level OR is still always honored on row-time keys (the existing `or replace`/`or ignore`/upsert row-time tests stay green) — the reject targets only the *constraint-level* default with no statement OR.

## Known gaps / honest flags (treat as a floor)

- **PK row-time arm is defensive / untested-by-construction.** The reject handles `primaryKey` via `effectiveKeyDefaultConflict` for totality, but no current shape reaches a *row-time* PK: a logical PK is NOT NULL, so a matching basis `UNIQUE`+NOT-NULL **proves** it (`proved`, not row-time — see the `re-keyed PK over a basis unique(code) is PROVED` test), and with no basis UNIQUE it falls to commit-time. Only the `unique` arm is exercised end-to-end. The PK arm is correct-by-reuse but has no direct test (none can be constructed without a row-time PK shape). Reviewer may decide whether a comment-only note suffices or a (currently unconstructible) test is worth chasing.
- **Inverse divergence is deliberately NOT addressed** (per source ticket § Notes): the *opposite* leak — logical declares **no** action but the basis UC declares `on conflict replace`, so a lens write inherits REPLACE the logical schema never asked for — is pre-existing row-time behavior and out of scope. The reject fires only when the *logical* key declares REPLACE/IGNORE. If undesired, it warrants a separate backlog ticket; do **not** widen this fix.
- **Option 1 (true per-logical-key honoring) is deferred.** Honoring the logical action at write time needs a per-statement, per-constraint conflict-override channel threaded planner → memory/isolation/store. Documented as a deferred enhancement in `docs/lens.md`; file `lens-set-level-per-constraint-conflict-channel` (backlog) if pursued. This ticket delivers the sound deploy-time floor.
- **Store path not run.** Only the memory-backed `yarn test` was run, not `yarn test:store`. The change is purely deploy-time (the prover runs identically regardless of storage layer; `quereus-isolation`/`quereus-store` carry structurally identical write-path resolvers but are not touched by a deploy-time reject). Low risk, but `test:store` was not exercised — note for the reviewer if store-path confidence is needed.
- **Message shape.** The error names the key columns, the declared action, the backing covering-structure name, and both remediations. It says "backing basis UNIQUE/PK (covering structure '<mv>')" which lightly conflates the UC with its covering MV — readable, but a reviewer may want to sharpen the wording.

## Out of scope (carried from source ticket)

- Per-constraint conflict-resolution channel (option 1).
- Inverse divergence (basis UC action leaking into an unrequested lens write).
- Parent-side FK conflict actions through the lens.
