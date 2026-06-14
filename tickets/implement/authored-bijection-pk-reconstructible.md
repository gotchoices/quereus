description: A proven-bijective authored inverse makes its logical PK column key-reconstructible — a PK over a `with inverse` column whose forward/inverse pair the prover proved a bijection deploys WRITABLE instead of read-only. The non-injective (lossy) case stays read-only, unchanged.
prereq:
difficulty: hard
files:
  - packages/quereus/src/schema/lens-prover.ts            # proveLens ordering, checkKeyReconstructibility, provePutGetByEnumeration, classifyKeyConstraint, checkAuthoredInverse
  - packages/quereus/src/schema/table.ts                  # new shared columnsFormDeclaredKey helper (PK + non-partial UNIQUE set-equality)
  - packages/quereus/src/schema/lens-compiler.ts          # indicesFormDeclaredUnique (refactor onto the shared helper, optional DRY)
  - packages/quereus/src/planner/mutation/single-source.ts # analyzeView read-only gate; columnMap WHERE-lowering for an authored PK (verify/fix keyed access)
  - packages/quereus/test/logic/55.5-lens-authored-inverse.sqllogic # scenario 13 (unchanged), new bijective-PK scenarios
  - packages/quereus/test/property.spec.ts                # View Round-Trip Laws — computeRoundTrip agreement must not regress
  - packages/quereus/test/lens-enforcement.spec.ts        # pin the `proved` classification for a bijective authored PK
  - docs/lens.md                                          # Coverage checklist key-reconstructibility note + round-trip §

# PK over a proven-bijective authored inverse → writable

## Problem

`checkKeyReconstructibility` (`lens-prover.ts:463`) decides read-only via
`isReconstructibleColumn` — a **bare-column-projection** test
(`rc.type === 'column' && rc.expr.type === 'column'`). A logical PK column
written through an authored (`with inverse`) put is a *computed* projection
(`upper(code) as grp`), so it fails the test and the table deploys read-only
(`lens.pk-not-reconstructible`) — even when the prover's enumeration has already
proved the forward/inverse pair a **bijection** between the basis and logical
CHECK domains (the same `{kind:'proved', injective:true}` verdict that suppresses
`lens.getput-lossy`). Semantically a bijective key is fully reconstructible: a
written logical key maps to exactly one basis key and back.

Scenario 13 of `55.5-lens-authored-inverse.sqllogic` pins the read-only outcome
for the **non-injective** case (`substr(code,1,1)` collapses `A1`/`A2`), which is
correct and must stay read-only. The gap is only the *bijective* case.

## Design

### 1. Thread the proven-bijection verdict ahead of key reconstructibility

Today `proveLens` (`lens-prover.ts:232`) computes `readOnly` (which runs
`checkKeyReconstructibility`) **before** `proveRoundTrip` — yet the bijection
verdict is produced *inside* `proveRoundTrip` → `checkAuthoredInverse` →
`provePutGetByEnumeration`. Reorder so the round-trip enumeration runs **once, up
front**, and both consumers read it:

```
proveLens(slot, db):
  ctx = buildProveContext(...)
  checkColumnCoverage / checkTypeAndNullability        (unchanged)
  rt = analyzeRoundTrip(ctx)                            // plan logical body ONCE; computeRoundTrip; per-authored-column provePutGetByEnumeration cached
  bijectiveAuthored = bijectiveAuthoredColumns(rt)      // Set<lowercased col> where enum.kind==='proved' && injective
  readOnly = checkKeyReconstructibility(ctx, bijectiveAuthored, warnings)
  emitRoundTrip(ctx, rt, readOnly, errors, warnings)    // emits putget-violation / getput-lossy / branches (1)(2) from cached verdicts+enum
  obligations = classifyObligations(ctx, readOnly, bijectiveAuthored, errors, warnings)
  checkAnsweringStructures / checkPartialOverride       (unchanged)
```

- `analyzeRoundTrip(ctx)` → `{ verdicts?: ColumnRoundTrip[]; authoredEnum: Map<lowerCol, PutGetEnumeration> }`.
  It plans the body logically (`planLogicalBody`), runs `computeRoundTrip`, and
  for each `v.authored` verdict caches `provePutGetByEnumeration(ctx, column,
  v.authored, v.forward)`. A degrade-to-safe body (no verdicts) yields an empty
  map. **Run the enumeration exactly once** — `emitRoundTrip` consumes the cached
  result, it does not recompute.
- Split today's `checkAuthoredInverse` into (a) the proof — now hoisted into
  `analyzeRoundTrip` — and (b) diagnostic emission (`emitAuthoredInverseDiagnostics`),
  which takes the cached `PutGetEnumeration` plus `readOnly` and pushes the
  `lens.putget-violation` error / `lens.getput-lossy` warning **byte-identically
  to today** (same codes, severities, messages, fingerprints, ordering). This is a
  pure refactor: every existing 55.5 scenario (1–17) and `property.spec.ts` § View
  Round-Trip Laws must pass unchanged before any behavior flip.

### 2. Bijective authored PK column counts as reconstructible

`checkKeyReconstructibility` gains the `bijectiveAuthored` set; a PK column is
reconstructible iff `isReconstructibleColumn(ctx, name) || bijectiveAuthored.has(name.toLowerCase())`.
When every PK column passes, `readOnly` is false → the table deploys writable.
The non-injective authored PK (not in the set) and any computed/opaque PK column
remain read-only exactly as today.

### 3. PK obligation: `proved` by bijection-transport over a basis key

Once writable, the bijective authored PK still flows through `classifyKeyConstraint`
(`lens-prover.ts:1374`). Without help it would fall to `enforced-set-level
commit-time` and emit a spurious `lens.no-backing-index` (and contribute no
asserted FD). Add a **bijection-transport proof** consulted after the existing
`proveEffectiveKeyUnique` check and before `findBasisCovering`:

> If every key column is bare-reconstructible **or** authored-bijective (in
> `bijectiveAuthored`), map each to its basis column — bare via the existing
> projection, authored via its **single** put-target basis column (`rc.inverse`'s
> sole `p.baseColumn`) — and if those basis columns exactly form a **declared
> basis key** (the basis `primaryKeyDefinition`, or a **non-partial** basis
> `uniqueConstraints` entry), classify the logical key **`proved`**.

Rationale: a bijection is injective, so two distinct logical keys map to two
distinct basis keys; a basis key forbids the collision. The logical key is
therefore intrinsically unique — zero runtime enforcement, like any `proved` key.
This subsumes both the basis-PK and basis-UNIQUE cases (a basis UNIQUE alone
entails it via the bijection — no covering MV required), so the authored key never
needs the row-time/covering path. Absent a declared basis key over the
put-target, it correctly falls to `commit-time` + `lens.no-backing-index` (the
O(n) scan over the forward image is the honest enforcement).

Add the set-equality test as a shared `columnsFormDeclaredKey(table, indices)` in
`schema/table.ts` (checks `primaryKeyDefinition` and non-partial `uniqueConstraints`
for exact column-set equality) — this is exactly what `lens-compiler.ts`
`indicesFormDeclaredUnique` already does; refactor that onto the shared helper to
stay DRY. Do **not** import lens-compiler into lens-prover (would risk a cycle —
lens-compiler already type-imports `ConstraintObligation` from lens-prover); the
shared home is `table.ts`, already imported by lens-prover (`resolvePkDefaultConflict`).

`mappedBasisColumn` / `findBasisCovering` are **left untouched** — the
authored-bijective mapping lives only in the new transport helper, so the existing
bare-column covering path (and the plan-time `revalidateRowTime`) keep their exact
semantics. An authored key never classifies `row-time`, so the plan-time FD path
(`computeLensAssertedKeyFds` → `assertedFdForObligation`) needs **no** bijection
knowledge: it reads the stored `proved` obligation and contributes the
unconditional key FD via the existing `proved` arm. Soundness of that unconditional
FD: `proveForwardInjective` already requires the basis put-target column NOT NULL
and a never-NULL forward image, and the column's enumerable CHECK domain excludes
NULL, so the logical key is non-null and unconditionally unique.

### 4. Mutation-time keyed access — verify, then test

Confirmed by reading the write path: `delete/update … where <authored-pk> = lit`
lowers correctly. `analyzeView` builds `columnMap` (single-source.ts:556) mapping
an authored column to its **forward** `get` expression (the lineage is computed,
so `columnMap.set(grp, normalizeBaseRefs(upper(code)))`); `remapper`
(single-source.ts:833) substitutes it into the user WHERE, so `where grp = 'A'`
becomes `where upper(code) = 'A'` over the basis — location uses the forward (read
direction), **not** the inverse. The put is applied only to the SET value
(UPDATE) / supplied cell (INSERT), already exercised for a non-PK authored column
in scenario 1. The `lensSlot?.readOnly` gate (single-source.ts:`analyzeView`) now
sees `readOnly === false` and admits the write.

This path is **untested for an authored column in the WHERE**. The implementer
MUST add end-to-end tests (below) and, if any of insert / update-by-key /
delete-by-key over a bijective authored PK does not work, fix it in
single-source.ts (the expected fix surface is `columnMap` lowering + the
`writableSites` authored fan-out, both already present). Do not flip the verdict
without the write path proven by a passing test.

## Edge cases & interactions

- **Non-injective authored PK stays read-only** (scenario 13: `substr` collapses
  `A1`/`A2`). Not in `bijectiveAuthored` → `readOnly` stays true → `insert` reds
  `read-only`. Assertions unchanged; only tighten the comment to say the gate is
  now the bijection verdict, not the bare-column test.
- **PutGet-violation PK stays a hard error** (scenario 14): the
  `lens.putget-violation` branch is NOT read-only-gated and fires regardless of
  the new writability — must still error at deploy.
- **getput-lossy suppression path**: for a bijective PK the advisory is suppressed
  by the `proved && injective` branch (writable table, `readOnly === false`); for
  the non-injective PK it stays suppressed by the read-only gate. Both unchanged
  from today's outcomes.
- **Singleton/empty PK** (`pk.length === 0`): still vacuously reconstructible
  (early return) — the bijection set is not consulted.
- **Mixed key** (one bare-reconstructible + one authored-bijective column): the
  transport proof must map both and test the combined basis-column set against a
  basis key. Authored put with **more than one** put-target column, or a put-target
  that is not a single bare basis column, bails the transport proof (→ falls to the
  commit-time fallback, never an unsound `proved`).
- **Authored bijective PK, no basis key over the put-target**: e.g. basis column
  has a CHECK domain + NOT NULL (so the bijection proves) but is *not* itself a
  basis PK/UNIQUE. Then the logical key is NOT intrinsically unique (two basis rows
  can share the value) → must classify `commit-time` + `lens.no-backing-index`, NOT
  `proved`. The `columnsFormDeclaredKey` gate is load-bearing here.
- **Degrade-to-safe body** (out-of-fragment / no lineage / negation in residual):
  `analyzeRoundTrip` yields no verdicts → empty `bijectiveAuthored` → the authored
  PK stays read-only (today's behavior; the completeness gap is intentional). An
  authored PK on a join body (scenario 9-shape) does not flip.
- **FD soundness**: the unconditional `proved` FD must only be contributed for the
  bijection-transport-proved key (basis key + injective). A regression here can make
  the optimizer drop rows (DISTINCT / join-elimination) — pin with a read-side test
  that the bijective-PK lens contributes the key FD AND that a non-injective /
  no-basis-key authored key contributes none.
- **Plan-time/out-of-band currency**: a `proved` authored key contributes the FD
  with no replanning (no `revalidateRowTime`). If the basis key is dropped
  out-of-band the FD goes stale — this matches the existing `proved`-key posture
  for a bare projection of a basis key (also not re-validated), so it is consistent,
  not a new hazard. Document, do not over-engineer.
- **Store mode**: the read-only flip and keyed write path must hold under
  `yarn test:store` too (the authored put fan-out and covering resolution differ
  per backend). Run the new scenarios under the store path if feasible; if not
  agent-runnable in-ticket, note the deferral.

## Key tests (expected outputs)

A new scenario block in `55.5-lens-authored-inverse.sqllogic`, mirroring scenario
6's bijective shape but with the authored column as the **PK** (single-column
table so the PK *is* the authored column), backed by a basis whose put-target is a
declared key:

```
declare schema bpk_b { table Item ( code text primary key check (code in ('a','b','c')) ) }
apply schema bpk_b;
insert into bpk_b.Item values ('b');
declare logical schema bpk_x { table Item ( grp text primary key check (grp in ('A','B','C')) ) }
declare lens for bpk_x over bpk_b {
  view Item as select upper(code) as grp with inverse (code = lower(new.grp)) from bpk_b.Item
}
apply schema bpk_x;
```

- No `lens.getput-lossy` advisory (bijective): `select count(*) … = 'lens.getput-lossy'` → `[{"n": 0}]`.
- No `lens.pk-not-reconstructible` and no `lens.no-backing-index`:
  `select count(*) from quereus_lens_advisories('bpk_x')` → `[{"n": 0}]`.
- Read: `select * from bpk_x.Item` → `[{"grp": "B"}]`.
- INSERT through the put: `insert into bpk_x.Item values ('A'); select code from bpk_b.Item order by code` → includes `'a'`.
- UPDATE by authored key (forward in WHERE, put in SET):
  `update bpk_x.Item set grp = 'C' where grp = 'B'; select code from bpk_b.Item where code = 'c'` → `[{"code": "c"}]`.
- DELETE by authored key: `delete from bpk_x.Item where grp = 'A'; select count(*) from bpk_b.Item where code = 'a'` → `[{"n": 0}]`.
- GetPut still byte-stable (bijection): `update bpk_x.Item set grp = grp where grp = 'C'; select code from bpk_b.Item where code = 'c'` → `[{"code": "c"}]`.
- A bijective authored column whose put-target is **not** a basis key (basis column
  with CHECK+NOT NULL but no PK/UNIQUE, made the logical PK) → still read-only OR (if
  you make it a non-PK with the table otherwise keyed) classifies `commit-time` with
  `lens.no-backing-index` — pin whichever shape exercises "bijective but no basis
  key ⇒ not proved".

`lens-enforcement.spec.ts`: pin that the bijective authored PK obligation is
`proved` (not `commit-time`), so a future regression to commit-time is caught.

`property.spec.ts` § View Round-Trip Laws: the `computeRoundTrip` agreement test
(`property.spec.ts:5054`) must still pass — the refactor changes call ordering, not
`computeRoundTrip`'s output.

## TODO

- Refactor `proveLens`: extract `analyzeRoundTrip(ctx)` (plan body once + cache
  per-authored-column `provePutGetByEnumeration`); add `bijectiveAuthoredColumns(rt)`;
  reorder so the bijection set is available before `checkKeyReconstructibility`.
- Split `checkAuthoredInverse` into the hoisted proof + `emitAuthoredInverseDiagnostics`
  (consumes cached enum + `readOnly`); add `emitRoundTrip` consuming cached verdicts.
  Verify byte-identical diagnostics on scenarios 1–17.
- Add `bijectiveAuthored` param to `checkKeyReconstructibility`; reconstructible =
  bare OR bijective-authored. Update the function/`isReconstructibleColumn` doc comments.
- Add `columnsFormDeclaredKey(table, indices)` to `schema/table.ts`; refactor
  `lens-compiler.ts` `indicesFormDeclaredUnique` onto it.
- Add the bijection-transport `proved` branch to `classifyKeyConstraint` (thread
  `bijectiveAuthored` through `classifyObligations`/`classifyConstraint`); map authored
  key columns to their single put-target; gate on `columnsFormDeclaredKey(basis, …)`.
- Verify the mutation-time keyed write path (insert / update-by-key / delete-by-key)
  for a bijective authored PK; fix `single-source.ts` only if a test proves it broken.
- Add the new bijective-PK scenarios to `55.5-lens-authored-inverse.sqllogic`;
  tighten scenario 13's comment; add the `proved`-classification pin in
  `lens-enforcement.spec.ts`.
- Update `docs/lens.md` Coverage checklist key-reconstructibility note (§354/§358) and
  the round-trip § (§370) — a proven bijection now makes an authored PK reconstructible;
  the non-injective case stays read-only.
- `yarn lint` + `yarn test` (and `yarn test:store` for the new scenarios if runnable);
  stream output with `tee`.
