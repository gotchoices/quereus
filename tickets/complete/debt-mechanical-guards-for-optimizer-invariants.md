---
description: Three optimizer coding rules that only reviewers used to catch are now checked automatically by tests that read the source files as text.
files:
  - packages/quereus/test/util/source-scan.ts (new — shared helpers for source-scanning tests)
  - packages/quereus/test/optimizer/side-effect-audit.spec.ts (OPT-002 guard)
  - packages/quereus/test/optimizer/fd-propagation.spec.ts (OPT-046 guard)
  - packages/quereus/test/optimizer/assertion-as-premise.spec.ts (OPT-052 guard)
  - packages/quereus/test/planner/cost-additivity.spec.ts (de-duplicated onto the shared helper)
  - docs/invariants.md (three `guard:` lines updated)
---

## What landed

Three *static convention guards* — tests that read engine source files as plain text and assert
a coding pattern holds. Same shape as the pre-existing guard in `cost-additivity.spec.ts`. No
runtime cost, no new assertions in the optimizer's hot path. A new shared module,
`test/util/source-scan.ts`, holds the helpers all four guards use (`stripComments`,
`tsFilesUnder`, `readCode`, `relPosix`, `lineAt`); `cost-additivity.spec.ts` dropped its private
copy of `stripComments` in favour of the shared one.

**OPT-002 — an `'aware'` rule consults the side-effect signal.** Parses every `addRuleToPass(...)`
registration in `src/planner/optimizer.ts`, resolves each `'aware'` rule's `fn:` identifier through
the file's own import map to the rule's source file, and requires that file to name one of
`hasSideEffects`, `subtreeHasSideEffects`, `isConcurrencySafe`, `isFunctional`, `physical.readonly`.
27 rules are `'aware'`; 26 name a signal. `cte-optimization` is the sole allowlist entry — it wraps
the CTE body in a run-once `CacheNode` rather than refusing, so there is nothing to consult.

**OPT-046 — `addFd` is the only FD accumulation path.** Scans the planner for `<receiver>.push(`
where the receiver name ends in `fd`/`fds`. Four allowlist entries, each a local candidate list
consumed by `addFd` or by an FD reasoning helper.

**OPT-052 — provenance is informational.** Scans `src/planner/rules/**` for the identifier
`ConstraintProvenance`; currently zero hits. Keyed on the type name rather than on `.source`
property reads, because `node.source` (a plan node's child pointer) is read constantly by rules.

Each guard carries anti-vacuity self-checks (the scanner must still find the known matches, the
optimizer parser must account for every `sideEffectMode:` in the file), a stale-allowlist test, and
an in-spec negative test that feeds a hand-written violating snippet to the pure scanning function.

OPT-004 (a custom-`execute` pass argues its own soundness) and OPT-008 (plan-node immutability) keep
their `guard: none` lines — the ticket excluded both. Neither has a cheap mechanical check, and
freezing plan nodes in a debug build is a design question deserving its own plan ticket.

## Validation

`yarn workspace @quereus/quereus run test` — 6708 passing, 9 pending, 0 failing.
`yarn workspace @quereus/quereus run lint` (eslint + `tsc -p tsconfig.test.json --noEmit`) — exit 0.
No `src/` files changed, so the build is untouched.

## Review findings

### Checked

Read the implement diff before the handoff summary. Verified each guard against a **real injected
violation** in engine source (not only its synthetic unit test), restoring the file afterwards and
confirming a clean working tree each time. Audited the guards for the failure mode that matters most
for a source-scanning test — passing *vacuously* — and for scope holes where a violation could exist
today and go unseen. Cross-checked every claim in the handoff's "known gaps" list against the actual
source rather than taking it on trust. Re-read `docs/invariants.md` against the code as it now
stands. Ran the full engine suite and lint.

### Fixed in this pass (minor)

- **OPT-046 scanned only `planner/nodes/**` and `planner/analysis/**`, and a matching push already
  existed outside that scope.** `rules/aggregate/rule-groupby-fd-simplification.ts:97` does
  `keyFds.push(keyFd)`. It is benign — a candidate list handed to `expandEcsToFds`/`minimalCover` as
  reasoning input, never reaching a node's FD set — but the handoff filed the unscanned-directory gap
  as hypothetical when an instance was already sitting in it. The guard now scans all of
  `src/planner/**` except `util/fd-utils.ts` (which *is* the sanctioned accumulation path), with that
  push allowlisted and its consumer named. Verified by appending an `fds.push(1)` to
  `rules/join/rule-join-elimination.ts`: the widened guard reports
  `rules/join/rule-join-elimination.ts:427 — fds.push(`; the old scan roots would have missed it.
  Docs updated to match. Allowlist is now four entries — still inside the "handful" the ticket set as
  the guard's exit condition.

- **OPT-002's allowlist excused a rule whose source the audit could not even read.** `auditAwareRules`
  reports two distinct problems — "consults no signal" and "cannot resolve `fn:` to a source file" —
  but the offender filter dropped anything whose rule id was allowlisted, regardless of which. So if
  `cte-optimization`'s import were renamed or moved, the guard would stop auditing it and still pass
  green. Now `Unguarded` carries a `kind` (`'no-signal' | 'unresolved'`) and only `'no-signal'` is
  excusable; the stale-allowlist test likewise requires the `'no-signal'` reason. Added a regression
  test (`does not let the allowlist excuse a rule the audit could not read`). Re-verified the real
  path afterwards by flipping `join-key-inference` to `'aware'` — the guard still fails correctly.

### Checked, no change needed

- **Registration coverage.** `optimizer.ts` is the only `addRuleToPass` call site (52 calls, 52
  `sideEffectMode:` occurrences — the anti-vacuity check is exact, not approximate). The three other
  files containing the string `sideEffectMode:` mention it in prose comments only, which
  `stripComments` removes. The one bypass — `registerPass` takes `pass.rules` as-is without validating
  — already carries an explanatory `NOTE:` in `framework/pass.ts` and no pass ships pre-populated.
- **OPT-052's rules-only scope is correct, not an oversight.** `ConstraintProvenance` is *defined* in
  `nodes/plan-node.ts` and *produced* in `analysis/assertion-hoist-cache.ts`; scanning those would be
  a guaranteed false positive. Zero references in `rules/`. Confirmed the type-name keying is
  necessary: `rules/access/rule-lens-auxiliary-access.ts` and `rules/access/rule-monotonic-*.ts` read
  `node.source` (the child pointer) many times over.
- **`test/util/source-scan.ts` is not collected as a spec.** `test-runner.mjs` globs
  `test/**/*.spec.ts`; the helper sits alongside other non-spec helpers already in `test/util/`.
- **The `cost-additivity` de-duplication is behaviour-preserving.** `stripComments` now keeps the
  newlines inside block comments (so the two new guards can report `file:line`), but that spec only
  runs `includes()` and `\b`-anchored regexes, neither of which is line-sensitive.

### Tripwires (recorded, not ticketed)

- `stripComments` treats a `//` inside a string literal as a comment start, and fails *open* (stops
  seeing code after that line) rather than closed. Confirmed dormant: no code line under
  `src/planner/` contains `//` inside a string literal. Parked as a `NOTE:` at the helper in
  `test/util/source-scan.ts`.
- OPT-002 reads only the rule's own file, so a rule that delegates its refusal to a helper module
  would be flagged as a false positive. No rule does today. Parked as a `NOTE:` on the guard, naming
  the right fix (follow the rule file's imports) rather than the wrong one (allowlist the rule).
- OPT-046's receiver-name heuristic stops discriminating once the allowlist grows large; the exit
  condition is to delete the guard rather than keep feeding it. Already a `NOTE:` above the allowlist
  and a sentence in `docs/invariants.md`. Deliberately not an assertion — that would force the
  decision at an arbitrary moment.

### Majors / new tickets

None. Every gap in the handoff's "known gaps" list is either a documented tripwire above, or the
explicit price the ticket agreed to pay for textual matchers over dataflow analysis. Nothing found
was reachable-but-broken, so nothing warranted a `fix/` or `backlog/` ticket.
