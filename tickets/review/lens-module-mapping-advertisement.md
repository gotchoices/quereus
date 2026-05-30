description: Review the module mapping-advertisement protocol — the typed descriptor a vtab module exposes to tell the lens default mapper how its basis relations decompose a logical table, the reserved-tag vocabulary + shared builder generic modules assemble advertisements from, and the lens-compiler resolution + validation + slot-storage + introspection seam. Protocol only — the n-way join synthesis + put fan-out that CONSUME a resolved advertisement land in `lens-multi-source-decomposition`. Mirrors the IND-foundation Wave-1 pattern: surface made ready + validated here, consumer lands next.
prereq:
files: packages/quereus/src/vtab/mapping-advertisement.ts, packages/quereus/src/vtab/module.ts, packages/quereus/src/schema/reserved-tags.ts, packages/quereus/src/schema/mapping-advertisement-tags.ts, packages/quereus/src/schema/lens.ts, packages/quereus/src/schema/lens-compiler.ts, packages/quereus/src/func/builtins/explain.ts, packages/quereus/src/vtab/memory/module.ts, packages/quereus-store/src/common/store-module.ts, packages/quereus/src/index.ts, packages/quereus/test/lens-advertisement.spec.ts, packages/quereus/test/schema/reserved-tags.spec.ts, docs/lens.md
----

## What shipped

The protocol seam for module-advertised logical→basis decomposition. **No synthesis** — a resolved advertisement is *stored* on the lens slot; the v1 name-match / override body producer is unchanged. `lens-multi-source-decomposition` reads `slot.advertisement` to build the n-way join + put fan-out.

### Phase 1 — descriptor + module surface
- **New `packages/quereus/src/vtab/mapping-advertisement.ts`** — the full descriptor: `MappingAdvertisement` (`id` / `logicalTable` / `role` / `storage` / `access`), `StorageShape` (anchor + members + sharedKey), `DecompositionMember` (presence + per-column mappings or EAV `attributePivot`), `LogicalColumnMapping`, `SharedKey` (surrogate vs logical-tuple, `keyColumnsByRelation`, generator), `SharedKeyGenerator`, `AccessForm` (open string union), `AccessShape`, `AttributePivot`, `BasisRelationRef`. Each field's doc ties it to the accommodation constraint it satisfies.
- **`vtab/module.ts`** — optional `getMappingAdvertisements?(db, basisSchema)` on `VirtualTableModule` (module-level, returns every decomposition; presence is the capability — no new `ModuleCapabilities` flag).

### Phase 2 — reserved-tag vocabulary + builder
- **`schema/reserved-tags.ts`** — new `physical-table` `TagSite` + the `quereus.lens.decomp.*` family (11 templated specs: `logical`/`role`/`anchor`/`member`/`presence`/`keykind`/`key`/`generator`/`gencadence`/`col`/`pivot`). Facet leads the key so each is a single-placeholder registry template; enums validated (`role`, `presence`, `keykind`, `generator`, `gencadence`), `key` is csv-of-identifiers.
- **New `schema/mapping-advertisement-tags.ts`** — `buildAdvertisementsFromTags(basisSchema)` assembles advertisements from the distributed tags; validates the decomp subset through `validateReservedTags(..., 'physical-table')` (malformed tag → atomic deploy abort). Memory (`vtab/memory/module.ts`) and store (`quereus-store/src/common/store-module.ts`) modules return it. Exported from `index.ts` (`buildAdvertisementsFromTags`, `Schema`, all descriptor types).

### Phase 3 — resolution + validation + storage
- **`schema/lens.ts`** — `LensSlot.advertisement?` / `LensSlot.auxiliaryAccess?`; `LensColumnProvenance.advertisedBy?` (the backing member relationId).
- **`schema/lens-compiler.ts`** — `resolveAdvertisement` in the compile-first loop of `deployLogicalSchema` (collect distinct modules → call each → dedup by id → filter to table → select single primary → validate). Validation (aggregated, atomic, sited): `id === anchorRelationId`; anchor is a member; every member relation + mapped basis column + pivot column + shared-key column exists; surrogate ⇒ generator present, logical-tuple ⇒ generator absent + per-member key arity == logical PK arity; column coverage (exactly-one-member / EAV / name-match) when no override. Override-vs-advertisement re-anchor conflict validated for sparse overrides; provenance annotated with the backing member.

### Phase 4 — introspection + docs
- **`func/builtins/explain.ts`** — `quereus_effective_lens` gains `advertised_member` + `advertisement_anchor` columns (additive; existing rows unchanged).
- **`docs/lens.md`** — Implementation-Surface bullet flipped to **shipped (protocol only)**; new § "The module mapping advertisement (protocol)" covering the descriptor, the two facets, the IND existence-anchor contract, and override composition; TVF column table updated.

## How to exercise / validate

`packages/quereus/test/lens-advertisement.spec.ts` (15 cases, all passing) is the floor:
- **Resolution + storage** — a 3-member columnar split stored as `slot.advertisement` (primary) + an nd-tree as `slot.auxiliaryAccess`; the IND contract (`id === storage.anchorRelationId`); a no-advertisement deploy leaves `slot.advertisement` undefined (name-match untouched).
- **Validation errors (atomic)** — anchor not a member; missing member relation; basisExpr → missing column; two primaries; surrogate w/o generator; logical-tuple w/ generator; an advertisement claiming the table but leaving a column unbacked+uncovered. Each asserts the slot was NOT created (atomicity).
- **Override composition** — a rename over an advertised column keeps the advertisement stored + records `advertised_member` provenance; a sparse override whose FROM references a non-member relation errors with the conflict named.
- **Tag builder** — `quereus.lens.decomp.*` tags over `mem()` tables resolve to the equivalent advertisement (anchor-first member order, presence, per-column mappings, key); a bad enum value fails through `validateReservedTags`.
- **Introspection** — `quereus_effective_lens` surfaces `advertised_member` / `advertisement_anchor` per column.

Build + suites: `yarn workspace @quereus/quereus run build` (tsc clean), full quereus suite **3904 passing / 0 failing**, `yarn workspace @quereus/quereus run lint` clean, `@quereus/store` builds + **274 passing**.

## Known gaps / seams the reviewer should probe

- **`plan-node.ts` `IndTarget` cross-link is DEFERRED, not done.** The ticket asked to cross-link the `id ⇄ IndTarget.kind:'relation'.relationId` contract in `plan-node.ts`'s `IndTarget` doc-comment — but `IndTarget` / `InclusionDependency` **do not exist in the codebase yet** (`optimizer-inclusion-dependency-foundation`, seq `1-`, is still in `tickets/implement/`). I did NOT fabricate the type. The contract is documented in `mapping-advertisement.ts` (`MappingAdvertisement.id` doc), in `resolveAdvertisement`'s `id === anchorRelationId` check, and in `docs/lens.md`. **Action when the IND foundation lands:** add the reciprocal cross-link to its `IndTarget` doc-comment.
- **Multi-member advertisement does NOT drive the body in this ticket.** A logical table whose *only* backing is a multi-member advertisement (no name-match table, no override) still FAILS at body compilation (`compileDefaultBody`: "no basis backing"). This is by design (synthesis is next) — the tests provide a name-match table (or an override) so the body compiles while the advertisement rides along. Reviewer should confirm this is the intended seam and that the failure mode is acceptable until `lens-multi-source-decomposition`.
- **The optional degenerate single-member `logical-tuple` "drive the trivial projection" was NOT implemented** (the ticket flagged it as scope-creep-risky; I asserted resolution+validation+storage only).
- **Override conflict check is relation-membership only.** It catches a sparse override whose FROM references a relation outside the advertised decomposition (re-anchor). It does NOT detect a contradiction in the *join key itself* (members joined on a different key than the advertised shared key) — deferred to the synthesis ticket, which builds the join and can compare keys. Confirm this is a sound subset.
- **Auxiliary-access validation is minimal** — only that member relations resolve; the `AccessShape` predicate forms are stored unvalidated (the planner consumer is the deferred backlog `lens-access-shape-path-selection`).
- **`IsolationModule` does not forward `getMappingAdvertisements`.** When memory/store is wrapped by `IsolationModule`, tag-derived advertisements would be missed (the wrapper's `vtabModule` has no method). Out of scope here; flag if isolation + lens decomposition is needed downstream.
- **EAV provenance attribution** is best-effort: a column with no explicit member mapping is attributed to the *sole* EAV pivot member when exactly one exists.

## ⚠️ Unrelated working-tree changes (NOT part of this ticket)

Two files were modified in the working tree **during my session by some process other than me** (the start-of-session git status was clean; I never touched these files):
- `packages/quereus/src/planner/analysis/constraint-extractor.ts` — a relation-key casing fix (lowercases the instance key in `createTableInfoFromNode`).
- `packages/quereus/test/optimizer/change-scope-analyzer.spec.ts` — a regression test for that fix.

They compile, lint, and pass (they were present during the green full-suite run). I left them untouched (I did not author them and reverting could destroy intended work). **The reviewer / runner should decide whether they belong here** — they are unrelated to the advertisement protocol and, if the runner commits the whole working tree, will be conflated into this ticket's commit.
