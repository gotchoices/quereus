description: The lens escalation policy (`quereus.lens.policy.error-on` / `quereus.lens.policy.require-ack`) silently no-ops any advisory code it does not recognize, so a typo'd or stale code fails *open* — the developer believes they escalated a code to a hard error, but the deploy stays advisory. Validate policy codes against the prover's known advisory-code vocabulary (a single exported source) and surface unrecognized entries as a deploy error instead of ignoring them.
prereq:
files: packages/quereus/src/schema/lens-prover.ts, packages/quereus/src/schema/lens-ack.ts, packages/quereus/src/schema/lens-compiler.ts, packages/quereus/test/lens-ack.spec.ts, docs/lens.md
effort: medium
----

## Summary / reproduction

Confirmed fail-open. A typo'd escalation policy deploys silently — the intended
escalation never happens and nothing flags the typo:

```sql
declare schema y { table u (id integer primary key, email text null) }
apply schema y;
-- author *intends* error-on for no-backing-index, but typos the code:
declare logical schema x {
  table u (id integer primary key, email text null, unique (email))
  with tags ("quereus.lens.policy.error-on" = 'lens.no-backing-indx')
}
apply schema x;        -- BUG: succeeds. lens.no-backing-index stays a mere warning.
```

`apply schema x` succeeds, the deploy report still lists `lens.no-backing-index`
as an ordinary advisory, and `acknowledged` is empty. Compare the correctly-spelled
`error-on` test (`lens-ack.spec.ts:256`) which *throws*. The author thinks they
hardened the deploy; they did not.

### Root cause

`resolveEscalationPolicy` (`lens-ack.ts:79`) parses both `quereus.lens.policy.*`
tags as free CSV via `parseCodeCsv` (`lens-ack.ts:94`), which normalizes each
entry through `advisoryCodeBase` and adds *whatever it finds* to the set — it has
no knowledge of the real advisory vocabulary. `applyAckGovernance` then only ever
asks `policy.errorOn.has(codeBase)` / `policy.requireAck.has(codeBase)` for codes
an advisory **actually emitted** (`lens-ack.ts:332,361`). A policy entry that names
no real advisory code is never consulted and never reported — silently dropped.

The reserved-tag layer (`reserved-tags.ts`) cannot catch this: `error-on` /
`require-ack` are validly-keyed `string` (free-CSV) values (`reserved-tags.ts:184`),
and that layer deliberately reads no reserved tag's *semantics*. The advisory-code
vocabulary lives only in `lens-prover.ts` (the warning-severity `LensCheckCode`
members), so validation must happen where that vocabulary is known.

## The advisory-code vocabulary

The prover emits exactly **four** warning-severity (governable) codes — every one
flows through `applyAckGovernance` and can therefore be legitimately named by a
policy:

- `lens.no-backing-index` (`lens-prover.ts:545`)
- `lens.no-answering-structure` (`lens-prover.ts:652`)
- `lens.partial-override` (`lens-prover.ts:688`)
- `lens.pk-not-reconstructible` (`lens-prover.ts:390`) — the read-only verdict

**Include all four** in the recognized set. The ticket prose names the "three pure
advisories," but `pk-not-reconstructible` is also a warning routed through the same
ack/escalation governance: a project may legitimately write
`error-on = 'lens.pk-not-reconstructible'` (block deploy of a read-only table) or
`require-ack = 'lens.pk-not-reconstructible'`. Excluding it would make a *valid*
policy entry false-positive as "unknown" — re-introducing a fail-the-wrong-way
trap. The recognized set must be every code that can flow through governance, not
just the three documented advisories. (The five error-severity `LensCheckCode`
members — `uncovered-column`, `type-mismatch`, `nullability-mismatch`,
`unrealizable-constraint`, `non-invertible` — are *not* governable: they are
already hard errors and never reach `applyAckGovernance`, so they are not valid
policy targets and are excluded.)

### Single exported source (no drift)

Make the code list authoritative in `lens-prover.ts` so the vocabulary cannot drift
from what the prover emits. Recommended shape (derives both the type and the runtime
set from one `const` array):

```ts
/** The warning-severity advisory codes that flow through ack/escalation governance. */
const ADVISORY_CODE_LIST = [
  'lens.pk-not-reconstructible',
  'lens.no-backing-index',
  'lens.no-answering-structure',
  'lens.partial-override',
] as const;
export type LensAdvisoryCode = typeof ADVISORY_CODE_LIST[number];
export const ACKNOWLEDGEABLE_ADVISORY_CODES: ReadonlySet<LensAdvisoryCode> =
  new Set(ADVISORY_CODE_LIST);
```

Then redefine `LensCheckCode = LensErrorCode | LensAdvisoryCode` (split the five
error codes into a `LensErrorCode` union). The existing warning emit sites keep
their string literals (still type-checked against `LensCheckCode`). A focused unit
test (below) locks the membership so a future warning code added without updating
the list is caught. Don't over-engineer beyond the typed list + guard test.

## Chosen surface: hard error at deploy

**Surface unknown policy codes as a deploy-blocking error** (thrown atomically with
the other prove/escalation errors), *not* a warning. Rationale:

- **Symmetry.** `reserved-tags.ts` already treats an unknown reserved *key* as
  `severity: 'error'` (`unknownReservedTag`, `reserved-tags.ts:509`). An unknown
  policy *value* is the same class of typo and should fail the same way.
- **Anti-fail-open.** This is the bug's whole point: "a fail-safe governance control
  that silently fails open is the worst failure mode." A warning still *deploys*, and
  a warning row is exactly the kind of advisory that gets ignored (the fatigue the
  lens governance exists to fight). The author who wrote `error-on` is opting into
  hardness; a broken hardness config must fail loudly, not soft-warn.
- A correctly-spelled policy is **unaffected** (the four recognized codes pass), so
  this only ever fires on a genuine typo/stale code. No backwards-compat concern
  (per AGENTS.md, not a concern yet).

> Fallback if the dev prefers non-blocking: the only change is to push the
> diagnostic into `warnings` with `severity: 'warning'` instead of `errors`. Keep
> the implementation structured so this is a one-line routing flip. Note the
> tradeoff in the test/docs if chosen.

## Integration point

Do the validation inside `applyAckGovernance` (`lens-ack.ts:320`), which already
returns an `errors: LensDiagnostic[]` channel that `lens-compiler.ts:230` throws
atomically — **no compiler or `resolveEscalationPolicy` signature change needed.**
`applyAckGovernance` already receives the resolved `policy` and the `slot` (for the
diagnostic site = `slot.logicalTable.name`).

Validate **once, up front** (before the per-advisory loop), against the *vocabulary*
— independent of whether any advisory fired (a policy may pre-empt a code that is
not currently triggered; that is valid and must NOT error). For each base in
`policy.errorOn` and each base in `policy.requireAck` that is not a recognized base,
emit one error `LensDiagnostic`:

- Recognized bases: `new Set([...ACKNOWLEDGEABLE_ADVISORY_CODES].map(advisoryCodeBase))`
  — reuse the existing `advisoryCodeBase` helper so the policy's bare/`lens.`-prefixed
  forms both compare correctly (mirrors `parseCodeCsv`).
- Attribute the offending tag (`error-on` vs `require-ack`) by which set it came
  from. The resolved set holds the normalized base (e.g. `no-backing-indx`);
  reconstruct the full form `lens.<base>` for the message.
- Message names the tag, the unknown code, that it "will never match," and lists the
  recognized codes — e.g.: `lens: escalation policy tag 'quereus.lens.policy.error-on'
  on 'u' references unknown advisory code 'lens.no-backing-indx' — it will never
  match and the escalation silently does nothing; recognized codes: lens.no-backing-index,
  lens.no-answering-structure, lens.partial-override, lens.pk-not-reconstructible`.
  Site: `{ table: slot.logicalTable.name }`, severity `error`.

A code named in *both* tags yields two diagnostics (accurate — two misconfigs);
de-duping by base is optional and not required.

## Out of scope

- Prefix-spelling normalization (already landed — `parseCodeCsv` / `advisoryCodeBase`).
- A global/schema-wide policy source (separate future ergonomics).
- Validating that an escalated advisory actually *fires* for the table — pre-empting
  a not-currently-triggered but recognized code is intended and must stay allowed.

## TODO

- In `lens-prover.ts`: introduce `ADVISORY_CODE_LIST` (the four warning codes),
  derive `LensAdvisoryCode` + exported `ACKNOWLEDGEABLE_ADVISORY_CODES` from it, and
  split `LensCheckCode` into `LensErrorCode | LensAdvisoryCode`. Confirm the warning
  emit sites still type-check.
- In `lens-ack.ts`: import `ACKNOWLEDGEABLE_ADVISORY_CODES`, build the recognized
  base-set once (module-level const via `advisoryCodeBase`), and add an up-front
  unknown-code pass in `applyAckGovernance` that pushes an error `LensDiagnostic`
  per unrecognized `errorOn` / `requireAck` base (attributed to its tag).
- Verify `lens-compiler.ts` throws these atomically with no change (governance.errors
  already routes through `formatProveErrors`). Add nothing there unless a gap surfaces.
- `docs/lens.md` § Escalation policy (~line 217): add a sentence that an unrecognized
  policy code is a hard deploy error (it cannot silently fail open), listing the four
  recognized codes.
- Tests in `lens-ack.spec.ts` (escalation-policy describe block):
  - `error-on` naming an unknown code → `apply schema` throws, message matches the
    unknown-code diagnostic; no deploy report is recorded (mirror the existing
    `expectThrows` + `getDeployedLensReport(...).to.be.undefined` pattern).
  - `require-ack` naming an unknown code → same.
  - Regression guard: a recognized code (both bare `no-backing-index` and full
    `lens.no-backing-index`) does NOT trigger the unknown-code error (the existing
    `error-on`/`require-ack` tests largely cover this; add an explicit assertion that
    the throw is the escalation error, not an unknown-code error, if disambiguation
    is cheap).
  - Lock the vocabulary decision: `error-on = 'lens.pk-not-reconstructible'` is
    treated as recognized (does not raise unknown-code), even on a table where it is
    not currently emitted.
  - A small unit guard that `ACKNOWLEDGEABLE_ADVISORY_CODES` contains exactly the
    four warning codes (drift catch).
- Run `yarn workspace @quereus/quereus test` (at least the lens specs) and
  `yarn workspace @quereus/quereus lint` before handing off.
