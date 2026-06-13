description: Set operations (UNION/INTERSECT/EXCEPT/DIFF) now resolve each output column's dedup/compare collation across BOTH inputs through the shared comparison lattice and write it into the node's output column/attribute types, so the runtime dedup comparator and an enclosing ORDER BY stay in lockstep. UNION ALL never errors. Implemented; ready for adversarial review.
prereq: comparison-collation-provenance-and-precedence, join-key-collation-resolution-alignment
files:
  - packages/quereus/src/planner/analysis/comparison-collation.ts        # NEW resolveSetOpColumnCollation + SetOpColumnCollation (reuses private mergeContributions + SOURCE_BY_RANK)
  - packages/quereus/src/planner/nodes/set-operation-node.ts             # cached per-data-column resolution; applied in buildAttributes() + getType()
  - packages/quereus/src/runtime/emit/set-operation.ts                   # comment only (already reads attr.type.collationName)
  - packages/quereus/test/planner/comparison-collation.spec.ts           # NEW resolveSetOpColumnCollation rank/conflict/symmetry block
  - packages/quereus/test/logic/09.1-set-op-cross-collation.sqllogic     # NEW behavior matrix
  - docs/types.md                                                        # § Comparison collation resolution — set-operation subsection
difficulty: medium
----

# Set-operation cross-input collation merge — implement handoff

## What landed

The last row-comparison surface that paired two relations' columns without
consulting both sides — set-operation dedup/membership — now resolves each
output column's collation across **both** operands through the same
provenance-ranked lattice the comparison and join-key tickets already use
(explicit > declared > default > BINARY, **symmetric**, plan-time error on
same-rank explicit/declared conflicts). The resolved collation is written into
`SetOperationNode`'s output column/attribute types, so:

- the dedup / intersect / except / membership comparators in
  `emit/set-operation.ts` pick it up with **no emitter change** (they already
  read `attr.type.collationName` — only a clarifying comment was added);
- an enclosing `ORDER BY`'s `SortNode` keys off the same output-column
  collation → lockstep is structural (one resolution site, two readers);
- nested set-ops re-resolve against the inner node's resolved output column
  **and rank** (forward propagation), so divergence surfaces at every level.

### The resolver (`comparison-collation.ts`)

`resolveSetOpColumnCollation(left, right): SetOpColumnCollation` — one exported
wrapper over the existing private `mergeContributions([a,b])` + `SOURCE_BY_RANK`.
Returns `{kind:'resolved', collationName?, collationSource?}` (the winning
contribution's name + rank as a `CollationSource`, or no collation for the
BINARY floor), or `{kind:'conflict', level, left, right}`. Pure — never throws.
It keeps the winning **rank** (as `collationSource`) that the bare-name
`resolveComparisonCollation` discards; that rank is what makes nested
propagation pin at the correct level.

### The node (`set-operation-node.ts`)

- `dataCollationsCache` (mirrors `attributesCache`) holds one resolved
  `{collationName?, collationSource?}` per DATA column (`0 .. dataColumnCount()`).
  Flag columns (membership + surfaced inner flags, appended after, no collation)
  are never touched.
- Conflict policy keyed on `isSet = op !== 'unionAll'`: DISTINCT operators throw
  `collationConflictError` (the same error a spelled-out comparison throws);
  `unionAll` swallows the conflict and carries no collation forward (bag, no
  dedup — like `||` / CASE).
- `resolvedDataType(baseType, i)` overrides ONLY `collationName`/`collationSource`
  on the left's base `ScalarType` (logicalType/nullable/affinity preserved —
  cross-branch type merge stays the existing TODO). Applied in both
  `buildAttributes()` and `getType()` over the first `dataColumnCount` items,
  **preserving attribute ids** (so ORDER BY / enclosing views still resolve and
  `withChildren` rebuilds are stable). The cache makes the two readers
  un-driftable.
- The conflict throws at **build time** because `createSetOperationScope`
  (`select-compound.ts`) forces `getAttributes()` + `getType().columns`; for DIFF
  the outer union forces the nested except nodes transitively. Confirmed by the
  `-- error:` sqllogic cases firing at prepare.

## How to exercise / validate (use cases)

Behavior matrix lives in `test/logic/09.1-set-op-cross-collation.sqllogic`; the
resolver rank/conflict table in `test/planner/comparison-collation.spec.ts`
(describe `resolveSetOpColumnCollation`). Quick runs:

- planner unit: `node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus/test/planner/comparison-collation.spec.ts"`
- the sqllogic file: same runner with `"packages/quereus/test/logic.spec.ts" --grep "09.1-set-op-cross-collation"`

Cases covered (memory + the two store spot-checks pass):

- **Branch-order symmetry** (headline): declared NOCASE one side, plain other →
  union dedups case-insensitively (3 not 4) in BOTH branch orders.
- **Declared-vs-default** both orders; **explicit/explicit** same-name resolve,
  diff-name → `conflicting COLLATE clauses` error; **declared/declared**
  diff-name → `ambiguous collation` error; explicit COLLATE disambiguates a
  declared conflict.
- **Default/default** diff-name → BINARY **silently** (no error), via
  session-`default_collation` tables.
- **UNION ALL never errors** with divergent explicit AND divergent declared
  collations (the easiest place to wrongly throw) — bag passes 4 rows.
- **INTERSECT / EXCEPT** fold case the same way UNION does (1 row each vs BINARY
  0 / 2); INTERSECT yields the LEFT row but the output column still reports the
  resolved collation (output type is the node's, not the row's).
- **Nested forward propagation**: inner union resolves NOCASE at rank 2; outer
  NOCASE(2) vs declared RTRIM(2) → conflict. This **pins rank propagation** —
  demoting the inner to rank 1 would let RTRIM win silently.
- **Multi-column**: conflict in column 2 errors the whole statement though
  column 1 resolves.
- **ORDER BY lockstep** (end-to-end): `… union … order by <name>` sorts NOCASE
  (`apple < banana < Cherry`, which BINARY would order differently).
- **Membership-flag set-op**: data column still dedups NOCASE; a divergent
  declared data-column collation still errors on the data column only.
- **DIFF**: divergent declared → conflict (each nested except is `isSet`); a
  resolving DIFF folds under NOCASE (2 rows vs BINARY 4).

## Validation run

- `yarn build` — clean (exit 0).
- `yarn test` (all workspaces, memory) — **quereus 6042 passing, 9 pending**; no
  failures in any workspace.
- `yarn workspace @quereus/quereus run lint` — clean (exit 0).
- `node test-runner.mjs --store --grep "File: 09"` — 2 passing (09 +
  09.1) — declared + session-default collations survive the store reconcile path.

## Known gaps / honest flags for the reviewer (tests are a floor)

1. **Compound ordinal `ORDER BY 1` is a constant sort (pre-existing, NOT fixed
   here).** `select-compound.ts applyOuterOrderBy` builds the order-by expr via
   `buildExpression` **without** calling `resolveOrdinalReference` (which the
   regular SELECT path uses), so `order by 1` over a compound sorts by the
   literal `1` (no effective ordering → union/input order), not by output
   column 1. My ORDER BY lockstep case therefore uses the column **name** form
   (which the ticket explicitly allows: "order by 1 (or by column name)"). The
   ordinal gap is latent (no existing test asserts it, so not a `.pre-existing-
   error`), but it is a real limitation a reviewer may want to file as backlog —
   ordinal GROUP BY/ORDER BY works everywhere except the compound outer clause.
2. **Parenthesized-left compound + trailing `ORDER BY` is a parse error**
   (`(A union B) union C order by n` → "got 'order'"). Pre-existing parser
   quirk, unrelated to collation; I worked around it by asserting the nested
   case without ORDER BY (the union runner's left-first/input order is
   deterministic). Flagging in case it surprises the reviewer.
3. **Output-column collation is now a (correct) behavior change.** Previously a
   set-op's output column reported the LEFT input's collation; it now reports
   the symmetric resolved collation. Downstream consumers that read a union's
   output-column collation — **views and materialized views built over a
   cross-collation union** — now see the resolved value. The full suite is green
   (incl. MV/view specs), but I did not author a dedicated "MV over a
   cross-collation UNION persists the resolved backing collation" fixture; that
   is the highest-value place for the reviewer to push deeper (the join-key
   sibling threaded `collationExplicit` into MV backing columns — confirm a
   union body does the analogous right thing through `deriveBackingShape`).
4. **Store path only spot-checked** (`--grep "File: 09"`, count-based asserts).
   Declared-collation set-ops beyond the 09 file under the store reconcile path
   are not separately exercised.
5. **Custom/plugin collations** in set-ops are not tested (only BINARY/NOCASE/
   RTRIM); the resolver is collation-name-agnostic so this should be a no-op, but
   it is unverified.
6. **Forward note (out of scope, in the original ticket):** no sort-merge set-op
   strategy exists, so ORDER BY is the only ordering surface. If one is ever
   added it MUST derive its key collation from the resolved output-column
   collation (this same source of truth) — called out in `docs/types.md`.

## Review findings

(reviewer to complete)
