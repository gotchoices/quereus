---
description: Predicate-gated functional dependencies — CHECK implication-form extraction, Filter-time activation, guard-aware FD propagation through projection / shift / closure / join.
files:
  - packages/quereus/src/planner/nodes/plan-node.ts
  - packages/quereus/src/planner/util/fd-utils.ts
  - packages/quereus/src/planner/analysis/check-extraction.ts
  - packages/quereus/src/planner/nodes/filter.ts
  - packages/quereus/test/optimizer/conditional-fds.spec.ts
  - docs/optimizer.md
---

## What landed

Conditional / guarded FDs flow through the optimizer:

- `FunctionalDependency` gains an optional `guard: GuardPredicate` of
  conjunctive `GuardClause`s (`eq-literal`, `eq-column`, `is-null`).
- CHECK extraction recognizes implication-form `OR` chains
  (`¬g₁ OR ¬g₂ OR ... OR body`) by negating the leading disjuncts into
  guard clauses and emitting guarded equality FDs (no equiv pairs,
  bindings, or domain constraints from guarded bodies).
- `FilterNode.computePhysical` merges ECs/bindings up front, then walks
  inherited FDs and activates (strips the guard from) any whose guard
  is entailed by the predicate via `predicateImpliesGuard`.
- FD/EC helpers — `computeClosure`, `addFd`, `mergeFds`, `projectFds`,
  `shiftFds`, `hasAnyKey`, `hasSingletonFd`, `isAssertedKey`,
  `deriveKeysFromFds` — all skip / preserve / project / shift guards
  correctly.

See the implementation commit (`ticket(implement): optimizer-conditional-fds`)
for the file-by-file diff.

## Review findings

### Validation status

- `yarn workspace @quereus/quereus run build` — clean.
- `yarn workspace @quereus/quereus run test` — **3000 passing, 2 pending**
  (matches handoff; no regressions introduced).
- `yarn workspace @quereus/quereus run lint` — exit 0.
- `yarn test:store` was not run; per the prereq's review, that suite has
  pre-existing failures unrelated to this work.

### Implementation correctness

**Type extension** — `FunctionalDependency` and `GuardPredicate` /
`GuardClause` shapes are minimal and aligned with what
`predicateImpliesGuard` can discharge. No mismatch between the vocabulary
the CHECK extractor emits and the vocabulary the activation check
recognizes.

**CHECK implication recognition (`handleImplication` →
`recognizeNegatedGuard` → `recognizeGuardedBody`)** — verified the
sense-of-negation mapping by hand for all four shapes:

| Disjunct        | Negation (guard)                          |
| --------------- | ----------------------------------------- |
| `c <> v`        | `eq-literal {c, v}`                       |
| `c1 <> c2`      | `eq-column {c1, c2}`                      |
| `c IS NULL`     | `is-null {c, negated: true}` ⇒ "IS NOT NULL" |
| `c IS NOT NULL` | `is-null {c, negated: false}` ⇒ "IS NULL"    |

`clauseEntailed` interprets these symmetrically with the predicate-side
facts (`isNullCols` vs `isNotNullCols`). The eight-case combination
(unit tests at `conditional-fds.spec.ts`) confirms the polarity is right.

The bail-out flow is correct: if any leading disjunct fails to recognize
as a negated guard, `handleImplication` returns without emitting FDs —
no partial state leaks into the FD list.

**Guard propagation through projection / shift / closure** — the helper
behaviors verified by unit tests (`shiftFds`, `projectFds` drop-on-missing,
`projectFds` remap-on-full, `stripGuard`, `addFd` keep-side-by-side and
dedupe). `computeClosure` / `hasAnyKey` / `hasSingletonFd` /
`isAssertedKey` / `deriveKeysFromFds` all skip guarded FDs — confirmed by
read-through. A guarded FD never proves a key claim, which is the right
invariant.

**Filter activation** — `FilterNode.computePhysical` was restructured so
EC merge, binding merge, and binding EC-closure run **before**
`activateGuardedFds`. This gives the activation check the post-predicate
view of the world, which is what `predicateImpliesGuard` consumes. The
ordering is correct.

**Outer join behavior** — `propagateJoinFds`' left-outer / right-outer /
full-outer / semi / anti branches use unchanged `wrap()` over only
the surviving side's FDs (no shift+merge), so guarded FDs on the
NULL-padded side are dropped along with that side's unconditional FDs.
This is the expected behavior — verified by the LEFT OUTER JOIN
end-to-end test (`assert surviving.length === 0`). Inner / cross join
merges via `mergeFds` and `shiftFds`, both guard-aware.

**Consumer scan** — searched `packages/quereus/src/` for direct iteration
over `physical.fds`. Only one site outside the four touched files reads
fds directly (`reference.ts:104` — iterates `checkExt.fds` and calls
`addFd` on each). Since `addFd` is guard-aware, that site is correct.
Every other consumer routes through the helper surface, which is now
guard-aware. **No silently-broken consumers found.**

### Test coverage

The implementer's test file (`test/optimizer/conditional-fds.spec.ts`,
34 specs) covers:

- `predicateImpliesGuard` — direct match, EC match, binding match,
  is-null direct, is-null negated via column nullability, is-null negated
  via predicate conjunct, conservative-false on arithmetic / top-level
  OR, conjunctive-guard requires all clauses.
- `extractCheckConstraints` — eq-literal guard, is-null guard, two-clause
  guard, unguarded equality fall-through, non-equality body rejection.
- `fd-utils` — `shiftFds`, `projectFds` (drop and remap), `stripGuard`,
  `addFd` side-by-side and dedupe.
- End-to-end — guarded FD survives on TableRef, activation at Filter
  produces unguarded FDs in both directions, no activation when the
  predicate doesn't entail the guard, LEFT OUTER JOIN drops right-side
  guarded FDs.

**Gaps I considered and decided not to fill in this pass:**

- *Parameter-binding eq-column activation* — `clauseEntailed` treats two
  bindings sharing the same `ConstantValue` (parameter ref) as
  entailment for an `eq-column` guard. The handoff flagged this as
  light-on-coverage. The semantics are defensible (parameters are fixed
  per execution, so two columns bound to the same parameter ref are
  equal at runtime). Not a correctness gap — a coverage gap. Logged
  here; not worth a follow-up ticket on its own.
- *Inequality / IN-list / arithmetic guard vocabulary* — explicitly out
  of scope per the ticket's "future extensions" list.
- *Guard infeasibility detection* — out of scope per the ticket; a
  contradictory conjunctive guard (e.g. `c='x' AND c='y'`) is retained
  but is harmlessly unmatchable.
- *NOT-wrapped CHECK implication form* — explicitly out of scope. Users
  must write the OR form.

### Pre-existing limitations exposed by this work (not regressions)

- `sqlValueEquals` (in `fd-utils.ts`) is reference-equality + `Uint8Array`
  byte-equality only. Bigint vs number with the same numeric value will
  not match, and SQL `NaN`-like values fall through to `===`. This is a
  pre-existing helper; guard equality reuses it. In practice CHECK
  literals and predicate literals both come from the same parser and
  carry identical runtime types, so this hasn't manifested. Not raised
  as a follow-up ticket — too narrow.
- `extractEqualityFds` recognizes only `=`; `buildPredicateFacts`
  recognizes both `=` and `==`. The difference is strictly additive for
  activation (`==`-only equalities can fire activation even when they
  don't contribute to EC merges). Inconsistency, not a bug.
- `enforceCap`'s `keyHints` filter doesn't distinguish guarded from
  unguarded FDs. A pathological CHECK set could push the FD list over
  `MAX_FDS_PER_NODE` and the cap logic could in principle keep a
  guarded FD whose determinants are a key-subset over an unguarded FD
  whose aren't. Since a guarded FD can't actually prove a key claim,
  this is suboptimal but not unsound. Noted; not actioned in this pass
  given the cap is rarely hit and the fix is mechanical when it bites.

### Code quality

- Documentation comments on `FunctionalDependency`, `GuardPredicate`,
  `predicateImpliesGuard`, `activateGuardedFds`, `handleImplication`,
  and `recognizeGuardedBody` explain the *why* (closure semantics,
  activation flow, no-EC-from-guarded-body rationale) rather than the
  *what*. Reads well.
- Small, single-purpose helpers (`projectGuard`, `shiftGuard`,
  `guardsEqual`, `guardClauseEquals`, `buildPredicateFacts`,
  `clauseEntailed`, `recognizeNegatedGuard`, `recognizeGuardedBody`,
  `flattenDisjunction`) — consistent with project style.
- `docs/optimizer.md` § Functional Dependency Tracking now has a
  "Guarded (conditional) FDs" subsection with the negation mapping
  table, activation rule, and propagation behavior — sufficient for a
  future implementer to understand the surface without diving into
  source.

### What was checked, what was not

- ✓ Read implement diff end-to-end without consulting the handoff first.
- ✓ Verified guard polarity by hand for IS-NULL / IS-NOT-NULL mapping.
- ✓ Verified ordering in `FilterNode.computePhysical` (ECs/bindings
  before activation).
- ✓ Verified `propagateJoinFds` outer-join branches drop right-side
  guarded FDs along with the rest.
- ✓ Scanned every direct `fds` consumer in `packages/quereus/src/` for
  guard-unaware iteration; only one site outside the touched files,
  and it's correct.
- ✓ Ran lint, build, and the full `yarn test` suite — clean.
- ✗ `yarn test:store` not run (pre-existing unrelated failures per the
  prereq ticket's review).
- ✗ No new follow-up tickets filed — every gap identified is either
  explicitly out-of-scope per the original ticket or a pre-existing
  limitation that hasn't manifested.

### Disposition

No minor fixes applied inline — the implementation is sound and the
gaps I identified are either deliberate out-of-scope items or
sub-threshold for action. No major findings warranting new tickets.
