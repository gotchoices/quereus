description: Module mapping-advertisement protocol — the typed descriptor a vtab module exposes so the lens default mapper learns how its basis relations decompose a logical table, the reserved-tag vocabulary + shared builder generic modules assemble advertisements from, and the lens-compiler resolution + validation + slot-storage + introspection seam. Protocol only; synthesis (n-way join + put fan-out) lands in `lens-multi-source-decomposition`.
files: packages/quereus/src/vtab/mapping-advertisement.ts, packages/quereus/src/vtab/module.ts, packages/quereus/src/schema/reserved-tags.ts, packages/quereus/src/schema/mapping-advertisement-tags.ts, packages/quereus/src/schema/lens.ts, packages/quereus/src/schema/lens-compiler.ts, packages/quereus/src/func/builtins/explain.ts, packages/quereus/src/vtab/memory/module.ts, packages/quereus-store/src/common/store-module.ts, packages/quereus/src/index.ts, packages/quereus/test/lens-advertisement.spec.ts, packages/quereus/test/schema/reserved-tags.spec.ts, docs/lens.md
----

## What shipped

The protocol seam for module-advertised logical→basis decomposition. A resolved primary-storage advertisement is **stored** on `LensSlot.advertisement` (auxiliaries on `LensSlot.auxiliaryAccess`); the v1 name-match / override body producer is unchanged. `lens-multi-source-decomposition` consumes the slot to build the n-way join + put fan-out.

- **Descriptor** (`src/vtab/mapping-advertisement.ts`) — `MappingAdvertisement` + `StorageShape` / `AccessShape` (separate, asymmetric facets), `DecompositionMember`, `SharedKey` (surrogate vs logical-tuple), `SharedKeyGenerator`, `AttributePivot`, `AccessForm` (open union).
- **Module hook** (`vtab/module.ts`) — optional `getMappingAdvertisements(db, basisSchema)`; presence is the capability.
- **Tag vocabulary + builder** (`schema/reserved-tags.ts` new `physical-table` site + `quereus.lens.decomp.*` family; `schema/mapping-advertisement-tags.ts` `buildAdvertisementsFromTags`). Memory + store modules delegate to it.
- **Resolution / validation / storage** (`schema/lens-compiler.ts` `resolveAdvertisement`) — collect → dedup by id → filter to table → select single primary → aggregated, atomic, sited validation; stored on the slot.
- **Introspection** (`func/builtins/explain.ts`) — `quereus_effective_lens` gains `advertised_member` + `advertisement_anchor` (additive).
- **Docs** (`docs/lens.md`) — new § "The module mapping advertisement (protocol)" + TVF column table + Implementation-Surface status.

## Review findings

Reviewed the full implement diff (`70fa883e`) with fresh eyes, then re-derived the seams from the handoff. Build (quereus + store), lint, and the full suite were re-run green; untested validation branches were exercised with a throwaway probe spec (since deleted) before forming the verdict.

### Validation re-run (all green)
- `yarn workspace @quereus/quereus run build` — tsc clean.
- `yarn workspace @quereus/store run build` — clean (confirms the new `index.ts` exports `buildAdvertisementsFromTags` / `Schema` / descriptor types resolve for an external module).
- `yarn workspace @quereus/quereus run lint` — exit 0.
- Full quereus suite (`node test-runner.mjs`) — **3904 passing / 0 failing / 9 pending**.
- Touched specs in isolation (lens*, schema/reserved-tags, optimizer/change-scope-analyzer) — 109 passing.

### Correctness — checked, no defects found
Probed every validation branch the implementer's 15 cases left uncovered; **all fire correctly and atomically** (slot not created on failure): shared-key column non-existent on a member; logical-tuple per-member key arity ≠ logical PK arity; ambiguous column backing (two members map one logical column); auxiliary-access advertisement with a missing member relation; surrogate-key-via-tags end-to-end (generator + cadence assembled from `generator.<id>` / `gencadence.<id>`). The compile-first ordering genuinely makes a malformed advertisement (and a malformed `quereus.lens.decomp.*` tag, via `validateReservedTags`) abort before any catalog mutation — verified by asserting the slot is absent after each throw. The `quereus_effective_lens` TVF column arity matches its yield (5 columns / 5 values, additive — existing rows unchanged). The IND existence-anchor contract (`id === storage.anchorRelationId`) is enforced and the implementer correctly did NOT fabricate the not-yet-existent `IndTarget` type (documented cross-link is deferred to when `optimizer-inclusion-dependency-foundation` lands).

### Edge cases / interactions — minor, documented (no code change)
- **Full override that re-anchors away from the advertised decomposition still stores + annotates the advertisement.** A *full* hand-authored override (no gap-fill) is — by design — not conflict-checked, so it may legally read from relations outside the decomposition. But the advertisement is still resolved, stored on the slot, and `annotateProvenanceWithAdvertisement` still labels every column with `advertised_member`. Result: `quereus_effective_lens` reports e.g. `advertised_member: T_core` for columns the body actually sources from `Other` (probe-confirmed: body returns the `Other` rows while provenance points at `T_core`). The docs say a full override "bypasses the advertisement entirely," so the introspection is mildly inconsistent with that. **Disposition: documented, not fixed** — the existing intentional test (`override renaming an advertised value column`) deliberately wants override-sourced-but-aligned columns annotated, and distinguishing an *aligned* full override from a *re-anchored* one requires per-column body-source analysis that genuinely belongs to `lens-multi-source-decomposition` (where advertisement-vs-override precedence becomes load-bearing). Flagged there as a seam: the synthesis ticket must decide whether a full override suppresses the stored advertisement (for both body and introspection).
- **`collectAdvertisements` rescans the whole basis schema once per distinct module.** A generic module's `getMappingAdvertisements` (memory / store) calls `buildAdvertisementsFromTags(basisSchema)`, which scans *all* tables — not just the module's own. With two generic modules in one schema this is O(modules × tables) redundant work, and a memory module will build advertisements from `decomp` tags on store-owned tables (and vice-versa). The `id` dedup collapses the duplicates and advertisements are module-agnostic relation refs, so it is harmless — but conceptually loose and a latent perf footgun on wide schemas. Minor; left as-is for the protocol landing.

### Major — filed as new ticket
- **`IsolationModule` does not forward `getMappingAdvertisements`** → `tickets/backlog/lens-isolation-module-advertisement-forwarding.md`. The isolation wrapper delegates explicitly and lacks this optional hook, so a memory/store basis table wrapped by isolation silently drops its tag-derived advertisements. No effect today (synthesis deferred; absent advertisement just falls back to name-match), but it will silently disable decomposition under isolation once the consumer lands. Filed as backlog (future-facing) rather than fixed inline.

### Deferred-by-design — confirmed sound
- Multi-member advertisement with no name-match table and no override fails body compilation with `lens: logical table '…' has no basis backing` (probe-confirmed). Intended seam until synthesis; acceptable failure mode.
- Override join-key contradiction (members joined on a different key than the advertised shared key) is not detected — only relation-membership re-anchor is. Sound subset; the synthesis ticket builds the join and can compare keys.
- Auxiliary-access predicate forms (`AccessShape`) are stored unvalidated (planner consumer is backlog `lens-access-shape-path-selection`).
- The degenerate single-member `logical-tuple` "drive the trivial projection" was intentionally not implemented (resolution+validation+storage only).
- EAV provenance attribution is best-effort (sole-pivot heuristic) — acceptable for the protocol.

### Docs — checked against the new reality
`docs/lens.md` accurately describes the descriptor, the two facets, the IND existence-anchor contract, override composition, and the new TVF columns; the Implementation-Surface status is correctly flipped to **shipped (protocol only)**. The only gap is the "bypasses the advertisement entirely" wording vs. the still-annotated-under-full-override behavior noted above — left for the synthesis ticket to reconcile rather than soften the doc now.

### ⚠️ Unrelated changes conflated into the implement commit (no action)
`70fa883e` also carries two files unrelated to this ticket — `src/planner/analysis/constraint-extractor.ts` (lowercase-canonicalize the relation instance key in `createTableInfoFromNode`) and its regression test `test/optimizer/change-scope-analyzer.spec.ts`. The implementer flagged them as authored by another process mid-session. **Reviewed:** the change is a genuine, correct bug fix (every other relation-key builder in the change-scope pipeline lowercases; this one didn't, silently widening single-PK equality watches on non-lowercase table names to whole-table scope) with a pinning regression test, and both compile/lint/pass. Left untouched — reverting would destroy a legitimate fix — but recorded here so the conflation is on the record.

## Pre-existing failures
None. The full suite is green at this SHA; no `.pre-existing-error.md` written.
