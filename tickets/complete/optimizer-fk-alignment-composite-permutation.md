---
description: Fix `lookupCoveringFK` (ind-utils.ts) and `checkFkPkAlignment` (key-utils.ts) so composite-FK alignment checks compare the equi-partner of each FK column against the FK's specific `referencedColumns[i]`, not just any PK column. Closes a soundness bug where IND-existence folding (EXISTS / NOT EXISTS / semi-join / anti-join / inner-join elimination) treated a permuted equi-pair set on a composite FK (e.g. `fa = b AND fb = a` against `FOREIGN KEY (fa, fb) REFERENCES p(a, b)`) as covered and produced wrong results.
files:
  - packages/quereus/src/planner/util/ind-utils.ts            # lookupCoveringFK + import + doc
  - packages/quereus/src/planner/util/key-utils.ts            # checkFkPkAlignment + import + doc
  - packages/quereus/test/optimizer/ind-existence.spec.ts     # +2 misaligned-permutation tests +1 3-column lock-in
  - packages/quereus/test/optimizer/rule-join-elimination.spec.ts # +1 misaligned-permutation test
  - docs/optimizer.md                                          # IND-reasoning paragraph updated to "positional pairing"
---

## What shipped

Both `lookupCoveringFK` and `checkFkPkAlignment` previously walked `fk.columns` and accepted the FK whenever each FK column's equi-partner was in the parent PK set. For a 2-column PK both PK indices live in `pkColSet`, so a permuted equi-pair set on a composite FK (e.g. `fa = b AND fb = a` against `FOREIGN KEY (fa, fb) REFERENCES p(a, b)`) silently passed and the IND-existence rules folded a query whose predicate the FK does not actually guarantee.

The fix replaces the set-membership test with a *positional* comparison: for each FK column at index `i`, the equi-partner must equal exactly `fk.referencedColumns[i]` — the specific parent column the FK declares at that position. A defensive cross-check additionally requires every `fk.referencedColumns[i]` to be a PK column so a malformed FK (referencing non-PK columns) is never reported as an IND on the PK.

Because `fk.referencedColumns` is `Object.freeze([])` at CREATE TABLE time (deferred resolution; parent column *names* live in `fk.referencedColumnNames`), both helpers now resolve the parent-column indices with `resolveReferencedColumns(fk, parentSchema)`. The call is wrapped in `try/catch` so a resolution failure (dangling ref name) skips the FK rather than throwing inside the optimizer.

## Review findings

### What was checked

- **Implement-stage diff (`git show b6347c9e`)** read end-to-end against the source it modifies.
- **Soundness of the positional rule.** For each FK column at `i`, the new check requires `equiMap.get(fk.columns[i]) === refCols[i]`. This is necessary and sufficient: the FK's IND guarantee is `(child.fk[i]) ⊆ (parent.refCols[i])` per column; the equi-pair must match that exact pairing for the FK to cover the predicate. A `Map.get` miss (FK column not in any equi-pair) returns `undefined`, which never equals a number, so the check correctly rejects partial coverage.
- **`resolveReferencedColumns` wiring.** Grepped `referencedColumns:` across the codebase — confirmed all CREATE-TABLE / ALTER-TABLE paths (`schema/manager.ts:778,812`, `runtime/emit/alter-table.ts:346`) populate the field as `Object.freeze([])` and put real parent-column names in `referencedColumnNames`. Direct reads of `fk.referencedColumns` would have always returned `[]`, so the resolve call is required. Lowercase-case-folding of column names is consistent with `parentSchema.columnIndexMap` keys.
- **`try/catch` defensive wrap.** `resolveReferencedColumns` throws only when a name is not in `parentSchema.columnIndexMap`. Schema-build validates this for typed-column FKs, but the FK's `referencedColumnNames` could theoretically dangle (e.g. parent altered later). Optimizer rules cannot meaningfully recover from a malformed schema, so silent skip is the right call.
- **Other callers of the two helpers.** `git grep` shows three callers of `lookupCoveringFK` (anti-join-fk-empty, semi-join-fk-trivial, rule-join-elimination) and three callers of `checkFkPkAlignment` (rule-join-elimination, rule-join-key-inference, the helper itself). The key-inference rule only **logs** — stricter alignment cannot break it. The other rules all benefit from the soundness fix.
- **Single-column FK path.** A 1-column FK has only one position, so the bug was invisible there. All non-composite FK regression tests in `ind-existence.spec.ts` and `rule-join-elimination.spec.ts` continue to pass.
- **Lint, targeted suites, and full quereus suite.** All clean; 3025 passing / 2 pending after my added 3-col permutation test.

### Issues found and disposition

- **(minor — fixed inline) Doc drift in `docs/optimizer.md:1345`.** The IND-reasoning paragraph claimed `lookupCoveringFK` matches the equi-pairs "in any permutation." That sentence is exactly the bug. Rewrote to make the positional pairing explicit and added the concrete misaligned example so future readers see the rule, not the prior unsoundness.
- **(minor — fixed inline) Test coverage on wider composite FKs.** The implement-stage tests cover 2-column permutation (one non-canonical case). Added a 3-column composite FK lock-in test in `ind-existence.spec.ts` that fires the canonical pairing (must fold, all child rows returned) and asserts **all 5 non-canonical permutations** abstain (join op survives, zero rows). Locks in the positional rule under wider arity where the old set-membership bug would have continued to misfire if anyone reintroduced the order-blind comparison.
- **(considered — no action) Performance of per-FK `resolveReferencedColumns`.** Each helper call now resolves indices for each candidate FK, building a small `number[]`. In a deep plan with many candidate joins this is repeated work, but the parent table count and FK count are bounded by schema size and the array is tiny. Not worth caching today; revisit only if a plan-time profile flags it.
- **(considered — no action) Unit test against a hand-built malformed `ForeignKeyConstraintSchema`.** The handoff suggested poking the helpers with a synthetic schema whose `referencedColumns` references a non-PK column. The defensive `pkColSet.has(refCols[i])` line covers this, and the `pkDef.length === fk.columns.length` guard also fires for arity mismatches. The case is unreachable through parser+schema today, so no behaviour test was added. If the schema layer later loosens (e.g. UNIQUE-only FKs), `rule-join-elimination.spec.ts` is the right place for a `REFERENCES p(unique_col)` regression and the helpers will already abstain.
- **(considered — no action) Three-column adversarial probe from the handoff.** Implemented; see "fixed inline" above — addressed rather than logged.
- **(considered — no action) Catch silently swallowing real upstream schema bugs.** Reviewed CREATE TABLE / ALTER TABLE flows — `referencedColumnNames` is always either undefined (PK fallback) or comes directly from the parsed `REFERENCES p(col, …)` list. The only resolution failure is a dangling name (parent renamed/dropped after FK creation, which the schema layer itself would have flagged earlier). The catch is unreachable in the happy path and the conservative skip is the right behaviour for an unhappy path.

### Categories with nothing to report

- **Type safety / `any` creep:** none — `refCols` is typed `ReadonlyArray<number>`; no implicit casts; no `any`.
- **Resource cleanup:** the helpers allocate two small data structures (`equiMap`, `pkColSet`) per call; no I/O, no async, no cursors.
- **Error handling beyond what's noted above:** no thrown exceptions cross helper boundaries; the only `throw` source (`resolveReferencedColumns`) is contained.
- **Cross-platform concerns:** no platform-specific code; helpers are pure-function index arithmetic.
- **DRY:** the two helpers share the same shape and same fix; that's intentional (one lives in `key-utils.ts` for non-IND callers, the other adds IND-specific nullability info). Merging them is out of scope and would not improve clarity.
- **Backwards compatibility:** AGENTS.md explicitly says we are not worrying about it yet; the fix tightens behaviour for a soundness bug, which is the intended kind of breakage.

## Validation

- `yarn workspace @quereus/quereus run test --grep "IND-driven existence folding"` → **13 passing** (12 from implement + my 3-col lock-in).
- `yarn workspace @quereus/quereus run test --grep "ruleJoinElimination"` → 13 passing.
- `yarn workspace @quereus/quereus run test` → **3025 passing, 2 pending, 0 failing.**
- `yarn workspace @quereus/quereus run lint` → clean (exit 0, no output).
- `yarn test:store` not run — change touches no store code (per AGENTS.md, store suite is reserved for store-specific diagnosis).

## Notes for archaeologists

- If you reintroduce an order-blind FK alignment check, the new `it('three-column composite FK …')` in `ind-existence.spec.ts` will fail on at least one of the five non-canonical permutations.
- The defensive `pkColSet.has(refCols[i])` line is currently unreachable through user SQL but locks in the IND-on-PK invariant if the schema layer ever accepts a `REFERENCES p(non_pk_col)` declaration.
- The `try/catch` around `resolveReferencedColumns` is a conservative skip-on-malformed-schema; a stricter project policy could replace it with an invariant assertion.
