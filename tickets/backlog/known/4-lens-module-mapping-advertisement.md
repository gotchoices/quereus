description: Module-level mapping advertisement protocol for the lens layer — the surface modules expose to say "these N basis tables are a columnar decomposition sharing surrogate key id" so the lens default mapper can generate the n-way join (or EAV gather, or column-family stitch) without the developer authoring the join interior. Without this protocol, the lens layer's default mapper is limited to single-source name-equivalent alignment.
prereq: lens-foundation-and-default-mapper
files: packages/quereus/src/vtab/module.ts, packages/quereus/src/schema/lens-compiler.ts, docs/lens.md, docs/module-authoring.md
----

## Why this is parked

The lens doc commits to module advertisements as load-bearing ("Advertisements can be primary, not supplementary" — `docs/lens.md` § "The Default Mapper"). They're the only sound way to support exotic basis layouts (columnar decomposition, EAV triples, column-family) without forcing the developer to author the join.

But the v1 lens shipping target is **MemoryTable + name-equivalent basis**, which doesn't exercise the protocol. Designing and implementing the advertisement surface before a real consumer would be speculative: the protocol's shape is best driven by the first non-trivial module that needs it (likely a columnar plugin or a sync-coordinator-backed module).

This ticket is parked here so it surfaces when that consumer arrives.

## What needs to be designed

When this promotes to plan, the design surface includes:

- **What modules advertise.** A typed shape on `VirtualTableModule` that describes:
  - "this set of basis tables jointly back logical table X with shared key K"
  - per-column mapping from logical-column-name → (basis-table, basis-expression)
  - the join shape (inner / outer per column, mandatory vs optional)
  - the shared-key generation strategy (`integer auto`, `uuid7()`, callback) and its cadence (per-row, per-statement)
- **How the lens compiler consumes it.** The aligner from `lens-foundation-and-default-mapper` becomes pluggable: name-matching is the fallback when no advertisement is present; an advertisement takes precedence and supplies both `get` (the join expression) and `put` (the fan-out shape + shared-key threading).
- **How `put` works for shared-surrogate decompositions.** The mutation-context envelope already provides the "evaluate once and thread" guarantee (`docs/view-updateability.md` § "Mutation Context"); the advertisement specifies which logical column is the shared surrogate, and the lens compiler emits the per-row binding that threads it through every branch.
- **How the lens prover validates advertisements.** GetPut / PutGet over an n-way decomposition is provable from FD facts, but the prover needs to reason over the advertisement's claimed shape, not just the resulting join.
- **Compatibility with `covering-structure-unique-enforcement`.** A covering MV over a decomposed basis must lookup into the right basis table(s).

## What the protocol must accommodate

These constraints come from surveying the consumer set (column-store decomposition, row-store hybrid backing, spatial / nd-tree access) before the protocol is designed. They are not the protocol itself — they are the shape it must admit.

1. **Storage shape and access shape are separate facets of an advertisement.** *Storage shape* drives `put`: decomposition, shared key, per-column placement, fan-out. *Access shape* drives `get` planning: the predicate forms the basis relation can serve efficiently. They need not be symmetric. A column-store decomposition has storage = N-way surrogate join, access = equi-join on the surrogate or value-range per column. An **nd-tree** has storage = a surrogate-keyed insert path identical in shape to the column stores it lives alongside, access = spatial predicates over a coordinate tuple. Without this separation the protocol forces equi-join framing onto modules whose efficient access isn't equi-join shaped.

2. **The access-shape vocabulary is extensible.** Built-ins should cover `equality`, `range`, `prefix`, `contains`, `intersects`, `kNN`. Modules declare which forms they serve over which columns, and the planner consults this during path selection. The motivating case is **nd-tree** (range / contains / kNN over a coordinate tuple), but vector-similarity, full-text, and time-series prefix modules land on the same mechanism — pinning a closed enum would force re-litigation as each arrives.

3. **The shared key may be a surrogate distinct from any logical column, and that's a first-class advertised property.** A column-store decomposition shares a substrate-managed `rowId` and carries the logical primary key as an ordinary value column; a single-table row store may share the logical primary key directly. The advertisement flags which: a *surrogate* shared key engages the per-row default evaluator before fan-out; a *logical-tuple* shared key collapses generation entirely because the key arrives mapped from the logical layer. Both must be expressible cleanly, and the distinction must surface to the lens compiler so it knows whether to drive surrogate generation.

4. **One basis relation in a decomposition is the existence anchor.** It is the preserved side for outer joins of value-only relations onto it, the delete source for "the logical row ceases to exist" (deleting from value-only relations leaves orphan cells that the substrate reclaims), and the relation a covering materialized view joins back through for unique enforcement. The advertisement must name the anchor explicitly rather than leaving it implicit in the join expression — the alternative is reverse-engineering it from outer-join structure, which is fragile and ambiguous when a logical column is `not null` and could otherwise stand in.

5. **A logical table can carry multiple advertisements composed together.** A logical `Spatial` table may be simultaneously backed by a column-store decomposition (primary storage), an nd-tree (spatial access path), and one or more covering materialized views (constraint enforcement / index access). The lens compiler routes writes to the primary decomposition's fan-out, selects access paths per query from the union of advertised access shapes, and validates constraints via the covering structures. The protocol must therefore admit several advertisements coexisting against one logical table rather than assuming a single advertisement per module per logical table — and must name which advertisement is the primary storage (for write fan-out) versus which are auxiliary access paths (for read-path selection only).

## References

- `docs/lens.md` § "The Default Mapper" (third bullet onward)
- `docs/lens.md` § "Constraint Attachment" (lens-attached set-level enforcement against decomposed basis)
- `docs/view-updateability.md` § "Mutation Context" (the shared-surrogate threading guarantee)
- `tickets/complete/...` once landed: the three lens plan tickets (`lens-foundation-and-default-mapper`, `lens-explicit-overrides-and-attribute-merge`, `lens-prover-and-constraint-attachment`)
