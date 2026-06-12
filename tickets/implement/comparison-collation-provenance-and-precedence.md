description: Replace right-operand collation precedence in comparisons with a provenance-ranked resolution lattice (explicit COLLATE > explicitly-declared column collation > defaulted collation > BINARY), erroring at plan time on same-rank conflicts at the explicit/declared levels. Adds ScalarType.collationSource, rewrites the shared resolver in comparison-collation.ts, and keeps every plan-time mirror and runtime emitter in lockstep through it.
difficulty: hard
files:
  - packages/quereus/src/common/datatype.ts                                # ScalarType — add collationSource
  - packages/quereus/src/planner/analysis/comparison-collation.ts          # THE shared resolver — core of the change
  - packages/quereus/src/planner/nodes/scalar.ts                           # BinaryOpNode.generateType (line ~224 TODO), CaseExprNode merge, CollateNode→'explicit', UnaryOp/Cast propagation, BetweenNode
  - packages/quereus/src/planner/nodes/reference.ts                        # TableReferenceNode attribute types (line ~62) — source from collationExplicit
  - packages/quereus/src/planner/nodes/subquery.ts                         # InNode generateType validation
  - packages/quereus/src/planner/type-utils.ts                             # columnSchemaToScalarType — source from collationExplicit
  - packages/quereus/src/planner/building/expression.ts                    # eager getType() after building BinaryOp/In/Between comparisons
  - packages/quereus/src/planner/building/alter-table.ts                   # 3 ScalarType construction sites (~264, ~309, ~326)
  - packages/quereus/src/planner/analysis/change-scope.ts                  # copies collationName (~84, ~102) — copy source too
  - packages/quereus/src/runtime/emit/binary.ts                            # emitComparisonOp — route through shared resolver
  - packages/quereus/src/runtime/emit/between.ts                           # per-bound resolution through shared resolver
  - packages/quereus/src/runtime/emit/subquery.ts                          # emitIn — condition+RHS resolution through shared resolver
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts   # effectivePredicateCollation — auto-updates via helpers; verify
  - packages/quereus/src/planner/util/fd-utils.ts                          # consumer of helpers; verify gates
  - packages/quereus/src/planner/analysis/predicate-normalizer.ts          # eq↔IN gate consumer; verify
  - packages/quereus/src/planner/analysis/constraint-extractor.ts          # collation-gate consumer; verify
  - docs/types.md                                                          # document the resolution lattice (currently silent on operand precedence)
  - packages/quereus/test/logic/40.2-check-extras.sqllogic                 # chk_coll_flip pins old right-precedence — update
  - packages/quereus/test/logic/06.4.2-collation-extras.sqllogic           # comment wording pins "right-operand precedence" — update
  - packages/quereus/test/logic/06.4.3-write-path-collation.sqllogic       # FK comment pins right-operand rule — reword (results unchanged)
  - packages/quereus/test/planner/collation-soundness.spec.ts              # unit tests over the helpers
----

# Comparison collation: provenance-ranked resolution

## Background

Today `emitComparisonOp` resolves a comparison's collation as: right operand's
`ScalarType.collationName`, else left's, else BINARY. Because every declared
column always carries a (possibly defaulted) collation name, a plain TEXT
column on the right silently clobbers a NOCASE-declared column on the left:
`a = b` with `a text collate nocase` compares BINARY, while `b = a` compares
NOCASE. Plan-time mirrors (`comparison-collation.ts`, consumed by the
access-path cover analysis, FD/EC gates, predicate normalizer,
constraint extractor) faithfully mirror this asymmetric rule.

Human-signed-off direction (triage 2026-06-12): SQLite conformance is a
non-goal; the engine follows explicit-over-implicit semantics. The new rule is
**symmetric** — `a = b` and `b = a` always resolve identically.

## The resolution lattice (settled design)

Each comparison operand contributes at most one `(collation, rank)` from its
`ScalarType`, based on a new provenance field (see below):

| rank | source                                            | BINARY counts as a contribution? |
|------|---------------------------------------------------|----------------------------------|
| 3    | `explicit` — a COLLATE expression (CollateNode)   | yes (`collate binary` is a real demand) |
| 2    | `declared` — column with `collationExplicit`      | yes (`c text collate binary` is a real preference) |
| 1    | `default` — defaulted column collation (session `default_collation`, store-module reconcile, engine BINARY default) | **no** — a defaulted BINARY contributes nothing |
| —    | none — no `collationName` (literals, most exprs)  | n/a |

Resolution of `left <op> right`:

1. Take the highest rank present among the two contributions.
2. If both operands contribute at that rank with **different** normalized names:
   - rank 3 → **plan-time error** (`conflicting COLLATE clauses in comparison: NOCASE vs RTRIM`)
   - rank 2 → **plan-time error** (`ambiguous collation for comparison: column collations NOCASE vs RTRIM differ; apply an explicit COLLATE`)
   - rank 1 → resolve to **BINARY**, no error (defaults are preferences, not declarations — per triage sign-off)
3. Otherwise the winning (single, or name-identical) contribution's name; no
   contributions at all → BINARY.

Erroring on rank-3 conflicts (rather than SQLite's leftmost-wins) was the open
question; settled as **error**: it keeps comparison resolution fully
commutative, matches the rank-2 error's philosophy, and two different explicit
COLLATEs across one comparison is near-certainly a user mistake. Conflicts
error even when operands are statically non-textual (consistent strictness;
collation declarations on non-text columns are already rejected by
`validateCollationForType`, so this only affects COLLATE-wrapped expressions).

Spot-check against existing pins:
- `b = c` (b plain, c NOCASE-declared) → NOCASE — unchanged (40.2 `chk_coll`).
- `c = b` flipped → was BINARY, now **NOCASE** — behavior change, symmetric with the above (40.2 `chk_coll_flip` must be updated; this is the headline fix: `'Bob' = 'bob'` with one NOCASE-declared side is now true regardless of spelling).
- `b = c collate binary` (c NOCASE-declared) → BINARY — unchanged (40.2 `chk_coll_bin`).
- FK parent lookup `parent.k = child.ref` (parent default-BINARY, child NOCASE-declared) → NOCASE — unchanged (06.4.3 §5; only the comment's "right operand wins" rationale needs rewording).
- session default-NOCASE column vs literal → NOCASE — unchanged (43.1).
- BETWEEN bounds with explicit COLLATE (06.4.2 §COLLATE-on-bound) → unchanged results; comments reference "right-operand precedence" and need rewording.

## Provenance representation

Add to `ScalarType` (common/datatype.ts):

```ts
/** Provenance of `collationName`; absent means unknown/derived (treated as 'default'). */
collationSource?: 'explicit' | 'declared' | 'default';
```

Setters:
- `CollateNode.generateType` (scalar.ts ~789) → `'explicit'`.
- Column types: `columnSchemaToScalarType` (type-utils.ts ~143), `TableReferenceNode` attributes (reference.ts ~62), alter-table.ts (~264/~309/~326 — the SET COLLATE site at ~326 is `'declared'` by definition) → `col.collationExplicit ? 'declared' : 'default'`.
- Sweep every other `collationName:` construction/copy site (`grep collationName:`) — notably change-scope.ts (~84/~102) must copy `collationSource` alongside. Nodes that copy whole `type` objects get it free.
- Absent `collationSource` with a present `collationName` is treated as `'default'` (safe floor for any site missed by the sweep).

Propagation through non-comparison combiners — concat (`||`,
BinaryOpNode.generateType line ~224, resolving its `TODO: Handle collation
conflict`) and CASE branch merging (scalar.ts ~508–546):
higher-ranked contribution wins; equal rank with the same name keeps it; equal
rank with different names propagates **no collation** (the conflict is not an
error here — concat/CASE don't compare — but it must not silently coin-flip;
a later comparison then falls back to BINARY). Note this changes concat: today
`leftType.collationName || rightType.collationName` lets a plain-left's
truthy default BINARY shadow a declared NOCASE on the right. UnaryOp (~62) and
Cast (~686) keep pass-through, adding the source field (Cast continues to drop
collation for non-textual targets).

## Single resolver, lockstep by construction

Rewrite `comparison-collation.ts` as the one implementation both plan-time and
runtime call:

```ts
export type CollationSource = 'explicit' | 'declared' | 'default';
/** (normalized name, rank) one operand contributes, or undefined. */
export function collationContribution(t: ScalarType): { name: string; rank: 3 | 2 | 1 } | undefined;
export type CollationResolution =
  | { kind: 'resolved'; name: string }
  | { kind: 'conflict'; level: 'explicit' | 'declared'; left: string; right: string };
export function resolveComparisonCollation(left: ScalarType, right: ScalarType): CollationResolution; // pure, never throws
export function effectiveComparisonCollation(left: ScalarPlanNode, right: ScalarPlanNode): string;    // throws QuereusError on conflict
export function effectiveInCollation(node: InNode): string;            // signature change — see IN below
export function effectiveBetweenBoundCollation(expr, bound): string;   // per-bound, same lattice
```

- `emitComparisonOp` (binary.ts) deletes its inline right-else-left block and
  calls `effectiveComparisonCollation` — the throw there is an unreachable
  backstop once plan-time validation exists.
- `emitBetween`, `emitIn` likewise route through the helpers.
- Existing consumers (`effectivePredicateCollation` in
  rule-select-access-path.ts, fd-utils.ts range/equality gates,
  predicate-normalizer eq↔IN gate, constraint-extractor collation gates,
  equi-pair-extractor, join-node/check-extraction value-discrimination gates)
  update automatically through the helpers; verify each compiles and its gate
  semantics still read correctly. `isValueDiscriminatingEquality` and the AST
  variant keep their both-sides-BINARY rule (unchanged: a default-NOCASE
  contribution still blocks value-level facts; default-BINARY ⇒
  `operandCollation` still normalizes to 'BINARY').

## Plan-time error placement

- `BinaryOpNode.generateType` — for the comparison operator class only
  (`=`, `==`, `!=`, `<>`, `<`, `<=`, `>`, `>=`, `IS`, `IS NOT`) — calls
  `resolveComparisonCollation` and throws `QuereusError` (StatusCode.ERROR,
  with `this.expression` location) on conflict. Same in `InNode.generateType`
  and `BetweenNode.generateType`.
- generateType is lazily cached, so force the error to prepare time: in
  `planner/building/expression.ts`, call `.getType()` on the freshly built
  BinaryOp comparison (~158), InNode (~253/~259), and BetweenNode (~283).
- Optimizer-synthesized comparisons (constraint-extractor, key-filter,
  equi-pair-extractor, decorrelation, predicate-inference, MV rewrite, …)
  reuse operands from already-validated user comparisons or are gated on
  collation equality, so they should never introduce a fresh conflict; the
  lazy generateType/emit backstops keep any miss loud. If a synthesized site
  trips the error, the gate that admitted the pair is the bug — fix the gate,
  don't relax the resolver.

## IN resolution

`cond IN (e1, …, en)` / `cond IN (subquery)`: merge the RHS contributions
first (list elements pairwise under the same lattice — a rank-3/2 name
conflict among elements is the same plan-time error; rank-1 conflicts merge to
no-contribution; subquery RHS contributes its single output column's
contribution), then resolve condition-vs-RHS with the lattice. Literal-only
lists contribute nothing, preserving today's condition-driven behavior for the
dominant case. `emitIn` still pre-resolves ONE collation (BTree build
unchanged). predicate-normalizer's eq↔IN equivalence gate now agrees with the
symmetric comparison rule automatically.

## Documentation

docs/types.md gains a "Comparison collation resolution" subsection under
"Collations and Types": the lattice table, the two error cases, the
defaults-conflict→BINARY rule, IN/BETWEEN behavior, propagation through
concat/CASE, and an explicit note that this deliberately diverges from
SQLite's left-operand precedence (explicit-conversion philosophy, symmetric
comparisons). Update the stale inline comment in emit/between.ts and the
`TODO: Handle collation conflict` in scalar.ts.

## Edge cases & interactions

- Symmetry: every matrix cell below must give identical results for `a = b`
  and `b = a` (and the error cases must error for both spellings).
- explicit-vs-explicit: same name OK; different names error; `x collate
  nocase = y collate nocase` fine; works on `<`/`<=`/IS as well as `=`.
- explicit BINARY beats declared NOCASE (40.2 `chk_coll_bin` pin must keep passing).
- declared-vs-declared: same name (two NOCASE columns) OK; NOCASE vs RTRIM →
  error naming both collations; error fires at prepare time for SELECT,
  CHECK-constraint compile (CREATE TABLE time), and DML-compiled scopes.
- declared `collate binary` column vs declared NOCASE column → error (BINARY
  counts at rank 2); declared `collate binary` vs plain column → BINARY, no error.
- declared NOCASE vs defaulted BINARY → NOCASE regardless of side (the
  headline change; 40.2 `chk_coll_flip` insert of ('X','x') now passes).
- defaulted NOCASE (session `default_collation` or store-module PK reconcile)
  vs defaulted BINARY → NOCASE; defaulted NOCASE vs defaulted RTRIM → BINARY,
  silently (pin with a test: two tables created under different session
  defaults).
- literal / no-collation expression vs anything → the other side (unchanged).
- COLLATE nested inside an operand (`(a collate nocase) || x = b`) propagates
  rank 3 through concat; concat of two different declared collations
  propagates none → comparison falls back to BINARY (new; pin it).
- BETWEEN: per-bound resolution; expr-declared vs bound-declared conflict
  errors per bound; `x between lo collate nocase and hi collate rtrim` is NOT
  a conflict (two independent comparisons); NOT BETWEEN same path; 06.4.2
  bound-COLLATE results unchanged.
- IN: condition declared NOCASE with literal list (unchanged NOCASE);
  `a IN (b)` with b declared NOCASE, a plain → now NOCASE; list elements with
  conflicting declared collations → error; subquery RHS column declared
  NOCASE vs plain condition → NOCASE; NOT IN same.
- IS / IS NOT: null-safe comparisons resolve through the same lattice
  (confirm where binary IS emits — emitBinaryOp's switch lists no IS case;
  if the parser only ever produces unary IS forms, document that and gate
  only the reachable operators).
- Write-path scopes (CHECK, DEFAULT new.* comparisons, RETURNING, upsert SET,
  FK parent-lookup) thread `columnSchemaToScalarType`, so provenance arrives
  free — 40.2 §CHECK-collation and 06.4.3 must pass with updated expectations.
- FK with parent and child columns declaring different explicit collations:
  the synthesized parent-existence comparison errors at DML plan time. Pin
  that error with a test; CREATE-time detection is parked in backlog
  (`fk-collation-conflict-create-time-validation`).
- Access-path cover analysis: effective collation flips for flipped-spelling
  predicates → cover classification (MATCH/COARSER_SAFE/MISMATCH_UNSAFE)
  follows automatically; 06.4.2 index/residual results must stay correct.
- Plan golden tests (test/plan/) may serialize ScalarType: if
  `collationSource` surfaces, update goldens rather than hiding the field.
- Store module (`yarn test:store`): implicit text PKs reconciled to NOCASE
  carry source 'default' — uncontested they still win (today's behavior on
  the right side, NEW behavior when on the left vs a plain column). The
  store path is directly affected; run `yarn test:store` once at the end
  despite the agent default, streaming output (`2>&1 | tee`).
- Sweep all of test/logic for col-vs-col comparisons between differently
  collated declared columns that now error — add `collate` annotations where
  the test's intent was the comparison, or pin the error where the intent was
  precedence.

## TODO

Phase 1 — provenance plumbing (no behavior change yet)
- Add `collationSource` to ScalarType (common/datatype.ts) with doc comment.
- Set source at CollateNode, columnSchemaToScalarType, TableReferenceNode attributes, alter-table sites; sweep remaining `collationName:` constructors (incl. change-scope.ts copies, building/schema-resolution.ts) and thread or document each.
- Propagation merges in BinaryOpNode (concat/result, resolving the line-224 TODO), CASE, UnaryOp, Cast.

Phase 2 — resolver + validation + emitters
- Rewrite comparison-collation.ts: collationContribution, resolveComparisonCollation, throwing effective* helpers; update module doc comment (it currently documents the right-precedence rule).
- generateType validation in BinaryOpNode (comparison class), InNode, BetweenNode; eager getType() in building/expression.ts.
- Route emitComparisonOp, emitBetween, emitIn through the helpers; delete inline precedence logic; refresh emit notes/comments.
- Verify all helper consumers (access-path, fd-utils, predicate-normalizer, constraint-extractor, equi-pair-extractor, join-node, check-extraction) compile and their gates remain sound.

Phase 3 — tests + docs
- Update 40.2 chk_coll_flip (+ section comment referencing this ticket), 06.4.2 and 06.4.3 comment wording, collation-soundness.spec.ts as needed.
- New test/logic/06.4.4-comparison-collation-precedence.sqllogic: the full matrix above (symmetric spellings, both error shapes with `-- error:` expectations, defaults-conflict→BINARY, IN/BETWEEN variants, concat-laundered conflict, FK explicit-conflict DML error).
- Unit tests for resolveComparisonCollation rank/conflict table (extend collation-soundness.spec.ts or a sibling spec).
- docs/types.md subsection; sweep test/logic for now-erroring comparisons; update plan goldens if collationSource serializes.
- `yarn build`, `yarn test` (workspace), lint in packages/quereus, plus one `yarn test:store` run (streamed) given the store-path interaction.
