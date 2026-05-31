<!-- resume-note -->
RESUME: A prior agent run on this ticket did not complete.
  Prior run: 2026-05-31T08:27:48.084Z (agent: claude)
  Log file: C:\projects\quereus\tickets\.logs\lens-multi-source-put-fanout.implement.2026-05-31T08-27-48-083Z.log
Read the log to see what was done. Resume where it left off.
If the prior run hit a timeout or repeated error, be cautious not to rush into the same situation.
<!-- /resume-note -->
description: The `put` direction of n-way decomposition — propagate a logical-table mutation (insert / update / delete) as an ordered fan-out across every basis member of the decomposition, with a shared key that may be a surrogate supplied by a basis default and **evaluated once per logical row and threaded** across all branches so members agree on identity, optional members handled per outer-join semantics, and the singleton degenerate case. Rides the view-mutation plan-node substrate (the multi-source put path) and the evaluate-once-and-thread mutation-context cadences. Consumes the existence facts from `lens-multi-source-ind-injection` for put soundness. Design source: `docs/lens.md` § "The Default Mapper" (shared-key surrogate, evaluate-once-and-thread, singleton).
prereq: lens-multi-source-get-synthesis, lens-multi-source-ind-injection, view-mutation-physical-lineage, view-mutation-substrate-orchestrator
files: packages/quereus/src/schema/lens-compiler.ts, packages/quereus/src/vtab/mapping-advertisement.ts, packages/quereus/src/planner/mutation/propagate.ts, packages/quereus/src/planner/nodes/view-mutation-node.ts, packages/quereus/src/runtime/emit/view-mutation.ts, packages/quereus/src/planner/building/insert.ts, packages/quereus/src/planner/building/update.ts, packages/quereus/src/planner/building/delete.ts, docs/lens.md, docs/view-updateability.md
----

<!-- held-note (2026-05-30) -->
> **HELD in implement/ — hard-prereq substrate not yet built. Not started; no code written.**
>
> This ticket's entire fan-out is a consumer of the view-mutation substrate
> (`propagate()` planned-body → `BaseOp[]` visitor, `ViewMutationNode` orchestrator,
> `runtime/emit/view-mutation.ts`). That substrate **does not exist in the codebase yet**
> (verified 2026-05-30):
> - `planner/mutation/propagate.ts` holds only the single-source `classifyViewBody`
>   classifier (it returns `unsupported-join` for >1 base table); there is no
>   `propagate()` visitor, `MutationRequest`, or `BaseOp` type anywhere in `src`.
> - `planner/nodes/view-mutation-node.ts` and `runtime/emit/view-mutation.ts` do **not** exist.
> - The live write path is the Phase-1 AST rewrite (`planner/building/view-mutation.ts`,
>   `rewriteViewInsert/Update/Delete`), which explicitly rejects multi-source fan-out.
>
> The substrate is produced by **`view-mutation-substrate-orchestrator`** (and its prereq
> **`view-mutation-physical-lineage`**), both still unbuilt in `implement/`. The ticket
> forbids re-inventing the sequencer, and building the substrate here would be doing two
> other tickets' entire scope — so this work cannot start until they land.
>
> **Why it was dispatched prematurely:** the `prereq:` header named the stale slug
> `view-mutation-plan-node-substrate`, which matches no ticket file (the substrate was
> decomposed/renamed into the two slugs above), so the runner's automatic cross-stage
> gating did not defer it. The header is now corrected to the real substrate slugs, so
> the runner will defer this ticket until that chain clears (this is the sanctioned
> "prereq still in implement → deferred automatically" path, not a `blocked/` case).
>
> **To resume (once the substrate lands):** delete this note and implement Phases A–D
> below against the substrate's *actual* `BaseOp` / `ViewMutationNode` / `propagate()` API
> (adapt to whatever shape it shipped with, per the ticket's own guidance below).

## Scope

The write half of the decomposition. After `lens-multi-source-get-synthesis`, a
logical table over a columnar/EAV/column-family decomposition **reads** through a
synthesized n-way join but still **rejects** multi-source writes (the v1
single-source view-updateability path cannot sequence more than one base op). This
ticket flips that: a mutation through such a logical table fans out to every member
basis relation as an ordered set of base ops, with the shared key threaded so all
members agree on row identity.

This is fundamentally a consumer of the **view-mutation plan-node substrate**
(`view-mutation-plan-node-substrate`): that ticket retires the Phase-1 AST rewrite
and makes `propagate.ts` + `ViewMutationNode` the single propagation path for all
view mutations, sequencing multiple base ops with conflict composition, FK
ordering, and RETURNING capture. The decomposition put is exactly a multi-source
case of that substrate — this ticket supplies the **advertisement-driven fan-out
shape and the surrogate generation/threading**; the substrate supplies the
orchestration mechanism. (Hard prereq: without the substrate there is no
multi-base-op sequencer to fan out into.)

## Why the substrate is a hard prereq (not a hint)

`docs/view-updateability.md` and the substrate ticket are explicit: the Phase-1
AST rewrite "does not generalize — it drives off `selectAst` and cannot sequence
more than one base op." Multi-source put has no other host. So this ticket designs
*as if* the substrate has landed (per the tess prereq rule) and builds the
decomposition-specific fan-out on top of `ViewMutationNode` / `propagate.ts`. If
the substrate's surface differs at implement time from what is sketched below,
adapt the fan-out to the substrate's actual `BaseOp` / orchestrator API rather than
re-inventing a sequencer.

## Current state (verified, do not re-discover)

- `packages/quereus/src/schema/lens-compiler.ts` — `slot.advertisement`
  (`StorageShape`) carries the fan-out shape: `members[]` (each `presence`,
  `columns[]`/`attributePivot`), `anchorRelationId`, and `sharedKey`
  (`kind:'surrogate'|'logical-tuple'`, `keyColumnsByRelation`, `generator?`).
  `SharedKeyGenerator` carries `strategy:'integer-auto'|'uuid7'|'callback'`,
  `cadence:'per-row'|'per-statement'`, optional `expr`.
- `packages/quereus/src/planner/building/{insert,update,delete}.ts` — view-mediated
  DML resolves the view and (post-substrate) propagates through `propagate.ts`. The
  mutation-context plumbing (`stmt.contextValues` + `tableSchema.mutationContext`,
  `mutationContextValues` map, `contextAttributes`) is the **statement-level
  evaluate-once** seam: a value bound once and reused across the statement
  (`dml-executor.ts` `contextEvaluatorInstructions` evaluates each context value
  once). This is the existing substrate the per-statement surrogate cadence rides.
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
    row. This is the row-scoped analogue of the statement-level seam; if the
    substrate exposes a per-row computed-binding slot, use it; otherwise introduce a
    per-row surrogate evaluator in `ViewMutationNode` that runs before the member ops
    and publishes the value to each.
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
- In `propagate.ts` (the substrate's visitor), recognize a logical-table body backed by `slot.advertisement` and emit the member fan-out `BaseOp[]`: anchor-rooted, mandatory always, optional conditioned on supplied values; per-column routing via `buildColumnBackingMap`.
- Map insert/update/delete to the member-op shapes (incl. the optional-component presence transitions, restricted with a clear diagnostic if the substrate cannot yet compose insert-or-delete within an update fan-out).

### Phase B — surrogate generation + threading
- Implement evaluate-once-and-thread: `per-statement` via the mutation-context evaluate-once seam; `per-row` via a per-row surrogate evaluator in `ViewMutationNode` published to every member op.
- Map `generator.strategy` to the basis default expression / built-in generator; honor non-determinism policy (reuse nondeterministic-schema-expression handling); ensure change-capture records the resolved value.
- `logical-tuple` key: thread the logical PK to each member, no generation.

### Phase C — soundness + singleton
- Consume the injected IND so mandatory-member ops skip per-member existence probes; assert no O(n) fallback when the IND is present.
- Singleton: unconditional member ops over the empty key; existence anchor lets the all-null singleton exist.

### Phase D — docs + tests
- `docs/lens.md` § "The Default Mapper": flip the `put` fan-out + surrogate threading + singleton write from pending to shipped; document the optional-component write transitions and any v1 restriction.
- `docs/view-updateability.md`: note the decomposition fan-out as the canonical multi-source consumer of the substrate; document the surrogate cadences.
- Tests per "Key tests". Run `yarn workspace @quereus/quereus run build`, `yarn workspace @quereus/quereus test`, `yarn workspace @quereus/quereus run lint` (single-quote globs on Windows) before handoff. Note `yarn test:store` is the store-path regression for write fan-out — run it if time permits, else flag the deferral in the handoff.
