----
description: Lens-prover law treatment for authored inverses — PutGet by const-evaluated enumeration over CHECK in(...) domains (`lens.putget-violation` hard error), the acknowledgeable `lens.getput-lossy` advisory (+ governance + domain-sensitive fingerprint), writable-intent satisfaction, row-local CHECK realizability/enforcement over authored columns (forward substitution, single-source), and the `inverse` disposition column on quereus_effective_lens. Reviewed: two soundness fixes (bijectivity suppression, multi-source CHECK realizability) applied in the review pass.
files:
  - packages/quereus/src/schema/lens-prover.ts          # branch (3) of proveRoundTrip; enumeration; proveForwardInjective; authoredForwardMap
  - packages/quereus/src/schema/lens-ack.ts             # domainValues in the fingerprint canonicalization
  - packages/quereus/src/planner/mutation/lens-enforcement.ts  # row-local CHECK rewrite: authored column → NEW-qualified forward
  - packages/quereus/src/func/builtins/explain.ts       # quereus_effective_lens `inverse` column + lensInverseDispositions
  - packages/quereus/test/logic/55.5-lens-authored-inverse.sqllogic  # 17 end-to-end scenarios
  - packages/quereus/test/lens-ack.spec.ts              # drift-lock (5 codes) + fingerprint domain tests
  - docs/lens.md                                        # errors table row, 3-branch firing rule, fingerprint facts, row-local forward substitution (single-source)
  - docs/view-updateability.md                          # § Authored inverses status bullet
  - docs/schema.md                                      # advisory code list includes lens.getput-lossy
----

# Authored inverses at the lens boundary — implemented + reviewed

Third step of `with inverse` (parser/AST → write path → **prover**). Normative
design: `docs/lens.md` § Computed and Generated Columns + § Coverage checklist;
`docs/view-updateability.md` § Authored inverses (law treatment).

## What landed (implement stage)

- **Firing-rule branch (3)** — `computeRoundTrip` attaches the resolved
  `authored` put payload + the forward `get` expression to a verdict;
  `proveRoundTrip` routes such columns to `checkAuthoredInverse` instead of
  branches (1)/(2). An authored column satisfies `quereus.lens.writable = true`
  by construction.
- **PutGet by enumeration** (`provePutGetByEnumeration`): the logical column's
  CHECK `in (...)` domain (cap 64; intersected across enum CHECKs, filtered
  through recognized range CHECKs). Per value, `forward(inverse(v))` is
  composed by AST substitution and const-evaluated (never a vtab read). A
  failing value is the hard, sited **`lens.putget-violation`** error; deploy
  blocks before catalog mutation. Degrades to safe on any precondition miss
  (no enumerable domain, multi-source, multi-column inverse, non-foldable).
- **`lens.getput-lossy` advisory** — warning severity, registered in
  `ADVISORY_CODE_LIST` so acks and `error-on` / `require-ack` escalations work
  uniformly. Suppressed on a read-only table; the PutGet *error* is NOT
  read-only-gated.
- **Bijectivity suppression** (`proveForwardInjective`): PutGet proved + a
  single NOT NULL put target with an enumerable basis CHECK domain + forward
  injective over that domain with images inside the logical domain + (added in
  review) **the inverse's put images inside the basis domain** ⇒ the pair is a
  bijection, GetPut holds, advisory suppressed.
- **Fingerprint domain sensitivity** — `FingerprintInputs.domainValues`
  (rendered + sorted; text quoted so `'1'` ≠ `1`), serialized conditionally so
  pre-existing advisory fingerprints are unchanged (pinned by unit test).
- **Row-local CHECK over an authored column** — `authoredForwardMap(slot)` is
  the agreement predicate between deploy realizability
  (`classifyCheckConstraint`) and the write-time rewrite
  (`lens-enforcement.ts`): the column ref is substituted with its forward
  `get` in `NEW.`-qualified basis terms. Restricted (in review) to
  **subquery-free forwards on single-source bodies**.
- **`quereus_effective_lens` `inverse` column** — `'authored'` / `'inferred'` /
  `'none'`, derived from the logically planned body's `updateLineage`,
  positionally aligned with provenance; a body that fails to plan degrades to
  `'none'`.

## Review findings

Reviewed against the implement diff (`0c879a2f`) with fresh eyes; every touched
file and the surrounding surfaces (`update-lineage.ts` AuthoredSite,
`check-extraction.ts` DomainConstraint, `scope-transform.ts` substitution
semantics, the advisories/ack machinery, all four docs) were read.
`yarn build`, `yarn lint`, and the full workspace `yarn test` pass after the
review fixes (quereus: 5747 passing / 9 pending; zero failures anywhere).

### Major — fixed in this pass (both are prover soundness holes, small targeted fixes)

1. **Bijectivity suppression was unsound: the inverse's image was never
   checked against the basis domain.** `proveForwardInjective` proved the
   *forward* injective over the basis CHECK domain with images inside the
   logical domain, and took PutGet + that as "bijection ⇒ GetPut holds ⇒
   suppress the advisory". The counting argument fails when `inverse(v)` lands
   *outside* the basis domain — PutGet can still pass through a forward's
   catch-all arm. Concrete counterexample (now pinned as scenario 11): basis
   `code in ('a','b')`, logical `grp in ('A','B')`, forward
   `case code when 'a' then 'A' else 'B' end`, inverse
   `code = case new.grp when 'A' then 'a' else 'z' end`. PutGet proves,
   forward is injective — the advisory was wrongly suppressed, yet
   `update set grp = grp` on a stored 'b' puts 'z' (GetPut violated; the write
   reds the basis CHECK at runtime). **Fix:** the PutGet enumeration now
   records the per-value put images and `proveForwardInjective` additionally
   requires each inside the basis domain (then |logical| ≤ |basis| ≤ |logical|
   ⇒ both maps are bijections and the inverse is exactly forward⁻¹).
2. **A CHECK over an authored column on a multi-source body deployed as
   row-local but silently never enforced.** `authoredForwardMap` admitted any
   subquery-free forward; on a join body whose forward reads a column of a
   *different member* than the put writes (probe: forward
   `upper(Core.code) || Aux.tag`, put on `code`), the substituted `NEW.tag` on
   the Core-member write row resolves NULL, the CHECK evaluates UNKNOWN, and
   an out-of-domain write lands silently — the basis reaches a state whose
   logical image violates the declared CHECK. Verified empirically before
   fixing. The clause's put targets are bare column names, so the slot AST
   cannot prove member-locality; **fix:** the agreement predicate now admits
   single-source bodies only (gate inside `authoredForwardMap`, so deploy and
   write-time move together). A multi-source CHECK over an authored column
   reds `lens.unrealizable-constraint` — honest and conservative; this
   over-blocks the single-side-forward join case that empirically *did*
   enforce (pinned as scenario 12's comment), accepted as the price of an
   AST-decidable predicate.

### Minor — fixed in this pass

- `docs/schema.md` § Acknowledging lens advisories enumerated the advisory
  codes without `lens.getput-lossy` — added.
- `docs/lens.md` (row-local CHECK paragraph) and `docs/view-updateability.md`
  (§ Authored inverses status bullet) updated for the single-source condition.

### Test coverage added (scenarios 11–17 in 55.5)

- 11: the bijectivity counterexample — advisory stands; write-back reds the
  basis CHECK.
- 12: join body + CHECK over authored column ⇒ `lens.unrealizable-constraint`.
- 13: read-only gate — a lossy authored inverse on a read-only table (authored
  PK ⇒ not reconstructible) deploys with **no** advisory; a write reds
  read-only. (The implement handoff claimed this posture untested.)
- 14: `lens.putget-violation` is NOT read-only-gated — same read-only shape
  with a wrong inverse still blocks the deploy.
- 15: the cross-side-forward leak shape ⇒ deploy rejection (regression pin for
  finding 2).
- 16: the same join-body authored inverse *without* a CHECK still deploys and
  writes through (the gate constrains only CHECK realizability).
- 17: range CHECK narrows the enum domain (integer domain) — an inverse only
  correct for the surviving values deploys clean (false-positive guard for
  `enumerableDomain`'s intersection/filter logic, previously untested), the
  advisory stands absent a basis domain, and both declared CHECKs enforce over
  the written image.

### Checked, no issues found

- **Index-space alignment**: `newRefIndex` (carrying select's output indexes)
  vs `ctx.outputIndex` (provenance order) — consistent because an authored
  site re-projected by an outer select degrades to `computed` in
  `update-lineage.ts` before it could misalign.
- **Const-evaluation safety**: `evalDeployConstant` try/catches, rejects
  async results (with a swallowed `.catch` to avoid unhandled rejections),
  and never reads a vtab; `constEvaluable` treats unregistered functions as
  deterministic with the eval-failure degrade as backstop — sound.
- **Value semantics**: `sqlValueEquals` (NULL-as-identity), cross-type
  `compareSqlValues`, NULLs dropped from enum domains, NOT NULL basis
  requirement for injectivity — all conservative. `renderSqlValue` quoting is
  injective across the type shapes that can appear in a domain.
- **Error/advisory ordering**: a definite violation wins over another value's
  evaluation failure; `indeterminate` keeps the advisory; `proved && injective`
  is the only suppression.
- **`quereus_effective_lens`**: declared 6-column shape matches the yield and
  the docs table; plan-failure degrades to `'none'` instead of failing the
  TVF.
- **Fingerprint compatibility**: `domainValues` serialized conditionally;
  pre-existing hashes pinned unchanged by unit test; drift-lock updated to 5
  codes.
- **Docs**: lens.md (errors table, 3-branch firing rule, advisory row,
  fingerprint facts, governance list), view-updateability.md, migration.md
  cross-references all accurate post-fix.

### Accepted gaps (documented, not regressions)

- Out-of-fragment (join/aggregate/etc.) bodies emit neither the PutGet error
  nor the lossy advisory (scenario 9) — the prover's wholesale degrade-to-safe
  posture, stated explicitly in lens.md's firing-rule paragraph.
- NULL is never enumerated; a nullable logical column's NULL write path is
  unverified (degrade).
- An unrecognized CHECK shape (e.g. a UDF conjunct) cannot narrow the enum
  domain, so a value excluded only by it could still red
  `lens.putget-violation` — residual theoretical over-block, accepted.
- The redundant-on-passthrough advisory remains unimplemented (docs say so).

### Spawned tickets

- `backlog/authored-inverse-key-reconstructibility` — PK/UNIQUE over a
  *proven-bijective* authored column still forces read-only /
  `lens.unrealizable-constraint` (scenario 13 pins the read-only outcome);
  scoped out by the implement stage, filed as a future enhancement with a
  specification sketch.
