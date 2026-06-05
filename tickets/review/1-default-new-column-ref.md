description: Adversarial review of the landed `new.<column>` DEFAULT feature — a column default may read a value the INSERT supplies for a sibling column (e.g. `slug text default (lower(new.title))`). Scrutinize correctness, edge cases, resource safety, perf, and especially the paths the implementer did NOT test (emit round-trip, view inserts, REPLACE/NOT-NULL default path, declarative-schema). Verify tests and docs are complete.
files: packages/quereus/src/planner/building/insert.ts, packages/quereus/src/schema/manager.ts, packages/quereus/test/logic/03.4-defaults.sqllogic, packages/quereus/test/logic/03.4.1-default-edge-cases.sqllogic, packages/quereus/test/logic/44.1-nondeterministic-schema.sqllogic, packages/quereus/test/logic/46-mutation-context.sqllogic, docs/sql.md, docs/runtime.md
----

## How to find the diff (read this first)

The standard `git log --grep="ticket(implement): <slug>"` recipe **does not work here** — this
feature was implemented directly (not via a tess implement ticket) and the tess runner auto-committed
it, smeared across commits labeled for *unrelated* tickets (observed: `20ec7d7f` "view-write-nway-inner-join"
holds the `schema/manager.ts` change; `291485a6` "view-write-outer-join-static" holds the
`insert.ts` lazy-scope change; the original `new.` registration and the doc edits landed in still other
commits). **The whole feature is present in HEAD** — review the current on-disk state of the named
files. To see history for a specific hunk: `git log -p -S 'defaultReferencesNewRow' -- packages/quereus/src/schema/manager.ts`
and `git log -p -S 'defaultCtxFor' -- packages/quereus/src/planner/building/insert.ts`.

## What landed (the surface to review)

A `DEFAULT` may read a **populated** sibling via `new.<column>`. Only INSERT-supplied columns are
visible — a default never depends on another column's default (no evaluation-order race); referencing
an omitted column is a resolution error. Two cooperating pieces, plus a perf refinement:

- **Build — `insert.ts` `createRowExpansionProjection`.** `defaultCtxFor()` lazily builds a
  `RegisteredScope` (parented on the mutation-context scope) registering each source-supplied column
  under `new.<col>` and bare `<col>` (bare skipped when a same-named mutation-context variable shadows
  it via `!contextVarNames.has(...)`). Lazy = built only on the first omitted column carrying an
  *expression* default; literal/NULL defaults build against plain `ctx`.
- **DDL validation — `schema/manager.ts`.** `rejectIllegalReferences` lets a `new.`-qualified column
  past the bare-column rejection; `defaultReferencesNewRow` (new helper, scans **any** depth) drives a
  deferral so a `new.` default's build/determinism check moves to INSERT time. The bare-column reject
  message now names `new.<column>`.
- **Perf.** Runtime per-row path unchanged unless `new.` is used (`new.<col>` = one `resolveAttribute`,
  same as any column ref); all scope wiring is plan-time and now lazy.

## Explicitly OUT OF SCOPE (already filed — do NOT re-file)

The shared-key view-write **envelope** (anchor-key + per-member defaults) and the **ALTER TABLE**
default paths (ADD COLUMN backfill + ALTER COLUMN SET DEFAULT) still reject/ignore `new.<col>`. That
extension is `tickets/implement/8-default-new-ref-envelope-and-alter.md`. If you find a *new* gap there,
fold it into #8; don't open a duplicate.

## Scrutinize — known gaps & risk areas (highest risk first)

The implementer's tests are a floor (happy path + override + omitted-error + context coexistence). The
following are **untested or under-examined** — treat each as guilty until proven safe:

1. **Emit / declarative round-trip (HIGH — silent-break risk).** Does `emit/ast-stringify.ts` emit a
   `new.`-qualified column inside a default and re-parse it intact (`new.base * 2` → string → AST)?
   Does a table with a `new.` default survive the declarative pipeline (`declare schema { … } apply
   schema`, then emitted-DDL equivalence)? If the `new.` qualifier is dropped on stringify, the feature
   silently corrupts under schema export / declarative apply. Add coverage to `emit-roundtrip*.spec.ts`
   and `declarative-equivalence.spec.ts` / `test/property.spec.ts`.

2. **Single-source VIEW insert (HIGH).** A view INSERT re-plans through `buildViewMutation` →
   `buildInsertStmt` → `createRowExpansionProjection`, so `new.` *should* work — but it's untested.
   Add a view-insert `new.`-default case. (Multi-source/envelope is #8.)

3. **REPLACE / NOT-NULL default path consistency (HIGH).** `constraint-builder.ts buildNotNullDefaults`
   (the `INSERT OR REPLACE` NOT-NULL substitution path) registers `new.<col>` too — but reportedly for
   **all** columns, not just supplied ones, unlike the row-expansion path (supplied only). Reconcile:
   can a NOT-NULL default under `OR REPLACE` read an *unsupplied* sibling there, contradicting the
   "only populated columns visible" invariant? Pick one semantics and make both paths agree; test it.

4. **bare-vs-context precedence when the column IS supplied (MED).** `46-mutation-context.sqllogic`
   Test 9 only covers the *omitted*-column collision. The implementer changed the original
   "throw on collision" to "context variable shadows the column" for bare names — but only the omitted
   case is exercised. Add the case where a column is supplied AND shares a context-variable name
   (bare → context wins; `new.<col>` → the column). Confirm no `RegisteredScope` "symbol already exists"
   throw survives.

5. **Determinism with non-deterministic functions (MED).** `default (new.x + random())`: DDL defers, so
   INSERT-time `validateDeterministicDefault` must still reject it under default options and allow it
   under `pragma nondeterministic_schema = true`. Verify both; `validateDeterministicDefault` checks
   functions, not column refs — confirm a bare `new.` ref isn't mistaken for non-determinism.

6. **Generated-column interaction (MED).** `new.<generated_col>` in a default → gen cols aren't
   source-supplied → resolution error (intended?). Also confirm a `new.` default coexisting with
   generated columns doesn't break the two-pass expansion (`createGeneratedColumnProjection`).

7. **`defaultReferencesNewRow` any-depth scan (LOW-MED).** Deferral triggers on a `new.`-qualified
   column at *any* AST depth (incl. inside a subquery). Confirm this doesn't false-defer a genuine
   DDL error that should fail fast, and that `new.<col>` *inside a subquery* in a default resolves as a
   correlated ref at INSERT (or errors cleanly).

8. **Resource safety (LOW — already traced).** A `new.` ref opens no connection; a subquery-embedding
   default does. The scan emitter (`runtime/emit/scan.ts` finally → `disconnectVTable`) + transaction
   lifecycle clean up, and scalar subqueries full-drain. Engine-level cleanup is sound *provided the
   vtab module honors `disconnect()`*. Spot-check, don't re-derive.

9. **Error-message quality (LOW).** Omitted-column reference yields `"new.title isn't a column"` — reads
   like the column doesn't exist. Consider a clearer message ("`new.title` is unavailable: this INSERT
   does not supply `title`"). Implementer's call → yours; minor.

10. **Perf refactor correctness (LOW).** Confirm `defaultCtxFor` memoizes (built once across multiple
    expression defaults), literal/NULL defaults bypass it, and behavior is identical to the eager
    version. Confirm plan-cache interaction is unaffected.

## Docs to verify (treat as out-of-date until read)

- `docs/sql.md` § "Default Values" (added) and `docs/runtime.md` DDL-validation rules (updated) —
  confirm they match the shipped behavior.
- Sweep for *other* docs that describe defaults and should mention `new.`:
  `docs/view-updateability.md` (Mutation context), `docs/module-authoring.md` (DEFAULT resolution),
  `docs/architecture.md` (Determinism Enforcement / Sequential ID Generation). Mention or link as fits.

## Validation

- `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/t.log; tail -n 80 /tmp/t.log`
- `yarn workspace @quereus/quereus lint`
- `yarn workspace @quereus/quereus typecheck`
- Targeted: `03.4-defaults`, `03.4.1-default-edge-cases`, `44.1-nondeterministic-schema`,
  `46-mutation-context` logic files.
- NOTE: an untracked `test/logic/zz-right-probe.sqllogic` (RIGHT JOIN "not supported yet") fails in the
  full suite and is **not** part of this feature — pre-existing/external probe; ignore or flag per
  `tickets/.pre-existing-error.md`.

Disposition per stage rules: minor findings → fix inline this pass; major → new fix/plan ticket(s) (or
fold into #8 if it's an envelope/ALTER gap). Output `complete/` with a `## Review findings` section.
