description: Phase B3 — converged the decomposition put fan-out (`decomposition.ts`) onto the SAME plan-node backward-walk consumer the multi-source path uses. A new shared `analyzeBodyLineage` (n-way) plans a view body once and reads its threaded `updateLineage`; `resolveBaseSite` is the shared per-site reader. Decomposition now derives column→member routing + the anchor-only predicate gate from that lineage (retiring `buildViewColMap` + `collectColumnQualifiers`); the advertisement only disambiguates deferred shapes. Build + lint clean; full quereus suite green (4349 passing, 9 pending, 0 failing — baseline parity), incl. Family C + lens put-fanout.
prereq:
files: packages/quereus/src/planner/mutation/backward-body.ts, packages/quereus/src/planner/mutation/decomposition.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/analysis/update-lineage.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/test/property.spec.ts, packages/quereus/test/lens-put-fanout.spec.ts, docs/view-updateability.md, docs/lens.md

## What shipped

The debt this ticket targeted: `decomposition.ts` derived its backward decisions from
AST analysis (`buildViewColMap` projection map, `collectColumnQualifiers` base-qualifier
scan in `anchorPredicate`) rather than the threaded plan-node lineage the multi-source
path (post-B2) consumes. Goal: single-source / multi-source / decomposition share **one**
backward-walk consumer, not three.

### New shared surface

- **`analysis/update-lineage.ts` — `resolveBaseSite(site)`** (+ `ResolvedBaseSite`): the
  n-way per-`UpdateSite` reader. Unwraps a `base` / outer-join-`null-extended` site to its
  owning base relation (`table`, `baseColumn`, `writable`, `nullExtended`, `inverse?`,
  `domain?`). Generalizes — and subsumes — the former multi-source-local `writableBaseSite`
  (which discarded the table on null-extension) and the single-source identity-only
  `identityBaseColumn`. `writable` = identity-or-inverse base; identity-only consumers
  additionally check `inverse === undefined`.

- **`mutation/backward-body.ts` (NEW) — `analyzeBodyLineage(ctx, view)`**: the one
  plan-node backward-walk consumer. Plans a view body **once** (`buildSelectStmt`),
  collects its `TableReferenceNode`s, reads `root.physical.updateLineage` via
  `resolveBaseSite`, and returns `{ root, tableRefsById, viewColToBaseRef, columns:
  BackwardColumn[] }`. Source-count-agnostic (single table / two-table inner join / n-way
  decomposition join). Also exports `collectTableRefs` (relocated from multi-source).

### Consumers converged

- **`multi-source.ts` `analyzeJoinView`** now calls `analyzeBodyLineage` for the
  plan-body + lineage read, then layers its `JoinNode` / `joinScope` / per-side mapping on
  top. `writableBaseSite` and the private `collectTableRefs` are **deleted** (the shared
  surfaces replace them). The `outColumns` mapping was written to match the prior
  `writableBaseSite`→`sideIndex` shape exactly (`writable = sideIndex !== undefined`;
  `baseColumn` / `inverse` / `domain` preserved; an extra `!nullExtended` guard is
  defensively added but unreachable for inner joins, which never null-extend). The
  `select *` reject (reason `unsupported-join`) moved just *before* the shared read so it
  still beats the generic arity diagnostic.

- **`decomposition.ts`** — `analyzeDecomposition(ctx, view, storage)` builds a
  `DecompShape` off `analyzeBodyLineage` + a `TableReferenceNode`-id → member map (matched
  by base table schema+name). `classifyColumn(shape, name)` routes each logical column off
  the lineage (identity base column → owning member) and falls back to the **advertisement**
  only to disambiguate the deferred shapes (a non-identity `member.columns` mapping → a
  read-only `computed-mapping`; an EAV-pivot subquery column → `eav`; otherwise `unbacked`).
  `routeAssignment` (UPDATE), `routeInsertColumn` (INSERT), and the new lineage-driven
  `assertAnchorScoped` (the anchor-only WHERE gate) all decide off `classifyColumn`.
  `buildViewColMap` and `collectColumnQualifiers` are **retired**; `collectViewColumnRefs`
  (collects the *logical* column names a user WHERE touches + subquery presence) feeds the
  lineage gate. The anchor-key subquery / `substituteViewColumns` / `stripAnchorQualifier`
  / `rewriteAssignedValue` AST construction (execution mechanics) is unchanged, as are the
  anchor-last ordering, EAV / optional / singleton handling, `ViewMutationNode` +
  base-builder reuse, and every `unsupported-decomposition-*` / `no-inverse` diagnostic
  (messages preserved verbatim where tests assert on them).

INSERT now also routes off the lineage and therefore plans the synthesized body once
(`analyzeDecompositionInsert` → `analyzeDecomposition`), where it previously worked purely
off the advertisement — mirroring the multi-source insert, which also plans. The envelope
materialization (`buildDecompositionInsert`) is untouched.

## Validation (what I ran)

- `yarn workspace @quereus/quereus run build` — clean (tsc exit 0).
- `yarn workspace @quereus/quereus run lint` — clean (exit 0).
- `node test-runner.mjs` (full quereus suite) — **4349 passing, 9 pending, 0 failing**,
  identical to the B2 baseline (`view-mutation-retire-ast-roundtrip`). Behavioral parity.
- Focused: `--grep decomposition` (Family C + `lens-put-fanout.spec.ts`) = 56 passing;
  `--grep "multi-source inner join|View Round-Trip|lens"` = 331 passing.

## Use cases for the reviewer to exercise / re-verify

Acceptance gate is **behavioral parity** — the suite already locks these; the reviewer
should treat the tests as a floor and probe the boundaries below.

- **Family C (`property.spec.ts` `describe('decomposition fan-out')`)** — columnar
  (+ optional outer-joined member), EAV pivot, surrogate, singleton; PutGet / GetPut /
  lineage agreement; reject-don't-widen.
- **`lens-put-fanout.spec.ts`** — the message-sensitive rejects are the parity tripwires:
  `where b = 100` ⇒ `/non-anchor decomposition member/i`; `set c = 5` ⇒ `/optional member/i`;
  `set id = 9` ⇒ `/shared key/i`; `set p = 99` (EAV) ⇒ `/EAV pivot member/i`;
  `set notacol = …` ⇒ `/not backed by any decomposition member/i`; `set a = b + 1` ⇒
  `/cross-member assignment/i`; self-member `set b = b + 1` / `set a = a * 2` succeed.
  Surrogate per-row vs per-statement mint, EAV mixed-case attribute, atomic mid-fan-out
  rollback, NOT-NULL omission.
- **Multi-source (Family B + `93.4-view-mutation.sqllogic`)** — the refactor of
  `analyzeJoinView` is the highest-risk blast radius; both/single-side update, FK-child
  delete, `delete_via=parent`, inverse-column writes, RETURNING, `select *`/self-join/
  composite-PK/cross-source rejects.

## Known gaps / honest flags (treat tests as a floor)

1. **Unknown-WHERE-column tightening (untested, intentional).** Old `anchorPredicate` left
   an unknown column un-substituted; it passed the gate (no base qualifier) and leaked to /
   errored at the anchor base op. The new lineage gate classifies an unknown column as
   `unbacked` → not anchor → **rejects** with `unsupported-decomposition-predicate`. This
   aligns decomposition with the multi-source / single-source scope guards (arguably more
   correct), but it is a behavior change on a path **no test covers**
   (`delete from x.T where <unknown> = 1`). The reused diagnostic message says "non-anchor
   decomposition member", which is slightly imprecise for a genuinely-unknown column.
   Reviewer: decide whether to add a goldens test locking the reject, or refine the message.

2. **Dead-path message divergence in `routeAssignment`.** The old step-3 had a
   "projected non-column but no EAV member" sub-branch → `unsupported-decomposition-update`
   ("computed projection"). `classifyColumn` returns `unbacked` → `no-inverse` for that
   case. It is unreachable in a synthesized body (a non-column projection arises only from
   an EAV subquery — which requires an EAV member — or a `member.columns` non-identity
   mapping, caught earlier as `computed-mapping`). Flagged, not fixed.

3. **Non-identity / non-invertible columnar mappings are untested.** All test advertisements
   use identity `colMap('a','a')`. `classifyColumn`'s identity-via-lineage +
   `member.columns` fallback handles `a+1` (lineage base+inverse → `computed-mapping`) and
   `a||b` (lineage computed → `computed-mapping`), reasoned-equivalent to the old
   `basisExpr.type !== 'column'` reject — but unproven by goldens. A worthwhile addition.

4. **`memberByTableId` matches planned refs to members by `relation.schema`+`relation.table`
   (case-insensitive).** A decomposition with two members over the *same* physical base
   table (a self-decomposition) would match ambiguously — structurally unsupported today
   (multi-source rejects self-joins), but it is an unguarded assumption.

5. **Multi-source parity is by-construction + suite-validated, not a structural diff.**
   `analyzeJoinView` was rewired through `analyzeBodyLineage`; I matched the prior
   `OutColumn` shape by hand and leaned on the full Family-B / `93.4` / `view-info` suites
   (all green) rather than a byte-level comparison of the produced analysis.

6. **`view-complement.ts` listed in the ticket files but deliberately not edited.** The
   ticket named `updateLineage` / `viewComplement` as the backward sources. All routing /
   gate decisions are per-output-column → `updateLineage` is the natural fit; the
   complement's hidden-columns / residual-predicate surface was not needed here. Left
   unchanged (a deliberate scope call, not an oversight).

7. **`test:store` (LevelDB) not run.** Planner-only change, but the store exercises a
   different base-write path. Left for CI / a human, consistent with the B1/B2 handoffs.
