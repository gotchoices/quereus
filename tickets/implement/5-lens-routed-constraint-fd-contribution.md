description: Contribute a lens-guaranteed declared logical key (PK / UNIQUE) to the optimizer's FD framework on the routed-constraint path, so a key the lens *proves* or *actively enforces* surfaces as a functional dependency on the inlined-view boundary even when the compiled body doesn't intrinsically prove it. Read-side only; soundness-gated by obligation kind.
prereq:
files: packages/quereus/src/planner/building/select.ts, packages/quereus/src/planner/nodes/, packages/quereus/src/runtime/emit/, packages/quereus/src/schema/lens-prover.ts, packages/quereus/src/schema/lens.ts, packages/quereus/src/schema/schema.ts, packages/quereus/src/planner/util/fd-utils.ts, packages/quereus/src/planner/nodes/reference.ts, docs/optimizer.md, docs/lens.md
----

## Context

A logical table is registered as an inlined `ViewSchema` (`lens-compiler.ts`),
so FDs **intrinsic to the compiled body** already flow to the optimizer through
ordinary view-inlining + per-node FD propagation. What does **not** flow is the
**declared logical key** when the body alone can't prove it — a key that holds
only because the lens *enforces* it (row-time, via a covering structure), or a
`proved` / `vacuous` key whose guarantee the optimizer should be able to rely on
even when local per-node propagation loses the proof the `proveEffectiveKeyUnique`
coverage prover established at deploy.

`docs/lens.md` (Constraint Attachment maturity note, ~line 152) names this exact
gap as the remaining **Pending** half: *"the FD-contribution of proved/enforced
keys to the optimizer."* The enforcement classes themselves (row-local, FK,
set-level) are orthogonal and shipped/sibling-tracked; this ticket is purely the
**optimizer FD surfacing**.

### Where the facts already live

The lens prover (`schema/lens-prover.ts`) classifies every logical constraint into
a `ConstraintObligation` (`lens-prover.ts:146`) and the lens compiler records the
list on `LensSlot.obligations` (`schema/lens.ts:~119`) at deploy. For a key
constraint the obligation is one of:

- `proved` — body intrinsically guarantees it (zero enforcement cost).
- `vacuous` — body + predicate make it trivially satisfied (e.g. `primary key ()`
  singleton).
- `enforced-set-level { mode: 'row-time', structure }` — a basis covering
  structure (non-stale covering MV) enforces uniqueness **synchronously per
  row-write** (`findBasisCoveringStructure` / `_findRowTimeCoveringStructure`).
- `enforced-set-level { mode: 'commit-time' }` — O(n) `DeltaExecutor` scan,
  **detection-only**, checked at commit; transient violation permitted
  mid-statement.
- (`enforced-row-local` / `enforced-fk` are not key/uniqueness facts — out of
  scope.)

The slot is reachable at plan time exactly as the mutation builder already
resolves it: `schemaManager.getSchema(view.schemaName)?.getLensSlot(view.name)`
(see `planner/building/view-mutation-builder.ts:159,173`).

## Design

### Soundness gate (resolves the ticket's open question)

Contribute the logical key as an FD **iff** its obligation is one of:

| Obligation | Contribute? | Why sound |
|---|---|---|
| `proved` | **yes** | Body guarantees it. Redundant-but-harmless when local propagation already surfaces it (`addFd` subsumes); load-bearing when it doesn't (multi-source / complex bodies the coverage prover proved but per-node FD flow lost). |
| `vacuous` | **yes** | Trivially holds (≤1 row → `∅ → all_cols`). |
| `enforced-set-level` `row-time` | **yes** | Covering structure enforces uniqueness per row-write; the relation is unique on the key at **every** observation point, including mid-statement. No transient duplicate survives a single row write. |
| `enforced-set-level` `commit-time` | **NO — degrade** | Detection-only, enforced at commit; a duplicate can transiently exist mid-statement (read-own-writes / Halloween). Assuming the FD mid-statement is **unsound** — the optimizer could drop a DISTINCT / eliminate a self-join over rows that transiently violate the key. Conservatively skip. |
| `enforced-row-local` / `enforced-fk` | **NO** | Not a uniqueness/key fact. |

This is the conservative resolution the ticket asks for: **commit-time set-level
is NOT contributed.** A false key FD is a *correctness* defect (it makes
DISTINCT/join-elimination/order-by-pruning drop real rows), so the gate errs
toward under-claiming exactly like every other FD-propagation rule.

> **Row-time obligation currency (verify during implement).** A `row-time`
> obligation is a deploy-time snapshot of "a non-stale covering MV answers this
> key." It is sound to trust at plan time **only if** a basis covering structure
> cannot be dropped or go stale without a re-deploy that recomputes obligations.
> Confirm this holds in the logical-schema model (basis structure changes go
> through `apply schema`). If a covering MV can be dropped/staled out-of-band
> between deploys, the `row-time` contribution must be re-validated at plan time
> (re-run `findBasisCoveringStructure`-equivalent against current catalog) or
> conservatively downgraded. Document the resolved assumption in `docs/lens.md`.

### Mechanism: an asserted-key pass-through node

`keysOf` / `isUnique` (`planner/util/fd-utils.ts`) read uniqueness from declared
`RelationType.keys` **or** a physical FD `key → others` equivalently. The
idiomatic surface — the one `TableReferenceNode.computePhysical` already uses
(`reference.ts:107`) — is the **physical FD** (`superkeyToFd(key, colCount)`),
not inventing `RelationType.keys` on a derived node. No node asserts keys today;
FDs are the dynamic surface. Mirror that.

Add a minimal **unary pass-through relational node** — `AssertedKeysNode`
(suggested; `planner/nodes/asserted-keys-node.ts`) — modeled byte-for-byte on
`AliasNode`:

- Carries `assertedFds: readonly FunctionalDependency[]` (the encoded logical
  keys, in the node's **output**-column-index space).
- `getType()` / `getAttributes()`: return the source's, **preserving attribute
  IDs** (pure pass-through; column shape unchanged).
- `computePhysical(childrenPhysical)`: pass every child physical property through
  unchanged (`ordering`, `monotonicOn`, `equivClasses`, `constantBindings`,
  `domainConstraints`, `inds`, `updateLineage`, `attributeDefaults`,
  `estimatedRows`) — exactly like `RetrieveNode.computePhysical` — and merge the
  asserted FDs into the child's via `addFd(fds, fd, { keyHints })` per FD.
- `withChildren(newChildren)`: rebuild preserving `assertedFds`.
- Emitter (`runtime/emit/asserted-keys.ts`): `return emitPlanNode(plan.source, ctx)`
  — purely a planning-time wrapper that **vanishes at runtime**, exactly like
  `emitAlias` (`runtime/emit/alias.ts:14`). Zero runtime cost.

Why a dedicated node and not a flag on `ProjectNode`/`AliasNode`: ProjectNode is
rewritten/reconstructed by several rules (e.g. `rule-projection-pruning`) that
would have to learn to preserve the field; a dedicated opaque pass-through is only
touched by the generic `withChildren` tree-walk, which preserves constructor
state. `RetrieveNode`/`AliasNode` are the precedent for exactly this kind of
marker pass-through.

### Wiring point: view inlining in `buildFrom`

In `planner/building/select.ts` `buildFrom`, the lens read path inlines the body
(`select.ts:392-441`) and — because lens views always declare `columns`
(`effectiveColumns`) — wraps it in a `ProjectNode` whose output columns are the
non-hidden logical columns in declaration order. Insert the `AssertedKeysNode`
**around that ProjectNode**, before the optional `AliasNode`:

```
AliasNode(optional)               -- existing, passes FDs through unchanged
  └─ AssertedKeysNode(assertedFds)  -- NEW
       └─ ProjectNode(rename → view columns)  -- existing
            └─ <inlined body>
```

The `AssertedKeysNode`'s output indices == the ProjectNode's output indices == the
non-hidden logical columns in declaration order — the same index space the lens
prover's `outputIndex` map uses. Resolve the slot via
`getSchema(schemaName)?.getLensSlot(viewSchema.name)`; only inline the node when a
slot exists **and** it yields ≥1 asserted FD (no node for plain views/MVs).

### The slot → FD helper

Add `computeLensAssertedKeyFds(slot: LensSlot): FunctionalDependency[]`
(suggested home: a new `schema/lens-fd.ts`, or exported from `lens-prover.ts`
alongside the obligation logic — both deploy and plan must reach it). It:

1. Builds the **non-hidden output index** map exactly as
   `buildProveContext` does (`lens-prover.ts:245-251`): walk
   `slot.columnProvenance`, skip `source === 'hidden'`, assign sequential output
   indices; record logical-column-name (lower) → output index, and the output
   column count.
2. For each `ob` in `slot.obligations` passing the soundness gate above:
   - Extract the key's **logical** column indices from `ob.constraint`
     (`primaryKey`: `constraint.columns[].index`; `unique`:
     `constraint.constraint.columns[]`).
   - Map each logical column index → name (`slot.logicalTable.columns[i].name`) →
     output index. If **any** key column has no output index (hidden / not
     emitted), **skip that key** — it isn't in the readable relation, so no FD is
     expressible.
   - Encode via `superkeyToFd(outCols, outColCount)`:
     - empty key (`vacuous` `primary key ()`) → `superkeyToFd([], n)` yields the
       `∅ → all_cols` singleton — the correct ≤1-row encoding.
     - key covering **all** output columns → `superkeyToFd` returns `undefined`
       (it's the all-columns/`isSet` key, inexpressible as a non-trivial FD).
       Either skip, or optionally surface via the node's `getType().isSet` — note
       the decision; skipping is acceptable for v1.
   - Accumulate via `addFd`.
3. Return the FD list (output-index space). Empty list ⇒ no node inlined.

Reuse `fd-utils.ts` helpers (`superkeyToFd`, `addFd`, `singletonFd`) — derive no
new inference; this is pure restatement of already-classified obligations.

### Write-path interaction (trace first — flagged riskiest)

The mutation builder (`view-mutation-builder.ts`) consumes obligations only for
**row-local CHECK** and **child-side FK** enforcement (`:159,:173`); FD
contribution is a **read-side** concern and lands solely on the `buildFrom`
inlining path. Two interactions to verify during implement:

- A lens mutation's **RETURNING re-query** reads the lens through the view path
  and will pick up the asserted FDs. That's a *post-write* read of an
  already-enforced relation — sound for the gated kinds (`proved` / `vacuous` /
  `row-time` hold at every observation point; `commit-time` is gated out).
- **Read-own-writes within a statement** (e.g. `insert into Lens select … from
  Lens`, or a correlated self-reference): for `row-time` the covering structure
  resolves each conflict synchronously per row, so the relation is unique
  throughout the statement → the FD holds mid-statement. `commit-time` (the only
  unsound case) is gated out. Confirm no path lets a `commit-time` key reach the
  node.

## Tests (TDD targets)

Logic/optimizer tests proving the FD now flows (use `query_plan(...)` assertions
as in existing optimizer specs; lens fixtures per `test/lens-*.spec.ts` /
`test/logic/5x-lens-*.sqllogic`):

- **DISTINCT elimination (positive, row-time):** a lens whose body does *not*
  intrinsically prove the logical PK but whose PK is `enforced-set-level`
  `row-time` (covering MV present) → `select distinct k from Lens` plans with
  **0** `DISTINCT` ops (`rule-distinct-elimination` fired because `keysOf` now
  sees the key).
- **DISTINCT elimination (positive, proved):** body proves it via a path local
  propagation loses → still eliminated.
- **ORDER BY trailing-key pruning (positive):** `select * from Lens order by k,
  other` drops the trailing key once `k` is `isUnique` (`rule-orderby-fd-pruning`).
- **Negative — commit-time NOT contributed:** identical lens but PK is
  `enforced-set-level` `commit-time` (no covering structure) → DISTINCT is
  **retained** (FD not asserted). This is the soundness gate's regression guard.
- **Negative — unenforced/unproved key:** a declared key that is neither proved
  nor enforced contributes **no** FD.
- **Vacuous singleton:** `primary key ()` lens → `∅ → all_cols` surfaces
  (`isAtMostOneRow` true on the boundary).
- **Hidden key column:** a logical key column hidden via `hiding(...)` → key
  skipped, no FD, no crash.
- **Key Soundness harness (`test/property.spec.ts`):** must stay green — the
  asserted FD genuinely holds for every gated kind. This is the empirical
  soundness backstop; treat any failure as a real over-claim, not a flake.

## Docs

- `docs/lens.md` Constraint Attachment maturity note (~line 152): move "the
  FD-contribution of proved/enforced keys to the optimizer" out of **Pending**;
  describe the gate (which obligation kinds contribute and why commit-time does
  not) and the row-time currency assumption resolved above.
- `docs/optimizer.md` Functional Dependency Tracking: add the lens boundary as an
  FD producer (the `AssertedKeysNode` pass-through), in the per-operator
  propagation vicinity, noting it is the declared-logical-key analogue of
  `TableReferenceNode`'s declared-key seeding and is soundness-gated by lens
  obligation kind.

## TODO

- [ ] Trace the write path first: confirm `commit-time` key obligations cannot
      reach the read inlining for a mid-statement self-referencing mutation;
      confirm RETURNING re-query soundness. (`view-mutation-builder.ts`,
      `select.ts` buildFrom).
- [ ] Resolve the **row-time currency** assumption (can a covering MV be
      dropped/staled between deploys without recomputing obligations?). Document
      the answer; if not guaranteed, re-validate at plan time or downgrade.
- [ ] Add `AssertedKeysNode` (`planner/nodes/asserted-keys-node.ts`) modeled on
      `AliasNode` / `RetrieveNode`: unary pass-through, attribute-ID-preserving,
      `computePhysical` merges `assertedFds` into child FDs via `addFd`,
      `withChildren` preserves `assertedFds`. Add the `PlanNodeType` enum entry.
- [ ] Add the emitter (`runtime/emit/asserted-keys.ts`) that emits the source
      directly (mirror `emitAlias`); register it in the emit dispatch. Verify
      planviz / serialization / the Pass-4 validation walk accept the new node
      type (grep `AliasNode` for every registration touchpoint and mirror).
- [ ] Add `computeLensAssertedKeyFds(slot)` (gate by obligation kind/mode; map
      logical key columns → non-hidden output indices via `columnProvenance`;
      encode with `superkeyToFd` / `singletonFd` / `addFd`). Factor the non-hidden
      output-index construction so it cannot drift from `buildProveContext`'s
      `outputIndex`.
- [ ] Wire into `buildFrom` (`select.ts` lens-view branch): resolve the slot,
      compute the FDs, wrap the body's ProjectNode in `AssertedKeysNode` when the
      list is non-empty (inside the optional `AliasNode`).
- [ ] Tests per the TDD targets above (positive row-time/proved, ORDER BY prune,
      negative commit-time, negative unenforced, vacuous singleton, hidden-key,
      Key Soundness harness).
- [ ] Run `yarn workspace @quereus/quereus build`, the lens + optimizer specs,
      and `yarn lint` (single-quote globs on Windows). Stream long output with
      `Tee-Object` / `tee` + a follow-up `tail`.
- [ ] Update `docs/lens.md` and `docs/optimizer.md` as above.
