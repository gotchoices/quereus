description: Whole-Sort elimination over a provably ≤1-row source in `rule-orderby-fd-pruning`. A single-key (or any) ORDER BY over a relation proven to hold ≤1 row is now dropped entirely via a top-of-rule `isUnique([], source)` guard.
files: packages/quereus/src/planner/rules/sort/rule-orderby-fd-pruning.ts, packages/quereus/test/optimizer/rule-orderby-fd-pruning.spec.ts, docs/optimizer.md
----

## What shipped

A relation with ≤1 row is trivially totally ordered, so an `ORDER BY` over it is a
pure no-op. `rule-orderby-fd-pruning` now drops the whole `SortNode` (returns its
source) when `isUnique([], node.source)` — i.e. the empty key `[]` is present in the
source's unified key surface (`keysOf`), which happens iff the source carries a
`∅ → all_cols` singleton FD or a declared empty key. The guard runs **before** the
`sortKeys.length < 2` early-return, so single-key sorts over a singleton source are
eliminated too (the gap the ticket targeted).

This is the degenerate "0 leading keys already form a superkey" case the existing
front-to-back trailing-key loop could not express (it always retains the first key
before checking `isUnique`). It mirrors `rule-distinct-elimination`'s
"return `node.source`" pattern; safe because `SortNode.getType()`/`getAttributes()`
delegate to the source, so the parent sees identical attribute identity.

## Review findings

Reviewed the implement diff (commit `3b37aa91`) with fresh eyes against the
`isUnique`/`keysOf` semantics in `fd-utils.ts`, then the handoff.

### Correctness / soundness — **clean**
- The guard is sound given the key surface is sound: `isUnique([], source)` is true
  only when `keysOf` contains the empty key (`[].every(...)` is vacuously true), and the
  empty key is emitted only by a declared empty key or `hasSingletonFd` — both genuinely
  mean ≤1 row. The broader key-soundness invariant is covered by the existing
  `test/property.spec.ts` "Key Soundness" harness (out of scope here).
- `SortNode` attribute/type delegation confirmed (`sort.ts:49-57`): returning the source
  preserves attribute identity, so no parent column-reference breaks.

### Ordering physical-property regression (the ticket's explicit concern) — **probed, clean**
The handoff flagged but did not exercise the case where an outer operator depends on the
declared `ordering` of a now-Sort-less ≤1-row source. I built and ran two probes:
- `DISTINCT c FROM (SELECT count(*) AS c FROM t) ORDER BY c` — correct single ordered row.
- A `JOIN` with a singleton aggregate side, `ORDER BY t.a` above — correct ordered output.
Both pass. A ≤1-row relation satisfies any ordering, and the rule runs in the Structural
pass (before physical order-requiring inserts), so the worst residual case is a redundant
re-inserted Sort over ≤1 row — a completeness, not correctness, concern. Distilled the
`DISTINCT`-over-singleton probe into a permanent regression test.

### Test coverage — **extended inline (minor)**
The implementer's tests used only scalar aggregates as the ≤1-row source. Added two tests
to `rule-orderby-fd-pruning.spec.ts`:
- **`LIMIT 1` subquery source** → Sort eliminated. Verified empirically that a `LIMIT 1`
  subquery already carries the singleton FD today, so this is a real, covered path (not
  "once limit-one-singleton-fd lands" as the handoff hedged).
- **DISTINCT-over-singleton** ordering-dependent-consumer regression test (above).

Existing negative cases (single-key sort over a multi-row source untouched; trailing-key
pruning unchanged) remain green.

### Completeness gap discovered — **filed as backlog, not fixed here**
Single-row literal `VALUES (1, 2)` is **not** recognized as ≤1-row: `ValuesNode` declares
`keys: []` and has no `computePhysical`, so it emits no `∅ → all_cols` singleton FD even
when it holds exactly one row. The Sort therefore survives over a single-row `VALUES`.
This is a gap in the VALUES node's physical-property computation, not in this rule (the
rule reads the surface correctly), so it is out of scope here. Filed as
`tickets/backlog/values-singleton-fd.md`.

### Docs — **verified accurate**
- `docs/optimizer.md:1250` consumer summary updated to describe the whole-Sort drop.
- Rule doc comment (`rule-orderby-fd-pruning.ts:15-21`) added.
- `docs/architecture.md:181` mentions "ORDER BY pruning" generically — still accurate, no
  change needed.

### Pre-existing failure — **already resolved by triage**
The implementer's `tickets/.pre-existing-error.md` (flaky blob-truthiness differential in
`fuzz.spec.ts`) was triaged in commit `6ee1d4cf`, which fixed the root cause in
`src/runtime/emit/binary.ts` and removed the marker file. Nothing outstanding.

## Validation
- `npx eslint` on the rule + spec — clean.
- `ruleOrderByFdPruning` spec — 17 passing (incl. 2 new tests).
- Full `@quereus/quereus` suite — **3642 passing, 0 failing, 9 pending**.
