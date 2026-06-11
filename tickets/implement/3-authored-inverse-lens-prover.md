description: Lens-prover integration for authored inverses — PutGet checked by composition (enumeration over CHECK-constrained domains), the new acknowledgeable `lens.getput-lossy` advisory, writable-intent tag satisfaction, and the `inverse` disposition column on quereus_effective_lens.
prereq: authored-inverse-write-path
files:
  - packages/quereus/src/schema/lens-prover.ts        # proveRoundTrip: authored-inverse branch; PutGet enumeration
  - packages/quereus/src/schema/lens-ack.ts           # lens.getput-lossy in the governed advisory vocabulary
  - packages/quereus/src/func/builtins/explain.ts     # quereus_effective_lens `inverse` column
  - packages/quereus/src/planner/analysis/const-evaluator.ts  # (consume) enumeration evaluation
  - packages/quereus/test/logic/                      # lens authored-inverse logic tests
  - docs/lens.md                                      # advisory table + effective-lens table (already written — reconcile)
  - docs/view-updateability.md                        # § Authored inverses law-treatment bullet (already written — reconcile)
----

# Authored inverses at the lens boundary

Third step. The write path works (`authored-inverse-write-path`); this ticket
makes the lens prover *reason* about it at deploy. Normative design:
`docs/lens.md` § Computed and Generated Columns (authored-inverses paragraph),
§ Coverage checklist (the `lens.getput-lossy` advisory row), and
`docs/view-updateability.md` § Authored inverses (law treatment).

## Prover behavior per authored-inverse column

At `proveLens`, a logical column whose lens-body result column carries an
authored inverse is **writable** (it satisfies `quereus.lens.writable = true`
intent exactly as an inferred inverse does — branch (2) of the round-trip
firing rule must not fire for it).

**PutGet** (`forward(inverse(NEW)) ≡ NEW.col`) — checked by composition:

- When the logical column carries an enumerable domain (the existing
  `domainConstraints` enum bounds from a CHECK `in (...)` — cap the
  enumeration at a small bound, e.g. 64 values), evaluate the composition per
  domain value via the const evaluator:
  - all values reproduce → PutGet **proved**; additionally, if the forward is
    thereby proved **injective** over the domain, suppress the lossy advisory
    (see below);
  - any value fails to reproduce → **deploy error**, sited, naming the column
    and the offending value (a put that loses the written value is never
    acceptable — this is the one hard error this ticket adds; give it a
    stable code, e.g. `lens.putget-violation`).
- No enumerable domain → **degrade to safe** (admit; mutation-time behavior
  governs, consistent with the prover's existing posture). No new advisory
  for the unverified case.

**GetPut** — surrendered by design for a non-injective forward (write-through
normalizes the base value). Emit the **`lens.getput-lossy`** advisory
(warning severity, acknowledgeable, fingerprinted like every other advisory)
for every authored-inverse column **except** one whose forward was proved
bijective by the enumeration above. Wire the code into the governed
vocabulary (`lens-ack.ts` recognized-targets list) so
`quereus.lens.ack.getput-lossy[:<column>]` and the
`error-on` / `require-ack` escalation policies work uniformly.

## Introspection

`quereus_effective_lens(schema, table)` gains an `inverse` column per the
table already documented in `docs/lens.md`:
`'authored'` (a `with inverse` clause supplies the put) · `'inferred'`
(registry invertibility / identity / passthrough) · `'none'` (computed,
read-only). Update any test pinned to the TVF's arity/columns.

## Edge cases & interactions

- **Override merger provenance** — an authored inverse on a *covered* column
  survives baseline regeneration (the override AST is re-read from source per
  deploy); a gap-filled column always reports `inferred` (identity).
- **Ack round-trip** — `quereus.lens.ack.getput-lossy:<col>` with rationale +
  `#fp=` fingerprint suppresses; a domain change (the CHECK `in` list gains a
  value) changes the fingerprint facts → re-surfaces. Reuse the existing
  fingerprint inputs discipline (constraint columns / domain band).
- **Escalation** — `quereus.lens.policy.require-ack = 'lens.getput-lossy'`
  errors on an unacknowledged instance; `error-on` makes it hard. Unknown-code
  fail-loud already covers typos once the code is registered.
- **`quereus.lens.writable = true` + authored inverse** on an out-of-fragment
  body — the existing degrade-to-safe rule holds (neither branch fires);
  don't regress the documented completeness gap.
- **Enumeration determinism** — the composition must be evaluated with the
  const evaluator only (no vtab reads); a non-constant-foldable inverse
  expression (subquery, volatile fn) falls to degrade-to-safe, never a crash.
- **PutGet error is atomic** — a `lens.putget-violation` aborts the whole
  deploy before catalog mutation, like every prover error.

## Tests

Lens logic tests: the code-collapse lens (3-code logical over 20-code basis)
deploys with a `lens.getput-lossy` advisory; ack suppresses; escalation
errors; a deliberately wrong inverse (`'A' → 'B1'` where forward('B1') ≠ 'A')
reds `lens.putget-violation` at deploy with the column + value named; a
bijective enumerable mapping emits no advisory; effective-lens reports
`authored` / `inferred` / `none` correctly across a mixed table; writable
intent satisfied by an authored inverse (no `lens.non-invertible`).

## TODO

- proveRoundTrip authored branch (writable; intent satisfaction)
- PutGet enumeration + `lens.putget-violation` hard error
- `lens.getput-lossy` advisory + governance vocabulary registration + fingerprint
- effective-lens `inverse` column + test updates
- Logic tests above
- Reconcile docs/lens.md + docs/view-updateability.md with what landed
- `yarn build`, `yarn lint`, `yarn test`
