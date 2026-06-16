description: Multi-source (inner-join) INSERT σ (where-clause) constant-FD defaulting — lift the join body's `col = literal` selection constants as per-side insert-defaults so an omitted σ-constrained column is supplied its σ value (inserted row visible through the view), and an explicit contradicting value rejects at plan time. Brings the multi-source insert path to parity with the single-source spine. REVIEWED.
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, docs/view-updateability.md, packages/quereus/test/logic/93.4-view-mutation.sqllogic, packages/quereus/test/logic/93.6-set-op-flagless-write.sqllogic
----

## What landed

The multi-source inner-join INSERT envelope (`analyzeMultiSourceInsert` /
`buildMultiSourceInsert`) consults the join body's `where` for `column = literal`
equality constants and lifts them as **per-side constant-FD insert-defaults** — the
side-aware analog of the single-source `extractFilterConstants` →
`collectAppendedDefaults` path. An omitted σ-constrained column is now defaulted to its
σ constant (row **visible** through the view) instead of landing at base default / NULL
(row written but invisible); an explicit value contradicting a σ constant rejects at
plan time with `predicate-contradiction`.

Three pieces (`multi-source.ts`): `extractJoinFilterConstants` lifts each `column =
literal` conjunct, resolving its owning side via `resolveColumnSide` and canonical base
name via `columnByName`; `checkJoinFilterContradiction` (mirror of single-source
`checkContradiction`) rejects a supplied VALUES cell that contradicts a σ constant
(matched on the resolved **base** column, so renames are covered); and a `sigmaDefaults`
field on `MsInsertSide` carries `{baseColumn, valueExpr}` for omitted columns, folded
into the covered set before `assertNoMissingNotNull`. The build appends one constant
projection per σ-default onto the side's `ProjectNode` (riding the projection, not the
VALUES rows, so it also supports a **SELECT** source). No new diagnostic codes; no
envelope-shape changes. Reuses `predicate-contradiction`.

See the implement commit `f7e1e2bf` for the full diff.

## Review findings

Adversarial pass over the implement-stage diff (`f7e1e2bf`), read with fresh eyes before
the handoff summary. Aspect angles scrutinized: SPP/DRY (parity with single-source
spine), modularity, type safety, error handling, resource cleanup, edge/error/regression
coverage, doc accuracy.

### Verified correct (checked, no action)

- **Parity with the single-source spine.** `extractJoinFilterConstants` /
  `checkJoinFilterContradiction` are faithful side-aware analogs of single-source
  `extractFilterConstants` / `checkContradiction` (`single-source.ts:670,1106`) — same
  AND-flatten, same `column = literal`-only lift, same `value instanceof Promise ⇒
  undefined ⇒ unprovable` guard, same `sqlValuesEqual` contradiction test, same
  `predicate-contradiction` diagnostic. DRY by analogy; helper reuse
  (`resolveColumnSide`, `columnByName`, `flattenAnd`) is consistent with the existing
  cross-source/join-correlation paths.
- **Build-side projection/column ordering alignment.** Both the projection array and the
  side insert's `columns` are built as `[...targetColumns, ...sigmaDefaults]`
  (`view-mutation-builder.ts:588-625`), so `projection[i] ↔ columns[i]` for every i. The
  σ-default projection is a compiled constant (`buildExpression`) over no columns, so the
  side scope is irrelevant.
- **Contradiction-check index alignment (the handoff's flagged concern) — HOLDS,
  including the implicit-column-list path.** `checkJoinFilterContradiction` keys the
  VALUES cell by the supplied-array index, which must equal the VALUES tuple index because
  `assertSourceArity` (`view-mutation-builder.ts:1004`) rejects any source whose arity ≠
  `supplied.length`. For an implicit column list, `suppliedNames` is the base-routed
  non-inverse output columns *in output order*; a view with any computed/inverse/existence
  column in its output would make the user's full-width implicit VALUES fail arity, so the
  reachable implicit-list case has `supplied` 1:1 positionally aligned with the VALUES
  tuple. Alignment is sound.
- **Doc accuracy.** Read every touched doc paragraph. `docs/view-updateability.md` §
  Inner Join — Inserts and § Outer Joins — Inserts reflect the new behavior; the added
  cross-reference anchor `#selection-σ` resolves to the existing `### Selection (σ)`
  heading (line 113). `93.6` JV fixture note rewritten correctly (the join leg's
  `where jv1.color='red'` IS now consulted; row now visible through JV).
- **Active-side scope / outer-join residual.** The σ-default applies to any active side
  and is never added to `presenceGateIndices`, so it cannot make an absent optional side
  "present"; a preserved-only insert leaves the non-preserved σ side inactive (no default,
  invisible-but-succeeds row) — the documented structural residual, covered by fixture σ4.

### Found + fixed inline (minor)

- **Coverage gap: multiple σ-defaults on one side was untested.** Every implementer
  fixture (σ1–σ4) had at most one σ-default per side, so the build loop's repeated
  projection push and the multi-element `columns` spread (`[...targetColumns,
  ...sigmaDefaults.map(...)]`) were never exercised, nor was `assertNoMissingNotNull`
  covering *two* NOT-NULL-without-default columns at once. Added fixture **(σ5)** to
  `93.4-view-mutation.sqllogic`: two σ-constrained, projected-away, NOT-NULL-no-default
  columns (`color`, `region`) on one side, both defaulted, row visible. Passes.

### Observations (documented, no action — degenerate/unreachable)

- **σ on the shared join key — minor asymmetry vs single-source, but degenerate.** The
  σ-default loop skips `keyColumns[sideIndex]` (the EC/key thread owns that value), so
  `where sharedkey = 5` with a **minted** key produces a row whose key is the minted
  default (not 5) ⇒ invisible — whereas single-source `where pk = 5` would default `pk`
  to 5. The contradiction check does *not* skip the key, so a **supplied** contradicting
  key still rejects, and a supplied matching key is visible. The gap is therefore only the
  minted-and-pinned case, which is genuinely degenerate (pinning a surrogate shared key to
  a literal forces every inserted row to collide on one key value). The implementer's
  inline comment already calls a σ on a join key "degenerate"; left as-is.
- **The `resolveColumnSide → undefined` (ambiguous/unresolved) branch is defensive and
  effectively unreachable from a valid view body.** An unqualified σ column ambiguous
  across sides, or a qualifier matching no side, is rejected at body planning
  (`analyzeJoinView`) before `extractJoinFilterConstants` ever runs. The handoff suggested
  a fixture for it; none is constructable through a planned view, so the conservative skip
  stays as unreachable defensive code (no fixture added — it would not compile to a
  reachable state).
- **Non-literal / non-equality σ (`col = :p`, `col = col`, `qty > 0`) not lifted** —
  parity with single-source, by design. Multiple σ conjuncts on the *same* column with
  divergent literals dedup to the first (the view predicate is contradictory ⇒ always
  empty anyway). No negative fixture added (asserts a non-feature; same single-source
  posture).

### Validation

- `yarn workspace @quereus/quereus test` — **6318 passing, 0 failing, 9 pending** (full
  suite, after adding σ5). Exit 0.
- `yarn workspace @quereus/quereus test --grep "93.4-view-mutation"` — passing (σ5
  included).
- `yarn workspace @quereus/quereus lint` — clean (eslint + test-file tsc, exit 0). The
  test-file tsc pass also covers `src` signature drift.

No major findings; no new tickets filed. The single inline fix (σ5 fixture) is committed
with this stage.
