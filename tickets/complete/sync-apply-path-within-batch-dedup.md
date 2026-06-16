description: Apply-path within-batch dedup — commitChangeMetadata collapses same-key repeats inside ONE applyChanges batch to the max-HLC winner, closing the relay re-attribution / duplicate-fact hazard for both delete and column entries. Reviewed and completed.
prereq:
files:
  - packages/quereus-sync/src/sync/change-applicator.ts        # commitChangeMetadata rewrite + helpers; deleteKey/columnKey now reuse encodePK (review change)
  - packages/quereus-sync/src/sync/sync-manager-impl.ts        # collectChangesSince LOAD-BEARING INVARIANT comment extended for the apply-path in-batch collapse
  - packages/quereus-sync/test/sync/sync-manager.spec.ts       # 3 tests in applyChanges describe; test 3 re-ordered into a genuine guard (review change)
  - docs/sync.md                                               # § Transaction-granularity bounding — in-batch collapse note
difficulty: medium
----

# Complete: apply-path within-batch dedup

## What landed

`commitChangeMetadata` (Phase 3 of `applyChanges`) collapses in-batch repeats per key
before writing any metadata. When two versions of one key arrive in a single `applyChanges`
call, Phase 1 (`resolveChange`, read-only — confirmed it performs no writes) resolves BOTH
against the same pre-batch prior version, so neither sees the other. The old code wrote two
change-log entries for one key; the older then re-attributed (via `resolveLogEntry`, which
keys the surfaced HLC off the *current* version) to the later HLC, breaking
`collectChangesSince`'s LOAD-BEARING INVARIANT (survivor log HLC == current version HLC) and
re-introducing the transaction-split / duplicate-fact hazard on a relay.

The fix builds two `Map<key, ResolvedChange>` winner tables (deletes keyed by
`(schema, table, pk)`, columns by `(schema, table, pk, column)`), keeping only the max-HLC
change per key via `compareHLC`. Only winners' metadata + change-log entries are written; the
single pre-batch prior entry is deleted once; `deleteRowVersions` runs once per winning delete.
Decomposed into small helpers (`deleteKey`, `columnKey`, `keepMaxHLC`, `commitDeleteMetadata`,
`commitColumnMetadata`). `result.applied/skipped/conflicts` accounting is unchanged.

## Review findings

### Checked

- **Implement-stage diff read first, fresh eyes** (`e7a19cd1`), before the handoff summary.
- **Pre-batch-snapshot assumption** — read `resolveChange`; confirmed it is read-only, so all
  in-batch changes for a key genuinely resolve against the same pre-batch version and carry the
  same `oldTombstone`/`oldColumnVersion`. Using the *winner's* prior-entry reference is correct.
- **HLC tie handling** — `keepMaxHLC` keeps strictly-greater; HLCs from distinct sites never
  compare equal (siteId tiebreaker), so first-wins on a (non-occurring) tie is harmless.
- **Mixed delete + column for the same pk in one batch** — routed to separate maps, both
  committed; `deleteRowVersions` (post-batch) still clears the column versions written in the
  same batch. Identical interleaving to the pre-fix code — no regression.
- **Resource cleanup** — `deleteRowVersions` now runs once per *winning* delete instead of once
  per *applied* delete; losers were never written, so this is strictly fewer redundant scans.
- **Type safety / narrowing** — the `if (change.type !== 'delete') continue` guards in the
  commit loops are defensive union-narrowing over homogeneous maps; acceptable.
- **pk key serialization** — `SqlValue` includes `bigint`, which `JSON.stringify` cannot
  serialize. The new helpers originally inlined `JSON.stringify`; verified the canonical
  `encodePK` (`metadata/keys.ts`) ALSO uses `JSON.stringify`, so this is a pre-existing
  package-wide limitation (the whole sync KV keyspace would throw at `encodePK` before ever
  reaching the dedup), NOT a new defect. Addressed for consistency anyway — see fixes.
- **Docs** — read `docs/sync.md` § Transaction-granularity bounding and the
  `collectChangesSince` invariant comment; both accurately describe the in-batch collapse and
  remain correct after the review changes (behaviour — max-HLC winner — is unchanged).
- **Lint/tests** — `yarn workspace @quereus/sync test` → 260 passing, 0 failing. `typecheck`
  (src) clean. Transient src+test type-check (`tsconfig.spec-check.json`, then removed) clean.
  `@quereus/sync` has no lint script (per AGENTS.md); the typecheck + test run is the gate.

### Found & fixed inline (minor)

- **Test 3 was a tautology — fixed.** The "does not split a separate transaction…" test
  (`batchSize=1` multi-round walk) placed the multi-fact transaction (`tx-multi`) at `now+2000`,
  AFTER both colliding pk[1] deletes (`now`, `now+1000`). Adversarially defeating the collapse
  (unique key per change), I confirmed tests 1 and 2 flipped to red but **test 3 stayed green** —
  the duplicate pk[1] entry was masked because the watermark advanced past it on round 2.
  Re-ordered so `tx-multi`'s HLC sits BETWEEN the two deletes (deletes at `now`/`now+2000`,
  multi-fact at `now+1000`). Now, without the collapse, the older pk[1] entry re-attributes
  forward to the winner HLC (`now+2000`), advancing the watermark PAST `tx-multi` in round 1 so
  it is silently dropped — the `withPk5 lengthOf(1)` assertion catches it. Re-ran the adversarial
  check: all THREE tests now flip to red without the fix and pass with it. Updated the trailing
  winner-HLC assertion to `now+2000` and documented the ordering rationale in-test.
- **DRY: collapse keys now reuse `encodePK`.** `deleteKey`/`columnKey` reimplemented pk
  serialization inline (`JSON.stringify([schema, table, pk, …])`). Switched them to
  `` `delete:${schema}.${table}:${encodePK(pk)}` `` / `` `column:…:${encodePK(pk)}:${column}` ``
  so in-batch grouping uses the SAME canonical pk encoding as the actual KV keys
  (`buildTombstoneKey`/`buildColumnVersionKey`) — two pks collapse here iff they would collide
  on disk, and the pk-encoding limitation now has a single source of truth.

### Found, not actioned (out of scope / pre-existing — no new ticket warranted)

- **Phase 2 data-value divergence** — explicitly out of scope and untouched. This fix
  guarantees only the metadata invariant. `dataChangesToApply` is still applied in Phase-1
  resolve order, so a repeated `(pk, column)`'s host *value* is last-applied, not necessarily
  max-HLC. Non-issue in the normal relay flow (`getChangesSince` emits ascending HLC →
  max-HLC applies last → value == metadata); only reachable if a caller hands `applyChanges`
  same-key changes in descending HLC order, which this package never produces. Hardening (HLC-
  sort or collapse `dataChangesToApply`) is a separate concern; deliberately not folded in.
- **Custom `conflictResolver` among two in-batch column writes** — the collapse picks the
  max-HLC remote, never invoking the resolver to choose *between two remotes* (the resolver only
  compares remote-vs-local). Under the default HLC resolver this is exactly sequential
  semantics; under a custom resolver the metadata winner could differ from strict
  apply-in-order. Same class as the Phase-2 note above (metadata == max-HLC, host value ==
  last-applied) and already covered by it. The previous behaviour (two entries) was
  unambiguously wrong; max-HLC is the correct CRDT default. Not a blocker.
- **Stale `cl:` column entries after a row delete** — `deleteRowVersions` clears `cv:` rows, not
  `cl:`; the orphaned column entries resolve to null and are correctly skipped (footprint only).
  Carried forward from the prior `sync-stale-delete-entry-reattribution` review; unchanged here.

### Empty categories

- **No major findings → no new fix/plan/backlog tickets filed.** The implementation is correct;
  the only defect was a non-guarding test, fixed inline.
- **No `.pre-existing-error.md` written** — the suite is green at HEAD with these changes; no
  unrelated failures surfaced.

## Validation performed

- `yarn workspace @quereus/sync test` → **260 passing, 0 failing**. (The `Oversized transaction`
  warnings and `Error handling transaction commit` lines are from tests that intentionally
  exercise oversized / failing-KV paths — not regressions.)
- Adversarial guard check (defeat collapse → all 3 new tests fail; restore → all pass) — done
  twice (before and after the test-3 re-order) to confirm test 3 is now a genuine guard.
- `yarn workspace @quereus/sync typecheck` (src) → clean.
- Transient src+test type-check (`tsconfig.spec-check.json`, removed after) → clean (covers both
  the src refactor and the spec edit, which the standard gate excludes).
- `test:store` (LevelDB) not run — metadata-logic only, no store-specific path touched; fully
  exercised by the memory-backed suite. Deferred per agent-runnable guidance.

## End
