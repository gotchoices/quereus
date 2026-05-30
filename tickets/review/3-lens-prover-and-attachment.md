description: Review the lens prover + obligation classification + deploy report + read-only gate + Phase D auto-index retirement. The prover proves/blocks unsound logical-schema deploys (5 errors), surfaces 3 advisories, classifies every logical constraint into an enforcement obligation, and makes a non-reconstructible-PK table read-only. The LIVE per-write enforcement of those obligations was deliberately split into the follow-up implement ticket `lens-constraint-enforcement-wiring`.
prereq:
files: packages/quereus/src/schema/lens-prover.ts, packages/quereus/src/schema/lens.ts, packages/quereus/src/schema/lens-compiler.ts, packages/quereus/src/schema/declared-schema-manager.ts, packages/quereus/src/planner/building/view-mutation.ts, packages/quereus/src/planner/mutation/mutation-diagnostic.ts, packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/test/lens-prover.spec.ts, packages/quereus/test/logic/55-lens-prover.sqllogic, docs/lens.md, docs/optimizer.md, docs/materialized-views.md
effort: high
----

## What landed

The first, self-contained half of the prover capstone: **prove / block / classify / advise + read-only enforcement + auto-index retirement.** Build, lint, and the full suite (4031 passing, 0 failing) are green.

### `packages/quereus/src/schema/lens-prover.ts` (new) — `proveLens(slot, db): LensProveResult`
A pure-analysis consumer of the shipped inference surface (`proveEffectiveKeyUnique` / `keysOf` / `isUnique` / FD framework). Per lens slot it produces:

- **5 errors** (any ⇒ deploy blocks, aggregated + thrown atomically before catalog mutation):
  - `lens.uncovered-column` — a logical column with no basis backing (formal backstop; the compiler's gap-fill path catches most first).
  - `lens.type-mismatch` — cross-affinity-family mismatch (numeric↔text/blob), read off the optimized body's output column types. **Deliberately lenient** (numeric/boolean compatible; NULL/OBJECT permissive) to avoid false-blocking faithfully-aligned deploys.
  - `lens.nullability-mismatch` — a NOT NULL logical column over a nullable basis expression with no total default.
  - `lens.unrealizable-constraint` — a **unique / check** referencing a column with no write path (computed/hidden lineage). (A **PK** over such a column is *read-only*, not an error — see below.)
  - `lens.non-invertible` — round-trip / lens laws, behind a single swappable `proveRoundTrip` function. **v1 is the enumerated form and currently returns no new error** (non-invertibility is already caught at mutation time by view-updateability; a non-reconstructible key is caught by the read-only check). Documented as the seam to tighten to the computed-complement form.
- **3 warnings** (advisory; never block; flow to the deploy report, each carrying `FingerprintInputs` for the sibling ack ticket):
  - `lens.no-backing-index` — a set-level constraint with no basis covering structure (commit-time scan).
  - `lens.no-answering-structure` — a `quereus.lens.access.<col>` tag with no serving basis index/PK leading-column.
  - `lens.partial-override` — informational: override-authored vs default gap-filled columns.
- **Obligation classification** per constraint (recorded on `LensSlot.obligations`): `proved` (via `proveEffectiveKeyUnique`) / `enforced-row-local` (scalar check) / `enforced-set-level{row-time|commit-time}` / `enforced-fk` / `vacuous` (empty PK).
- **`readOnly`** verdict: a non-reconstructible PK (computed/hidden column) ⇒ read-only.

### Wiring
- `LensSlot` gains `obligations` + `readOnly`, populated in `lens-compiler.ts`'s compile-first loop alongside `validateLensTags`.
- `deployLogicalSchema` now returns `LensDeployReport { errors, warnings, obligationsByTable }`, persisted on `DeclaredSchemaManager.setDeployedLensReport` and readable via `getDeployedLensReport` — the **stable hook** the sibling ack ticket consumes.
- **Read-only mutation gate**: `analyzeView` (the common entry for all three view-DML rewrites) raises `lens-read-only` when the target's lens slot is `readOnly`. Reads still resolve; writes error precisely.
- **Phase D**: `MemoryTableManager.ensureUniqueConstraintIndexes` is gated on `!isLogicalSchema()` (one-bit `Schema.kind` guard, also reads `tableSchema.isLogical`).

## Use cases to validate (the floor — treat as a starting point, not exhaustive)

- **Obligation classification** (`test/lens-prover.spec.ts`): proved (basis-key faithful projection), commit-time (no covering MV) + warning, row-time (nullable unique + NULL-skipping covering MV), row-local check, enforced-fk, vacuous singleton PK.
- **Blocking errors**: type-mismatch (int over text), nullability-mismatch (NOT NULL over nullable), uncovered-column, unrealizable check over a computed override column. (`test/logic/55-lens-prover.sqllogic` exercises these end-to-end via `apply schema` + `-- error:`.)
- **Read-only**: computed-PK override deploys read-only; reads work; insert/update/delete all error at the lens boundary.
- **Advisories**: partial-override message lists the right columns; no-answering-structure on an access tag.
- **Phase D**: a logical UNIQUE creates no implicit index; classified commit-time.
- **Regression floor**: the entire existing suite (lens-foundation/overrides/advertisement/backfill, covering-structure, all `test/logic`) stays green — the prover runs on every logical deploy and must not false-block.

## Known gaps / where to look hard (honest handoff)

- **The headline "write-sound" claim is only partially delivered.** The prover *classifies* and *records* obligations and enforces the read-only verdict, but the **live per-write enforcement** (routing row-local CHECK/NOT-NULL into the basis write's per-row check pipeline, set-level UNIQUE existence into `findIndexForConstraint`, FK into the commit-time `DeltaExecutor`, the `lens.boundary.attached` marker, and the planner FD-contribution of *non-proved* routed constraints) is **deferred to the follow-up implement ticket `lens-constraint-enforcement-wiring`** (chained `prereq`). Until it lands, a write through the lens is enforced only by whatever the basis tables themselves carry. **This split is the single biggest judgement call to review** — verify it is the right seam and that the prover's obligation shape is what the wiring needs.
- **Deploy report surfaced via a manager hook, not `apply schema` result rows.** Converting the universally-used void `ApplySchemaNode` to relational was judged high-blast-radius and orthogonal; the row-yielding UX is deferred to the sibling ack ticket that consumes/expands the report. Confirm the manager hook is an adequate contract for that ticket.
- **Type/nullability conformance is intentionally lenient.** Reviewer should probe whether it is *too* lenient (misses a real mismatch) or whether any edge (temporal types, OBJECT/JSON columns, collation) deserves tightening. It was tuned to not false-block the existing lens suite — re-verify that trade-off.
- **Covering-structure lookup is single-source only.** `findBasisCoveringStructure` maps logical→basis columns through a single-source body projection; a multi-source body falls back to commit-time. Row-time is realistically reachable only for a *nullable* basis unique + NULL-skipping covering MV (a NOT-NULL basis unique is already `proved`). Confirm this is the intended boundary.
- **`proveRoundTrip` is a documented no-op stub** (v1 enumerated). Verify it is correctly encapsulated for the later computed-complement swap and that no round-trip-only failure shape silently slips through deploy.
- **`proveLens` calls `db.getPlan` per logical table at deploy** and degrades gracefully (skips plan-derived checks) if the body fails to plan. Sanity-check that graceful degradation can't mask a real error that should block.

## Suggested commands
- `yarn workspace @quereus/quereus test` (full suite; 4031 passing)
- `node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus/test/lens-prover.spec.ts" --colors`
- `yarn workspace @quereus/quereus run build` and `run lint` (single-quote globs on Windows)
