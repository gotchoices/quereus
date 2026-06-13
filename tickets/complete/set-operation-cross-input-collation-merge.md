description: Set operations (UNION/INTERSECT/EXCEPT/DIFF) resolve each output column's dedup/compare collation across BOTH inputs through the shared comparison lattice and write it into the node's output column/attribute types, so the runtime dedup comparator and an enclosing ORDER BY stay in lockstep. UNION ALL never errors. Implemented and reviewed.
files:
  - packages/quereus/src/planner/analysis/comparison-collation.ts        # resolveSetOpColumnCollation + SetOpColumnCollation (reuses private mergeContributions + SOURCE_BY_RANK)
  - packages/quereus/src/planner/nodes/set-operation-node.ts             # cached per-data-column resolution; applied in buildAttributes() + getType()
  - packages/quereus/src/runtime/emit/set-operation.ts                   # comment only (already reads attr.type.collationName)
  - packages/quereus/test/planner/comparison-collation.spec.ts           # resolveSetOpColumnCollation rank/conflict/symmetry block
  - packages/quereus/test/logic/09.1-set-op-cross-collation.sqllogic     # behavior matrix (incl. MV-over-cross-collation-UNION added in review)
  - docs/types.md                                                        # § Comparison collation resolution — set-operation subsection
----

# Set-operation cross-input collation merge — COMPLETE

## What landed

Set-operation dedup/membership now resolves each output column's collation
across **both** operands through the same provenance-ranked lattice the
comparison and join-key tickets use (explicit > declared > default > BINARY,
**symmetric**, plan-time error on same-rank explicit/declared conflicts). The
resolved collation is written into `SetOperationNode`'s output column/attribute
types, so the dedup/intersect/except/membership comparators in
`emit/set-operation.ts` pick it up with no emitter change (they already read
`attr.type.collationName`), and an enclosing `ORDER BY`'s `SortNode` keys off
the same output-column collation — lockstep is structural (one resolution site,
two readers). Nested set-ops re-resolve against the inner node's resolved output
column **and rank** (forward propagation). `UNION ALL` swallows conflicts (bag,
no dedup), like `||` / CASE.

- `resolveSetOpColumnCollation(left, right): SetOpColumnCollation` — one exported
  wrapper over the existing private `mergeContributions` + `SOURCE_BY_RANK`, pure
  (never throws); keeps the winning rank as `collationSource` for nested propagation.
- `SetOperationNode.dataCollationsCache` — one resolved `{collationName?,
  collationSource?}` per DATA column; the conflict throws at build time (via
  `createSetOperationScope` forcing `getAttributes()`/`getType().columns`); flag
  columns are never touched. `resolvedDataType` overrides ONLY collation on the
  left base type (cross-branch type/nullable merge remains the existing TODO).

## Review findings

### Process
- Read the implement diff (`2ea5e316`) with fresh eyes BEFORE the handoff, then
  every touched file in full: `comparison-collation.ts` (whole module, to confirm
  the new wrapper composes correctly with `mergeContributions`/`SOURCE_BY_RANK`),
  `set-operation-node.ts` (whole node), the emitter comment, both test files, and
  the docs section.
- Ran the planner unit block (36 passing), the 09.1 sqllogic (passing), the FULL
  quereus suite (**6042 passing, 9 pending, exit 0** — no regressions), and lint
  (clean, exit 0). Store path not re-run in review (handoff spot-checked `File:
  09`; see gap below).

### Correctness — checked, no defects found
- **Resolver composition**: `resolveSetOpColumnCollation` reuses `mergeContributions`
  over exactly `[left, right]`; resolved-name equivalence with
  `resolveComparisonCollation` (modulo BINARY ≡ no-collation) is unit-asserted, as
  is full 11×11 swap symmetry (kind + name + source + conflict-pair). Rank-keeping
  (the one thing the bare comparison form discards) is what powers nested
  propagation and is pinned by the nested-conflict sqllogic case.
- **Conflict policy**: keyed on `isSet = op !== 'unionAll'` — DISTINCT operators
  throw `collationConflictError`; UNION ALL pushes `{}` (no collation). Verified the
  throw is forced at prepare time (the `-- error:` cases fire), and that UNION ALL
  with divergent explicit AND divergent declared collations does NOT throw.
- **Indexing/layout**: only the first `dataColumnCount()` columns are resolved over
  the cached array; flag slices (`[L][R][own]`) ride through verbatim; attribute
  ids preserved so ORDER BY / enclosing views / `withChildren` stay stable. The two
  readers (`buildAttributes`, `getType`) share the one cache and cannot drift.
- **No infinite recursion / no leaks**: `dataCollationsCache` reads children's
  `getType()` only (no self-reference); `Cached`, rebuilt fresh by `withChildren`.
- **Non-textual columns** carry no collation → resolution is a harmless no-op
  (BINARY floor), matching the docs claim.

### Edge/interaction coverage — added in this pass (minor, fixed inline)
- **MV over a cross-collation UNION (handoff gap #3 — the flagged highest-value
  gap).** Verified the union's resolved output-column collation + provenance flows
  through `deriveBackingShape` (`materialized-view-helpers.ts` reads
  `c.type.collationName` and sets `collationExplicit` for declared/explicit
  sources) into the backing column: an MV over `select n from cl union select p
  from cr` (declared NOCASE one side) dedups under the resolved NOCASE (3, not 4)
  in **both** branch orders. Added as §12 of `09.1-set-op-cross-collation.sqllogic`
  (two `create materialized view` + count cases). This was the implementer's
  "highest-value place to push deeper"; behavior is correct and now locked in.

### Major finding — filed as a new ticket (NOT a regression of this work)
- **`tickets/fix/compound-order-by-ordinal-reference.md`** — `ORDER BY <n>` (a
  bare positional ordinal) over a compound set operation is silently a constant
  sort: `applyOuterOrderBy` in `select-compound.ts` compiles the order-by expr with
  `buildExpression` WITHOUT the `resolveOrdinalReference` step every other ORDER
  BY/GROUP BY path runs, so `order by 1` builds the literal `1` and orders nothing.
  Verified reproduction (`select v from t union select v from t order by 1` over
  `{3,1,2}` returns `3,1,2`, not `1,2,3`). Pre-existing, unrelated to collation,
  and no existing test asserted it (so not a `.pre-existing-error`); the
  collation ticket's §9 ORDER-BY-lockstep case correctly used the column-NAME form
  to dodge it. The fix ticket includes the requirement that the resolved ordinal
  key off the same resolved output-column collation (lockstep), and notes the
  separate parenthesized-left-compound + trailing-ORDER-BY *parse* error (handoff
  gap #2) as out-of-scope/flag-only.

### Remaining honest gaps (carried from handoff; not blockers)
- **Store path** beyond `--grep "File: 09"` not separately exercised in review
  (memory + that spot-check pass; declared/session-default collations survive the
  09 reconcile). Not run here to respect agent wall-clock; CI `test:store` covers it.
- **Custom/plugin collations** in set-ops untested (only BINARY/NOCASE/RTRIM); the
  resolver is collation-name-agnostic, so this should be a no-op — unverified.
- **UNION ALL output-column collation driving an enclosing ORDER BY** is exercised
  for "never errors" but there is no assertion that a UNION ALL's *merged* output
  collation sorts an outer ORDER BY (a minor positive-case gap; the resolver path
  is identical to the DISTINCT operators that ARE asserted).
- **Forward note (out of scope):** no sort-merge set-op strategy exists; if added it
  MUST derive its key collation from the resolved output-column collation — called
  out in `docs/types.md`.

## Validation (review run)
- `node … mocha … test/planner/comparison-collation.spec.ts` — 36 passing.
- `node … mocha … test/logic.spec.ts --grep "09.1"` — passing (incl. new §12).
- `yarn workspace @quereus/quereus run test` — **6042 passing, 9 pending, exit 0**.
- `yarn workspace @quereus/quereus run lint` — clean (exit 0).
