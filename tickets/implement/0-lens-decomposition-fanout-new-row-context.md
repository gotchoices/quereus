description: |
  Extend the `new.<col>` row-context binding (which currently covers only the single-source
  base-table INSERT path) to the **multi-member decomposition INSERT fan-out**, so a decomposition
  member's anchor key-column `default` can correlate on the produced row's other supplied values —
  e.g. a parent-resolving surrogate default `default (select rowId from h0_users_id h0 where h0.value = new.value)`.
  Today such a default throws `QuereusError: new.<col> isn't a column` from the engine's own
  fan-out: `buildDecompositionMemberInsert` → `buildInsertStmt` → `buildNotNullDefaults` →
  `resolveColumn`. The `new.<col>` binding that landed (commit `5545e31b`) reaches a single-source
  base insert but NOT the per-member decomposition inserts a lens logical-view write routes through.
files:
  - packages/quereus/src/planner/building/view-mutation-builder.ts   # buildDecompositionMemberInsert — establish the NEW-row context for each member's default-build scope
  - packages/quereus/src/planner/building/insert.ts                  # buildInsertStmt / buildNotNullDefaults — where the default expression is bound; resolveColumn throws on new.<col>
  - packages/quereus/src/planner/mutation/decomposition.ts           # the decomposition fan-out that produces the per-member inserts (carries the produced row / supplied values)
  - packages/quereus/test/logic/                                     # add a decomposition-insert case whose member default references new.<col>
  - packages/quereus/test/property.spec.ts                           # Family C decomposition fan-out — extend with a new.<col>-defaulted member
  - docs/view-updateability.md                                       # § Mutation Context — note new.<col> reaches the decomposition fan-out, not just single-source

# `new.<col>` row-context in the decomposition INSERT fan-out

## Why

A lens logical-view INSERT lowers to an n-member decomposition fan-out: the engine produces one
logical row, evaluates the anchor key column's `default` once, and EC-threads the surrogate across
every member (the `shared-key-via-column-defaults` model). When that anchor `default` is an
**identity-resolving subquery** that correlates on the inserted row's own supplied columns
(`… where parent.key = new.<fk>`), it needs the produced row's `new.<col>` values in scope at the
point the member insert binds its defaults. Single-source inserts already get this (commit
`5545e31b`); the decomposition fan-out does not, so the default fails to resolve.

## Repro (Quereus-side)

A multi-member lens decomposition where a member's key column carries a default referencing
another supplied column of the produced row, e.g.:

```
member anchor:  h2 ( rowId int primary key
                       default (select rowId from h0 h where h.value = new.value),
                     value int )
```
Inserting through the logical view throws `new.<col> isn't a column` from
`buildDecompositionMemberInsert` → `buildInsertStmt` → `buildNotNullDefaults` → `resolveColumn`
instead of evaluating the default against the produced row's supplied `value`.

## Deliverable

- Thread the produced row's NEW-row context (the same one the single-source path already exposes
  for `new.<col>` and `mutation_ordinal()`) into each member insert's default-build scope in the
  decomposition fan-out, so `new.<col>` resolves to the supplied value of that column on the row
  being produced.
- Scope/ordering: `new.<col>` references only **supplied** (or already-evaluated) columns of the
  produced row — those are known before the anchor key default evaluates. Keep the single-source
  path's behaviour identical.
- Tests: a decomposition-insert case whose member default references `new.<col>` (logic test +
  property Family C), plus the existing single-source `new.<col>` cases stay green.

## Downstream consumer (motivation; cross-repo)

This is the lone remaining gate for the Lamina adapter's parent-fk shared-rowId **identity**
through the lens. Lamina (sibling repo `../lamina`, consumes `@quereus/quereus` via a `portal:`
link to `dist/`) advertises a per-column decomposition whose anchor `default` resolves the parent
row's surrogate from the inserted FK value; until this lands, that default "fires for nobody" and
Lamina's writes ride a legacy physical path. The Lamina-side proof is its
`pk-is-fk-anchor-default-e2e.test.ts` (skipped, pending this); the Lamina-side dependents are
`tickets/blocked/{1-lamina-lens-write-path-adoption, 4-lamina-retire-rowidsource-physical-machinery}.md`.
