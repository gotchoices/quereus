description: Lens layer foundation — `Schema.kind: 'physical' | 'logical'`, `declare logical schema X { ... }` parser surface, lens-slot data model per logical table, default name-based aligner that generates the inlined view body over a default basis. No override syntax yet (separate ticket), no prover (separate ticket), no module advertisements (backlog). Lands the substrate that the next two lens tickets build on. Design source: `docs/lens.md`.
prereq: view-updateability-implementation
files: packages/quereus/src/schema/schema.ts, packages/quereus/src/schema/table.ts, packages/quereus/src/schema/lens.ts, packages/quereus/src/schema/lens-compiler.ts, packages/quereus/src/parser/ast.ts, packages/quereus/src/parser/parser.ts, packages/quereus/src/planner/building/declare-schema.ts, packages/quereus/src/schema/ddl-generator.ts, packages/quereus/src/schema/schema-differ.ts, packages/quereus/src/schema/schema-hasher.ts, docs/lens.md, docs/schema.md, docs/architecture.md
----

**Prereq note.** `docs/lens.md` opens by saying "A lens is the bidirectional-transformation (`get`/`put`) pair that Quereus's view updateability already provides." A May-2026 code audit confirmed view-updateability is **designed-only** — `docs/view-updateability.md` is timeless prose, but no `updateLineage`, no propagation pass, no per-operator `propagateMutation` exists; today views are read-only and `test/logic/93.1-view-error-paths.sqllogic` § 2 enforces it. The `view-updateability-implementation` plan ticket lifts the doc into a concrete implementation plan; **phase 1 of that ticket** (single-source projection-and-filter with constant-FD default recovery) is the minimum lens-foundation can build on. The prereq is wired accordingly.

## Scope

The lens layer separates a Quereus database into three relational layers: **logical** (developer's design, embodiment-free), **basis** (module-backed relations, possibly federated), and **mapping** (per-logical-table lens slots). The full design is in `docs/lens.md` — substantial, decided. What's left for plan is to lock the AST, the schema data model, and the default-mapper algorithm enough to enter implement.

This ticket lands the foundation: the schema kind, the logical-schema parser, and the default mapper. With this in place, a logical schema deploys against a name-equivalent basis with **no explicit lens needed** — the default mapper generates the inlined effective view body and the rest of the engine sees ordinary views.

Explicit `declare lens` overrides land in `lens-explicit-overrides-and-attribute-merge`. The completeness prover lands in `lens-prover-and-constraint-attachment`. Module-level mapping advertisements (the protocol that lets a columnar/EAV module advertise a custom default mapping) is backlogged.

## Design

The architecture is fully specified in `docs/lens.md`. This section pins down the *implementation* shape.

### `Schema.kind`

```ts
interface Schema {
  // ... existing fields ...
  readonly kind: 'physical' | 'logical';
}
```

- `'physical'` is today's behavior: tables may carry `using module(...)`, indexes, storage tags. This is the default for any `Schema` created without an explicit kind.
- `'logical'` rejects, at parse / build time, every physical construct: module association, indexes, storage hints. Tables in a logical schema carry only columns, types, and *logical* constraints (PK, UNIQUE, CHECK, FK, NOT NULL). Tags are allowed (engine-facing metadata; survive into the compiled view).

The rejection lives in `packages/quereus/src/planner/building/declare-schema.ts`, in the existing `declare schema { ... }` build path. Error messages name the offending construct and the logical-schema context.

### Logical-table representation

A logical table is represented like a view (full constraints, deferred body) so downstream code follows the existing `isView` path. In `packages/quereus/src/schema/table.ts`:

- `vtabModule` becomes optional.
- A new `isLogical: boolean` discriminator (parallel to `isView`) — a logical table is *neither* an MV nor a base table; it's a lens-compiled view.
- Reuse the existing `viewDefinition` slot to hold the **compiled effective body** (a `QueryExpr` over basis relations), populated by the default mapper (this ticket) or by the override merger (next ticket).

This piggybacks on the existing view-as-relation infrastructure: `select` from a logical table resolves through the same code path as `select` from a view. The query processor sees an ordinary view — exactly what `docs/lens.md` calls "the query processor sees an ordinary view." No new runtime; all the work is compile-time.

### Lens slot

Per logical table, a slot:

```ts
interface LensSlot {
  // What's stored
  override?: AST.SelectStmt;   // explicit body (this ticket: always undefined)
  defaultBasis: SchemaRef;     // which basis to align against
  compiledBody: AST.QueryExpr; // the effective body — populated by the compile step
  attachedConstraints: ReadonlyArray<LogicalConstraint>; // for the prover/attachment ticket
}
```

Lives in `packages/quereus/src/schema/lens.ts`. The slot is populated at lens-compile time (the deploy compile step from `docs/lens.md` § Deployment). For this ticket, `override` is always undefined and `attachedConstraints` is the spec verbatim (not yet routed to enforcement).

### `declare logical schema` parser

```sql
declare logical schema X {
  table Car (
    id int primary key,
    maxSpeed int,
    ...
  );
}
```

Reuses the existing `declare schema` infrastructure plus the new `logical` keyword. The differ / hasher (`schema-differ.ts`, `schema-hasher.ts`) already process declare-schema content; they need to learn `kind` for logical-only validation rules (no module, no index).

Lens binding (`declare lens for X over Y`) is **not** parsed by this ticket — it lands in `lens-explicit-overrides-and-attribute-merge`. Without an explicit lens, the compile step uses the default basis named (a) via an out-of-source binding (CLI / config flag / engine option), or (b) for the MVP, the **single physical schema in scope** when exactly one exists. If zero or multiple physical schemas exist with no binding, the deploy errors clearly.

### Default name-based aligner

The default mapper is the algorithm that, given a logical schema `L` and a basis schema `B`, produces the inlined effective body per logical table. v1 is **name-based only**:

For each logical table `L.T`:

1. Find a basis table `B.T'` whose name matches (case-insensitive, lowercase per Quereus convention).
2. For each logical column `L.T.c`, find a basis column `B.T'.c` (same name).
3. Build the effective body as `select <projected columns> from B.T'`.

Failure cases (errors at compile / deploy, with clear diagnostics):

- No basis table matches by name → "logical table `L.T` has no basis backing"; nameable in the override surface (next ticket).
- A column has no matching basis column → "logical column `L.T.c` has no basis backing".
- A basis column's logical type / nullability is incompatible with the logical column's declaration → defer the *full* compatibility check to the prover ticket (`lens-prover-and-constraint-attachment`); at this ticket's level surface the basis type as-is and let downstream validation catch incompatibilities.

The n-way decomposition shape (`docs/lens.md` § Default Mapper, third bullet — "Optional components are outer-joined") is the future-shape but **not v1**: v1 is single-source name-equivalent. Decomposition awaits the module-mapping-advertisement protocol (backlog).

### Empty / singleton primary key handling

The lens doc's fourth bullet on default mapper ("empty key (singleton) is the degenerate case") is **already handled** by the shipped FD framework (the `[]` empty-key carries through `keysOf`). v1 default mapper inherits this for free — `select` from a `primary key ()` logical table over a `primary key ()` basis table is a single-source projection like any other.

### Computed / generated columns

Standing computed columns (those re-evaluated on every read) are a lens-`get`-level concern: a logical-table column whose lens body is `first || ' ' || last` over basis columns `first, last`. The default mapper has **no way to know** a logical column is computed (no syntax in v1); computed columns require explicit override syntax and land in `lens-explicit-overrides-and-attribute-merge`. For now the default mapper assumes every logical column has a name-matched basis column.

### Deployed-basis hash & basis-asymmetric removals

`docs/lens.md` § Deployment specifies the basis is hash-coded and diffs are additive: a logical-removal does **not** drop basis storage. This integrates with the existing `schema-hasher.ts` / `schema-differ.ts`. The asymmetry needs a one-bit add: when a logical table is removed, the differ emits a "detach lens" diff and not a "drop basis table" diff. The basis side is unchanged.

One-shot backfill DDL emission for re-decompositions ("when the new basis can be populated by running the new lens `get` over the prior basis") is **out of v1's scope**; v1 ships with backfills as the application's responsibility, exactly as the declarative-schema pipeline already supports.

## Resolved Open Questions

- **Single-binding vs multi-binding default basis.** v1: explicit binding goes through `declare lens for X over Y` (next ticket) or is inferred when exactly one physical schema is in scope. Zero / multiple → error with a clear "supply `declare lens for X over Y`" hint.
- **Validation severity for type-conformance mismatches.** Defer to the prover ticket; this ticket lets them through with a basis-type-as-is projection and a warning. The prover then errors.
- **Logical-removal cascade to basis.** Confirmed asymmetric: never cascades. The detached basis column stays until GC'd separately.

## Out of scope (file in backlog/ after this lands)

- **Module mapping advertisement protocol** — the surface modules expose to say "these five basis tables are a columnar decomposition sharing key id." Lives in `lens-module-mapping-advertisement` (backlog).
- **Multi-source n-way decomposition default mapping** — depends on the advertisement protocol.
- **Engine-emitted backfill DDL for re-decompositions** — second-phase deployment polish.
- **`declare lens for X over Y { ... }` override syntax** — next ticket.
- **The completeness prover and constraint attachment** — separate ticket downstream.

## Implementation Surface

- `packages/quereus/src/schema/schema.ts` — `kind: 'physical' | 'logical'`.
- `packages/quereus/src/schema/table.ts` — `vtabModule` optional; `isLogical` discriminator; reuse `viewDefinition` for the compiled effective body.
- `packages/quereus/src/schema/lens.ts` (new) — `LensSlot` and helpers.
- `packages/quereus/src/schema/lens-compiler.ts` (new) — the default name-based aligner; produces the inlined `QueryExpr` per logical table.
- `packages/quereus/src/parser/ast.ts` + `parser.ts` — `declare logical schema X { ... }` production. Reuses most of the existing declare-schema machinery; the keyword `logical` enables the kind discriminator and the physical-construct rejection.
- `packages/quereus/src/planner/building/declare-schema.ts` — extend to reject physical constructs under `kind: 'logical'` with named diagnostics; invoke the lens compiler at apply time.
- `packages/quereus/src/schema/ddl-generator.ts` — round-trip `declare logical schema` from the catalog.
- `packages/quereus/src/schema/schema-differ.ts` + `schema-hasher.ts` — `kind`-aware diffing; logical-removals-don't-drop-basis asymmetry; reuse the deployed-basis hash machinery.
- `docs/lens.md` — update the Implementation Surface section as items land; status flips from "designed" to "shipped."
- `docs/schema.md` — extend with the kind discriminator and the logical-schema rules.
- `docs/architecture.md` — register the new lens-foundation chapter in the doc map.

## Key Tests (TDD seeds for implement stage)

- **Logical-schema declaration parses + builds.** A minimal `declare logical schema X { table T (id int primary key); }` builds a `Schema` with `kind: 'logical'` and a logical table with no `vtabModule`.
- **Physical-construct rejection.** Each of `using mem()`, `create index`, and storage tags under a logical schema errors with a clear diagnostic naming the construct.
- **Default mapper aligns identically-shaped logical+basis.** `declare logical schema X { table T (id int primary key, name text); }` + a name-equivalent basis `T(id int pk, name text)` produces a compiled lens body `select id, name from <basis>.T` and a working `select * from X.T`.
- **Name mismatch errors.** Logical column not present in basis → compile error naming the column.
- **Empty-key / singleton.** `table Config (theme text)` with `primary key ()` over a basis `Config(theme text) primary key ()` works end-to-end (no surrogate, no special path).
- **Round-trip.** Declare logical schema → emit DDL → re-parse → schema equivalent (rides the `declarative-equivalence` harness — `test/declarative-equivalence.spec.ts`).
- **Basis hash is asymmetric to logical removals.** Drop a logical table → basis hash unchanged; differ emits a detach-lens diff, not a drop-basis-table diff.
- **Default-binding inference.** Logical schema with one physical schema in scope → auto-binds; logical schema with zero physical → error with "supply `declare lens for X over Y`" hint.

## TODO (implement stage)

Phase A — schema kind + logical-table data model
- Add `Schema.kind`; default `'physical'` for backward compatibility.
- Add `TableSchema.isLogical`; make `vtabModule` optional; reuse `viewDefinition` for the compiled body slot.
- Add `LensSlot` in `schema/lens.ts`.

Phase B — parser + builder
- `declare logical schema X { ... }` parser production.
- Build-time rejection of physical constructs under `kind: 'logical'`.
- DDL round-trip in `ddl-generator.ts`.

Phase C — default mapper
- `schema/lens-compiler.ts`: name-based aligner producing the inlined effective body per logical table.
- Default-basis inference (single-physical-schema-in-scope).
- Wire compile-at-deploy via the existing declarative-schema apply path.

Phase D — differ / hasher integration
- `kind`-aware diffing.
- Asymmetric removal: detach lens, never drop basis.
- Extend the hash to cover logical-side declarations.

Phase E — docs + tests
- Update `docs/lens.md`'s Implementation Surface (status: shipped for items in this ticket; pending for next-ticket items).
- Extend `docs/schema.md` with the kind discriminator and logical rules.
- Test corpus per "Key Tests" above (sqllogic + declarative-equivalence + unit).
