description: Keyed cross/inner product-key derivation — combineJoinKeys + analyzeJoinKeyCoverage emit ONE lex-min composite product key (leftKey ∪ rightKey-shifted) for a true keyed inner/cross product, so keysOf surfaces a column key instead of the all-columns fallback. Reviewed and completed.
files: packages/quereus/src/planner/util/key-utils.ts, packages/quereus/test/optimizer/keys-propagation.spec.ts, docs/optimizer.md
----

## Summary

A keyed `inner`/`cross` relational product — where **neither** side's key is
covered by the equi-predicate but **both** sides advertise a non-empty unique key
— is itself keyed by `(leftKey ∪ rightKey-shifted-by-leftColumnCount)`. That
composite is now emitted at both the logical (`combineJoinKeys`) and physical
(`analyzeJoinKeyCoverage` → `propagateJoinFds` → `superkeyToFd`) key layers, so
`keysOf` surfaces a real column key for the product (consumed by DISTINCT
elimination, covering proofs, MV backing-PK derivation) instead of falling back to
the all-columns/`isSet` fact. A new `selectLexMinKey<K>` helper bounds growth to
exactly one product key per join node.

See `docs/optimizer.md` § *Keyed cross/inner (and lateral) product keys* for the
soundness argument, the one-key-per-node policy, and the gate.

## Review findings

**Diff reviewed:** commit `c1b0c7f8` (key-utils.ts +73, keys-propagation.spec.ts
+119, docs/optimizer.md +38). Read with fresh eyes against the FD integration
(`propagateJoinFds`/`superkeyToFd`/`keysOf`) before the handoff summary.

### Soundness (VERIFIED — no defects)

- **Composite product key is sound.** For `inner`/`cross`, each `(leftKey-value,
  rightKey-value)` pair occurs at most once: leftKey is unique on the left,
  rightKey on the right, and inner/cross only *removes* `(leftRow, rightRow)`
  pairs — never duplicates one — so the composite stays a key. Holds for bare
  cross joins, non-equi inner predicates, and many-to-many equi predicates alike.
  Confirmed there is no counterexample for inner/cross.
- **Gate is for minimality, not soundness.** The composite is *always* a sound key
  for inner/cross; the `!survive && !survive` (resp. `!covered && !covered`) gate
  only suppresses it when a simpler survivor key already exists (the survivor is a
  subset → composite would be non-minimal/double-counting). Both layers gate on
  the symmetric AND of the same two facts, so they reach the new branch in the
  same situations.
- **≤1-row edge handled.** A ≤1-row side carries only the empty key `[]`, which
  makes the survivor branch fire (`joinPairsCoverKey`/`isUnique` vacuously true)
  AND makes `selectLexMinKey` return `undefined`, so the composite is never
  reached. Verified in both layers (the singleton path sets `*KeyCovered = true`
  in `analyzeJoinKeyCoverage`).
- **All-columns edge handled.** When a side's only key is the all-columns key
  (a set with no smaller key), the composite is the full product row;
  `superkeyToFd` returns `undefined` for an all-columns determinant, so no useless
  FD is emitted and full-row set-ness continues to flow through `RelationType.isSet`.
- **`desc` preservation** is faithful — `selectLexMinKey` returns the original
  `ColRef` array and `combineJoinKeys` re-maps `{index, desc}` on both picks.
- **Index disjointness:** right indices are shifted by `leftColumnCount`, so left
  and right picks never collide in the concatenated key.

### Layer parity (acceptable divergence, documented)

- `combineJoinKeys` reads `leftType.keys` via `joinPairsCoverKey` (logical only);
  `analyzeJoinKeyCoverage` reads `keysOf(rel)` via `isUnique` (FD-aware + all-cols
  fallback). The two can therefore *pick different composite keys*, but both are
  sound, and `keysOf` merges the logical-key and FD-derived surfaces downstream,
  so surfacing both is harmless (more complete, never unsound). Not a defect.
- **Lex-min determinism:** deterministic given a stable upstream key order; the
  only non-determinism is the *choice* among equal-length / equal-first-index keys
  (affects which sound key, never soundness). Upstream key order is stable
  (schema-declared + deterministic FD derivation), so no test flake. Noted, not
  tightened — would be a pure-polish change.

### Lateral claim (VERIFIED accurate)

The doc section is titled "…(and lateral)…". Confirmed `LATERAL` joins are built
as a `JoinNode` (`building/select.ts:590,634`) with joinType `cross`/`inner`, so
they route through the *identical* `combineJoinKeys`/`analyzeJoinKeyCoverage` path;
the composite forms whenever the lateral right side (e.g. a TVF) advertises a
non-empty key. Only the lateral-TVF *integration test* was deferred (honest); the
base-table `CROSS JOIN` integration tests exercise the same code path, so coverage
is not lost.

### Docs (VERIFIED current)

- `docs/optimizer.md`: new § *Keyed cross/inner (and lateral) product keys* added;
  the two pre-existing prose spots that claimed `combineJoinKeys` "returns `[]`"
  were corrected to point at the new behavior. Cross-link anchor
  `#keyed-crossinner-and-lateral-product-keys` matches the generated heading slug.
- `docs/materialized-views.md`: checked — no stale `combineJoinKeys`/"product key"
  references. No other `.md` references the old behavior.

### Build / lint / tests (all green, re-verified independently)

- `yarn workspace @quereus/quereus run build` → exit 0, 0 TS errors.
- `yarn workspace @quereus/quereus run lint` → exit 0, 0 errors/warnings.
- Targeted: "Keyed product" (3), "Key propagation" (64), "combineJoinKeys unit
  tests" (22 after the added gate test) — all passing.
- **Full** `yarn workspace @quereus/quereus test` → **3885 passing, 9 pending, 0
  failing** (includes the MV regression corpus — no behavioral regression from
  narrowing the all-columns fallback to the composite product key).

### Findings disposition

- **Minor (fixed inline):** Added a unit test
  (`INNER covering only ONE side → survivor key only, NO composite (gate)`) closing
  the one untested gate case — the existing suite covered "both covered" and
  "neither covered" but not the asymmetric "one covered" case, which is precisely
  the double-counting case the gate guards. Test passes; suite stays green.
- **Minor (noted, not actioned — low value):** No *direct* unit test of
  `analyzeJoinKeyCoverage`'s composite `preservedKeys` (it is covered via the
  `query_plan` integration tests; a direct unit test would require heavyweight
  `RelationType`/`PhysicalProperties` fixtures for marginal gain). Lex-min
  tie-break could be tightened to a sorted signature if a real flake ever appears.
- **Major:** None. No new fix/plan/backlog tickets filed.

## Known follow-ups (carried from implement, non-blocking)

- **Lateral-TVF integration test** remains a nice-to-have follow-up *if* a TVF
  readily advertises a per-call non-empty key reaching `combineJoinKeys` (check
  `table-function-call.ts` `getType().keys`). The composite product key is now
  produced end-to-end through the shared JoinNode path, so
  `materialized-view-rowtime-general-bodies` can consume the composite backing PK.
