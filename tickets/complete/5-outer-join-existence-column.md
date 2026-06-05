description: Write-enabled second half of the outer-join existence column (Dataphor `include rowexists`) — writing the `existence`-sited boolean drives insert/delete of the non-preserved side. `set hasB = true` while absent ⇒ insert B; `= false` ⇒ delete the matching B row; composes with same-side / cross-side column writes and with insert-through. Reviewed and shipped.
files: packages/quereus/src/planner/analysis/update-lineage.ts, packages/quereus/src/planner/mutation/backward-body.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/func/builtins/schema.ts, packages/quereus/test/property.spec.ts, docs/view-updateability.md, docs/sql.md
----

## What shipped

The write half of the outer-join existence column. The `existence`-sited boolean
(`exists … as hasB`) is now **writable through an effect**: writing it drives the
non-preserved side's existence. The runtime substrate is **reused, not extended** — the
existence write is the insert-or-delete specialization of the non-preserved-side UPDATE
machine (capture + null-extended INSERT + captured-key DELETE).

- **Routing** — `resolveBaseSite` (`update-lineage.ts`) makes an `existence` site
  `writable: true` with no `baseColumn`, carrying `existenceComponent` +
  `existenceGuard`. The descriptor threads through `BackwardColumn` → `OutColumn`
  (`existenceComponent` + resolved `existenceSide`). `analyzeJoinView` maps the
  component's node id → sole `TableReferenceNode` → side index
  (`buildNodeToSoleTableRef` / `resolveExistenceSide`, with a fallback to the unique
  non-preserved side).
- **UPDATE** (`decomposeUpdate`) — `true` ensures a (possibly empty) `nullExtendedBySide`
  entry ⇒ the post-loop emits the null-extended materialization INSERT (matched rows are
  a no-op); `false` emits a base DELETE keyed on the captured non-preserved PK (a
  null-extended row's captured PK is null, so it is naturally excluded). A same-side
  column write folds into the INSERT. `set npCol = …, hasB = false` rejects
  `conflicting-assignment`. Boolean literal only; RETURNING rejects.
- **INSERT** (`analyzeMultiSourceInsert`) — `hasB` is a uniform-boolean-literal routing
  directive (`existenceInsertFlag`): `true` forces the non-preserved side active, `false`
  preserved-only; a `false` contradicting a supplied non-preserved column rejects
  `conflicting-assignment`. Never stored; kept as an envelope column for VALUES arity.
- **Static surface** (`schema.ts`) — `deriveColumnInfo` reports an `existence` flag
  `is_updatable = 'YES'` with `base_table` / `base_column` = `null`, gated on a preserved
  anchor (FULL outer stays deferred).

## Validation

- `node packages/quereus/test-runner.mjs` — **4695 passing, 0 failing, 9 pending** (exit
  0; +1 over the implement-stage 4694 — the new compositions/null-key regression test).
- `yarn workspace @quereus/quereus lint` — exit 0.

## Review findings

Adversarial pass over the implement diff (`abd0aa6c`). Read the full diff fresh before
the handoff summary; scrutinized routing, capture reuse, the insert directive model,
schema reporting, and the "known gaps" the handoff flagged.

### Checked — correct, no change

- **Capture wiring for a pure existence write.** `capturedSideIndices` derives captured
  sides from the emitted base ops, so a `hasB = false`-only DELETE (or `hasB = true`-only
  INSERT) on the non-preserved side still captures that side's PK / threads the `nejk`
  preserved join key. Verified the DELETE's `buildCapturedKeyPredicate` and the INSERT's
  `<np PK> is null and <join key> is not null` guard both resolve against it.
- **Composition semantics.** Traced `set npCol = …, hasB = true` (matched UPDATE folds
  with the materialization INSERT, no double-insert), `set npCol = …, hasB = false`
  (contradiction via non-empty `perSide[np]`), and `hasB = true/false` over matched vs
  null-extended partitions. The `existenceDeleteSides` / `existenceInsertSides`
  contradiction guard is sound.
- **`schema.ts` base-trace split.** The new `hasBaseTrace = updatable && bs && ref`
  correctly reports `null` base for the (updatable, base-less) existence flag without
  regressing any real base column or read-only computed column — `updatable` can only be
  true with `bs`/`ref` undefined via the `isExistence` path. FULL-outer existence (no
  preserved anchor) stays `is_updatable = 'NO'`.
- **`resolveExistenceSide` deferral.** For >1 non-preserved side the direct id map may
  resolve; if not, the unique-side fallback returns `undefined` ⇒ the write defers
  `unsupported-outer-join-update` cleanly (no incorrect write). Safe boundary; the n-way
  tightening is left for `set-operator-membership-columns` as the handoff notes.
- **FK contract.** `hasB = false` deleting a still-referenced parent tripping RESTRICT
  with FK on is *correct* behavior, not a defect; tests use `pragma foreign_keys = false`
  by the established outer-join pattern. No plan-time FK analysis is owed here.

### Minor — fixed in this pass

- **Untested-but-working compositions now pinned.** Added a regression test
  (`property.spec.ts` → `existence-column write compositions and null-key boundary`)
  covering: `set pv = …, hasB = true` over a matched row (UPDATE + no-op INSERT, no
  spurious second parent); cross-side `set cv = …, hasB = false` (preserved write +
  parent delete compose); multi-row uniform-`false` insert; per-row-mix insert reject
  (`unsupported-outer-join-update`); and `insert (hasP) values (true)` with no anchor
  (`null-extended-create-conflict`). All behaved correctly when probed; pinned so they
  stay that way.
- **Silent null-key no-op documented + pinned.** `hasB = true` over a null-extended row
  whose *join key is itself null* cannot mint a joinable row, so the materialization
  INSERT (`<join key> is not null`-guarded) drops it — the flag reads back `false` after
  a write of `true`. This is *dropped, not rejected* (inherited from the
  non-preserved-column UPDATE create branch). Added the regression assertion and a
  `view-updateability.md` NOTE documenting this and the shared-component effect (a
  `hasB = false` deletes the shared non-preserved row out from under sibling preserved
  rows). Also documented the `1`/`0` numeric-literal leniency and the INSERT uniform-
  directive requirement, which the prior doc omitted.

### Major — none

No correctness defects found. Every "known gap" the handoff flagged was probed and is
either working-as-designed (now covered by tests) or a documented, intentional boundary.
No new fix/plan/backlog tickets filed.

### Out of scope (kept rejecting, by design)

Non-literal boolean existence writes; projection-position sugar `exists(<alias>) as hasB`
(deferred by the read half); composite shared keys for the create branch; multi-source
insert RETURNING; composite non-preserved join key for the `hasB = true` materialization
(`unsupported-outer-join-update`, inherited from `outerJoinInsertKey`).

## Downstream note (`set-operator-membership-columns`)

The existence write routing keys off the generic `RelationalComponentRef`
(`existenceComponent`), **not** a hard-coded join side, so the set-operation
membership-column work extends the same `existence` `UpdateSite` + routing. Confirm this
stays component-generic if the routing is refactored, and consider tightening the n-way
`resolveExistenceSide` map (multiple non-preserved sides each with their own existence
column) at that time — today it defers safely but is not exercised.
