description: Derived attribute-provenance surface (`computeAttributeProvenance`) + cached per-node `getAttributeIndex()`; validator rewrite replacing the bogus "each attribute ID appears once" invariant with "originated once"; consumer migrations to `getAttributeIndex()`.
files: packages/quereus/src/planner/analysis/attribute-provenance.ts, packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/src/planner/validation/plan-validator.ts, packages/quereus/src/planner/nodes/bloom-join-node.ts, packages/quereus/src/planner/nodes/merge-join-node.ts, packages/quereus/src/planner/rules/access/rule-monotonic-range-access.ts, packages/quereus/test/planner/attribute-provenance.spec.ts, packages/quereus/test/planner/validation.spec.ts, docs/optimizer.md, docs/architecture.md
----

## Summary

Replaced the validator's tree-global "each attribute ID appears at most once" invariant — which false-positived on every attribute-preserving parent (Set/Join/EagerPrefetch/AsyncGather/Project) — with a derived **attribute-provenance surface**:

- `computeAttributeProvenance(root)` (`planner/analysis/attribute-provenance.ts`): one post-order walk returning `Map<attrId, { originNode, path }>`. An ID is *originated* at the deepest relational node that outputs it and whose direct relational children do not; ancestors that re-publish it are *forwarding*. Throws `QuereusError(INTERNAL)` on two distinct nodes originating the same ID, or one node listing the same ID twice. Forwarding never throws. Dedupes by node identity (DAG-safe).
- `PlanNode.getAttributeIndex(): ReadonlyMap<number, number>` — cached `attrId → index` map, replacing scattered `findIndex(a => a.id === …)` scans.
- Validator (`plan-validator.ts`) computes provenance once at entry when `validateAttributes` is on; per-attribute *shape* checks retained; `validateColumnReference` resolves against `provenance.has(attrId)`, preserving the prior global-set scoping semantics.
- Consumer migrations: `bloom-join-node.ts`, `merge-join-node.ts` (added during review), `rule-monotonic-range-access.ts` — all preserve the `-1`-on-miss contract via `.get(id) ?? -1`.

## Review findings

**Diff reviewed against the implement commit (75e217dd) with fresh eyes before reading the handoff.**

### Checked — verified correct
- **Provenance algorithm.** Post-order walk; origination-vs-forwarding logic correct. `visited` set dedupes by node identity so shared subtree instances (DAGs) originate once rather than colliding. Collision (distinct origin nodes) and within-node-duplicate (same node) both throw with distinct messages.
- **`getRelations` ⊆ `getChildren` consistency.** The provenance walk recurses via `getChildren()` but computes the "forwarded" child-ID set via `getRelations()`. Audited every `getRelations` override (`block`, `async-gather`, `fanout-lookup-join`, `subquery`/`exists`, `returning-node`): in each, the relational sources are a subset of `getChildren()`, so no relational source is treated as "forwarded" yet left unwalked. `validateNode` also recurses via `getChildren()`, matching the provenance walk — no divergence.
- **Scoping semantics.** `hasAttribute` → `provenance.has(attrId)` covers every ID in the tree (forwarded IDs resolve to origin), exactly matching the old global-set membership. Sibling-scope visibility intentionally not tightened (per original ticket scope).
- **`getAttributeIndex` caching.** Per-instance lazy field; PlanNodes are immutable and `withChildren` mints a fresh instance, so the cache cannot go stale. Empty map is truthy (object), so zero-attribute nodes cache correctly and never recompute. Scalar nodes (no `getAttributes`) return an empty map harmlessly.
- **Consumer migrations.** `bloom-join` retains `leftAttrs` because `leftAttrs.length` is still needed by `analyzeJoinKeyCoverage`/`propagateJoinFds`; only the index lookups changed. `rule-monotonic-range-access` collapses a manual O(n) loop to a map get. All preserve `-1`-on-miss.
- **Tests.** Cover happy path, forwarding, mixed forward+mint projection, dropped-but-in-scope column, origin collision, within-node duplicate, DAG no-throw, and `getAttributeIndex` position/cache-identity/fresh-on-withChildren. Validator spec flips the core semantics (forwarding parent now accepted) and adds a real-node family block (Join inner/right/cross, SetOperation, EagerPrefetch, AsyncGather) under default options. Workaround removals in `async-gather`/`fanout-lookup-join` confirmed.
- **Docs.** `optimizer.md` §Attribute provenance and `architecture.md` attribute-system bullet both updated and accurately describe origination/forwarding and the "originated once" invariant.
- **Validation.** `yarn typecheck` clean; `yarn lint` clean (exit 0); full suite **3440 passing, 9 pending, 0 failing**.

### Minor — fixed inline
- **`merge-join-node.ts` was the exact structural twin of the migrated `bloom-join-node.ts`** (same 4 `findIndex(a => a.id === …)` sites in `getType()`/`computePhysical()`) but was left unmigrated only because it wasn't named in Phase 4. Migrated it inline to `getAttributeIndex().get(id) ?? -1` for DRY/consistency. `leftAttrs` retained where `.length` is still consumed. Typecheck/lint/full-suite re-verified green after the change.

### Noted — behavior changes, judged acceptable
- **Un-aliased self-join `[id, id]` (same leaf instance both sides) is no longer flagged.** The shared instance originates once and the Join forwards both. This matches the "originated once" model and the original ticket's framing of shared instances as legitimate DAGs. Aliased self-joins (the normal path) already get distinct IDs at build time, so this is not a real-query concern.
- **`getAttributeIndex().get(id)` returns the *last* index on a within-node duplicate ID, vs `findIndex`'s *first*.** Only reachable if a single node's `getAttributes()` contains a duplicate ID, which the attribute model forbids (and `computeAttributeProvenance` now actively rejects). No behavior change for valid trees.

### Major — filed as follow-up
- **Remaining `findIndex(a => a.id === …)` sweep** (`aggregate-node`, `sort`, `window-node`, `reference`, `key-utils`, several rules, and the runtime emitters that operate on raw attribute arrays with no node in hand). Optional DRY polish, not a correctness gap — the surface exists and new code can use it. Filed as `migrate-attribute-index-consumers` (backlog, low priority). Some emitter sites are not trivially migratable (no node available); that's documented in the ticket.
- The unrelated `unified-key-inference-surface` backlog ticket (key/FD/isSet consolidation) was spun off during implement and is not part of this work.
