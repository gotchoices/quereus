---
description: `IsolationModule`'s overlay-level PK / UNIQUE pre-checks now read column-level `defaultConflict` and per-UC `defaultConflict`, honoring `ON CONFLICT REPLACE|IGNORE|FAIL|ROLLBACK` when statements omit an `OR <action>` override. Three-tier resolution (`stmt OR > per-constraint default > ABORT`) now matches the memory vtab. Two upstream gaps surfaced and were spun off as new fix tickets.
files:
  packages/quereus-isolation/src/isolated-table.ts
  packages/quereus-store/test/isolated-store.spec.ts
---

# `IsolationModule` honors column-level `defaultConflict` — completed

## Summary of change

Three sites in `packages/quereus-isolation/src/isolated-table.ts` that
previously short-circuited to `UNIQUE constraint failed` whenever the
statement lacked an `OR <action>` override now read the column-level /
UC-level default:

- **Live overlay row on insert** (`isolated-table.ts:~658`): replaced
  the `!args.onConflict || args.onConflict === ABORT` guard with a
  resolution against `effectiveOR = args.onConflict ?? resolvePkDefaultConflict(schema)`,
  short-circuiting on ABORT/FAIL/ROLLBACK and falling through to
  `overlay.update()` for IGNORE/REPLACE.
- **`checkMergedPKConflict`**: now resolves
  `effective = stmt ?? resolvePkDefaultConflict(schema) ?? ABORT`.
- **`checkMergedUniqueConstraints`**: resolves per-UC,
  `effective = stmt ?? uc.defaultConflict ?? ABORT`.

To keep the wrapped overlay vtab in agreement with the overlay's decision,
`update()` computes `effectiveOR` once at the top and forwards it on every
`overlay.update({...})` call (five sites: insert fall-through, tombstone-to-row
conversion, PK-change update's insert, same-PK update, and no-existing-overlay-row
insert). The wrapped memory vtab's own resolver would arrive at the same answer
(since `createOverlaySchema` spreads column references and `uniqueConstraints`
survive), but forwarding the resolved value makes the contract explicit at the
boundary.

Two module-scope helpers added at the bottom of `isolated-table.ts`:

- `resolvePkDefaultConflict(schema)` — mirrors the same-named helper in
  `packages/quereus/src/vtab/memory/layer/manager.ts:1491`.
- `resolveEffective(stmt, perConstraint)` — `stmt ?? perConstraint ?? ABORT`.

Tests: six new cases under `describe('column-level ON CONFLICT default (defaultConflict)')`
in `packages/quereus-store/test/isolated-store.spec.ts` — PK REPLACE/IGNORE,
UNIQUE REPLACE/IGNORE, statement `OR ABORT` override, and live-overlay-row
same-txn replace.

## Review findings

**Scope of review:** read the full implement-stage diff
(commit `503b3574` — `isolated-table.ts` and `isolated-store.spec.ts`),
audited every call-site that forwards `onConflict` to `overlay.update`,
cross-checked the duplicated `resolvePkDefaultConflict` against the memory-layer
helper, verified schema propagation through `createOverlaySchema`
(spread preserves columns / `uniqueConstraints` / `primaryKeyDefinition`),
and confirmed `defaultConflict` is set by `schema/manager.ts` from AST
`onConflict` for both column-level and table-level UNIQUE / CHECK forms.

### Architecture / correctness

- **Three-tier resolution matches reference.** The new helpers mirror
  `vtab/memory/layer/manager.ts:1491` exactly (function declarations,
  hoisted — no TDZ for the in-class call sites).
- **Boundary forwarding is sound.** All five non-delete `overlay.update`
  call sites get `effectiveOR` (or the `argsForOverlay` spread that carries
  it). The two delete-path sites still pass raw `args.onConflict` —
  intentional, since deletes don't pre-check uniqueness.
- **UC handler uses per-UC default, not PK-level.** Correct: each UC can
  declare its own `defaultConflict`. By the time the code reaches
  `overlay.update`, UC IGNORE/REPLACE have already short-circuited
  (status:'ok' or tombstone-then-insert), so the wrapped vtab never sees
  an unresolved UC conflict — the PK-level `effectiveOR` forwarded onward
  is the right value.
- **No regression on default-less tables.** `resolveEffective(undefined, undefined) === ABORT`,
  preserving the pre-change behavior in the existing `cross-layer UNIQUE / PK conflict detection`
  group (which still passes — 250/250 in `@quereus/store`).

### DRY / maintainability

- **Minor: recomputed PK default.** The implement-stage code recomputed
  `resolvePkDefaultConflict(this.tableSchema!)` inside the live-overlay-row
  branch even though `effectiveOR` (already computed at the top of `update()`)
  encodes the same answer. Fixed inline: replaced the redundant
  `resolveEffective(args.onConflict, resolvePkDefaultConflict(this.tableSchema!))`
  with `effectiveOR ?? ConflictResolution.ABORT`.
- **Helper duplicated across packages.** `resolvePkDefaultConflict` lives
  in both `isolated-table.ts` and `vtab/memory/layer/manager.ts`. Not a
  defect — moving it to the public API surface for one line is overkill,
  and the handoff documents the intentional copy. Leave as-is.

### Error handling / type safety

- `this.tableSchema!` non-null assertions are consistent with the existing
  pattern in this file (lines 420, 601, 801, 930, 1013). `update()` always
  calls `ensureOverlay()` first, which either throws on missing schema or
  sets `this.tableSchema = schema` (line 127). No new risk.

### Tests

- **Coverage of new behavior:** good — PK + UNIQUE × REPLACE + IGNORE,
  plus statement-OR override and live-overlay-same-txn cases.
- **Coverage gap (minor, not filed):** column-level FAIL and ROLLBACK
  share the same branch as ABORT (`isolated-table.ts:659–661`). Not
  directly tested, but the branch is symmetric and exercised by the
  ABORT cases. Acceptable.
- **Coverage gap acknowledged in code:** an UPDATE-path test was drafted
  and removed with an explanatory comment, since the upstream
  `dml-executor.ts:499` coercion blocks it. See follow-up ticket.
- **No regressions:** `@quereus/store` 250/250, `@quereus/isolation` 64/64,
  `@quereus/quereus` 2940/2940 + 2 pending. Lint clean. Typecheck clean.
  (The 2 pre-existing `@quereus/sample-plugins` failures noted in the
  handoff are present on `main` and unrelated.)

### Docs

- No engine-internals docs (e.g., `docs/architecture.md`, `docs/runtime.md`)
  mention `defaultConflict` resolution today — the three-tier rule was
  added by `1-fix-or-conflict-clause-semantics` without doc updates, and
  this ticket extends the same rule. Not adding doc here either; if
  conflict resolution warrants its own section, that's a separate concern.
- Comments at the new sites adequately explain the three-tier rule and
  the rationale for forwarding `effectiveOR` to the wrapped vtab.

### Major findings — spun off as new tickets

Both are pre-existing upstream gaps surfaced (but not caused) by this work:

1. **`fix/dml-executor-update-path-default-conflict`** —
   `dml-executor.ts:499` coerces `plan.onConflict ?? ABORT` on the UPDATE path,
   so column-level `ON CONFLICT REPLACE` etc. is **not** honored end-to-end
   for plain UPDATEs (it works for plain INSERTs because line 369 keeps
   `undefined`). The isolation overlay is already prepared for the fix.
2. **`fix/table-level-pk-on-conflict-propagation`** —
   `find­ConstraintPKDefinition` in `schema/table.ts:483` doesn't propagate
   a `TableConstraint`-level `PRIMARY KEY (...) ON CONFLICT <action>` onto the
   participating columns' `defaultConflict`, and `resolvePkDefaultConflict`
   only inspects columns. So table-level PK ON CONFLICT silently degrades
   to ABORT.

### Flush-time `onConflict` — flagged for awareness, not filed

`flushOverlayToUnderlying` (`isolated-table.ts:1078+`) calls
`underlyingTable.update({...preCoerced: true})` without passing `onConflict`.
By flush time, the overlay's pre-check has resolved all conflicts (REPLACE
evictions are tombstoned, IGNORE never reaches flush), so the underlying
never sees a conflict. If a future change introduces a code path where it
could, lack of `onConflict` would surface as ABORT. Not exercised today.

## How to validate

```
yarn workspace @quereus/store run test
yarn workspace @quereus/isolation run test
yarn workspace @quereus/quereus run test
yarn workspace @quereus/quereus run lint
```

All pass.

External acceptance signal (out of this repo): the lamina conformance suite's
`29.1-column-level-on-conflict.sqllogic` cases 1–5 exercise the same INSERT-side
semantics through `createSqllogicFixture`, which wraps `LaminaModule` in
`IsolationModule`.
