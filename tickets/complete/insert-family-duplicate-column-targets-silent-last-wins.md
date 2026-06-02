description: INSERT-family duplicate-column-target rejection. Two name-based guards in building/insert.ts close the silent last-wins hole for (a) `ON CONFLICT DO UPDATE SET <col>=..,<col>=..` (Guard 1) and (b) an explicit duplicate INSERT column list `insert into t (a,a) ...` (Guard 2). Guard 2 also backstops the view-INSERT analogue (two view columns lowering to one base column). Mirrors the UPDATE-side backstop in building/update.ts. Reviewed; build + full `yarn test` + lint green.
files: packages/quereus/src/planner/building/insert.ts, packages/quereus/src/planner/building/update.ts, packages/quereus/src/planner/mutation/single-source.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/test/logic/47-upsert.sqllogic, packages/quereus/test/logic/01.5-insert-select.sqllogic, packages/quereus/test/logic/93.4-view-mutation.sqllogic, docs/view-updateability.md
----

## Summary

Closes the INSERT-family analogue of the UPDATE-side silent last-wins hole hardened by
sibling ticket `view-update-conflicting-base-column-assignments-silent-last-wins`.

- **Guard 1** (`insert.ts` `buildUpsertClausePlans`): a name-keyed `seenTargets` set
  over the DO-UPDATE assignments rejects `on conflict do update set b = 1, b = 2` before
  index resolution (`duplicate assignment to column '<col>' in ON CONFLICT DO UPDATE`).
  This path never routes through `buildUpdateStmt`, so it needs its own backstop.
- **Guard 2** (`insert.ts` `buildInsertStmt`, explicit-columns branch): a `seenColumns`
  set rejects a duplicate INSERT column list (`column '<col>' specified more than once in
  INSERT into '<table>'`). Case-insensitive; preserves the user's casing in the message.
- **View INSERT analogue**: all three view-INSERT spines re-plan through `buildInsertStmt`
  with an explicit base-column list, so two view columns lowering to one base column land
  a duplicate that Guard 2 catches (naming the base column). No view-aware message — a
  deliberate departure from the UPDATE spines (judgement call, see findings).

Both guards reject **unconditionally** (no value-agreement softening) and throw during
planning/building, before any plan node is built or any side effect runs.

## Review findings

### Implementation correctness — checked, no defects
- Read the actual code diff (landed in the fix-stage commit `ad7f14a5`, not the
  implement commit which only moved ticket files). Guard 1 (`insert.ts:329-359`) and
  Guard 2 (`insert.ts:484-503`) are clean, name-based, case-insensitive, and faithfully
  mirror the UPDATE-side backstop (`update.ts:124-141`). Both throw before index
  resolution / plan construction.
- **View-spine routing claims independently verified by code reading** (the implement
  handoff confirmed these by reading; I re-confirmed against current source):
  - single-source: `single-source.ts:718,738` — `finalColumns` (= `baseColumns`) becomes
    the rewritten insert's `columns`. The `isSupplied` guard at `:694-696` prevents the
    constant-FD `appendColumns` from injecting a spurious duplicate against a base column
    (no false-positive risk).
  - multi-source join: `view-mutation-builder.ts:418-429` feeds `[...side.targetColumns]`
    (built at `multi-source.ts:351-356` as `[key, ...supplied base cols]`) into
    `buildInsertStmt`. A same-side two-view-columns-to-one-base collision lands a
    duplicate → Guard 2.
  - decomposition: `view-mutation-builder.ts:561-574` feeds `op.columns.map(c => c.baseColumn)`
    into `buildInsertStmt`. Same routing.

### Tests — gaps from the handoff floor closed inline (minor)
- **Added** (`47-upsert.sqllogic`): case-insensitive DO-UPDATE-SET duplicate
  (`name = 'one', NAME = 'two'`) rejects — pins Guard 1's case-insensitivity, which the
  handoff flagged as untested. Plus a positive case (`set email = .., name = ..` distinct
  columns) succeeds — false-positive guard for Guard 1.
- **Added** (`01.5-insert-select.sqllogic` §11): a distinct prefix-sharing column list
  (`prefix_cols (ab, abc)`) inserts successfully — confirms Guard 2 keys on exact-name
  collision, never on shared prefixes (the false-positive concern the handoff raised).
- **Not added — multi-source / decomposition view-INSERT collision behavioral tests.**
  The handoff flagged these as untested belt-and-suspenders. I verified the routing by
  code reading (above) rather than adding tests: a multi-source-join INSERT test would be
  brittle — surrogate minting and `assertNoMissingNotNull` (`multi-source.ts:358`) can
  throw for reasons unrelated to the collision before the per-side insert is built, making
  it a poor regression test. Code-verified routing is the stronger guarantee here.

### Docs — was stale, fixed inline (minor)
- `docs/view-updateability.md` § Diagnostics documented only the UPDATE-side backstop,
  even though the ticket claimed the INSERT rationale "lives" there. **Added** a paragraph
  mirroring the UPDATE coverage: Guard 1, Guard 2, the view-INSERT analogue routing, and
  the deliberate no-view-aware-message choice.

### Judgement call — view INSERT names the base column (acceptable; no action)
- The view-INSERT collision message names the **base** column (e.g. `b`), not the view
  column the user wrote (`b2`). The fix stage chose the generic Guard-2 backstop over a
  view-aware message. Assessment: **acceptable as-is.** Adding a view-aware INSERT message
  would touch all three view-spine builders for a low-frequency error path; if a friendlier
  message is later desired it is a self-contained `fix/` ticket, not an inline tweak. The
  UPDATE single-source/decomposition spines do carry a view-aware message, so there is a
  minor cross-statement UX asymmetry — documented in § Diagnostics and not worth closing now.

### Verification (this stage)
- `node test-runner.mjs --grep "47-upsert|01.5-insert-select|93.4-view-mutation"` — 3 passing
  (includes the new assertions).
- `yarn test` (root, full suite, all workspaces) — **4411 passing / 9 pending, 0 failing**,
  `Done in 2m 60s`. The sync workspace's `Error: boom` / `batch write failed` / `iterate
  failed` lines are expected negative-path assertions, not failures.
- `yarn workspace @quereus/quereus run lint` — clean (exit 0).
