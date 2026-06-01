description: The substrate-gated remainder of the decomposition **put** fan-out: INSERT across every member with a shared key that may be a **surrogate** evaluated-once-per-row-and-threaded (rides the `view-mutation-shared-surrogate-insert` envelope), the **logical-tuple** insert (no generation), the optional-component write transitions (null→non-null materializes a member insert; non-null→null deletes it), and the **predicate-honest** multi-member DELETE/UPDATE whose WHERE spans more than the anchor (rides snapshot-consistent multi-member base-op execution). Extends the shipped DELETE/UPDATE fan-out in `planner/mutation/decomposition.ts`. Design source: `docs/lens.md` § The Default Mapper (shared-key surrogate, evaluate-once-and-thread, singleton) and `docs/view-updateability.md` § Mutation Context / § Multi-Base-Table Mutations.
prereq: view-mutation-shared-surrogate-insert
files: packages/quereus/src/planner/mutation/decomposition.ts, packages/quereus/src/planner/mutation/propagate.ts, packages/quereus/src/planner/mutation/mutation-diagnostic.ts, packages/quereus/src/planner/nodes/view-mutation-node.ts, packages/quereus/src/runtime/emit/view-mutation.ts, packages/quereus/src/vtab/mapping-advertisement.ts, packages/quereus/test/lens-put-fanout.spec.ts, docs/lens.md, docs/view-updateability.md
----

## Why this is its own ticket

`lens-multi-source-put-fanout` (now in `review/` / `complete/`) shipped the
**substrate-independent** half of the decomposition put fan-out — DELETE across every
member and UPDATE routed to the mandatory backing member — by routing a decomposition
body off the generic two-table join path to `propagateDecomposition`
(`planner/mutation/decomposition.ts`). It **deferred** every case that rides substrate
which was not present at the time:

1. **INSERT** — needs the per-row / per-statement **shared-surrogate mutation-context
   envelope** (evaluate-once-and-thread): a surrogate is computed **once per produced
   logical row** and the **same** value threaded into every member insert, so all
   branches agree on identity. That envelope is `view-mutation-shared-surrogate-insert`'s
   charter (its mechanism — pre-evaluate at the envelope vs capture-and-thread via
   RETURNING — was undecided when the parent ticket ran). **Hard prereq.**
2. **Predicate-honest multi-member DELETE/UPDATE** — when the WHERE references a
   non-anchor member, each member's identifying set cannot be read from the anchor alone;
   the set must be **captured once before any base op mutates the join**. That is the
   **snapshot-consistent multi-member base-op execution** substrate that `multi-source.ts`
   and `view-mutation-lenient-multiside-delete-fanout` (backlog) also defer onto. If that
   substrate is still absent when this ticket runs, keep the `unsupported-decomposition-predicate`
   diagnostic and split this half off again — do **not** invent the snapshot mechanism here.
3. **Optional/EAV component write transitions on UPDATE** — setting a previously-null
   optional/EAV component to non-null is an **insert** of that member row; setting it back
   to all-null is a **delete**. Both ride the insert path from (1), so they land with it.

The shipped half already raises precise diagnostics for all of the above
(`unsupported-decomposition-insert`, `unsupported-decomposition-predicate`,
`unsupported-decomposition-update`, `unsupported-decomposition-key`); this ticket flips
the ones whose substrate has landed from diagnostic to supported.

## Required behavior

### INSERT fan-out (the headline)

Given a decomposition `slot.advertisement.storage`, an insert through the logical table
emits one insert per member, **anchor first** (FK-order root):

- **Mandatory** members always get an insert. **Optional** members get an insert **only
  when the logical row supplies a value** for ≥1 of that member's columns (an all-null
  optional component is not materialized — the outer-join semantics the read preserves).
  EAV pivot members get one triple insert per supplied EAV-backed column.
- **Shared key threading.** When `sharedKey.kind === 'surrogate'`: evaluate the
  `SharedKeyGenerator` once per logical row (per `cadence`: `per-statement` rides the
  statement-level mutation-context seam; `per-row` rides 3.6's per-row envelope), and
  thread the one captured value into every member insert's key column(s)
  (`keyColumnsByRelation`). Evaluating the basis default independently per member would
  mint a different key per member and shatter the row — this is the load-bearing
  invariant. When `sharedKey.kind === 'logical-tuple'`: thread the logical PK straight
  into each member's key columns; **no generation**.
- **Per-member omitted-column fill** follows the § Projection default chain (value list →
  constant-FD → FD reconstruction → EC propagation → base default → null; `not null` with
  no value → `no-default`). Reuse whatever 3.6 builds for the join-insert default-fill.
- **Singleton** (`primary key ()`): member inserts are unconditional over the empty key;
  the existence anchor lets the all-null singleton exist.
- **Non-determinism**: a `uuid7()` / `nanoid()` generator is permitted where local DML
  policy allows; change-capture records the **resolved** row. Reuse the existing
  nondeterministic-schema-expression policy.

### Predicate-honest multi-member DELETE/UPDATE

When the WHERE spans a non-anchor member, capture the identifying key set once (via the
snapshot substrate) before fan-out, then drive each member op off the captured set. Until
that substrate lands, keep the diagnostic.

## Key tests (TDD)

- **Surrogate insert reaching all branches with one resolved value** — both `per-statement`
  and `per-row` cadences; a multi-row `per-row` insert gives distinct keys per row but a
  consistent key across members within a row. Assert every member received a row and they
  share the same surrogate.
- **Logical-tuple insert** — the logical PK threads to every member, no generated
  surrogate, round-trips via the get join.
- **Optional-component insert** — a row with the optional component null materializes no
  optional member row; later update to non-null inserts it; update back to all-null
  deletes it.
- **Columnar split write round-trip**; **singleton write**; **EAV column insert** (a
  triple per supplied attribute).
- **Predicate-honest delete** filtered on a non-anchor member (once the snapshot substrate
  lands) — flips `unsupported-decomposition-predicate`.
- **Conflict / FK / RETURNING parity** — the decomposition insert composes `on conflict`
  across member ops, orders FK checks anchor-first, and (with RETURNING-through-view)
  captures RETURNING, matching hand-written multi-table DML. Reuse 3.6's parity harness.

## TODO

### Phase A — INSERT fan-out
- Extend `propagateDecomposition` (`decomposition.ts`) with an `insert` arm emitting the
  member insert `BaseOp[]` (anchor-first; optional members conditioned on supplied
  values; EAV triples per supplied column), replacing the `unsupported-decomposition-insert`
  diagnostic. Per-column routing via the advertisement's `member.columns`.
- Thread the shared key: `logical-tuple` straight from the user values; `surrogate` via
  the 3.6 envelope (consume the per-row/per-statement captured value — **thread, don't
  re-invent**). Map `generator.strategy` to the basis default / built-in generator.
- Per-member omitted-column fill via the substrate's default chain; honor non-determinism
  policy; ensure change-capture records the resolved value.

### Phase B — optional/EAV update transitions
- On UPDATE, detect a null→non-null optional/EAV target → member insert; non-null→all-null
  → member delete. Compose within the update fan-out (or document the boundary if the
  substrate's op-composition cannot yet branch insert-or-delete inside an update group).

### Phase C — predicate-honest multi-member writes
- If the snapshot-consistent multi-member execution substrate has landed, capture the
  identifying set once and drive every member op off it; flip
  `unsupported-decomposition-predicate`. Else split this phase off again (do not invent
  the substrate).

### Phase D — docs + tests
- `docs/lens.md` § The Default Mapper and `docs/view-updateability.md`: flip the deferred
  insert / surrogate / predicate-honest rows to shipped; document the cadences and any
  remaining boundary.
- Tests per "Key tests". Run `yarn workspace @quereus/quereus run build`,
  `yarn workspace @quereus/quereus test`, `yarn workspace @quereus/quereus run lint`
  (single-quote globs on Windows). Run `yarn test:store` if time permits, else flag.
