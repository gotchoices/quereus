description: PostOptimization rule `rule-async-gather-zip-by-key` that folds a `Project` over a chain of binary full-outer `JoinNode`s sharing a common key set into one N-ary `AsyncGatherNode(zipByKey)`, plus the collation guard on `AsyncGatherNode.validateZipByKey`. Reviewed and completed.
files: packages/quereus/src/planner/rules/parallel/rule-async-gather-zip-by-key.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/src/planner/nodes/async-gather-node.ts, packages/quereus/src/planner/optimizer-tuning.ts, packages/quereus/src/runtime/emit/async-gather.ts, packages/quereus/test/optimizer/parallel-async-gather-zip-by-key.spec.ts, packages/quereus/test/runtime/async-gather.spec.ts, docs/optimizer.md
----

## What landed

A new PostOptimization rule (`rule-async-gather-zip-by-key.ts`, priority 17,
matches `PlanNodeType.Project`) recognizes a `Project` over a left-deep chain of
binary full-outer `JoinNode`s that all equate the **same** key column set across
every branch, and rewrites it to a single
`AsyncGatherNode({ kind: 'zipByKey', branchKeyAttrs, outputKeyAttrs })`.

Because binary `FULL JOIN` has **no runtime lowering** in Quereus
(`runtime/emit/join.ts` throws), this rewrite is the *only* execution path for a
full-outer chain — a recognized shape that fails any gate stays a `JoinNode` and
errors at emit, exactly the pre-rule baseline.

The matcher requires (in order): `Project` over `Join(full)`; the chain flattens
to ≥ `minBranches`; each `ON` is a pure AND-of-column-equalities; equalities
partition into K key positions with **every branch contributing exactly one
column per position**; and the projection list is exactly canonical
(`K coalesce(group) calls` then bare non-key refs in branch+column order), which
matches the emitter's row layout so the gather replaces the `Project` with no
reordering wrapper.

Gates: `concurrencySafe` on every branch; every branch uncorrelated; slowest
branch `expectedLatencyMs ≥ gatherThresholdMs` (inert on memory-vtab plans);
**binary key collation on every branch** (tightened during review — see
findings); and **branch key-uniqueness** (the zip key must cover a declared
unique key of every branch). Provenance is Option A: per-branch key attr ids +
gather-minted output key ids; `preserveAttributeIds` = the Project's output list.

See `docs/optimizer.md` § *Async gather ZIP BY KEY* for the full contract.

## Review findings

**Diff reviewed first, fresh, before the handoff** (`git show b8289baa`): the
rule, the `validateZipByKey` collation guard, the optimizer registration, the
tuning doc, and both spec files. Cross-read the prereq's `async-gather-node.ts`
and the `async-gather.ts` emitter (`runZipByKey`, `composeZipRow`) since the
rule's correctness depends on the emitter's exact row layout and merge behavior.

### Correctness / SPP — one major issue found and mitigated

- **Non-deterministic merged-key value under a non-binary collation (gap #2 in
  the handoff — confirmed real).** `runZipByKey` writes the BTree entry's `key`
  cells once, from whichever branch *first* inserted the entry, and never
  updates them; arrival order is non-deterministic (concurrent driver). Under
  binary collation this is harmless (equal keys are byte-identical). Under a
  non-binary collation (NOCASE etc.) collation-equal keys can be byte-distinct
  (`'A'`/`'a'`), so the emitted merged key is both non-deterministic *and* can
  diverge from `coalesce`'s deterministic left-to-right pick. The implementer's
  gate only required collation *agreement*, which does not prevent this.
  - **Fixed inline (minor mitigation):** the rule gate is tightened from
    "collations agree" to "**every key column is binary**"
    (`keyCollationsAllBinary`), so the rule never folds a chain that could emit a
    silently-wrong/non-deterministic merged key. Non-binary full-outer chains now
    error at emit (the pre-rule baseline) rather than returning wrong results.
    `validateZipByKey` keeps the weaker agreement invariant for manual builds
    (node contract unchanged). Added two tests (`does NOT fold … non-binary
    collation`, `still folds when key columns are explicitly binary`) and updated
    `docs/optimizer.md` + the rule/node doc comments.
  - **Filed (major, proper fix):** `parallel-async-gather-zip-by-key-nonbinary-collation`
    (backlog) — make the emitter's merged-key value deterministic (branch-order
    first-non-null, matching `coalesce`), then relax the gate back to agreement.

- **NULL-key semantics — checked, correct.** Concern that the hash-merge might
  fold NULL keys (SQL `NULL = NULL` is unknown, so a true full join keeps them
  separate). `runZipByKey` explicitly buffers NULL-keyed rows and emits each
  standalone — matches full-join semantics. No issue.

- **Key-uniqueness gate (added beyond the ticket asks) — checked, correct.**
  Requires the zip key to cover a *declared* unique key of every branch; a
  non-unique branch would make the one-row-per-key merge diverge from a true
  full join's per-key product. Conservative (declared-key-only → false negatives
  are safe, they just error at emit as before). Sound.

- **Matcher conservatism — checked, safe.** The coalesce/non-key matcher is
  biased toward false negatives (size checks, exact attr-id match, used-group
  tracking, branch-membership checks). It cannot mis-recognize a shape into
  incorrect results — worst case it declines and the query errors at emit.

- **Provenance / attribute layout — checked, consistent.** `preserveAttributeIds`
  (the Project's output) aligns 1:1 with what the gather's `getType()` /
  `buildZipByKeyAttributes` compute (K minted keys in coalesce order, then
  per-branch non-key in branch+column order). `validatePhysicalTree` runs in the
  full suite and passes.

- **Idempotence / priority collision — checked, fine.** After rewrite the node
  is an `AsyncGatherNode`, so the `instanceof ProjectNode` matcher rejects a
  second firing. Shares priority 17 with `async-gather-union-all` but matches a
  different node type (`Project` vs `SetOperation`), so no ordering conflict.

### Maintainability / DRY / docs

- The rule cleanly generalizes `rule-async-gather-union-all`; helpers are small
  and single-purpose. No duplication concerns.
- `docs/optimizer.md`, `optimizer-tuning.ts` doc, and in-file doc comments
  reviewed and updated to reflect the binary-collation gate and the two filed
  follow-ups.

### Limitations filed as follow-ups (major, not fixed inline)

- `parallel-async-gather-zip-by-key-projection-order` (backlog) — canonical
  projection layout only; any reordered/subset/derived SELECT (and likely
  `USING`/`NATURAL`) hard-errors at emit instead of folding. Reorder-`Project`
  wrapper is the fix.
- `parallel-async-gather-zip-by-key-nonbinary-collation` (backlog) — see above.

### Empty categories

- **Resource cleanup:** nothing to check — the rule allocates no resources;
  driver/fork cleanup lives in `ParallelDriver.drive` (prereq, unchanged).
- **Error handling:** the rule only ever returns `null` (declines) or a new node;
  no exceptions thrown or eaten. `validateZipByKey` throws via `quereusError`
  (intended, guards manual construction).
- **Performance:** rule is O(branches × attrs); union-find + linear scans, no
  pathological paths. No concern.

## Validation

- `yarn typecheck` — clean.
- `yarn lint` — clean.
- `node test-runner.mjs` (full suite) — **3546 passing, 0 failing**, 9 pending
  (was 3544 at handoff; +2 new collation tests).
- Targeted `ruleAsyncGatherZipByKey` spec — 14 passing.

## Pre-existing notes

No `tickets/.pre-existing-error.md` written — suite is green. The `FULL JOIN is
not supported yet` emit error remains expected behavior for any full-outer query
that does not match this rule's gates.
