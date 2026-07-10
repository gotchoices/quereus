description: Three optimizer coding rules that only reviewers used to catch are now checked automatically by tests that read the source files as text.
files:
  - packages/quereus/test/util/source-scan.ts (new — shared helpers for source-scanning tests)
  - packages/quereus/test/optimizer/side-effect-audit.spec.ts (OPT-002 guard, appended)
  - packages/quereus/test/optimizer/fd-propagation.spec.ts (OPT-046 guard, appended)
  - packages/quereus/test/optimizer/assertion-as-premise.spec.ts (OPT-052 guard, appended)
  - packages/quereus/test/planner/cost-additivity.spec.ts (de-duplicated onto the shared helper)
  - docs/invariants.md (three `guard:` lines updated)
----

## What landed

Three "static convention guards" — tests that read engine source files as plain text and
assert a pattern. Same shape as the pre-existing guard in `cost-additivity.spec.ts`. No
runtime cost, no new assertions in the optimizer's hot path. All three were implemented; the
ticket said landing one was a complete outcome.

A new shared module, `test/util/source-scan.ts`, holds the helpers all four guards now use:
`stripComments`, `tsFilesUnder`, `readCode`, `relPosix`, `lineAt`. `cost-additivity.spec.ts`
had its own private copy of `stripComments`; it now imports the shared one. One behaviour
change there: `stripComments` now preserves the newlines inside block comments, so line
numbers in the stripped text still line up with the original file (the two new guards report
`file:line`). That does not affect what `cost-additivity` matches — it only does substring
and `\b`-anchored tests.

### OPT-002 — an `'aware'` rule consults the side-effect signal

`side-effect-audit.spec.ts`, describe block `OPT-002 static guard: every 'aware' rule consults
a side-effect signal`.

Reads `src/planner/optimizer.ts`, parses every `addRuleToPass(...)` registration by paren
balance, and for each rule declared `sideEffectMode: 'aware'` resolves its `fn:` identifier
through the file's own import map to the rule's source file. That file must name one of
`hasSideEffects`, `subtreeHasSideEffects`, `isConcurrencySafe`, `isFunctional`, or
`physical.readonly`.

27 rules are `'aware'`. 26 name a signal. `cte-optimization` is the single allowlist entry —
it wraps the CTE body in a run-once `CacheNode` rather than refusing, so there is nothing to
consult. The ticket predicted a second allowlist entry (`in-subquery-cache`); that turned out
to be unnecessary once `isFunctional` was accepted as a signal, which is what that rule
actually calls (`isFunctional` = `physical.readonly` AND deterministic, strictly stronger than
`hasSideEffects`). `docs/invariants.md` already described it that way.

Two anti-vacuity checks are built in: the parser must find as many registrations as there are
`sideEffectMode:` occurrences in the file, and it must find more than 20 `'aware'` rules. A
registration missing `id`/`fn`/`sideEffectMode` makes the parser throw rather than skip.
A second `it()` fails if an allowlist entry goes stale (rule no longer registered, or the rule
started consulting a signal).

### OPT-046 — `addFd` is the only FD accumulation path

`fd-propagation.spec.ts`, describe block `OPT-046 static guard: addFd is the only FD
accumulation path`.

Scans `src/planner/nodes/**` and `src/planner/analysis/**` for `<receiver>.push(` where the
receiver name ends in `fd`/`fds` (case-insensitive). `util/fd-utils.ts` is out of scope — it
*is* the sanctioned path. Three allowlist entries, each a local candidate list handed to
`addFd` by its consumer:

- `nodes/project-node.ts::projectedKeyFds` — folded through `addFd` in the loop directly below.
- `analysis/check-extraction.ts::fds` — returned to `nodes/reference.ts`, which folds via `addFd`.
- `analysis/assertion-hoist-cache.ts::fds` — same consumer, same fold.

I traced all three consumers before allowlisting them (`nodes/reference.ts` lines ~140-160);
none is a real violation. A stale-allowlist test fails if any of the three pushes disappears.

### OPT-052 — provenance is informational

`assertion-as-premise.spec.ts` (where the existing provenance tests live), describe block
`OPT-052 static guard: provenance is informational`.

Scans `src/planner/rules/**` for the identifier `ConstraintProvenance`. Currently zero hits.
As the ticket anticipated, the check is written against the type name rather than against
`.source` property reads, because `node.source` (a plan node's child pointer) is read
constantly by rules — `rule-select-access-path.ts` has two such reads.

## How to test / validate

```
# the three guards plus the precedent test they were modelled on
node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js \
  "packages/quereus/test/optimizer/side-effect-audit.spec.ts" \
  "packages/quereus/test/optimizer/fd-propagation.spec.ts" \
  "packages/quereus/test/optimizer/assertion-as-premise.spec.ts" \
  "packages/quereus/test/planner/cost-additivity.spec.ts"
```

Ran and passing: the four specs above (94 passing), the whole `@quereus/quereus` suite
(`yarn workspace @quereus/quereus run test` — 6707 passing, 9 pending, no failures), and
`yarn workspace @quereus/quereus run lint` (eslint + `tsc -p tsconfig.test.json --noEmit`,
exit 0). No `src/` files changed, so the build is untouched and was not re-run.

Each guard was verified against a **real injected violation**, not only its synthetic unit
test — I temporarily edited engine source, watched the guard fail with the right message, and
restored the file (working tree confirmed clean afterwards):

- OPT-002: flipped `join-key-inference` from `'safe'` to `'aware'` → guard reported
  `join-key-inference: \`ruleJoinKeyInference\` consults none of ...`.
- OPT-046: appended `_probeFds.push(x)` to `nodes/window-node.ts` → guard reported
  `nodes/window-node.ts:326 — _probeFds.push(`.
- OPT-052: added `import type { ConstraintProvenance }` to `rules/distinct/rule-distinct-elimination.ts`
  → guard reported both the import line and the type-alias line.

Each guard also carries an in-spec negative test that feeds a hand-written violating snippet
to the pure scanning function, so the failure path stays covered without touching engine
source.

## Known gaps — please poke at these

These are textual matchers. They are smoke alarms, not proofs. Specifically:

- **OPT-002 proves a rule *mentions* a signal, not that it *acts* on it.** A rule that calls
  `subtreeHasSideEffects(node)` and ignores the result passes. Closing that would need real
  dataflow analysis, which is exactly the cost the ticket ruled out. The doc text in
  `invariants.md` now says this out loud.
- **OPT-002 only reads the rule's own file.** A rule that delegates its refusal to a helper
  module would be flagged as unguarded (false positive). None currently do.
- **OPT-002's optimizer parser is a regex/paren-balance parser, not a TS parser.** It relies
  on `id:`/`fn:`/`sideEffectMode:` being literal, on `fn:` naming a directly-imported
  identifier, and on comments being strippable. Today all 52 registrations satisfy that. The
  anti-vacuity count check is what stops a parse regression from silently passing.
- **`stripComments` is naive** about `//` inside string literals (e.g. a URL). No planner
  source has one. It fails *open* (stops seeing code after such a line) rather than closed —
  which is the wrong direction for a guard. Worth a look if you disagree with the tradeoff.
  Noted as a `NOTE:` at the helper.
- **OPT-046 keys on receiver *names*.** Naming an accumulator something not ending in `fd`/
  `fds` evades it, and the allowlist is keyed by `file::receiverName`, so a future variable
  reusing an allowlisted name in an allowlisted file would be silently permitted. The ticket
  called this out and set the exit condition: if the allowlist grows past a handful, delete
  the guard instead of maintaining it. That condition is recorded as a `NOTE:` above the
  allowlist and as a sentence in `invariants.md`, not as an assertion — an assertion would
  force the decision at an arbitrary moment.
- **OPT-046 scans `nodes/**` and `analysis/**` only.** FD lists built elsewhere (e.g. a future
  `rules/` file) are unscanned.
- **OPT-052 would miss a rule that reads `fd.source` without ever naming the type** —
  e.g. `if (fd.source) return null;`. The reasoning (recorded in `invariants.md`) is that this
  cannot do anything *useful* with the tag, but "useful" is doing work in that sentence and a
  reviewer may disagree.

## Not done, deliberately

OPT-004 (a custom-`execute` pass argues its own soundness) and OPT-008 (plan-node immutability)
keep their `guard: none` lines. The ticket excluded both: neither has a cheap mechanical check,
and freezing plan nodes in a debug build is a design question deserving its own plan ticket.
