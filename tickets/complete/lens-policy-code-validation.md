description: Make an unrecognized lens escalation-policy code (`quereus.lens.policy.error-on` / `require-ack`) a hard deploy error instead of a silent no-op. A typo'd/stale policy code previously failed *open* — the author believed they escalated to a hard error, but the deploy stayed advisory. The fix validates policy codes against the prover's single exported advisory vocabulary and throws atomically on an unknown code.
files: packages/quereus/src/schema/lens-prover.ts, packages/quereus/src/schema/lens-ack.ts, packages/quereus/src/schema/lens-compiler.ts, packages/quereus/test/lens-ack.spec.ts, docs/lens.md
----

## What shipped

The fix splits the prover's diagnostic vocabulary so the *governable* advisory codes are a single exported source of truth, then validates every escalation-policy entry against it up front in `applyAckGovernance` — an unrecognized code raises a deploy-blocking `lens.unknown-policy-code` error that rides the existing atomic `errors` channel.

### `lens-prover.ts`
- `LensCheckCode` split into `LensErrorCode | LensAdvisoryCode`.
- `LensErrorCode`: the five coverage error codes + the new `lens.unknown-policy-code` (the structural code the governance diagnostic carries).
- `LensAdvisoryCode` derived from `ADVISORY_CODE_LIST` (the four governable warning codes).
- `ACKNOWLEDGEABLE_ADVISORY_CODES: ReadonlySet<LensAdvisoryCode>` exported as the authoritative governable vocabulary.

### `lens-ack.ts`
- Module-level `RECOGNIZED_ADVISORY_BASES` (vocabulary mapped through `advisoryCodeBase`, so bare and `lens.`-prefixed policy forms both compare).
- `validatePolicyCodes(slot, policy)` runs once, up front in `applyAckGovernance`, pushing one error per unrecognized `errorOn`/`requireAck` base. Validated against the *vocabulary*, independent of whether any advisory fires.
- No signature changes — errors ride the existing `errors: LensDiagnostic[]` channel that `lens-compiler.ts:225` throws atomically before any catalog mutation.

### `docs/lens.md` § Escalation policy
- Added the "Unknown codes fail loud, never open" bullet listing the four recognized codes and the `ACKNOWLEDGEABLE_ADVISORY_CODES` drift anchor.

## Review findings

**Reviewed:** the full implement diff (`a935e651`) read first with fresh eyes, then the prover/ack/compiler sources end-to-end, the docs the change touches, and all call sites of the affected symbols.

### Correctness / fail-open closure — PASS
- **Single funnel confirmed.** `applyAckGovernance` is the only consumer of `resolveEscalationPolicy`, called once per logical-table slot in the compile loop (`lens-compiler.ts:198`). Every table carrying a policy tag is validated; there is no second path that reads a policy code and could still fail open.
- **Comparison is sound.** Both the policy sets (via `parseCodeCsv`) and `RECOGNIZED_ADVISORY_BASES` are normalized through `advisoryCodeBase` and lowercased, so bare/prefixed/upper-case forms all compare correctly. Verified `pk-not-reconstructible` is genuinely `severity: 'warning'` routed through governance (`lens-prover.ts:416`), so its inclusion in the recognized set is correct — the one judgment call the ticket flagged holds up.
- **No accidental re-governance.** `lens.unknown-policy-code` is a `LensErrorCode`, absent from `ACKNOWLEDGEABLE_ADVISORY_CODES`, so it can never itself be acknowledged or named as a policy target (naming it would be rejected as unknown — self-consistent).
- **Empty/whitespace CSV** (`error-on=''`) produces no false-positive error (`parseCodeCsv` skips empty parts).

### Type safety / exhaustiveness — PASS
- Audited every `LensCheckCode` / `LensErrorCode` / `LensAdvisoryCode` reference project-wide: the union is used *only* as the type of `LensDiagnostic.code` (`lens-prover.ts:112`). No `switch`/exhaustive check relies on the old flat shape, so the split is non-breaking. `tsc --noEmit` clean.

### Docs — PASS
- The new error-code is documented under § Escalation policy (the governance section), not the prover § Coverage checklist errors table — correct placement, since it is a governance error, not a coverage check. The four recognized codes in the doc match `ADVISORY_CODE_LIST` exactly (locked by the drift-guard test).

### Tests — minor gap fixed inline
- **Fixed (minor):** added `validates per-code: a valid sibling in the CSV cannot mask a typo` to `lens-ack.spec.ts`. The implementer's suite covered single unknown codes but not a CSV mixing a recognized code with a typo. The new test locks per-entry granularity — a valid sibling must not short-circuit validation of the typo. Passes; the deploy is blocked and records no report.
- Existing coverage (repro typo, require-ack typo, bare/prefixed recognized, pk-not-reconstructible recognized-but-unemitted, drift guard) is sound and the repro from the ticket is faithfully reproduced.

### Observations — noted, not defects (no fix)
- **Error-severity code as a policy target.** `error-on='lens.type-mismatch'` (an already-hard coverage error) is rejected with "unknown advisory code 'lens.type-mismatch'". The *behavior* is correct and anti-fail-open (the doc states the five error codes are not governable), but the *wording* calls a real code "unknown". Improving it would require exporting the error-code vocabulary and branching the message for a marginal UX gain on a misconfiguration the doc already forbids — disproportionate, left as-is.
- **Bare-form message reconstruction.** A typo'd bare code (`error-on='foo'`) is reported as `'lens.foo'` — the canonical form, with the prefix the user omitted. Cosmetic; the canonicalization is intentional.
- **De-dup not done** (a code in both `error-on` and `require-ack` yields two diagnostics) — the ticket explicitly accepts this as two distinct misconfigs.

### Validation run
- `lens-ack.spec.ts`: **17 passing** (was 16 + 1 added).
- All lens specs (`test/**/lens*.spec.ts`): **119 passing** pre-change, green after.
- `yarn typecheck`: exit 0. `yarn lint`: exit 0.

No major findings; no new fix/plan/backlog tickets warranted.
