description: Live per-write enforcement of the lens prover's `enforced-set-level{mode:'commit-time'}` obligation — a logical `unique`/primary-key with no basis covering structure. Today these are classified but NOT enforced: a duplicate inserted through the lens is silently accepted. This ticket wires detection-only commit-time enforcement by synthesizing a deferred `(select count(*) … ) <= 1` check that rides the already-shipped `extraConstraints` seam (the same path as row-local CHECK and FK existence), and rejects `or replace`/`or ignore` against such a key. Second enforcement class after row-local + FK.
prereq:
files: packages/quereus/src/planner/mutation/lens-enforcement.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/planner/building/constraint-builder.ts, packages/quereus/src/planner/mutation/mutation-diagnostic.ts, packages/quereus/src/schema/lens-prover.ts, packages/quereus/test/lens-enforcement.spec.ts, docs/lens.md
----

## Context

The lens layer reaches write-soundness by consuming the prover's per-constraint
`ConstraintObligation`s (`schema/lens-prover.ts`) on each write. Two enforcement
classes already ship through one seam:

- **row-local CHECK** (`collectLensRowLocalConstraints`) and
- **child-side FK existence** (`collectLensForeignKeyConstraints`)

both in `planner/mutation/lens-enforcement.ts`, both routed onto the basis
insert/update via the `extraConstraints` parameter of `buildInsertStmt` /
`buildUpdateStmt` (wired in `planner/building/view-mutation-builder.ts`). This
ticket adds the **third** class: `enforced-set-level{mode:'commit-time'}`.

A logical `unique` / primary key that the body does not intrinsically prove and
that has **no basis covering structure** is classified by the prover
(`classifyKeyConstraint` in `lens-prover.ts`) as:

```
{ kind: 'enforced-set-level', mode: 'commit-time' }
```

It already emits the `lens.no-backing-index` advisory and is covered by the
prover spec tests `enforced-set-level commit-time` (unique) and the PK variant.
It is currently **classified but not enforced** — a write through the lens that
introduces a duplicate logical key is silently accepted.

## Key design decision — reuse the shipped seam, NOT a synthetic assertion

The plan-stage handoff proposed an assertion-style O(n) `DeltaExecutor` scan
registered as a *synthetic* commit-time assertion (`core/database-assertions.ts`),
and flagged the lifecycle (register-at-deploy / teardown-on-redeploy) as the main
cost/risk. **We deliberately do not take that path.** Investigation of the
constraint pipeline shows a far simpler, already-proven mechanism:

`buildConstraintChecks` (`constraint-builder.ts:167`) auto-defers **any** check
whose expression contains a scalar subquery or `EXISTS` to commit:

```ts
const needsDeferred = containsSubquery(expression) || containsCommittedRef(expression);
```

So a set-level uniqueness obligation is enforceable as a synthesized
**deferred count-subquery CHECK** routed through the identical `extraConstraints`
seam the FK class already uses — the FK class proves the mechanism end-to-end
(deferred `EXISTS` against the logical parent; see the FK deferred-semantics test
in `test/lens-enforcement.spec.ts`). The synthesized predicate, per key
constraint over logical key columns `lk1..lkn` mapping to basis columns
`bk1..bkn`:

```sql
(select count(*) from <logicalSchema>.<logicalTable> as _u
   where _u.lk1 = NEW.bk1 and … and _u.lkn = NEW.bkn) <= 1
```

Why this is correct:

- **Deferred to commit** — contains a scalar subquery, so the pipeline auto-defers
  it (no special-casing). At commit the logical view reflects the post-mutation
  basis; the NEW row is present, so a unique key sees count `1` (itself only) and a
  duplicate sees count `≥ 2` ⇒ ABORT. Matches "no two logical rows share the key".
- **Count over the logical view, not the basis table** — sound when the lens body
  filters/projects: a duplicate is only a duplicate among the *logical* rows. (For
  v1 the commit-time class is reached only on single-source-ish, reconstructible-key
  lenses; multi-source put fan-out is still write-rejected upstream, so NEW is
  unambiguous.)
- **NULL semantics fall out for free** — `_u.lk = NEW.bk` is `NULL` (not true) when
  either side is NULL, so any row with a NULL key column is never counted. This is
  exactly SQL UNIQUE's NULL-distinct rule (a composite `(1, NULL)` never conflicts
  with another `(1, NULL)`); no explicit `IS NOT NULL` guard is needed.
- **Self-reference is safe** — the subquery FROM is the *logical view* qualified by
  the logical schema and aliased (`as _u`); `NEW.*` resolves to the basis write
  row. Re-querying a view triggers only the read path, never re-entering write
  enforcement.
- **Intra-batch duplicates are caught** — two new rows sharing a key both see
  count `2` at commit ⇒ both ABORT.

Lifecycle cost is therefore **zero new machinery**: the slot's `obligations` are
the source of truth and are rebuilt clear-and-rebuild on every `apply schema`
(`deployLogicalSchema` → `clearLensSlots` / `addLensSlot`). The collector reads
`slot.obligations` at plan time exactly like the row-local and FK collectors — no
registration, no teardown, no `AssertionEvaluator` coupling.

**Cost note (document, do not optimize):** each synthesized check is one O(n)
count scan per changed NEW row (no covering structure by definition), so a
statement touching `m` rows is O(n·m) — the same asymptotic class the synthetic
assertion would have had (its per-tuple residual is also an O(n) key-filtered
scan). The row-time sibling (`lens-set-level-rowtime-enforcement`) is what upgrades
this to O(log n) via a covering structure; this ticket is detection-only.

## Mechanism — where each piece lands

`planner/mutation/lens-enforcement.ts` (new collector, sibling to the existing two):

- `collectLensSetLevelConstraints(slot: LensSlot): RowConstraintSchema[]` — reads
  `slot.obligations`, selects `kind === 'enforced-set-level' && mode === 'commit-time'`
  whose `constraint.kind` is `primaryKey` | `unique`, and for each builds the
  count-subquery `RowConstraintSchema`:
    - reuse the module-private `logicalToBasisColumnMap(slot)` to map each logical
      key column → its basis column (the `NEW.*` side);
    - the subquery side keeps **logical** column names (they resolve against the
      registered logical view, whose columns are pinned to the logical declaration);
    - `operations: RowOpFlag.INSERT | RowOpFlag.UPDATE` (a delete can't introduce a
      duplicate — DELETE is excluded by the view-mutation-builder anyway);
    - `tags: { [LENS_BOUNDARY_ATTACHED_TAG]: true }`;
    - `name`: `lens:pk` for a primary key, `lens:unique:<name>` / `lens:unique` for a
      unique (mirror the FK `lens:fk:<name>` convention).
  - Returns `[]` when `obligations` is undefined/empty or carries no commit-time
    set-level key (the common case — non-lens / plain view / proved key pays nothing).
  - Factor a small AST builder for the count-`<=`-1 expression (analogous to
    `synthesizeFKExistsExpr`). The logical key column names come from the
    constraint: `primaryKey.columns[].index` / `unique.constraint.columns[]` →
    `slot.logicalTable.columns[i].name` (see `logicalKeyColumns` in `lens-prover.ts`
    for the exact shape).

`planner/building/view-mutation-builder.ts`:

- Add `lensSetLevelConstraints(ctx, view)` (mirror `lensRowLocalConstraints` —
  resolve the slot via `ctx.schemaManager.getSchema(view.schemaName)?.getLensSlot(view.name)`,
  no pragma gate) and append it into the `extraConstraints` array next to the
  row-local + FK collectors for the non-delete case.
- **Conflict-resolution rejection.** Before/at that point, if the slot has any
  `enforced-set-level{mode:'commit-time'}` obligation AND the request is an insert
  with a conflict-resolution OR clause that the commit-time class cannot honor,
  raise `raiseMutationDiagnostic` with a new reason (below). The detection-only
  commit-time scan cannot perform replace/ignore (those need the row-time covering
  structure), so silently letting `insert or ignore` through would wrongly ABORT at
  commit instead of skipping — hence the up-front rejection.
    - `req.stmt.onConflict === ConflictResolution.REPLACE` or `=== ConflictResolution.IGNORE`
      (`common/constants.ts`) ⇒ reject. `ABORT`/`FAIL`/`ROLLBACK` are fine (they abort,
      consistent with detection-only).
    - UPSERT (`req.stmt.upsertClauses`) whose conflict target columns correspond to a
      commit-time set-level key ⇒ reject too (same reasoning). If matching the target
      columns is awkward, a sound conservative v1 is to reject any upsert when a
      commit-time set-level obligation is present, and document the over-rejection.
    - UPDATE has no statement-level OR clause (`update.ts` passes `onConflict:
      undefined`), so no update-side rejection is needed.

`planner/mutation/mutation-diagnostic.ts`:

- Add a `MutationDiagnosticReason` member, e.g.
  `'lens-set-level-conflict-resolution'`, with a clear message: the logical
  unique/PK enforces via an O(n) commit-time scan with no covering structure, so
  `or replace`/`or ignore` (row-time conflict resolution) is not supported — add a
  basis covering materialized view (ordered by the key columns) to upgrade to
  row-time enforcement. This echoes the prover's existing `lens.no-backing-index`
  advisory wording (`lens-prover.ts:592`).

## Requirements (restated, authoritative)

- A mutation (insert/update) through a lens-backed logical table whose obligations
  include an `enforced-set-level{mode:'commit-time'}` key is **rejected at commit**
  when it would introduce a duplicate of that logical key (detection-only — ABORT).
- A commit-time set-level key under `or replace` / `or ignore` is **rejected** with
  a clear diagnostic (conflict resolution requires a covering structure — the
  sibling row-time ticket).
- **Zero behavior change** for: tables with no set-level obligation, plain
  views/MVs (no lens slot), read-only logical tables (set-level enforcement moot),
  and `proved` / `row-time` keys.
- Composes with the already-shipped row-local + FK checks on the same write (all
  three classes contribute to the same `extraConstraints` array).
- NULL-distinct semantics preserved (multiple all-/any-NULL key rows allowed).

## Scope boundary

Detection-only. Row-time enforcement via a covering structure (which unlocks
conflict resolution) is `lens-set-level-rowtime-enforcement` (the sibling, which
takes this ticket as a prereq). FK enforcement already shipped
(`lens-fk-enforcement-wiring`). Do NOT touch `core/database-assertions.ts` — the
synthetic-assertion approach is explicitly rejected in favor of the deferred
count-subquery on the existing seam.

## Key tests (extend `test/lens-enforcement.spec.ts`, new describe block)

In the spirit of TDD, the enforcement suite should assert behavior end-to-end
through the full `apply schema` pipeline (matching the existing row-local/FK
blocks). Expected outcomes:

- **unique, single column** — `declare schema y { table u (id integer primary key,
  email text null) }`; logical `unique (email)` (no covering MV ⇒ commit-time).
    - Two distinct emails through the lens ⇒ ok.
    - A second insert with a duplicate email ⇒ ABORT (`/unique|constraint/i`); the
      first row survives.
    - Two NULL emails ⇒ both accepted (NULL-distinct).
- **re-keyed PK** — the prover's `enforced-set-level commit-time` PK case
  (`table t (id integer primary key, code text)` basis; logical
  `t (code text primary key, id integer)`): a duplicate `code` through the lens
  ⇒ ABORT; distinct codes ⇒ ok.
- **rename override** — logical `unique` over a renamed column, lens
  `select id, basisCol as logicalCol …`; the synthesized count check must reference
  the **basis** column on the `NEW.*` side and the **logical** column inside the
  subquery. Assert via `collectLensSetLevelConstraints(slot)` + `astToString` that
  the expr contains `count` and the basis column name, and is boundary-tagged
  (`LENS_BOUNDARY_ATTACHED_TAG`) and named `lens:unique:…` / `lens:pk`.
- **composite key** — `unique (a, b)`; `(1, NULL)` twice ⇒ allowed; `(1, 2)` twice
  ⇒ ABORT.
- **update that creates a duplicate** — seed two distinct rows, update one's key to
  collide ⇒ ABORT; an update that leaves the key unique ⇒ ok.
- **intra-statement duplicate** — a single insert of two rows sharing the key ⇒
  ABORT.
- **deferred timing** — within a `begin … commit`, a transiently-duplicate state
  that is resolved before commit (e.g. insert dup then delete the original in the
  same txn) must commit cleanly (mirrors the FK deferred-semantics test); a state
  still duplicate at commit ABORTs.
- **or replace / or ignore rejection** — `insert or ignore` / `insert or replace`
  into the commit-time-keyed logical table ⇒ rejected with the new diagnostic
  (assert on the `ViewMutationError` reason / message substring). `insert or abort`
  / plain insert ⇒ not rejected (subject to the duplicate check).
- **no-op / negative** — a logical table with no set-level obligation, and a plain
  view, ⇒ `collectLensSetLevelConstraints` returns `[]` and writes are unaffected;
  a `proved` key (basis PK faithfully projected) ⇒ `[]`; a `row-time` key (covering
  MV present) ⇒ `[]` (this ticket only emits for `commit-time`).

Run `yarn workspace @quereus/quereus test` (and `yarn workspace @quereus/quereus
run lint` with single-quoted globs on Windows). Stream output with `tee` per
AGENTS.md.

## Docs

Update `docs/lens.md` § Constraint Attachment: set-level commit-time is now
enforced via a deferred count-subquery on the write seam (not a follow-up), and
`or replace`/`or ignore` against a commit-time key is rejected. Update the prover
module-doc note in `lens-prover.ts` (the `set-level existence routing remains a
follow-up` line ~`:40`) to reflect that the commit-time class now enforces, with
row-time still pending its sibling ticket.

## TODO

Phase 1 — collector + AST builder
- Add `collectLensSetLevelConstraints(slot)` to `planner/mutation/lens-enforcement.ts`,
  reusing `logicalToBasisColumnMap`; add a count-`<=`-1 AST builder helper.
- Pull the logical key column names from the obligation's constraint
  (primaryKey/unique), mapping each to its basis column for the `NEW.*` side.

Phase 2 — wiring + conflict rejection
- In `view-mutation-builder.ts`, add `lensSetLevelConstraints(ctx, view)` and append
  it to `extraConstraints` for the non-delete case.
- Add the `lens-set-level-conflict-resolution` reason to `mutation-diagnostic.ts`
  and reject `or replace`/`or ignore` (and matching upsert) against a commit-time
  set-level key.

Phase 3 — tests + docs
- Add the new describe block in `test/lens-enforcement.spec.ts` covering the cases
  above.
- Update `docs/lens.md` § Constraint Attachment and the `lens-prover.ts` module-doc
  note.
- Run the quereus test suite + lint; fix any fallout. Flag genuinely pre-existing,
  unrelated failures per `tickets/.pre-existing-error.md` rather than chasing them.
