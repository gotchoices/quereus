description: Give every synced table a stable identity that outlives its name, and file the sync engine's per-row conflict-tracking records under that identity instead of the table name, so renaming a table or dropping and re-creating one no longer strands or inherits the wrong history.
architecture: docs/sync.md#storage-layout
files:
  - packages/quereus-sync/src/metadata/table-identity.ts       # TableIdentityStore, applySchemaChangeTransitions, withIdentityRecovery, writeIdentityBatch
  - packages/quereus-sync/src/metadata/keys.ts                 # tg: prefix/builders/parser; cv:/tb:/cl: keyed by generation; SYNC_METADATA_FORMAT_VERSION 6
  - packages/quereus-sync/src/clock/site.ts                    # randomBytes shared by the site id and the generation mint
  - packages/quereus-sync/src/metadata/column-version.ts
  - packages/quereus-sync/src/metadata/tombstones.ts
  - packages/quereus-sync/src/metadata/change-log.ts
  - packages/quereus-sync/src/sync/admission.ts                # commitMetadata runs under withIdentityRecovery
  - packages/quereus-sync/src/sync/change-applicator.ts
  - packages/quereus-sync/src/sync/sync-manager-impl.ts        # capture catch re-reads the index; streaming apply delegate wrapped
  - packages/quereus-sync/src/sync/snapshot-identity.ts        # compareTableNames
  - packages/quereus-sync/src/sync/snapshot-stream.ts
  - packages/quereus-sync/src/sync/snapshot.ts
  - packages/quereus-sync/src/sync/store-adapter.ts
  - packages/quereus-sync/src/sync/protocol.ts
  - packages/quereus-sync/test/metadata/table-identity.spec.ts            # NEW — standalone-write recovery
  - packages/quereus-sync/test/sync/transaction-commit.spec.ts            # capture-catch recovery
  - packages/quereus-sync/test/sync/table-identity-strands-metadata.spec.ts
  - docs/sync.md
  - docs/sync-schema.md
difficulty: hard
----

# Complete: sync bookkeeping keyed by a stable table generation

Every per-row sync record (`cv:` cell version, `tb:` tombstone, `cl:` change-log entry) is filed under a per-peer **table generation** instead of the table name. A `tg:` record maps each `(schema, table)` name to its generation; a rename moves that record, a drop retires the generation, a same-name re-create mints a fresh one. Nothing changed on the wire: a change is addressed by the table's current name at extraction time and the receiver resolves that name to its own generation. `SYNC_METADATA_FORMAT_VERSION` is 6; a replica on 5 refuses to open and must re-bootstrap (release note in `docs/sync.md` § Metadata format version).

Implemented in `ticket(implement): sync-table-generation-identity`; this review pass is on top of it.

## Review findings

**Read first:** the whole implement diff (34 files), then the handoff. Checked happy path, the rename and drop/re-create races, in-batch fates, both snapshot producers and receivers, the relay-only fallback, the commit-chain drains, the three DDL transition drivers, the prune and repair sweeps, every doc the change touched, and every file that references the identity store.

### Found and fixed in this pass

- **The in-memory identity index could run ahead of disk after a failed batch, permanently.** The index is updated when a transition is *staged*, which is right (later stages of the same batch must see `drop t; create t`'s fresh generation), but the handoff's claim that a failed mint "is re-persisted by the next write" was false: `ensure` returns early for a name the index already holds and never stages the `tg:` put again. So one failed batch (a storage write rejection, or a throw mid-staging in the capture) left every later record for that name filed under a generation no `tg:` record names, silently, until the next restart made them all unresolvable. Fixed at the invariant level: `TableIdentityStore.load` is now idempotent (clears, then reads) and is the recovery, invoked through one wrapper, `withIdentityRecovery`, at every site that stages transitions and may fail to commit them: `admitGroup`'s metadata commit (apply, drain, non-streaming snapshot), the streaming snapshot apply delegate, the stores' four standalone writers (via `writeIdentityBatch`), and the local commit capture's catch (which swallows its own errors, so the re-read's error is logged, not rethrown; a pre-existing failing-KV test exercised exactly that path). Two tests reproduce it at the two layers that own a batch: `table-identity.spec.ts` (standalone store write) and `transaction-commit.spec.ts` (commit capture, reopened replica). Both fail with the recovery disabled and pass with it.
- **DRY:** `mintTableGeneration` re-implemented `generateSiteId`'s random-bytes fallback; extracted `randomBytes` in `clock/site.ts` and used it in both.
- **Determinism:** both snapshot producers sorted tables with `localeCompare`, which differs across runtimes and ICU builds; replaced with a shared code-unit comparator `compareTableNames` in `snapshot-identity.ts`.
- **Tests cut:** `keys.spec.ts`'s "the format version is 6" pinned a constant that `metadata-format-version.spec.ts` already asserts as the precondition of its version-5 refusal test.

### Found and parked as tripwires (fine now; conditional)

- `change-applicator.ts`, the identity-transition step in `commitMetadata`: a crash between Phase 2's engine commit and the identity batch strands a replicated rename's generation at the old name (the retry decides `already-applied` and moves nothing — the one non-idempotent step of the apply). Same crash class docs/sync.md § Write Order and § Known Limitations already carry; `NOTE:` at the site, sentence under § Table identity "What this does not solve".
- `table-identity.ts`, `ensure` and `move`: DDL run while sync is detached leaves a `tg:` record whose table is gone; a later same-name create inherits it and a rename onto that name hits the `move` collision throw. The drop's migration is lost the same way, so it is the existing unsupported window; `NOTE:` at both sites naming the fix (reconcile `tg:` against the catalog in `load`) if detached DDL is ever supported.
- The handoff's own three tripwires (`whenCommitsSettled` ordering, `freshLocalTable` narrowing via `historyName`, the `alterPrimaryKey` arm) were read and left in place.

### Considered and declined (no change)

- **Snapshot receivers do not drain the commit chain.** A local DDL committing mid-bootstrap is outside the supported window that `feat-sync-bootstrap-write-gate` (backlog) already owns; a drain here would not make it safe. Left alone.
- **`executedSchemaChanges` optional with the relay-only fallback.** The doc comment states the rule; only the shipped adapter exists and it always reports.
- **`clearExistingMetadata` leaves `tg:` records.** Correct: generations are local, rewritten records file under the same ones, and a table the snapshot's DDL drops is retired by that DDL's transition.
- **Case-sensitivity of names in the maps.** Same verbatim keying the name-keyed records used; every emit site uses the engine's one canonical spelling.

### Tickets filed

None. The one major finding was fixed in place at the invariant level rather than filed; the two tripwires are conditional on crash or detached-DDL support, neither of which is a current-release anchor. The two sibling implement tickets (`sync-retire-dropped-table-bookkeeping`, `sync-rekey-bookkeeping-on-primary-key-change`) reference `TableIdentityStore.retire`/`ensure` and are unaffected by the added `load` on `TableIdentityResolver`.

### Validation

```
yarn workspace @quereus/sync typecheck          # clean (source + test tsconfig)
yarn workspace @quereus/sync test               # 765 passing (764 before: +2 added, -1 cut)
yarn workspace @quereus/sync build
yarn workspace @quereus/sync-coordinator typecheck && test   # clean; exit 0
yarn workspace @quereus/sync-client typecheck
yarn workspace @quereus/quoomb-web typecheck
```

`yarn lint` was not run: only `packages/quereus` has a real lint and nothing there changed. No pre-existing failures surfaced.
