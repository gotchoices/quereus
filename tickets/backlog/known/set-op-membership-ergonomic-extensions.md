description: Future ergonomic extensions to set-operation membership columns — a flat n-way shorthand (one membership flag per leaf without writing the nesting) and a multiplicity-aware (count) membership variant for `union all`. Both are non-gating nice-to-haves parked out of the core read/write/nested chain.
prereq: set-op-membership-nested
files: packages/quereus/src/parser/parser.ts, packages/quereus/src/parser/ast.ts, packages/quereus/src/planner/nodes/set-operation-node.ts, docs/sql.md, docs/view-updateability.md
----

## Concept

The core set-op membership feature (`set-op-membership-read` / `-write` / `-nested`) ships the
**nested binary** form as the sound baseline: each binary combinator names its own two immediate
operands with `exists left as <col>` / `exists right as <col>`, and the general n-way case is reached
by nesting. These two extensions are ergonomic sugar on top of that — desirable, not required.

### 1. Flat n-way shorthand

A single non-nested set-op chain (`A union B union C`) currently exposes membership only by
rewriting it as an explicit nesting. A flat shorthand would expose **one flag per leaf** without the
nesting — which needs per-leg leaf labels (a per-leg `… as branch <name>`, or positional). It must
desugar to exactly the same `existence` sites the nested form produces (so the read derivation and
write fan-out are unchanged — this is sugar over the same substrate). Resolve the labeling syntax
(named vs positional) and the desugaring rule when promoting.

### 2. `union all` multiplicity-aware membership

The core feature defines a `union all` membership flag as boolean "present ≥ once in that branch"
(bag multiplicity collapses to a set probe). A multiplicity-aware variant would expose the **count**
of occurrences in each branch (and define write semantics for it — e.g. `set countB = n`). This is a
distinct value shape (integer, not boolean) and a distinct write contract; scope it separately if
the demand materializes.

## Why backlog, not gating

The nested binary form is the complete, sound baseline; both items are pure ergonomics layered on
identical substrate. Promote when a concrete use case demands the flat shorthand's brevity or the
count variant's multiplicity, and resolve the open syntax/semantics choices at that point.
