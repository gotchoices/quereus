description: A row-time logical set-level key (`unique`/PK, backed by a basis UNIQUE + non-stale covering MV) that declares a constraint-level `on conflict replace`/`ignore` silently resolves a duplicate to ABORT at write time when the backing **basis** UC carries no matching action and no statement-level OR is present — the declared logical action is dropped. Close the row-time channel at deploy time, mirroring the commit-time sibling: reject at `apply schema` with `lens.unenforceable-conflict-action` when the backing basis UC cannot honor the declared action. (Reproduced end-to-end; see § Reproduction.)
files: packages/quereus/src/schema/lens-prover.ts, packages/quereus/test/lens-prover.spec.ts, packages/quereus/test/lens-enforcement.spec.ts, docs/lens.md
prereq: lens-set-level-commit-time-constraint-conflict
----

## The confirmed gap

A **row-time** logical set-level key is enforced by re-planning the lens write against the basis table (`planner/mutation/single-source.ts`), where the conflict action resolves as `statement-level OR > basis-UC defaultConflict > ABORT` (memory layer `checkSingleUniqueConstraint`, `vtab/memory/layer/manager.ts:1013` — `onConflict ?? uc.defaultConflict ?? ABORT`). The **logical** constraint's own `defaultConflict` is never consulted in that re-plan.

So a logical declaration

```sql
declare schema y { table u (id integer primary key, email text null, unique (email)) }
-- + a covering MV  → makes the unique(email) classify row-time
create materialized view y.ix_u_email as select email, id from y.u where email is not null order by email;
declare logical schema x { table u (id integer primary key, email text null, unique (email) on conflict replace) }
```

deploys clean (correct — row-time is *capable* of REPLACE), but a plain duplicate insert resolves to **ABORT**, silently dropping the declared `on conflict replace`.

### Reproduction (verified during fix)

- `apply schema x` deploys clean.
- `insert into x.u (id,email) values (1,'a@x')` then `insert into x.u (id,email) values (2,'a@x')` → **ABORTs** with `UNIQUE constraint failed: u (email)`; `select id from x.u where email='a@x'` → `[{id:1}]`. Expected under the declared REPLACE: `[{id:2}]`.
- **Remediation that already works (verified):** declare the matching action on the *basis* UC too — `table u (… unique (email) on conflict replace)` in schema `y`. Then `uc.defaultConflict = REPLACE`, the basis UC resolves REPLACE for free, and the plain duplicate insert REPLACEs (`[{id:2}]`). This is the path the implementer's diagnostic should point the user toward.
- Statement-level OR is **always** honored already (threaded via `rewriteViewInsert`'s `onConflict: stmt.onConflict`) — the existing row-time `or replace`/`or ignore` tests in `lens-enforcement.spec.ts` rely on it. The gap is strictly the *constraint-level* default with *no* statement OR and a *non-matching* basis UC.

## Why option 1 (honor it) is not cleanly feasible — and option 2 is the chosen fix

The runtime resolves the conflict action per-UC from the **live basis schema** (`uc.defaultConflict`). There is **no per-statement, per-constraint conflict-override channel** from the planner into the memory layer (nor the `quereus-isolation` / `quereus-store` parallel layers, each of which carries its own `resolvePkDefaultConflict` + `statement OR > per-constraint default > ABORT` resolver). Honoring the *logical* key's action at write time would require either:

- **Statement-level fallback** — set the basis insert's `stmt.onConflict` to the logical key's effective action when absent. **Rejected: unsound.** Statement-level OR applies to *every* constraint on the basis insert (the basis PK, any other UC), so a row whose basis **PK** (= the `proved` logical PK, default ABORT) collides would wrongly REPLACE. It over-broadens a per-key action into a per-statement one. Multiple logical keys with *different* declared actions cannot be represented this way at all.
- **A new per-constraint conflict channel** — thread per-UC overrides planner → emit → memory layer (+ isolation + store for parity), applied as `onConflict ?? perUcOverride ?? uc.defaultConflict ?? ABORT`. Correct but **invasive and cross-package** — out of proportion to the gap.

Per the source ticket ("fall back to 2 if threading proves invasive") and for consistency with the commit-time sibling `lens-set-level-commit-time-constraint-conflict` (which closed its channel at deploy), the fix is **option 2: reject at deploy**. It is sound, minimal, reuses existing machinery, and gives the user a precise remediation (declare the matching action on the basis UC, or drop the logical action). Option 1 (true per-key honoring) is documented as a deferred enhancement in § Out of scope.

## The fix — deploy-time reject in the row-time branch

All in `schema/lens-prover.ts`, `classifyKeyConstraint` (the row-time early-return at lines ~620-625). Today it returns the `row-time` obligation with no conflict check; the conflict reject only lives in the *commit-time* (`!readOnly`) branch below it (lines ~643-651, code `lens.unenforceable-conflict-action`).

Extend the row-time branch to reject when the backing basis UC cannot honor the declared logical action:

- Switch the row-time resolution from `findBasisCoveringStructure(ctx, logicalColumns)` (returns only the `CoveringStructureRef`) to `findBasisCovering(ctx, logicalColumns)` (returns `{ ref, uc }`), so the **backing basis `UniqueConstraintSchema`** is in hand. (`findBasisCoveringStructure` is just `findBasisCovering(...)?.ref` — keep it, or inline.)
- Read the logical key's effective action via the existing helper `effectiveKeyDefaultConflict(ctx, constraint)` (`unique` → its `defaultConflict`; `primaryKey` → `resolvePkDefaultConflict(ctx.table)`). **Reuse it — do not re-derive.**
- **Reject condition** (gate on `!readOnly`, matching the commit-time branch — a read-only table never writes, so the action is moot): the logical effective action is `REPLACE` or `IGNORE`, **and** it differs from the backing basis UC's own `defaultConflict` (`covering.uc.defaultConflict`). When they match, the basis UC already honors the action at write time (the verified remediation) → no reject. Push `lens.unenforceable-conflict-action` (severity `error`, same code/site shape as the commit-time block) with a message naming the key, the declared action, the backing basis UC, and the remediation: *declare the matching `on conflict <action>` on the basis UNIQUE/PK, or drop the logical conflict action.* Still return the `enforced-set-level` `row-time` obligation (errors block the deploy atomically; mirror the commit-time branch, which pushes-then-returns).

Truth table the condition must satisfy (logical action / basis UC action → verdict):
- REPLACE / none → reject (the reproduced gap)
- IGNORE  / none → reject
- REPLACE / REPLACE → no reject (basis honors it — verified)
- REPLACE / IGNORE → reject (basis would IGNORE, not REPLACE)
- IGNORE / REPLACE → reject
- ABORT/FAIL/ROLLBACK / any → no reject (logical effective ∉ {REPLACE, IGNORE}; consistent with commit-time, which only rejects REPLACE/IGNORE)

Keep this **child-side set-level keys only** (per `docs/lens.md` § Constraint Attachment); parent-side FK actions through the lens remain out of scope.

### Notes / hazards

- **PK is largely unreachable for row-time**, but handle it for totality via `effectiveKeyDefaultConflict`'s `primaryKey` arm. A logical PK is NOT NULL, so when a matching basis UNIQUE+NOT-NULL backs it the body *proves* the key (`proved`, not row-time — see the `re-keyed PK over a basis unique(code) is PROVED` test in `lens-enforcement.spec.ts`); with no basis UNIQUE it falls to commit-time. The reject still belongs in the row-time branch for soundness even if no current shape reaches it.
- **Inverse divergence (out of scope, note for the human):** the *opposite* leak — logical declares **no** action but the basis UC declares `on conflict replace`, so a lens write inherits REPLACE the logical schema never asked for — is pre-existing row-time behavior (the lens rides the basis UC's resolution) and is **not** addressed here (the reject only fires when the *logical* key declares REPLACE/IGNORE). If undesired, file a separate backlog ticket; do not widen this fix to cover it.

## TODO

- [ ] In `classifyKeyConstraint` (`schema/lens-prover.ts`), resolve the row-time covering via `findBasisCovering` to obtain the backing basis `uc`, and in the row-time branch push `lens.unenforceable-conflict-action` when `effectiveKeyDefaultConflict(ctx, constraint) ∈ {REPLACE, IGNORE}` and `!== covering.uc.defaultConflict` (gated on `!readOnly`). Still return the `row-time` obligation.
- [ ] Craft the error message to name the key columns, the declared action, the backing basis UC, and the remediation (matching basis UC action, or drop the logical action). Mirror the commit-time message's shape.
- [ ] Tests in `lens-prover.spec.ts` (classification/deploy-reject) — mirror the commit-time `… blocks the deploy` cases:
      - row-time `unique(email) on conflict replace` over a plain basis `unique(email)` + covering MV → `apply schema` throws `/lens\.unenforceable-conflict-action/`.
      - same with `on conflict ignore` → throws.
      - basis `unique(email) on conflict replace` + logical `on conflict replace` + covering MV → deploys clean (matching action; assert no `errors`).
      - `on conflict abort` (and no declared action) on a row-time key → deploys clean.
- [ ] Tests in `lens-enforcement.spec.ts` (end-to-end, in the row-time describe block) — the matching-basis-action path actually REPLACEs a duplicate (`[{id:2}]`) via a plain insert (the verified remediation); keep the existing statement-level `or replace`/`or ignore` row-time tests green.
- [ ] Update `docs/lens.md` — the row-time bullets (lines ~152, ~157) and the constraint-attachment narrative claim the row-time path "preserves the conflict action." Tighten to: the row-time path honors the **statement-level** OR and a **matching basis-UC** action; a constraint-level `on conflict replace`/`ignore` the backing basis UC does **not** carry is rejected at deploy (`lens.unenforceable-conflict-action`), symmetric with the commit-time channel. Note true per-logical-key honoring (option 1) is deferred (needs a per-constraint conflict channel).
- [ ] Run `yarn workspace @quereus/quereus test` (or `node packages/quereus/test-runner.mjs`) green, plus `yarn workspace @quereus/quereus lint` (single-quote globs on Windows).

## Out of scope

- **Option 1 (honor the logical action at write time):** requires a per-statement, per-constraint conflict-resolution channel from the planner into the memory layer and the `quereus-isolation` / `quereus-store` layers. If desired later, file a backlog ticket (e.g. `lens-set-level-per-constraint-conflict-channel`); this ticket deliberately delivers the sound deploy-time floor instead.
- The inverse divergence (basis UC action leaking into a lens write the logical schema didn't request) — see § Notes.
- Parent-side FK conflict actions through the lens.
