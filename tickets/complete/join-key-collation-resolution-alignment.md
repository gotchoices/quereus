description: Pairwise join-key collation resolution (USING/merge/bloom/asof) routes through the shared provenance-ranked comparison-collation resolver; plan-time USING conflict validation; MV backing-column collationExplicit threaded from output collation provenance. Reviewed and completed.
files:
  - packages/quereus/src/runtime/emit/merge-join.ts
  - packages/quereus/src/runtime/emit/bloom-join.ts
  - packages/quereus/src/runtime/emit/asof-scan.ts
  - packages/quereus/src/runtime/emit/join.ts
  - packages/quereus/src/planner/building/select.ts
  - packages/quereus/src/planner/rules/join/equi-pair-extractor.ts
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts
  - packages/quereus/src/planner/analysis/comparison-collation.ts
  - packages/quereus/test/logic/11.1-join-using.sqllogic
  - packages/quereus/test/logic/82-bloom-join.sqllogic
  - packages/quereus/test/logic/83-merge-join.sqllogic
  - packages/quereus/test/logic/84-asof-scan.sqllogic
  - packages/quereus/test/logic/51.5-materialized-views-coarsened-key.sqllogic
  - docs/optimizer.md
  - docs/schema.md
----

# Join-key collation resolution alignment — completed

The four pairwise comparison sites (USING comparator, merge-join, bloom-join, asof-scan)
that previously resolved key collation with ad-hoc per-emitter rules (`left || right` /
`left ?? right`) now resolve through the shared `effectiveCollationOfTypes` /
`resolveComparisonCollation` lattice (explicit > declared > default > BINARY, **symmetric**,
plan-time error on same-rank explicit/declared conflicts). Plus a new plan-time USING
conflict check and MV backing-column `collationExplicit` threading from output-collation
provenance.

## What landed (verified)

- **merge / bloom / asof emitters** — each pairwise key collation = `effectiveCollationOfTypes(leftType, rightType)`,
  replacing `left || right` (merge/bloom) and `left ?? right` (asof). The resolver throws
  `QuereusError` on a same-rank explicit/declared conflict (loud backstop). Stale
  `BINARY_COLLATION` fallback imports dropped — the resolver always returns a name.
- **join.ts USING comparator** — already routed through the resolver by the prereq
  (`comparison-collation-provenance-and-precedence`); verified unchanged at `join.ts:46-47`.
- **Plan-time USING validation** — new `validateUsingCollations` in `select.ts buildJoin`
  runs `resolveComparisonCollation` over each paired attribute and throws the same
  `collationConflictError` a spelled-out `l.c = r.c` would, at plan time. USING pairs never
  become `BinaryOpNode`s so `BinaryOpNode.generateType`'s lattice check never sees them.
- **equi-pair-extractor gate** — deliberately NOT loosened; docstring corrected (the old
  "left-operand precedence / right-first" claims are obsolete).
- **MV backing columns** — `deriveBackingShape` sets `collationExplicit: true` iff the body
  output column's `collationSource` is `explicit`/`declared`; left unset for `default`/absent.

## Review findings

**Verdict: implementation correct and complete. One minor test-robustness fix applied
inline; no major findings; no new tickets filed.**

### Checked — sound

- **Shared resolver (`comparison-collation.ts`)** — re-read in full. Lattice is symmetric,
  rank-1 BINARY contributes nothing (engine floor), same-rank rank≥2 distinct names →
  conflict, everything else resolves to a single name or BINARY. `effectiveCollationOfTypes`
  is the throwing form. Correct.
- **Emitter ↔ gate lockstep (the load-bearing invariant)** — the `equi-pair-extractor` gate
  admits a pair only when `operandCollation(left) === operandCollation(right)` (provenance-blind
  *name* match, `equi-pair-extractor.ts:181`). For any gate-admitted pair both contributions
  share a name, so the provenance-based resolver yields that same name and *cannot* hit the
  same-rank-different-name conflict branch — the emitter backstop is provably unreachable for
  legitimately-admitted pairs, and the resolved key collation always equals each input's
  declared sort collation. The merge/bloom emitter diffs are therefore **no-ops for currently
  admitted pairs**; their value is the loud backstop + symmetric robustness. Confirmed.
- **Implementer's central ask — no other collation-carrying ordering surface.** Verified:
  `PhysicalProperties.ordering` is `{column, desc}[]` (collation-blind, `deriveOrderingFromMonotonicOn`
  in `physical-utils.ts`); the actual sort comparators (`createOrderByComparator`, memory
  `primary-key.ts`, isolation `comparePK`) all key off each column's OWN declared collation.
  A column's advertised ordering is implicitly under its own collation; nothing else relates
  ordering to collation. The lockstep reasoning is complete.
- **No missed join emitter.** The four covered sites are the complete set doing ad-hoc
  per-pair collation resolution. There is no `hash-join.ts` (hash path = bloom-join);
  `fanout-lookup-join.ts` does no key normalization — it delegates equality down to the
  access path, which is collation-aware via the index. Nothing else to align.
- **USING extraction vs. validation consistency.** `extractEquiPairsFromUsing` rejects a pair
  on name mismatch (asymmetric → generic nested-loop join, whose USING comparator folds via
  the resolver); `validateUsingCollations` throws only on same-rank conflict. Conflicts are
  caught at plan-build (JoinNode never returned); asymmetric handled by the generic join.
  No conflicting pair can reach merge/bloom via USING. Consistent.
- **MV `collationExplicit` thread + all consumers.** Every consumer treats the field as
  truthy/falsy (`store-module.ts:2466` `if (col.collationExplicit) return col;`;
  `columnSchemaToScalarType` `collationExplicit ? 'declared' : 'default'`), so leaving it
  unset (vs `false`) for implicit columns is identical to all consumers. The "absent ⇒ implicit"
  contract holds. Confirmed.
- **51.5 §9 is load-bearing.** Ran `yarn test:store --grep "51.5"`: passes. The explicit
  `collate binary` MV PK keeps both `'Bob'`/`'bob'` (distinct under BINARY, colliding under
  the store's NOCASE default) — proving the thread; without it the store would re-key under
  NOCASE and collide.
- **MV reopen "gap" (implementer flag) — investigated, NOT a defect.** `generateTableDDL`
  elides BINARY (confirmed via `ddl-generator-roundtrip-positions.spec.ts`), but the store
  load path does **not** reconcile (persisted DDL is the source of truth on reopen), and
  BINARY-elided == BINARY-default is exactly the desired keying. `collationExplicit`'s job is
  done at create-time reconcile (preventing the implicit→NOCASE coercion); the resulting
  BINARY collation is baked into the persisted schema/DDL and round-trips. Sound by
  construction; a dedicated reopen spec would be belt-and-suspenders only.

### Checked — minor, fixed inline this pass

- **asof mix test could pass vacuously.** The new `asof_*_mix` case (84-asof-scan) — the one
  genuinely result-affecting fix (the live `??`→resolver change; asof has no equi-pair gate)
  — asserted only the result rows, not that the plan is an `ASOFSCAN`. Had the plan ever
  degraded to a generic correlated subquery, the partition-collation code under review would
  not run and the assertion would pass without exercising it. I manually confirmed via
  `query_plan` that the mix query DOES produce an `ASOFSCAN` and that the result reflects
  NOCASE folding (`id=1 'A'` → quote `'a'` → `1.0`, which the pre-fix left-first `??`/BINARY
  would have left `null`), then **added a plan-shape assertion** (`SELECT op ... WHERE op =
  'ASOFSCAN' → [{"op":"ASOFSCAN"}]`) mirroring the file's existing base-case assertion. Passes
  memory + store.

### Checked — accepted gaps (documented, no action)

- **asof has no plan-time USING-style conflict validation.** A genuinely-conflicting asof
  (both match/partition sides carrying *different explicit* collations) surfaces the emitter's
  loud backstop at emit time, not plan time. Acceptable: asof match/partition attrs are almost
  always the same source column, and the failure is a loud error (never silent wrong results),
  not a correctness hole. No fixture builds such a conflict. If plan-time parity is ever wanted,
  the asof-building rule is the site.
- **3-way mixed-collation merge / synthesized-equi-pair angles.** The resolver is strictly
  per-pair (each `equiPair` resolved independently in the emitter loop), so per-level
  independence is structural; a synthesized mismatched-declared pair is excluded by the gate's
  name match (→ residual) before it can reach merge/bloom. No dedicated fixture added — the
  structural guarantee plus the existing `mj_ci_pk` real-MergeJoin-over-NOCASE-PK and
  asymmetric-demotion cases cover the behavior. Noted for any future gate-loosening, which must
  re-validate the emitter resolver + lockstep together.
- **NATURAL join** is not parsed (`parser.ts` joinType has no `natural`); the USING validation
  would apply for free if added (NATURAL desugars to USING pairs). Nothing to test today.

### Validation run

- `yarn build` — clean (exit 0).
- `yarn test` (memory) — 5977 passing, 9 pending.
- `yarn lint` — clean (exit 0).
- `yarn test:store --grep "51.5|82-bloom|83-merge|84-asof|11.1-join"` — all passing
  (incl. the load-bearing 51.5 §9 and the edited 84 plan assertion).

### Docs

`docs/optimizer.md` (bloom/merge collation bullets) and `docs/schema.md` (MV backing-column
`collationExplicit` note) read and confirmed to reflect the new reality — the merge bullet
correctly states merge correctness rides on the collation-blind ordering property + the
conservative gate. No further doc drift found.
