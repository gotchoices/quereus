----
description: Extend the View Round-Trip Law property harness (PutGet / GetPut / forward-backward lineage agreement) from the shipped single-source Tier A to the multi-source key-preserving inner-join tree AND the n-way decomposition fan-out, so the backward (put) direction has a mechanical soundness net wherever it ships — not just on single-source. This is the acceptance gate the derived-backward-walk migration (`view-mutation-derived-backward-walk`) is checked against, so it must land first.
files: packages/quereus/test/property.spec.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/mutation/decomposition.ts, packages/quereus/src/planner/analysis/update-lineage.ts, packages/quereus/src/planner/analysis/view-complement.ts, packages/quereus/src/vtab/mapping-advertisement.ts, docs/view-updateability.md, docs/lens.md
effort: high
----

## Why this exists

The backward (write) direction of view-updateability is the most correctness-sensitive
code in the VU/MV/lens stack, and today it has the *least* mechanical coverage exactly
where it is hardest. The forward direction is netted by **Key Soundness**
(`test/property.spec.ts`, Tiers 1+2). The backward direction is netted by **View
Round-Trip Laws** — but only **Tier A** has shipped: single-source projection-and-filter
bodies (bare `select *`, explicit/rename projection, computed column, equality-filter,
alias-qualified body). See `docs/view-updateability.md` § "Round-Trip Laws and the Derived
Backward Walk" and the "Landed (Tier A)" note.

The shipped multi-source inner-join path (`planner/mutation/multi-source.ts` —
`update`/`delete` Phase 2a, `insert` Phase 2b) and the decomposition fan-out
(`planner/mutation/decomposition.ts` — INSERT/UPDATE/DELETE) currently have **no
round-trip property coverage**. Their backward rules are hand-written and gated by
discipline alone. That is the standing soundness risk flagged in the architecture review:
*"the most powerful operators have the least mechanical soundness coverage."* This ticket
closes it for the shapes that have shipped.

Scope note: this ticket builds the **soundness net** (the law harness). The Voigtländer-style
*auto-derivation of `put` from `get`* is the separate, deferred north-star and is explicitly
**out of scope** (it is an enhancement, sequenced after the operator set stabilizes). The
harness here is what makes that later enhancement a safe refactor.

## What to build

Extend the existing `describe('View Round-Trip Laws')` block in
`packages/quereus/test/property.spec.ts`. Reuse its existing structure verbatim — a pure
law core + a negative self-test that proves each law reds on an injected violation, with
`numRuns` per law (Tier A uses 50). Do **not** fork a parallel harness; add body-shape
families to the same block so the three laws are asserted uniformly across all shipped
backward paths.

Add two body-shape families over randomly-seeded small base tables:

### Family B — multi-source key-preserving two-table inner join
Bodies of the form `select … from T join P on T.fk = P.id` matching what
`collectInnerJoinSources` / `analyzeMultiSourceInsert` accept (two-table inner equi-join,
single-column PKs, no self-join, no `select *` join body). Cover:
- `update` touching columns on one side, on the other side, and on both (per-side base ops).
- `delete` (FK-many/child default routing; and a `delete_via`-tagged variant).
- `insert` with the shared key **directly supplied** and with it **minted** (the
  `integer-auto` / `per-row` shared-surrogate envelope — `ViewMutationNode.envelope`).

### Family C — n-way decomposition fan-out
Decomposition bodies driven by a `primary-storage` mapping advertisement (build via the
`buildAdvertisementsFromTags` / `quereus.lens.decomp.*` tag path so the test needs no custom
module). Cover the shipped fan-out arms in `decomposition.ts`:
- INSERT anchor-first, one-per-member, surrogate minted once per row and threaded into every
  member's key (the evaluate-once-and-thread invariant — assert all members agree on the key).
- UPDATE routed to the mandatory non-EAV member backing each column.
- DELETE across every member, anchor-last, anchor-only identifying predicate.
- Include an **optional (outer-joined) member** and an **EAV pivot** member so PutGet
  exercises the per-row presence gate and the triple insert.

### The three laws (unchanged in meaning; assert them on B and C)
- **PutGet (write-then-read):** apply a generated mutation through the view, read the view
  back, assert the read reflects exactly the mutation's effect on writable columns — no rows
  appear/disappear outside the view predicate; computed columns are read-only (a write reds
  with the `no-inverse` diagnostic, never silently dropped); the key the forward walk claims
  on the view output is the same tuple the backward walk used to bind the base rows. For
  multi-source/decomposition, cross-check the post-state **view image** against the **union of
  base images** (every member/side).
- **GetPut (read-then-write-back):** read a row through the view, write the same values back
  via the identifying predicate, assert every base table / member diff is empty.
- **Forward/backward lineage agreement:** plan the body; for each output column cross-check
  the backward lineage (`deriveViewColumns` → per-source `updateLineage`, and the
  decomposition's advertisement-driven member map) against the forward FD facts
  (`keysOf`/`isUnique`/`fds`): every `base`-writable column has a forward FD path to that base
  column, and every forward key is reconstructible by the backward identifying predicate.
  This is the structural crux — it is what catches an operator advertising a key forward while
  its `put` threads it to the wrong base column.

### Negative self-tests (mandatory, mirroring Tier A)
For each new family, inject a violation and prove the law reds — e.g. a put that writes a row
outside the join/decomposition predicate, a deliberately wrong member key thread (PutGet/lineage
red), and a non-empty GetPut diff. A law that cannot be made to red is not testing anything.

### Shapes asserted to REJECT (not silently widen)
Mirror Tier A's reject assertions for the new families: outer-join `insert`, composite-PK or
`>2`-table joins, self-joins, cross-source `set`, `select *` join bodies (multi-source); and
the decomposition deferred shapes (`unsupported-decomposition-predicate`,
`unsupported-decomposition-update`, non-integer surrogate, composite shared key). Assert the
structured diagnostic fires rather than a wrong/empty result.

## Acceptance criteria
- `yarn workspace @quereus/quereus test` green, including the extended block.
- The `View Round-Trip Laws` block exercises B and C with working negative self-tests for each.
- `checkedNodes`/`numRuns`-style guards present so a family cannot silently degenerate into
  all-skips or all-rejects (same guard discipline as Key Soundness Tier 2).
- `docs/view-updateability.md` § Round-Trip Laws updated: the "Landed (Tier A)" note becomes
  "Tier A + multi-source + decomposition"; `docs/lens.md` decomposition section gets a
  one-line pointer to the decomposition round-trip coverage.

## TODO
- [ ] Read the shipped `describe('View Round-Trip Laws')` block and factor its law core so B/C reuse it (no copy-paste of the three laws).
- [ ] Build the Family B inner-join body zoo + base-image cross-check helper.
- [ ] Build the Family C decomposition fixtures via `quereus.lens.decomp.*` tags + `buildAdvertisementsFromTags`; include an optional member and an EAV pivot.
- [ ] Implement PutGet / GetPut / lineage-agreement for B and C against the union of member/side base images.
- [ ] Add a failing-by-construction negative self-test per family per law.
- [ ] Add the reject-don't-widen assertions for the deferred shapes.
- [ ] Run full `yarn test`; update both docs' status notes.
