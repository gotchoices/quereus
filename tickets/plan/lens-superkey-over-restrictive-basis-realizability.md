description: When a logical UNIQUE/PK is a strict superkey of a smaller declared basis key (basis `unique(a)`, logical `unique(a, b)`), the lens deploys with the logical key `proved`, but the basis enforces something strictly stronger — the logical schema advertises write-capacity the basis cannot hold. This is an over-constrained-basis / under-constrained-logical-key realizability mismatch, distinct from the conflict-action drop fixed in `lens-proved-superkey-basis-key-conflict-action-drop`. Decide whether it warrants a deploy advisory and design it.
files:
  - packages/quereus/src/schema/lens-prover.ts                 # classifyKeyConstraint / proveEffectiveKeyUnique superkey arm — where a smaller basis key proves a larger logical key
  - packages/quereus/src/planner/analysis/coverage-prover.ts   # proveEffectiveKeyUnique — superkey semantics (isUnique proves any superset of a real key)
  - docs/lens.md                                               # § Constraint Attachment — the proved/superkey paragraphs

# Strictly-more-restrictive basis behind a superkey logical key: a write-capacity realizability gap

## Context

Surfaced while fixing `lens-proved-superkey-basis-key-conflict-action-drop`. A logical
`unique(a, b)` over a basis carrying `unique(a)` is body-proved (`proveEffectiveKeyUnique`
proves any superset of the basis relation key `{a}`). The conflict-action fix stops the
silent drop of a declared `on conflict` action on this shape, but leaves a deeper mismatch
untouched:

```sql
declare schema y { table t (id integer primary key, a integer not null unique, b integer not null) }
declare logical schema x { table t (id integer primary key, a integer, b integer, unique (a, b)) }
declare lens for x over y { view t as select id, a, b from y.t }
```

The logical schema declares `unique(a, b)`, which **permits** two rows `(a=1, b=2)` and
`(a=1, b=3)` to coexist. The basis `unique(a)` **forbids** it. So the logical relation can
express states the basis cannot represent: the lens advertises more write-capacity than the
basis can hold. The logical key is *over*-enforced by the basis, not unenforceable — so this
is **not** a `lens.unrealizable-constraint` (that code is for a constraint that can be neither
proved nor enforced; this one is proved *and* over-enforced).

## Why it is a distinct concern

- The conflict-action fix is about *which action resolves a duplicate*; this is about *which
  states the logical relation can actually hold*.
- A write that is valid per the logical schema (insert `(1,3)` when `(1,2)` exists) is rejected
  by the basis — a surprise the logical declaration does not predict. The logical key
  under-constrains relative to the basis; equivalently the basis over-constrains the lens.

## Open questions to resolve

- Is this worth a dedicated deploy-time **advisory** (warning), e.g.
  `lens.over-constrained-basis` / `lens.under-constrained-key`, fired when a logical key is a
  strict superkey of a smaller declared basis key reachable through the body's column mapping?
  Or is it acceptable-as-designed (the basis is the source of truth; a tighter basis is the
  author's prerogative) and merely a documentation note?
- If an advisory: where does it sit in the ack/escalation governance vocabulary
  (`ADVISORY_CODE_LIST` in `lens-prover.ts`), and what is its fingerprint?
- Does the same shape arise for PK (logical PK a superset of a smaller basis UNIQUE) and for
  multi-source bodies, and should the advisory cover those?
- Interaction with the round-trip / realizability checklist in `docs/lens.md` § Coverage
  checklist — is this a new row there, or a sub-case of an existing check?

This is analysis/spec work, not a confirmed bug; promote to `plan/` (or directly to `fix/` if
a concrete defect is pinned) once prioritized.
