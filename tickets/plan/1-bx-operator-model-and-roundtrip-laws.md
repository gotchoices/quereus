description: Design-spike — the backward (put / update-propagation) direction is a DERIVED-and-law-checked dual of each operator's forward FD/EC/domain walk (relational-lens operator typing, Bohannon–Pierce–Vaughan 2006), NOT a parallel hand-maintained walk, decided BEFORE view-mutation-plan-node-substrate threads plan-node update-lineage parallel to computePhysical. DECISION: auto-deriving `put` from `get` (Voigtländer-style bidirectionalization) is the committed NORTH-STAR — every operator's backward method is authored as a get→put derivation from the shared forward annotation so eventual mechanical auto-derivation is a refactor behind the same law, not a redesign. The cheapest insurance — a per-operator round-trip LAW in the property suite that forces the directions to agree — is carved out as its own implement follow-on that lands first and is independent of the substrate. Design source: docs/view-updateability.md § Mutation Propagation / § Implementation Surface; docs/lens.md § Background (Foster 2007; Bohannon–Pierce–Vaughan 2006).
prereq:
files: docs/view-updateability.md, docs/lens.md, docs/optimizer.md, packages/quereus/src/planner/mutation/propagate.ts, packages/quereus/src/planner/analysis/update-lineage.ts, packages/quereus/src/planner/analysis/scalar-invertibility.ts, packages/quereus/src/planner/analysis/binding-extractor.ts, packages/quereus/test/property.spec.ts
----

## Why this spike exists (the fork in the road)

Quereus computes the **forward** relational direction once, structurally: each
operator's `computePhysical` derives the output `PhysicalProperties.fds`
(FD / key / equivalence-class / domain) from its children, and the
**Key Soundness** property harness (`property.spec.ts` § Key Soundness, Tiers 1
and 2) materializes the rows and asserts the claimed `keysOf` / `isSet` never
over-claim. That harness is the structural net that keeps the forward walk honest.

The **backward** direction — "given a mutation against this relation, what base
operations realize it" — is, by contrast, three *separate* hand-maintained walks:

- `analysis/update-lineage.ts` (per-output-column provenance back onto base columns — the doc calls it "the dual of the FD walk"),
- `analysis/scalar-invertibility.ts` (which scalar transforms are invertible on the write path),
- `mutation/propagate.ts` (`classifyViewBody` — the dual of `binding-extractor` / change-scope, walking the planned body down to base tables).

Today all three are **AST-driven and restricted to the single-source
projection-and-filter shape**, and — crucially — **nothing structurally forces
them to agree with the forward FD walk**. The Key Soundness harness backstops only
the forward direction. There is no round-trip check: an operator could advertise a
key forward while its `put`/lineage rule silently disagrees about which base column
that key threads to, and no test would red.

`view-mutation-plan-node-substrate` (plan/) is about to make this worse before it
makes it better: it will thread `updateLineage` / `AttributeDefault` **on
`PhysicalProperties`, computed by each operator's `computePhysical`** — i.e. a
second per-operator walk living right next to the forward FD walk, populated by
hand, operator by operator (TableReference seeds, Project rethreads through
invertible scalars, Filter contributes constant-FD defaults, Join composes
per-source lineage). Two parallel per-operator walks, one structural net on only
one of them. This spike must decide the discipline **before** that threading lands,
because retrofitting a derivation/law contract after a dozen operators have a
hand-written `updateLineage` is the expensive order.

## The on-point research the current docs do not cite

`docs/view-updateability.md` § Background cites Bancilhon–Spyratos (constant
complement), Keller (per-operator decomposition), Hegner (order-based updates),
Date & Darwen, and Litak–Mikulás. `docs/lens.md` § Background cites Foster et al.
(2007) *Combinators for Bidirectional Tree Transformations* and frames GetPut /
PutGet as "the completeness checks the lens prover discharges."

The directly on-point work that is **missing** is **Bohannon, Pierce & Vaughan
(2006), "Relational Lenses: A Language for Updatable Views."** It types
`select` / `project` / `join` lenses with **FD-and-predicate annotations** and
proves **GetPut / PutGet *compositionally, per operator*** — exactly the structure
Quereus already half-has (FD-annotated operators) but applies in only one
direction. Voigtländer's "bidirectionalization for free" and the broader
putback-based-BX line are the secondary references for *deriving* `put` from `get`
rather than authoring it twice. This spike's job is to decide how much of that
relational-lens discipline Quereus adopts.

## What is already shipped and must NOT be redesigned

- **The forward FD encoding and surface.** `PhysicalProperties.fds` is the sole
  uniqueness encoding (`5-collapse-uniquekeys-into-fds`): a key `K` is
  `K → (all_cols \ K)`, at-most-one-row is `∅ → all_cols`. `keysOf` / `isUnique`
  (`unified-key-inference-surface`, `planner/util/fd-utils.ts`) is the read surface.
  This spike consumes that surface; it does not re-encode keys.
- **The forward soundness net.** Key Soundness Tiers 1 + 2 (`property.spec.ts`,
  `key-soundness-harness-tier2`) stay exactly as they are. The round-trip law this
  spike recommends is a **third, sibling** property block, not a rewrite of Tiers
  1/2.
- **Phase-1 view write-through.** The AST-rewrite path in `building/view-mutation.ts`
  (`view-updateability-phase-1`) ships and is correct for single-source
  projection-and-filter. This spike does not delete it; whether the eventual
  substrate retires it or keeps it as a fast path is the substrate ticket's call,
  not this one's.
- **The attribute-provenance surface.** `computeAttributeProvenance` /
  `getAttributeIndex()` (`attribute-provenance-surface`) is the stable-attribute-id
  machinery that the *put* walk addresses columns by. The round-trip law and any
  derived-put walk key off attribute ids, not positions, reusing this surface.
- **The diagnostics contract.** `mutation/mutation-diagnostic.ts`
  (`MutationDiagnosticReason`, `ViewMutationError`) is the structured-rejection
  surface; a non-invertible / undisambiguated operator already has a `no-inverse`
  reason. Derived-put / law failures reuse this vocabulary; no new error subsystem.

## The decision (decisive recommendation)

**Adopt relational-lens operator typing for the backward direction, with the law
as the contract — but stage it as insurance-first, derivation-second.** Concretely,
three nested commitments, in landing order:

### Tier A (land first, independent of the substrate): the round-trip LAW as a property test

Add a **per-operator round-trip property block** to `property.spec.ts`, sibling to
Key Soundness, that forces the *existing* backward walk to agree with the forward
walk over the writable fragment. For a randomly-seeded small base table and a
spread of **single-source projection-and-filter** view bodies (the only shape the
shipped backward walk admits today):

- **PutGet (write-then-read).** Apply a generated mutation through the view
  (Phase-1 AST rewrite), then read the view back; assert the read reflects exactly
  the mutation's effect on the writable columns — no extra rows appear/disappear
  outside the view predicate, computed columns are untouched, and a key the forward
  walk claims on the view output is the same tuple the backward walk used to bind
  the base row. This is the law that would have caught the two correctness bugs
  Phase-1 review fixed by hand (the `LIMIT`/`DISTINCT` write-widening and the
  alias-qualifier leak) as *property* failures rather than hand-authored cases.
- **GetPut (read-then-write-back).** Read a row through the view, write the same
  values back, assert the base table is unchanged (no spurious diff).
- **Lineage/forward agreement (the structural crux).** For each accepted body,
  cross-check the **backward** lineage (`deriveViewColumns` →
  `ViewColumnLineage.base` / `computed`) against the **forward** FD facts
  (`keysOf` / `fds` of the planned body): every column the backward walk calls
  `base`-writable must have a forward FD path to that base column, and every key
  the forward walk advertises on the view output must be reconstructible by the
  backward walk's identifying predicate. A disagreement reds the test.

Tier A is the **cheapest insurance now**. It is pure test code, touches no engine
surface, and is carved out as its own implement ticket
(`bx-roundtrip-law-harness`) that **lands before the substrate** and stands alone
regardless of how Tiers B/C resolve. It immediately converts the "two parallel
walks, net on one" risk into a green/red signal on the shape that exists today.

### Tier B (gates the substrate): `put` is DERIVED, not a second hand-walk

When `view-mutation-plan-node-substrate` threads the backward surface, it threads
it as a **derived dual of the forward operator walk**, not as an independently
authored `updateLineage`. Each relational operator that already has a
`computePhysical` (forward `get` facts) gains **one** backward method whose output
is *checked against* the forward facts by the Tier-A law extended to the planned
multi-source tree:

```
// Per-operator backward surface (illustrative shape; finalized in the substrate ticket).
interface OperatorBx {
  // Forward already exists: computePhysical → PhysicalProperties (fds/ec/domain).
  // Backward: given a mutation request phrased over THIS node's output attributes,
  // emit the child-level requests, using the SAME fds/ec/domain the forward pass
  // produced — never a re-derived or hand-duplicated annotation.
  propagate(req: MutationRequest, forward: PhysicalProperties): ChildMutation[];
}
```

The point is the **shared annotation**: Project's `put` inverts exactly the scalar
transforms `scalar-invertibility.ts` classifies, threads keys exactly along the FDs
`computePhysical` emitted, and routes constant-FD defaults from the same `∅ → c = v`
guarded FDs the forward Filter produced. There is one FD/EC/domain object per node;
both directions read it. The Tier-A law, run over the planned tree, is the
acceptance gate that this derivation actually round-trips. This is the
Bohannon–Pierce–Vaughan move adapted to Quereus's FD-annotated operators: the
operator *type* (its FD/predicate annotation) determines both directions, and the
laws are checked rather than assumed.

This Tier hand-writes each `put` for v1 (the operator set is still moving), but every
backward method is **authored as a get→put derivation**: it *reads the forward
annotation* instead of re-deriving its own, and a law test gates it. Crucially, that is
the committed **north-star direction** — full mechanical auto-derivation of `put` from
`get` (Voigtländer-style bidirectionalization). v1 does not ship the auto-deriver, but
every operator's backward method is shaped so the eventual auto-derivation is a *refactor
behind the same law*, never an unwind of a parallel hand-walk. **No operator may
introduce a backward rule that auto-derivation could not later reproduce** — that
invariant is what keeps the north-star reachable instead of aspirational.

### Tier C (informs the lens prover): the predicate-honest complement as a first-class object

`docs/view-updateability.md` § Philosophy already commits to **predicate-honest
fan-out** as Quereus's answer to the Bancilhon–Spyratos complement ambiguity: a
mutation is routed to *every* branch whose predicate is consistent, so the
"complement" (what the view does **not** expose, held fixed by a write) is
**determined**, not chosen. Make that complement a **first-class derived object**:
for a view body, the complement is the set of base facts outside the view's
projection/predicate image, expressed in the same FD/predicate vocabulary. With the
complement in hand, the lens prover's **"Round-trip (lens laws)"** row
(`3-lens-prover-and-constraint-attachment`) stops being a 5-error/3-warning
*checklist* and becomes a **computed** check: GetPut holds iff `put` leaves the
complement fixed; PutGet holds iff `get ∘ put` reproduces the written view image.
The prover *evaluates* the law over the complement rather than enumerating failure
shapes. This Tier is a **design note for the lens prover**, not work this spike
schedules — it is named here so the prover ticket can consume the complement object
the substrate will produce.

## Why this path (over the alternatives the thesis names)

- **Over "keep parallel hand-maintained walks" (status quo extended to the
  substrate):** rejected. Two per-operator walks with a soundness net on only one is
  precisely the latent-divergence trap, and the cost of retrofitting agreement grows
  with every operator that gains a hand-written `updateLineage`. The marginal cost of
  Tier B (read the forward annotation instead of re-deriving) is small *if paid at
  threading time* and large if paid later.
- **On "full bidirectionalization-for-free" (derive `put` from `get`
  automatically):** committed as the **north-star**, sequenced — not built v1. The
  principle is adopted now (every backward method is a get→put derivation, §Tier B);
  what is deferred is only the mechanical auto-deriver, because the operator set is still
  moving (general-bodies, lateral-TVF, multi-source decomposition all in-flight).
  Tier B's "shared annotation + law gate" captures the soundness benefit immediately
  (the directions *cannot* silently disagree once the law is green) and is structured so
  the auto-deriver layers on later behind the same law without redesign. The rejected
  alternative is the *parallel hand-maintained walk* (below), not auto-derivation.
- **Why insurance-first (Tier A before the substrate):** the law harness is
  decoupled from the substrate, costs only test code, exercises the shape that ships
  today, and turns the entire question from "trust the review" into "watch the
  property suite." It is the highest value-per-risk increment and must not wait on
  the substrate's `Map`-serialization blocker or golden-plan regen.

## Proof-of-concept scope (what "spike done" looks like)

This spike is **decided** when the following PoC is demonstrated and written into the
design, sufficient to seed the two implement follow-ons:

1. **Tier-A law, single-source, green.** A working `property.spec.ts` round-trip
   block (PutGet + GetPut + lineage/forward agreement) over the *shipped* Phase-1
   AST-rewrite path, run on the existing projection-and-filter view zoo, green at
   `numRuns: 50`. Demonstrate it **reds** on a deliberately injected lineage
   disagreement (the negative self-test pattern Key Soundness already uses).
   *(This PoC body is exactly the deliverable of the `bx-roundtrip-law-harness`
   implement ticket; the spike produces the spec text and the assertion shapes.)*
2. **One operator's derived-put sketch.** For **Project** (the operator with both a
   forward FD rule and a backward invertibility rule today), write the design of the
   single shared-annotation backward method: how `propagate` reads the same projected
   FDs / `scalar-invertibility` profile the forward pass used, and how the Tier-A law
   extended to a two-node planned tree (Project over TableReference) gates it. No
   engine code — the spike establishes the *shape* the substrate ticket implements.
3. **Complement object sketch.** A concrete definition of the predicate-honest
   complement for the single-source projection-and-filter case (projected-away base
   columns + the negation-free residual of the view predicate), and a one-paragraph
   statement of how the lens prover would evaluate GetPut/PutGet over it — enough for
   `3-lens-prover-and-constraint-attachment` to pick up without re-deriving the idea.

## Implement follow-ons this spike unblocks

- **`bx-roundtrip-law-harness`** (implement, created alongside this spike, **lands
  first**): the Tier-A per-operator round-trip property block in `property.spec.ts`,
  plus the doc cross-references. Independent of the substrate; depends only on this
  spike's spec.
- **`view-mutation-plan-node-substrate`** (existing plan/ ticket, **retargeted** to
  depend on this spike): threads the backward surface as the Tier-B *derived dual*
  (shared FD/EC annotation, law-gated), not a parallel hand-maintained walk. The
  spike's Project PoC is its seed.
- **`3-lens-prover-and-constraint-attachment`** (existing plan/ ticket, **informed,
  not blocked**): consumes the Tier-C complement object so its "Round-trip (lens
  laws)" check is computed over the complement rather than enumerated as a checklist.

## Decided (was: human decision)

**Auto-deriving `put` from `get` (Voigtländer-style bidirectionalization) is the
committed north-star.** Every operator's backward method is authored as a get→put
derivation from the shared forward annotation (§Tier B), structured so the eventual
mechanical auto-deriver is a refactor behind the same round-trip law — not an unwind of a
parallel hand-walk. v1 still hand-writes each backward method; what is *sequenced* (not
abandoned) is only the auto-deriver itself, gated on the operator set stabilizing. This
shapes how `view-mutation-plan-node-substrate` writes every operator's backward method
from day one — and the "no backward rule auto-derivation could not reproduce" invariant
(§Tier B) is the concrete contract that keeps it on track.
