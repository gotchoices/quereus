description: The lens escalation policy (`quereus.lens.policy.error-on` / `quereus.lens.policy.require-ack`) accepts an arbitrary CSV of advisory codes and silently no-ops any entry it does not recognize. A typo'd or stale code (e.g. `lens.no-backing-indx`, or a code that no longer exists) therefore fails *open*: the developer believes they have escalated `no-backing-index` to a hard error, but the deploy stays advisory and nothing blocks. A fail-safe governance control that silently fails open is the worst failure mode. Validate policy codes against the known advisory code set and surface unrecognized entries instead of ignoring them.
files: packages/quereus/src/schema/lens-ack.ts, packages/quereus/src/schema/lens-prover.ts, packages/quereus/test/lens-ack.spec.ts, docs/lens.md
----

## Problem

`resolveEscalationPolicy` (`src/schema/lens-ack.ts`) parses the two
`quereus.lens.policy.*` reserved tags into `EscalationPolicy.{errorOn,requireAck}`
as free CSV (`parseCodeCsv`). The governance later asks `policy.errorOn.has(codeBase)`
/ `policy.requireAck.has(codeBase)` for each advisory the prover actually emitted.
Any policy entry that does not correspond to a real advisory code is never
consulted and never reported — it is silently dropped.

Consequences:
- A typo (`no-backing-indx`) silently disables the escalation the author intended.
- A code that was renamed/removed leaves a dead policy entry that looks active in
  source but does nothing.
- Because the escalation is the *fail-safe* (it promotes an advisory to a blocking
  error), the silent drop fails **open** — the opposite of what a governance
  control should do on misconfiguration.

The reserved-tag layer (`reserved-tags.ts`) cannot catch this: it validates the
value is a non-empty string, but it has no knowledge of the advisory code
vocabulary (which lives in `lens-prover.ts` as the warning-severity
`LensCheckCode` members: `lens.no-backing-index`, `lens.no-answering-structure`,
`lens.partial-override`). Validation must happen where that vocabulary is known.

Note the prefix forms are already normalized (a policy may name a code bare
`no-backing-index` or fully `lens.no-backing-index`; both resolve to the same base
— landed in the `lens-advisory-acknowledgment` review). This ticket is only about
*unrecognized* codes, not the prefix spelling.

## Expected behavior

- A `quereus.lens.policy.{error-on,require-ack}` entry that is not a recognized
  acknowledgeable advisory code is **surfaced**, not silently ignored. Candidate
  surfaces (pick during implement):
  - a deploy-report **warning** ("policy references unknown advisory code
    'lens.no-backing-indx' — it will never match; recognized codes: …"), keeping
    the deploy non-blocking but visible; or
  - a hard **error** at deploy (consistent with "an unknown reserved *key* is a
    hard error" — an unknown policy *value* is arguably the same class of typo).
    Leaning warning, since the policy tag itself is validly-keyed and the engine
    elsewhere treats advisory misconfig as advisory; confirm during implement.
- The recognized-code vocabulary should be derived from a single exported source
  (e.g. an exported `ACKNOWLEDGEABLE_ADVISORY_CODES` set in `lens-prover.ts`) so it
  cannot drift from the codes the prover actually emits.
- A recognized code continues to escalate exactly as today (no behavior change for
  correct policies).

## Out of scope

- The prefix-spelling normalization (already landed).
- A global/schema-wide policy source (separate future ergonomics, noted in
  `docs/lens.md`).

## Test

- A policy naming a non-existent code surfaces the chosen diagnostic (warning row
  on the report, or a throw) rather than deploying silently advisory.
- A policy naming a real code is unaffected (regression guard).
