description: Read half of set-operation membership columns — the `<setop> exists <branch> as <col>` clause (parser/AST/stringify), the `set-op-branch` `RelationalComponentRef` variant, the combinator-derived membership-flag projection on `SetOperationNode` (per-branch semijoin probe → clean `{true,false}` NOT NULL), the read-only `existence` `UpdateSite` for set-op branches, and the FD ramifications. Reads only; all writes reject (write half is `set-op-membership-write`). REVIEWED & COMPLETE.
files: packages/quereus/src/parser/parser.ts, packages/quereus/src/parser/ast.ts, packages/quereus/src/emit/ast-stringify.ts, packages/quereus/src/planner/building/select-compound.ts, packages/quereus/src/planner/nodes/set-operation-node.ts, packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/src/planner/analysis/update-lineage.ts, packages/quereus/src/runtime/emit/set-operation.ts, packages/quereus/src/func/builtins/schema.ts, packages/quereus/test/property.spec.ts, packages/quereus/test/emit-roundtrip.spec.ts, docs/view-updateability.md, docs/sql.md
----

## Summary

The read-only front half of set-operation membership columns shipped and passed an
adversarial review. A binary set operation's branch membership is exposed as a first-class
clean `{true,false}` NOT NULL boolean column derived **at the combinator** (a per-branch
semijoin probe over the operand data relations, never a stored operand column):

```sql
select id, x, inA, inB
from a union exists left as inA, exists right as inB select id, x from b;
```

Grammar (`exists <branch> as <name>` between the set-op keyword/`all` and the right leg,
wired into both compound parse sites, rejected on `diff`), the `set-op-branch`
`RelationalComponentRef` variant, the appended membership-flag attributes + physical surface
on `SetOperationNode` (`key → flag` FDs for the keyed-distinct case, `{true,false}` domain,
`except`/`intersect` constant-fold, read-only `existence` `UpdateSite`), the read-only
lineage resolution, the uniform buffering membership runtime runner, and the `column_info`
read-only reporting all landed as described in the implement handoff. Plain (flag-less) set
ops are byte-identical to before (early return in `computePhysical`, original streaming/dedup
runners untouched).

## Review findings

**Scope of review.** Read the full implement diff (`abfd1a8d`) with fresh eyes before the
handoff summary, across all 13 touched files, plus the supporting code it leans on
(`superkeyToFd`, `checkNext`, `EXISTENCE_FLAG_TYPE`, `column_info` gating, `resolveBaseSite`).
Aspect-checked: SPP/DRY/modularity, soundness of the FD / constant-binding / domain claims,
runtime probe correctness, resource/identity preservation, type safety, error paths, and doc
accuracy. Ran `typecheck` (exit 0), `lint` (exit 0), and the full suite.

**Soundness verified (no findings):**
- **FD claims.** `allDataCols → flag` is sound (the flag is a pure deterministic function of
  the data tuple it probes); `union all` (a bag) correctly makes **no** `key → flag` claim.
  The flag is never inside a claimed key; `isSet`/`keys` are unchanged vs. the flag-less node.
  The full property suite's Key-Soundness over-claim pass (which now rotates the flag-bearing
  union query) stays green across all runs.
- **Constant bindings agree with the runtime.** `except` ⇒ left-flag true / right-flag false;
  `intersect` ⇒ all flags true — confirmed against the runtime probe by the operator-coverage
  test. `union`/`union all` bind nothing.
- **Set identity preserved.** Dedup and probe run over the data columns only
  (`dataComparator` built from `attributes.slice(0, dataColCount)`); flags are appended after,
  so set membership is never perturbed.
- **Read-only routing.** `resolveBaseSite` resolves a `set-op-branch` `existence` site
  non-writable without ever reading the (placeholder) guard; `column_info` reports
  `is_updatable='NO'` / null base; `update`/`insert` through a set-op view reject (not a silent
  no-op). The guard placeholder is correctly load-bearing for the write half only — verified it
  is carried, never consumed, in the read half.

**Adversarial edge-case probing (all behave correctly):**
- Flag referenced in outer `where` / `order by` — resolves via the set-op scope.
- Single-branch flag (`exists right as inB` only) — correct.
- **union all with a tuple present in BOTH branches** — both flags read true, multiplicity
  preserved. This is a distinct case from the shipped duplicate-within-one-branch test.
- **NULL-equal probe** — a NULL-bearing tuple in both legs reads both flags true (set NULL=NULL
  equality), flag stays a clean `{true,false}`, never NULL-propagated.

**Minor (fixed in this pass):**
1. *Test-coverage gap.* The shipped `union all` test only pinned the "present ≥ once" probe
   on the **same** branch. Added two regression tests to `property.spec.ts` →
   `describe('Set-operation membership columns')`: (a) a cross-branch `union all` tuple that
   probes both flags true with multiplicity preserved, and (b) a NULL-equal probe across both
   branches. Both pass and document the previously-unpinned behavior.
2. *Doc honesty.* `docs/view-updateability.md` described unused-flag dead-column-elimination as
   a present-tense property; the implementation always selects the buffering membership runner
   when any flag is present (no prune pass exists — acknowledged in the implement caveats).
   Softened the wording to "in principle … deferred" so the doc no longer overstates the
   current behavior.

**Major (new tickets):** none. The remaining known gaps are all deliberate, documented
deferrals already routed to named follow-up tickets and need no new filing:
- Real accumulated-σ `guard` (vs. the `true` placeholder) → `set-op-membership-write`
  (the read half never consumes the guard, so the placeholder is honest here).
- Dead-column-elimination of unused membership flags (esp. the `union all` streaming regression)
  → sibling of the join's deferred `prune-unused-existence-flag`; correctness unaffected.
- `EXISTENCE_FLAG_TYPE` reuse (cosmetic rename), `union all` count-variant, parenthesized
  left-leg (pre-existing compound-grammar limitation), nested/n-way/projection-position sugar
  → `set-op-membership-nested` / `set-op-membership-ergonomic-extensions`.

**Validation:**
- `yarn workspace @quereus/quereus typecheck` → exit 0.
- `yarn workspace @quereus/quereus lint` → exit 0.
- `node packages/quereus/test-runner.mjs` → **4711 passing, 0 failing, 9 pending** (was 4708;
  +2 new membership regression tests, +1 from the property-suite's randomized rotation). The
  pre-existing LSP-only diagnostics in `property.spec.ts` (lines ~210/249/1457, unreachable
  code / inferred-`any` in unrelated test helpers) are not `tsc` errors and are outside this
  diff.

## Out of scope (still rejecting / deferring, by design)

All write semantics (membership-flip ⇒ branch insert/delete, data-column fan-out,
insert-through) → `set-op-membership-write`. Nested/subtree flags, product coordinates,
multi-target fan-out → `set-op-membership-nested`. Flat n-way shorthand, `union all`
count-variant, projection-position sugar → `set-op-membership-ergonomic-extensions`.
