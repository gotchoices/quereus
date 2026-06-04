description: n-way generalization of the multi-source inner-join write-through substrate — 2-table/single-column-PK cap lifted to n-way (≥2) inner equi-joins, composite-PK identification, and self-joins, for update/delete/insert. Reviewed; one correctness bug (n-way DELETE FK ordering) found and fixed inline.
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/planner/nodes/view-mutation-node.ts, packages/quereus/src/func/builtins/schema.ts, packages/quereus/test/property.spec.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, docs/view-updateability.md
----

## What landed (implement → review)

The multi-source write-through substrate (`multi-source.ts`) was lifted from a hard cap of
**two distinct base tables, single-column PK per side** to an **n-way (≥2) inner equi-join**
path that also admits **composite-PK sides** and **self-joins** (one base table under ≥2
distinct aliases), for `update` / `delete` / `insert`. The generic shape threads
`readonly JoinSide[]` (length ≥2) end to end; routing is keyed by side index `0..n-1`.

Core mechanics (verified during review):
- `JoinViewAnalysis.sides` is `readonly JoinSide[]`; the identity capture projects one column
  **per side per PK column** (`k<side>_<j>`, `keyColumnName`), and per-side identification is a
  **correlated EXISTS** matching all PK columns (`buildCapturedKeyPredicate`).
- **Self-join enumeration** (`resolveSourceTableRef`) maps each AST source's *alias* to its
  planned `TableReferenceNode` by resolving the alias-qualified PK column through the join's
  combined scope → attribute id → owning ref (an `attrId → TableReferenceNode` inversion), **not**
  by table name. Column→side routing is id-driven (`sideByTableId`).
- **n-way side ordering** is an FK topological sort (`orderSides`, parent before child; self-join
  mutual edges cycle-break to alias-declaration order).
- Static surfaces (`isDecomposableJoinBody` in `schema.ts`) widened to agree with the wider
  dynamic acceptance so `view_info` / `column_info` stay in sync.

## Review findings

**Process:** read the full implement diff (commit `c278131f`, `multi-source.ts` +726 plus the
builder / node / schema / docs / tests) with fresh eyes *before* the handoff summary, then
adversarially probed every gap the implementer flagged as untested. Note: the branch has moved
on past this ticket (outer-join, cross-source-`set`, and projection-filter rewrite commits landed
on top), so review ran against the current tree, focusing findings on the n-way change itself.

### Checked — every aspect angle
- **Correctness / SPP / DRY / modularity:** the `JoinSide[]` threading, `keyColumnName` /
  `requireKeyColumns` composite-key shape, alias-keyed routing, and the attribute-id-inversion
  self-join enumeration are sound and well-decomposed. The correlated-EXISTS correlation shape is
  reused across the per-side capture, the UPDATE-RETURNING re-query, and the cross-source read
  (one pattern, not three). No DRY or layering regressions spotted.
- **Type safety:** no `any`; `yarn workspace @quereus/quereus typecheck` clean.
- **Error handling / resource cleanup:** structured diagnostics on every reject path; a keyless
  side, a composite shared-key insert, and a chained-key insert all raise precise reasons (no
  silent widen). No leaked plan state — the capture is materialized once, descriptor-shared.
- **Lint:** `yarn workspace @quereus/quereus lint` clean.
- **Tests:** full suite passes **4626 / 0 failing** on a clean tree (one unrelated external
  failure — see below); the 21 multi-source round-trip property tests (incl. composite-PK,
  n-way, self-join) and the `93.4` / `93.2` / `06.3.4` / `06.3.5` sqllogic suites all green.

### Adversarially probed the three flagged-untested gaps
- **n-way star INSERT** — *works* (verified directly): shared key both supplied **and** minted
  from the anchor's declared `default`, threaded into all members FK-parent first. **Added a
  permanent positive regression** (`93.4`, view `axi_v`, minted-key 3-table star insert under FK
  enforcement). Chain inserts and composite shared-key inserts reject correctly
  (`unsupported-decomposition-key`).
- **n-way DELETE fan-out** — **FOUND A CORRECTNESS BUG (fixed inline).** The n-way (>2) delete
  fan-out ordered base deletes by `orderSides` = **FK-parent before FK-child**. Under FK
  enforcement (the default in many setups, incl. the `93.4` sqllogic suite) this trips the
  children's inbound RESTRICT/NO-ACTION and **aborts the whole statement** — on the canonical
  columnar-split shape, which is the exact `n3v` shape the new property test uses. The property
  test masked it with `pragma foreign_keys = false`. **Fix:** delete in **reverse** FK-topological
  order (FK-child before FK-parent), which is unconditionally FK-safe for both RESTRICT and
  CASCADE; single-side deletes reverse a one-element order (no-op); mutual-FK cycles still defer
  wholesale to the runtime RESTRICT pre-check. Updated the `decomposeDelete` comment and the
  `docs/view-updateability.md` two-side-only note. **Added a permanent regression** (`93.4`, view
  `axd_v`, 3-table columnar-split delete under FK enforcement).
- **Composite shared-key / chain insert** — reject correctly with `unsupported-decomposition-key`.
  (Handoff predicted `unsupported-join` for a chain; in practice a chain forces the middle table to
  contribute a composite shared key, so `unsupported-decomposition-key` fires — still a clean
  reject, only the predicted label differed. No action needed.)

### Reviewed — acceptable, no change
- **Self-join updating a PK column** (`rj_self set cc2 = 9`): works. The capture pins the
  pre-image, so the base op finds the row by old PK and rewrites it; the documented
  "PK change drops the row from RETURNING" applies only to the post-mutation RETURNING re-query
  (rj_self has none). Consistent with the docs.
- **`effective_targets` self-join collapse** to one base name in `view_info`: correct — a
  self-join genuinely targets one physical table under two roles; the dynamic path still routes by
  two distinct scans.
- **Composite-PK partial-key predicate fan-out** (`where c1 = 1` on PK `(c1,c2)` binds every
  matching composite row): the predicate-honest reading, already pinned in `93.4`.
- **n-way / both-sides UPDATE ordering** stays parent-first: updates of non-key columns have no FK
  ordering hazard, and the FK-on `ax_three` n-way update passes. Out of scope to change.

### Major findings filed as new tickets
None. The one correctness bug found was a small, safe ordering fix (a `.reverse()` with
regression coverage) — fixed inline rather than deferred.

### Out of scope / external (flagged, not chased)
- `test/logic/44.1-nondeterministic-schema.sqllogic:262` fails on a DEFAULT bare-column-reference
  **error-message wording** mismatch. This is caused by a **separate uncommitted changeset in the
  working tree that this ticket did not author** (`src/planner/building/insert.ts`,
  `src/schema/manager.ts`, `03.4-defaults.sqllogic`, `44.1`, `46-mutation-context.sqllogic`;
  116 insertions — a concurrent agent's DEFAULT-column-reference work, corroborated by a stray
  `packages/quereus/fulltest_run.log`). Proven independent: stashing the **entire** working tree
  passes 4626 / 0 failing. Documented in `tickets/.pre-existing-error.md` for the triage pass.

## Deferred (unchanged, documented scope boundaries)
- n-way DELETE **ON-DELETE-aware** ordering and the plan-time `mutual-fk-restrict-delete` reject
  stay **two-side only**; n-way (>2) uses the (now reverse) FK-topo order and defers mutual-FK
  cycles to the runtime RESTRICT pre-check.
- Composite **shared-key insert**, outer-join bodies, and `select *` join bodies stay rejected
  with their precise diagnostics.

## Validation performed (review)
- `yarn workspace @quereus/quereus typecheck` — clean.
- `yarn workspace @quereus/quereus lint` — clean.
- `yarn workspace @quereus/quereus test` — **4626 passing, 9 pending** on a clean tree; the only
  failure with the full working tree is the external 44.1 DEFAULT-wording case above.
- Targeted: `93.4-view-mutation.sqllogic` (incl. the two new n-way FK regressions) and the 21
  multi-source round-trip property tests all pass.
