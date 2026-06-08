---
description: A new `nondeterministic_schema` boolean database option / PRAGMA (alias `allow_nondeterministic_schema_expressions`, default `false`) gates the static rejection of non-deterministic expressions in DEFAULT, CHECK, and `GENERATED ALWAYS AS` clauses. The validators themselves stay strict; the five call sites that invoke them are wrapped in the gate. Independent scope checks (bind-parameter / column-reference pre-walks) stay active in both modes.
files:
  - packages/quereus/src/core/database.ts
  - packages/quereus/src/schema/manager.ts
  - packages/quereus/src/planner/building/insert.ts
  - packages/quereus/src/planner/building/update.ts
  - packages/quereus/src/planner/building/constraint-builder.ts
  - packages/quereus/test/logic/44.1-nondeterministic-schema.sqllogic
  - packages/quereus/test/planner/validation.spec.ts
  - docs/runtime.md
  - docs/architecture.md
  - docs/module-authoring.md
  - docs/sql.md
  - docs/lens.md
---

## Outcome

A single boolean database option, `nondeterministic_schema`
(alias `allow_nondeterministic_schema_expressions`, default `false`),
lifts the static rejection of non-deterministic expressions in DEFAULT,
CHECK, and `GENERATED ALWAYS AS` clauses when set to `true`.

The replay contract documented in `docs/runtime.md` § "Determinism
Validation" is: the captured artifact at the `vtab.update()` frontier is
fully resolved per row (defaults / stored-generated evaluate before the
module call; immediate row CHECKs fire at write time; deferred CHECKs
decide commit-or-rollback once at commit). Source-expression determinism
is a stricter-than-necessary proxy for that invariant, so the engine now
makes the strictness opt-out rather than mandatory.

### Gating sites (five)

The option is read at each of the five validator call sites and the
strict `validateDeterministic*` call is skipped when the option is
`true`:

1. `packages/quereus/src/schema/manager.ts` — `validateDefaultDeterminism`
   (CREATE TABLE DEFAULT determinism check, internally gated; the bind-param /
   column-reference pre-walk runs in both modes).
2. `packages/quereus/src/schema/manager.ts` — `validateCheckConstraintDeterminism`
   (CREATE TABLE CHECK determinism check, internally gated; the bind-param
   pre-walk runs in both modes).
3. `packages/quereus/src/planner/building/insert.ts:131` — DEFAULT
   determinism check at INSERT build time.
4. `packages/quereus/src/planner/building/insert.ts:201` — GENERATED
   ALWAYS AS determinism check at INSERT build time.
5. `packages/quereus/src/planner/building/update.ts:115` — GENERATED
   ALWAYS AS determinism check at UPDATE build time.
6. `packages/quereus/src/planner/building/constraint-builder.ts:150` —
   CHECK constraint determinism check at INSERT / UPDATE / DELETE build
   time (this is the row-context-resolved CHECK pass that the implementer's
   first iteration missed; both this and the AST-walk in
   `validateCheckConstraintDeterminism` need to be gated).

(That's actually six gating points; the "four/five" counts in earlier
ticket prose fold the two manager-side validators into "CREATE TABLE
DEFAULT" / "CREATE TABLE CHECK" buckets, and the constraint-builder site
into the "DML-time CHECK" bucket.)

### Coverage

- New `packages/quereus/test/logic/44.1-nondeterministic-schema.sqllogic`
  exercises: pragma roundtrip + alias; strict-mode rejection of DEFAULT /
  CHECK / GENERATED random(); relaxed-mode acceptance of DEFAULT
  `random()`, DEFAULT `datetime('now')`, immediate CHECK with
  `datetime('now') >= '2020-01-01'`, immediate CHECK with
  `random() IS NOT NULL`, stored generated `random()`, CREATE ASSERTION
  with `random()`; pragma-off-after-on semantics (existing schema is
  preserved, INSERTs that re-fire the non-det DEFAULT re-validate against
  the *current* pragma); and bind-parameter / column-reference pre-walk
  rejection under relaxed mode (the only scope check kept strict).
- `packages/quereus/test/planner/validation.spec.ts` adds a
  "validators remain strict when called directly" block that locks in
  "the relaxation lives at the call sites, not in the validators".

## Review findings

**Source diff first, then the handoff.** Read the implement commit
(cef4c535) cold before consulting the implementer's "What landed"
section. The diff is small (5 source files + 2 test files + 5 doc files),
and the implementer's known-gaps list at the bottom of the review ticket
is honest about the four behaviours flagged.

### Findings

- **Doc-vs-implementation discrepancy on scope-check pre-walks** (minor —
  fixed inline). `docs/runtime.md` § "Validation Timing" claims:
  > The bind-parameter / column-reference pre-walks remain active in
  > both modes (those are scope checks, not determinism checks).

  But the implement-stage gate at `schema/manager.ts:1492` wrapped the
  entire `validateDefaultDeterminism` / `validateCheckConstraintDeterminism`
  calls in `if (!allowNonDet)` — those validators *also* perform the
  bind-param / column-ref pre-walks via `rejectIllegalReferences`, so
  relaxed mode silently skipped the scope checks too.

  Fix: moved the gate inside each validator. Both functions now always
  run their `rejectIllegalReferences` pre-walk; only the determinism
  half (the `checkDeterministic` call in `validateDefaultDeterminism`,
  the function-flag AST traversal in
  `validateCheckConstraintDeterminism`) is skipped when
  `allowNonDeterministic = true`. The validators gain a default-false
  `allowNonDeterministic` parameter so any future internal caller stays
  on the strict path by default.

  Regression test added to the 44.1 sqllogic — three cases under
  `pragma nondeterministic_schema = true`:

  ```sql
  CREATE TABLE … (v INTEGER DEFAULT (?));
  -- error: may not reference bind parameters
  CREATE TABLE … (a INTEGER, b INTEGER DEFAULT (a));
  -- error: may not reference columns
  CREATE TABLE … (v INTEGER, CHECK (v > ?));
  -- error: may not reference bind parameters
  ```

- **The six gating sites are the complete set.** Walked every
  `validateDeterministic*` and `checkDeterministic` reference via
  `find_references`. All call sites of the per-name validators
  (`validateDeterministicDefault`, `validateDeterministicGenerated`,
  `validateDeterministicConstraint`) are in the three planner-building
  files; both schema-manager validators are at the CREATE TABLE site.
  The validators themselves and the test file are the only other
  references. Nothing missed.

- **Each gate reads the right `db.options`.** `ctx.db.options` in the
  planner-building call sites (planning context carries the Database
  ref); `this.db.options` in the schema-manager call sites. Both are
  in scope; the pattern matches the existing `foreign_keys` pragma usage
  at the same files (`insert.ts:557`, `update.ts:175`, `delete.ts:139`,
  `manager.ts:481/526/1175`).

- **NOT NULL REPLACE substitution and non-det DEFAULTs.** A side path I
  was uncertain about: the constraint-check emitter
  (`runtime/emit/constraint-check.ts:268`) calls `defaultEntry.evaluator`
  when REPLACE substitutes a column DEFAULT for an explicitly-NULL value.
  Those evaluators are built by `buildNotNullDefaults`
  (`constraint-builder.ts:198+`), which today does not invoke the
  determinism validator. That means even under strict mode, the REPLACE
  fallback may evaluate a default that the *primary* INSERT path
  rejected — but it can only reach a row whose explicit NULL it is
  patching, and the default has already been built into a plan node, so
  the gating decision is whether to build/run it at all. In strict mode
  this path is unreachable because the same DEFAULT would already have
  been rejected at INSERT build time; in relaxed mode the relaxed
  resolution is exactly what REPLACE intends. No fix needed.

- **DDL-time pre-walks (rejectIllegalReferences) still cover the bind-param
  / column-ref classes that the planner-side validators don't cover.**
  At DDL time `CHECK (v > ?)` and `DEFAULT (other_col)` are caught by
  `rejectIllegalReferences` walking the AST (no scope is available yet).
  At DML time the same shapes either resolve cleanly (column refs in
  DEFAULT are forbidden by `rejectIllegalReferences` at DDL anyway, so
  they never get to DML) or fail through normal expression-build error
  paths. The gate fix above ensures DDL pre-walks still fire in relaxed
  mode.

- **The `nondeterministic_schema` option metadata is consistent with
  `foreign_keys` and `default_column_nullability`.** Registered in
  `setupOptionListeners()` next to the others, type/default/aliases/
  description present, `onChange` logs the change. PRAGMA roundtrip
  works via the alias too (with the pre-existing caveat the implementer
  noted — the PRAGMA emitter echoes the literal name as written; the
  underlying value is canonical).

- **Docs reviewed end-to-end.** `runtime.md` § "Determinism Validation"
  (rewritten lede correctly frames the option, the strict-mode behaviour
  table is preserved, "Validation Timing" introduces the option-skip
  rule and notes the scope-check carve-out — which now matches the
  implementation after the fix above). `architecture.md` § Constraints —
  Determinism Enforcement bullet correctly cross-links to runtime.md
  and module-authoring.md. `module-authoring.md` § "Mutation Statements"
  — the tightened "audit / transport encoding" wording is accurate, and
  the "Defaults / Generated Columns are per-row literal-resolved"
  bullet captures the right invariant. `sql.md` § 9.2.4 entry is a
  faithful summary of the pragma surface (name, alias, default, scope,
  example). `lens.md`'s § "shared key need not be a logical key" gains
  a paragraph extending the surrogate-key story to non-deterministic
  generators under this option — consistent with the new pragma.

- **Lint clean** (`yarn workspace @quereus/quereus run lint`).
  **Tests clean** (`yarn workspace @quereus/quereus run test`):
  3674 passing, 9 pending, 0 failing. The 44.1 sqllogic file passes
  including the three regression cases added in this review.
  `yarn test:store` was not run — this change is engine-side and
  store-agnostic (the option lives on `Database.options` and the
  validators are at planning time), so store mode should produce
  identical results.

### Findings deferred to follow-ups (not opened as new tickets here)

- **"Pragma off after on" footgun** (implementer's known gap #1). A
  table with `DEFAULT random()` created under relaxed mode keeps that
  expression in its schema; flipping the pragma off makes any INSERT
  that *would* fire the default re-compile and fail. Explicit-column
  INSERTs and SELECTs still work. This is documented in the sqllogic
  test and in `docs/runtime.md` § "Scope" (the option is read at
  validation time, not baked into the schema), and is consistent with
  how other compile-time-decided pragmas behave. If we ever want
  bake-at-DDL semantics (option sampled into the table schema at
  CREATE TABLE), that's a deliberate semantic change requiring a
  separate ticket. Leaving as-is.

- **ALTER TABLE determinism gap** (implementer's known gap #2,
  pre-existing). `ALTER TABLE ADD COLUMN`, `ADD CONSTRAINT`, and
  `ALTER COLUMN ... SET DEFAULT` do not route through the determinism
  validators at DDL time today. The gap exists in *both* strict and
  relaxed modes and is documented in `docs/runtime.md` § "Validation
  Timing" as a known follow-up. This ticket does not touch ALTER paths;
  when a future ticket extends ALTER to invoke the validators, the
  `nondeterministic_schema` gate I added covers it transparently
  (the same validator functions are used).

- **PRAGMA emitter echoes alias name as written** (implementer's known
  gap #4). Pre-existing behaviour of `runtime/emit/pragma.ts` — the
  result row carries the alias the user typed, not the canonical name.
  Not specific to this option (every aliased pragma in the engine
  behaves this way). Leaving as-is.

- **No probabilistic CHECK rejection coverage** (implementer's known
  gap #5). Choice of test predicates (`random() IS NOT NULL`,
  `datetime('now') >= '2020-01-01'`) avoids flakiness. There's no test
  that demonstrates a relaxed-mode CHECK *rejecting* a row whose
  predicate evaluates to false under non-determinism. The omission is
  fine — the relaxation is about whether the expression is *accepted*
  by validation; the actual constraint-check semantics are unchanged
  and covered by existing CHECK tests. Not worth a new ticket.

- **Implementer's known gap #6** (no rewrite of the rejected/accepted
  function bullet lists in `runtime.md`) — judgment call. The
  bullet lists are now under "Strict-mode behaviour (default)" and
  serve as a reference. Tightening would mean folding the prose
  paragraph above them into the same level, which I'd rather leave for
  a docs-only cleanup if it bothers readers. Not opening a ticket.

- **Implementer's known gap #7** (validator unit-test message regex
  is light, `/Non-deterministic expression not allowed/`) — fine.
  The per-site message strings are already locked by the original
  per-validator tests above the new block.
