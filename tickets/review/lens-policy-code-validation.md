description: Review the fix that makes an unrecognized lens escalation-policy code (`quereus.lens.policy.error-on` / `require-ack`) a hard deploy error instead of a silent no-op. Previously a typo'd/stale policy code failed *open* — the author believed they escalated to a hard error, but the deploy stayed advisory. The fix validates policy codes against the prover's single exported advisory vocabulary and throws atomically on an unknown code.
files: packages/quereus/src/schema/lens-prover.ts, packages/quereus/src/schema/lens-ack.ts, packages/quereus/src/schema/lens-compiler.ts, packages/quereus/test/lens-ack.spec.ts, docs/lens.md
----

## What changed

### `lens-prover.ts` — single exported vocabulary (no drift)
- Split `LensCheckCode` into `LensErrorCode | LensAdvisoryCode`.
- `LensErrorCode`: the five already-hard error codes (`uncovered-column`, `type-mismatch`, `nullability-mismatch`, `unrealizable-constraint`, `non-invertible`) **plus a new `lens.unknown-policy-code`** — the structural code carried by the new diagnostic (so `formatProveErrors` prints a meaningful `[lens.unknown-policy-code]` tag rather than a misleading real advisory code).
- `LensAdvisoryCode` is derived from a new `ADVISORY_CODE_LIST` const (the four governable warning codes: `pk-not-reconstructible`, `no-backing-index`, `no-answering-structure`, `partial-override`).
- Exported `ACKNOWLEDGEABLE_ADVISORY_CODES: ReadonlySet<LensAdvisoryCode>` derived from that same array — the authoritative governable vocabulary.

### `lens-ack.ts` — up-front validation
- Imports `ACKNOWLEDGEABLE_ADVISORY_CODES`.
- Module-level `RECOGNIZED_ADVISORY_BASES` = the vocabulary mapped through the existing `advisoryCodeBase` helper, so a policy's bare (`no-backing-index`) and full (`lens.no-backing-index`) forms both compare correctly (mirrors `parseCodeCsv`).
- New `validatePolicyCodes(slot, policy)` runs **once, up front** in `applyAckGovernance` (before the per-advisory loop), pushing one error `LensDiagnostic` per unrecognized `errorOn`/`requireAck` base, attributed to its tag. Validated against the *vocabulary*, independent of whether any advisory actually fires.
- No signature change to `applyAckGovernance` / `resolveEscalationPolicy` / the compiler — errors ride the existing `errors: LensDiagnostic[]` channel that `lens-compiler.ts:230` already throws atomically.

### `docs/lens.md` § Escalation policy
- Added a bullet: an unknown policy code is a hard deploy error (cannot silently fail open), listing the four recognized codes and noting they validate against `ACKNOWLEDGEABLE_ADVISORY_CODES`.

## Design decisions worth a reviewer's eye

- **Chose hard error (the ticket's primary surface), not warning.** Rationale per ticket: symmetry with `reserved-tags.ts` unknown-key handling, and anti-fail-open. The fallback (route into `warnings` with `severity: 'warning'`) is a one-line flip: change `severity: 'error'` in `unknownPolicyCodeError` and push into `outWarnings` instead of `errors`. If the dev prefers non-blocking, that's the lever.
- **Included `pk-not-reconstructible` in the recognized set** even though the ticket prose calls it the "read-only verdict" rather than one of the "three pure advisories." It is a warning-severity code routed through the same governance, so `error-on='lens.pk-not-reconstructible'` is a *valid* policy. Excluding it would false-positive a valid entry as unknown. Locked by a test (recognized even where not currently emitted).
- **New `lens.unknown-policy-code` error code** rather than reusing a real advisory code for the diagnostic's structural `code` field. Reviewer: confirm this code name reads well in the thrown message and isn't expected to be acknowledgeable (it isn't — it's a `LensErrorCode`, never reaches governance).
- **De-dup not done:** a code named in *both* `error-on` and `require-ack` yields two diagnostics. Ticket explicitly says this is accurate (two misconfigs) and de-dup is optional. Left as-is.

## Use cases / validation (tests in `lens-ack.spec.ts`, `escalation policy` describe block + new `advisory vocabulary` block)

All 127 `--grep lens` tests pass; lint clean (exit 0).

- `error-on='lens.no-backing-indx'` (typo) → `apply schema x` throws `/unknown advisory code 'lens\.no-backing-indx'.*never match/`; no deploy report recorded. **This is the exact reproduction from the ticket.**
- `require-ack='lens.bogus-code'` → throws, attributed to the `require-ack` tag; no report.
- Regression guard: recognized code in both bare and `lens.`-prefixed form → throws the *escalation* error (`require-ack`), explicitly asserted NOT to match `/unknown advisory code/`.
- Vocabulary lock: `error-on='lens.pk-not-reconstructible'` on a table where it is not emitted → `apply schema` **succeeds** (recognized, not triggered).
- Drift guard: `ACKNOWLEDGEABLE_ADVISORY_CODES` deep-equals exactly the four warning codes.

## Known gaps / things to probe

- **Coverage of the deferred fallback path is absent** — no test exercises the warning-route variant (intentionally, since the chosen surface is the hard error). If the reviewer wants the fallback validated, it needs its own test.
- **The "recognized but not emitted succeeds" test** asserts the whole `apply schema x` succeeds. It relies on a plain pass-through `table u (id integer primary key, email text null)` (no unique constraint) emitting no blocking diagnostic. If a future prover change makes that table emit an error, this test would break for an unrelated reason — it is a slightly indirect assertion of "no unknown-code error." A more surgical unit test calling `applyAckGovernance` directly with a hand-built slot could isolate it, but that requires constructing a `LensSlot` fixture (none exists in the spec today; all tests go through `apply schema`).
- **Error-code exhaustiveness:** I split `LensCheckCode` but did not audit every `switch`/exhaustive check over it project-wide beyond the prover and ack modules (tests compile + pass, so no type break surfaced). A reviewer grep for `LensCheckCode` switch statements would confirm nothing relies on the old flat union shape.
- `pk-not-reconstructible` membership is the one judgment call that diverges from the ticket's "three advisories" prose — the ticket body itself argues for inclusion, but worth a second opinion.
