---
description: Suppress directHit column rewrite when the qualifier resolves to a non-exposing shadowing CTE
files:
  - packages/quereus/src/schema/rename-rewriter.ts
  - packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic
---

## What landed

Two changes in `packages/quereus/src/schema/rename-rewriter.ts`:

1. **Implement-stage fix** (commit `541bd7e3`): `ScopeFrame` now
   carries `ctesShadowingSource: Set<string>`. In
   `collectFromBindings`, the shadowing-non-exposing branch records
   the unaliased source name into that set. A new
   `isQualifierShadowedInScope(state, qualifier)` walks the stack
   innermost-first — returning `true` on a shadowing entry, `false`
   on a closer rebind to the renamed real table. The `column` case
   in `visitColumnRename` gates `directHit` on
   `!isQualifierShadowedInScope(...)`.

2. **Review-stage extension**: extended the shadowing branch to also
   record the *alias* when one is present, so `from t as t` (alias
   text equal to the renamed table name) with a non-exposing
   shadowing CTE no longer falls through to `directHit`. The branch
   is now an unconditional `else` rather than `else if (!ts.alias)`.

Tests landed in `41.3-alter-rename-propagation.sqllogic`:

- **6m** Unaliased qualified ref against a non-exposing shadowing CTE.
- **6n** Sibling shadowing CTE in a multi-WITH; qualified ref.
- **6o** Recursive shadowing CTE; qualified self-ref in recursive step.
- **6p** (added during review) Non-exposing shadowing CTE with an
  alias whose text equals the renamed table name (`from t as t`).

## Review findings

### Methodology

Read the implement-stage diff (commit `541bd7e3`) cold, traced every
test scenario through `visitColumnRename` by hand, then audited
every other walk of `state.scopeStack` in `rename-rewriter.ts` for
consistency with the new shadowing semantics.

### Code review

| Aspect | Result |
|---|---|
| Logic correctness for 6m/6n/6o | OK — traced each test through the rewriter; the `ctesShadowingSource` entry is set in the right frame and suppresses `directHit` as intended. |
| Innermost-first precedence in `isQualifierShadowedInScope` | OK — explicit early-returns on closer rebinds (alias or unaliased) match expected SQL shadowing semantics. |
| Frame initialization | OK — `ctesShadowingSource: new Set()` added to `emptyFrame()`; every other call site goes through it, so no missed initialization. |
| `ScopeFrame` doc comment | Tightened during review to reflect that the recorded qualifier is the alias when present, not always the source name. |
| Type safety / lint | Clean (`yarn lint` exit 0, no `any` introduced). |
| Cross-platform | No platform-specific code; pure AST walk. |
| Resource cleanup | Nothing to clean up — Sets are scoped to the frame. |
| Error handling | N/A — pure data-flow function. |
| DRY / modularity | OK — single small helper added; no duplication. |
| Performance | Negligible — adds one `Set` per scope frame and one extra `O(depth)` scan per qualified column ref. |

### Test review

Implementer-supplied tests (6m/6n/6o) exercise the three principal
shapes the fix targets: unaliased, sibling-WITH, and
recursive-WITH. All three would have failed pre-fix (saved view body
would reference the renamed column name on a CTE that doesn't expose
it). The new 6p extends coverage to the aliased-same-name edge case
the review-stage extension addresses.

Regression coverage for 6a–6l (existing scenarios) is preserved by
the surrounding tests; full sqllogic suite (3172 tests) passes.

### Minor finding — fixed inline

`from t as t` with a non-exposing shadowing CTE: the implement-stage
code only recorded the source name into `ctesShadowingSource` when
the source was *unaliased* (`else if (!ts.alias)`). For an aliased
source whose alias text equals the renamed table name, neither
`ctesShadowingSource` (skipped) nor `aliasMap` (only set on the
exposing branch) was populated — so `directHit` fired and the
qualified `t.k` rewrote incorrectly.

Fix: changed the branch to record the alias (or source name when
unaliased) unconditionally. This keeps the aliased-different-name
case unchanged (the alias is added to the set but never matches a
state-tableName-qualified ref's qualifier, so it's harmless), and
now handles the aliased-same-name case correctly. Test 6p covers
it. Tests + lint pass.

### Major finding — filed as backlog ticket

`tickets/backlog/rename-rewriter-scope-precedence-gaps.md`.

While auditing the scope-stack walks, three helpers were found to
not respect shadowing the way `isQualifierShadowedInScope` does:

- `isCteExposingInScope(name)` ORs across all frames — an outer
  exposing CTE shadowed by an inner non-exposing CTE will still
  report "exposing", binding the inner source to the renamed real
  table. Latent: not surfaced by current tests, but easily
  triggerable with nested same-name CTEs.
- `isTableInUnaliasedScope()` ORs across all frames — same shape.
- `aliasResolvesToTable(alias)` walks outer-first and returns on
  first match — should be innermost-first.

These are the same class of bug as the one this ticket fixed, just
in different helpers. None are introduced by this ticket — they're
pre-existing and latent. The backlog ticket documents the failure
modes, proposes innermost-first rewrites, and lists tests to add
when the work is picked up.

### Docs

`docs/schema.md` covers ALTER propagation at a high level and
doesn't enumerate shadowing-CTE edge cases. No doc updates needed
for this fix; the test file itself documents the covered shapes.

## Validation

- `yarn workspace @quereus/quereus run test` — **3172 passing**.
- `yarn workspace @quereus/quereus run lint` — clean (exit 0).
- `yarn test:store` not run — fix touches only the AST rewriter in
  `src/schema/`; no store-specific code path is involved.
