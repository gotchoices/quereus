description: COMPLETE — null-safe parent-side FK UPDATE short-circuit guard. A value→NULL update of a *nullable* referenced parent key while a child references the old value now ABORTs (parity with physical RESTRICT), via a three-arm null-safe equality synthesized from existing AST node kinds. Reviewed: fix is sound, well-tested, docs current.
files: packages/quereus/src/planner/mutation/lens-enforcement.ts, packages/quereus/test/lens-enforcement.spec.ts, docs/lens.md
----

## What shipped

`buildParentSideUpdateGuard` (parent-side FK UPDATE short-circuit) previously compared
the referenced key with plain `=`. For a **nullable** referenced parent key a value→NULL
update made `OLD.p = NEW.p` evaluate to `NULL`; `NULL or <false NOT EXISTS> = NULL`, which
the deferred-constraint check (`value === false || value === 0`) does not treat as a
failure — so an orphaning update was wrongly admitted, diverging from physical RESTRICT.

The fix introduces `buildNullSafeEquality(col)` — a per-column null-safe
(`is not distinct from`) comparison built from only existing AST node kinds:

```
( OLD.p is null and NEW.p is null )
  or ( OLD.p is not null and NEW.p is not null and OLD.p = NEW.p )
```

This three-arm form yields a definite **false** (never NULL) when exactly one side is
NULL — so a value→NULL key change falls through to the `NOT EXISTS`, which finds the child
⇒ ABORT. `buildParentSideUpdateGuard` maps each parent basis column through it. DELETE is
unchanged (plain `NOT EXISTS`, no guard — op-specific synthesis). For a NOT-NULL referenced
key the null arms are dead and the predicate collapses to plain `=` (exact physical parity).

## Review findings

**Verdict: the FK fix is sound, correctly scoped, well-tested, and the docs are current.
One unrelated-provenance concern flagged (backlog ticket filed); no code defects in the fix.**

### Correctness (FK null-safe guard) — checked, no defects
- **Three-arm truth table verified by hand** for all four cases (value→NULL ⇒ definite
  `false`; NULL→NULL ⇒ `true`; value→value equal ⇒ `true`; value→value differing ⇒
  `false`). No arm can yield `NULL` because the `is not null` conjuncts gate the `=` and
  `is null`/`is not null` return definite booleans. So the deferred-constraint check
  (`false`/`0` ⇒ fail) sees the intended definite values.
- **AST node kinds are valid and round-trip.** `UnaryExpr` operator strings `'IS NULL'` /
  `'IS NOT NULL'` and `BinaryExpr` `'AND'`/`'OR'`/`'='` are exactly what `emit/ast-stringify.ts`
  and the runtime evaluate (confirmed against `ast-stringify.ts` postfix handling). Runtime
  evaluation is exercised by the passing behavioral tests, not just stringification.
- **DELETE untouched** — unit test asserts `del[0].expr` has no `NEW.email` reference. The
  doc explains why DELETE cannot share the null-safe guard (NEW all-NULL ⇒ `OLD ≡ NEW` would
  wrongly short-circuit a NULL OLD key).
- **NOT-NULL / PK parity** — for a non-nullable key the predicate collapses to plain `=`, so
  the broad common case is byte-for-byte the prior behavior; the fix is reachable only for
  the unusual FK-references-a-nullable-unique-column case.

### Tests — extended (the implementer's were the starting point)
- **Closed the flagged composite-nullable gap (minor → fixed inline).** Added
  `value→NULL on ONE component of a composite nullable referenced key ABORTs` — proves the
  per-column null-safe arm survives the AND-reduction (the nulled component's arm is `false`,
  the unchanged component's `true`, AND ⇒ `false` ⇒ fall through ⇒ ABORT). The prior
  composite test used a NOT-NULL PK parent, so this path (n>1 with a nullable component) was
  uncovered.
- **Negative control run** (temporarily reverted the source to plain `=`): the value→NULL
  test fails with "expected the operation to throw" — i.e. the original orphaning bug
  reproduces — and all null-safe tests pass on the restored code. Confirms the tests
  genuinely guard the fix, not just the happy path.
- Edge/benign cases already covered: NULL→NULL no-op succeeds, value→value unchanged
  (`set id = id`) succeeds, unit assertion on the synthesized SQL (both the `=` arm and the
  `is null and is null` arm present).

### Docs — checked, current
- `docs/lens.md` § Foreign key parent-side: the `≡` short-circuit guard is documented as
  null-safe (with the synthesized form spelled out) and the prior **v1 divergence** caveat
  (which referenced this slug) was removed. Repo-wide grep for `nullable-key-update-gap` /
  `v1 divergence` / `null-safe` in `*.md` finds no other stale reference.

### Validation
- `yarn lint` (full quereus package) — **exit 0** (the implementer's
  `.pre-existing-error.md` lint complaint about `DeltaApplyInput` in `database-watchers.ts`
  was a transient stale-working-tree artifact; the committed file uses the import at line
  214 and lints clean. The triage commit `27ba5739` only deleted the marker — but the
  underlying error no longer reproduces).
- `node test-runner.mjs` full suite — **4344 passing** (was 4343; +1 my composite test),
  9 pending, **0 failing**.
- `lens enforcement: parent-side FK` describe — **40 passing** (was 39); full `lens
  enforcement` — **94 passing** (was 93).

### Major finding (filed, not fixed here): unrelated feature swept into this ticket's commits
The implement commit `b28548c2` bundled an **unrelated, in-flight feature** —
`notifyExternalChange` / external-change watcher notification — across
`src/core/database.ts` (+26), `src/core/database-watchers.ts` (+60), and a new
`test/external-change-watch.spec.ts` (+166). More uncommitted edits of the same feature sit
in the working tree right now (`src/runtime/delta-executor.ts` +9, `test/external-change-watch.spec.ts`
+54) — the session-start git snapshot reported "clean" but was stale; this is the human's
concurrent work. It is **complete and green** (the external-change tests pass, 12 passing;
lint clean) — NOT "half-finished" as the implement handoff guessed. I left it entirely
untouched (reverting would destroy the human's active work). The concern is **provenance**:
a coherent feature is landing un-ticketed and split across an unrelated FK ticket's commits,
and the runner will likely sweep the remaining working-tree edits into this review commit too.
Filed `tickets/backlog/external-change-watch-feature-untracked-provenance.md` so it gets a
proper ticket/review trail. No action needed for the FK fix itself.

## Reviewer notes / residual
- **Dead-arm overhead for NOT-NULL keys.** The null-safe guard is synthesized unconditionally
  (column nullability isn't consulted at synthesis), so a NOT-NULL referenced key carries two
  extra unary ops + an AND/OR per column that always resolve. These are deferred commit-time
  checks; the overhead is immaterial and the unconditional path is DRYer. Not worth a
  conditional. Noted, not actioned.
- **Build not re-run.** My change is test-only; the source was unchanged by this review (the
  implement handoff ran `yarn build` clean and lint passes). A full sequential rebuild was
  deferred as redundant.
