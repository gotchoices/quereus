description: Preserved-keyed RETURNING re-query for outer-join non-preserved UPDATEs — `buildMultiSourceUpdateReturning` keys preserved sides by exact PK equality and non-preserved sides by a matched-OR-null disjunction, so materialized null-extended rows (and preserved-side updates touching null-extended rows) surface; the plan-time `returning-through-view` reject in `decomposeUpdate`'s non-preserved-column branch was removed.
files: packages/quereus/src/planner/mutation/multi-source.ts, docs/view-updateability.md, packages/quereus/test/property.spec.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic
----

## What landed

The post-mutation RETURNING re-query for a multi-source (join) UPDATE now builds its
identity EXISTS **per side**: a *preserved* side matches by exact per-PK-column equality;
a *non-preserved* (outer-join null-extended) side matches by a `(exact) OR (all captured
PK cols null)` disjunction. The null branch identifies a freshly-materialized null-extended
row (whose non-preserved PK was captured NULL) by its preserved-side equalities alone,
instead of dropping it on a `NULL = <minted pk>` match. It also recovers a preserved-side
update touching a still-null-extended row (latent partial-set bug). The plan-time
`returning-through-view` reject in `decomposeUpdate`'s non-preserved-column branch was
removed; the **existence-flag** RETURNING reject and the FULL-join rejects were left intact.

Implemented in `multi-source.ts` (`buildMultiSourceUpdateReturning` ~line 1996,
`decomposeUpdate` ~line 1435), with docs in `docs/view-updateability.md` and coverage in
`property.spec.ts` (LEFT `npv` + RIGHT `rnpv`) and `93.4-view-mutation.sqllogic` (`ojrv`).

## Review findings

**Scope of review.** Read the implement diff (`37c1ead7`) first, then the surrounding
`multi-source.ts` machinery (`buildMultiSourceKeyCapture`, `capturedValueSubquery`,
`buildCapturedKeyPredicate`, `requireKeyColumns`, `combineAnd`, the `JoinSide.preserved`
classification in `collectJoinSources`), the AST operator spellings, the docs section, and
both test files.

**Correctness (verified, no defect).**
- *Three-valued disjointness.* For the supported & reachable shapes (2-way INNER / LEFT /
  RIGHT; RIGHT is the mirror keyed off `JoinSide.preserved`, not source order), the
  matched/null branches are provably disjoint: a non-null captured np PK takes the matched
  branch (`null` IS NULL is false), a captured-null np PK fails the matched equality
  (`null = x` is not-true) and takes the null branch. The null branch identifies by the
  **preserved** PK alone, which is unique per join row, so it can neither over-match a
  different preserved row nor produce duplicates (EXISTS is existential; the re-query is a
  single Filter over the post-mutation join). Walked the materialization, matched, null-key
  no-op, mixed-batch, and shared-partner (preserved-column) fan-out cases by hand against
  the built AST — all sound.
- *Inner-join parity.* For an all-preserved join every side reduces to exact equality and
  the per-side grouping is structurally identical to the prior flat AND-chain — inner-join
  RETURNING is unchanged (confirmed against the existing `rjoin`/multi-source specs, green).
- *AST idioms.* `IS NULL` (unary) and `OR` (binary) spellings, and the `reduce(combineAnd)!`
  non-null assertions, match existing patterns and are safe — `requireKeyColumns` guarantees
  ≥1 PK column per side and `analysis.sides` has ≥2 entries, so no empty-array reduce.
- *Preserved exclusions intact.* The existence-flag (`set hasB = …`) RETURNING reject stays
  (still tested at `property.spec.ts:5310`); `set hasB = false` deletes the matched
  partition and is genuinely unrecoverable, so the uniform existence reject is the right call
  even though `set hasB = true` would now be recoverable in principle.

**Tests.** The implementer's coverage is thorough: matched-only, null-extended
materialization, null-key no-op, mixed batch, `returning *`, GetPut idempotence,
preserved-side-update-touching-null-extended-row, and a fan-out (no-sibling-leak) — mirrored
LEFT and RIGHT. Happy path, edge cases (null key, materialization), regression
(inner-join), and idempotence are all exercised. Full suite re-run during review:
**5287 passing, 9 pending, 0 failing**; `lint` and `typecheck` clean.

**Minor — fixed inline.** The `docs/view-updateability.md` § `returning` section header
still read "**Multi-source** inner-join `update` / `delete`" / "spans both base tables",
which the update bullet's outer-join coverage had outgrown. Reworded to "(n-way join)" /
"spans multiple base tables".

**Major — filed as backlog ticket.** The non-preserved-**column** update **fan-out**
(updating a non-preserved column across multiple preserved rows that share one
non-preserved partner) fails at the base op with "Scalar subquery returned more than one
row". Confirmed the mechanism by reading `capturedValueSubquery` (a scalar read correlated
by the non-preserved PK becomes multi-valued when a partner is shared). This is
**pre-existing and orthogonal** to this ticket — it fails with or without RETURNING, and
predates the RETURNING re-query work — so per the implementer's flag it was filed as
`tickets/backlog/view-write-outer-join-nonpreserved-fanout-update.md` rather than blocking.
The implementer's fan-out RETURNING test correctly sidesteps it by updating a preserved
column, which still proves the re-query identity (no unselected sibling leaks).

**No other findings.** No SPP/DRY/type-safety/resource-cleanup/error-handling issues: the
change is a localized, allocation-free AST rewrite reusing existing helpers; no new
substrate, no new error paths beyond the removed reject. Docs read and confirmed current.

## Known limitations (carried forward, documented)

- An update that changes a **base PK** or the **join-key / FK** column breaks the captured
  identity and drops that *matched* row from RETURNING (these columns are generally not
  writable through the supported shapes).
- Non-preserved-column update **fan-out** over a shared partner →
  `view-write-outer-join-nonpreserved-fanout-update` (backlog).
- Existence-flag `set hasB = …` RETURNING, FULL-outer write-through + its RETURNING, and
  multi-source INSERT RETURNING remain rejected (`returning-through-view`).
