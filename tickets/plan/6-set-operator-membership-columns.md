---
description: Manifest per-branch membership of a set-operation (union / intersect / except) as first-class writable boolean columns — the set-op analogue of the outer-join existence column. Flags are derived membership predicates over operand data relations (never stored columns), so they compose and nest cleanly. Reifies branch provenance as an explicit, per-row updateability control surface that replaces the quereus.update.* routing tags.
prereq: outer-join-existence-column
files: packages/quereus/src/planner/analysis/update-lineage.ts, packages/quereus/src/planner/mutation/propagate.ts, packages/quereus/src/planner/mutation/mutation-tags.ts, packages/quereus/src/schema/reserved-tags.ts, packages/quereus/src/parser/parser.ts, packages/quereus/src/parser/ast.ts, docs/view-updateability.md, docs/sql.md
---

## Concept

This is the set-operator sibling of `outer-join-existence-column`. An outer-join existence column reifies "is this row present in **component X**" where the component is a *join side*; for a set operation the component is a *branch*. It is the same idea — state presence explicitly instead of inferring it — applied to a vertical (row) combination rather than a horizontal (column) one.

For a set-operation view, manifest per-branch **membership** as writable boolean columns (e.g. `inLeft` / `inRight`, or named branches):

- **Read** — provenance: which branch(es) the current row came from.
- **Write** — direct fan-out control:
  - `set inRight = true` → insert the row into the right branch's base relation;
  - `set inRight = false` → delete it from the right branch's base;
  - both branches false → the row leaves the view entirely.

These columns are **`existence`-sited** in the lens/update model — the same `UpdateSite` kind the outer-join existence column introduces, with the relational-component reference being a set-op branch instead of a join side. (See the substrate note on `outer-join-existence-column`: the `existence` site should carry a generalized component reference so this is an extension, not a parallel mechanism.)

### Flags are derived membership on data — never stored columns (so nesting is legit)

The load-bearing rule (shared with the join existence column): a membership flag is a **derived predicate** — `inA ≡ (result-tuple ∈ A)` — computed at the combinator over operand **data** relations. It is **not** a stored column that lives inside a branch and flows back into the union. This is what keeps it sound:

- **Set semantics are untouched.** The union still dedups on the **data** columns only; the flags are metadata computed *after*, so they never perturb identity/dedup. (Storing a provenance column inside a branch is the error mode — it would re-enter the outer union's schema and dedup; the join analogue is the null-extended `{true, NULL}` symptom.)
- **Nesting is fully legitimate.** Because each flag is just `tuple ∈ <that operand's relation>`, a flag can name a **leaf** branch (`t ∈ A`) *or* a **subtree** (`t ∈ R1`, R1 a sub-union) — every one an independent boolean function of the result tuple, dedup-safe at any depth. A nested `((A ∪ B) ∪ (C ∪ D))` with flags at both levels is well-defined: inner flags give base-relation provenance, outer flags give subtree provenance.
- **Writes route at any granularity.** `set <leafFlag> = true/false` → base insert/delete; `set <subtreeFlag> = true/false` → recurse through that subtree's own `put` (the recursive view-update fan-out). The flat per-leaf form is just the common special case where only leaf flags are exposed.

### Reused flag names factor the address (product vs sum)

Reusing a flag name across sibling subtrees is a **feature**, not a hazard. When the siblings are *structurally parallel* (the same leaf relations under different filters — `R1 = (A∪B) where id=1`, `R2 = (A∪B) where id=2`), reusing `inA`/`inB` at both levels while naming the subtrees `inX`/`inY` yields a **product coordinate system**: `{inX,inY} × {inA,inB}` is a 2×2 grid and each leaf is the **conjunction** of one coordinate per axis — `(B where id=1) = inX ∧ inB`. A write setting `inX=true, inY=false, inA=false, inB=true` therefore targets exactly the B-leaf of the X-subtree. This is strictly better than forcing distinct per-leaf names (which flattens the grid to `in_A1/in_B1/in_A2/in_B2` and loses the factoring).

The derivation is uniform: a top-level flag is `tuple ∈ <the union of all like-named leaves>` (so `inA ≡ tuple ∈ (A where id∈{1,2})`). The flags are **named, writable handles on the branch predicates**, so conjunction routing *is* the existing predicate-honest fan-out — `inX` carries the `id=1` predicate, `inB` selects base `B`, the write goes to `B where id=1`.

- **Single-target vs multi-target is a choice, both sound.** One-hot coordinates (mutually-exclusive predicates) make the conjunction pin **one** leaf — single-target. Setting several coordinates true instead is a **multi-target** write that fans out to *every* leaf consistent with the flags (`inX=inY=inA=inB=true` upserts the row at all of them) — the predicate-honest fan-out, a feature. One-hot is **not** a soundness requirement; it is just how you opt into single-target. The *only* rejection is a provable **contradiction**: a multi-target needs the set coordinates **co-satisfiable**. Note two *values of one attribute* are mutually exclusive (`color='red'` vs `'blue'`, like `id=1` vs `id=2`) and contradict; two *different attributes* (`color='red'` and `size='large'`) co-exist. `inX ∧ inY` over mutually-exclusive subtrees is the `predicate-contradiction`.
- **Reused names express a product** (factored coordinates, structurally-parallel subtrees); **distinct names express a sum** (tagged tree positions, structurally-different subtrees, e.g. `(A∪B)∪(C∪D)`). The engine chooses neither — it derives `flag ≡ tuple ∈ <union of like-named leaves>` and lets conjunction address the leaf.

The one real rider is cost: each flag is a **semijoin probe**, so exposing many flags / deep nesting scales read cost — a perf consideration, not correctness.

## Per-operator semantics

- **`union all` / `union`** — `inA` / `inB` independently describe presence in each branch's underlying relation; both informative on read. Setting one true inserts into that branch; setting both false removes the row.
- **`except`** (`A except B`) — a visible row is always `inLeft = true, inRight = false`. `set inRight = true` inserts into B, pushing the row out of the view (the explicit form of today's `delete_via = 'right_insert'`); `set inLeft = false` deletes from A.
- **`intersect`** — reads are trivially all-true (a visible row is in every branch), so membership columns are write-useful only: `set inB = false` removes the row from B, dropping it from the intersect (the explicit form of a single-side delete).

## Why it matters

It **replaces the `quereus.update.*` routing tags** (`target` / `exclude` / `delete_via`, and arguably `policy`) by making branch membership a per-row, explicit, writable value rather than a statement-level tag inferred against branch predicates. This is the set-op half of the directive to **remove the routing-tag surface** (the other half is the outer-join existence column). The value-supply tag `default_for` is **retained** — it supplies values for omitted insert columns and has no column equivalent. The actual deletion of the redundant routing tags from the reserved-tag registry + docs is its own gated step — see `remove-update-routing-tag-surface`.

## Open design questions (for the plan stage to resolve)

1. **Branch naming / selector.** The keyword is settled as **`exists`** (reusing the join form), and the derived/nesting model (above) means the **general** n-way case is already covered: each binary combinator names its own immediate operands with `exists left` / `exists right`, and chains nest, so no global positional naming of a "middle branch" is ever needed. The remaining *ergonomic* question is whether to also offer a **flat n-way shorthand** — a single non-nested chain that exposes one flag per leaf without writing the nesting — which would need leaf labels (a per-leg `... as branch <name>`, or positional). Nice-to-have, not gating; the nested form is the sound baseline.
2. **Membership-column syntax — aligned with the join.** Canonical form is `exists <branch> as <col>` (e.g. `exists left as inA`), reusing the already-reserved `exists` keyword exactly as `outer-join-existence-column` settles it (clause never followed by `(`, so it cannot collide with the `exists (<subquery>)` predicate; it appears only after a complete set-op leg where no expression begins). An optional projection-position sugar `exists(<branch>)` mirrors the join's `exists(<alias>)` sugar. No new keyword is introduced.
3. **Grammar interaction at the `union` boundary + breaking-change/version check.** Placing a clause adjacent to `union` is grammar-sensitive: a leg can currently begin with `select` / `values` / `(` / `with` (parenthesized CTE leg). **`with` is specifically hazardous** there (it collides with CTE syntax) — a concrete reason the clause uses `exists`, not `with`. `exists` cannot begin a leg today, so the clause should be **additive (non-breaking)**, occupying unused grammatical space — but **confirm** this against the real grammar, **document** the post-`union` interaction in `docs/sql.md`, and record the major-version-bump decision as forward-looking governance (AGENTS.md currently says back-compat is not yet a concern, so today the bar is documentation, not a bump).
4. **`union all` bag semantics.** A row can be present in a branch more than once; membership is likely boolean "present ≥ once," with the multiplicity limit documented (or a count variant considered).
5. **Interaction with branch-consistency dispatch.** How an explicit membership write composes with the predicate-honest fan-out and branch-consistency rules already in `propagate.ts`.

## Expected behaviour / use cases (illustrative — syntax TBD)

```sql
-- binary: each combinator names its own two operands
create view U as
  (select id, x from A)
  union exists left as inA, exists right as inB
  (select id, x from B);

select id, x, inA, inB from U;            -- inA ≡ tuple ∈ A, inB ≡ tuple ∈ B (derived, dedup-safe)
update U set inB = true  where id = 7;    -- also place the row in B
update U set inA = false where id = 7;    -- remove from A (still visible if inB)

-- nested with REUSED inner names → a product coordinate system.
-- The two subtree axes are INDEPENDENT, co-satisfiable predicates (color vs size),
-- so a single row can sit in both subtrees and all four flags can be true at once.
create view U4 as
      ((select id, x from A where color = 'red')
         union exists left as inA, exists right as inB
       (select id, x from B where color = 'red'))
  union exists left as inX, exists right as inY
      ((select id, x from A where size = 'large')
         union exists left as inA, exists right as inB
       (select id, x from B where size = 'large'));
-- axes:  base ∈ {A,B} (inA/inB)   ×   predicate ∈ {red = X, large = Y} (inX/inY)
-- single-target (conjunction):  inX ∧ inB  → the B/red leaf → B where color='red'
-- multi-target  (fan-out):      inX=inY=inA=inB=true → upsert into BOTH A and B
--                               as red AND large  (no contradiction: co-satisfiable)
```

## Tests (TDD seeds)

The shared FD invariants and the `existence`-site substrate live in `outer-join-existence-column` (§ FD ramifications); this ticket adds the set-op coverage.

- **View Round-Trip Laws** (`test/property.spec.ts`), a set-op membership family: leaf-flag and subtree-flag reads agree with `tuple ∈ <union of like-named leaves>`; `set flag = true/false` (PutGet) shows the row appear/disappear in the targeted base(s); a multi-target write (`inX=inY=inA=inB=true` over co-satisfiable axes) fans out to all consistent bases; a contradictory coordinate (`inX ∧ inY` over mutually-exclusive subtrees) rejects with `predicate-contradiction`.
- **Key Soundness** (`test/property.spec.ts`): a distinct union carrying flags stays keyed by its data columns (`key → flag`, flag never in a claimed key); a `union all` (bag) makes no `key → flag` claim (FD ramifications, Invariant 1 + the bag case).
- **AST round-trip**: `parse(stringify(ast)) ≡ ast` for the `exists <branch> as <col>` clause at the `union` boundary; confirm the clause is additive (open question #3).
