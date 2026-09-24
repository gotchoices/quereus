description: Adding a rule like "this column must always be positive" to a table that already holds rows breaking that rule used to be accepted silently, after which those rows vanished from queries that looked for them; the rule is now checked against the existing rows first and refused if any break it.
architecture: docs/sql-alter.md
files:
  - packages/quereus/src/runtime/emit/add-constraint.ts        # rejectCheckViolatedByExistingRows — the pre-dispatch guard, called from BOTH arms (module-routed + engine-side fallback)
  - packages/quereus/src/schema/constraint-builder.ts          # storedRowPredicate (conjunct split, old. screen, new. requalify); validateChecksOverExistingRows (raw scan, no mask policy); validateRowInvariantChecksOverExistingRows (ALTER-side row-invariant gate)
  - packages/quereus/src/planner/analysis/check-extraction.ts  # containsOldRowImageRef + isRowInvariantCheck exported: the optimizer's own screens, reused verbatim by the scan
  - packages/quereus/src/schema/rename/self-qualifier-strip.ts # requalifyOwnRowRefsInSchemaExpression — scope-aware `new.<col>` / `<table>.<col>` → `<alias>.<col>` rewrite
  - packages/quereus/src/schema/rename-rewriter.ts             # barrel export of the above
  - packages/quereus/src/runtime/emit/alter-table.ts           # validateBackfillAgainstChecks routes through the row-invariant wrapper (ADD COLUMN sibling)
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts  # maintained-table caller keeps its wider op-mask-collapse filter and takes the raw scan (comment says why)
  - packages/quereus/src/runtime/emit/schema-declarative.ts    # NOTE tripwire: failed migration steps flatten to ERROR, inner code only on `cause`
  - packages/quereus/src/vtab/capabilities.ts                  # permitsGrandfatheredCheckViolators doc now names both halves of the contract
  - packages/quereus/src/index.ts                              # exports both scan entry points
  - packages/quereus/test/alter-add-constraint.spec.ts         # full new./old./mask/opt-out/self-fold/wrong-result matrix (memory); insert-only / update-only mask cases added in review
  - packages/quereus/test/logic/10.1.8-alter-add-check-existing-rows.sqllogic  # runs under memory and store logic legs; § 5 now covers all three partial masks
  - packages/quereus/test/alter-table-conformance.spec.ts      # tightening suite, memory leg
  - packages/quereus-store/test/alter-table-conformance.spec.ts      # tightening suite, store leg
  - packages/quereus-isolation/test/alter-table-conformance.spec.ts  # tightening suite, isolation leg; staged-overlay violator case added in review
  - packages/quereus/test/declarative-equivalence.spec.ts      # tightening a CHECK body declaratively against a violator is refused
  - docs/sql-alter.md, docs/sql-ddl.md, docs/optimizer-fd.md, docs/mv-constraints.md, docs/design-isolation-challenges.md, docs/sync-schema.md, docs/module-authoring-schema-changes.md, docs/module-capabilities.md, docs/determinism.md, docs/schema-rename-detection.md
difficulty: hard
repro: verified
----

# `alter table … add constraint … check` now rejects rows that already violate it

## What shipped

`ALTER TABLE … ADD CONSTRAINT … CHECK` validates the table's existing rows against the new predicate before anything is dispatched to the module or written to the catalog, and fails with `CONSTRAINT` when a row violates it. The table is left as it was: no constraint in the catalog, none in the module's cached schema, nothing persisted. Both emitter arms (module-routed and the engine-side fallback for modules without `alterTable`) call the same guard, `rejectCheckViolatedByExistingRows` in `runtime/emit/add-constraint.ts`.

The scan is `validateChecksOverExistingRows` in `schema/constraint-builder.ts`, now the one existing-row CHECK scan for every path that installs a CHECK over rows that already exist: `ADD CONSTRAINT` (both arms), `ADD COLUMN … CHECK`, and the maintained-table derivation. It splits the predicate on top-level AND, drops any conjunct that references `old.<col>` (a transition rule, using the optimizer's own `containsOldRowImageRef`), requalifies `new.<col>` and self-qualified `<table>.<col>` references to a scan alias no user FROM source can rebind, and runs `select 1 from <t> as <alias> where not (<pred>) limit 1`. A CHECK whose every conjunct is transitional is skipped without blocking the statement.

**Operation-mask policy belongs to the caller, not the scan** (changed in review, see findings). The ALTER paths go through `validateRowInvariantChecksOverExistingRows`, which keeps only CHECKs the optimizer's `isRowInvariantCheck` accepts (mask covers both INSERT and UPDATE, not deferred). The maintained-table derivation filters with its own, deliberately wider, op-mask collapse (any insert-or-update CHECK) and calls the raw scan.

Placement is load-bearing: the guard runs before `module.alterTable` and before `schema.addTable`, because the optimizer treats a declared CHECK as a fact about every stored row and would fold the validation scan's own `where not (…)` to nothing. The "self-fold pin" test in `alter-add-constraint.spec.ts` demonstrates both halves.

`permitsGrandfatheredCheckViolators` is honored: a module declaring it skips the guard, and the optimizer already skips the lift for its tables.

## Review findings

**Read first, before the handoff:** the full implement diff (`63e839aff`), then every touched doc.

### Found and fixed in this pass

- **Partial-mask CHECKs were validated too eagerly (semantic false positive).** The implementer gated the scan on "mask covers INSERT *or* UPDATE" and called it a superset of the optimizer's lift. But a row can be legally stored in violation of a partial-mask CHECK (inserted under `check on update (…)`, updated under `check on insert (…)`), so existing rows owe such a CHECK nothing, and the optimizer lifts nothing from it, so accepting leaves no wrong-result hole. Example: `check on update (status <> 'archived')` on a table with rows inserted as archived was refused. First fix attempt (gate the scan itself on `isRowInvariantCheck`) broke `51.8-maintained-table-declared-constraints.sqllogic` § 6, which documents that the maintained-table derivation validates `on update` CHECKs against derived images on purpose (op-mask collapse, `docs/mv-constraints.md`). That revealed the "either bit" rule was serving that caller, not the ALTER paths. Resolution: the raw scan carries no mask policy (only the intrinsic `old.` screen); a new `validateRowInvariantChecksOverExistingRows` wrapper applies the optimizer's exact gate and is what both ALTER paths call; the maintained-table caller keeps its own filter and a comment saying why it differs. `isRowInvariantCheck` is exported from `check-extraction.ts` for this, so the validated set on the ALTER paths is now exactly the lifted set by construction. Tests: two new spec cases (insert-only, update-only, each asserting the constraint installs and the violator stays visible to `where n <= 0`) and sqllogic § 5 extended to all three partial masks. Docs updated: `sql-alter.md`, `optimizer-fd.md`, `mv-constraints.md`, and the doc comments on the scan, the wrapper, the gate, and the maintained-table caller.
- **`capabilities.ts` flag doc was one-sided.** `permitsGrandfatheredCheckViolators` described only the lift half of the contract. Added the sentence that the engine's ADD CONSTRAINT scan is what it skips.
- **Stale reason in two comments.** The maintained-table validator's doc and `docs/mv-constraints.md` said `new.`/`old.` CHECKs are rejected at registration because "the SQL scan could not resolve the qualifiers". The scan now can; the registration rule stands on the derivation semantics (no OLD image). Reworded both.
- **Isolation-leg gap the handoff flagged, closed.** Added a test to the isolation conformance's "ALTER over staged overlay rows" describe: an overlay-only violator inside an open transaction is caught, no CHECK installs, and the staged row survives and stays visible. Passes.
- **Stale `dist` during the handoff's cross-package runs.** The store, isolation and sync test suites import `@quereus/quereus` from its built `dist`, which was stamped 10:02, before the implement commit at 10:21. Rebuilt and re-ran all three plus the store sqllogic leg (see validation).

### Checked, nothing to do

- **Both emitter arms call the guard, before any mutation.** Confirmed by reading `runAddConstraintViaModule` and `runAddCheckEngineSide`; the constraint schema handed to the guard is built with the same builder and taken-name set the module uses, so the reported name matches the catalog's.
- **`new.` requalification scope rules.** Walked `requalifyOwnRowRef` against the strip walker: innermost-first rebind check skips the seed frame, a schema-qualified `main.new.a` is left as a three-part ref, sealed view frames are untouched. The one residual (a correlated `new.<col>` inside a subquery that selects from a real table named `new`) fails to plan loudly, never passes silently; documented in the walker and the handoff.
- **Requalifying to an alias, not stripping to bare.** Correct: a bare name inside a subquery can be captured by that subquery's FROM sources; the alias `__quereus_stored_row__` cannot be rebound by anything a user writes.
- **`topLevelConjuncts` matches the optimizer's `walkConjunction`** (same `binary`/`AND` split, source order preserved).
- **ADD COLUMN sibling.** `validateBackfillAgainstChecks` now mints constraint names with the same builder and taken set the module install uses, so an inline `check (new.v > 0)` reports `_check_v` instead of "isn't a column". Verified by sqllogic § 6.
- **Sync layer.** `validatesExistingRows` already classified the CHECK add as row-validating; only comments changed. Nothing to fix.
- **Existing sqllogic and specs needed no seed changes.** Every populated ADD CHECK in the tree seeds conforming rows; the full memory and store legs confirm it.
- **Comment hygiene.** Comments are dense but say why, not what; no narrated runs to extract. File sizes after the change: `constraint-builder.ts` 678 lines, `add-constraint.ts` 315, `self-qualifier-strip.ts` 195 (`wc -l`). No split warranted.
- **Accepted tradeoffs.** No `NOTE:` at any touched site was contradicted.

### Tripwires recorded

- **Declarative refusal surfaces as `ERROR`, not `CONSTRAINT`.** `apply schema` wraps every failed step with `StatusCode.ERROR`; the inner code is on `cause` and inside the message. Pre-existing and not specific to CHECK. Parked as a `NOTE:` at the wrapper in `runtime/emit/schema-declarative.ts`: if a caller ever needs to key on "data violates the new schema" vs. "the migration is broken", propagate the inner code.
- **Lift/validation pairing invariant.** The `storedRowPredicate` doc, the wrapper doc and the `check-extraction.ts` gate comment each say "change one, change the other". Not new; index entry only.
- **`unique_constraint_info` on a PK-only table returns `[]`** and the tightening suite's UNIQUE arm relies on it. If a later change lists the PK there, the `unchanged` probe needs a name filter. Left in the handoff text; the test would fail loudly, so no comment added.

### Not filed, and why

- **Non-atomic declarative DROP + ADD leaves a tightened CHECK dropped on a failed re-add** (memory backend). This is the same class as UNIQUE and FK re-adds, documented in `docs/sql-alter.md` and `docs/schema-rename-detection.md` as "apply aborts + data survives, not old constraint restored". CHECK newly joins that class because its re-add can now fail. No open ticket names declarative-apply atomicity, and the docs present the guarantee as a deliberate one, so this stays a documented limitation rather than a new ticket. If a human wants the stronger guarantee, the right shape is a class-level ticket on declarative apply atomicity, not a CHECK-specific one.
- **Error-message wording differs between ADD CONSTRAINT and ADD COLUMN** for the same class of failure. Cosmetic; the ADD COLUMN wording carries "backfilled rows", which is accurate there.

## Validation run (review)

- `yarn lint` clean after all edits (eslint plus the test-file type pass).
- `yarn test` all workspaces green after all edits: quereus 10428 passing / 25 pending; every other package green.
- Rebuilt `@quereus/quereus` `dist`, then re-ran the store (1958), isolation (427, includes the new staged-violator case) and sync (755) suites: green.
- `yarn test:store` after the rebuild: 10420 passing / 33 pending, including the extended sqllogic in store mode.
- The one failure seen mid-review (`51.8-maintained-table-declared-constraints.sqllogic:159`) was caused by my first mask-gate attempt and resolved by the wrapper split; it is green in the final runs.

## Use cases verified

- Violating row → `CONSTRAINT`; `check_constraint_info('t')` empty; a later violating insert still succeeds. Store: nothing persisted.
- Conforming table → accepted, forward enforcement live, and `select … where n <= 0` agrees with `select *`.
- Uncommitted rows in the issuing transaction count, on memory and on the isolation-wrapped backend; the staged row survives the rejection.
- `check (new.n > 0)`, `check (t.n > 0)`, and a `new.n` correlated from inside a subquery all validate like the bare form; a subquery over a real table named `"new"` is left alone.
- `old.`-only CHECKs are accepted against any rows; mixed CHECKs still validate their `old.`-free conjuncts; an `old.` inside an OR kills that whole conjunct.
- `check on insert`, `check on update`, `check on delete` against a violator are accepted, and the violator stays visible to the contradicting query.
- `add column v integer default -1 check (new.v > 0)` → `CONSTRAINT` naming `_check_v`, column not added.
- Module without `alterTable` → same rejection; module with `permitsGrandfatheredCheckViolators` → accepted, violator still found.
- Declarative tightening `check (qty > 0)` → `check (qty > 10)` against a row holding 5 fails the apply; data survives.
- Tightening suite on all three conformance legs: `set not null`, `add unique`, `add check`, `add foreign key`, `create unique index`, `add column … not null` without default.
