description: The `zipByKey` combinator for `AsyncGatherNode` — full N-way outer join over N uncorrelated branches on shared key columns, implemented as an eager BTree hash-merge. Node properties + runtime emitter + manual-construction path (recognition rule deferred to backlog `parallel-async-gather-zip-by-key-rule`).
files: packages/quereus/src/planner/nodes/async-gather-node.ts, packages/quereus/src/runtime/emit/async-gather.ts, packages/quereus/test/runtime/async-gather.spec.ts, packages/quereus/src/planner/analysis/attribute-provenance.ts, docs/runtime.md, docs/architecture.md, docs/optimizer.md
----

## What landed (implement stage)

A third `AsyncGatherCombinator` variant, `{ kind: 'zipByKey', keyAttrs: readonly number[] }`,
performing a full N-way outer join on shared key columns via an eager BTree
hash-merge. Output layout `[ key cols (K) ] ++ [ branch0 non-key ] ++ … `. Node
type/attribute inference (`buildZipByKeyAttributes`, `getZipByKeyType`,
`computeZipByKeyIndices`), construction validation (`validateZipByKey`), physical
property drops, `estimatedRows = max(children)`, and the runtime emitter
(`runZipByKey` + `composeZipRow`) all landed. See the implement summary that was
in the review ticket for the full feature description.

## Review findings

### Scope checked
Implement diff `4290b95c` read first with fresh eyes, then the handoff summary.
Scrutinized: node type/attribute inference, construction validation, physical
property derivation, `estimatedRows`, the emitter's hash-merge + NULL-key path +
collation comparator, BTree (inheritree) API usage, attribute-provenance
interaction, and all touched + should-have-been-touched docs. Ran the targeted
`zipByKey` suite, full `yarn test`, `yarn lint`, `yarn typecheck`.

### MAJOR — filed as new ticket (blocks the recognition rule)
- **`zipByKey` nodes cannot pass `validatePhysicalTree`** (filed
  `tickets/plan/parallel-async-gather-zip-by-key-provenance.md`). The combinator's
  contract requires the shared key attribute id to exist in *every* branch (else
  `validateZipByKey` throws "not found in branch i"). But
  `computeAttributeProvenance` (run by `validatePhysicalTree`) enforces "each id
  originated exactly once" — two independent branches both originating the shared
  key id throw "originated at two distinct nodes". The two requirements are
  mutually exclusive, so no validly-constructed zipByKey node survives physical
  validation, and the optimizer validates physical trees. This was missed at
  implement time because the construction unit tests reuse the same `Attribute`
  object across branches and never ran `validatePhysicalTree` on a zipByKey node.
  The new ticket weighs two fixes (per-branch key refs + minted output key id vs.
  a narrow provenance exception) and needs human sign-off because it touches the
  just-landed provenance surface. The backlog rule ticket
  `parallel-async-gather-zip-by-key-rule` was re-pointed to `prereq` the new
  ticket, and its now-invalid "arrange per-branch projections to share the ID"
  approach was flagged inline.

### MINOR — fixed inline this pass
- **Stale docs.** Implement updated `docs/runtime.md` but missed two other files
  that described zipByKey as "parked in backlog": `docs/architecture.md` (said
  "v1 ships two combinators") and `docs/optimizer.md`. Both corrected to "three
  combinators ship / zipByKey implemented, recognition rule parked".
- **Test gaps.** Added a passing runtime test for a **composite key with a NULL
  component** (must be treated as NULL-keyed / non-merging — `keyRow.some(=== null)`
  path was untested for K>1). Added a `validatePhysicalTree` test on a zipByKey
  node that exposed the MAJOR finding; left it as `it.skip(... BLOCKED ...)` as a
  regression marker to un-skip when the provenance ticket lands.

### Verified correct (no action)
- **NULL-key composition width** matches merged-row width (key cells come from the
  row itself, non-key slots NULL-padded for absent branches) — covered by tests.
- **`getType()` ↔ emitter layout alignment** — both consume `getZipByKeyIndices()`;
  positionally consistent.
- **BTree post-drive walk** (`first()`/`moveNext()` without `safeIterate`) is safe:
  the tree is read-only after the drive loop. Confirmed against the inheritree API.
- **`insert` freezes entries, then `cells[branch] = value` mutates the slot array** —
  safe because `Object.freeze` is shallow (the `cells` array contents stay mutable);
  proven by the passing full-overlap merge test.
- **Collation comparator** mirrors the established DISTINCT / SetOperation pattern
  (`createCollationRowComparator` + `compareSqlValuesFast`, cross-type-safe). NULL
  keys never enter the tree, so the comparator never sees a NULL.
- **`unionAll` / `crossProduct` provenance** are unaffected (their branches keep
  distinct ids; only zipByKey shares the key id).

### Accepted v1 design (documented, not findings)
- **Affinity proxied by `logicalType.physicalType`** (storage class). Acceptable
  as a v1 sanity guard, but it rejects e.g. INTEGER-vs-REAL keys that SQL would
  join under NUMERIC affinity. The provenance ticket / recognition-rule ticket
  should reconsider granularity before any rule auto-mints these nodes. Note: only
  `children[0]`'s key **collation** drives the comparator; cross-branch collation
  disagreement is not validated (affinity is). Worth folding into the same
  redesign.
- `estimatedRows = max(children)` (true bound is `max ≤ result ≤ sum`); conditional
  non-key FDs dropped; within-branch duplicate keys unspecified; eager
  materialization. All documented inline / in JSDoc.

## Validation status (all green)
- `yarn typecheck` — clean.
- `yarn lint` (packages/quereus) — clean.
- `zipByKey` suite — 17 passing, 1 pending (the BLOCKED validator marker).
- Full `yarn test` — 3458 passing, 10 pending, 0 failing across all packages.
  No pre-existing failures surfaced.
