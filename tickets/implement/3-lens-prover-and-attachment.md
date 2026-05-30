description: Lens coverage prover (5 errors + 3 warnings) + constraint attachment/routing (proved / row-local / set-level / foreign-key) + retire `ensureUniqueConstraintIndexes` for logical schemas. Makes the lens layer read-correct AND write-sound. A logical constraint declared on a logical table is either proved-vacuous by the body, or routed to live enforcement at the lens boundary (row-local check, row-time covering-structure lookup, or commit-time DeltaExecutor scan). Errors block the deploy; warnings surface in a new deploy report channel. Acknowledgment governance (ack tags, fingerprints, escalation) is the sibling ticket `lens-advisory-acknowledgment`. Design source: `docs/lens.md` § "Constraint Attachment", § "Coverage checklist".
prereq: lens-explicit-overrides-and-attribute-merge, covering-structure-unique-enforcement, reserved-tag-namespace-typed-registry
files: packages/quereus/src/schema/lens-prover.ts, packages/quereus/src/schema/lens.ts, packages/quereus/src/schema/lens-compiler.ts, packages/quereus/src/schema/table.ts, packages/quereus/src/planner/analysis/coverage-prover.ts, packages/quereus/src/planner/util/fd-utils.ts, packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/src/runtime/emit/schema-declarative.ts, packages/quereus/src/core/database-assertions.ts, docs/lens.md, docs/optimizer.md, docs/materialized-views.md
effort: xhigh
----

## Scope

The first half of the lens capstone: the prover that proves/blocks, the
attachment that makes writes sound, and the retirement of the legacy auto-index
for logical schemas. After this ticket lands, a developer can declare a logical
schema and have its constraints **enforced correctly** through the lens — whether
or not the basis carries a covering structure. The acknowledgment/escalation
governance layer (the anti-fatigue half) is the sibling `lens-advisory-acknowledgment`.

**Read-only / write-correct status this ticket flips** (document prominently in
`docs/lens.md`):
- `lens-foundation-and-default-mapper` (shipped): read-correct, write-unsound for logical-constraint enforcement.
- `lens-explicit-overrides-and-attribute-merge` (shipped): read-correct with overrides, write-unsound for logical-constraint enforcement.
- **this ticket**: read-correct *and* write-sound. Lens layer is genuinely usable end-to-end.

## Current state (verified, do not re-discover)

- `packages/quereus/src/schema/lens.ts` — `LensSlot` already carries
  `attachedConstraints: ReadonlyArray<LogicalConstraint>` (verbatim, **unrouted**)
  built by `buildLogicalConstraints(logicalTable)`. `LogicalConstraint` is a
  discriminated union over `primaryKey | check | unique | foreignKey`. This is
  the input to the prover; the prover annotates each with an obligation.
- `packages/quereus/src/schema/lens-compiler.ts` — `deployLogicalSchema(db, declaredSchema, name)`
  returns `void`. It compiles-first (atomic deploy: all tables align before any
  catalog mutation), then clear-and-rebuilds slots+views. `validateLensTags(slot)`
  already runs reserved-tag **shape/site** validation (throws on `severity:'error'`,
  logs warnings). The prover hooks into the compile-first loop alongside it.
- `packages/quereus/src/runtime/emit/schema-declarative.ts` — `emitApplySchema`
  calls `deployLogicalSchema(...)` and `return []` for a logical schema. **This is
  where the deploy report must surface.** The `run` is currently
  `async (rctx): Promise<Row>`; to emit advisory rows it becomes a generator
  (`AsyncIterable<Row>`), symmetric with `emitDiffSchema` which yields DDL rows.
- `packages/quereus/src/planner/analysis/coverage-prover.ts` —
  - `proveEffectiveKeyUnique(root, keyColumns): { proved: true } | { proved: false; reason: 'not-a-key' | 'out-of-frame' }`
    is the **obligation primitive** the prover's `obligation: proved` class
    consumes. `keyColumns` are **body-output** indices; the prover owns the
    logical-column → output-column mapping. (Module doc explains why this is NOT
    folded into `proveCoverage`.)
  - `proveCoverage(...)` proves an explicit MV covers a base-table UNIQUE
    (literal projection of UC cols + source PK, ordering permutation, predicate/NULL
    alignment) — the set-level row-time linkage.
- `packages/quereus/src/planner/util/fd-utils.ts` — `keysOf(rel)` / `isUnique(cols, rel)`,
  the unified uniqueness read surface (declared keys ∪ FD-derived ∪ all-cols/set
  fallback; `isUnique` additionally consults FD closure). Soundness-critical
  superkey question goes through `isUnique`.
- `packages/quereus/src/vtab/memory/layer/manager.ts`:
  - `ensureUniqueConstraintIndexes()` (~line 143) is **constructor-called** and
    auto-builds a secondary index per UNIQUE + records an implicit covering-structure
    descriptor. **Phase D gates this on physical schemas.**
  - `findIndexForConstraint(targetLayer, uc): CoveringStructure | undefined` (~975)
    prefers a linked, non-stale row-time covering MV (`db._findRowTimeCoveringStructure`)
    then falls back to the auto-built memory-index. This is the set-level row-time
    path the lens attachment calls into.
  - `_findRowTimeCoveringStructure` / `_maintainRowTimeCoveringStructures` on the db.
- `packages/quereus/src/core/database-assertions.ts` — the commit-time
  assertion-evaluator path; set-level constraints that fall back to O(n) scan
  piggyback here (no new commit-phase consumer).
- Existing tests to extend: `test/lens-foundation.spec.ts`, `test/covering-structure.spec.ts`,
  `test/optimizer/keysof-isunique.spec.ts`.

## Design

The full design is `docs/lens.md` §§ "Constraint Attachment" / "Coverage checklist".
Lock the algorithm here.

### Prover output shape (`lens-prover.ts`, new)

The prover is a **consumer** of the unified `keysOf`/`isUnique`/`proveEffectiveKeyUnique`
surface plus the FD framework — it *applies* shipped inference to a specific
question per logical aspect; it derives no new inference.

For each `LensSlot` it produces a `LensProveResult`:

```ts
interface LensDiagnostic {
  code: LensCheckCode;              // stable, e.g. 'lens.uncovered-column', 'lens.no-backing-index'
  severity: 'error' | 'warning';
  site: { table: string; constraint?: string; column?: string };
  message: string;                  // sited, human-facing
  fingerprintInputs?: FingerprintInputs; // for warnings the ack ticket fingerprints; see sibling ticket
}

interface ConstraintObligation {
  constraint: LogicalConstraint;
  obligation:
    | { kind: 'proved' }                                       // body proves it; zero runtime cost; FD contributed
    | { kind: 'enforced-row-local' }                           // not null / scalar non-computed check
    | { kind: 'enforced-set-level'; mode: 'row-time' | 'commit-time'; structure?: CoveringStructureRef }
    | { kind: 'enforced-fk' }                                  // cross-relation existence, commit-time
    | { kind: 'vacuous' };                                     // body+predicate make it trivially satisfied
}

interface LensProveResult {
  errors: LensDiagnostic[];         // any non-empty ⇒ deploy blocks
  warnings: LensDiagnostic[];
  obligations: ConstraintObligation[];
  readOnly: boolean;                // key not reconstructible ⇒ table is read-only; mutation errors at the lens
}
```

`LensSlot` gains `obligations: ReadonlyArray<ConstraintObligation>` (populated
post-prove) and `readOnly: boolean`. `table.ts` logical-constraint records gain a
`lens.boundary.attached` marker once routed, so the runtime knows enforcement is
alive at the lens.

### Coverage prover — the 5 errors (each blocks the deploy, sited)

| Check | Code | What it asks |
|---|---|---|
| Column coverage | `lens.uncovered-column` | Every logical column resolves to a basis expression (override-covered or default gap-filled). *Mostly already enforced by the compiler's gap-fill error path — the prover formalizes it into the checklist.* |
| Type / nullability conformance | `lens.type-mismatch` / `lens.nullability-mismatch` | Each mapped column's basis-derived type & nullability satisfy the logical declaration. A nullable basis expr under a `not null` logical column errors unless a total default/guard supplies a value. |
| Constraint realizability | `lens.unrealizable-constraint` | Each logical constraint is proved by the body OR attachable as enforcement. A constraint referencing a `computed`-lineage column (no write path) errors. |
| Key reconstructibility | `lens.pk-not-reconstructible` | For a writable logical table the logical PK is reconstructible at the lens boundary. Otherwise the table is read-only (`readOnly: true`) and any mutation errors at the lens. |
| Round-trip (lens laws) | `lens.non-invertible` | GetPut / PutGet hold over the writable fragment. An override whose `put` is non-invertible and undisambiguated errors, naming the operator/column (reuse `docs/view-updateability.md` § "Diagnostics"). |

**Round-trip is enumerated in v1, computed later.** The
`bx-operator-model-and-roundtrip-laws` spike + `view-mutation-plan-node-substrate`
(both currently in `plan/`) make the predicate-honest **complement** of a lens
body first-class; with it, GetPut = "`put` leaves the complement fixed" and
PutGet = "`get ∘ put` reproduces the written view image" become *computed*
predicates. **This is an informing dependency, NOT a hard prereq** — ship the
enumerated failure-shape checklist now, tighten to the computed form once the
substrate exposes the complement. Encapsulate the round-trip check behind one
function so the swap is local.

### Coverage prover — the 3 warnings (never block; flow to the deploy report)

| Check | Code |
|---|---|
| No backing index for a set-level constraint | `lens.no-backing-index` — enforces via O(n) commit-time scan; recommend an explicit basis covering MV. |
| No answering structure for a declared access pattern | `lens.no-answering-structure` — `quereus.lens.access.<col>` declared an expected lookup/ordering and no basis ordering/index serves it. Read the tag via `getReservedTagByTemplate(tags, 'quereus.lens.access.<col>')`. |
| Partial override | `lens.partial-override` — informational: which columns were override-authored vs default gap-filled (read straight off `slot.columnProvenance`). |

Each warning carries `fingerprintInputs` (constraint columns, presence/absence of
a covering structure, a coarse cardinality band, …) so the sibling ack ticket can
fingerprint without re-deriving. Define the `FingerprintInputs` shape here; the
sibling ticket computes the hash and persists it.

### Constraint attachment, by class (Phase B)

For each logical constraint decide the obligation at lens-compile time:

- **Body proves it** → `proved`. Map logical-constraint columns to body-output
  indices, call `proveEffectiveKeyUnique(compiledBodyRoot, outputCols)`. On
  `{proved:true}` mark proved; zero runtime cost; the fact rides the FD-contribution
  path (see Planner wiring). *Example: spec `unique(x,y)`, body `group by x,y`.*
- **Body does not prove it** → `enforced`, routed to:
  - **Row-local** (`not null`, scalar `check` with non-`computed` lineage):
    evaluable on the projected row being written → wire into the existing per-row
    check pipeline at the lens-write boundary.
  - **Set-level** (`unique`, primary key): existence lookup via
    `findIndexForConstraint` → when a `CoveringStructure` exists, `mode: 'row-time'`
    (O(log n), conflict-resolution-capable: IGNORE/REPLACE/ABORT). Otherwise
    `mode: 'commit-time'` — O(n) `DeltaExecutor`/assertion scan, **detection-only**:
    ABORT works; IGNORE/REPLACE are rejected with "row-time conflict resolution
    requires a covering structure". Emits the `lens.no-backing-index` warning.
  - **Foreign key** (cross-relation existence): always commit-time `DeltaExecutor`;
    a covering structure on the referenced relation is optional, used when present.
- **Vacuous** (body+predicate trivially satisfy it, e.g. `not null` with body
  `where col is not null` + non-nullable basis) → no attachment.

### Planner wiring — surfacing attached constraints (Phase B)

`packages/quereus/src/planner/analysis/` constraint-extraction must read the
lens slot's routed constraints when planning over a logical-table reference. The
lens body **inlines into the plan** (it is a registered `ViewSchema`), so the
logical spec's constraint surface rides the same FD-contribution path as any
declared constraint. Trace the write path: a write to `x.T` resolves the view →
view-updateability rewrites to a basis write. The row-local checks and set-level
existence checks attach at that boundary. **This is the riskiest part of the
ticket — budget for tracing the view-write/mutation path before coding.**

### Retiring `ensureUniqueConstraintIndexes` for logical schemas (Phase D)

One-bit guard on `Schema.kind`:
- Physical schema → preserve today's auto-build + implicit-covering-structure
  descriptor (the implicit-MV reframe from `covering-structure-unique-enforcement`).
- Logical schema → **does nothing**. A logical `unique` contributes only the
  FD/key signal to the optimizer; O(log n) enforcement requires the developer to
  author an explicit basis covering MV. The commit-time scan + `lens.no-backing-index`
  advisory is exactly the warning surface this lights up.

The constructor that calls `ensureUniqueConstraintIndexes` runs in the memory
vtab/layer manager — confirm whether the manager sees `Schema.kind` directly or
whether the guard belongs at the call site (logical tables are never module-backed,
so the auto-index path may already be unreachable for them; verify and gate
explicitly regardless, with a test asserting no implicit index appears).

### Deploy report surface

`deployLogicalSchema` returns a `LensDeployReport { errors, warnings, obligationsByTable }`
instead of `void`. Errors are aggregated across all tables and thrown atomically
(before catalog mutation, preserving the existing atomic-deploy property) as a
single `QuereusError` listing every blocking diagnostic sited. Warnings are
attached to the report. `emitApplySchema` (logical branch) surfaces the report:
yield one advisory row per warning (columns: `severity, code, site, message`),
symmetric with `diff schema`'s DDL rows. (The acknowledged-count tally / expand
is the sibling ack ticket's; leave a stable hook.)

## Key Tests (TDD)

- **Body-proves vacuous.** `unique(x,y)` over `select x, y, sum(z) from B.T group by x,y` → `proved`; no runtime check; FD contributed.
- **No-prove + covering MV → row-time.** `unique(email)` over `select * from B.U` + `create materialized view ix_u_email as select email, id from B.U order by email`; insert duplicate email → row-time conflict; IGNORE/REPLACE/ABORT all work.
- **No-prove, no MV → commit-time.** Same without the MV; duplicate email → commit-time scan errors (assertion-style diagnostic); ABORT works; IGNORE/REPLACE rejected with "row-time conflict resolution requires a covering structure".
- **Row-local check.** `check` on a non-`computed` column enforces at the lens boundary for insert/update; violation raises at the lens-write boundary, not commit.
- **Error: uncovered logical column** → deploy errors, names column.
- **Error: type/nullability mismatch** → deploy errors, names column + expected vs basis type.
- **Error: writable PK not reconstructible** (non-trivial-aggregate body) → table compiles read-only; any mutation errors with the named diagnostic.
- **`lens.no-backing-index` advisory** surfaces in the deploy report (logical `unique(x)`, no covering MV).
- **`lens.partial-override` advisory** lists override-authored vs gap-filled columns.
- **Logical schema skips `ensureUniqueConstraintIndexes`.** `declare logical schema X { table T (id int primary key, email text unique); }` deploys with NO implicit BTree on `email`; insert path still works (commit-time scan); explicit covering MV upgrades to row-time.
- **Physical schema unchanged.** Every existing physical-schema UNIQUE test passes; existing `covering-structure.spec.ts` + `test/logic/` UNIQUE suites are the regression floor.
- **End-to-end scenario suite**: deploy a logical schema, exercise inserts/updates/deletes through it with each enforcement class.

## TODO (implement)

Phase A — prover
- New `lens-prover.ts`: `proveLens(slot, db): LensProveResult`. Implement the 5 errors + 3 warnings over `proveEffectiveKeyUnique` / `keysOf` / `isUnique` / FD surface; the round-trip check behind a single swappable function (enumerated form, documented as the v1 shape).
- Define `LensDiagnostic` (code/site/severity/message/fingerprintInputs), `ConstraintObligation`, `LensProveResult`, `FingerprintInputs`.
- Add `obligations` + `readOnly` to `LensSlot`; populate in `lens-compiler.ts` compile-first loop (alongside `validateLensTags`).

Phase B — attachment + routing
- Per logical constraint: decide `proved` / `enforced-row-local` / `enforced-set-level{row-time|commit-time}` / `enforced-fk` / `vacuous`. Map logical-col → body-output col for the set-level/proved checks.
- Set-level → call `findIndexForConstraint`; surface row-time vs commit-time + the no-MV resolution-rejection semantics.
- Row-local → wire into per-row check pipeline at the lens-write boundary.
- FK → commit-time `DeltaExecutor` (no kernel change).
- Mark `lens.boundary.attached` on `table.ts` constraint records once routed.
- Planner: `planner/analysis/` reads routed constraints from the lens slot when planning over a logical-table reference; constraints ride the FD-contribution path. Trace the view-write/mutation path first.

Phase D — retire auto-index for logical schemas
- Gate `ensureUniqueConstraintIndexes` on `Schema.kind === 'physical'`; logical skips entirely. Add the no-implicit-index assertion test.

Phase E (this ticket's slice) — docs + tests
- `docs/lens.md`: flip § "Constraint Attachment" + § "Coverage checklist" (error/warning halves) to shipped; add the read-only/write-correct maturity note across the three lens tickets; update "Departures and Non-Goals" auto-index entry to the actually-shipped gating.
- `docs/optimizer.md`: note lens-attached-constraint contributions to the FD framework.
- `docs/materialized-views.md`: cross-ref — explicit covering MV is the recommended response to `lens.no-backing-index`.
- Tests per "Key Tests": sqllogic + declarative-equivalence + per-prover-check unit tests + the end-to-end scenario suite. Run `yarn workspace @quereus/quereus test` and `yarn workspace @quereus/quereus run lint` (single-quote globs on Windows) before handoff.

## Out of scope (handled by sibling/backlog)
- Acknowledgment tags, fingerprints, escalation policy → sibling `lens-advisory-acknowledgment`.
- Module-level mapping advertisement (EAV/columnar coverage), engine-emitted backfill DDL, auto-promote computed→backfilled basis, logical-to-logical lenses → backlog (already filed / file as discovered).
