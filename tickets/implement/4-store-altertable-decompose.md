description: Breaks up an oversized 565-line method that handles every kind of ALTER TABLE in the persistent store into small, single-purpose helpers, without changing any behavior.
prereq: store-codec-lifecycle-cleanups
files:
  - packages/quereus-store/src/common/store-module.ts   # alterTable (~1233-1911) inside a 2,689-line file
difficulty: medium
----

# Store: decompose the 565-line `alterTable`

`StoreModule.alterTable` (`store-module.ts`, starts ~1233, ends ~1911) is a
~565-line method inside a ~2,689-line file. It is one big `switch (change.type)`
with arms for `addColumn`, `dropColumn`, `renameColumn`, `alterColumn`
(which itself branches on `setNotNull` / `setDataType` / `setDefault` /
`setCollation`, including the physical PK re-key path), and the ALTER PRIMARY KEY
arm. AGENTS.md calls for "small single-purpose funcs/methods; decomposed
sub-functions over grouped sections" — this method is the opposite.

**This is a behavior-preserving refactor.** No SQL-visible behavior, error
message, event, or persistence side effect may change. The existing store test
suite is the regression net.

## Approach

Extract each `switch` arm (and the `alterColumn` sub-branches) into a small
private helper with a focused signature, e.g.:

- `alterAddColumn(db, table, oldSchema, change, …): Promise<TableSchema>`
- `alterDropColumn(...)`
- `alterRenameColumn(...)`
- `alterColumnSetNotNull(...)` / `SetDataType` / `SetDefault` / `SetCollation`
- `alterPrimaryKey(...)`

`alterTable` itself becomes a thin dispatcher: resolve the table, capture
`oldSchema`, `switch` to the right helper, return its `TableSchema`. Keep the
shared preamble (`ensureSchemaSubscription`, `getOrReconnectTable`, the
not-found throw, `defaultNotNull`) in the dispatcher.

If the arms plus their private collaborators (`rebuildSecondaryIndexes`,
`validateUniqueOverExistingRows`, `ddlCommitPendingOps`, the DDL-persist /
schema-change-event tail that several arms repeat) form a cohesive cluster,
consider extracting the whole ALTER machinery into its own module
(e.g. `common/alter-table.ts`) exported back to `StoreModule`, per the "decomposed
sub-functions over grouped sections" guidance — but only if it stays a pure move
with no behavior change. If a clean module extraction would balloon the diff or
entangle private state, prefer keeping the helpers as private methods on
`StoreModule` and note the deferral. Either outcome is acceptable; do not force
the module split.

**Preserve the ordering-sensitive invariants** — several are load-bearing and
called out inline today; keep every comment that explains *why* an operation
runs where it does:
- throw-only validation passes (NULL probe, type-convert probe, UNIQUE
  re-validation, PK-collision detection) run **before** `ddlCommitPendingOps()`
  and any store mutation, so a rejected ALTER leaves the transaction intact;
- `ddlCommitPendingOps()` runs **before** any physical rewrite
  (`mapRowsAtIndex`, `rekeyRows`, `rebuildSecondaryIndexes`);
- catalog DDL rewrites and expression-qualifier rewrites happen in their current
  order relative to `propagateTableRename` and the schema re-registration.

## Edge cases & interactions

- **No behavior drift.** Every arm's error `StatusCode` and message text, every
  `emitSchemaChange` payload, and every `saveTableDDL` call must be byte-for-byte
  equivalent after the move. Diff-review each arm against its pre-refactor form.
- **Early returns.** Some arms `return oldSchema` early (already-in-desired-state
  short-circuits, e.g. `setNotNull` no-op, `setCollation` name-matches-explicit).
  Extracted helpers must return `TableSchema` and preserve those early exits —
  don't collapse them into a fall-through.
- **Shared mutable preamble.** `oldSchema`, `defaultNotNull`, `table`, and the
  optional `rows?: EffectiveRowSource` are read by multiple arms. Thread them as
  parameters; don't reach back into re-fetched state inside a helper (a second
  `getOrReconnectTable` could return a different instance).
- **`rows` (wrapper-supplied `EffectiveRowSource`).** The isolation layer passes
  it for UNIQUE/PK validation over staged rows. Every arm that consults `rows`
  today (`setCollation` UNIQUE re-validate, PK re-key notes) must keep receiving
  it. An async generator is single-shot — preserve the `rows()` re-invocation per
  constraint.
- **Merge ordering with the prereq ticket.** `store-codec-lifecycle-cleanups`
  edits `renameTable` in the same file; this ticket is chained after it to keep
  the `store-module.ts` edits serialized. `renameTable` is *not* part of
  `alterTable` — do not fold it in.
- **Interaction with the later streaming ticket.** `store-stream-large-rewrites`
  (plan) will touch `rekeyRows` / `mapRowsAtIndex` / `buildIndexEntries`, which
  the `alterColumn`/PK arms call. Keep those call sites as ordinary method calls
  so the streaming work can change the callee without re-touching the arms.

## TODO

- [ ] Extract each `switch` arm (and `alterColumn` sub-branches) into a focused
      private helper; reduce `alterTable` to a dispatcher.
- [ ] Decide module-extraction vs private-methods; if extracting to
      `common/alter-table.ts`, keep it a pure move. Document the choice.
- [ ] Preserve all ordering-invariant comments and early-return short-circuits.
- [ ] `yarn test` + `yarn lint` green. Run `yarn test:store` for the ALTER paths
      (this is the primary regression net for a store-path refactor); stream the
      output (`2>&1 | tee`) and report results. Document any deferral honestly.
- [ ] Review handoff summarizing the decomposition shape and confirming
      no behavior changed.
