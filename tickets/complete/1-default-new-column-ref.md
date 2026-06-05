description: Adversarial review of the landed `new.<column>` DEFAULT feature — a column default may read a value the INSERT supplies for a sibling column (e.g. `slug text default (lower(new.title))`). Reviewed correctness, edge cases, resource safety, perf, emit/declarative round-trip, view inserts, the REPLACE/NOT-NULL path, determinism, generated-column interaction, and docs. Feature is sound; review added the missing test coverage, fixed one stale comment, and filed one low-priority backlog ticket.
files: packages/quereus/src/planner/building/insert.ts, packages/quereus/src/schema/manager.ts, packages/quereus/src/planner/building/constraint-builder.ts, packages/quereus/test/logic/03.4-defaults.sqllogic, packages/quereus/test/logic/44.1-nondeterministic-schema.sqllogic, packages/quereus/test/logic/46-mutation-context.sqllogic, packages/quereus/test/emit-roundtrip.spec.ts, packages/quereus/test/declarative-equivalence.spec.ts, docs/sql.md, docs/runtime.md
----

The `new.<column>` DEFAULT feature lets a column default read a **populated**
sibling the INSERT supplies (`doubled integer default (new.base * 2)`). Only
INSERT-supplied columns are visible; a default never reads another column's
default (no evaluation-order race); referencing an omitted column is a clean
resolution error. DDL validation defers the build/determinism check for any
`new.`-referencing default to INSERT time.

**Verdict: the implementation is correct and well-factored.** Every behavior I
probed matched the documented invariant. The review's value was in *coverage*:
the implementer's tests were a happy-path/override/omitted-error floor, and the
high-risk paths (emit round-trip, view insert, declarative apply, determinism
deferral, generated-column interaction, bare-vs-context precedence when the
column is supplied) were untested — any of them could have regressed silently.
Those are now pinned.

## Review findings

Each numbered risk from the review ticket, what was checked, found, and done.

### Checked and SAFE — coverage added

1. **Emit / declarative round-trip (was HIGH silent-break risk).** Verified
   `parse → astToString → parse` is **stable** and preserves the `new.`
   qualifier (`new.base`, `new.title` survive verbatim — the `column` emit case
   already renders `expr.table`, and `new` is not force-quoted). Verified a
   `new.` default survives `declare schema { … } apply schema` with catalog +
   probe equivalence. **Added** `emit-roundtrip.spec.ts` "DEFAULT reading a
   populated sibling via new.<column>" and `declarative-equivalence.spec.ts`
   "new.<column> default survives the declarative round-trip".

2. **Single-source VIEW insert.** Verified a view INSERT re-plans through
   `buildViewMutation → buildInsertStmt → createRowExpansionProjection` and the
   `new.` default fires correctly. **Added** a view-insert case to
   `03.4-defaults.sqllogic`.

4. **bare-vs-context precedence when the column IS supplied.** Verified that
   when a context variable and a column share a name and the column is supplied:
   bare `<col>` → the context variable (context shadows), `new.<col>` → the
   supplied column. No `RegisteredScope` "symbol already exists" throw. **Added**
   Test 12 to `46-mutation-context.sqllogic`.

5. **Determinism with non-deterministic functions.** Verified `default (new.x +
   random())` is rejected at INSERT under strict mode and permitted under
   `pragma nondeterministic_schema = true`; and that a pure deterministic
   `new.x + 1` is **not** mistaken for non-determinism (a bare `new.` column ref
   carries no non-determinism). **Added** three cases to
   `44.1-nondeterministic-schema.sqllogic`.

6. **Generated-column interaction.** Verified `new.<generated_col>` is a clean
   resolution error (generated columns are not source-supplied), and that a
   `new.` default coexists with generated columns without breaking the two-pass
   expansion (`dbl=20, g=11`). **Added** both cases to `03.4-defaults.sqllogic`.

7. **`defaultReferencesNewRow` any-depth scan.** Verified `new.<col>` *inside a
   subquery* in a default resolves as a correlated read of the inserted row
   (`coalesce((select new.x), 0)` → the row value). The any-depth deferral
   overlaps the existing subquery deferral, so it introduces no new false-defer
   class; the determinism check still fires at INSERT. **Added** a subquery case
   to `03.4-defaults.sqllogic`.

   Also verified **multi-row VALUES** and **INSERT…SELECT**: each row's default
   reads its own supplied sibling (covered indirectly; the row-expansion
   projection references the per-row source attribute).

8. **Resource safety.** Confirmed by inspection (per the ticket's spot-check
   directive): a `new.` ref opens no connection; the engine-level scan/txn
   cleanup is unchanged. Nothing in the diff allocates a runtime resource.

10. **Perf refactor (lazy `defaultCtxFor`).** Confirmed it memoizes via
    `rowScopedDefaultCtx` (built once, shared across all expression defaults),
    that literal/NULL defaults bypass it (`ctx`, no scope allocation), and that
    the lazy form is behavior-identical to the eager version (the registered
    scope contents do not depend on which column triggers construction). Plan
    caching is unaffected — the lazy build is plan-time, producing identical
    plan nodes.

### Found and FIXED inline (minor)

3. **REPLACE / NOT-NULL default path consistency.** `buildNotNullDefaults`
   registers **every** column as `new.<col>` (not just supplied ones), unlike
   the row-expansion path. Confirmed this is reachable now that `new.` defaults
   exist: `b not null default (new.a)` under `insert or replace … (b) values
   (null)` substitutes `new.a` reading `a`'s *materialised* value. This is **not
   a contradiction of the invariant** — the two paths run at different lifecycle
   points: row-expansion computes an omitted column's default *before the row is
   complete* (so it must hide not-yet-computed siblings to avoid an evaluation
   race), whereas the REPLACE NOT-NULL substitution fires *after the row is fully
   materialised* (so every column legitimately has a value). The behavior is
   defensible; the **comment was stale** ("defaults may not reference columns").
   **Fixed** the `buildNotNullDefaults` doc comment to state the real semantics
   and the deliberate timing difference.

### Found and FILED (minor, separate subsystem — not safely fixable in this pass)

3b. **Misattributed NOT NULL diagnostic.** In the REPLACE NOT-NULL substitution
    path, when a column-reference default resolves to NULL, the NOT NULL
    violation names the *referenced* column rather than the column being
    enforced (`b not null default (new.a)` with `a` NULL → "NOT NULL constraint
    failed: c1.a", should be `c1.b`). The statement still correctly rejects — a
    message-only defect. The fix lives in the constraint-check / OR-conflict
    reporting machinery, not the `new.`-default path, so chasing it here would be
    scope-creep. **Filed** `tickets/backlog/notnull-replace-default-colref-error-attribution.md`.

### Examined and deliberately LEFT AS-IS

9. **Error-message quality.** The omitted-column reference yields `"new.title
   isn't a column"` from the generic `resolve.ts` column resolver. Tailoring it
   ("`new.title` is unavailable: this INSERT does not supply `title`") would
   require special-casing the table name `new` in a shared resolution path used
   by all `table.column` lookups — including UPDATE/trigger/constraint contexts
   where `new.x` is a genuine NEW-row reference. The leak isn't worth it; the
   current message is technically accurate (within the default scope there is no
   `new.title` symbol). The omitted-column error remains asserted in
   `03.4-defaults.sqllogic`.

### Docs

- `docs/sql.md` § Default Values and `docs/runtime.md` DDL-validation rules were
  read in full and **match the shipped behavior** (deferred build/determinism,
  bare-column rejection with the `new.<column>` hint, supplied-only visibility).
  No edits needed.
- Swept the secondary docs (`view-updateability.md`, `module-authoring.md`,
  `architecture.md`): no stale default-resolution statement and no natural
  insertion point that improves on the sql.md/runtime.md coverage. Left
  unchanged intentionally.

### Out of scope (per review ticket — not re-filed)

The shared-key view-write **envelope** and **ALTER TABLE** default paths still
reject/ignore `new.<col>`; that extension is
`tickets/implement/8-default-new-ref-envelope-and-alter.md`. No new envelope/ALTER
gap was found during this review.

## Validation

- `node test-runner.mjs` (full `@quereus/quereus` suite): **4654 passing, 9
  pending, 0 failing**.
- Targeted logic files (`03.4-defaults`, `03.4.1-default-edge-cases`, `44.1`,
  `46-mutation-context`): pass.
- `emit-roundtrip.spec.ts` + `declarative-equivalence.spec.ts`: 162 passing,
  including the two new `new.<column>` cases.
- `yarn workspace @quereus/quereus lint`: clean.
- `yarn workspace @quereus/quereus typecheck`: clean.
- The review-ticket-noted `zz-right-probe.sqllogic` pre-existing probe is not
  present in this checkout; no unrelated failure surfaced, so no
  `.pre-existing-error.md` was filed.
