description: Covering structures — materialized indexes that physically realize UNIQUE constraints. Generalize `findIndexForConstraint`/`checkUniqueViaIndex` to consult both today's auto-built secondary BTrees and explicit `create materialized view ... order by` declarations; add a minimal coverage prover that recognizes when an MV covers a constraint; reframe `LayerManager.ensureUniqueConstraintIndexes` as an *implicit* basis-layer declaration so the engine has one enforcement path. Sets up the "constraint is logical, structure is optional" model the lens layer's constraint-attachment ticket finishes.
prereq: materialized-view-core
files: packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/src/vtab/memory/index.ts, packages/quereus/src/schema/table.ts, packages/quereus/src/schema/view.ts, packages/quereus/src/planner/analysis/, packages/quereus/src/planner/analysis/partial-unique-extraction.ts, packages/quereus/src/core/database.ts, docs/materialized-views.md, docs/optimizer.md, docs/lens.md, docs/schema.md
----

## Scope

Two clean concerns, ticketed together because they share `findIndexForConstraint` and `checkUniqueViaIndex`:

1. **One enforcement path.** Today, `LayerManager.ensureUniqueConstraintIndexes()` (`packages/quereus/src/vtab/memory/layer/manager.ts:80`) silently auto-builds a secondary BTree for every UNIQUE constraint. The constraint enforcement path then asks `findIndexForConstraint` and goes through `checkUniqueViaIndex`. This ticket re-expresses that auto-built BTree as an **implicit basis-layer materialized view** (the same shape an explicit covering MV produces) so both implicit and explicit covering structures flow through the same code path.

2. **Explicit covering MVs.** A user-declared `create materialized view ix_t_xy as select x, y, <pk> from t [where <null-skip>] order by x, y` should be recognized as covering `unique(x, y)` and upgrade enforcement to the same row-time existence-lookup that the implicit auto-index provides today.

The big-picture rationale is in `docs/lens.md` § "Relationship to Materialized Views" and `docs/lens.md` § "Constraint Attachment": **the constraint is a logical claim; the structure is an optional physical optimization.** The lens layer's full realization of that principle (`prereq: covering-structure-unique-enforcement` from `lens-prover-and-constraint-attachment`) lands after this ticket, when the *automatic* aspect of `ensureUniqueConstraintIndexes` is finally retired in favor of explicit basis-layer declarations. This ticket lands phases 1 and 2 of that arc; phase 3 lives with the lens work.

## Design

### What "covers" means here

Two senses (from the parent ticket's framing — paraphrased):

- **Answering coverage.** The MV's columns ⊇ the columns needed by a read, and its key/ordering fits the read. The optimizer surface already handles this through `keysOf` / FDs / orderings on the backing table; no new code needed.
- **Enforcement coverage.** Maintaining the MV is sufficient to detect any UNIQUE violation. This is the new concern.

The covering form for UNIQUE is a **materialized index** — a materialized view with `order by` over the constraint columns. Count-form views (`select cols, count(*) ... having count(*) > 1`) are explicitly **rejected** as a covering form (they only detect at COMMIT and can't drive row-time conflict resolution); the parent ticket's rationale stands.

Enforcement against a covering MV is the existing row-time existence lookup (`checkUniqueViaIndex`): "does a row with this key already exist in the covering structure?" → point lookup → IGNORE/REPLACE works → ABORT raises a constraint error with the existing row. This is exactly today's code; the change is just *what* `findIndexForConstraint` returns.

### Minimal coverage prover

A new `packages/quereus/src/planner/analysis/coverage-prover.ts`. For a candidate (`MaterializedViewSchema`, `UniqueConstraintSchema`) pair, returns `Covers | NotCovers(reason)`. Recognition rules for v1:

- The MV body, after optimization, must be a `TableReference(T)` → optional `Filter(P)` → `Project(...)` → optional `Sort(...)` chain over the constrained table `T`.
- The projection's output attributes must include every column in `uc.columns` (in any order) and every PK column of `T` (so the MV row carries enough to identify the source row).
- If `uc.predicate` is non-null (partial UNIQUE), `P` must entail `uc.predicate` — checkable with the existing `partial-unique-extraction.ts` machinery, which already classifies recognized predicate shapes. Use it in "does A entail B?" direction.
- For NULL semantics alignment (the parent ticket's most subtle gotcha): if any `uc.columns[i]` is nullable, the MV body must carry `where <col_i> is not null` (or equivalent), since UNIQUE allows multiple NULLs but a materialized-index lookup over NULL keys must not match. For all-NOT-NULL UC columns the predicate is vacuous and the MV body needs no NULL-skip.
- If `order by` is present on the body, its columns must be a permutation of `uc.columns` (so the structure can answer the point-lookup efficiently); a missing or wrong-order `order by` is `NotCovers('ordering-mismatch')`. The prover does not invent an ordering.

Out-of-scope recognition (in v1; file follow-ups in backlog):
- FD-driven coverage (the MV's effective key is the constraint columns via a closure argument rather than literal projection).
- Multi-table MV bodies (joins) covering a single-table UC — the binding extractor's `'row'` analysis could in principle support this, but the prover's safe surface starts narrow.

### Wiring `findIndexForConstraint`

Generalize the function in `vtab/memory/layer/manager.ts:848` to return a uniform `CoveringStructure` shape:

```ts
type CoveringStructure =
  | { kind: 'memory-index'; index: MemoryIndex }       // today's secondary BTree
  | { kind: 'materialized-view'; view: MaterializedViewSchema };
```

`checkUniqueViaIndex` keeps its current shape for `kind: 'memory-index'`; a new branch for `kind: 'materialized-view'` does the equivalent point-lookup against the covering MV's backing table (a normal `TableReference` query gated by an equality on the MV's PK projection).

The dispatch decision is straightforward: prefer an explicit covering MV when one exists; fall back to the implicit auto-index (the legacy `_uc_<cols>` index) when one doesn't.

### Reframing the auto-index as implicit basis declaration

`ensureUniqueConstraintIndexes` (`vtab/memory/layer/manager.ts:80`) today fuses two concerns: it creates an `IndexSchema` and it implies enforcement. We split them:

- The `IndexSchema`-shaped secondary BTree remains as the physical structure (no migration / no rebuild for existing tables).
- Each auto-created index gets a synthesized `MaterializedViewSchema` entry marked `origin: 'implicit-from-unique-constraint'` that *describes* the same structure in the MV vocabulary, with a `covers` link to the originating `UniqueConstraintSchema`.
- Enforcement queries `findIndexForConstraint` and gets back the unified `CoveringStructure` value; the data path is unchanged.

The synthesized MV is **not** user-visible by default in `query_plan`-style introspection (it's a backing detail of the unique constraint), but it **is** visible through `Database.export_schema()` if the constraint was explicitly tagged `quereus.expose_implicit_index = true`. Default-hidden preserves today's user-visible schema shape.

Why bother with this reframe? Three reasons:

1. The lens layer's "constraint is logical, structure is optional" principle requires a single covering-structure abstraction. The mechanical reframe here lets the lens layer's phase 3 (logical schemas don't auto-build the structure) flip a single bit instead of restructuring two paths.
2. Explicit covering MVs become first-class: they get the same enforcement upgrade, the same access-path benefit, and the same diagnostics as the implicit case.
3. Drop / replace flows are uniform: `drop materialized view ix_t_xy` and `alter table drop constraint uc_xy` both flow through the same "tear down covering structure" path, with the difference being whether the originating UC is also dropped.

### Concurrency / store-plugin parity

The memory vtab is the reference implementation. The covering-structure dispatch lives in the memory `LayerManager`; the store plugin (`packages/quereus-plugin-leveldb/`) has its own equivalent. Either:
- Stage the changes so the memory side flips first and the store side follows in a follow-up implement ticket; or
- Land both in the same implement ticket if the store wrapper is thin.

Either way, `yarn test:store` must stay green by the end of the implement stage.

## Resolved Open Questions

- **Declaration model (the parent ticket's most consequential open question).** Hybrid leaning **explicit**, per the lens-doc commitment. The legacy auto-index is preserved as an implicit basis-layer declaration that presents identically through the unified `CoveringStructure` surface. The lens layer's phase 3 (logical schemas don't auto-build) lands later without touching this ticket's code.
- **Coverage prover scope.** Narrow v1: linear chain `Filter → Project → Sort` over a single source; literal column matching on the projection; entailment of partial-UC predicates via the existing `partial-unique-extraction` machinery; NULL-skip alignment for nullable UC columns; ordering match for `order by`. FD-driven coverage and multi-table MV bodies are explicit follow-ups.
- **Backing module parity.** Today the auto-index lives in `vtab/memory/`; the equivalent path in `quereus-plugin-leveldb/` already mirrors the memory shape. Both must converge on the unified `CoveringStructure` surface by the time the implement ticket lands.

## Out of scope (file in backlog/ after this lands)

- **FD-driven covering recognition** — the prover surface generalizes to bodies whose effective key is the constraint columns by FD closure rather than literal projection.
- **Multi-source covering MVs** — a join MV covering a single-table UC by virtue of advertising a single-source binding through the binding extractor.
- **Lens-layer phase 3.** Logical schemas don't auto-build covering structures — covered by `lens-prover-and-constraint-attachment`, which is what consumes this ticket.

## Implementation Surface

- `packages/quereus/src/planner/analysis/coverage-prover.ts` (new) — the (`MaterializedViewSchema`, `UniqueConstraintSchema`) → `Covers | NotCovers(reason)` decision.
- `packages/quereus/src/vtab/memory/layer/manager.ts` — generalize `findIndexForConstraint` to return `CoveringStructure`; new branch in `checkUniqueViaIndex` for `kind: 'materialized-view'`; `ensureUniqueConstraintIndexes` synthesizes the implicit-MV entry alongside the secondary BTree.
- `packages/quereus/src/vtab/memory/index.ts` — surface a lookup shape the MV-backed branch can consume (the existing `MemoryIndex.getPrimaryKeys` is `IndexKey → PK[]`; the MV branch needs the equivalent against a backing-table read — likely a thin helper that wraps a `TableReference` query with an equality filter).
- `packages/quereus/src/schema/view.ts` — `MaterializedViewSchema.origin: 'explicit' | 'implicit-from-unique-constraint'`; `covers?: { schemaName, tableName, constraintName }`.
- `packages/quereus/src/schema/table.ts` — `UniqueConstraintSchema` gets an optional `coveringStructureName` pointer (or leave the linkage implicit via the `covers` back-pointer on the MV — pick one and document).
- `packages/quereus/src/planner/analysis/partial-unique-extraction.ts` — consult the existing predicate-shape recognition to discharge "does P entail uc.predicate?" — no new shapes, just a "implies" direction over the existing classifications.
- `packages/quereus/src/core/database.ts` — register the covering-prover at MV-creation time so the linkage is established eagerly (rather than re-proving on every enforcement check).
- `packages/quereus-plugin-leveldb/...` — mirror the unified `CoveringStructure` dispatch.
- `docs/materialized-views.md` (extend with covering section), `docs/optimizer.md` (link to the prover), `docs/lens.md` (already commits to this; update prose to point at the now-shipped surface), `docs/schema.md`.

## Key Tests (TDD seeds for implement stage)

- **Legacy auto-index path unchanged.** Every existing UNIQUE-constraint test in `test/logic/`, `test/optimizer/`, `test/vtab/` continues to pass without modification. (This is the regression floor.)
- **Coverage prover positive cases.** A canonical `create materialized view ix_t_xy as select x, y, id from t order by x, y` is recognized as covering `unique(x, y)`. Add per-shape goldens.
- **Coverage prover negative cases.** Each `NotCovers(reason)` shape gets a test: missing UC column, missing PK column, ordering mismatch, partial-UC-predicate entailment failure, missing NULL-skip for a nullable UC column.
- **Explicit MV drives row-time enforcement.** `insert or replace` against a covered UC with an explicit covering MV (and no legacy auto-index) substitutes in place, exactly like the auto-index case. Build a table that bypasses `ensureUniqueConstraintIndexes` (or temporarily disables it via a test hook) to prove the explicit-MV path is sufficient on its own.
- **Implicit MV reframe is observation-equivalent.** Every behavior — `insert or {ignore,replace,abort,fail,rollback}`, partial-UNIQUE NULL semantics, conflict diagnostics — produces identical results before and after the reframe. Run the existing logic tests under both shapes via a parameterized harness.
- **Drop semantics.** Dropping an explicit covering MV demotes enforcement to the commit-time `DeltaExecutor` scan; dropping the underlying UC drops the covering MV (explicit or implicit) atomically.
- **Store parity.** All of the above pass under `yarn test:store`.

## TODO (implement stage)

Phase A — prover + schema linkage
- New `coverage-prover.ts` with the recognition rules above.
- `MaterializedViewSchema.origin` + `covers` fields; `UniqueConstraintSchema.coveringStructureName` (or back-pointer — pick one).
- Eager prove-and-link at MV creation.

Phase B — unified dispatch
- Generalize `findIndexForConstraint` to return `CoveringStructure`.
- New `checkUniqueVia*` branch for the MV-backed structure (point-lookup against backing table with equality filter).
- Reframe `ensureUniqueConstraintIndexes` to synthesize the implicit-MV alongside the secondary BTree.

Phase C — drop & introspection
- Drop-MV path: demote enforcement (mark UC's covering pointer null; subsequent writes flow through the commit-time fallback).
- Drop-UC path: drop linked covering structure (explicit + implicit) atomically.
- Default-hide implicit MVs in `export_schema()`; surface via the `quereus.expose_implicit_index` tag when set.

Phase D — store parity + docs + tests
- Mirror in `quereus-plugin-leveldb`.
- Update `docs/materialized-views.md` (covering section), `docs/optimizer.md`, `docs/lens.md`, `docs/schema.md`.
- Run the full regression + parameterized "before/after reframe" harness; both must be green under `yarn test` and `yarn test:store`.
