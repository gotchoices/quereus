description: A lens-synthesized commit-time set-level uniqueness CHECK (and, latently, any row-local CHECK / child-FK / parent-FK) was threaded onto EVERY base op of a decomposition UPDATE fan-out, so a member op (UPDATE / materialize-INSERT) whose target table lacks the constraint's referenced basis column failed to BUILD with `NEW.<col> isn't a column` — making the natural surrogate-keyed (logical-PK-not-on-every-member, no-basis-uniqueness) UPDATE path entirely unusable. Fixed with a uniform per-op resolvability gate at the threading site: a lens-synthesized constraint rides a base op iff every write-row column it references resolves on that op's target table.
prereq:
files:
  - packages/quereus/src/planner/building/view-mutation-builder.ts   # FIX: per-op gate at the threading site (buildViewMutation ~L175); writeRowColumns AST-walk helper + constraintsForOp filter + debug log (bottom of file)
  - packages/quereus/src/planner/mutation/lens-enforcement.ts         # (unchanged) the four extraConstraints collectors that synthesize the routed constraints
  - packages/quereus/src/planner/mutation/propagate.ts                # (unchanged) BaseOp.table: TableReferenceNode — the per-op target read by the gate
  - packages/quereus/src/parser/ast.ts                                # (reference) Expression / ColumnExpr / SubqueryExpr / ExistsExpr / FromClause shapes the walker covers
  - packages/quereus/test/lens-put-fanout.spec.ts                     # workaround removed (doc_key text, no UNIQUE) + new docKey-rekey routing regression (~L1454, ~L1536)
  - docs/lens.md                                                      # § Constraint Attachment routing paragraph rewritten (per-op decomposition routing + residual)
  - docs/view-updateability.md                                        # § Current limitations: cross-member CHECK/FK deferral residual documented
----

# Per-op resolvability gate for lens-synthesized constraints — implement handoff

## What changed

`buildViewMutation` computed `extraConstraints` once and threaded the SAME list onto every base op of
the fan-out (`baseOps.map(op => buildBaseOp(ctx, op, extraConstraints, …))`). The four lens collectors
(`lens-enforcement.ts`: set-level count CHECK, row-local CHECK, child-FK `EXISTS`, parent-FK
`NOT EXISTS`) synthesize constraints in **basis** terms. On a decomposition UPDATE that fans out to
≥1 member op whose target table does not carry a referenced basis column, the member op's
`buildConstraintChecks` cannot resolve `NEW.<col>` and the whole UPDATE throws at **plan-build time**.

The fix (ticket's recommended **approach A** — localized, no schema-type change) adds a uniform per-op
gate at the single threading site:

- `writeRowColumns(expr)` — an AST walker collecting a constraint's **write-row** column references:
  every `NEW.*` / `OLD.*`-qualified column **anywhere** (it descends into subqueries for these — the
  set-level count subquery's correlated `NEW.bk`, the FK `EXISTS`/`NOT EXISTS` correlated side, and the
  parent-FK UPDATE guard's top-level `OLD.p ≡ NEW.p`), **plus** any **bare** (unqualified) column **not**
  inside a subquery (the row-local CHECK's bare basis refs — the `enforced-row-local` class is
  subquery-free). Subquery-internal bare / alias-qualified refs (`_u.docKey`, FK aliases) are ignored —
  they resolve against the subquery's own FROM.
- `constraintsForOp(op, extraConstraints, ridden)` — keeps a constraint for `op` iff every
  `writeRowColumns` entry is in `op.table.tableSchema.columns` (lowercased). Applied uniformly to all
  four classes. `extraConstraints` is exclusively lens-synthesized (the basis table's own checks enter
  via `buildConstraintChecks` from `tableSchema.checkConstraints`, never this seam), so gating every
  entry is safe.
- A debug `log()` fires when a constraint resolves on **no** base op of the fan-out (a key-unchanged
  UPDATE dropping its uniqueness scan; a cross-member CHECK/FK deferred) so silent non-enforcement is
  traceable.

## Resulting semantics (intended, documented)

- **Single-source spine** (plain lens, one base op carrying all basis columns): unchanged — every
  constraint rides the one op. Confirmed by the 193 lens-enforcement/-put-fanout tests staying green.
- **Set-level uniqueness on a key-unchanged decomposition UPDATE** (e.g. `update x.Doc set note=…`):
  the synthesized `NEW.doc_key` CHECK rides no fan-out op (the `note` update produces only Doc_meta
  ops, which lack `doc_key`) → dropped. Sound: a key-unchanged update cannot create a duplicate.
- **Key-changing decomposition UPDATE** (`update x.Doc set docKey=…`): routes the CHECK onto the
  Doc_core anchor op (which owns `doc_key`), so a duplicate logical PK still ABORTs at commit.
- **Cross-member row-local CHECK / FK on a decomposition UPDATE**: deferred (rides no single member
  op) — matching the decomposition INSERT path, which already defers row-local/set-level enforcement.
  A single-member-resolvable CHECK / FK still rides its member.

## Use cases for testing / validation

The repro is `lens-put-fanout.spec.ts` § `surrogate-keyed optional-member UPDATE`. The
`doc_key text unique` workaround was removed (anchor is now `doc_key text`, no basis uniqueness), which
re-arms the commit-time set-level obligation that previously crashed the member UPDATE.

- **Member-only UPDATE builds + runs** (4 pre-existing tests, now exercised with no basis uniqueness):
  matched UPDATE, absent→materialize INSERT, all-null DELETE, null-to-absent no-op. Each fans out to
  Doc_meta ops the CHECK must NOT ride.
- **Key-routing regression (new)** — `a docKey re-key routes the commit-time uniqueness CHECK onto the
  Doc_core anchor op`: a unique re-key builds + runs (count = 1 ⇒ pass), a duplicate re-key ABORTs at
  commit (count ≥ 2), and the aborted statement rolls back. This pins that the CHECK still fires on the
  op that owns the key — proving the gate routes precisely, not just that it stops crashing.

## Verification (all green on this run)

- `yarn workspace @quereus/quereus test --grep "surrogate-keyed optional-member UPDATE"` → 5/5.
- `lens-put-fanout.spec.ts` + `lens-enforcement.spec.ts` together → **193 passing**.
- Full `yarn workspace @quereus/quereus test` → **4921 passing, 9 pending, 0 failing**.
- `yarn workspace @quereus/quereus lint` → clean. `tsc --noEmit` → clean.
- (The `[property-planner] Rule '…' never fired` lines in the full-suite output are pre-existing
  informational notices from the property planner, not failures — suite exits 0.)

## Honest gaps / where to push as a reviewer

- **The cross-member CHECK/FK deferral residual has NO dedicated behavioral test.** The
  surrogate-optional fixture's logical `Doc` table declares no logical CHECK / FK, so the "a logical
  CHECK spanning two members is silently deferred (not enforced) on a decomposition UPDATE" path is
  verified only by reasoning + the debug `log`, not by a test that constructs such a schema and asserts
  the violation is NOT caught. A reviewer wanting belt-and-suspenders should add one (a decomposition
  whose logical `check (a < b)` spans two members; an UPDATE that violates it across members should
  currently pass — documenting the deferral — while a single-member CHECK should still ABORT). This was
  left out because it asserts a *non*-enforcement (a deliberate deferral matching INSERT), which is a
  weaker contract to pin; flagging rather than papering over.
- **The debug `log()` drop-trace is not asserted** by any test (it's observational only).
- **`writeRowColumns` bare-ref handling** (the ticket's noted fragility point for approach A): it
  assumes the `enforced-row-local` class is subquery-free, so a bare top-level ref is always a
  write-row ref. That holds by the prover's current definition. If a future row-local obligation could
  carry a subquery, a bare ref *inside* it is correctly ignored (resolves against the subquery FROM),
  but a reviewer should confirm the prover invariant still holds before relying on it. Fallback is the
  ticket's **approach B** (metadata on the synthesized constraint) if the AST walk is judged fragile.
- **No store-path run.** Only `yarn test` (memory) was run; this is a planner-build-time change with no
  storage-layer surface, so `test:store` was not exercised (per AGENTS.md guidance to default to memory
  tests). A reviewer preparing a release may want `test:store` for completeness.
