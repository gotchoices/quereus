description: Module mapping advertisement protocol — the typed surface a virtual-table module exposes to tell the lens default mapper how its basis relations decompose a logical table (columnar split / EAV / column-family / nd-tree). Delivers the descriptor types, the module-interface method, the reserved-tag vocabulary a generic module assembles advertisements from, and the lens-compiler **resolution + validation + slot storage + introspection** seam. Does NOT synthesize the n-way join or put fan-out — that is `lens-multi-source-decomposition`, which consumes the resolved advertisement this ticket stores. Mirrors the IND-foundation pattern: the surface is made ready and validated here; the synthesis consumer lands next. Design source: `docs/lens.md` § "The Default Mapper".
prereq: lens-foundation-and-default-mapper
files: docs/lens.md, packages/quereus/src/vtab/module.ts, packages/quereus/src/vtab/capabilities.ts, packages/quereus/src/schema/lens.ts, packages/quereus/src/schema/lens-compiler.ts, packages/quereus/src/schema/reserved-tags.ts, packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/src/func/builtins/explain.ts
----

## Use case

The v1 default mapper (`lens-foundation-and-default-mapper`, shipped) aligns a logical table to a *single* basis table purely by name (`compileDefaultBody` in `lens-compiler.ts`). That only works when one basis relation surfaces the logical column names. Real storage decomposes:

- **Columnar split** — one logical table over several basis tables sharing a key.
- **EAV / triple store** — generic `(entity, attribute, value)` rows; no basis column carries the logical column's name.
- **Column-family** — value columns named generically.
- **nd-tree** — a coordinate-tuple access path that lives alongside a column-store insert path.

For these, name/type/structure matching is insufficient and the **module** must be the alignment source. The advertisement is load-bearing in both directions: `get` (the join fan-out shape + which basis relation backs each logical column) and `put` (the same fan-out + the shared key, so an insert reaches every member and a surrogate is evaluated once and threaded).

## Scope boundary (read first)

This ticket is the **protocol**, not the synthesis. It is the lens analogue of `optimizer-inclusion-dependency-foundation` Wave 1: the descriptor surface is defined, resolved, validated, and stored, and made introspectable — but no body-synthesis consumer reads it here. The single-source name-match path in `compileDefaultBody` is **unchanged** by this ticket.

| This ticket | `lens-multi-source-decomposition` (next) |
|---|---|
| Descriptor types (`MappingAdvertisement` + facets) | Reads `slot.advertisement` → synthesizes the n-way `get` join (anchor preserved-side, outer/inner per `presence`, key-equi-join) |
| `VirtualTableModule.getMappingAdvertisements?` method | Surrogate generation + evaluate-once-and-thread through `put` fan-out |
| Reserved-tag vocabulary + shared tag→advertisement builder | Emits the injected `InclusionDependency` (`kind:'relation'`) per mandatory member onto the anchor `relationId` this ticket mints |
| Compiler **resolution** (collect, match-to-logical-table, select primary) | — |
| Compiler **validation** (malformed advertisement errors atomically at deploy) | — |
| `LensSlot.advertisement` / `auxiliaryAccess` storage + `quereus_effective_lens` surfacing | — |
| **Override-vs-advertisement composition rules** (specified + conflict-validated here; gap-fill *execution* lands next) | Advertisement-driven gap-fill execution |

Keeping the slug `lens-module-mapping-advertisement` so `lens-multi-source-decomposition`'s `prereq:` resolves.

## Architecture

### The descriptor (new `packages/quereus/src/vtab/mapping-advertisement.ts`)

A module advertises how a set of *its* basis relations jointly back a logical table. The two facets are **separate and need not be symmetric** (accommodation #1): *storage shape* drives `put`; *access shape* drives `get` planning. An nd-tree's storage shape is a surrogate-keyed insert path identical to the column stores beside it, while its access shape is spatial predicates over a coordinate tuple.

```typescript
/** How a set of a module's basis relations decomposes one logical table. */
export interface MappingAdvertisement {
  /** Stable symbolic id, unique within the basis schema. This is the existence
   *  anchor's `relationId` — the target an injected IND (IndTarget.kind:'relation',
   *  reserved by optimizer-inclusion-dependency-foundation) points at. Minted by the
   *  module (dedicated) or by the tag builder (generic) from the anchor relation. */
  readonly id: string;
  /** Logical table this decomposition backs, matched case-insensitively by the
   *  resolver against the logical declaration. */
  readonly logicalTable: string;
  /** primary-storage drives write fan-out (at most one per logical table — accommodation #5);
   *  auxiliary-access is a read-path-only structure (nd-tree, covering MV, vector index). */
  readonly role: 'primary-storage' | 'auxiliary-access';
  /** Drives put (and the get join). Required on primary-storage. */
  readonly storage?: StorageShape;
  /** Drives read-path selection. Defined + stored here; its planner consumer is the
   *  deferred `lens-access-shape-path-selection` (backlog). */
  readonly access?: AccessShape;
}

export interface StorageShape {
  /** The existence anchor (accommodation #4): preserved side for outer joins of
   *  value-only members, the delete source for "the logical row ceases to exist",
   *  and the relation a covering MV joins back through. Named explicitly — never
   *  reverse-engineered from outer-join structure. Must be one of `members`. */
  readonly anchorRelationId: string;
  /** Every basis relation in the decomposition, including the anchor. */
  readonly members: readonly DecompositionMember[];
  readonly sharedKey: SharedKey;
}

export interface BasisRelationRef { readonly schema: string; readonly table: string; }

export interface DecompositionMember {
  /** Member's symbolic id (the anchor's equals StorageShape.anchorRelationId). */
  readonly relationId: string;
  readonly relation: BasisRelationRef;
  /** mandatory ⇒ inner-joined onto the anchor (every logical row has it);
   *  optional ⇒ outer-joined (a logical row may lack it). */
  readonly presence: 'mandatory' | 'optional';
  /** logical-column-name -> the basis expression on THIS relation backing it. A
   *  member may back many columns (column-family), one (columnar), or none beyond
   *  identity (pure existence anchor). EAV members use `attributePivot` instead. */
  readonly columns: readonly LogicalColumnMapping[];
  /** EAV / triple-store member: logical columns are rows keyed by an attribute
   *  literal, not basis columns. Defined for completeness; the resolver validates
   *  its shape, the synthesis ticket builds the pivot. */
  readonly attributePivot?: AttributePivot;
}

export interface LogicalColumnMapping { readonly logicalColumn: string; readonly basisExpr: AST.Expression; }

export interface SharedKey {
  /** accommodation #3 — first-class, surfaces to the compiler so it knows whether
   *  to drive surrogate generation:
   *  - 'surrogate': a substrate-managed key distinct from any logical column.
   *    Engages the per-row default evaluator before fan-out (evaluate-once-and-thread,
   *    docs/view-updateability.md § Mutation Context). Requires `generator`.
   *  - 'logical-tuple': the shared key IS the logical PK, arriving mapped from the
   *    logical layer. Generation collapses entirely; `generator` must be absent. */
  readonly kind: 'surrogate' | 'logical-tuple';
  /** Per-member key columns the equi-join uses (a surrogate may be spelled
   *  differently across relations). Keyed by member relationId. */
  readonly keyColumnsByRelation: ReadonlyMap<string, readonly string[]>;
  readonly generator?: SharedKeyGenerator;
}

export interface SharedKeyGenerator {
  readonly strategy: 'integer-auto' | 'uuid7' | 'callback';
  /** per-row mints a distinct value per produced logical row; per-statement binds
   *  once for the statement (docs/view-updateability.md § Mutation Context cadences). */
  readonly cadence: 'per-row' | 'per-statement';
  /** callback: the basis-level default expression/function evaluated at insert. */
  readonly expr?: AST.Expression;
}

/** Extensible (accommodation #2) — string-typed with built-in constants, NOT a
 *  closed enum, so vector-similarity / full-text / time-series forms land without
 *  re-litigating the type. Built-ins: */
export type AccessForm = 'equality' | 'range' | 'prefix' | 'contains' | 'intersects' | 'knn' | (string & {});

export interface AccessShape {
  /** Which predicate forms this decomposition serves efficiently over which
   *  columns (or coordinate tuple). The nd-tree case is `{ columns: [x,y,z],
   *  forms: ['range','contains','knn'] }`. */
  readonly served: readonly { readonly columns: readonly string[]; readonly forms: readonly AccessForm[] }[];
}

export interface AttributePivot {
  readonly entityColumn: string;     // basis column = logical row identity
  readonly attributeColumn: string;  // basis column = logical column name
  readonly valueColumn: string;      // basis column = the value
}
```

### Module-interface method (`vtab/module.ts`)

```typescript
/** Optional. Returns the logical→basis decompositions this module recognizes over
 *  the given basis schema. A dedicated module (columnar/EAV/nd-tree) synthesizes
 *  from its own knowledge; a generic module (memory/store) delegates to the shared
 *  tag builder over its tables' reserved tags. Consulted by the lens compiler's
 *  resolver. Omit ⇒ name-match only (today's behavior). */
getMappingAdvertisements?(db: Database, basisSchema: Schema): readonly MappingAdvertisement[];
```

A module spans many tables, and a decomposition spans many relations, so the method is **module-level given the basis schema** (not per-table) — it returns every decomposition it recognizes; the resolver indexes them. No new `ModuleCapabilities` flag is needed (presence of the method is the capability), but document the method beside `getCapabilities` in `capabilities.ts`'s orbit.

### Reserved-tag vocabulary + shared builder (`schema/reserved-tags.ts` + a helper)

Generic modules don't intrinsically know decompositions; the metadata lives in reserved tags on the basis tables, validated by the existing typed registry. Add a `quereus.lens.decomp.*` family (TagSite `physical-table`) and a shared `buildAdvertisementsFromTags(basisSchema): MappingAdvertisement[]` the memory/store modules return from `getMappingAdvertisements`. Tag facts needed per decomposition `<id>`: the member set, which member is the anchor, `presence` per member, the shared-key kind + per-member key columns + generator, and the per-column logical→basis mapping. Finalize exact key spellings against `reserved-tags.ts` conventions during implementation; register each with `validateReservedTags` shape/site checking so a malformed tag fails the same atomic path `validateLensTags` already uses.

### Compiler resolution + validation (`schema/lens-compiler.ts`)

In `deployLogicalSchema`, **before** body compilation, add `resolveAdvertisement(logicalTable, basis, db)`:

1. **Collect.** For each module owning ≥1 table in the basis schema, call `getMappingAdvertisements?(db, basisSchema)`. Flatten, filter to `logicalTable` (case-insensitive).
2. **Select primary.** At most one `role:'primary-storage'` may match a logical table (accommodation #5) — two is an error. The remainder are `auxiliary-access`.
3. **Validate** (each blocks the deploy atomically, before catalog mutation — same contract as `validateLensTags`, errors aggregated and thrown):
   - anchor `anchorRelationId` is among `members`;
   - every member `relation` resolves to a real basis table; every `LogicalColumnMapping.basisExpr` references columns that exist on its member;
   - every logical column of the table is backed by exactly one member's mapping (or an `attributePivot`) **or** left to override/name-match — an advertisement that claims the table but leaves a column unbacked and uncovered errors, naming the column;
   - `sharedKey.kind:'surrogate'` ⇒ `generator` present; `'logical-tuple'` ⇒ `generator` absent **and** `keyColumnsByRelation` maps to the logical PK columns;
   - `keyColumnsByRelation` covers every member and each named key column exists;
   - `attributePivot`'s three columns exist on the member.
4. **Store** on the slot (below). Resolution failure leaves existing lens state untouched (atomic deploy preserved).

The single-source name-match (`compileDefaultBody`) remains the body producer this ticket. When an advertisement resolves, it is **stored, not yet synthesized** — `lens-multi-source-decomposition` reads it. (Exception, optional: a degenerate single-member `logical-tuple` advertisement is semantically identical to name-match and may be allowed to drive the trivial projection to exercise the seam end-to-end; if that risks scope creep, leave it for the synthesis ticket and assert resolution+validation only.)

### LensSlot storage (`schema/lens.ts`)

```typescript
/** The resolved primary-storage advertisement, if a module advertised a
 *  decomposition for this logical table. Consumed by lens-multi-source-decomposition
 *  to synthesize the n-way get join + put fan-out. undefined ⇒ name-match/single-source. */
advertisement?: MappingAdvertisement;
/** Auxiliary access-path advertisements (nd-tree, vector, covering structures).
 *  Stored here; the planner path-selection consumer is deferred (backlog
 *  lens-access-shape-path-selection). */
auxiliaryAccess?: readonly MappingAdvertisement[];
```

### Override-vs-advertisement composition (specified here; gap-fill executed next)

An `declare lens` override is still the sparse patch keyed by logical-column-name (`compileOverrideBody`). Composition rules with an advertisement (accommodation: "an explicit override composes with and can correct an advertised mapping"):

- An override **corrects** an advertised column mapping the same way it corrects a name-match: a covered column wins; a rename caps the boundary.
- An uncovered column gap-fills from the **advertisement's per-column mapping** when one is present (richer than name-match) — *this gap-fill execution lands in `lens-multi-source-decomposition`*; this ticket specifies the rule and validates conflicts.
- An override may **not** silently re-anchor or change the shared key: if the override's FROM/join contradicts the advertisement's anchor or shared-key relations, error (the developer must drop to a full hand-authored body, which then bypasses the advertisement entirely). Validate this conflict here.

### IND existence-anchor contract

The `id` the module/builder mints **is** the `relationId` that `lens-multi-source-decomposition` will pass to `InclusionDependency` with `IndTarget.kind:'relation'` (reserved in `optimizer-inclusion-dependency-foundation`). This ticket's only obligation is that the id is **stable and unique within the basis schema** and equals `StorageShape.anchorRelationId` — so the injected INDs and the join the next ticket builds agree on which relation is the anchor. Document the contract in `plan-node.ts`'s `IndTarget` doc-comment (cross-link) and in `docs/lens.md`.

### Introspection (`func/builtins/explain.ts`)

Extend `quereus_effective_lens(schema, table)` (or note for a sibling TVF) so the resolved advertisement is inspectable: at minimum surface, per logical column, whether its provenance is advertisement-backed and which member/anchor backs it. Keep it additive to the existing provenance rows.

## Accommodation-constraint checklist (from the ticket — confirm each is admitted by the type surface)

1. **Storage vs access facets separate** — `StorageShape` (put) and `AccessShape` (get planning) are distinct optional members; an nd-tree carries `access` with `storage` identical-in-shape to its column-store siblings. ✔
2. **Access vocabulary extensible** — `AccessForm` is `string & {}`-widened, built-ins enumerated, not a closed enum. ✔
3. **Surrogate vs logical-tuple shared key first-class** — `SharedKey.kind` flags it; surrogate requires a generator and engages the per-row evaluator, logical-tuple collapses generation. ✔
4. **One member is the existence anchor, named explicitly** — `StorageShape.anchorRelationId`, validated to be a member. ✔
5. **Multiple advertisements per logical table** — a list per module, resolver selects the single `primary-storage`, keeps the rest as `auxiliary-access`. ✔

## Key tests

- **Resolution.** A dedicated test module advertising a 3-member columnar split for logical `T` resolves to one `primary-storage` advertisement stored on the slot; a second module advertising an nd-tree for `T` resolves to one `auxiliary-access` entry.
- **Validation errors (atomic, before catalog mutation, named site):** anchor not among members; a member relation that doesn't exist; a `basisExpr` referencing a missing basis column; two `primary-storage` advertisements for one logical table; `surrogate` key with no generator; `logical-tuple` key carrying a generator; an advertisement claiming `T` but leaving a logical column unbacked and uncovered.
- **Tag builder.** A basis schema with `quereus.lens.decomp.*` tags over `mem()` tables produces the equivalent advertisement via `buildAdvertisementsFromTags`; a malformed tag fails through the existing `validateReservedTags` path.
- **Override composition.** An override renaming one advertised value column resolves with the advertisement still stored and the rename recorded in provenance; an override whose FROM contradicts the advertised anchor/shared-key errors with the conflict named.
- **IND anchor id contract.** The minted `id` equals `StorageShape.anchorRelationId` and is unique within the basis schema (unit assertion the synthesis ticket relies on).
- **Introspection.** `quereus_effective_lens` surfaces advertisement-backed provenance for a resolved decomposition.
- **No regression.** Every existing single-source `lens-foundation` test passes unchanged (no advertisement ⇒ name-match path untouched).

## TODO (implement)

### Phase 1 — descriptor + module surface
- New `packages/quereus/src/vtab/mapping-advertisement.ts`: `MappingAdvertisement`, `StorageShape`, `DecompositionMember`, `LogicalColumnMapping`, `SharedKey`, `SharedKeyGenerator`, `AccessForm`, `AccessShape`, `AttributePivot`, `BasisRelationRef` — with sibling-style doc comments tying each field to the accommodation constraint it satisfies.
- Add `getMappingAdvertisements?(db, basisSchema)` to `VirtualTableModule` (`vtab/module.ts`); document beside the other optional hooks.
- Cross-link the `id` ⇄ `IndTarget.kind:'relation'.relationId` contract in `plan-node.ts`'s `IndTarget` doc-comment.

### Phase 2 — reserved-tag vocabulary + shared builder
- Add the `quereus.lens.decomp.*` family (TagSite `physical-table`) to `schema/reserved-tags.ts` with shape/site specs.
- Implement `buildAdvertisementsFromTags(basisSchema): MappingAdvertisement[]`; have memory (`vtab/memory/module.ts`) and store modules return it from `getMappingAdvertisements`.
- Unit tests: tag round-trip → advertisement; malformed tag → `validateReservedTags` error.

### Phase 3 — compiler resolution + validation + slot storage
- Add `advertisement?` / `auxiliaryAccess?` to `LensSlot` (`schema/lens.ts`).
- Implement `resolveAdvertisement(...)` in `lens-compiler.ts` (collect → select primary → validate → store), invoked in the compile-first loop of `deployLogicalSchema` alongside `validateLensTags`; aggregate errors and throw atomically before catalog mutation.
- Specify + enforce the override-vs-advertisement conflict rule (re-anchor / shared-key contradiction errors); record advertisement provenance where an override corrects a mapping.
- Tests per "Key tests" (resolution, every validation error, override composition, IND id contract).

### Phase 4 — introspection + docs
- Extend `quereus_effective_lens` (`func/builtins/explain.ts`) to surface advertisement-backed provenance.
- `docs/lens.md`: flip the "Module mapping advertisement" Implementation-Surface bullet from pending to shipped (protocol only; synthesis still pending in `lens-multi-source-decomposition`); document the descriptor, the two facets, the anchor-id ⇄ IND contract, and the override-composition rules under § "The Default Mapper".
- Run `yarn workspace @quereus/quereus run build`, the lens specs, and lint (single-quote globs on Windows) before handoff.
