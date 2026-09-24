description: Adding a rule like "this column must always be positive" to a table that already holds rows breaking that rule used to be accepted silently, after which those rows vanished from queries that looked for them; the rule is now checked against the existing rows first and refused if any break it.
architecture: docs/sql-alter.md
files:
  - packages/quereus/src/runtime/emit/add-constraint.ts        # rejectCheckViolatedByExistingRows — the pre-dispatch guard, called from BOTH arms (module-routed + engine-side fallback)
  - packages/quereus/src/schema/constraint-builder.ts          # storedRowPredicate (conjunct split, old. screen, new. requalify) + validateChecksOverExistingRows (mask filter, aliased scan) — the one shared scan
  - packages/quereus/src/schema/rename/self-qualifier-strip.ts # requalifyOwnRowRefsInSchemaExpression — scope-aware `new.<col>` / `<table>.<col>` → `<alias>.<col>` rewrite
  - packages/quereus/src/schema/rename-rewriter.ts             # barrel export of the above
  - packages/quereus/src/planner/analysis/check-extraction.ts  # containsOldRowImageRef now exported (the optimizer's own screen, reused verbatim)
  - packages/quereus/src/runtime/emit/alter-table.ts           # validateBackfillAgainstChecks now routes through the shared scan (ADD COLUMN sibling fixed)
  - packages/quereus/src/index.ts                              # exports validateChecksOverExistingRows
  - packages/quereus/src/planner/building/schema-authored-context.ts  # NOTE rewritten: the statement seam now has one spelling
  - packages/quereus/src/vtab/memory/layer/manager.ts          # comments only
  - packages/quereus-store/src/common/store-module-alter.ts    # comment only
  - packages/quereus-sync/src/sync/store-adapter.ts            # comment only
  - packages/quereus/test/alter-add-constraint.spec.ts         # 19 new cases: the full new./old./mask/opt-out/self-fold/wrong-result matrix (memory)
  - packages/quereus/test/alter-table-conformance.spec.ts      # tightening suite, memory leg
  - packages/quereus-store/test/alter-table-conformance.spec.ts      # tightening suite, store leg
  - packages/quereus-isolation/test/alter-table-conformance.spec.ts  # tightening suite, isolation leg
  - packages/quereus/test/logic/10.1.8-alter-add-check-existing-rows.sqllogic  # new; runs under both memory and store logic legs
  - packages/quereus/test/declarative-equivalence.spec.ts      # new case: tightening a CHECK body declaratively against a violator is refused (and the drop already happened)
  - docs/sql-alter.md, docs/sql-ddl.md, docs/optimizer-fd.md, docs/design-isolation-challenges.md, docs/sync-schema.md, docs/module-authoring-schema-changes.md, docs/module-capabilities.md, docs/determinism.md, docs/schema-rename-detection.md
difficulty: hard
repro: verified
----

# `alter table … add constraint … check` now rejects rows that already violate it

## What changed

`ALTER TABLE … ADD CONSTRAINT … CHECK` validates the table's existing rows against the new predicate **before** anything is dispatched to the module or written to the catalog, and fails with `CONSTRAINT` when a row violates it. The table is left exactly as it was: no constraint in the catalog, none in the module's cached schema, nothing persisted. Both arms of the emitter — the module-routed one (memory, store, isolation, any module with an `alterTable` hook) and the engine-side fallback for modules without one — call the same guard, `rejectCheckViolatedByExistingRows` in `runtime/emit/add-constraint.ts`.

The scan itself is the pre-existing `validateChecksOverExistingRows` in `schema/constraint-builder.ts`, now the **one** existing-row CHECK scan for every path that installs a CHECK over rows that already exist: `ADD CONSTRAINT` (both arms), `ADD COLUMN … CHECK` (`validateBackfillAgainstChecks` was rewritten to call it), and the maintained-table derivation (unchanged caller). Three rules were folded into it so no caller can forget them:

- **Operation mask.** A CHECK whose mask covers neither INSERT nor UPDATE (`check on delete (…)`) constrains no stored row and is skipped. Superset of what the optimizer lifts (which needs both bits).
- **`old.<col>` conjuncts.** The predicate is split on top-level AND, and any conjunct containing an `old.` row-image reference is dropped — via `containsOldRowImageRef`, the optimizer's own screen, now exported from `check-extraction.ts`. A CHECK whose every conjunct is transitional is skipped entirely and does not block the statement. A mixed CHECK keeps validating its `old.`-free conjuncts (the case that would otherwise leave the hole open, since the optimizer still lifts them).
- **`new.<col>` and self-qualified refs.** The scan is now `select 1 from <t> as "__quereus_stored_row__" where not (<pred>) limit 1`, and `requalifyOwnRowRefsInSchemaExpression` (new, next to the self-qualifier strip in `schema/rename/self-qualifier-strip.ts`) rewrites `new.<col>`, `<table>.<col>` and `<schema>.<table>.<col>` to the alias. It rides the existing scope walker, so a qualifier rebound by an inner FROM/WITH (`(select max("new".v) from "new")`, `from other as t`) is left alone, and nothing under a sealed view write-through frame is touched. Qualified-to-alias rather than stripped-to-bare because a bare name inside a subquery can be captured by that subquery's FROM sources; an alias cannot.

`permitsGrandfatheredCheckViolators` is honored: a module declaring it skips the guard, and the optimizer already skips the lift for its tables, so the two halves of the contract stay consistent (same shape as `delegatesNotNullBackfill` gating `validateNotNullBackfill`).

The two "schema-only, matching the engine's prior in-emitter behavior" comments (memory manager, store alter) now say where validation happens. The `schema-authored-context.ts` NOTE that warned about two spellings of the statement seam now records that there is exactly one.

## Why the placement is load-bearing (reviewer: check this first)

The guard runs before `module.alterTable` and before `schema.addTable`. Moving it later makes it pass vacuously: the optimizer treats a declared CHECK as a fact about every stored row and folds the validation scan's own `where not (<expr>)` to nothing. The pin test in `alter-add-constraint.spec.ts` ("self-fold pin") demonstrates both halves — the end-to-end rejection, and that a direct call to the scan with the CHECK already in the live catalog passes vacuously over the same violating row. If the second half ever starts throwing, the fold no longer applies and the pin is moot; the test's comment says so.

## Validation run

- `yarn lint` — clean (eslint + test typecheck across the quereus package).
- `yarn test` — all workspaces green (quereus 10424 passing / 25 pending; store 426; isolation 179; sync 1958; others unchanged).
- `yarn test:store` — 10416 passing / 33 pending (the new sqllogic passes in store mode too).
- Focused runs: conformance legs memory 65 / store 35 / isolation 47 passing; the new sqllogic passes in memory and store mode when run alone.
- After the full runs above, two test-only edits landed (one more case in `alter-add-constraint.spec.ts`, one in `declarative-equivalence.spec.ts`); those two files were re-run together (184 passing) and the package lint re-run clean, but the full `yarn test` / `yarn test:store` were not repeated after them. No engine code changed after the full runs.

No existing sqllogic or spec needed its seed data changed: every populated ADD CHECK in the tree already seeded conforming rows (the one that looked suspect, `53.3` § 13, deletes the violator before the add). The existing conformance ADD CHECK arms seed `(1, 5), (2, 9)` and stayed honored.

## Use cases to verify

- Violating row → `CONSTRAINT`, message `CHECK constraint failed: <name> — existing rows in '<t>' violate the constraint`; `check_constraint_info('t')` empty; a later violating insert still succeeds (nothing installed). Store: nothing persisted (the tightening suite's store leg asserts catalog state, and the sqllogic's store mode covers a reopen-free session).
- Conforming table → accepted, forward enforcement live, and `select … where n <= 0` agrees with `select *` (the wrong-result probe).
- Uncommitted rows in the issuing transaction count (memory: `begin; insert violator; alter …` rejects; the staged row survives the rejection). Verified on memory only by spec; the isolation leg's tightening suite exercises the wrapper but not an open-transaction variant — see gaps.
- `check (new.n > 0)` rejects/accepts like `check (n > 0)`; `check (t.n > 0)` too; `check (exists (select 1 from lim where lim.cap >= new.n))` correlates `new.n` from inside the subquery correctly; `check (n < (select max("new".v) from "new"))` leaves the real table `"new"` alone.
- `check (old.n is null or n >= old.n)` is accepted against any rows and enforced on the next UPDATE; `check ((old.id is null or id = old.id) and status in ('a','i'))` rejects a row with `status = 'z'`; `check (n > 0 or old.n is not null)` is accepted (the `old.` inside the OR kills the whole conjunct, matching the lift).
- `check on delete (n > 0)` against a violator is accepted.
- `alter table t add column v integer default -1 check (new.v > 0)` → `CONSTRAINT` naming `_check_v` and "backfilled rows", column not added (was `new.v isn't a column` before).
- Module without `alterTable` → same rejection through the engine-side arm. Module with `permitsGrandfatheredCheckViolators` → accepted, and the violator is still found by `where n <= 0`.
- Declarative: tightening `check (qty > 0)` → `check (qty > 10)` against a row holding 5 fails the apply with `CONSTRAINT`; data survives; the old CHECK is already dropped (memory backend, non-atomic DROP+ADD) so a re-apply re-attempts the add. Documented in `docs/sql-alter.md` and `docs/schema-rename-detection.md` rather than leaving the old "forward-enforcing only" sentence.
- Tightening suite (all three conformance legs, table-driven): `set not null` vs NULL, `add unique` vs duplicates, `add check` vs violator, `add foreign key` vs orphan, `create unique index` vs duplicates, `add column … not null` without a default on a non-empty table. Each asserts `CONSTRAINT`, unchanged catalog, unchanged row count, and that a write the rule would forbid still succeeds afterwards.

## Known gaps and things worth a second look

- **Declarative refusal surfaces as `ERROR`, not `CONSTRAINT`.** `apply schema` wraps a failing migration statement as `Failed to execute DDL: … Error: <inner>` with `StatusCode.ERROR` (pre-existing wrapper in `runtime/emit/schema-declarative.ts`); the `CHECK constraint failed: <name>` diagnosis is inside the message. The new declarative test asserts that shape. A caller keying on the status code to distinguish "your data violates the new schema" from "the migration is broken" cannot today — not this ticket's to change, noting it for the reviewer.
- **One residual `new.` shape is left to fail loudly:** a correlated `new.<col>` written inside a subquery that selects from a real table literally named `new`. The qualifier is ambiguous by spelling there (the rename walkers document the same residual), so the rewrite leaves it alone and the scan fails to plan with `new.<col> isn't a column` — a rejection, never a silent pass. The non-ambiguous self-referencing shape (`new.n` inside `(select … from t …)`) is covered by a test and resolves to the stored row.
- **`unique_constraint_info` on a PK-only table** returns `[]` (the tightening suite relies on it). If a later change starts listing the PK there, the UNIQUE arm's `unchanged` probe needs a name filter.
- **Isolation leg + open transaction:** the ticket's claim that a staged-but-uncommitted violator in the *isolation-wrapped* backend is caught was verified by the ticket author, not re-verified here by a test. The isolation conformance file's second describe ("ALTER over staged overlay rows") would be the place for one.
- **Error message shape.** The ADD CONSTRAINT rejection reuses the scan's generic wording; the ADD COLUMN path keeps its own wording via the `onViolation` hook. Fine, but the two read differently for the same class of failure.
- **Sync layer untouched by design** (`validatesExistingRows` already classified the `check` add as row-validating); only comments were trimmed. Its replication spec still has no CHECK-tightening case (the FK one at ~738 is the closest sibling).

## Tripwires recorded

None new beyond what is in code comments: the `storedRowPredicate` doc and the `check-extraction.ts` gate comment each say "change one, change the other" about the lift/validation pairing — that is the invariant a future edit to either side must preserve.
