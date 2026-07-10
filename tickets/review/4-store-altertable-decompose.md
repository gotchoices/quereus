description: A 565-line method that handled every kind of ALTER TABLE in the persistent store was split into small single-purpose helpers; no behavior was meant to change, and the reviewer should confirm that.
prereq:
files:
  - packages/quereus-store/src/common/store-module.ts   # alterTable dispatcher (~1248) + extracted alter* helpers (~1282–2055); AlterColumnAttrChange type (~172)
  - packages/quereus-store/test/alter-table-conformance.spec.ts   # the per-arm honored/reject regression matrix (read-only; primary net)
  - packages/quereus-store/test/mv-store-backing.spec.ts          # pins the alterColumn setDataType arm (read-only)
difficulty: medium
----

# Review: decompose the 565-line store `alterTable`

Behavior-preserving refactor. The one ~565-line `StoreModule.alterTable` — a
`switch (change.type)` with eight arms — is now a thin dispatcher plus one
private method per arm, and the largest arm (`alterColumn`) is further split into
per-attribute sub-helpers. **No SQL-visible behavior, error message, event, or
persistence side effect was intended to change.** The reviewer's job is to confirm
that claim.

## What changed (shape)

`alterTable` keeps its shared preamble (`ensureSchemaSubscription`,
`getOrReconnectTable`, not-found throw, `oldSchema`, `defaultNotNull`) and then
`switch`es to one extracted method per change type, each returning `TableSchema`:

| change type       | extracted method            |
|-------------------|-----------------------------|
| `addColumn`       | `alterAddColumn`            |
| `dropColumn`      | `alterDropColumn`           |
| `renameColumn`    | `alterRenameColumn`         |
| `alterPrimaryKey` | `alterPrimaryKeyChange`     |
| `addConstraint`   | `alterAddConstraint`        |
| `dropConstraint`  | `alterDropConstraint`       |
| `renameConstraint`| `alterRenameConstraint`     |
| `alterColumn`     | `alterColumnChange`         |

`alterColumnChange` picks the one changed attribute via three sub-helpers plus one
inline case, each returning `{ newCol, collationChanged }` or `null`:

- `alterColumnSetNotNull` (async) — SET/DROP NOT NULL; `null` = already in desired state
- `alterColumnSetDataType` (async) — SET DATA TYPE
- `setDefault` — kept inline (one-liner) in the dispatcher
- `alterColumnSetCollation` (sync) — SET COLLATE; `null` = already explicit in desired collation

A `null` result maps to the pre-refactor `return oldSchema` no-op (the two
early-exit short-circuits). The shared post-attribute work (build `updatedColumns`
/ `updatedIndexes` / `updatedSchema`, the non-PK UNIQUE re-validation, the PK
physical re-key, `updateSchema` + `saveTableDDL` + `emitSchemaChange`) stays in
`alterColumnChange` unchanged.

New module-private type `AlterColumnAttrChange { newCol: ColumnSchema;
collationChanged: boolean }` (just above the class) carries the sub-helper result.

### Module-extraction decision

Kept the helpers as **private methods on `StoreModule`**, not a separate
`common/alter-table.ts`. Every arm calls private collaborators
(`this.ddlCommitPendingOps`, `this.rebuildSecondaryIndexes`,
`this.validateUniqueOverExistingRows`, `this.saveTableDDL`, `this.eventEmitter`);
a module split would have to thread all of that private state out, which is the
"entangle private state" case the plan ticket said to avoid. This is the plan's
sanctioned alternative, not a shortcut.

## How the extraction was done (why it's low-risk)

The eight arm bodies and the three sub-branch comment-heavy middles were
**relocated programmatically** (a throwaway Node splice: extract by anchor, dedent
by tabs, re-wrap), so the load-bearing comments and statements are byte-identical
to the originals — no hand-retyping. Only the thin structural glue (method
signatures, the dispatcher `switch`, the sub-helper `return` wrappers) was
authored by hand.

**The only intentional content changes**, and all of them, are:
- 8× `case 'X': { … }` → `case 'X': return this.alterX(…);`
- `let newCol`/`let collationChanged` locals folded into sub-helper returns + the
  dispatcher's `const { newCol, collationChanged } = attr;`
- `return oldSchema` → `return null` in `alterColumnSetNotNull` and
  `alterColumnSetCollation` (the two no-op early exits; the dispatcher turns `null`
  back into `return oldSchema`)
- `inferType(change.setDataType)` → `inferType(change.setDataType!)` and
  `validateCollationForType(change.setCollation, …)` → `…setCollation!, …` (the
  dispatcher already narrowed these to defined; the sub-helper sees the wide
  `string | undefined`, so a non-null assertion restores the original runtime
  behavior)
- `newCol = { … }` assignments folded into the sub-helpers' `return { newCol: { … } }`

A normalized (whitespace-stripped) line diff of the whole region confirmed exactly
these and nothing else: 21 "removed" lines, every one accounted for by the list
above; the big invariant-explaining comment blocks do **not** appear in the removed
set (i.e. preserved intact).

## What to scrutinize

The refactor is mechanical, but these are where a behavior drift would hide —
diff each against its pre-refactor form:

- **The four `alterColumn` attribute branches.** Confirm the `null`→`return
  oldSchema` sentinel exactly reproduces the two original early exits, and that no
  attribute path lost its `newCol`/`collationChanged` value. In particular
  `alterColumnSetNotNull` now uses `let newCol: ColumnSchema;` (uninitialized) with
  a definite-assignment guarantee via the `else { return null }`; verify all three
  paths still yield the right column or the no-op.
- **The two `!` non-null assertions.** They are safe only because the dispatcher
  gates each sub-helper behind `change.setDataType !== undefined` /
  `change.setCollation !== undefined`. Confirm no other caller reaches them.
- **Ordering invariants** (the plan called these load-bearing, and every
  explaining comment was kept): throw-only validation before
  `ddlCommitPendingOps()` before any physical rewrite (`migrateRows` /
  `mapRowsAtIndex` / `rekeyRows` / `rebuildSecondaryIndexes`); non-PK UNIQUE
  re-validation before the PK re-key in `alterColumnChange`; the `renameColumn`
  in-place predicate/CHECK AST rewrite inside its `try`/reverse-on-throw `catch`.
- **`rows` (wrapper-supplied `EffectiveRowSource`) threading.** It reaches
  `alterAddConstraint` and `alterColumnChange` unchanged; the per-constraint
  `rows()` re-invocation (single-shot async generator) is intact in the UNIQUE
  re-validation loop.

## Validation performed

All green on this branch:

- `yarn workspace @quereus/store run typecheck` (tsc --noEmit) — clean. Note the
  store package's `noUnusedLocals`/`noUnusedParameters`/`noImplicitReturns` are on,
  so the signatures carry only used params and the dispatcher `switch` stays
  exhaustive.
- `yarn workspace @quereus/store run test` — **910 passing** (includes
  `alter-table-conformance.spec.ts`, which honored/reject-checks every arm and
  sub-branch: ADD/DROP/RENAME COLUMN, ALTER PRIMARY KEY, ADD/DROP/RENAME
  CONSTRAINT, SET NOT NULL both directions + existing-NULL reject, SET DATA TYPE
  lossy reject, SET DEFAULT, SET COLLATE non-PK / PK re-key / third-collation /
  collision reject / no-op).
- `yarn test:store` (LevelDB store-path logic tests — the plan's named primary
  net) — **6891 passing, 18 pending**.
- `yarn lint` — exit 0 (store package has no real lint; `packages/quereus`'s
  eslint+tsc pass is unaffected — no files there changed).
- `yarn test` (all workspaces) — passing (~3m31s).

## Known gaps / notes for the reviewer

- **Tests are unchanged** — this is a pure refactor, so the existing suites are the
  regression net, not new tests. `alter-table-conformance.spec.ts` is dense and
  directly exercises the store `alterTable`, so it is a strong floor; but it is a
  *behavior* floor, and it does not assert comment/structure. The normalized-line
  diff above is the evidence that comments/statements were not silently dropped —
  a reviewer who wants belt-and-suspenders can re-run that diff against
  `main`'s `store-module.ts`.
- **No tripwires filed.** The one pre-existing `NOTE:` in the code (the
  `rekeyRows` PK-dedupe-vs-wrapper-`rows` gap, in the SET COLLATE PK-member block)
  was relocated verbatim, not introduced here.
- **Interaction with `store-stream-large-rewrites` (plan).** `rekeyRows` /
  `mapRowsAtIndex` / `buildIndexEntries` are still called as ordinary method calls
  from the arms, so that later streaming work can change the callees without
  re-touching these arms — as the plan intended.
- The `alterTable` doc comment was refreshed to describe the dispatcher (it
  previously said only "ADD/DROP/RENAME COLUMN", already stale before this change).

## End
