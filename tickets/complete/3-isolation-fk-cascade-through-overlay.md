description: Verified that CASCADE DELETE through the isolation overlay and transition-constraint (`committed.*`) row counts work correctly in store mode; removed `29-constraint-edge-cases.sqllogic` and `43-transition-constraints.sqllogic` from the store-mode exclusion list.
prereq: none
files:
  - packages/quereus/test/logic.spec.ts                                (MEMORY_ONLY_FILES exclusions trimmed)
  - packages/quereus/test/logic/29-constraint-edge-cases.sqllogic      (now exercised in store mode)
  - packages/quereus/test/logic/43-transition-constraints.sqllogic     (now exercised in store mode)
----

## What shipped

The implement stage investigated whether two suspected isolation-layer failures still reproduced in store mode:

- **CASCADE DELETE through overlay** — DELETE on a parent row that exists in the underlying store cascading through the overlay to children residing in either layer. The cascade path routes through `IsolatedTable.update({ operation: 'delete' })`, which writes tombstones into the per-connection overlay; the merge of overlay + underlying then yields the correct post-cascade state.
- **Transition constraints (`committed.*`)** — CHECK constraints and assertions that read `committed.*` to compare current vs. committed state (`(SELECT count(*) FROM t) >= (SELECT count(*) FROM committed.t)`, `coalesce((SELECT … FROM committed.t WHERE …), 0)`).

Both were already fixed by earlier tickets in the queue (notably `isolation-fk-cascade-through-overlay` implement, and the broader committed-state snapshot work). The only change in this slice was removing the two filenames from `MEMORY_ONLY_FILES` in `packages/quereus/test/logic.spec.ts` so store mode now runs them.

## Coverage now exercised in store mode

`29-constraint-edge-cases.sqllogic` — multi-row CASCADE DELETE, three-level CASCADE chain, multi-row SET NULL, multi-assertion identification, deferred CHECK + assertion together, mixed CASCADE/SET NULL on shared parent, savepoint that reintroduces a deferred-constraint violation, multi-statement transaction that fixes a violation before COMMIT, FK SET NULL hitting a NOT NULL CHECK, cross-table assertion (`count(a) = count(b)`).

`43-transition-constraints.sqllogic` — auto-deferred CHECK with `committed.*` subquery, new-row pass-through (no committed counterpart), assertion enforcing cardinality monotonicity, multi-`committed.*` reference in one expression, deletion-detection assertion (`exists in committed but not current`), CHECK + assertion combined.

## Testing

- `yarn test` (memory) — 121 passing, no regressions.
- `yarn test:store` — 2436 passing / 9 pending. Both target files pass; net coverage improved versus prior runs as adjacent tickets also reduced the pending list.
- Targeted run via `--grep "29-constraint-edge-cases.sqllogic|43-transition-constraints.sqllogic"` in store mode: 2 passing.

## Usage note

No engine, runtime, or user-facing change. Downstream consumers see no behavior delta; this purely promotes two `.sqllogic` files into the store-mode regression matrix so future regressions in cascade-through-overlay or `committed.*` merging are caught automatically.
