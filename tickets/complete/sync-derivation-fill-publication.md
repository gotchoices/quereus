description: A replicate-opted-in materialized view's create-fill / refresh now publishes only genuine row changes against its committed contents, so cold derived rows reach old peers at deploy while a value-identical re-fill emits nothing (no change-log storm).
files:
  - packages/quereus-store/src/common/backing-host.ts            # replaceContents (bifurcated); module header § Events
  - packages/quereus-store/test/backing-host.spec.ts             # replaceContents emit tests (+ commit-first-with-pending-txn, DESC/NOCASE block)
  - packages/quereus/src/schema/reserved-tags.ts                 # quereus.sync.replicate doc comment (clarified to include create-fill/refresh)
  - docs/migration.md                                            # § Synced vs. local derived tables; § Current gaps
----

# Complete: publish create-fill / refresh deltas on a replicate-opted-in store backing

Implements the settled decision that **sync changes fire only on actual deltas**:
`StoreBackingHost.replaceContents` (create-fill / full-rebuild refresh) on a
`quereus.sync.replicate = true` backing now diffs the incoming rows against the
**committed** before-image and queues one `DataChangeEvent` per genuine
insert / update / delete, suppressing byte-identical keys. A non-replicating
backing keeps its original streaming put-all path byte-for-byte. The change is
`quereus-store`-only; the memory host and the engine `BackingHost` interface are
untouched.

See the implement commit (`ticket(implement): sync-derivation-fill-publication`,
`c88e4242`) for the full design rationale.

## Review findings

### Scope / correctness (checked)

- **Diff logic mirrors `applyReplaceAll`.** Read both side by side. The
  replicating `replaceContents` arm is a faithful analogue: same key-by-encoded-
  bytes comparison (folding per-column key collation), same `rowsValueIdentical`
  byte-faithful skip, same emit order (inserts/updates in `rows` order, deletes
  after in ascending-PK order). The one deliberate difference is sound: it
  snapshots `store.iterate(committed)` rather than `iterateEffectiveEntries`,
  correct because the coordinator is committed at the top of the method (no
  pending layer to merge).
- **Two refresh paths are now consistent.** `rebuildBacking`'s constraint-bearing
  branch (`materialized-view-helpers.ts:1403`) already refreshed via
  `applyMaintenance` replace-all (which published deltas); the fast path
  (`:1387`) and create-fill (`:486`) used `replaceContents` (which did **not**).
  This change closes that inconsistency — both refresh routes now publish.
- **No double-emit.** Both `replaceContents` arms write via `store.batch()`
  directly (not the coordinator), so the only events are the ones explicitly
  `queueEvent`'d on the replicating arm. Verified `queueEvent` emits immediately
  when not in a transaction (`transaction.ts:179`) — the engine's
  `StoreEventEmitter` batch (started by the create-fill engine transaction) is
  what groups them into one change-set.
- **Default path byte-identical; duplicate-key gate first.** Confirmed the entire
  diff/deserialize/emit is gated on `this.replicates`, and the dup-key throw
  precedes any write or event in both arms.
- **Stats.** Both arms end with `resetStats(rows.length)` (absolute count for a
  full replace) — correct even though byte-identical keys skip their put.

### Tests

- Implementer's floor (6 emit cases × 2 registration flavors + DESC/NOCASE block)
  re-read and run: all pass.
- **Added (minor, this pass):** a replicate-mode **open-coordinator-transaction**
  test — flagged as a gap in the handoff. It queues a pending `applyMaintenance`
  insert, then calls `replaceContents` omitting that row, and asserts (a) the
  pending insert fires on the top-of-method commit, and (b) the committed
  before-image the diff snapshots **includes** that row, so the fill emits exactly
  one delete for it — proving commit-first ordering and no double-count. Runs
  against both registration flavors. Store suite: **624 passing** (was 622).

### Docs (checked, all touched files read)

- `backing-host.ts` module header + `replaceContents` docstring — updated and
  accurate (the old "stays event-free, would storm" line is replaced with the
  minimal-keyed-diff description).
- `docs/migration.md` § "Synced vs. local derived tables" and § "Current gaps" —
  both updated, consistent with the new behavior.
- **Fixed (minor, this pass):** `reserved-tags.ts` — the `quereus.sync.replicate`
  comment described only "maintenance writes" being recorded, which could read as
  excluding create-fill/refresh. Added a clause noting the tag now covers the
  create-fill / refresh path too (the minimal keyed diff). The implementer had
  intentionally left this file alone on the (technically true) grounds that it
  never claimed create-fill was event-free; the clarification removes the
  ambiguity. Comment-only; engine reserved-tags spec still 35 passing, lint clean.

### Major findings → filed as tickets

- **`backlog/sync-create-fill-grouped-changeset-integration-test`** — the headline
  scenario (a replicate MV created over a **pre-populated** source, asserting the
  create-fill inserts arrive at a peer as ONE grouped change-set under a single
  HLC) has **no end-to-end coverage**. The existing sync integration test
  (`echo-loop-quiescence.spec.ts`) builds its MV over an *empty* `src`, so
  create-fill emits nothing there and only the maintenance path is exercised.
  Residual risk is low (the grouping machinery is pre-existing and shares the
  exact `queueEvent → emitter` path that the maintenance test does cover), so this
  is test-only and non-blocking — but the cold-fill delivery is the whole point of
  the ticket and deserves a direct assertion. Filed as backlog (test-only).

### Out-of-scope changes swept into the implement commit (noted, not actioned)

- The implement commit (`c88e4242`) also carries edits to `docs/sql.md` (+69) and
  `packages/quereus/README.md` that document `with inverse` / `with defaults`
  (updatable-view authoring) — unrelated to this ticket (whose doc surface is
  `migration.md` + the store backing comments). These appear to be pre-existing
  uncommitted `view-updates-lens`-branch work that got `git add`-ed alongside the
  ticket's changes. They are valid for their own feature and harmless here; left
  in place (already committed; reverting another stream's in-flight work is
  outside this ticket and against the "never sanitize the working tree" rule).
  Flagged so the branch owner is aware of the mis-attribution.

### Validation run

- `yarn workspace @quereus/store test` → **624 passing**
- `yarn workspace @quereus/store build` (tsc) → clean
- `yarn workspace @quereus/quereus lint` → exit 0 (eslint + test tsc)
- engine `reserved-tags` spec → 35 passing
- No `.pre-existing-error.md` needed; no pre-existing failures surfaced.
