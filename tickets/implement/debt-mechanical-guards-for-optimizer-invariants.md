description: Three rules the optimizer's code is supposed to follow are currently enforced only by reviewers noticing. Each could be checked automatically by a small test that scans the source, the way an existing test already scans for a different mistake.
files:
  - docs/invariants.md (the invariants — OPT-002, OPT-046, OPT-052)
  - packages/quereus/test/planner/cost-additivity.spec.ts (the existing source-scanning test to copy)
  - packages/quereus/test/optimizer/side-effect-audit.spec.ts (where an OPT-002 scan would live)
  - packages/quereus/src/planner/optimizer.ts (where rules declare `sideEffectMode`)
  - packages/quereus/src/planner/util/fd-utils.ts (`addFd`, the sanctioned accumulation path)
----

## Background

`docs/invariants.md` records, for every optimizer invariant, a `guard:` line naming the test
or runtime assertion that would catch a regression. Five entries say `guard: none`. This
ticket collects the three where a **cheap mechanical check** looks worthwhile — a test that
reads the source files as text and asserts a pattern, not a new runtime assertion in the
optimizer's hot path.

The precedent already exists: `test/planner/cost-additivity.spec.ts` § *Cost model: static
convention guard* reads every plan-node source file and fails if a constructor folds a child's
cost into its own. It is fast, has no runtime cost, and catches the exact mistake it was
written for. Each item below is the same shape.

The other two unguarded invariants (OPT-004, plan-node immutability at OPT-008) are
deliberately excluded: neither has a cheap check. Freezing plan nodes in a debug build is a
real design question and should get its own plan ticket if anyone wants it.

## The three checks

**OPT-002 — an `'aware'` rule consults the side-effect signal.** A rule that moves, drops,
duplicates, or merges a subtree declares `sideEffectMode: 'aware'` and is supposed to ask
whether that subtree carries a write before touching it. Today 25 of the 27 `'aware'` rules do.
A test could read `src/planner/optimizer.ts`, collect every rule id declared `'aware'`, resolve
each to its rule file, and assert the file mentions `hasSideEffects`, `subtreeHasSideEffects`,
`isConcurrencySafe`, or `physical.readonly`. The two rules that legitimately consult none —
`cte-optimization` and `in-subquery-cache`, which wrap the subtree in a run-once cache instead
of refusing — go in an allowlist with the reason written next to them. This is the most
valuable of the three: it is the check that would notice a new subtree-moving rule shipped
without a side-effect guard, which is a wrong-answer bug, not a missed optimization.

**OPT-046 — `addFd` is the only FD accumulation path.** Functional dependencies must be
accumulated through `addFd` / `mergeFds`, which apply subsumption and enforce the per-node
cap. Pushing straight onto the array skips both. A source scan over
`src/planner/nodes/**` and `src/planner/analysis/**` could flag a `.push(` whose receiver is
named like an FD list. Expect false positives on local array builds that are later handed to
`addFd`; the test needs a small allowlist, and if the allowlist grows past a handful the check
is not paying for itself and should be dropped rather than maintained.

**OPT-052 — provenance is informational.** An FD or constant binding may carry a `source` tag
saying it came from a declared CHECK or from a hoisted assertion. No optimizer rule may branch
on it — the tag is for diagnostics. A scan over `src/planner/rules/**` asserting no file reads
`.source` on a dependency fact, or imports `ConstraintProvenance`, would catch the first rule
that starts making a fact's meaning depend on where it came from. The `.source` field name
collides with `node.source` (a child pointer), so the check has to be written against the
import rather than the property access.

## What "done" looks like

Each check lives with the tests that already cover its area, fails on a hand-written
violation, and passes on `main`. When one lands, replace that invariant's `guard: none — …`
line in `docs/invariants.md` with a pointer at the new test. Landing one of the three is a
complete outcome; they are independent.
