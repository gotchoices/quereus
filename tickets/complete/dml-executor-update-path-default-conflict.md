---
description: UPDATE path in `dml-executor.ts` no longer coerces `plan.onConflict` to ABORT — column-level PK `defaultConflict` directives (REPLACE/IGNORE) are now honored on plain UPDATE end-to-end through the memory module. Memory module's `performUpdateWithPrimaryKeyChange` gained the missing `REPLACE` branch.
files:
  packages/quereus/src/runtime/emit/dml-executor.ts
  packages/quereus/src/vtab/memory/layer/manager.ts
  packages/quereus/test/logic/29.1-column-level-conflict-clause.sqllogic
  packages/quereus-store/test/isolated-store.spec.ts
---

## Summary

Two coupled changes landed at commit `b634c77b` (fix) and `b8dc6d36`
(implement handoff):

1. **`packages/quereus/src/runtime/emit/dml-executor.ts` UPDATE path
   (~line 495–504).** Removed `?? ConflictResolution.ABORT` coercion;
   `plan.onConflict` is now forwarded raw. `undefined` means "no
   statement-level OR clause" and lets the vtab consult its
   per-constraint `defaultConflict` directive. INSERT path was already
   doing this; UPDATE path now matches.

2. **`packages/quereus/src/vtab/memory/layer/manager.ts`
   `performUpdateWithPrimaryKeyChange` (~line 639–683).** Added the
   sibling `REPLACE` branch (IGNORE was already there): records a delete
   for the row at the new PK, records a delete for the old PK, records
   an upsert at the new PK, returns
   `{ status: 'ok', row: newRowData, replacedRow: existingRowAtNewKey }`.

Tests cover happy-path behavior:

- `packages/quereus/test/logic/29.1-column-level-conflict-clause.sqllogic`
  sections 7–8 cover UPDATE with PK declared `ON CONFLICT REPLACE` and
  `ON CONFLICT IGNORE` against the in-memory vtab.
- `packages/quereus-store/test/isolated-store.spec.ts` covers the same
  behavior against the isolated-store module (which wraps the store path
  with an overlay that resolves column-level defaults itself).

`docs/sql.md` already promised this contract at line 433 (precedence:
statement OR > per-constraint default > ABORT) and line 437 (`UPDATE OR
<action>` deliberately not supported — use the schema-level
`ON CONFLICT`). The fix brings the engine into compliance with the doc;
no doc edits required.

## Review findings

### SPP / DRY / modular / scalable / maintainable / performant
- **OK.** The REPLACE branch in `performUpdateWithPrimaryKeyChange`
  follows the same three-line shape as the IGNORE branch above it and
  the matching INSERT-path REPLACE branch in `performInsert` (line
  564–569). No new abstraction warranted.
- **OK.** Removing the `?? ABORT` coercion in the UPDATE-path executor
  brings it to parity with the INSERT-path emitter (`emitInsertOne` at
  line 365 already forwards `plan.onConflict` raw). One-shot change, no
  ripple.

### Resource cleanup / error handling / type safety
- **OK.** `UpdateResult.replacedRow` is part of the established type
  (`packages/quereus/src/common/types.ts:176`); no new type surface.
- **OK.** No new exception paths; constraint paths still flow through
  `isConstraintViolation` + `translateConflictError`.

### Behavior on the ticket's acceptance scenarios
- **Plain UPDATE with column-level PK REPLACE, new key colliding** —
  silently replaces the existing row at the new PK. Covered by
  29.1 § 7 and isolated-store spec. **Verified by passing tests.**
- **Plain UPDATE with column-level PK IGNORE, new key colliding** —
  silent no-op; both rows untouched at their original PKs. Covered by
  29.1 § 8 and isolated-store spec. **Verified by passing tests.**
- **Plain UPDATE with no collision** — unchanged. **Verified by full
  regression suite passing (2940 passing, 2 pending).**
- **Plain UPDATE with no column-level directive** — `undefined`
  propagates to the memory module which falls back to `ABORT` (line
  651: `onConflict ?? resolvePkDefaultConflict(schema) ?? ABORT`).
  Behavior unchanged from pre-fix. **Verified by full regression
  suite.**
- **Statement-level `OR <action>` on INSERT** — untouched code path,
  still honored.
- **`UPDATE OR <action>`** — deliberately not supported, pinned by
  parser test at `42.1-returning-extras.sqllogic` § 7 and explicitly
  called out in `docs/sql.md` line 437. Acceptable scope reduction.

### Lint + tests run
- `npx eslint 'src/**/*.ts' 'test/**/*.ts'` — clean (exit 0, 0 issues).
- `node packages/quereus/test-runner.mjs` — **2940 passing, 2 pending**
  (60s).
- `yarn workspace @quereus/quereus-store test` — **252 passing** (228ms).
- `yarn test:store` (logic suite against LevelDB store) was **not** run.
  The pure store-mode column-level-default-conflict path has a
  separate gap; see follow-up
  [`store-table-update-column-default-conflict`](../fix/store-table-update-column-default-conflict.md).

### Issues found / disposition

**Major — filed as follow-up tickets, not fixed inline:**

1. **`replacedRow` not consumed on UPDATE path** —
   `packages/quereus/src/runtime/emit/dml-executor.ts` UPDATE path
   (line 506–545) reads `result.row` but never `result.replacedRow`.
   When the new REPLACE branch evicts a row at the new PK, the
   eviction is invisible to `_recordUpdate`/`_recordDelete` (change
   tracking), `executeForeignKeyActions` (FK cascades from the evicted
   row's PK), and `emitAutoDataEvent` (auto-event subscribers for
   modules without native event support). The INSERT path (line
   423–437) handles `replacedRow` correctly; UPDATE path needs
   equivalent treatment plus the moved-row accounting. Filed as
   [`dml-executor-update-replaced-row-not-recorded`](../fix/dml-executor-update-replaced-row-not-recorded.md).
   *Predates this work — no UPDATE path ever consumed `replacedRow` —
   but the new REPLACE-on-UPDATE branch is the first realistic user
   that can reach it.*

2. **Pure store-mode doesn't consult column-level defaults on UPDATE**
   — `packages/quereus-store/src/common/store-table.ts` UPDATE path
   (line 683–701) uses strict-equal on `args.onConflict` and ignores
   per-constraint defaults, so `yarn test:store` would not exhibit the
   new behavior. Through the isolation layer the pre-check resolves
   defaults itself (`packages/quereus-isolation/src/isolated-table.ts`
   `resolvePkDefaultConflict`), which is why isolated-store tests pass.
   Filed as
   [`store-table-update-column-default-conflict`](../fix/store-table-update-column-default-conflict.md).
   *Surfaced when the implementer noted store-mode wasn't exercised.*

**Minor — none requiring inline fix.**

**No-finding (checked, explicitly):**

- **UNIQUE-constraint ordering vs REPLACE.** The REPLACE branch fires
  before `checkUniqueConstraints` at the new PK position (line 674),
  matching the IGNORE branch's ordering. Implementer flagged as worth
  a second look. Confirmed acceptable: REPLACE eviction makes the new
  PK exclusively this row's, and any *other* UNIQUE column on the
  moved row that violates a separate index would have been caught on
  INSERT of the source row in the first place. The non-collision arm
  (line 671–681) does run `checkUniqueConstraints` for the moving row
  before committing the upsert, so non-PK UNIQUE drift is still
  detected on UPDATE — the REPLACE branch's deferred check applies
  only to the *evicted* row, which is about to be deleted anyway.
- **DELETE-path coercion left in place.** Intentional; DELETE carries
  no incoming row that could trigger a column-level constraint. No
  observable behavior depends on the executor passing raw
  `plan.onConflict` to DELETE.
- **Docs.** `docs/sql.md` § DML already promised the precedence rule
  (line 433) and the `UPDATE OR <action>` exclusion (line 437). Engine
  now matches doc; no edits needed.
- **Empty categories.** Resource cleanup: no new resources allocated.
  Performance: no new hot paths; the new REPLACE branch is the same
  three-call shape as IGNORE. Type safety: `UpdateResult.replacedRow`
  is pre-existing.

### Scope reduction acknowledged
The implementer dropped the original ticket's `UPDATE OR ABORT`
acceptance case because the parser rejects `UPDATE OR <action>` and an
existing test (`42.1-returning-extras.sqllogic` § 7) pins that.
Reviewer accepts; `docs/sql.md` line 437 explicitly documents the
exclusion.
