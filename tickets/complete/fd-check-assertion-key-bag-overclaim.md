description: Gated CHECK-derived and assertion-hoist-derived bi-directional value-equality FDs (`{a}↔{b}`) at the `TableReferenceNode` consumption site so they fold onto a non-keyed table's physical FDs only when an endpoint is a genuine declared key — closing the 5th (CHECK) and 6th (assertion-hoist) producers of the FD-derived-key bag-over-claim wrong-results bug. Mirrors the shipped filter-site gate (site 4) from `fd-derived-key-bag-overclaim`.
files: packages/quereus/src/planner/nodes/reference.ts, packages/quereus/test/fd-derived-key-bag-overclaim.spec.ts, packages/quereus/test/optimizer/binding-extractor.spec.ts, packages/quereus/test/optimizer/check-fold-gated-by-capability.spec.ts, docs/optimizer.md
----

## What shipped

`TableReferenceNode.computePhysical` (`reference.ts`) now folds `checkExt.fds` and
`hoisted.fds` through a new module-local gate `foldGatedProducerFds(fds, producerFds,
equivPairs, realKeyFds, colCount)`. The gate **skips** an unguarded single↔single FD
`{a}→{b}` whose unordered pair is in the producer's `equivPairs` **unless**
`isSuperkey([a]) || isSuperkey([b])` against `realKeyFds` (an immutable snapshot of the
PK/UNIQUE-derived FDs captured immediately after the declared-key loop). Everything else
folds unchanged: `∅→col` constant FDs, one-way `other→col` expression FDs, and guarded
implication-form FDs. The EC merge stays unconditional; checkExt-before-hoisted folding
order is preserved for provenance.

This prevents a `check (a = b)` (or equivalent hoisted `not exists (select 1 from T where
a <> b)`) on a non-keyed table from emitting `{a}↔{b}`, which `deriveKeysFromFds` would
otherwise read as a phantom unique key once a projection narrows the relation to the
equality columns — leaking duplicate rows past a dropped DISTINCT.

End-to-end repros + controls landed as sites 5 (CHECK) and 6 (assertion-hoist) in
`test/fd-derived-key-bag-overclaim.spec.ts`; goldens in `binding-extractor.spec.ts` and
`check-fold-gated-by-capability.spec.ts` were updated from the old over-claiming
expectation to the gated one. The implement stage also filed
`tickets/fix/fd-guarded-activation-key-bag-overclaim.md` for a 7th (guarded-activation)
producer it confirmed but left out of scope.

## Review findings

**Verdict:** implementation is correct and sound for its stated scope (the *bi-directional*
value-equality producer). One **MAJOR** adjacent wrong-results bug of the same class was
confirmed and filed; one **MINOR** doc-staleness was fixed inline. Lint clean, full suite
green (5517 passing, 9 pending, 0 failing).

### Checked

- **Diff read fresh before the handoff.** Re-derived the gate logic from `reference.ts`,
  `filter.ts` (the mirrored site 4 gate), `check-extraction.ts` `handleEquality`, and
  `fd-utils.ts` `addFd` / `isSuperkey` / `isUnique`.
- **`equivPairs` ⟺ bi-FD claim (1:1):** verified at `check-extraction.ts:172-178` —
  `handleEquality` pushes an equiv pair iff both sides are columns (`col = col`), the same
  branch that emits both `{a}→{b}` and `{b}→{a}`. Holds for the CHECK and (via shared
  `extractCheckConstraints`) the hoisted path. Confirmed empirically (site 6 passes).
- **`realKeyFds` snapshot soundness:** captured at `reference.ts:192`, before any CHECK /
  partial-unique / hoisted fold; `addFd` returns a fresh array and never mutates input, so
  the snapshot stays pinned to declared-key FDs. Using declared-keys-only (not checkExt- or
  partial-unique-derived) is the conservative/sound probe, consistent with the filter gate's
  `inputFds`.
- **`addFd` does not compute transitive closure** (`fd-utils.ts:240-273`, subsumption only),
  so no transitive single↔single FD escapes the gate.
- **Transitive multi-equality edge** (`check (a = b and b = c)` on a non-keyed table, project
  to `(a,b)`): each direct bi-FD is gated; verified empirically the DISTINCT survives (2 rows,
  1 DISTINCT node).
- **Guarded FDs** (`guard !== undefined`) correctly pass through (the gate's `guard === undefined`
  precondition + `computeClosure`/`deriveKeysFromFds` skipping guards).
- **Capability cap:** `permitsGrandfatheredCheckViolators` still empties `checkExt`; hoisted
  remains independent; EC merge unconditional — all preserved.
- **Lint + tests:** `yarn workspace @quereus/quereus lint` clean; full memory suite
  **5517 passing, 9 pending, 0 failing**, including the `property.spec.ts` "Key Soundness"
  over-claim differential. (`test:store` not run — pure planner logic, no store path touched.)

### Found — MAJOR (filed, not fixed in this pass)

- **One-way determination FD `a→b` over-claims the same phantom key (wrong results).**
  `check (b = a + 1)` (or hoisted `not exists (… where b <> a + 1)`) emits a *one-way*
  single↔single FD with **no** equiv pair, so `foldGatedProducerFds` — which gates only on
  `equivPairs` membership — folds it ungated. `select distinct a, b` over a non-keyed table
  then re-derives `{a}` as a phantom all-columns key (`isUnique` closure branch,
  `fd-utils.ts:840`) and drops the DISTINCT. **Confirmed repro: 3 rows instead of 2, DISTINCT
  eliminated.** This is pre-existing (the FDs folded unconditionally before this ticket), the
  same bag-as-set class, and the implement stage explicitly *preserved* the one-way FD as
  correct (`check-derived-fds.spec.ts:275` regression guard, ticket gap #4). The filter gate
  (`filter.ts:114-126`) does **not** have this hole because it gates *every* single↔single FD
  regardless of `equivPairs`; the table-reference gate diverged by adding the `equivPairs`
  condition. Filed as `tickets/fix/fd-oneway-determination-key-bag-overclaim.md` with the
  repro, full mechanism, two fix directions (broaden the gate to match the filter — recommended,
  and it simplifies/DRYs the helper — vs a reader-side `isUnique` fix), and validation plan.
  Out of scope here: this ticket scoped itself to the *bi-directional* shape, and the fix
  requires reversing a documented design decision + a multi-test sweep.

### Found — MINOR (fixed inline)

- **`docs/optimizer.md` was stale.** The `FilterNode` / `ProjectNode` / `JoinNode` rows all
  document their over-claim gates with the ticket reference, but the `TableReferenceNode` row
  (and the *Check-derived contributions* table's `col1 = col2` row) did not mention the new
  sites 5/6 gate. Updated both to describe the bi-FD gating (and the always-merging EC), noted
  the assertion-hoist contribution on the TableReference row, and annotated the `col = <expr>`
  (single-col RHS) row with a "Known over-claim" pointer to the new one-way fix ticket so the
  doc reflects current (buggy) reality.

### Not found / not changed (with reason)

- **`isUnique` closure branch** (`fd-utils.ts:840`) left unchanged — it is sound by construction
  for the bi-directional table-reference path once the over-claim is kept out of the FD set at
  the producer. (It is the soundness-critical reader the one-way and guarded-activation fix
  tickets must re-examine.)
- **Sibling fix ticket `fd-guarded-activation-key-bag-overclaim` verified accurate:**
  independently reproduced the guarded-activation wrong-results bug (DISTINCT eliminated, 3 rows
  vs 2) and confirmed the mechanism it describes matches `filter.ts` (the activation gate at
  `114-126` only covers `predFds`, not activated FDs). Different node / code path — correctly
  deferred, left to flow.
- **No new test-altitude gaps for the shipped scope:** sites 5/6 assert DISTINCT-node presence +
  materialized row counts (the wrong-results floor); the `check-fold-gated-by-capability` golden
  covers the physical-FD-set surface. Adequate.
