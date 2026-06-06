description: Plan-time rejection of a 1:many cross-source `update v set owner.x = partner.y` (where the owning/assigned side joins more than one partner row) with a dedicated `cross-source-ambiguous-cardinality` diagnostic naming the ambiguity, instead of the generic runtime `Scalar subquery returned more than one row`. The proof is partner-side uniqueness (PK / non-partial UNIQUE constraint / non-partial UNIQUE index ⊆ the join-pinned partner columns); the FK-child-reads-parent (at-most-one) direction stays accepted.
files: packages/quereus/src/planner/mutation/multi-source.ts (ownerJoinsAtMostOnePartner, stripSideQualifier gate, decomposeUpdate gate closure), packages/quereus/src/planner/mutation/mutation-diagnostic.ts (MutationDiagnosticReason), packages/quereus/test/logic/93.4-view-mutation.sqllogic, packages/quereus/test/quereus/view-mutation-substrate.spec.ts, docs/view-updateability.md
----

## What shipped

A cross-source `update v set owner.x = partner.y` is well-defined only when the owning
(assigned) side joins **at most one** partner row — the `__vmupd_keys` capture carries one
`srcN` row per joined owner/partner pair, so the per-row correlated read-back is
single-valued exactly in that direction. The implementation:

- **`MutationDiagnosticReason`** — adds `cross-source-ambiguous-cardinality` (carries the
  assigned view column + the view name).
- **`ownerJoinsAtMostOnePartner(ownerIdx, partnerIdx, sel, sides)`** — the proof. Collects
  the join's **direct** owner↔partner `column = column` equalities
  (`collectCrossSideEqualities`), gathers the partner-side columns they pin, and returns
  `true` iff some **non-empty** unique key of the partner table ⊆ that pinned set. Unique
  keys: the PRIMARY KEY, every **non-partial** UNIQUE constraint, every **non-partial**
  UNIQUE index. No direct equality (multi-hop) ⇒ `false` (conservative reject).
- **The gate** — `stripSideQualifier` gained `gateCrossSourceCardinality`, called at the
  rewrite site (covers a nested-in-value-subquery partner ref as well as a top-level one),
  built per-assignment in `decomposeUpdate` (capture-carrier path only, memoized per partner
  side). Ordering preserved: the lineage gate (`gateCrossSourceReads`) runs first so a
  computed partner column still rejects `no-inverse`; the legacy `propagateMultiSource` path
  rejects `cross-source-assignment` before this gate is reached.
- **Tests + docs** — see Review findings below.

## Review findings

**Implement-stage diff reviewed first (commit `34097f89`), with fresh eyes, before the
handoff summary.** Adversarial pass across SPP, DRY, modularity, soundness, type safety,
schema-metadata assumptions, error handling, resource cleanup, edge/error/regression
coverage, and docs.

### Soundness of the proof — VERIFIED, no issues
- The proof direction is correct: pinning **all** columns of a partner **unique key** to
  per-owner-row values admits ≤1 partner row. NULL handling is sound — a `=` join never
  matches NULLs, and a unique key bounds each non-null value tuple to ≤1 row (PK columns are
  NOT NULL regardless). The `cols.length > 0` guard correctly excludes a degenerate empty PK
  (`primary key ()`), an accepted residual conservatism.
- `provesAtMostOne` requires **every** unique-key column to be pinned (`cols.every`) — a
  partially-pinned composite key does not falsely prove at-most-one. Confirmed.
- Self-join (`ax_xs_self`) and composite-PK owner (`ax_xscpk_v`) accepts: the proof keys on
  the **partner**'s unique key (alias-resolved), not the owner's — both confirmed still
  accepted by the full suite. The owner's composite PK only widens the correlation; it is
  never the cardinality bound.
- The `resolveColumnSide(partnerCol) === undefined` silent-skip in the gate closure was
  scrutinized as a potential soundness hole: it is unreachable in practice — the gate is
  only handed columns that already matched `otherQuals` (qualified, resolving to a real other
  side), so `resolveColumnSide` always returns a defined index there. Not a hole.

### Schema-metadata assumptions — VERIFIED against `schema/table.ts` and `schema/manager.ts`
- `IndexColumnSchema.index` / `PrimaryKeyColumnDefinition.index` are column ordinals;
  `UniqueConstraintSchema.columns` are column ordinals; both `UniqueConstraintSchema` and
  `IndexSchema` carry `predicate?`. The proof reads all of these correctly.
- **The `indexes` branch is effectively defensive/unreachable via SQL DDL**: `CREATE UNIQUE
  INDEX` (both `SchemaManager.addIndexToTableSchema` and the store module) **always**
  synthesizes a mirrored `uniqueConstraints` entry (with `predicate` mirrored), so a
  non-partial unique index is already caught by the UNIQUE-constraint branch, and a partial
  one is excluded from both. The `indexes` branch is sound belt-and-suspenders for any future
  path that adds a unique index without the mirror; **left in place** (removing it would be
  behavior-neutral but the defensive value is reasonable). This is why no SQL test can
  exercise the index branch *in isolation*.

### Coverage — gaps from the handoff's "Review focus" closed (minor, fixed inline)
Two implemented-but-untested branches now have dedicated sqllogic coverage in
`93.4-view-mutation.sqllogic`:
- **Partial-unique-key exclusion (reject)** — `xs1pp_v`: the partner's only unique key on
  the join column is a **partial** UNIQUE index (`create unique index … where pv > 0`), and
  the table genuinely holds two `pcode=500` rows (one outside the partial scope), so the
  child really joins both. Confirms the `predicate` exclusion rejects at plan time rather
  than failing at runtime — and incidentally confirms the engine honors the partial
  predicate at insert time (both rows inserted).
- **Multi-hop / transitive (reject)** — reuses the 3-way `ax_three` view: owner `p`
  (ax_parent) and partner `b` (ax_b) connect only through `c` (ax_child), so no direct
  equality pins a partner column ⇒ conservative reject. Confirms the n-way build path reaches
  the gate and the `partnerEquatedCols.size === 0` branch fires.

Pre-existing coverage confirmed adequate and re-run green: the 1:many reject (`xs1n_v`,
FK-parent-reads-child), the UNIQUE-constraint accept (`xs1u_v`), the structured-`reason`
spec (`view-mutation-substrate.spec.ts`, both the reject and the FK-child-reads-parent
accept), and every pre-existing cross-source accept/reject.
- **Nested-in-value-subquery** partner ref: reviewed — the gate fires through the **same**
  shared `substitute` closure walked into subqueries via `mapQueryExprUniform`, so the
  behavior is identical to the top-level case already covered; a dedicated test would only
  re-exercise the same code path and risk coupling to unrelated scalar-subquery lowering, so
  **not added** (deliberate, documented here).

### DRY / modularity / type safety / resource cleanup — no findings
- `ownerJoinsAtMostOnePartner` reuses `collectCrossSideEqualities` and mirrors
  `edgeCorrelated`'s structure (FK not required). The gate memoizes per partner side; no
  redundant recomputation, no leaks, no `any`. Small single-purpose helper.

### Docs — VERIFIED up to date
- `docs/view-updateability.md` § Inner Join cross-source `set` and § Current limitations
  accurately describe the at-most-one requirement, the partner-side-uniqueness proof, the
  multi-hop conservative reject, the partial-key exclusion, and the new reason in the
  "still rejected" list. No other doc enumerates the diagnostic reasons (the reason is
  documented inline on `MutationDiagnosticReason`).

### Validation
- `yarn workspace @quereus/quereus run build` — clean.
- `eslint 'src/**/*.ts' 'test/**/*.ts'` — clean.
- `logic.spec.ts --grep 93.4-view-mutation` — passing (incl. the 2 new reject cases).
- `view-mutation-substrate.spec.ts` — 6 passing.
- Full memory suite (`test-runner.mjs`) — **4913 passing, 9 pending, 0 failing**.
- `yarn test:store` not run (plan-time schema-metadata proof, module-independent — store
  path not expected to differ). Noted for completeness, not a gap.

### Disposition
No major findings — no new tickets filed. Two minor coverage gaps fixed inline. No
pre-existing failures encountered.
