description: Review the multi-source (inner-join) INSERT σ (where-clause) constant-FD defaulting — the join body's `col = literal` selection constants are now lifted as per-side insert-defaults so an omitted σ-constrained column is supplied its σ value (the inserted row satisfies the view predicate and is visible through the view), and an explicit value contradicting a σ constant rejects at plan time. Brings the multi-source insert path to parity with the single-source spine.
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, docs/view-updateability.md, packages/quereus/test/logic/93.4-view-mutation.sqllogic, packages/quereus/test/logic/93.6-set-op-flagless-write.sqllogic
difficulty: medium
----

## What landed

The multi-source inner-join INSERT envelope (`analyzeMultiSourceInsert` /
`buildMultiSourceInsert`) now consults the join body's `where` for `column = literal`
equality constants and lifts them as **per-side constant-FD insert-defaults** — the
side-aware analog of the single-source `extractFilterConstants` → `collectAppendedDefaults`
path. This closes the pre-existing correctness asymmetry the ticket pinned: an omitted
σ-constrained column used to land at base default / NULL (row written but **invisible**
through the view); it is now defaulted to the σ constant (row **visible**, matching the
single-source path).

### Implementation (3 pieces)

1. **`extractJoinFilterConstants(where, sides)`** (`multi-source.ts`, near
   `extractJoinKeyColumns`) — flattens `where` on AND, keeps `column = literal` conjuncts,
   resolves each column to its owning join side via `resolveColumnSide` (alias-qualified AND
   unqualified; ambiguous/unresolved → skipped conservatively) and to its canonical base
   name via `columnByName`. Only **literal** RHS lifted (parameters / `col = col` /
   non-equality skipped — parity with single-source). Returns `{sideIndex, baseColumn,
   valueExpr, value}`.

2. **Routing in `analyzeMultiSourceInsert`** —
   - *Supplied-and-contradicting → reject:* a new `checkJoinFilterContradiction` (mirror of
     single-source `checkContradiction`) rejects `predicate-contradiction` when a VALUES
     literal cell ≠ the σ constant. Matched by resolved **base** column, so a *renamed* view
     column is covered. Unprovable (non-literal cell, parameter, SELECT source,
     `value === undefined`) ⇒ skipped.
   - *Not-supplied, owning side active → default:* a new `sigmaDefaults?` field on
     `MsInsertSide` carries `{baseColumn, valueExpr}`. Skips the shared join key
     (`keyColumns[sideIndex]`) and supplied columns. Run **before**
     `assertNoMissingNotNull`, with σ-default columns folded into the covered set (a σ
     default legitimately satisfies a NOT-NULL-without-default base column).
   - *Not-supplied, owning side inactive → skip:* an inactive (preserved-only) side never
     reaches the spec loop, so it gets no default — documented structural residual.

3. **Build (`buildMultiSourceInsert`)** — appends one constant projection per
   `side.sigmaDefaults` entry (`buildExpression(ctx, valueExpr) as ScalarPlanNode`, alias =
   baseColumn) onto the side's `ProjectNode`, and appends the base column to the side AST
   insert's `columns`. The base-table builder then coerces/constrains it exactly as a
   single-source appended-VALUES cell. Because the constant rides the projection (not the
   VALUES rows), this also supports a **SELECT-source** insert — an intentional capability
   gain over single-source (which defers σ-defaulting for SELECT sources).

No new diagnostic codes (reuses `predicate-contradiction`); no envelope-shape changes
(σ defaults bypass the envelope — they are per-row constants, not envelope columns).

## Validation done

- `yarn workspace @quereus/quereus test` — **6318 passing, 0 failing, 9 pending**.
- `yarn workspace @quereus/quereus lint` — clean (eslint + test-file tsc).
- `yarn workspace @quereus/quereus typecheck` (src `tsc --noEmit`) — clean.

### Test coverage added (the floor — treat as a starting point)

`93.4-view-mutation.sqllogic`, new σ-defaulting section (between the multi-parent reject and
the SUPPLIED-shared-key block):

- **(σ1)** the repro — σ on a **projected-away** column (`color`), key supplied ⇒ `color`
  defaulted, row visible through the view. Plus a **SELECT-source** variant (`insert … select
  11,110`) proving the capability gain.
- **(σ2)** σ on a **projected** column: supplied-matching ⇒ succeeds (idempotent);
  supplied-contradicting ⇒ `predicate-contradiction`; **multi-row** contradiction (2nd row
  contradicts) ⇒ rejected, nothing inserted.
- **(σ2b)** a **renamed** σ column (`color as hue`): contradiction matched on the base
  column, not the view spelling; matching value succeeds.
- **(σ3)** σ over a **minted** shared key: a σ-constrained non-key, non-projected `tier`
  (NOT NULL, no default) on the anchor side is defaulted while `rid` is still minted from the
  anchor high-water default — also exercises the σ-default-covers-NOT-NULL coverage path.
- **(σ4)** LEFT outer join with σ on the **non-preserved** side: both-side insert (side
  active) ⇒ σ default applies, row visible; preserved-only insert (side inactive) ⇒ no
  default, row null-extended/invisible but the insert **succeeds** (the documented residual).

`93.6-set-op-flagless-write.sqllogic` (the JV set-op join-leg fixture): the join leg's
`where jv1.color='red'` IS now consulted on insert — changed the expected `jv1` row from
`(5,50,null)` to `(5,50,'red')`, rewrote the "σ NOT consulted" note, and added a positive
`select * from JV` showing the inserted `(5,50,'a')` row now appears through the view.

Docs: `docs/view-updateability.md` § Inner Join — Inserts (the lift rule + contradiction +
active-side scope + SELECT-source gain, cross-ref to § Selection), § Outer Joins — Inserts
(the non-preserved-side preserved-only residual).

## Gaps / boundaries a reviewer should scrutinize

- **Ambiguous / unresolved σ column not directly tested.** `extractJoinFilterConstants`
  skips a conjunct whose column resolves to no side or to ≥2 sides (`resolveColumnSide →
  undefined`). The behavior is exercised indirectly (parity with `joinCorrelatesMutualFk`),
  but there is no dedicated fixture for "unqualified σ column present on two sides ⇒ no
  default." Worth adding if you want it pinned.
- **ON-clause constants are explicitly out of scope** (`a left join b on a.id=b.id and
  b.k='x'`). Only `sel.where` is consulted — these are join-match semantics, not a post-filter
  σ. Untested by design; a follow-up if a use case needs it.
- **Non-equality / non-literal σ** (`qty > 0`, `color = other_col`, `color = :p`) is not
  lifted (parity). No negative fixture asserts "such a column omitted yields an invisible
  row" — same single-source limitation, left implicit.
- **σ4 outer-join shape under FK enforcement.** The σ4 fixture runs with `pragma
  foreign_keys = false`. The both-side insert's key gate / presence gate interaction with a
  σ-defaulted non-preserved side was reasoned through (σ default is a constant projection, NOT
  added to `presenceGateIndices`, so it never makes an absent optional side "present") but not
  re-tested with FK on. The minted parent does exist for the present row, so FK-on should be
  fine — worth a confirming pass.
- **Contradiction index alignment.** `checkJoinFilterContradiction` keys the VALUES cell by
  the `supplied[]` index, which equals the envelope/VALUES column index (asserted by
  `buildEnvelopeSource` arity). This holds for explicit column lists; the implicit-column-list
  path (`insert into V values (…)` with no column names) reuses the same `supplied` indexing
  the existing envelope already relies on — verify the reviewer agrees the alignment holds
  there too (no implicit-list σ fixture was added).
- **Existence / authored columns:** σ defaults target distinct base columns via `where` and
  are independent of existence-directive / authored-put handling (distinct base columns by
  construction). No interaction expected; not separately fuzzed.

## How to re-run

```
yarn workspace @quereus/quereus test --grep "93.4-view-mutation|93.6-set-op-flagless"
yarn workspace @quereus/quereus test     # full suite
yarn workspace @quereus/quereus lint
```
