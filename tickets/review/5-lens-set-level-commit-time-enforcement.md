description: Live per-write enforcement of the lens prover's `enforced-set-level{mode:'commit-time'}` obligation (a logical `unique`/PK with no basis covering structure). Realized as a deferred `(select count(*) from <logicalView> as _u where _u.lk = NEW.bk …) <= 1` count-subquery CHECK routed through the same `extraConstraints` seam as the row-local and FK classes; `or replace`/`or ignore`/upsert against such a key is rejected up front (detection-only scan cannot do row-time conflict resolution). Third enforcement class after row-local + FK. Implemented; needs review.
prereq:
files: packages/quereus/src/planner/mutation/lens-enforcement.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/planner/mutation/mutation-diagnostic.ts, packages/quereus/src/schema/lens-prover.ts, packages/quereus/test/lens-enforcement.spec.ts, docs/lens.md
----

## What shipped

The third lens enforcement class, sibling to the shipped row-local CHECK and
child-side FK existence classes — all three contribute to the same
`extraConstraints` array on the basis insert/update.

**Collector (`planner/mutation/lens-enforcement.ts`).**
`collectLensSetLevelConstraints(slot)` reads `slot.obligations`, selects
`kind === 'enforced-set-level' && mode === 'commit-time'` over a `primaryKey` /
`unique` constraint, and for each synthesizes (via `synthesizeUniqueCountExpr`):

```sql
(select count(*) from <logicalSchema>.<logicalTable> as _u
   where _u.lk1 = NEW.bk1 and … and _u.lkn = NEW.bkn) <= 1
```

- The subquery FROM is the **logical view** (schema-qualified + aliased `_u`), so
  `_u.<logicalCol>` resolves against the registered logical relation; `NEW.<basisCol>`
  is the basis write row, a correlated ref resolved from the surrounding constraint
  scope (exactly as the FK `EXISTS` resolves `NEW.*`).
- The `NEW.*` side uses **basis** column names (mapped via the reused module-private
  `logicalToBasisColumnMap`); the subquery side keeps **logical** names.
- `count(*)` is a `FunctionExpr{name:'count', args:[]}` — `astToString` renders it
  `count(*)` and the planner treats it as the row-count aggregate.
- `operations: INSERT | UPDATE`; `tags: { [LENS_BOUNDARY_ATTACHED_TAG]: true }`;
  `name`: `lens:pk` for a PK, `lens:unique:<name>` / `lens:unique` for a unique.
- Returns `[]` when `obligations` is undefined/empty or carries no commit-time
  set-level key (the common case — non-lens / plain view / proved / row-time pays
  nothing). `hasCommitTimeSetLevelObligation(slot)` is the predicate the rejection
  consults.

**Why it is correct (no new machinery):** the contained scalar subquery makes
`buildConstraintChecks` auto-defer the check to commit (`needsDeferred =
containsSubquery(...)`), the *same* mechanism the FK class relies on. At commit the
logical view reflects the post-mutation basis: the NEW row is present, so a unique
key sees count `1` (itself) and a duplicate `≥ 2` ⇒ ABORT. NULL-distinct falls out
for free — `_u.lk = NEW.bk` is `NULL` (never true) when either side is NULL, so a
NULL-key row is never counted. No registration / teardown / `AssertionEvaluator`
coupling — the slot's `obligations` are the source of truth (rebuilt clear-and-rebuild
on every `apply schema`). The synthetic-assertion approach the plan-stage proposed
was **deliberately not taken** (`core/database-assertions.ts` is untouched).

**Wiring (`view-mutation-builder.ts`).** `lensSetLevelConstraints(ctx, view)`
(mirrors `lensRowLocalConstraints`, no pragma gate) is appended to `extraConstraints`
for the non-delete case. `rejectLensSetLevelConflictResolution(ctx, view, req)` runs
before `propagate` (after the multi-source / decomposition early returns): for an
INSERT against a commit-time-set-level slot it raises the new diagnostic on
`onConflict === REPLACE | IGNORE` or any `upsertClauses`. `or abort`/`or fail`/
`or rollback`/plain insert pass (they ABORT, consistent with detection-only). UPDATE
carries no statement-level OR clause, so only INSERT is gated.

**Diagnostic (`mutation-diagnostic.ts`).** New reason
`lens-set-level-conflict-resolution` with a message pointing at the missing covering
structure + a `suggestion` to add a basis covering MV (mirrors the prover's
`lens.no-backing-index` advisory wording).

**Docs.** `docs/lens.md` § Constraint Attachment (maturity blockquote + set-level
bullet) updated: commit-time is now enforced via the deferred count-subquery, and
`or replace`/`or ignore` against a commit-time key is rejected. `lens-prover.ts`
module-doc note updated (commit-time class now enforces; row-time still pending its
sibling).

## Validation performed

- `yarn workspace @quereus/quereus run build` — exit 0.
- `yarn workspace @quereus/quereus test` (full memory-backed suite) — **4212 passing**,
  9 pending, exit 0. No regressions; no `.pre-existing-error.md` needed.
- `yarn workspace @quereus/quereus run lint` — exit 0.
- New `describe` block in `test/lens-enforcement.spec.ts` — **10 passing**.

## Use cases to re-verify (the new tests are a floor, not a ceiling)

Each new test deploys end-to-end through `apply schema` (fresh `Database`):

- **unique, single column** — distinct emails ok; duplicate ⇒ ABORT (`/unique|constraint/i`),
  first row survives; two NULL emails both accepted (NULL-distinct).
- **re-keyed PK** — basis keys `id`, logical re-keys on `code`; duplicate `code`
  (distinct basis `id`, so the basis PK does not catch it) ⇒ ABORT; distinct ⇒ ok.
- **rename override** — `view u as select id, mail as email …`; asserts via
  `collectLensSetLevelConstraints` + `astToString` that the expr has `count(*)`,
  `<= 1`, the **basis** `mail` (NEW side) and the **logical** `email` (subquery side),
  is `LENS_BOUNDARY_ATTACHED_TAG`-tagged and named `lens:unique`; then enforces and
  confirms the basis stores `mail`.
- **composite `unique(a,b)`** — `(1, NULL)` twice allowed; `(1, 2)` twice ⇒ ABORT.
- **update creating a duplicate** — collide ⇒ ABORT (row unchanged); still-unique ⇒ ok.
- **intra-statement duplicate** — one insert of two rows sharing the key ⇒ whole
  statement ABORTs (nothing inserted).
- **deferred timing** — `begin; insert dup; delete original; commit` commits cleanly;
  a state still duplicate at commit ABORTs (mirrors the FK deferred-semantics test).
- **conflict-resolution rejection** — `insert or ignore` / `insert or replace` /
  `on conflict (email) do nothing` rejected (`/covering|commit-time scan|conflict/i`);
  `insert or abort` / plain insert pass (and the duplicate check still bites under
  `or abort`).
- **negative** — `proved` PK ⇒ `[]` (write unaffected); `row-time` unique (covering
  MV present) ⇒ `[]` (only commit-time emits).

## Known gaps / boundaries — review with fresh eyes here

- **Single-source path only.** Both the set-level enforcement and the
  conflict-resolution rejection live *after* the multi-source-insert /
  decomposition-insert early returns in `buildViewMutation`, so they do **not** fire
  on those paths (which pass `extraConstraints: []` to member inserts anyway). This
  matches the ticket scope (commit-time set-level is reached only on single-source-ish,
  reconstructible-key lenses; multi-source put fan-out is write-rejected upstream).
  Worth a reviewer double-check that no decomposition/multi-source lens can present a
  commit-time set-level obligation *and* accept an `insert or ignore` that would slip
  past the rejection — I believe it cannot today, but it is an asymmetry, not an
  invariant proven in code.
- **No filtering-/projecting-body test.** The ticket argues counting over the
  *logical view* (not the basis table) is what makes a WHERE-filtering body sound (a
  duplicate is only a duplicate among logical rows). The tests exercise rename and
  composite bodies but not a `where`-filtered body — a deliberate omission to avoid
  entangling insert-through-filtered-view (view-updateability) semantics. If a
  reviewer wants belt-and-suspenders, a `select id, email from y.u where active = 1`
  lens with `unique(email)` would directly probe the count-over-logical-view claim.
- **Upsert over-rejection (conservative v1).** *Any* upsert is rejected when a
  commit-time set-level obligation is present, even if the upsert's conflict target
  is unrelated to the set-level key. Documented as the sound conservative choice; a
  reviewer may judge whether target-aware rejection is worth the complexity now.
- **Key-unchanged UPDATE re-counts.** The check fires on every UPDATE (INSERT|UPDATE
  ops), including updates that touch no key column (count = 1, passes). Correct but
  mildly wasteful; the physical parent-side FK check skips when referenced columns are
  unchanged — an analogous optimization is possible but not implemented.
- **Cost (documented, not optimized).** One O(n) count scan per changed NEW row ⇒
  O(n·m) for an m-row statement — the same asymptotic class the rejected synthetic
  assertion would have had. The sibling `lens-set-level-rowtime-enforcement` upgrades
  this to O(log n) via a covering structure and unlocks conflict resolution.

## Scope boundary

Detection-only. Row-time enforcement (covering structure → O(log n) + conflict
resolution) is the sibling `lens-set-level-rowtime-enforcement`, which takes this
ticket as a prereq. `core/database-assertions.ts` deliberately untouched.
