description: SHELVED (2026-06-13 plan pass). Writable *product coordinates* over set-op branch membership — reused flag names merging into one coordinate column valued `tuple ∈ <union of like-named leaves>`, with σ-guard threading, coordinate-addressed multi-target fan-out, and `checkSatisfiability` contradiction rejection. Shelved in favor of the shipping sum model (6.2/6.3) + the projected-attribute idiom. Reopen only if a concrete use case needs writable boolean membership over a *non-literal* σ-guard (see reopen condition).
prereq: set-op-flagless-predicate-honest-writes
files: packages/quereus/src/planner/mutation/set-op.ts, packages/quereus/src/planner/nodes/set-operation-node.ts, packages/quereus/src/planner/analysis/update-lineage.ts, packages/quereus/src/planner/analysis/sat-checker.ts, packages/quereus/src/planner/rules/predicate/rule-filter-contradiction.ts, docs/view-updateability.md, docs/sql.md
difficulty: hard
----

## Status: SHELVED (plan pass 2026-06-13)

The plan pass for `set-op-projected-attribute-reframe` (the dev's redirect: *"explore if
we can accomplish the same thing using projected attributes, since this would add to the
predicate"*) concluded that the product-coordinate membership model should be **shelved**.
It is preserved here as a backlog spec — build it only if the reopen condition below is met.

### Why shelved (the finding)

The product model's distinctive capability over the already-shipping **sum** model
(distinct-named sibling subtrees, `6.2-set-op-leftwrap-arity` + `6.3-set-op-leftwrap-write`)
is the **reused-name merge**: collapsing like-named flags across sibling subtrees into one
coordinate column whose value is `tuple ∈ <union of like-named leaves>`.

That merge is a **probe/membership semantic** — "is this *data tuple* a member of branch X."
A projected discriminating attribute (`'red' as kind`, `'A' as src`) is the **dual** surface:
a **tag on the row's origin leg** (the sum / tagged-position model). A stored/projected value
records *where the row came from*, never *set membership of the tuple*, so a projected
attribute **structurally cannot reproduce the merge** — under `union all` the same tuple from
A and from B is two tagged rows, not one row carrying a 2-bit presence vector.

So the reframe expresses the sum model cleanly and the merge not at all. The sum model already
ships. **No use case has surfaced that genuinely requires the merge** and that this bespoke
build would serve better than the projected-attribute idiom:

- **Write addressing** for the literal/range/IN-discriminator case is subsumed by the engine's
  *existing* predicate-normalizer branch-consistency (the same pipeline behind
  `rule-filter-contradiction` / `sat-checker`): a leg whose accumulated σ contradicts the
  supplied discriminator values is "provably inconsistent ⇒ skipped" — no bespoke
  coordinate co-satisfiability gate, no new `predicate-contradiction` set-op gate.
- The **only residue** a projected attribute cannot express is writable boolean membership over
  an **arbitrary non-literal σ-guard** (a range too complex to fold to a constant, a correlated
  predicate, a function call). But `checkSatisfiability` returns **`unknown`** on exactly that
  fragment (`sat-checker.ts` § "Everything else … marks the touched columns as `sawUnknown`"),
  so the bespoke build degrades there *too* — it is not a point of advantage.

### Reopen condition

Reopen (promote to `plan/`) **only** when a concrete use case needs **writable boolean
membership over a non-literal σ-guard** — i.e. a row-level `set <flag> = true/false` whose
branch is gated by a range / correlated / function predicate that the FD framework cannot fold
to a constant discriminator, *and* whose contradiction/co-satisfiability the sat-checker can
actually decide (not `unknown`). Absent such a case, the sum model + the projected-attribute
idiom (`set-op-flagless-predicate-honest-writes`) is the recommended surface and this stays
shelved.

---

## Original product-coordinate design (comparison baseline — verbatim)

### The fixture this enables

```sql
create view U4 as
      ((select id, x from A where color = 'red')
         union exists left as inA, exists right as inB
       (select id, x from B where color = 'red'))
  union exists left as inX, exists right as inY
      ((select id, x from A where size = 'large')
         union exists left as inA, exists right as inB
       (select id, x from B where size = 'large'));
```

`inA`/`inB` are **reused** across the two sibling subtrees; `inX`/`inY` name the subtrees. This
yields a `{inX,inY} × {inA,inB}` product coordinate grid; each leaf is a **conjunction** of one
coordinate per axis (`(B where color='red') ≡ inX ∧ inB`).

### Read: reused names merge into one coordinate column

Today, two subtrees each declaring `inA` surface as **two `inA` columns** (a name collision;
6.2 deliberately leaves this as-is). The product model **collapses like-named flags into one
column** whose value is `tuple ∈ <union of all like-named leaves>`:
`inA ≡ tuple ∈ (A where color='red' OR size='large')`, `inX ≡ tuple ∈ <the red subtree>`. Distinct
names stay distinct (that is the sum model — tagged tree positions).

- Locus: `set-operation-node.ts` membership/attribute surface + `update-lineage.ts`. Merge by
  (lowercased) name across both operands at every depth; the merged read probe is the OR of the
  member leaves' presence.
- Open sub-question: do we **require** structural parallelism for a name reuse, or merge purely
  by name and let conjunction sort it out? (Parent ticket said merge purely by name; a reused
  name across non-parallel subtrees yields a defined-but-surprising union.)

### Analysis: thread the real σ-guard (currently a `true` placeholder)

`SetOperationNode.membershipLineage()` registers each flag's `existence` `UpdateSite` with
`guard = { type:'literal', value:true }` (a placeholder; `set-operation-node.ts`). The product
model needs the **real accumulated σ** each branch carries, threaded onto the `set-op-branch`
component, because leaf addressing = "the leaf whose accumulated guard is co-satisfiable with
the set-true coordinates' guards" and contradiction detection = sat-check over those guards.

### Write: coordinate addressing, multi-target fan-out, one rejection

Writing a merged coordinate flag `set inX = true, inB = true, inY = false, inA = false`:
1. Collect the **set-true** coordinates' guards (one per axis).
2. **Sat-check co-satisfiability** of their conjunction via `checkSatisfiability`. If provably
   `unsat` → reject `predicate-contradiction` (the **only** rejection).
3. **Target leaf set** = every leaf whose accumulated guard is co-satisfiable with the conjoined
   set-true guards. Single-target = one-hot coordinates pin one leaf; multi-target =
   co-satisfiable coordinates fan to every consistent leaf (predicate-honest fan-out).
4. Emit one recursive `MutationRequest` per target leaf, sharing the one up-front capture
   (reusing the `fanBranch*` machinery).

Contradiction example: a `U` whose two subtrees are `where id=1` / `where id=2`; `set inX=true,
inY=true` conjoins `id=1 ∧ id=2` → `unsat` → reject. Two **different** attributes
(`color='red' ∧ size='large'`) are co-satisfiable → legal multi-target write.

### Build plan (if reopened → two prereq-chained implement tickets)

- **`set-op-product-coordinate-read`**: reused-name flag merge on the read surface + real σ-guard
  threading onto the `set-op-branch` components. Read-only, independently testable.
- **`set-op-product-coordinate-write`**: coordinate-addressed `set <coordinate> = true/false`,
  multi-target fan-out, `predicate-contradiction` rejection via `checkSatisfiability`.

### Edge cases & interactions (if reopened)

- Subtree + leaf read agreement (`inA ≡ A where color='red' or size='large'`, `inX ≡ red subtree`).
- Single-target write (conjunction pins exactly one leaf); multi-target write (co-satisfiable
  axes fan to all consistent leaves); contradiction rejection (mutually-exclusive `id=1`/`id=2`).
- Co-satisfiable vs contradictory: different attributes co-exist; two values of one attribute
  exclude. Cover both.
- Sat-checker scope limits: `checkSatisfiability` returns `unknown` outside its fragment
  (non-literal guards, >64 conjuncts, NULL comparisons). Default for `unknown`: treat as
  co-satisfiable → fan-out, and document (a false-reject is worse than a possibly-empty leaf
  write the leaf's own correlation filters out).
- Key soundness: no flag (leaf or subtree, merged or not) ever enters a claimed key, all depths.
- Halloween safety: coordinate fan-out reuses the ONE up-front capture across all target leaves.
- Interaction with the sum model: distinct-named subtrees keep 6.2/6.3 sum behavior; only reused
  names trigger the merge/product path.
- `except` / `intersect` subtrees inherit the `set-op-membership-nested-except` membership-gating.
