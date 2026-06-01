description: Review per-row identity-capture RETURNING for multi-source (inner-join) view UPDATEs. Replaces the old loud-rejection of "update rewrites its own WHERE predicate column" with capture-base-PK-identities-pre-mutation + re-query-by-identity-post-mutation. DELETE path unchanged (pre re-query). A pre-existing both-sides base-decomposition ordering bug was discovered and deferred to a fix ticket.
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/planner/nodes/view-mutation-node.ts, packages/quereus/src/runtime/emit/view-mutation.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, packages/quereus/test/logic/93.2-view-mutation-pending.sqllogic, docs/view-updateability.md

## What shipped

`update <join-view> set <pred-col> = … where <pred-col> = … returning …` now returns
the post-mutation, view-projected rows for exactly the updated rows — matching the
single-source NEW path and Postgres — instead of being loudly rejected.

### Mechanism (multi-source UPDATE RETURNING)

1. **Capture (pre):** `buildMultiSourceUpdateReturning` (new export in
   `planner/mutation/multi-source.ts`) builds a capture SELECT
   `select s0.pk0 as k0, s1.pk1 as k1 from <body FROM clone> where <idPredicate>` —
   the affected view rows' base-PK identities, by the same identifying predicate the
   base ops route on. Built `preserveInputColumns=false` so the output is exactly
   `[k0, k1]`.
2. The emitter (`runtime/emit/view-mutation.ts`) materializes the capture rows into
   `rctx.tableContexts` under a shared `TableDescriptor` **before** draining the base
   ops, and removes the entry in `finally`.
3. Base UPDATE ops run unchanged (`decomposeUpdate`).
4. **Re-query (post):** the join body is re-queried, projecting the **view-spelled,
   base-term** RETURNING columns (incl. `*` expansion), filtered by
   `exists (select 1 from __vmret_keys k where k.k0 = s0.pk0 and k.k1 = s1.pk1)`.
   The keys are exposed via an `InternalRecursiveCTERefNode` (`__vmret_keys`) carrying
   the same descriptor — the working-table-in-context plumbing recursive CTEs and the
   insert envelope already use. Passed to `buildSelectStmt(ctx, ast, new Map([['__vmret_keys',
   refNode]]), false)`. The re-query keeps only the structural join ON-condition; it
   does **not** re-apply the body/user WHERE (so a row pushed out of the view filter
   is still returned, matching single-source NEW).

Node wiring: `ViewMutationNode` gained a `returningCapture?: { source, descriptor }`
field (parallel to `envelope`, but on the relational RETURNING branch), threaded
through `getChildren` / `withChildren` / `toString` / `getLogicalAttributes`. The
DELETE path is unchanged (`pre` re-query of the view by user predicate).

The old loud-rejection guard (`req.op === 'update' && req.stmt.where` clash) and its
`collectColumnRefNames` helper were removed; 93.2's regression case was removed (the
multi-source **insert** RETURNING rejection was kept).

## How to validate

- `yarn workspace @quereus/quereus test` (full suite: 4260 passing / 0 failing here).
- Targeted: `node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js packages/quereus/test/logic.spec.ts --grep "93\."`
- `yarn workspace @quereus/quereus lint` (clean).

### Coverage added — 93.4 § RETURNING (d) (`rjoin2`, two children per parent)

- predicate on the rewritten **child** column (`note='a'→'A'`) → returns cid 1,2.
- predicate on a **parent**-owned reassigned column (`label='P10'→'PX'`, single side)
  → both children re-projected. **This is the core predicate-clash capture case.**
- both sides assigned (note + label), predicated on the **child** column → returns
  both, fully post-mutation.
- `returning *` through the join update with a child-column predicate clash.

Pre-existing § RETURNING (c) `rjoin` cases continue to pass through the capture path.

## Known gaps / what the reviewer should scrutinize (treat tests as a floor)

1. **Both-sides + parent-predicate-clash is NOT covered as a positive test** — and
   that is deliberate. A multi-source update assigning **both** sides while
   predicating on the **FK-parent's reassigned column** drops the FK-child's base
   mutation: the parent op rewrites the predicate column before the FK-child op's
   live identifying subquery runs (verified to reproduce **without** RETURNING too —
   `note` stays `'a'`). This is a pre-existing `decomposeUpdate` ordering bug,
   orthogonal to RETURNING capture (the capture itself re-projects correctly). Filed
   as `tickets/fix/view-mutation-multisource-both-sides-predicate-clash.md`. Test (d)
   statement 3 was therefore predicated on the child column (same expected output).
   **Reviewer: confirm this is genuinely out of scope for the RETURNING ticket and the
   fix ticket captures it faithfully — or decide it must be fixed here.**
2. **`getRelations` excludes the capture source.** The ticket text said to thread
   `returningCapture` through `getChildren` / `getRelations` / `withChildren`, but I
   excluded it from `getRelations`, mirroring the **envelope source** (also a side
   input materialized into context, not part of the node's forwarded output). It IS in
   `getChildren` (so it is optimized and `withChildren`-rebuilt). All 4260 tests pass,
   but the reviewer should confirm no attribute-provenance / binding walk needs the
   capture source in `getRelations`.
3. **Residual base-PK / join-key edge (documented, untested).** An update that changes
   a base PK or the join-key/FK column drops the row from RETURNING (captured `(k0,k1)`
   no longer matches). These columns are generally not writable through supported view
   shapes; noted in `docs/view-updateability.md`.
4. **Composite-PK non-written side + RETURNING** reuses `requireSingleColumnPk`'s
   generic `unsupported-join` diagnostic (not a RETURNING-specific message) and has
   **no dedicated test**. Reviewer may want a focused negative case.
5. **`analyzeJoinView` runs twice** for an update-with-returning (once in `propagate` →
   `decomposeUpdate`, once in `buildMultiSourceUpdateReturning`), each re-planning the
   body. Matches the prior pattern (the old re-query also planned fresh); flagged as a
   perf nit, not correctness.
6. **Descriptor identity through optimization.** The capture descriptor object is
   shared between `ViewMutationNode.returningCapture.descriptor` and the
   `InternalRecursiveCTERefNode.workingTableDescriptor` in the re-query subtree.
   `withChildren` preserves both (the ref node is a `ZeroAry` leaf → returns `this`).
   End-to-end tests confirm the context read/write match, but it's worth a second look.
