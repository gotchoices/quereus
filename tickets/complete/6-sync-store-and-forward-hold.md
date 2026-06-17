description: A peer that no longer has a table can now be configured to durably keep a straggler's edits for it and mark them ready to pass along to peers that still have the table — the "keep and mark" half of store-and-forward.
prereq:
files:
  - packages/quereus-sync/src/sync/protocol.ts
  - packages/quereus-sync/src/metadata/quarantine.ts
  - packages/quereus-sync/src/metadata/keys.ts
  - packages/quereus-sync/src/sync/change-applicator.ts
  - packages/quereus-sync/src/sync/sync-manager-impl.ts
  - packages/quereus-sync/src/sync/manager.ts
  - packages/quereus-sync/test/metadata/quarantine.spec.ts
  - packages/quereus-sync/test/sync/unknown-table-disposition.spec.ts
  - docs/sync.md
  - docs/migration.md
----

# Complete: store-and-forward, part 1 — the durable forwardable hold

## What landed

The in-engine substrate for the `store-and-forward` unknown-table disposition (the
"keep and mark" half). A diverted out-of-basis straggler change is held identically
to `quarantine` but additionally marked **forwardable**, so the sibling relay ticket
(`sync-store-and-forward-relay`, also reviewed) can re-offer it. No transport, client,
or coordinator surface — only the flag, the disposition that sets it, the read path
the relay consumes (`listForwardable`), and telemetry parity (`forwarded`).

Substrate (committed in `a0410716`, the "agent error" partial-work commit; the doc
type-literal fix + this transition committed in `0f81b857`):

- **`protocol.ts`** — `UnknownTableDisposition` widened to add `'store-and-forward'`;
  default stays `'quarantine'` (opt-in). Doc comments on the type, `ApplyResult.unknownTable`.
- **`quarantine.ts`** — required `QuarantineEntry.forwardable`; compact optional `f?: 1`
  encoding (emitted only when true → plain-quarantine entries byte-identical to before);
  `put(..., forwardable)`; `listForwardable()` (full `qt:` scan filtered to the flag,
  horizon-bounded like `list()`).
- **`change-applicator.ts`** — hold block fires for both `quarantine` and
  `store-and-forward`, inside the same `commitMetadata` admission unit; `ignore` unchanged.
- **`sync-manager-impl.ts` / `manager.ts`** — `unknownTableForwarded` counter +
  `store-and-forward` branch in `recordUnknownTable`; `forwarded` added to the stats shape.
- **Docs** — `migration.md` § 4 reads *implemented*; `sync.md` disposition table, stats
  line, and the `SyncConfig.unknownTableDisposition` type literal all carry the third value.

## Review findings

**Verdict: clean. No minor fixes applied, no major tickets filed.** The implement-stage
work (and its honest-gaps section) held up under adversarial scrutiny.

### What was checked

- **Substrate diff read first, fresh.** Reviewed the real substrate commit `a0410716`
  (not the doc-only `0f81b857`) across all six source files and both spec files before
  reading the handoff. Cross-checked against current HEAD to account for the relay ticket
  (`6c8bce91`) having landed on top — the relay's `relayed` counter,
  `collectForwardableChanges`, and `getChangesSince` merge are correctly *out of scope*
  here and belong to the relay review.
- **Serialization (SPP / correctness).** `f?: 1` is emitted only when `forwardable` is
  true and decoded as `obj.f === 1`; no field-name collision with the existing serialized
  keys (`s/tb/pk/hlc/r/col/v/pv/ph/pr`); both the `column` and `delete` deserialize
  branches set `forwardable`. The byte-absence test pins the "plain quarantine stays
  byte-identical" claim. ✔
- **HLC-key / LWW invariant.** Confirmed `buildQuarantineKey` does not include
  `forwardable` (the flag lives in the value), so a re-delivery under a flipped disposition
  overwrites its own entry — last-writer-wins on the flag. Both flip directions are tested
  (`quarantine→store-and-forward` and back), including that the cleared flag drops out of
  `listForwardable`. ✔
- **`listForwardable` scan bounds.** Verified `buildQuarantineScanBounds()` with no args
  returns `[qt:, qt:+1)` — a correct full-prefix scan that cannot bleed into adjacent key
  spaces. Horizon-bounded exactly like `list()`; zero-cost with no stragglers. ✔
- **Caller coverage / type safety.** `quarantine.put` has exactly one caller
  (`change-applicator.ts`), updated to pass `forwardable`. `QuarantineEntry.forwardable`
  is required, so any un-updated construction site would be a compile error — none exist.
  The `getUnknownTableStats` shape matches across the `SyncManager` interface, the impl,
  and the `MockSyncManager` in `sync-client.spec.ts`. `typecheck` (exit 0) validates all
  shapes. No `any`. ✔
- **Diversion parity & echo-skip.** Tests confirm no CRDT metadata is written for the
  unknown table (same diversion as quarantine), idempotent re-apply keeps one entry, GC
  reclaims forwardable entries past the horizon, and a self-origin echo is skipped *before*
  the hold (never held forwardable, `forwarded` stays 0) — the right ordering, since
  forwarding your own retired-table change would be wrong. ✔
- **Telemetry partition.** `byTable` accumulates unconditionally (the union the
  per-disposition counters partition); `forwarded` bumps only on `store-and-forward`. The
  existing quarantine/ignore tests gained `forwarded === 0` assertions. ✔
- **Docs.** Read every touched doc. `docs/sync.md` disposition table, stats line, and
  `SyncConfig` type literal (line 1306) all reflect the new value; `docs/migration.md` § 4
  bullet reads *implemented across both parts*. No stale references found. ✔
- **Lint/tests.** `@quereus/sync` has no eslint script (typecheck is the gate here):
  `typecheck` exit 0; `test` 371 passing. The `[Sync] Error handling…` / `batch write
  failed` / `iterate failed` lines are deliberate fault-injection in unrelated error-path
  specs, not failures.

### Findings dispositioned

- **`forwarded` double-counts on idempotent re-apply (raised by implementer) — accepted,
  no action.** `recordUnknownTable` bumps once per diverted group per apply, so a
  re-delivered batch bumps `forwarded` again though `listForwardable` still shows one
  entry. This is pre-existing telemetry semantics — `quarantined`/`ignored` behave
  identically; the counters measure "changes diverted this apply," not "distinct entries
  held." Not a regression. Consciously signed off.
- **No real-engine end-to-end hold test — accepted, out of scope.** Coverage sits at the
  SyncManager/CRDT-metadata + serializer layers (mirroring the existing disposition spec),
  not through a real `Database` + `StoreModule`. The relay ticket carries the identical gap
  as its highest-value follow-up; a shared real-engine straggler→hold→relay test would
  harden both and is better filed once, against the relay surface. Not duplicated here.
- **`listForwardable` is an unbounded full scan — accepted, deliberately dumb.**
  Horizon-bounded, zero-cost with no stragglers, fine for the transitional window. Whether
  an HLC/origin-indexed read path is warranted is the relay review's call (the relay is its
  only caller); deliberately left dumb per this ticket's scope. No ticket filed from here.

### Empty categories (explicit)

- **No minor fixes:** the code is DRY, small-function, well-commented, and type-tight;
  nothing rose to a fix-in-pass change.
- **No major tickets filed:** every gap is either acceptable-by-design or already owned by
  the sibling relay ticket's review — none is a defect in this substrate.

## How to validate

```
yarn workspace @quereus/sync run typecheck   # exit 0
yarn workspace @quereus/sync run test        # 371 passing
```

## End
