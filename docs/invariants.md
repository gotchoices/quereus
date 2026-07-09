# Invariant Register

A single file holding **only** statements the code must satisfy. It is meant to be read
end-to-end against the implementation in one sitting, a few times a year. The topic docs
keep the exposition and explain *why*; this register is the **normative text**. When the
two disagree, the register wins and the topic doc is wrong.

An entry earns its place only if all four hold: it states a property the **code** upholds
(not a description of behaviour, not advice); violating it is a **bug**, not a missed
optimization; it fits in **120 words** without its topic doc; and it names a **concrete
code site**. Cost-model constants, the rule catalog, performance advice, and rejected
alternatives are deliberately absent.

Each entry carries:

- `code:` — one or more `` `path` — `symbol` `` pointers at the implementation.
- `guard:` — exactly one. A test, a runtime assertion, or `none — <reason>`.
- `doc:` — the topic-doc section that explains it.

`scripts/check-docs.mjs` (`yarn docs:check`) machine-checks the *pointers*: every `code:`
path exists, every named symbol still appears in it, every `doc:` link resolves. It never
checks that an invariant **holds** — that is what `guard:` is for. So a rename or deletion
fails the build and forces someone to re-read the entry; a semantic regression does not.

IDs ascend within an area and gaps are expected: a retired invariant's number is never
reused. Back-links from the topic docs use the full heading slug
(`invariants.md#opt-014--an-attribute-id-is-originated-exactly-once`), not the short
`#opt-014` form, which GitHub does not mint.

See [Documentation Conventions § The invariant register](doc-conventions.md#the-invariant-register).

## OPT — Query optimizer

### OPT-001 — Every rule declares `sideEffectMode`

- code: `packages/quereus/src/planner/framework/registry.ts` — `validateSideEffectMode`
- code: `packages/quereus/src/planner/framework/pass.ts` — `addRuleToPass`
- guard: `packages/quereus/test/optimizer/side-effect-audit.spec.ts` — `Registry guardrail: unannotated rules are rejected`
- doc: [Optimizer § Audit discipline](optimizer.md#audit-discipline-sideeffectmode)

Every rule handed to `PassManager.addRuleToPass` declares `sideEffectMode: 'safe' | 'aware'`.
Registration throws otherwise. The field is typed as required, but rule handles are built by
spread and by generated registries where TypeScript cannot see through, so the runtime check
is the load-bearing audit gate — not a belt over a proven property. This invariant is
self-guarding: `validateSideEffectMode` raises `QuereusError(INTERNAL)` at registration.

### OPT-002 — An `'aware'` rule consults the side-effect signal

- code: `packages/quereus/src/planner/framework/characteristics.ts` — `subtreeHasSideEffects`
- code: `packages/quereus/src/planner/rules/predicate/rule-empty-relation-folding.ts`
- guard: `packages/quereus/test/optimizer/side-effect-audit.spec.ts` — `Side-effect audit: rules must refuse on impure subtrees`
- doc: [Optimizer § The two declarations](optimizer.md#the-two-declarations)

A rule that moves, duplicates, drops, or merges a subtree it has not separately proven pure
declares `'aware'` and consults `PlanNodeCharacteristics.hasSideEffects` /
`subtreeHasSideEffects`, refusing or weakening when a participating subtree carries a write.
`'safe'` is the counter-claim that the transform's structural shape preserves side effects
by itself. Two `'aware'` rules — `cte-optimization`, `in-subquery-cache` — refuse nothing:
they wrap the subtree in a run-once `CacheNode`, which preserves the write. The guard covers
the fold rules only; the declaration is not machine-checked against a rule's body.

### OPT-004 — A custom-`execute` pass argues its own soundness

- code: `packages/quereus/src/planner/framework/pass.ts` — `createMaterializationPass`
- guard: none — a pass supplies its own traversal, so no registration-time check sees the transforms it performs; a violation shows up as a lost or duplicated write, not a crash.
- doc: [Optimizer § Pass 3.5: Materialization Advisory](optimizer.md#pass-35-materialization-advisory-single-whole-tree-pass-order-35)

A pass carrying a custom `execute` has an empty `rules` array, so it never passes through
`addRuleToPass` and OPT-001's gate never fires on it. Its side-effect soundness argument
must therefore live in a comment at the pass definition. `createMaterializationPass` is the
one live instance; its argument is that `CacheNode` is a run-once fence, so a subtree the
advisory wraps executes exactly once rather than once per reference — a count-changing but
order-preserving rewrite.

### OPT-006 — Parallel-track rules refuse an impure branch

- code: `packages/quereus/src/planner/framework/characteristics.ts` — `isConcurrencySafe`
- code: `packages/quereus/src/planner/rules/parallel/rule-async-gather-union-all.ts`
- guard: `packages/quereus/test/optimizer/parallel-side-effect-refusal.spec.ts` — `Parallel-track refusal: AsyncGather(unionAll)`
- doc: [Optimizer § Parallel-track side-effect refusal](optimizer.md#parallel-track-side-effect-refusal)

Every rule that introduces an `AsyncGatherNode`, `EagerPrefetchNode`,
`FanOutLookupJoinNode`, or `FanOutBatchedOuterNode` checks each participating branch on two
gates and returns `null` if either fails: `branch.physical.concurrencySafe === true` (the
module's concurrency contract) and `PlanNodeCharacteristics.isConcurrencySafe(branch)` (side-effect
freedom). Refusal, not fallback: the serial plan underneath is already correct. Driving a
write concurrently with a sibling branch violates the per-connection lock under every
module concurrency mode except `'fully-reentrant'`, which no module advertises.

### OPT-008 — Plan nodes are immutable

- code: `packages/quereus/src/planner/nodes/plan-node.ts` — `withChildren`
- guard: none — no cheap mechanical check; an in-place mutation surfaces as a stale cached `physical` or `getTotalCost()` value producing a wrong plan, never as a crash.
- doc: [Optimizer § Immutable Plan Nodes](optimizer.md#immutable-plan-nodes)

A `PlanNode` is never mutated after construction. A transform re-mints — `withChildren`
returns a fresh instance with fresh, empty `physical` and total-cost caches — rather than
writing through an existing node. The single sanctioned in-place mutator is
`RecursiveCTENode.setRecursiveCaseQuery()`, which exists because the recursive case cannot
be built before the node it references; it explicitly invalidates the caches it dirties
(see OPT-018).

### OPT-010 — Visited rules are inherited across a re-mint; declines are not

- code: `packages/quereus/src/planner/framework/pass.ts` — `inheritVisitedRules`
- guard: `packages/quereus/test/planner/framework.spec.ts` — `Visited-rule tracking`
- doc: [Optimizer § Rule Application Control](optimizer.md#rule-application-control)

When a rule transforms a node, `PassManager` copies the original node's applied-rule set onto
the freshly-minted node, so an applied rule is never re-offered its own output — that is what
terminates the per-node fixpoint loop. The *decline* set is the mirror image: it is scoped to
one unchanged node id and is **reset the instant any rule transforms the node**. Inheriting
declines would suppress a rule that becomes applicable only after a sibling rule reshapes the
node, silently changing the chosen plan.

### OPT-012 — `withChildren` preserves attribute IDs

- code: `packages/quereus/src/planner/nodes/plan-node.ts` — `withChildren`
- guard: `packages/quereus/test/optimizer/attribute-id-stability.spec.ts` — `Attribute ID stability`
- doc: [Optimizer § Attribute ID Preservation](optimizer.md#attribute-id-preservation)

A node reconstructed by `withChildren` republishes the same attribute IDs its original
published. Column identity is by stable attribute ID, never by name or output position, so a
rewrite that re-mints an ID orphans every `ColumnReferenceNode` above it and every
`RowDescriptor` the emitter builds from `getAttributes()`. A rule that must change a node's
output shape rebuilds it explicitly (`AggregateNode.preserveAttributeIds`,
`EmptyRelationNode`'s attribute-carrying constructor), rather than relying on generic
reconstruction.

### OPT-014 — An attribute ID is originated exactly once

- code: `packages/quereus/src/planner/analysis/attribute-provenance.ts` — `computeAttributeProvenance`
- guard: `packages/quereus/test/planner/attribute-provenance.spec.ts` — `computeAttributeProvenance`
- doc: [Optimizer § Attribute provenance](optimizer.md#attribute-provenance)

An attribute ID is *originated* by exactly one node — the deepest relational node that
outputs it and whose direct relational children do not — and may then be *forwarded*
verbatim by any number of ancestors. The invariant is "originated once", not "appears once":
joins concatenate both sides' IDs, set operations mirror the left child's, and `ProjectNode`
forwards a source ID for a bare column-reference projection. Two distinct nodes originating
the same ID, or one node listing an ID twice, is a genuine bug and throws
`QuereusError(INTERNAL)`.

### OPT-016 — `estimatedCost` is self-cost only

- code: `packages/quereus/src/planner/nodes/plan-node.ts` — `getTotalCost`
- code: `packages/quereus/src/planner/validation/plan-validator.ts` — `validateCostAdditivity`
- guard: `packages/quereus/test/planner/cost-additivity.spec.ts` — `Cost model: self-cost-only additivity`
- doc: [Optimizer § Self-cost-only convention](optimizer.md#self-cost-only-convention)

`PlanNode.estimatedCost` holds the node's own incremental cost, excluding its children.
`getTotalCost()` is the sole place child costs are summed. A constructor that folds
`child.getTotalCost()` or a child's `estimatedCost` into its own self-cost double-counts once
`getTotalCost()` sums the children again, compounding with nesting depth and changing which
plan the optimizer picks. Costs are abstract units, lower is better, finite, and `>= 0`; a
transform that changes a node's shape recomputes rather than inherits. The one leaf reading an
`estimatedCost` is the vtab access node's own `xBestIndex` cost. See
`tickets/complete/1-planner-cost-model-double-count.md`.

### OPT-018 — The total-cost memo is invalidated on mutation

- code: `packages/quereus/src/planner/nodes/plan-node.ts` — `invalidateTotalCostCache`
- guard: `packages/quereus/test/planner/cost-additivity.spec.ts` — `total invalidates when the recursive case is swapped`
- doc: [Optimizer § Self-cost-only convention](optimizer.md#self-cost-only-convention)

`getTotalCost()` is memoized per instance. That is sound only because nodes are immutable
(OPT-008) and no constructor calls it, so the first call always happens after the subtree is
fully built. Any in-place mutator that changes a node's children must call
`invalidateTotalCostCache()`. `RecursiveCTENode.setRecursiveCaseQuery()` is the one such
mutator today. A stale memo does not throw — it silently prices a subtree at its
pre-mutation cost.

### OPT-020 — No logical-only node reaches emission

- code: `packages/quereus/src/planner/validation/plan-validator.ts` — `validatePhysicalNodeType`
- guard: `packages/quereus/test/planner/validation.spec.ts` — `Logical-only node type Retrieve`
- doc: [Retrieve § Physicalization invariant](optimizer-retrieve.md#physicalization-invariant)

By the end of the Physical Selection pass every `RetrieveNode` has been rewritten to a
concrete access node (`SeqScanNode`, `IndexScanNode`, `IndexSeekNode`, `EmptyResultNode`) or
to a `RemoteQueryNode`, and every logical `AggregateNode` to a `StreamAggregateNode` or
`HashAggregateNode`. Neither has an emitter. `validatePhysicalNodeType` is a runtime
assertion, but it runs only under `tuning.debug.validatePlan`, which defaults to `false` in
production — so in a release build a surviving logical node surfaces as a missing-emitter
error, not as this message.

### OPT-022 — A Retrieve pipeline holds only supported operations

- code: `packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts`
- code: `packages/quereus/src/planner/rules/predicate/rule-predicate-pushdown.ts`
- guard: `packages/quereus/test/optimizer/remote-grow-retrieve.spec.ts` — `Retrieve growth with supports() (remote query)`
- doc: [Retrieve § Supported-only placement policy](optimizer-retrieve.md#supported-only-placement-policy)

Everything beneath a `RetrieveNode` is an operation the module committed to executing —
`supports()` accepted the candidate pipeline, or the index-style `getBestAccessPlan()`
fallback did. Anything else stays above the boundary as a residual. Both rules that move work
across the boundary construct a supported-only fragment and leave the remainder above;
neither pushes a predicate speculatively. Growth is purely structural (it never consults
cost), so a given plan always reaches the same segment boundary, which is what makes the
later join-enumeration cost comparisons meaningful.

### OPT-024 — An unconsumed seek constraint is reattached

- code: `packages/quereus/src/planner/rules/access/rule-select-access-path.ts` — `reattachUnconsumedConstraints`
- guard: `packages/quereus/test/vtab/overclaiming-module.spec.ts` — `over-claiming module: planner reattaches unconsumed filters`
- doc: [Optimizer § The `handledFilters` contract](optimizer.md#the-handledfilters-contract)

`handledFilters[i] = true` promises the module enforces filter `i`, and the only channel is
`FilterInfo.constraints` — the seek bounds `rule-select-access-path` builds. Since the rule
consumes at most one filter per column per role, a module that over-claims would leave a
filter enforced nowhere. So the rule reattaches, as a residual `Filter`, every seek-family
constraint it claimed-but-did-not-consume. An over-claiming module therefore costs a
redundant filter, never a wrong answer. Filters outside the seek family (`IS NULL`, `LIKE`,
`NOT IN`, …) are never pushed into `FilterInfo`, so a module claiming one is taken at its
word.

### OPT-030 — Uniqueness is read through one surface

- code: `packages/quereus/src/planner/util/fd-utils.ts` — `keysOf`
- code: `packages/quereus/src/planner/util/fd-utils.ts` — `isUnique`
- guard: `packages/quereus/test/optimizer/keysof-isunique.spec.ts` — `keysOf / isUnique (unified uniqueness surface)`
- doc: [Functional Dependencies § keysOf / isUnique](optimizer-fd.md#keysof--isunique-the-single-uniqueness-read-path)

A uniqueness fact can live on three surfaces — declared `RelationType.keys`, the
`PhysicalProperties.fds` FD set, and `RelationType.isSet`. A consumer never hand-checks them.
It reads `keysOf(rel)`, `isUnique(cols, rel)`, `isAtMostOneRow(rel)`, or the underlying
`isUniqueDeterminant`, all in `fd-utils.ts`, which reconcile the three. Over-claiming a key is
a correctness bug — DISTINCT elimination and join elimination drop real rows; under-claiming
only forgoes an optimization. Routing every read through one place is what lets the three
representations change without auditing every consumer.

### OPT-032 — Coverage is not uniqueness

- code: `packages/quereus/src/planner/util/fd-utils.ts` — `closureCoversAll`
- code: `packages/quereus/src/planner/util/fd-utils.ts` — `isUniqueDeterminant`
- guard: `packages/quereus/test/fd-determination-reader-side-rule.spec.ts` — `isUniqueDeterminant (kind-aware uniqueness reachability)`
- doc: [Functional Dependencies § The reader rule](optimizer-fd.md#the-reader-rule-isuniquedeterminant)

`closureCoversAll(attrs, fds, columnCount)` is a pure **value** claim: rows agreeing on
`attrs` agree everywhere. Over a bag that proves nothing about row-uniqueness. A set of
columns is row-unique only when `isUniqueDeterminant` holds — coverage **and** uniqueness is
reachable, meaning the relation is a set, or some unguarded `kind: 'unique'` FD has its
determinants inside `closure(attrs)`. Producers may emit value claims freely as
`kind: 'determination'`; the entire soundness burden sits on the reader. Closure-shaped
consumers (ORDER BY pruning, GROUP BY simplification) want coverage and use it deliberately.

### OPT-034 — Closure helpers skip guarded FDs

- code: `packages/quereus/src/planner/util/fd-utils.ts` — `computeClosure`
- guard: `packages/quereus/test/optimizer/conditional-fds.spec.ts` — `fd-utils: guarded FD helpers`
- doc: [Functional Dependencies § Guard activation](optimizer-fd.md#guard-activation)

A guarded FD — one carrying a `GuardPredicate`, minted by an implication-form CHECK or a
partial UNIQUE index — holds only over rows satisfying its guard. It is therefore not a
closure-time fact. `computeClosure`, `determines`, `closureCoversAll`, `isUniqueDeterminant`,
`hasAnyKey`, `hasSingletonFd`, and `deriveKeysFromFds` all skip it, and it can never serve as
the `'unique'` witness. A conditional uniqueness claim proves no key for a subtree that has
not discharged the condition.

### OPT-036 — A guard is discharged only at the producing Filter

- code: `packages/quereus/src/planner/nodes/filter.ts` — `activateGuardedFds`
- code: `packages/quereus/src/planner/util/fd-utils.ts` — `predicateImpliesGuard`
- guard: `packages/quereus/test/optimizer/conditional-fds.spec.ts` — `predicateImpliesGuard`
- doc: [Functional Dependencies § Guard activation](optimizer-fd.md#guard-activation)

Guard discharge happens in `FilterNode.computePhysical` and nowhere else: the filter asks
`predicateImpliesGuard` whether its own predicate entails every guard clause and, if so,
replaces the FD with its unconditional twin via `stripGuard`. A consumer must never discharge
a guard itself. Activation is sound at the producing Filter because its rows all satisfy the
guard and filtering only shrinks the row set; an activated `'unique'` FD that later crosses a
fanning join is downgraded there (OPT-040), not weakened here. An unentailed guarded FD passes
through unchanged so a higher Filter can still activate it.

### OPT-038 — Projection drops an FD whose guard loses a column

- code: `packages/quereus/src/planner/util/fd-utils.ts` — `projectFds`
- code: `packages/quereus/src/planner/util/fd-utils.ts` — `shiftFds`
- guard: `packages/quereus/test/optimizer/conditional-fds.spec.ts` — `projectFds`
- doc: [Functional Dependencies § Guard activation](optimizer-fd.md#guard-activation)

`projectFds` drops a guarded FD whose guard references any column absent from the output
mapping: the guard becomes unobservable, so no downstream Filter could ever discharge it, and
a fact nobody can activate is worse than useless — it survives cap eviction while carrying no
information. `shiftFds` shifts guard column indices alongside determinants and dependents.
`addFd`'s subsumption applies only between FDs with equal guards; a guarded and an unguarded
twin coexist.

### OPT-040 — A fanning join downgrades the non-preserved side

- code: `packages/quereus/src/planner/nodes/join-utils.ts` — `downgradeUniqueFds`
- code: `packages/quereus/src/planner/nodes/join-utils.ts` — `propagateJoinFds`
- guard: `packages/quereus/test/fanning-join-fd-overclaim.spec.ts` — `fanning-join FD over-claim: optimizer blast radius`
- doc: [Functional Dependencies § kind: uniqueness provenance](optimizer-fd.md#kind-uniqueness-provenance)

A join whose equi-predicate covers no key of the opposite side duplicates that side's rows.
On the inner, cross, left, and right arms, `propagateJoinFds` rewrites every surviving FD of a
non-preserved side from `kind: 'unique'` to `'determination'` — **guarded FDs included**, since
a partial-unique key is no longer row-unique inside its own guard scope once fanned out. The
value claims stay true and closure consumers still want them, so the FD is downgraded, not
deleted. Semi and anti pass left rows at most 1:1 and preserve kinds verbatim; full outer
drops everything.

### OPT-042 — An outer join drops the null-padded side's facts

- code: `packages/quereus/src/planner/nodes/join-utils.ts` — `propagateJoinFds`
- code: `packages/quereus/src/planner/nodes/join-utils.ts` — `propagateJoinInds`
- guard: `packages/quereus/test/optimizer/fd-propagation.spec.ts` — `FD propagation per operator`
- doc: [Functional Dependencies § Per-operator propagation](optimizer-fd.md#per-operator-propagation)

A left outer join keeps only the left side's FDs, equivalence classes, constant bindings,
domain constraints, and inclusion dependencies; the right side's, and every equi-pair-derived
fact, are dropped. NULL padding of an unmatched row violates them all, and a guard referencing
a padded column would become activatable for the wrong rows. Right outer mirrors it. Full
outer drops both sides — including the at-most-one-row empty key, because two non-matching
one-row sides produce two padded rows.

### OPT-044 — FD identity is structural; `'unique'` wins on merge

- code: `packages/quereus/src/planner/util/fd-utils.ts` — `fdsEqual`
- code: `packages/quereus/src/planner/util/fd-utils.ts` — `addFd`
- guard: `packages/quereus/test/optimizer/fd-kind.spec.ts` — `FD kind provenance`
- doc: [Functional Dependencies § kind: uniqueness provenance](optimizer-fd.md#kind-uniqueness-provenance)

`fdsEqual` compares determinants, dependents, and guard, order-insensitively. It ignores
`kind`, `source`, and `valueEquality` — those are not part of FD identity. When `addFd` merges
two entries it finds equal, or subsumes one under the other, the survivor's `kind` is
`'unique'` if either input claimed it: uniqueness is a property of the determinant set, so
equal-determinant claims compose. `kind` is a required field precisely so a transform that
rebuilds an FD without spreading the original fails to typecheck instead of silently losing
the marker.

### OPT-046 — `addFd` is the only FD accumulation path

- code: `packages/quereus/src/planner/util/fd-utils.ts` — `addFd`
- code: `packages/quereus/src/planner/util/fd-utils.ts` — `MAX_FDS_PER_NODE`
- guard: none — no mechanical check distinguishes a hand-rolled `Array.push` onto an FD list from a legitimate local array build; a violation shows up as a missing key or an over-long FD list, not a crash.
- doc: [Functional Dependencies § Helper surface](optimizer-fd.md#helper-surface)

FDs are accumulated through `addFd` / `mergeFds`, never by pushing onto the array. `addFd`
performs subsumption (an existing same-determinant, same-guard FD whose dependents are a
subset of the newcomer's is dropped; a newcomer already subsumed is skipped) and enforces
`MAX_FDS_PER_NODE = 64`. Cap eviction keeps FDs whose determinants lie inside a caller-supplied
`keyHints` set first, and within each partition prefers `'unique'` over `'determination'` —
evicting a uniqueness witness is sound but causes downstream under-claims. Truncations log on
`quereus:planner:fd`.

### OPT-048 — Dependency facts index output columns

- code: `packages/quereus/src/planner/util/fd-utils.ts` — `projectFds`
- code: `packages/quereus/src/planner/nodes/join-utils.ts` — `propagateJoinFds`
- guard: none — the two index spaces are both `number`, so nothing type-checks the difference; a mix-up reads a neighbouring column's facts and yields a wrong plan.
- doc: [Optimizer Conventions § Functional Dependencies, Equivalence Classes, Bindings](optimizer-conventions.md#functional-dependencies-equivalence-classes-bindings)

Every FD, equivalence class, constant binding, domain constraint, and inclusion dependency
indexes **output-column positions on the node carrying it** — never attribute IDs, never
source-relation positions. Crossing a Project, Returning, Aggregate, or join boundary goes
through `projectFds` / `shiftFds` and their equivalence-class, binding, domain, and IND
mirrors, rather than a hand-written index map. The one exception is an
`InclusionDependency.target.targetCols`, which indexes the *target* relation and is therefore
never remapped by projection or join shift.

### OPT-050 — Equality facts require a value-discriminating collation

- code: `packages/quereus/src/planner/util/fd-utils.ts` — `extractEqualityFds`
- code: `packages/quereus/src/planner/analysis/comparison-collation.ts`
- guard: `packages/quereus/test/planner/collation-soundness.spec.ts` — `Collation soundness of plan-time equality facts`
- doc: [Functional Dependencies § Collation gate on equality facts](optimizer-fd.md#collation-gate-on-equality-facts)

An equality-derived fact — a `∅ → col` constant pin, a `col1 = col2` mirror FD, an
equivalence class, a constant binding, a domain constraint — is a **value** claim, and a SQL
equality only implies value equality when its effective comparison collation discriminates
values. `'Bob' = 'bob'` holds under NOCASE. So each conjunct is gated: extraction happens only
when every contributed collation on a textual operand is BINARY. Effective collation is
resolved at plan time exactly as the runtime resolves it, through the shared helpers in
`comparison-collation.ts`, so plan-time facts and runtime behaviour cannot drift.

### OPT-052 — Provenance is informational

- code: `packages/quereus/src/planner/nodes/plan-node.ts` — `ConstraintProvenance`
- code: `packages/quereus/src/planner/util/fd-utils.ts` — `fdsEqual`
- guard: none — a rule branching on `source` still typechecks and still passes its own tests; the damage is that a fact's optimizer meaning starts depending on where it came from.
- doc: [Functional Dependencies § Assertion-derived premises](optimizer-fd.md#assertion-derived-premises)

An FD, constant binding, or domain constraint may carry a `source` tag recording where it came
from (`'declared-check'`, `{ kind: 'assertion', name }`, …). No rule branches on it. The dedup
helpers compare structural fields only and ignore it, so when a declared CHECK and a hoisted
assertion produce structurally identical facts, whichever merged first survives. The tag
exists for diagnostics and for explaining a plan, not for driving one.

### OPT-054 — All-columns key-ness lives on `isSet`

- code: `packages/quereus/src/common/datatype.ts` — `isSet`
- code: `packages/quereus/src/planner/util/fd-utils.ts` — `keysOf`
- guard: `packages/quereus/test/optimizer/keysof-isunique.spec.ts` — `isSet`
- doc: [Functional Dependencies § kind: uniqueness provenance](optimizer-fd.md#kind-uniqueness-provenance)

"All output columns together form a key" has no non-trivial FD encoding, so it lives on
`RelationType.isSet` and never in `physical.fds`. DISTINCT and a schema-set table with no
smaller key set it. The kind-aware readers take it as an explicit parameter
(`isUniqueDeterminant(…, isSet)`, `hasAnyKey(…, isSet)`), and `keysOf` emits the all-columns
fallback key only when nothing smaller was found. There is no `PhysicalProperties.uniqueKeys`
field; the at-most-one-row marker is the `∅ → all_cols` FD (OPT-058).

### OPT-056 — An inclusion dependency is dropped when unsure

- code: `packages/quereus/src/planner/util/fd-utils.ts` — `projectInds`
- code: `packages/quereus/src/planner/nodes/join-utils.ts` — `propagateJoinInds`
- guard: `packages/quereus/test/optimizer/inclusion-dependencies.spec.ts` — `IND soundness (no over-claim)`
- doc: [Functional Dependencies § Inclusion Dependency Tracking](optimizer-fd.md#inclusion-dependency-tracking)

An inclusion dependency asserts that every row's `cols` tuple appears in another relation's
`targetCols`. A false one is unsound — it mis-proves coverage downstream; a missing one only
forgoes an optimization. Every propagation rule therefore drops when unsure: `projectInds` is
all-or-nothing (an IND losing *any* of its `cols` is dropped, unlike `projectFds`, which keeps
an FD with a surviving dependent), outer joins drop the padded side, full outer drops both, and
`AggregateNode` / `SetOperationNode` / `WindowNode` emit none.

### OPT-058 — At-most-one-row folds through `addSingletonFd`

- code: `packages/quereus/src/planner/util/fd-utils.ts` — `addSingletonFd`
- code: `packages/quereus/src/planner/util/fd-utils.ts` — `isAtMostOneRow`
- guard: `packages/quereus/test/property.spec.ts` — `Singleton equivalence law`
- doc: [Functional Dependencies § Singleton equivalence](optimizer-fd.md#singleton-equivalence)

Three channels encode "this relation has at most one row": an empty key in
`RelationType.keys`, the `∅ → all_cols` FD, and `isAtMostOneRow(rel)`. A producer folds the
fact in through `addSingletonFd`; a consumer reads `isAtMostOneRow`. A node declaring the
empty key on one or more columns must back it with the singleton FD. The reverse does not
hold: a Filter over a covered key, a `LIMIT 1`, or a scalar aggregate adds the FD without
rewriting its inherited logical keys.

## MV — Materialized views

Populated by `docs-invariants-mv`.

## RT — Runtime

Reserved.

## SCH — Schema

Reserved.

## SYNC — Sync

Reserved.

## LENS — Lens

Reserved.
