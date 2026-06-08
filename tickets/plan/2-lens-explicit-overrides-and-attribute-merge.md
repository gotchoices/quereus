description: Lens layer — `declare lens for X over Y { view T as <select>; ... }` parser surface and the per-attribute sparse override merger. Overrides are addressed by **stable attribute ID** (not name or position), so a lens override survives baseline regeneration. Merge happens at the relational-plan level via the existing attribute-provenance system, never at text. Design source: `docs/lens.md` § "Sparse Overrides".
prereq: lens-foundation-and-default-mapper
files: packages/quereus/src/schema/lens.ts, packages/quereus/src/schema/lens-compiler.ts, packages/quereus/src/parser/ast.ts, packages/quereus/src/parser/parser.ts, packages/quereus/src/planner/building/declare-schema.ts, packages/quereus/src/planner/nodes/, docs/lens.md, docs/optimizer.md, docs/schema.md
----

## Scope

This ticket lights up the **authoring** half of the lens layer: explicit `declare lens` overrides plus the per-attribute sparse-override merger. The other authoring half — module-level mapping advertisements — is backlogged (`lens-module-mapping-advertisement`).

The substrate from `lens-foundation-and-default-mapper` is assumed in place: `Schema.kind`, logical tables represented as views, the default name-based aligner. This ticket adds the override surface so a developer can rename / hide / compute / filter at the lens boundary **without** authoring the n-way join interior (which the default mapper supplies for uncovered attributes).

## Design

The full design is in `docs/lens.md` § "Sparse Overrides" and § "Computed and Generated Columns." The implementation surface follows.

### `declare lens` syntax

```sql
declare lens for X over Y {
  view Car as
    select id, speed as maxSpeed              -- rename override
    from Y.CarCore join Y.CarPerf using (id); -- other Car columns gap-filled
  -- tables of X not mentioned here are auto-mapped against Y entirely
}
```

- `for X` — the logical schema (must be `kind: 'logical'`).
- `over Y` — the default basis for any gap-filled attribute.
- `view T as <select>` — explicit override body for logical table `T`. The override may cover **only some** of `T`'s columns; the remainder are gap-filled by the default mapper from the previous ticket.
- Tables of `X` not mentioned in the lens block are fully auto-mapped against `Y` (same shape as the foundation ticket's behavior for an unbound logical schema).

A lens block is **identified by `(logical-schema, basis-schema)` pair**, not by name. Re-declaring an override for the same pair is an error (parse-time); editing requires drop + re-declare or `alter lens`. The simpler "single lens per (logical, basis)" rule keeps this ticket's surface small; `alter lens` is a polish item for later.

### Per-attribute sparse-override merge

The load-bearing algorithm. For each logical table `T`:

1. Plan the override `select` (if any) to a relational expression. Run it through the standard optimizer pipeline up to the point where **attribute provenance** is stable.
2. Read the override's output attributes; for each, identify which logical column it covers and from which basis expression. Coverage is by **stable attribute ID** (the `attribute-provenance-surface` ticket already lands this surface).
3. For each logical column **not covered** by the override, generate the mapping via the default mapper from the previous ticket.
4. **Compose:** stitch the override's output with the gap-filled defaults into a single effective `select` body. This composition is per-attribute, on the plan tree — Quereus has the full parser and attribute system; nothing happens at the text level.
5. Cache the result in the lens slot's `compiledBody`. The text representation is generated on demand for introspection (`show effective mapping`), never on the authored surface.

### Override shapes the merger must recognize

The lens doc enumerates these as the common boundary caps. The merger must handle each soundly:

- **Rename** — `select id, speed as maxSpeed from B.T`. Pure projection-with-alias; merge is trivial (the renamed attribute *covers* the logical column; other attributes are gap-filled).
- **Hide** — `select id from B.T` (when `T` also has `name` and `email`). Hidden columns are gap-filled by the default mapper — *unless* the developer's intent was to hide, in which case the gap-fill is wrong. Resolution: if a logical column has no matching attribute in the override AND the developer wants to suppress the gap-fill, they use a column hide directive `view T as select id from B.T hiding (name, email)`. Surface bikeshed; nail down in implement.
- **Compute** — `select id, first || ' ' || last as full_name from B.T`. The computed attribute covers the logical column with `computed` lineage (read-only). Writes to `T.full_name` through any reference are rejected by view-updateability machinery (already in place — `docs/view-updateability.md` § "The Update Site Model").
- **Filter** — `select * from B.T where active = true`. A read-time filter; *not* a write-time invariant (per `docs/view-updateability.md` § "Interaction with Constraints"). The merger treats it as a `where` clause on the effective body; the prover (next ticket) verifies the filter doesn't drop columns the logical spec requires.
- **Cross-basis join** — `select c.id, c.name, k.email from Y.Core c join Y.Contact k using (id)`. The override authors the interior; the default mapper does not get involved. The merger validates that the override's output covers the columns it claims to cover.
- **N-way override with shared-surrogate** — when the lens declares a surrogate-key shared by multiple basis tables, the merger threads the captured per-row value through every branch of the fan-out via the existing mutation-context envelope (`docs/view-updateability.md` § "Mutation Context"). This already works for views generally — nothing new at this ticket's level.

### Constraint attachment is **next** ticket

This ticket compiles the effective body. **Attaching** the logical spec's constraints onto that body — and routing their enforcement through covering structures vs commit-time scans — is the prover ticket's concern. v1 of this ticket compiles the body and leaves constraints in the lens slot's `attachedConstraints` field; the runtime does not yet treat them as enforced.

That means an MV under this ticket only is **read-correct, write-unsound** for logical-constraint enforcement. The prover ticket closes the gap; until it lands, document the limitation in `docs/lens.md` (status: "shipped — read; pending — write enforcement").

### `show effective mapping` introspection

Per `docs/lens.md` § "Sparse Overrides": the compiled effective mapping is inspectable on demand but never the authored surface. Surface as either:

- A TVF: `select * from quereus_effective_lens('X', 'Car')` returns the effective SQL text and per-attribute provenance.
- Or a pragma / catalog view.

Pick one in implement; the simpler TVF is preferred for symmetry with `query_plan()` and `explain_assertion()`.

### Override AST persistence and round-trip

The override `select` AST is stored verbatim in the lens slot for DDL round-trip via `ddl-generator.ts`. The compiled effective body is **regenerated** on every catalog load — it is a derived artifact, not the authored truth — so override + default-mapper changes recompose automatically without stale-cache hazards.

## Resolved Open Questions

- **Hide-vs-gap-fill ambiguity.** Surface an explicit `hiding (col1, col2)` clause on the override so the merger knows the developer intends to *suppress*, not *cover-from-default*. Names finalize in implement (bikeshed-safe alternatives: `omit (...)`, `exclude (...)`).
- **One lens per (logical, basis) pair.** Re-declaration is an error. Future `alter lens` is a polish item.
- **Effective-mapping introspection.** TVF `quereus_effective_lens(logical_schema, table_name)`.

## Out of scope (file in backlog/ after this lands)

- **Module-level mapping advertisements** — the modules-tell-the-aligner-how-to-decompose protocol. Lives in `lens-module-mapping-advertisement` (backlog).
- **`alter lens` mutations** — for now, drop + re-declare.
- **Constraint attachment / enforcement** — next ticket (`lens-prover-and-constraint-attachment`).
- **Engine-emitted backfill DDL for re-decompositions** — late-deployment polish.

## Implementation Surface

- `packages/quereus/src/parser/ast.ts` + `parser.ts` — `declare lens for X over Y { ... }` plus `view T as <select> [hiding (col, ...)]`. New AST nodes.
- `packages/quereus/src/planner/building/declare-schema.ts` — extend the build path to ingest lens blocks: identify `(logical, basis)` pair; reject re-declaration; plan each override body; persist the override AST plus the compiled effective body in the appropriate lens slot.
- `packages/quereus/src/schema/lens.ts` — extend `LensSlot` with override AST and the `hiding` set.
- `packages/quereus/src/schema/lens-compiler.ts` — extend the compiler (from the foundation ticket) with the per-attribute merger: optimize override → read attribute provenance → identify covered/uncovered logical columns → gap-fill via default mapper → compose into effective body.
- `packages/quereus/src/planner/nodes/` — small additions to support per-attribute composition. The composition is purely on existing relational primitives (projection, join), so probably no new node types.
- `packages/quereus/src/schema/ddl-generator.ts` — round-trip `declare lens for X over Y` from persisted override ASTs.
- New TVF `quereus_effective_lens(schema, table)` — wire in the function-registration path; output schema mirrors the body's effective shape plus a per-attribute provenance column.
- `docs/lens.md` — flip status from "designed" to "shipped" for the override + merge surface; document the `hiding` clause and the TVF.
- `docs/optimizer.md` — cross-reference the attribute-provenance consumption.
- `docs/schema.md` — extend with override syntax.

## Key Tests (TDD seeds for implement stage)

- **Rename override.** `view Car as select id, speed as maxSpeed from Y.CarCore` over a logical `Car(id, maxSpeed)` produces an effective body whose output binds `maxSpeed` to `Y.CarCore.speed`. Round-trip: parse → schema → DDL emit → re-parse → schema equivalent.
- **Hide via gap-fill default fail (the trap).** `view Car as select id from Y.CarCore` where `Car` also has `name` and `Y.CarCore` lacks `name` → compile errors naming `name` as uncovered.
- **Hide via `hiding`.** `view Car as select id, name from Y.CarCore hiding (maxSpeed)` over logical `Car(id, name, maxSpeed)` → compiles; reading `Car` projects only `id, name` and `maxSpeed` reads as null (or errors — finalize in implement; document in `docs/lens.md`).
- **Compute override.** `view User as select id, first || ' ' || last as full_name, first, last from Y.U` → `full_name` is read-only (writes rejected by view-updateability machinery already in place).
- **Filter override.** `view ActiveUser as select * from Y.U where active = true` → reads filtered; inserts into `ActiveUser` not auto-restricted to `active=true` (covered by view-updateability rules).
- **Cross-basis join override.** Multi-table override; effective body matches authored body verbatim; gap-fill is a no-op when all columns covered.
- **Sparse override + later schema add.** Declare logical schema with override covering only some columns; add a new column to the logical schema; deploy again; the new column is gap-filled by the default mapper without touching the authored override. The exact "renaming and later adding compose cleanly" example from `docs/lens.md`.
- **`quereus_effective_lens` TVF.** Returns the composed effective SQL plus per-attribute provenance for a chosen logical table.
- **DDL round-trip** through the declarative-equivalence harness.

## TODO (implement stage)

Phase A — parser
- `declare lens for X over Y { view T as <select> [hiding (...)] }` AST + parse.
- Build-time `(logical, basis)` uniqueness check.

Phase B — merger
- Extend `lens-compiler.ts` with per-attribute merge: optimize override → identify covered logical columns by stable attribute ID → gap-fill remainder → compose effective body → cache in lens slot.
- Handle each documented shape (rename, hide, compute, filter, cross-basis join) with targeted tests.

Phase C — introspection + persistence
- `quereus_effective_lens` TVF.
- DDL round-trip via `ddl-generator.ts`.

Phase D — docs + tests
- Update `docs/lens.md` § "Sparse Overrides" status to shipped.
- Test corpus per "Key Tests" above (sqllogic + declarative-equivalence + unit).
