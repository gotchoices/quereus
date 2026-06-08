description: Lens layer completeness prover (PutGet / GetPut) plus constraint attachment — closes the loop where the compiled effective lens body is *proven* to honor the logical spec, and the logical spec's constraints become *real* enforcement at the lens boundary. Set-level constraints route through a covering structure (`covering-structure-unique-enforcement`) when present, else through commit-time `DeltaExecutor`. Row-local constraints (`not null`, `check`) enforce at the projected row. The legacy `LayerManager.ensureUniqueConstraintIndexes` auto-build behavior is retired *for logical schemas*: a logical `unique` creates no structure; the developer adds an explicit basis covering MV if they want O(log n) enforcement. Acknowledgement infrastructure for the `lens.no-backing-index` advisory. Design source: `docs/lens.md` § "Constraint Attachment", § "Coverage checklist", § "Acknowledging advisories".
prereq: lens-explicit-overrides-and-attribute-merge, covering-structure-unique-enforcement
files: packages/quereus/src/schema/lens.ts, packages/quereus/src/schema/lens-prover.ts, packages/quereus/src/schema/table.ts, packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/src/planner/analysis/, packages/quereus/src/core/database-assertions.ts, packages/quereus/src/runtime/delta-executor.ts, docs/lens.md, docs/optimizer.md, docs/schema.md, docs/materialized-views.md
----

## Scope

The capstone for the lens layer. With this ticket landed, a developer can:

- Declare a logical schema `X` and have its constraints enforced correctly when reads / writes flow through `X`'s lens, whether or not the basis carries a covering structure.
- See the prover's coverage checklist surface — errors that block the deploy, warnings that are advisory, advisories that can be acknowledged in source via a reserved tag with a required rationale.
- Watch the lens-prover advisories re-surface when the facts behind a prior acknowledgement materially change (fingerprint mismatch).

The legacy `ensureUniqueConstraintIndexes` auto-index path is **retired for logical schemas** as part of this ticket — the lens doc's "Departures and Non-Goals" entry on auto-index. Physical schemas keep the auto-index behavior (via the implicit-MV reframe from `covering-structure-unique-enforcement`). The flip is a one-bit guard on `Schema.kind`.

## Design

The full design is in `docs/lens.md`. What's left is to lock the prover algorithm, the constraint-attachment routing, and the acknowledgment-tag mechanics enough for implement.

### Constraint attachment, by class

For each logical constraint declared on a logical table `T`, decide at lens-compile time:

- **Body proves it** → mark as `obligation: proved`. The optimizer surface (the unified `keysOf` / `isUnique` from `unified-key-inference-surface`) already exposes the FD/key facts the body carries. The prover checks that the body's facts subsume the logical declaration. Zero enforcement cost at runtime; the optimizer gets the fact as a contribution. *Example:* spec declares `unique(x, y)`, body is `group by x, y`.
- **Body does not prove it** → mark as `obligation: enforced` and route to one of:
  - **Row-local** (`not null`, scalar `check` whose lineage is non-`computed`): evaluable on the projected row being written. Enforces at the lens boundary via the existing per-row check pipeline.
  - **Set-level** (`unique`, primary key): existence lookup against the **basis covering structure** when one exists (O(log n), row-time, conflict-resolution-capable). Otherwise fall back to the commit-time group/global `DeltaExecutor` scan (O(n), detection-only). This is the exact `findIndexForConstraint` → `CoveringStructure` path landed by `covering-structure-unique-enforcement`; the lens-attachment side just calls into it.
  - **Foreign key** (cross-relation existence): always commit-time `DeltaExecutor`. A covering structure on the referenced relation is optional and used when present.
- **Body proves the constraint is *vacuous* given the lens predicate** (e.g. spec says `not null` and the body has `where col is not null` plus a non-nullable basis): trivially satisfied; no attachment.

### Coverage prover (errors)

For every logical aspect of `T`, run the corresponding check. Each error blocks the deploy with a clear, sited diagnostic.

| Check | What it asks |
|---|---|
| **Column coverage** | Every logical column of `T` resolves to a basis expression (override-covered or default-mapper gap-filled). |
| **Type / nullability conformance** | Each mapped column's basis-derived type and nullability satisfy the logical declaration. A nullable basis expression under a `not null` logical column errors unless a total default or guard supplies a value. |
| **Constraint realizability** | Each logical constraint is either proved by the body or attachable as enforcement. A constraint referencing a `computed`-lineage column (no write path) errors. |
| **Key reconstructibility** | For a writable logical table, the logical primary key is reconstructible at the lens boundary. Otherwise the table is read-only and any mutation errors at the lens. |
| **Round-trip (lens laws)** | GetPut / PutGet hold over the writable fragment. An override whose `put` is non-invertible and undisambiguated errors, naming the operator/column (reuse existing `docs/view-updateability.md` § "Diagnostics" surface). |

The prover is a consumer of the unified `keysOf` / `isUnique` surface plus the FD framework. Most of the inference is already shipped; the prover *applies* it to a specific question per logical aspect.

### Coverage prover (warnings)

| Check | Advisory code |
|---|---|
| **No backing index for a set-level constraint** | `lens.no-backing-index` — the constraint enforces via O(n) commit-time scan; recommend an explicit basis covering MV (`covering-structure-unique-enforcement` shape). |
| **No answering structure for a declared access pattern** | `lens.no-answering-structure` — a tag (`quereus.lens.access.<col>`) declared an expected lookup/ordering and no basis ordering/index serves it. |
| **Partial override** | `lens.partial-override` — informational: which columns were authored by the override and which were gap-filled by the default mapper. |

Warnings flow through the same compile-result channel and are surfaced in the deploy summary. They never block.

### Acknowledgment infrastructure

The lens doc commits to specific mechanics; this ticket implements them.

- **Coded + sited.** Each advisory has a stable code and a logical site (table + optional constraint or column). Acknowledgements target one site.
- **Reserved tag.** `quereus.lens.ack.<code>` on the logical table or constraint suppresses *that* advisory from the default report. The tag value is a **required rationale** (empty rationale → meta-warning).
- **Tallied.** Deploy summary always reports `acknowledged: N` and expands on demand. The compile result keeps the full acknowledged list available for tooling.
- **Fingerprinted.** The prover computes a fingerprint per acknowledged advisory from the facts behind it (constraint columns, presence/absence of a covering structure, a coarse cardinality band, …). The tooling records the fingerprint when the ack is written. If the fingerprint changes later (cardinality crosses a band, a covering MV is dropped, constraint columns evolve), the advisory **re-surfaces as un-acknowledged**, flagged *"previously acknowledged; situation changed."* This is the anti-fatigue guarantee.
- **Escalation policy.** A deploy policy (per-engine option or per-schema tag) promotes specific codes:
  - `error-on: [code]` — always a hard error; ack cannot suppress.
  - `require-ack: [code]` — un-acknowledged instance errors; valid acknowledged instance clears. The sweet spot for `lens.no-backing-index`: forces a conscious decision without blocking the developer who has genuinely accepted the commit-time scan.

The fingerprint storage is the only piece of meaningful new persistence. Options:

- Store per-acknowledgment in a sibling artifact (`.tess/lens-ack-fingerprints.json` shaped) — outside source control, easy to regenerate. Risk: silent fingerprint reset.
- Store in the schema-export DDL alongside the tag — survives round-trip, no separate artifact. Slightly noisier DDL.

Decision deferred to implement; lean toward the second for the same reason the lens doc keeps acks in-source ("version-controlled and shows up in review").

### Retiring `ensureUniqueConstraintIndexes` for logical schemas

In `vtab/memory/layer/manager.ts:80`, the auto-build behavior is gated:

- Physical schema → preserves today's behavior (the implicit-MV reframe from `covering-structure-unique-enforcement` keeps the dispatch surface clean).
- Logical schema → does **nothing**. The logical `unique` contributes only the FD/key signal to the optimizer; if the developer wants O(log n) enforcement they author an explicit basis covering MV.

The legacy auto-index path remains the test bedrock for physical schemas. Logical-schema tests use the explicit-covering-MV path or accept the commit-time `DeltaExecutor` scan. Adding `lens.no-backing-index` as the advisory for the latter is exactly the warning surface this ticket lights up.

### Read-only / write-correct status across the three lens tickets

After this ticket lands:

- `lens-foundation-and-default-mapper` (shipped): read-correct, write-unsound for logical-constraint enforcement.
- `lens-explicit-overrides-and-attribute-merge` (shipped): read-correct with overrides, write-unsound for logical-constraint enforcement.
- `lens-prover-and-constraint-attachment` (this ticket): read-correct *and* write-sound. Lens layer is genuinely usable end-to-end.

This is worth documenting prominently in `docs/lens.md` so a user adopting lenses incrementally understands what they're getting at each release.

## Resolved Open Questions

- **Fingerprint storage.** Lean toward in-DDL (alongside the ack tag); finalize in implement. Out-of-band JSON sibling is acceptable but documented as opt-in.
- **Default escalation policy.** Out of the box, no codes are escalated (`error-on: []`, `require-ack: []`). Projects that want stricter behavior opt in via per-schema tags or engine options.

## Out of scope (file in backlog/ after this lands)

- **Module-level mapping advertisement protocol** — backlog (`lens-module-mapping-advertisement`). Without it, the prover cannot reason about EAV / columnar decomposition coverage; v1 covers only name-equivalent + single-source-per-table cases.
- **Engine-emitted backfill DDL for re-decompositions** — late-deployment polish.
- **Auto-promote computed-column to backfilled basis** — promoting a standing computed column to stored basis is a one-shot derivation (`docs/lens.md` § "Computed and Generated Columns"). The engine could synthesize the backfill DDL; that's a polish item.
- **Lens-layer cross-schema (logical-to-logical) lenses** — out of v1.

## Implementation Surface

- `packages/quereus/src/schema/lens-prover.ts` (new) — the coverage-checklist runner. Errors block the lens compile; warnings flow through.
- `packages/quereus/src/schema/lens.ts` — extend `LensSlot` with `obligations: ReadonlyArray<ConstraintObligation>` post-prover, plus the acknowledgment fingerprint store.
- `packages/quereus/src/schema/table.ts` — logical-table constraint records get a `lens.boundary.attached` flag once attached, so the runtime knows enforcement is alive at the lens.
- `packages/quereus/src/vtab/memory/layer/manager.ts` — gate `ensureUniqueConstraintIndexes` on `Schema.kind === 'physical'`. Logical schemas skip the auto-build entirely.
- `packages/quereus/src/planner/analysis/` — extend the constraint-extraction pipeline to read `attachedConstraints` from a lens slot when planning over a logical-table reference. The lens body inlines into the plan, so the constraint surface from the logical spec rides through the same FD-contribution path as any other declared constraint.
- `packages/quereus/src/core/database-assertions.ts` — set-level constraints that fall back to commit-time enforcement piggyback on the existing assertion-evaluator path. No new commit-phase consumer.
- `packages/quereus/src/runtime/delta-executor.ts` — no kernel changes; this ticket *consumes* the existing surfaces.
- `docs/lens.md` — flip § "Constraint Attachment" and § "Coverage checklist" status to "shipped"; add a "read-only / write-correct status" note for what the three lens tickets deliver. Update "Departures and Non-Goals" entry on auto-index to reflect the actual gating shipped.
- `docs/optimizer.md` — note the lens-attached-constraint contributions to the FD framework.
- `docs/schema.md` — extend with the acknowledgment-tag surface and the escalation policy options.
- `docs/materialized-views.md` — cross-reference: explicit covering MV is the recommended response to `lens.no-backing-index`.

## Key Tests (TDD seeds for implement stage)

- **Body-proves: vacuous enforcement.** `unique(x, y)` over a body `select x, y, sum(z) from B.T group by x, y` → marked `proved`; no runtime check; FD contributed.
- **Body-doesn't-prove, with covering MV: row-time.** `unique(email)` over a body `select * from B.U`; an explicit `create materialized view ix_u_email as select email, id from B.U order by email`; insert duplicate email → row-time conflict (IGNORE / REPLACE / ABORT all work).
- **Body-doesn't-prove, no covering MV: commit-time.** Same as above without the MV; insert duplicate email → commit-time `DeltaExecutor` scan errors with the existing assertion-style diagnostic; ABORT semantics (IGNORE / REPLACE rejected with "row-time conflict resolution requires a covering structure").
- **Row-local: `check` on a non-`computed` column.** Enforces at the lens boundary for inserts / updates; a write that violates raises at the lens-write boundary, not at commit.
- **Coverage error: uncovered logical column.** Deploy errors; named column in diagnostic.
- **Coverage error: type/nullability mismatch.** Deploy errors; named column + expected vs basis type.
- **Coverage error: writable PK not reconstructible.** Deploy errors for a non-trivial-aggregate-body logical-table; the table compiles read-only; any mutation errors with the named diagnostic.
- **`lens.no-backing-index` advisory.** Logical schema with `unique(x)` and no covering MV → advisory in deploy summary.
- **Ack tag suppresses the advisory.** `with tags ("quereus.lens.ack.no-backing-index" = 'low-write table, commit-time scan accepted')` → advisory acknowledged; deploy summary tallies it.
- **Empty ack rationale is itself a warning.** `with tags ("quereus.lens.ack.no-backing-index" = '')` → meta-warning per the lens doc.
- **Fingerprint re-surface.** Acknowledge; later drop the (covering MV or change constraint columns or cross a cardinality band) → advisory re-surfaces flagged "previously acknowledged; situation changed."
- **Escalation `require-ack`.** Set `require-ack: [lens.no-backing-index]`; un-acked instance → deploy errors; valid ack clears.
- **Logical schema skips `ensureUniqueConstraintIndexes`.** `declare logical schema X { table T (id int primary key, email text unique); }` deploys *without* an implicit BTree on `email`. Insertion path still works (commit-time scan); explicit covering MV upgrades to row-time.
- **Physical schema unchanged.** Every existing physical-schema UNIQUE test still passes.

## TODO (implement stage)

Phase A — prover
- New `lens-prover.ts`. Implement the 5 errors + 3 warnings from the coverage checklist over the unified `keysOf` / `isUnique` / FD surface.
- Surface a clear diagnostic shape: code, site (table + optional constraint/column), severity, fingerprint inputs.

Phase B — attachment + routing
- For each logical constraint, decide `proved` / `enforced-row-local` / `enforced-set-level` / `enforced-fk` at lens-compile.
- Set-level → call into `findIndexForConstraint` (from `covering-structure-unique-enforcement`) and emit row-time or commit-time enforcement accordingly.
- Row-local → wire into the existing per-row check pipeline at the lens-write boundary.
- FK → commit-time `DeltaExecutor` path (no kernel change).

Phase C — acknowledgment
- Reserved tag parser + validation (rationale required).
- Fingerprint computer (initial set of inputs: constraint columns, presence of covering structure, cardinality band).
- Deploy summary surface (counts, expand-on-demand).
- Escalation policy parser (per-schema tag or engine option).

Phase D — retire auto-index for logical schemas
- Gate `ensureUniqueConstraintIndexes` on `Schema.kind === 'physical'`.
- Update `docs/lens.md` § "Departures and Non-Goals" entry to match the actually-shipped gating.

Phase E — docs + tests
- Flip `docs/lens.md` § "Constraint Attachment" + § "Coverage checklist" to shipped status; add the "read-only / write-correct" maturity note.
- Update `docs/optimizer.md`, `docs/schema.md`, `docs/materialized-views.md` cross-refs.
- Test corpus per "Key Tests" above (sqllogic + declarative-equivalence + per-prover-check unit tests + an end-to-end "deploy a logical schema and exercise it through inserts/updates/deletes" scenario suite).
