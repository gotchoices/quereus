----
description: Lens-prover law treatment for authored inverses — PutGet by const-evaluated enumeration over CHECK in(...) domains (`lens.putget-violation` hard error), the acknowledgeable `lens.getput-lossy` advisory (+ governance + domain-sensitive fingerprint), writable-intent satisfaction, row-local CHECK realizability/enforcement over authored columns (forward substitution), and the `inverse` disposition column on quereus_effective_lens.
prereq: authored-inverse-write-path
files:
  - packages/quereus/src/schema/lens-prover.ts          # branch (3) of proveRoundTrip; enumeration; authoredForwardMap
  - packages/quereus/src/schema/lens-ack.ts             # domainValues in the fingerprint canonicalization
  - packages/quereus/src/planner/mutation/lens-enforcement.ts  # row-local CHECK rewrite: authored column → NEW-qualified forward
  - packages/quereus/src/func/builtins/explain.ts       # quereus_effective_lens `inverse` column + lensInverseDispositions
  - packages/quereus/test/logic/55.5-lens-authored-inverse.sqllogic  # 10 end-to-end scenarios
  - packages/quereus/test/lens-ack.spec.ts              # drift-lock (5 codes) + fingerprint domain tests
  - docs/lens.md                                        # errors table row, 3-branch firing rule, fingerprint facts, row-local forward substitution
  - docs/view-updateability.md                          # § Authored inverses status bullet (lens prover wired)
----

# Authored inverses at the lens boundary — implemented

Third step of `with inverse` (parser/AST → write path → **prover**). Normative
design: `docs/lens.md` § Computed and Generated Columns + § Coverage checklist;
`docs/view-updateability.md` § Authored inverses (law treatment). `yarn build`,
`yarn lint`, and the full workspace `yarn test` pass (quereus: 5747 passing /
9 pre-existing pending; zero failures anywhere).

## What landed

- **Firing-rule branch (3)** — `computeRoundTrip` now attaches the resolved
  `authored` put payload + the forward `get` expression to a verdict
  (`ColumnRoundTrip.authored` / `.forward`, additive fields); `proveRoundTrip`
  routes such columns to `checkAuthoredInverse` instead of branches (1)/(2).
  An authored column is writable by construction, so `quereus.lens.writable =
  true` is satisfied exactly as for an inferred inverse (branch 2 cannot fire).
- **PutGet by enumeration** (`provePutGetByEnumeration`): the logical column's
  CHECK `in (...)` domain (cap 64; intersected across multiple enum CHECKs and
  filtered through recognized range CHECKs on the same column, so a value the
  declared CHECK surface excludes is never enumerated — a false error would
  block a sound deploy; NULLs dropped). Per value, `forward(inverse(v))` is
  composed by AST substitution (`substituteNewRefs` + literal base images) and
  evaluated with the engine's const evaluator (`createRuntimeExpressionEvaluator`
  via a bare one-column SELECT plan — never a vtab read; an async/throwing
  evaluation degrades). A failing value is the hard, sited
  **`lens.putget-violation`** error naming the written value and what it reads
  back as; it aggregates into the prover's atomic-throw channel (deploy blocks
  before catalog mutation). A definite violation wins over another value's
  evaluation failure.
- **`lens.getput-lossy` advisory** — warning severity, emitted for every
  authored column the enumeration does not prove bijective. Registered in
  `ADVISORY_CODE_LIST`, so `quereus.lens.ack.getput-lossy[:<column>]` and the
  `error-on` / `require-ack` escalations work uniformly (the recognized-targets
  set and unknown-code fail-loud derive from that single list). Suppressed on a
  read-only table (puts never run — same gate as `lens.no-backing-index`); the
  PutGet *error* is deliberately NOT read-only-gated, mirroring branch (1)'s
  posture that a provably unsound declared write path is an authoring error.
- **Bijectivity suppression** (`proveForwardInjective`): requires a single put
  target backed by a NOT NULL basis column with its own enumerable CHECK
  domain; every forward image must be non-NULL, land inside the logical
  domain, and be pairwise distinct. With PutGet proved that makes the pair a
  bijection between the two enumerated domains, so GetPut holds and no
  advisory is emitted.
- **Fingerprint domain sensitivity** — new optional
  `FingerprintInputs.domainValues` (rendered + sorted; text values quoted so
  `'1'` ≠ `1`), serialized into `computeAdvisoryFingerprint` **conditionally**
  so every pre-existing advisory fingerprint is unchanged (pinned by unit
  test). A CHECK in-list change re-surfaces a `#fp=`-recorded ack.
- **Row-local CHECK over an authored column** (not in the ticket's file list,
  but required by its canonical scenario): `classifyCheckConstraint` previously
  red `lens.unrealizable-constraint` for any CHECK referencing a non-bare-column
  projection — which would have blocked the code-collapse lens (the CHECK
  in (...) sits on the authored column). New exported `authoredForwardMap(slot)`
  (subquery-free forwards only) is the **agreement predicate** between deploy
  acceptance and the write-time rewrite: `lens-enforcement.ts` now substitutes
  the column ref with its forward `get` in `NEW.`-qualified basis terms (the
  CHECK evaluates over the written basis row's logical image), and
  `referencedWriteRowColumns` carries the forward's basis refs for the
  decomposition gate.
- **`quereus_effective_lens` `inverse` column** — third column
  (`logical_column, source, inverse, advertised_member, advertisement_anchor,
  effective_sql`, matching the docs table): `'authored'` / `'inferred'` /
  `'none'`, derived from the logically planned body's `updateLineage` (the
  same surface `column_info` reads), positionally aligned with provenance. A
  null-extended (optional-member) base column reports `'inferred'` (its put is
  materialized by the fan-out); a body that fails to plan degrades every
  column to `'none'` rather than failing the TVF. No existing test pinned the
  TVF's full shape (all select named columns), so only the docs table needed
  reconciling — it already matched.

## Validation / use cases (all pinned in 55.5-lens-authored-inverse.sqllogic)

1. Code-collapse lens (5-code basis → 3-code logical) deploys with the
   advisory (active, sited at the column); reads collapse; UPDATE/INSERT lower
   through the put; `update set grp = grp` demonstrates the GetPut surrender
   (B2 → B1 normalization); the logical CHECK rejects an out-of-domain insert
   via the substituted forward.
2. In-source ack (`:grp`-targeted, bare rationale) → `acknowledged-unconditional`.
3. `require-ack` errors the un-acknowledged instance at deploy.
4. `error-on` is a hard error an ack cannot suppress.
5. A deliberately wrong inverse (`'A'` → `'B1'`, forward('B1') = 'B') reds
   `lens.putget-violation` at deploy.
6. A bijective enumerable mapping (`upper`/`lower` over matching 3-value
   domains) emits **no** advisory; operational GetPut/PutGet pinned.
7. Mixed-table effective-lens dispositions: authored / inferred (covered +
   gap-filled identity) / none (computed) + `source` cross-check.
8. `quereus.lens.writable = true` satisfied by an authored inverse (no
   `lens.non-invertible`); write-through works.
9. Out-of-fragment (join) body + authored inverse + writable tag: degrade-to-
   safe holds — no error AND no advisory (see review note below).
10. A subquery (non-const-foldable) inverse over an enumerable domain degrades
    to safe — deploys with the advisory, never crashes; the mutation-time
    lowering still evaluates the subquery put.

Unit tests: drift-lock updated to the five governable codes; fingerprint
domain sensitivity (in-list change moves the hash; order-insensitive;
absence-of-domain leaves pre-existing hashes untouched). Fingerprint
re-surfacing mechanics ride the existing `#fp=` machinery unchanged and are
covered by the pre-existing lens-ack suite.

## Design decisions & known gaps (review attention here)

- **Out-of-fragment bodies emit no advisory** (scenario 9): `computeRoundTrip`
  returns no verdicts outside the single-source projection-and-filter
  fragment, so the authored branch never runs — neither the enumeration nor
  the lossy advisory. The ticket mandated only that the error branches not
  fire; I read the prover's wholesale degrade posture as also covering the
  advisory. A multi-source authored column (join UPDATE is a live write path)
  is therefore advisory-silent. Defensible but debatable — flagging it.
- **Enumeration preconditions** (any miss ⇒ degrade, advisory stands):
  single basis source (forward refs name-match against put targets — ambiguous
  past single-source); inverse a function of the written column alone (every
  `new.*` ref resolves to it — a co-referencing inverse like
  `new.a || new.b` is never enumerated); deterministic, subquery-free puts and
  forward; forward refs ⊆ put targets.
- **NULL is never enumerated**: a nullable logical column's NULL write path is
  unverified (degrade); injectivity additionally requires a NOT NULL basis
  column. CHECK-passes-on-NULL semantics make this the conservative read.
- **Residual theoretical over-block**: an unrecognized CHECK shape (e.g. a
  UDF conjunct `check (valid(grp))`) cannot narrow the enum domain, so a value
  excluded only by such a CHECK could still red `lens.putget-violation`.
  Enum∩enum and range filtering are implemented; this corner is accepted and
  noted here rather than handled.
- **UNIQUE / PK over an authored column is unchanged**: still
  `lens.unrealizable-constraint` / read-only respectively (uniqueness of the
  computed image is not realizable through the puts; out of this ticket's
  scope).
- **Deploy cost**: the enumeration builds a tiny one-column SELECT plan per
  (domain value × put) + per basis value for injectivity — bounded by the
  64-value cap; deploy-time only.
- The pre-existing 93.5 lens scenario (`speed * 2` with inverse, no CHECK
  domain) now emits a non-blocking `lens.getput-lossy` advisory — its
  assertions are unaffected.
- The redundant-on-passthrough advisory mentioned in
  docs/view-updateability.md remains unimplemented (explicitly out of scope;
  doc still says so).
