description: Single-source INSERT now admits a `passthrough` view column (identity-on-value transform of one base column — `b collate nocase as bc`, no-op `cast(b as <same type>) as bc`), storing the value verbatim, matching the multi-source contract. Inverse and opaque-computed columns stay non-insertable on both spines. The single↔multi INSERT insertability divergence is closed.
files: packages/quereus/src/planner/mutation/single-source.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/analysis/update-lineage.ts, packages/quereus/src/planner/building/insert.ts, docs/view-updateability.md, packages/quereus/test/logic/93.4-view-mutation.sqllogic, packages/quereus/test/property.spec.ts
----

## Summary

Both mutation spines now admit exactly `writable && inverse === undefined` for INSERT:
identity / rename and passthrough store verbatim; inverse and opaque stay non-insertable.
The single-source INSERT path (`rewriteViewInsert`) was routed through the `writableSites`
map `analyzeView` already computes (which the UPDATE SET path has consumed since the
`single-source-passthrough-column-static-dynamic-divergence` ticket), via a local
`insertableBaseColumn(name)` reader returning `site.baseColumn` iff the site's `inverse` is
absent. The implicit target set and per-target base resolution both now consult it, mirroring
multi-source (`outColumns.filter(c => c.writable && !c.inverse)`). The identity-only AST
`deriveViewColumns` model was **not** widened — its `viewColumnsFromUpdateLineage ⇄
deriveViewColumns` parity remains pinned by `test/property.spec.ts`.

The implementation is correct, complete, and the contract matches multi-source. Validation
(typecheck, 4411 passing / 9 pending, lint) is green.

## Review findings

### Checked

- **Implement diff read first, fresh, before the handoff** (`git show 4976723c`): the
  `single-source.ts` `rewriteViewInsert` rewrite, the `analyzeView` `writableSites`
  population, the `update-lineage.ts` `identityBaseColumn` doc, the `docs/view-updateability.md`
  § Scalar Invertibility prose, the property.spec.ts comment, and the full `93.4-view-mutation.sqllogic`
  test diff.
- **Contract parity (DRY / divergence-closure)**: confirmed against `multi-source.ts`
  `analyzeMultiSourceInsert` (lines 286–319). Multi-source implicit set is
  `outColumns.filter(c => c.writable && !c.inverse)` and an explicit supply of a
  non-insertable column raises `no-inverse` (line 307–314). Single-source now mirrors both
  via `insertableBaseColumn` (implicit set) and the `requireBaseColumn` fallback (explicit
  reject). The two gates are structurally parallel separate implementations over different
  analysis shapes (writableSites map vs outColumns) — that duplication is inherent to the
  two spines, not a regression.
- **Inverse / opaque explicit-insert rejection**: an inverse column (`b + 1 as bp`,
  site WITH inverse) and an opaque column (`b || '!'`, no site) both yield
  `insertableBaseColumn === undefined` and fall to `requireBaseColumn(findViewColumn(...))`,
  which raises `no-inverse` because the identity-only `deriveViewColumns` classifies them
  `computed`. Verified the `iv_v` test pins the inverse case; the opaque explicit-insert
  case is the same code path (reasoned, not separately tested — low value).
- **Implicit value-count contract change**: for a view exposing an opaque/inverse column,
  implicit `insert into v values (...)` now expects one value per *insertable* column. A
  value supplied for the omitted position reaches `buildInsertStmt` with `finalColumns`
  shorter than the VALUES source and is rejected by the explicit count check
  (`insert.ts:550`, "Column count mismatch in VALUES clause"). This is the intended,
  multi-source-matching contract; the `pt_v2` implicit test (`insert into pt_v2 values
  (4,'imp',7)`, bo omitted) pins it.
- **Duplicate-base-column hazard** (two view columns lowering to one base column — newly
  reachable because a passthrough alias of a directly-exposed base column is now
  insertable): NOT a gap. The base insert builder has an explicit guard
  (`building/insert.ts:481–503`) whose own comment names this exact "view INSERT analogue"
  — `finalColumns` with a repeated base column is rejected ("column 'X' specified more than
  once in INSERT into '<base>'"). The single-source INSERT path lacks the UPDATE path's
  `recordBaseColumn` guard, but the base builder is the (intentional) backstop, so the
  outcome is a clean rejection (the message names the base column, not the two view
  columns — pre-existing, consistent with the UPDATE-side decision).
- **Generated-column exclusion on the implicit path**: triple-defended — `!vc.generated`
  filter, a non-writable site (so `insertableBaseColumn` returns undefined anyway), and the
  base builder's "Cannot INSERT into generated column" guard. The ticket's "no targeted
  regression test" gap is real but immaterial.
- **Casing of the emitted base column** (identity columns now resolve via `site.baseColumn`
  rather than `vc.lineage.baseColumnName`): parity harness guarantees only lowercase
  equality, but every downstream comparison (`filterConstants`/`isSupplied`/contradiction,
  and the base builder's `columnIndexMap` lookup) is case-insensitive. Functionally inert,
  matching the already-shipped UPDATE SET path.
- **Tests**: happy path (explicit + implicit passthrough INSERT, single-source and
  multi-source parity `pari_*`), error path (inverse insert rejects), regression (filtered
  `pt_vf` UPDATE expectations adjusted for the 2 inserted rows), interaction (read-back
  through the view recomputes the opaque `bo`). property.spec.ts parity + PutGet tests pass
  unchanged.
- **Validation**: `yarn workspace @quereus/quereus typecheck` clean; `... test` 4411
  passing / 9 pending (memory-backed vtab); `... lint` clean.

### Found & fixed inline (minor)

- **Stale doc claim — `docs/view-updateability.md:591`**: the § Scalar Invertibility UPDATE
  paragraph still asserted the identity-only AST reader "backs single-source INSERT routing",
  directly contradicting the new "INSERT and the passthrough contract" paragraph immediately
  below it ("INSERT no longer routes through it"). The implementer updated the new paragraph
  but missed this earlier sentence. Rewrote it to: the AST reader remains only the
  `deriveViewColumns`-parity surface, while the dynamic UPDATE **and** INSERT paths read the
  richer plan-node lineage separately.
- **Stale comment — `packages/quereus/test/property.spec.ts:2542`** (the inverse-column
  PutGet test): the comment attributed the inverse column's non-insertability to the
  `deriveViewColumns` `computed` classification ("so INSERT stays inverse-blind"). Post-ticket
  that classification no longer governs insertability — INSERT reads `writableSites` and
  rejects the column because its *site carries an inverse*. The implementer updated the
  sibling passthrough test comment (2595) but left this one with the old causal framing.
  Corrected the comment to state the real mechanism.

### Major findings — none

No correctness, type-safety, resource-cleanup, or error-handling defects found. The edge
cases that looked like potential gaps (duplicate base column, implicit value-count mismatch,
generated columns) are all cleanly handled by the base insert builder, which the rewrite
correctly relies on as the single re-validation choke point. No new fix/plan/backlog tickets
were spawned.

### Known gaps accepted as-is (test-hardening only, low risk)

- No INSERT test combining a passthrough column with a selection-predicate constant-FD
  default / `default_for` tag. The append logic operates on resolved base-column names and
  is unaffected by the routing change; reasoned through, not separately tested.
- No targeted regression test that implicit INSERT skips a *generated* passthrough/identity
  column (triple-defended as noted above).
- `yarn test:store` (LevelDB store path) not run — this is an AST-level rewrite that lowers
  to an ordinary base INSERT; the store path is exercised by the same lowered statement. Flag
  for a human/CI store run if store-path confirmation of the new INSERT cases is wanted.
