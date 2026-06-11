----
description: Authored-inverse (`with inverse`) write path — build-time validation, lineage upgrade to a writable `authored` UpdateSite, single-source UPDATE/INSERT + multi-source UPDATE lowering, view_info/column_info parity, ALTER RENAME propagation, lens-merger carry-through. Reviewed; written-row binding, column-list INSERT bridge, aggregate rejection, window-operand validation, and star-projection rename fixes applied in review.
prereq: authored-inverse-parser-ast
files:
  - packages/quereus/src/planner/analysis/authored-inverse.ts
  - packages/quereus/src/planner/analysis/update-lineage.ts
  - packages/quereus/src/planner/nodes/plan-node.ts
  - packages/quereus/src/planner/building/select-projections.ts
  - packages/quereus/src/planner/building/select-modifiers.ts
  - packages/quereus/src/planner/mutation/single-source.ts
  - packages/quereus/src/planner/mutation/multi-source.ts
  - packages/quereus/src/planner/mutation/scope-transform.ts
  - packages/quereus/src/planner/mutation/backward-body.ts
  - packages/quereus/src/planner/mutation/decomposition.ts
  - packages/quereus/src/func/builtins/schema.ts
  - packages/quereus/src/schema/rename-rewriter.ts
  - packages/quereus/src/schema/lens-compiler.ts
  - packages/quereus/test/logic/93.5-authored-inverse.sqllogic
  - docs/view-updateability.md
----

# Authored inverse write path — complete

Second step of the `with inverse` feature (parser/AST landed in
`authored-inverse-parser-ast`). Build-time validation everywhere the clause
appears, lineage upgrade to a writable `authored` UpdateSite (authored wins
over identity / passthrough / registry-`inverse`), single-source UPDATE/INSERT
and multi-source UPDATE lowering, view_info/column_info parity, ALTER RENAME
propagation, and lens-merger carry-through. Deferred with precise sited
diagnostics: multi-source INSERT, decomposition writes, SELECT-source INSERT.
Normative design + status block: docs/view-updateability.md § Authored
inverses. Prover integration is `authored-inverse-lens-prover`.

## Review findings

Reviewed the implement diff (`0881cea4`) file-by-file before reading the
handoff, then re-derived semantics from docs § Authored inverses and probed
the lowering paths with targeted tests. `yarn build`, `yarn lint`, and the
full workspace `yarn test` (5744 quereus logic/spec tests + all other
workspaces) pass after the fixes below.

### Fixed in this pass (minor → inline)

- **Written-row binding for co-assigned columns (semantic divergence).** Docs
  define `new.<x>` as the **written view row**, but both UPDATE lowerings
  bound `new.<x>` to `x`'s *forward read image* (the pre-update value) even
  when `x` was also assigned in the same statement —
  `update v set b2 = 5, a = 10` computed b2's put from the OLD `a`. Fixed in
  `rewriteViewUpdate` (single-source) and `decomposeUpdate` (multi-source):
  an upfront assigned-value map (keyed by the `newRefIndex` domain) substitutes
  the co-assigned value; every embedded RHS reads the pre-update row, so
  cross-references are order-independent (pinned both orders, plus the
  unassigned-sibling forward-image case, single-source and join).
- **Column-list rename broke the INSERT `new.<x>` bridge.** `new.<x>` names a
  SELECT-output column, but `rewriteAuthoredViewInsert`'s `resolveNew` looked
  `x` up **by name** against `targetNames` (VIEW-column names). Under an
  explicit `create view v(vid, vcode)` column list these diverge — the lookup
  missed (silent NULL) or could cross-map. Fixed to bridge positionally
  through the put site's validated `newRefIndex` → `analysis.viewColumns`,
  the same index discipline the UPDATE path already used. Pinned with a
  column-list view exercising INSERT, UPDATE, and read-back.
- **Aggregate result column silently dropped the clause.**
  `analyzeSelectColumns` routes aggregate columns into the aggregate phase,
  which never reaches the `Projection` array the metadata rides — a
  `sum(x) as s with inverse (…)` validated fine and then went silently inert.
  Now rejected with a sited error (aggregate views are read-only; silent
  inertness would mask the intent). Window columns keep the metadata (it is
  carried, not dropped; window bodies are rejected by the write spines).
- **Validator missed `windowFunction` operands.** `transformExpr` (which
  `substituteNewRefs` rides) descends into window args / PARTITION BY /
  ORDER BY / frame bounds, but `forEachInverseRef` treated `windowFunction`
  as a leaf — a bare ref there escaped rule 3, and a `new.x` there would
  surface as an `internal:` error at lowering instead of a sited user error.
  Walker extended to mirror `transformExpr`'s descent; pinned (bare ref in a
  window operand now raises the NEW-qualifier diagnostic).
- **RENAME output-name shift missed star projections.** The implement pass
  retargeted `new.<old>` refs only for an *unaliased bare projection* of the
  renamed column, but `select *` (covering the renamed table) exposes the old
  name as an output name too — a rename left `new.<old>` dangling, breaking
  the view body's validation at next use. `visitColumnRename`'s select case
  now adds the shift when a star column covers the renamed table (frame-
  resolved, alias-aware) and no explicit projection still exposes the old
  name. Pinned (`select *, expr with inverse (… new.tag …)` + rename).
- Docs status block updated for all of the above (written-row binding
  wording, aggregate rejection, star-projection rename case).

### Verified clean (no action)

- **Validation rules 1–4**: target resolution/ambiguity, `new.*` output
  resolution (case-insensitive, star-expanded, first-occurrence), bare-ref
  rejection with the `insideSubquery` exemption, object-keyed cross-column
  duplicate-target guard. The parser's in-clause duplicate check is
  case-insensitive (`seen.has(column.toLowerCase())`), so rule 4's same-rc
  exemption can't be abused via case variants.
- **CTE symmetry**: both the validator and `substituteNewRefs`
  (`mapQueryExprUniform`) skip subquery `withClause` bodies — a `new.x`
  inside a CTE is neither registered nor substituted, failing downstream as
  an ordinary unresolved reference (CTE bodies can't correlate; no internal
  error path).
- **Lineage**: `deriveAuthoredSite` requires every target to reach a plain
  identity base site (degrades to `computed` otherwise — never falls back to
  the inferred put); authored CHILD sites re-projected by an outer select
  degrade (index-domain safety); `composeUpdateSite`'s authored case is
  defensively pass-through and genuinely unreachable; `identityBaseColumn`
  returns undefined for authored sites, keeping the `deriveViewColumns`
  parity bridge intact (the property harness never generates the clause, so
  parity holds vacuously); `resolveBaseSite` leaves `baseColumn` undefined so
  no verbatim consumer admits an authored site.
- **Collision guards**: single-source UPDATE (`recordBaseColumn` per put) and
  INSERT (`claimBase` across verbatim + put targets); multi-source duplicate
  base assignments fall to the pre-existing base-builder backstop (same as
  the plain path — not a regression).
- **INSERT defaults precedence**: authored put targets count as supplied
  (shadow `insert defaults` / constant-FD pins); the literal-contradiction
  check applies to the verbatim subset only; `collectAppendedDefaults` is
  byte-equivalent on the plain path.
- **Deferral diagnostics**: join INSERT (`no-inverse`, naming the column),
  decomposition writes (`unsupported-decomposition-member`, naming members,
  write-classification sites only), SELECT-source INSERT
  (`unsupported-source`). All sited, all pinned.
- **view_info / column_info**: authored columns report updatable; single-put
  base trace vs multi-target null base; insert coverage counted on
  single-source bodies only (join INSERT is deferred — counting would
  over-report).
- **Lens merger**: the clause rides per covered column (gap-filled columns
  never carry one); composed-body output names equal logical column names, so
  `new.*` refs stay resolvable; write-through pinned.
- **scope-transform**: `cloneResultColumns` / `rebuildSelect` deep-clone the
  clause (sharing severed for in-place rewriters); `substituteNewRefs` is
  depth-blind on the reserved `new` qualifier and clones replacements.
- **Plan-shape inertness**: pinned via `query_plan` node-type comparison.

### Known gaps (documented, deliberate)

- `new.<x>` on INSERT where `x` is neither supplied nor default-appended
  binds NULL; a base-table-declared `default` is not visible to the inverse
  (it applies inside the base op). Documented; acceptable v1 boundary.
- Upsert (`on conflict do update`) clauses pass through un-rewritten through
  any view — pre-existing behavior, not widened by this ticket; only
  `insert or replace` is pinned.
- The redundant-on-passthrough advisory and PutGet/GetPut prover enumeration
  are `authored-inverse-lens-prover` (follow-up ticket already named in docs).
- Optimizer rules that rebuild `Projection` arrays may drop the metadata —
  harmless today (every consumer reads the freshly built body plan), flagged
  in code comments.

### Spawned tickets

- `backlog/cross-source-unqualified-body-projection` — **pre-existing** (not
  introduced here, found while probing the authored partner-read path): a
  cross-source read reaching the partner side through an *unqualified* body
  projection fails with a generic `Column not found` instead of riding the
  captured-read machinery; qualified projections work. No silent mis-bind
  (ambiguous names fail body planning).
- The "No row context" planner bug found during implement was already triaged
  by the runner from `tickets/.pre-existing-error.md` (commit `aaf87a3d`);
  nothing further filed here.
