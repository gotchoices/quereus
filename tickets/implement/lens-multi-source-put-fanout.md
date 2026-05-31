description: The `put` direction of n-way decomposition — propagate a logical-table mutation (insert / update / delete) as an ordered fan-out across every basis member of the decomposition, with a shared key that may be a surrogate supplied by a basis default and **evaluated once per logical row and threaded** across all branches so members agree on identity, optional members handled per outer-join semantics, and the singleton degenerate case. Rides the view-mutation substrate (`ViewMutationNode` / `propagate()` / multi-element `BaseOp[]`) and the evaluate-once-and-thread mutation-context cadences. Consumes the existence facts from `lens-multi-source-ind-injection` for put soundness. Design source: `docs/lens.md` § "The Default Mapper" (shared-key surrogate, evaluate-once-and-thread, singleton).
prereq: lens-multi-source-get-synthesis, lens-multi-source-ind-injection, view-mutation-substrate-core, view-mutation-multisource-innerjoin
files: packages/quereus/src/schema/lens-compiler.ts, packages/quereus/src/vtab/mapping-advertisement.ts, packages/quereus/src/planner/mutation/propagate.ts, packages/quereus/src/planner/nodes/view-mutation-node.ts, packages/quereus/src/runtime/emit/view-mutation.ts, packages/quereus/src/planner/building/insert.ts, packages/quereus/src/planner/building/update.ts, packages/quereus/src/planner/building/delete.ts, docs/lens.md, docs/view-updateability.md
----

<!-- prereq-correction (2026-05-31) -->
> **PREREQ CORRECTED — was mis-dispatched; this ticket should defer, not run yet.**
>
> A run on 2026-05-31 verified the codebase. Two corrections vs the prior notes
> (which were written against superseded slugs and a transient empty-filesystem
> read — ignore any earlier "substrate/lens absent" claim; that was a tooling
> artifact, not reality):
>
> 1. **The lens read/advertisement half is LANDED** (in `complete/`, code verified):
>    `vtab/mapping-advertisement.ts` defines `MappingAdvertisement` / `StorageShape`
>    (`anchorRelationId`, `members[]`, `sharedKey`) / `DecompositionMember`
>    (`presence:'mandatory'|'optional'`, `columns`, `attributePivot`) / `SharedKey`
>    (`kind:'surrogate'|'logical-tuple'`, `keyColumnsByRelation`, `generator?`) /
>    `SharedKeyGenerator` (`strategy:'integer-auto'|'uuid7'|'callback'`,
>    `cadence:'per-row'|'per-statement'`, `expr?`). `schema/lens-compiler.ts` carries
>    `compileDecompositionBody` (the n-way `get` join synthesis) and
>    `computeExistenceAnchorInds` (the IND injection this put consumes). `LensSlot`
>    (`schema/lens.ts`) exposes `advertisement`, `injectedInds`, `readOnly`,
>    `columnProvenance`, `compiledBody`. So the read body + advertisement + INDs this
>    ticket builds on **exist** — re-verify the exact field names before use, but the
>    "Current state" section below is accurate.
>
> 2. **The write substrate is IN FLIGHT in `implement/`, under new slugs.** The old
>    `view-mutation-substrate-orchestrator` slug (named in the prior prereq header,
>    matching no file → the runner could not gate on it → this ticket got
>    mis-dispatched) was decomposed into three implement/ tickets:
>      - `view-mutation-substrate-core` (3.1) — generalizes `propagate.ts` into a
>        `propagate(ctx, view, req): BaseOp[]` producer, adds `ViewMutationNode`
>        (`planner/nodes/view-mutation-node.ts`) + emitter
>        (`runtime/emit/view-mutation.ts`), retires the single-source AST rewrite
>        (`building/view-mutation.ts` is deleted), defines `BaseOp`.
>      - `view-mutation-multisource-innerjoin` (3.2) — planned-body walk emitting
>        **multi-element** `BaseOp[]`, emitter sequencing (FK order, conflict
>        composition, RETURNING-through-view), `MutationRequest`, and crucially the
>        **shared-surrogate mutation-context threading** (per-row/per-statement key
>        resolved at the envelope before fan-out) — the exact mechanism this ticket's
>        surrogate threading rides.
>      - `view-mutation-tag-override-surface` (3.4) — the `quereus.update.*` override
>        surface; **not** a hard prereq here (the decomposition fan-out is
>        advertisement-driven, not tag-driven), and it is numbered so it runs before
>        this unnumbered ticket anyway.
>    `view-mutation-physical-lineage` (the lineage annotation layer) is **complete**.
>
> The prereq header now names the real in-flight substrate slugs, so the runner's
> automatic cross-stage gating will **defer** this ticket until
> `view-mutation-substrate-core` + `view-mutation-multisource-innerjoin` land — the
> sanctioned "prereq still in implement → deferred automatically" path, **not** a
> `blocked/` case. This ticket is intentionally left UNNUMBERED so it runs after all
> numbered (3.x) substrate tickets and satisfies the prereq-sequence rule for both
> the numbered (3.1/3.2) and the completed-unnumbered (lens) prereqs.
>
> **To resume once the substrate lands:** delete this note and implement Phases A–D
> against the substrate's *actual* `BaseOp` / `MutationRequest` / `ViewMutationNode`
> / `propagate()` surface (adapt to whatever shape 3.1/3.2 shipped — see their tickets
> for the settled `BaseOp` / `MutationRequest` shapes).
>
> **Environment note:** on this Windows host the Bash tool may intermittently see an
> empty tree (`ls`/`grep` return nothing though files exist). Prefer the Read / Glob /
> Grep tools / PowerShell / the code-search index for file ops, build, and test.
<!-- /prereq-correction -->

## Scope

The write half of the decomposition. After `lens-multi-source-get-synthesis`, a
logical table over a columnar/EAV/column-family decomposition **reads** through a
synthesized n-way join but still **rejects** multi-source writes (the v1
single-source view-updateability path cannot sequence more than one base op). This
ticket flips that: a mutation through such a logical table fans out to every member
basis relation as an ordered set of base ops, with the shared key threaded so all
members agree on row identity.

This is fundamentally a consumer of the **view-mutation substrate**
(`view-mutation-substrate-core` + `view-mutation-multisource-innerjoin`): those
tickets retire the Phase-1 AST rewrite and make `propagate.ts` + `ViewMutationNode`
the single propagation path for all view mutations, sequencing multiple base ops with
conflict composition, FK ordering, and RETURNING capture. The decomposition put is
exactly a multi-source case of that substrate — this ticket supplies the
**advertisement-driven fan-out shape and the surrogate generation/threading**; the
substrate supplies the orchestration mechanism. (Hard prereq: without the substrate
there is no multi-base-op sequencer to fan out into.)

## Why the substrate is a hard prereq (not a hint)

`docs/view-updateability.md` and the substrate tickets are explicit: the Phase-1
AST rewrite "does not generalize — it drives off `selectAst` and cannot sequence
more than one base op." Multi-source put has no other host. So this ticket designs
*as if* the substrate has landed (per the tess prereq rule) and builds the
decomposition-specific fan-out on top of `ViewMutationNode` / `propagate.ts`. If
the substrate's surface differs at implement time from what is sketched below,
adapt the fan-out to the substrate's actual `BaseOp` / `MutationRequest` / orchestrator
API rather than re-inventing a sequencer.

## Current state (verified 2026-05-31)

- `packages/quereus/src/vtab/mapping-advertisement.ts` — the advertisement carried on
  `slot.advertisement` (`MappingAdvertisement.storage: StorageShape`) holds the fan-out
  shape: `members[]` (each `relationId`, `relation:{schema,table}`,
  `presence:'mandatory'|'optional'`, `columns[]?:{logical,basis}`, `attributePivot?`),
  `anchorRelationId`, and `sharedKey` (`kind:'surrogate'|'logical-tuple'`,
  `keyColumnsByRelation: Record<relationId, string[]>`, `generator?`).
  `SharedKeyGenerator` carries `strategy:'integer-auto'|'uuid7'|'callback'`,
  `cadence:'per-row'|'per-statement'`, optional `expr` (SQL text for `callback`).
- `packages/quereus/src/schema/lens-compiler.ts` — `compileDecompositionBody` already
  synthesizes the n-way `get` join (anchor-rooted left-deep; mandatory inner-joined,
  optional outer-joined; EAV pivots as subqueries) and `computeExistenceAnchorInds`
  injects the per-member existence INDs (`LensSlot.injectedInds`). The put fan-out
  mirrors this read shape in reverse.
- `packages/quereus/src/planner/building/{insert,update,delete}.ts` — view-mediated
  DML dispatch. **NOTE:** `view-mutation-substrate-core` reroutes these three sites
  from `return buildXStmt(ctx, rewriteViewX(...))` (the AST rewrite, now deleted) to
  building a `ViewMutationNode` via `propagate()`. Build this ticket on the post-3.1
  dispatch, not the old rewrite. The mutation-context plumbing (`stmt.contextValues` +
  `tableSchema.mutationContext`, `mutationContextValues` map, `contextAttributes`,
  runtime `evaluateContextRow` in `runtime/emit/dml-executor.ts`) is the
  **statement-level evaluate-once** seam that `view-mutation-multisource-innerjoin`
  extends into the per-row shared-surrogate envelope — the per-statement surrogate
  cadence rides this directly; the per-row cadence rides 3.2's per-row envelope.
- The IND existence facts from `lens-multi-source-ind-injection` prove every
  logical row exists in each mandatory member — the put fan-out relies on this to
  emit a mandatory member's insert/update without a defensive existence probe and
  to know a delete must reach every mandatory member.

## Design

### Fan-out shape per mutation kind

Given the resolved decomposition, `propagate.ts` emits one ordered `BaseOp` group:

- **Insert** — one insert per member. The anchor insert establishes row identity
  (and is the FK-order root). Mandatory members each get an insert; optional members
  get an insert **only when the logical row supplies a value** for at least one of
  that member's columns (an all-null optional component is *not* materialized — that
  is exactly the outer-join semantics the read body preserves). The shared key value
  is threaded into every member insert (see surrogate threading).
- **Update** — for each member, update the columns it backs. Updating a logical
  column routes the new value to the single member that backs it
  (`buildColumnBackingMap`). Setting a previously-null optional component to a
  non-null value becomes an **insert** into that optional member (the row did not
  exist there); setting it back to all-null becomes a **delete** from that member.
  (v1 may restrict update of optional-component presence transitions to a clear
  diagnostic if the substrate's op-composition does not yet support insert-or-delete
  branching within an update fan-out — decide against the substrate's actual
  capability and document the boundary rather than emit an unsound op.)
- **Delete** — delete from every member (mandatory and optional) keyed by the shared
  key; the anchor delete is "the logical row ceases to exist." Order so FK / anchor
  constraints are honored (the substrate owns FK ordering; supply the anchor-as-root
  hint).

### Surrogate generation + evaluate-once-and-thread (load-bearing)

When `sharedKey.kind === 'surrogate'`:

- The surrogate is supplied at insert by the basis default named in
  `SharedKeyGenerator` — but it must be **evaluated once per logical row** and the
  **same** value threaded into every member's insert, so all branches of the fan-out
  agree on identity. Evaluating the basis default independently per member would mint
  a *different* key per member and shatter the row across the decomposition.
- **Cadence:**
  - `cadence:'per-statement'` → bind the surrogate once for the statement via the
    existing mutation-context evaluate-once seam (`mutationContextValues` /
    `contextEvaluatorInstructions`), and thread that single attribute into each
    member insert's key column(s).
  - `cadence:'per-row'` → mint a distinct value per produced logical row, evaluated
    once *before* fan-out for that row, then threaded to every member insert for that
    row. This is the row-scoped analogue of the statement-level seam; reuse the
    per-row shared-surrogate envelope that `view-mutation-multisource-innerjoin`
    establishes (the single captured per-row value resolved at the envelope BEFORE
    propagation reaches the branches), publishing the value to each member op. If 3.2
    exposes a per-row computed-binding slot, use it; otherwise extend it in
    `ViewMutationNode`.
- **Strategy:** `integer-auto` / `uuid7` / `callback` map to the basis default
  expression (`generator.expr` for `callback`, or the engine's built-in generator
  for `integer-auto`/`uuid7`). A **non-deterministic** generator (`uuid7()`,
  `nanoid()`) is permitted where local DML policy allows non-determinism; the
  change-capture layer records the **resolved** row, so reactive consumers see the
  concrete value (the determinism guarantee that matters downstream). Reuse the
  existing nondeterministic-schema-expression policy rather than re-litigating it.
- When `sharedKey.kind === 'logical-tuple'` the shared key **is** the logical PK
  arriving from the logical layer — **no generation**; thread the logical key columns
  straight into each member's key columns. Generation collapses entirely.

### Singleton degenerate case

`primary key ()` → at most one logical row; there is no surrogate to generate
(nothing to distinguish at most one row). The fan-out still inserts/deletes across
members keyed by the (empty) key — i.e. the member ops are unconditional (`on true`
in the read body; "the singleton row exists" in the write). The existence anchor
still matters: it lets the singleton exist with every column null. The mandatory-
column elision (a `not null` member serving as the anchor) is honored by whatever
member the advertisement names as anchor — no special-casing.

### Soundness via the injected INDs

The mandatory-member fan-out (insert reaches every mandatory member; delete must
reach every mandatory member) is sound because `lens-multi-source-ind-injection`
proves every logical row exists in each mandatory member. The put builder consumes
that fact (do not re-probe existence per member for mandatory members). For optional
members, presence is data-dependent — the fan-out checks the supplied values, not an
IND.

## Key tests (TDD)

- **Surrogate-key insert reaching all branches with one resolved value.** A
  decomposition with `sharedKey.kind:'surrogate'`, `generator` minting the key →
  insert one logical row; assert **every** member basis relation received a row and
  they share the **same** surrogate value (the evaluate-once-and-thread property).
  Cover both `per-statement` and `per-row` cadences (a multi-row insert with
  `per-row` gives distinct keys per row but consistent keys across members within a
  row).
- **Logical-tuple insert.** `kind:'logical-tuple'` → the logical PK threads to every
  member; no generated surrogate; round-trips via the get join.
- **Columnar split write round-trip.** Insert/update/delete through the logical table
  land in the right members; `select * from L.T` reflects each.
- **Optional-component write.** Insert a row with the optional component null → the
  optional member gets **no** row; later update it to non-null → an insert into the
  optional member appears; update back to all-null → the optional member row is
  deleted (or the documented v1 diagnostic if the transition is restricted).
- **Delete fan-out.** Delete a logical row → every member (mandatory + optional)
  loses its row; the read join returns nothing for that key.
- **Singleton write.** `primary key ()` → insert the singleton (members written,
  empty key), read returns one row; delete returns zero.
- **Mandatory existence trust.** The mandatory-member ops emit without a per-member
  existence probe (consuming the injected IND); a regression assertion that the put
  does not degrade to an O(n) existence scan when the IND is present.
- **Conflict / FK / RETURNING parity.** Reuse the substrate's parity harness — a
  decomposition write composes conflict resolution across member ops, orders FK
  checks, and captures RETURNING, matching hand-written multi-table DML.

## TODO

### Phase A — fan-out shape (consume the substrate)
- In `propagate.ts` (the substrate's visitor, post-3.1/3.2), recognize a logical-table body backed by `slot.advertisement` and emit the member fan-out `BaseOp[]`: anchor-rooted, mandatory always, optional conditioned on supplied values; per-column routing via `buildColumnBackingMap` (the advertisement's `member.columns` logical→basis map).
- Map insert/update/delete to the member-op shapes (incl. the optional-component presence transitions, restricted with a clear diagnostic if the substrate cannot yet compose insert-or-delete within an update fan-out).

### Phase B — surrogate generation + threading
- Implement evaluate-once-and-thread: `per-statement` via the mutation-context evaluate-once seam; `per-row` via the per-row shared-surrogate envelope from `view-mutation-multisource-innerjoin`, published to every member op.
- Map `generator.strategy` to the basis default expression / built-in generator; honor non-determinism policy (reuse nondeterministic-schema-expression handling); ensure change-capture records the resolved value.
- `logical-tuple` key: thread the logical PK to each member, no generation.

### Phase C — soundness + singleton
- Consume the injected IND (`LensSlot.injectedInds` / `computeExistenceAnchorInds`) so mandatory-member ops skip per-member existence probes; assert no O(n) fallback when the IND is present.
- Singleton: unconditional member ops over the empty key; existence anchor lets the all-null singleton exist.

### Phase D — docs + tests
- `docs/lens.md` § "The Default Mapper": flip the `put` fan-out + surrogate threading + singleton write from pending to shipped; document the optional-component write transitions and any v1 restriction.
- `docs/view-updateability.md`: note the decomposition fan-out as the canonical multi-source consumer of the substrate; document the surrogate cadences.
- Tests per "Key tests". Run `yarn workspace @quereus/quereus run build`, `yarn workspace @quereus/quereus test`, `yarn workspace @quereus/quereus run lint` (single-quote globs on Windows) before handoff. Note `yarn test:store` is the store-path regression for write fan-out — run it if time permits, else flag the deferral in the handoff.
