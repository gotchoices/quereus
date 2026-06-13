description: Characterization + docs for the `retype`-flips-CHECK corner on the `refresh materialized view` reshape arm — the type-affinity-sensitive sibling of the recollate known-limitation. A sibling characterization-test trio (core / control / next-maintenance), a sibling docs note, and two extended code-comment cross-refs. PINS current (limitation) behavior; not a fix. Reviewed and completed.
files:
  - packages/quereus/test/maintained-table-refresh-revalidation.spec.ts     # new describe('reshape arm: type-sensitive CHECK (documented limitation)')
  - docs/materialized-views.md                                              # "Known limitation — type-sensitive CHECK on the reshape arm" note (line 221)
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts          # rebuildBacking + reshapeBackingInPlace cross-ref comments extended to name retype
----

# Reshape arm: type-sensitive CHECK known-limitation (COMPLETE)

## What this was

A sibling to the existing collation-sensitive-CHECK characterization. On the refresh
**reshape arm**, `reshapeBackingInPlace` sequences (3) `rebuildBacking` →
`validateDeclaredConstraintsOverContents` (validates + **commits**) then (4) the `retype`
op from `postReconcileOps` (same batch as `recollate`). CHECK comparisons resolve affinity
from the column's *declared* logical type; the step-3 scan runs while the catalog column
still carries the OLD type, so a CHECK whose truth flips under the retype passes, commits,
and is then retyped into a violating state. `set data type` here is **metadata-only**
(validates convertibility, does not rewrite the stored value), which is what makes the flip
affinity-driven rather than value-driven.

Three additive deliverables, all mirroring the recollate sibling: a test trio, a docs note,
and two extended code-comment cross-refs. This was scoped as characterization/documentation
— the tests PIN current behavior, they are not a fix.

## Review findings

Adversarial pass over the implement commit `986850c9`. Read the full diff with fresh eyes
before the handoff, verified the mechanism against the runtime, then ran lint + tests.

### Mechanism verified (the docs' central claim is accurate)
- The docs/comments assert "CHECK comparisons resolve their **affinity** from the column's
  declared logical type." Confirmed against `runtime/emit/binary.ts`: cross-category
  coercion is inserted **at plan time via `CastNode`s** keyed off operand (column) types
  (see the `buildGenericComparisonRun` docstring at `binary.ts:287`). So the CHECK validator
  compiled while `v` is TEXT does a same-category textual `<` (lexicographic `'10' < '9'` →
  true, passes) and a fresh comparison after the metadata-only retype compiles `v` as
  INTEGER → numeric `10 < 9` → false. The "affinity from declared type" framing is the
  correct, SQLite-conventional description of this engine's plan-time-cast implementation.
- The `vType` flip TEXT→INTEGER is a genuine guard: it proves the reshape+retype arm ran
  (the fast path would leave the type untouched), and would catch a future optimizer change
  that made the retype recompilable-in-place (the scenario would no longer be reachable).
- The `typeof(v) === 'text'` assertion correctly pins the metadata-only invariant; if
  `set data type` ever became a physical convert, the scan would catch the violation and the
  corner would close itself — that regression would surface here. Right place to pin it.

### Checked — clean
- **Tests pass.** `node packages/quereus/test-runner.mjs --grep "Maintained-table refresh
  re-validation"` → 23 passing (3 new). Full quereus suite `yarn workspace @quereus/quereus
  run test` → **6169 passing, 9 pending, exit 0** — no regressions (the implementer had only
  run the targeted grep; the full run is clean).
- **Lint passes.** `yarn lint` (eslint + `tsc -p tsconfig.test.json --noEmit`) → exit 0; no
  signature drift in spec call sites.
- **Docs note** (line 221) is structurally parallel to the collation note (line 219), states
  the metadata-only `set data type` caveat, and points at the correct spec section.
- **Code cross-refs.** Both touched comments (`rebuildBacking`'s constraint-bearing branch
  and `reshapeBackingInPlace`'s post-reconcile loop) name the `retype` analog tersely and
  point at both docs sections. No *other* site references the collation limitation that
  should also have been extended — searched.
- **Test trio is a faithful sibling**: core corner (flip + survives + metadata-only invariant
  + stale cleared), control (type-insensitive `id > 0` still rejects a `-1` drift, scoping the
  limitation to affinity-sensitive comparisons), and next-maintenance (no-delta touch frozen;
  genuine re-derivation `v=11` and fresh `insert (2,20)` both rejected under the NEW type;
  frozen row survives every case). Each assertion's value-arithmetic re-derived and confirmed.

### Minor observations — considered, no inline change
- **`vType`/`vCollation` near-duplication.** Intentional parallelism with the sibling block;
  they read different column properties. Refactoring to a shared helper would *reduce*
  readability of the deliberately-mirrored structure. Left as-is.
- **Equality/`typeof` non-flip not pinned (negative assertion).** The handoff flagged this as
  declined. I concur and add a sharper reason to *not* add it: equality is **not** uniformly
  affinity-immune — `check (v <> '010')` over a row `v = '10'` WOULD flip (TEXT `'10' <>
  '010'` true; INTEGER `10 <> 10` false). A blanket "equality stays clean" assertion would
  therefore be misleading. The `<` ordering case is the clean, unambiguous witness; the
  control test already scopes the limitation to affinity-sensitive comparisons. Adding a
  value-specific non-flip pin would risk implying a guarantee the engine does not make.
- **Boolean representation.** `select (v < '9')` returns JS `false` (`buildCmpToResult` emits
  native booleans), asserted as `{ lt: false }`. Verified against the runtime; correct.

### Disposition: characterize (current) vs. close — concur with CHARACTERIZE
The two-phase commit-first ordering plus attach-path parity make a clean fix a larger design
change that would also have to touch the attach reshape path; re-validating after the retype
would throw with rows already committed and the schema mutated (a worse state than the open
limitation, with no path back to pre-refresh contents). That is exactly the recollate
sibling's rationale and it holds here. Closing the corner is out of scope for this
characterization ticket and was **not** spawned as a new fix/plan ticket — it is a documented,
blast-radius-bounded limitation (ordinary writes cannot propagate it; the row-time validator
rejects any genuine re-derivation under the new type), not a defect needing remediation. If a
future maintainer decides to close it, that is a deliberate new design ticket touching both
the refresh and attach reshape arms.

### Deferred (tracked elsewhere, not a finding)
- **Store-path coverage.** Memory-backed only here; `yarn test:store` not run. Store parity
  for this engine-level corner is tracked by `maintained-table-refresh-revalidation-store-
  parity` (the recollate sibling made the same call). No new ticket needed.

## Major findings → new tickets
None. The implementation is faithful, the mechanism is correctly characterized, docs and
comments reflect the new reality, and lint + the full test suite are green.
