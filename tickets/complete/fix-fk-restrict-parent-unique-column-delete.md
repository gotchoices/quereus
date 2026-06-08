description: Backend-agnostic runtime RESTRICT pre-check for parent DELETE/UPDATE landed as defense-in-depth alongside the existing plan-time `NOT EXISTS` check. Closes the gap where a vtab module's subquery evaluation could diverge from a plain row scan.
files:
  packages/quereus/src/runtime/foreign-key-actions.ts
  packages/quereus/src/runtime/emit/dml-executor.ts
  packages/quereus/test/runtime/fk-restrict-runtime.spec.ts
  docs/sql.md
----

## Summary

Parent-side FK RESTRICT enforcement now runs in two layers:

1. **Plan-time** — `buildParentSideFKChecks` synthesizes a `NOT EXISTS` correlated subquery embedded as an `'fk-parent'` `RowConstraintSchema` (primary path, unchanged).
2. **Runtime** — `assertNoRestrictedChildrenForParentMutation` in `src/runtime/foreign-key-actions.ts` runs a direct `select 1 from <child> where <fk> = ? limit 1` against each inbound RESTRICT FK before `vtab.update()`. Wired into `runDelete` / `runUpdate` in `src/runtime/emit/dml-executor.ts`.

The runtime layer exists because some vtab modules evaluate the embedded subquery differently from a plain row scan (predicate-pushdown quirks, isolation-snapshot interactions, custom validators). The two paths together mean any backend exposing the standard `prepare` / `iterate` interface honours RESTRICT.

## Key behaviour

- `pragma foreign_keys = off` → both layers no-op.
- DELETE: throws CONSTRAINT if any child references the parent's old values.
- UPDATE: throws only when at least one referenced parent column actually changed (`sqlValuesEqual` per `parentColIndices[i]`).
- MATCH SIMPLE: any NULL in the old referenced values skips the check (NULL cannot be referenced).
- CASCADE / SET NULL / SET DEFAULT: unaffected (post-`vtab.update()` action walker handles them).
- Self-FKs are NOT excluded — a self-referencing row from a different row correctly trips RESTRICT.

## Files

- `packages/quereus/src/runtime/foreign-key-actions.ts` — new exported `assertNoRestrictedChildrenForParentMutation(db, parentTable, operation, oldRow, newRow?)`.
- `packages/quereus/src/runtime/emit/dml-executor.ts` — calls the pre-check from `runDelete` and `runUpdate` immediately before `vtab.update()`.
- `packages/quereus/test/runtime/fk-restrict-runtime.spec.ts` — 8 cases (DELETE on UNIQUE / DELETE on PK / UPDATE touching referenced col / UPDATE not touching referenced col / pragma off / CASCADE bypass / direct call with referenced parent / direct call with unreferenced parent).
- `docs/sql.md` § FK enforcement semantics — clarified the dual-layer RESTRICT behaviour.

## Validation

- `yarn workspace @quereus/quereus run typecheck` — clean
- `yarn workspace @quereus/quereus run lint` — clean
- `yarn workspace @quereus/quereus test` — 2713 passing, 2 pending, 0 failing
- `yarn workspace @quereus/quereus run test:store` (previously) — 562 passing, 1 pre-existing failure (`10.5.1-partial-indexes.sqllogic`, unrelated to this ticket)

## Usage notes

The runtime check is intentionally redundant with the plan-time check for the memory and store backends; the micro-cost (one prepared `select 1 ... limit 1` per row mutated when ≥1 inbound RESTRICT FK exists) is acceptable for the consistency guarantee. If profiling later flags it, gating behind a pragma or skipping when the plan-time check is known sound is straightforward.

## Downstream residual (not in scope)

`lamina-on-quereus` `41-fk-extended-targets.sqllogic` still fails — root cause is in lamina-relational's `evaluateFks` (`packages/lamina-relational/src/constraint.ts:312-325`) which looks the parent up by primary key instead of by the FK's `refColumns`. A lamina-side fix is needed there; once lamina accepts the child INSERT, this upstream change is sufficient — both layers will trip the subsequent parent DELETE. Track on the lamina side.
