description: Async-gather `zipByKey` now merges keys deterministically (lowest-indexed present branch == `coalesce` left-to-right pick), so the recognition rule's binary-only collation gate was relaxed to a collation-*agreement* gate. NOCASE (and other non-binary) full-outer chains fold again and match `coalesce`. Reviewed and completed.
files: packages/quereus/src/runtime/emit/async-gather.ts, packages/quereus/src/planner/rules/parallel/rule-async-gather-zip-by-key.ts, packages/quereus/src/planner/nodes/async-gather-node.ts, packages/quereus/test/optimizer/parallel-async-gather-zip-by-key.spec.ts, packages/quereus/test/runtime/async-gather.spec.ts, docs/optimizer.md
----

## What landed

The v1 mitigation gated non-binary key collations out of the `zipByKey`
recognition rule because the emitter took the merged key cells from whichever
branch arrived first (concurrent → non-deterministic). This work made the merge
deterministic and relaxed the gate back to collation *agreement*:

- **Emitter** (`runtime/emit/async-gather.ts`): new `composeMergedKeyCells` — the
  lowest-indexed present branch supplies all K merged key cells. Both the
  tree-walk loop and the NULL-keyed standalone loop use it. The `BTree` is still
  keyed by the first-arrived tuple (drives comparison only; collation-equal keys
  compare identical, so grouping is unaffected).
- **Rule** (`rules/parallel/rule-async-gather-zip-by-key.ts`):
  `keyCollationsAllBinary` → `keyCollationsAgree` — blocks only when a key
  position's collation *disagrees across branches*. This mirrors the agreement
  invariant `AsyncGatherNode.validateZipByKey` enforces (which throws on a true
  mismatch); the rule checks it to decline gracefully rather than let planning
  throw.
- **Docs** (`docs/optimizer.md`): Gates paragraph rewritten to the agreement
  gate + deterministic merge; the out-of-scope non-binary sentence (and this
  ticket as follow-up) removed.

### Correctness argument (verified during review)

`composeMergedKeyCells` matches `coalesce(b0.k, b1.k, …)` because every row with a
NULL in *any* key cell is routed to the NULL-keyed standalone path
(`keyRow.some(v => v === null)` at `async-gather.ts:181`). So within any merged
group every *present* branch has all K key columns non-null and collation-equal
to the group key. `coalesce` picks the first non-null per position; the first
present branch is non-null at *every* position, so it wins every position —
equal to picking the whole key row from the lowest-indexed present branch.
Composite keys, partial-NULL components, and the standalone NULL path all fall
out of the same routing invariant. The branch-0-derived comparator is correct
precisely because the agreement gate guarantees all branches share branch 0's
per-position collation.

## Review findings

**Diff reviewed:** `be0a5a8c` (implement commit) read first, before the handoff
summary. Source, rule, node validator, both test files, and `docs/optimizer.md`
all re-read against the new reality.

- **Correctness (SPP / logic):** ✅ The deterministic-merge argument holds. Walked
  the NULL-routing invariant for single, composite, and partial-NULL keys, and
  confirmed `composeMergedKeyCells` == `coalesce` left-to-right pick at every key
  position under collation-equal-but-byte-distinct keys. The standalone NULL path
  reduces to the prior `branchKeyIndices[branch].map(...)` behavior (single
  present branch). No divergence.
- **Consistency:** ✅ Rule's `keyCollationsAgree` and the doc-comment claims match
  `AsyncGatherNode.validateZipByKey` (which enforces the same per-position
  agreement and *throws* on mismatch — `async-gather-node.ts:193+`). Rule declines
  gracefully; validator is the hard backstop for manual builds.
- **Stale references:** ✅ Grepped for `keyCollationsAllBinary` / "binary-only" /
  "non-binary collations are gated" across `src`, `test`, `docs` — no stale text
  remains (the one "binary-only" hit is a correct contrasting comment in the
  optimizer test).
- **Test coverage — finding, fixed inline (minor):** The ticket's central new
  behavior (deterministic merge regardless of concurrent arrival) had no *direct*
  runtime unit test — only a timing-based 5×-loop assertion in the optimizer
  spec, which does not force an adverse arrival order. Added
  `merged key is deterministic under forced reverse arrival …` to the
  `zipByKey runtime` block (`test/runtime/async-gather.spec.ts`): uses the gated
  `controllableSource` + trace to force the byte-distinct NOCASE branch 1 (`'a'`)
  to arrive and seed the BTree key *first*, then asserts the emitted merged key is
  still branch 0's `'A'`. This fails against the pre-fix `entry.key` behavior, so
  it is a genuine regression floor (not just a restatement).
- **Latent coupling — checked, no action (acceptable):** If a future change ever
  let a present branch carry a NULL key component into a *merged* group,
  `coalesce` would skip it position-wise while `composeMergedKeyCells` emits the
  whole (NULL-containing) row — a divergence. Currently impossible by the
  NULL-key split; the coupling is documented in `composeMergedKeyCells`'s JSDoc
  and the call-site comment, and `composite key with a NULL component is treated
  as NULL-keyed` guards the routing. No ticket filed — guarded invariant, well
  documented.
- **RTRIM / other non-binary collations:** Not explicitly tested (NOCASE only).
  The agreement gate and `composeMergedKeyCells` are fully collation-agnostic, so
  NOCASE is representative; not worth additional cases. Stated explicitly rather
  than left silent.
- **Resource cleanup / error handling / type safety:** ✅ No new resources;
  emitter helper is pure. Types are explicit (`Row`, readonly arrays); no `any`.
  No exception-as-control-flow.
- **Docs:** ✅ `docs/optimizer.md` Gates + Out-of-scope paragraphs now reflect the
  agreement gate and deterministic merge; the follow-up pointer to this ticket
  removed. No other doc references the old binary-only gate.

**No major findings → no new fix/plan/backlog tickets filed.**

## Validation

- `node packages/quereus/test-runner.mjs --grep "ruleAsyncGatherZipByKey"` — 14 passing.
- `node packages/quereus/test-runner.mjs --grep "zipByKey runtime"` — 11 passing (+1 new forced-arrival test).
- `node packages/quereus/test-runner.mjs --grep "AsyncGather"` — 86 passing, 1 pending (strict-fork, intentionally skipped).
- Full suite `node packages/quereus/test-runner.mjs` — **3576 passing, 9 pending, 0 failing** (~41s).
- `eslint` clean on both changed source files and the changed test file.

Note: run tests via `test-runner.mjs` (uses `register.mjs`); raw `npx mocha` falls
back to node strip-only mode and produces spurious failures (TS parameter
properties in mock helpers + a shared global attr-id counter). That is a runner
artifact, not a code issue.

## Related follow-ups (unchanged, out of scope here)

- `parallel-async-gather-zip-by-key-projection-order` — recognizing non-canonical
  projection orderings via a reordering Project on top of the gather.

## End
