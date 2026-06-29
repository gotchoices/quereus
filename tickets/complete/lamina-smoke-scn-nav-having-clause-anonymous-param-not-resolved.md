---
description: Fixed anonymous `?` (and named) parameters failing to resolve inside a post-aggregate HAVING clause; one-line scope-chain repair plus regression tests. Reviewed and completed.
files:
  - packages/quereus/src/planner/building/select-aggregates.ts
  - packages/quereus/test/logic/25.2-having-edge-cases.sqllogic
---

# Complete — HAVING clause parameter resolution

## What was done

**Root cause:** `buildHavingFilter` (`select-aggregates.ts`) built its hybrid HAVING
scope with no parent (`new RegisteredScope()`). `RegisteredScope.resolveSymbol`
only delegates to `this.parent` when set, so the ancestor chain dead-ended at the
hybrid scope and never reached the `ParameterScope` up in `selectContext.scope` —
`resolveParameter` threw `? isn't a parameter`.

**Fix (one line, `select-aggregates.ts:342`):**

```ts
const hybridScope = new RegisteredScope(selectContext.scope);
```

The hybrid scope still checks its own registered symbols first (GROUP BY columns,
aggregate aliases, source-column fallbacks), so column-resolution precedence is
unchanged; the parent is only reached for symbols the hybrid scope doesn't define
(parameters, qualified `table.column`).

## Review findings

### Verified — root-cause correctness (no issue)
- The fix mirrors an existing pattern: `createAggregateOutputScope`
  (`select-aggregates.ts:294`) already constructs its scope with
  `parentScope === selectContext.scope`. `buildHavingFilter` copied that scope's
  *symbols* but not its parent, which is precisely why the bug existed. The fix
  restores parity. Confirmed correct, not a band-aid.
- **Containment:** the `hybridScope` is consumed only inside `buildHavingFilter`
  (for the HAVING expression and the resulting `FilterNode`). Downstream projection
  and ORDER BY resolve against the returned `aggregateScope` (`aggregateOutputScope`),
  not the hybrid scope — so chaining the parent cannot alter later-clause resolution.
- **Guard not weakened:** `findUngroupedColumnRef` rejects column references by
  attribute id regardless of resolution path. Bare source columns still resolve via
  the hybrid scope's own fallback (taking precedence over the parent) and land on
  source attribute ids, which remain rejected unless grouped. Confirmed by the
  still-passing negative cases (`having id > 0`, `having val > 0`, etc.).

### Tests (added in this review pass)
- **Hardened** the implementer's anonymous-`?` case with `order by grp` — it
  returned two rows with no ordering, unlike every other multi-row case in the file;
  the sqllogic harness compares rows positionally, so this removes a latent
  group-iteration-order flake.
- **Added** a combined WHERE+HAVING anonymous-`?` regression
  (`where val >= ? ... having count(*) = ?`, params `[10, 2]`) that reproduces the
  original bug-report shape (`where tag in (?) ... having count(distinct tag) = ?`)
  and verifies positional `?` indexing spans clauses — a stronger guarantee than the
  single-param HAVING cases.

### Lint (implementer skipped it; run in this pass)
- `yarn lint` (eslint + `tsc -p tsconfig.test.json`): **clean, exit 0.**

### Tests run
- `25.2-having-edge-cases.sqllogic` + `02.1-bind-parameters.sqllogic`: 2 passing.
- Full `yarn test` (all workspaces): **6405 passing / 9 pending / 0 failures** in
  `packages/quereus`; all other workspaces green; overall exit 0. The stderr noise
  from store/sync suites is intentional negative-path logging — those suites pass.

### Docs
- Checked `docs/sql.md` (the only doc with HAVING content). It describes HAVING
  generically and never asserted a parameter limitation, so the fix makes the engine
  match documented behavior — **no doc change needed.**

### Not in scope / no action
- The `site-cad` caller that triggered the original report lives outside this repo
  and needs no change once the engine resolves the parameter — confirmed; nothing to do here.

## Disposition
No major findings; no follow-up tickets filed. Minor test hardening applied inline.
