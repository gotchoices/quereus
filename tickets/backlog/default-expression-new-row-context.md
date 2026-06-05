description: |
  Expose the in-flight NEW row's column values to default-expression evaluation, so a
  column `default` can reference `new.<col>` (the other supplied values of the row being
  produced). Today the per-row mutation context plumbs through only the ordinal
  (`mutation_ordinal()` reads `rctx.mutationOrdinal`), but the envelope ALREADY
  materialises the NEW/OLD rows (`runtime/emit/view-mutation.ts:48` — "surfaces that one's
  rows (NEW for insert/update, OLD for delete)"). So the row context exists; this ticket
  surfaces it to default / mutation-context evaluation. Bounded extension of the
  `shared-key-via-column-defaults` machinery, not a new subsystem.
files:
  - packages/quereus/src/runtime/types.ts                 # RuntimeContext (carries mutationOrdinal today; add the NEW-row accessor)
  - packages/quereus/src/runtime/emit/view-mutation.ts    # per-row envelope scope where mutationOrdinal is set; NEW row already materialised here
  - packages/quereus/src/runtime/emit/envelope-scan.ts    # the materialised augmented source the NEW row reads from
  - packages/quereus/src/func/builtins/mutation.ts        # mutation_ordinal precedent (custom emitter reading rctx) — model the new.<col> resolution the same way
  - packages/quereus/src/planner/building/insert.ts        # default-expression binding/scoping during INSERT
  - docs/view-updateability.md                            # § Mutation Context — document new.<col> in default scope
  - docs/lens.md                                          # default-sourced shared key (cross-link)

# Surface `new.<col>` row context to default-expression evaluation

## Why

A downstream lens module (Lamina, `../lamina`) wants to express an **identity-resolving
column default** on a basis relation — for a 1:1 PK-is-FK extension table, the surrogate key
column's default resolves the *parent's* surrogate rather than minting a fresh one:

```sql
-- basis relation for an extension table; rowId adopts the parent's:
h2_uprof_user_id ( rowId int primary key
                     default (select rowId from h0_users_id h0 where h0.value = new.value),
                   value int )
```

This is the natural generalisation of `shared-key-via-column-defaults`: the surrogate still
comes from the anchor column's `default`, evaluated once per produced row and EC-threaded —
the only new capability is that the default expression can read the **other supplied values
of the same row** (`new.value` here) to do the resolution. Without `new.` context, a default
can compute a fresh id (`max()+mutation_ordinal()`) but cannot resolve an *existing* row's
key from the inbound values.

## Deliverable

- Make the in-flight NEW row's column values resolvable from within default /
  mutation-context expression evaluation, spelled `new.<col>` (confirm the exact spelling;
  `NEW.` SQL convention). The envelope already holds the row (`view-mutation.ts:48`); thread
  it onto `RuntimeContext` alongside `mutationOrdinal` and resolve column refs against it,
  the same shape as `mutation_ordinal()`'s custom emitter.
- Scope/ordering: `new.<col>` must reference only *supplied* (or already-defaulted) columns,
  so the referenced value is available before this default evaluates. Define behaviour for a
  forward reference to a not-yet-evaluated default (error, or a declared evaluation order).
- Valid only during default / mutation-context evaluation; error elsewhere (mirror
  `mutation_ordinal()`).
- Determinism: a default that reads `new.<col>` + a basis subquery is deterministic *given
  install state* (it resolves an existing row); it does not introduce nondeterminism beyond
  what the basis read already implies. Confirm it sits under the existing default-eval
  determinism story, no new gate.

## Notes
- Pure additive grammar/runtime extension; no change to existing defaults that don't use
  `new.`.
- Cross-repo: the Lamina consumer is `lamina-parent-fk-identity-via-basis-default`
  (`../lamina/tickets/plan/`). It gates its implement children on this landing + a Quereus
  rebuild (Lamina consumes Quereus via a `portal:` link).
