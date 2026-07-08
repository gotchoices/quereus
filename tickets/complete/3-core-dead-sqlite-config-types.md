description: Removed two unused, misleading SQLite-era config type declarations (write-ahead-log/journal/page-size knobs Quereus never implemented) from the shared public types file.
files:
  - packages/quereus/src/common/types.ts
----

## What changed

Deleted `DatabaseInfo` and `DatabaseConfig` interfaces from
`packages/quereus/src/common/types.ts` (previously ~lines 111–176). Both dead:
zero references anywhere in the monorepo. They described SQLite features
Quereus does not implement (WAL, journal mode, page size, synchronous pragma)
and were never imported, constructed, or re-exported through `src/index.ts`'s
public barrel.

## Review findings

Adversarial pass over the implement diff (commit `2f7fced2`). Verified every
claim in the handoff independently before trusting it.

**Reference check (confirmed clean).** Ran `git grep` and the project
`find_references` index for `DatabaseInfo`/`DatabaseConfig` across the whole
monorepo. Zero real references. Only substring hits are in
`packages/quereus-plugin-indexeddb/src/manager.ts` — the private method
`getExistingDatabaseInfo()` and its local `existingInfo` variable, whose
return shape is an *anonymous* `{ version, objectStores }` (no declared type
named `DatabaseInfo`). Wholly unrelated, correctly left untouched. Note: the
implement handoff called it a "local inline type named `DatabaseInfo`" — there
is no such named type; it's a method/var name substring collision. Harmless
prose inaccuracy, no code impact.

**Deletion site (confirmed clean).** `types.ts` around the cut reads
`CompareFn` → blank → `RowOp` → `ConstraintType`. No dangling comment,
orphaned brace, or broken export. Barrel `src/index.ts` never re-exported
these types, so no barrel edit was needed (confirmed).

**Docs (checked, no change needed).** Only doc hit is `docs/review.html:144`,
the static point-in-time review report ("Quereus Code & Design Review — July
2026", commit `ffcd8cf5`) that *spawned* this ticket — it lists the finding as
a recommendation. It is a historical artifact, not a user-facing API doc, and
is not misleading. No source doc (`docs/types.md`, README, etc.) mentioned the
deleted types. Left as-is.

**Correctness / SPP / DRY / type-safety / resource cleanup / error handling.**
N/A — pure type deletion, no runtime surface, no behavioral path added or
removed.

**Tests.** No new test added, correctly — deleting unexported dead types has
nothing to exercise. Existing suite is the regression guard: a lingering
reference would fail the build/lint.

Disposition: no minor fixes needed, no major tickets filed, no tripwires. All
handoff claims verified true (bar the cosmetic indexeddb-naming note above).

## Validation performed

- `yarn workspace @quereus/quereus run lint` (eslint + `tsc -p tsconfig.test.json --noEmit`) — clean, exit 0.
- `yarn workspace @quereus/quereus run test` — **6472 passing, 9 pending**, exit 0. (Implement handoff's "429 passing" undercounted; actual full-suite count is 6472.)
