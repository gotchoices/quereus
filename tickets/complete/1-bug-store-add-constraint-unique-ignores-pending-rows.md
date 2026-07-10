----
description: On persistent-store tables, adding a UNIQUE constraint (or changing a column's text-comparison rule) now checks both committed rows and rows written earlier in the same still-open transaction, closing a hole where such a duplicate could survive.
files:
  - packages/quereus-store/src/common/store-module.ts       # validateUniqueOverExistingRows (~1138), call sites addConstraint (~1456) / SET COLLATE (~1709)
  - packages/quereus-store/test/unique-constraints.spec.ts  # describe: 'ADD CONSTRAINT UNIQUE / SET COLLATE validate pending rows'
  - packages/quereus-store/README.md                        # read-your-own-writes bullet list
difficulty: easy
----

# Store `ADD CONSTRAINT … UNIQUE` / `SET COLLATE` validate effective rows

## What changed

`StoreModule.validateUniqueOverExistingRows` took a `KVStore` and scanned
`dataStore.iterate(...)` — committed rows only. It now takes an
`AsyncIterable<KVEntry>`; both call sites pass
`table.iterateEffectiveEntries(buildFullScanBounds())`, the committed rows merged with
the open transaction's own pending puts and deletes. This mirrors how `createIndex`
already feeds `buildIndexEntries`. The validator body is unchanged (per-column
collation-aware `seen`-set dedup, SQL NULL semantics, partial predicate honored).

Call sites: `alterTable` → `addConstraint` (unique arm), and `alterTable` →
`alterColumn` → `SET COLLATE` non-PK re-validation. Neither mutates the store before
validation returns, so a rejected ALTER still leaves the table exactly as it was.

## Review findings

Reviewed the implement commit `a45e5271` diff first, then the surrounding call sites,
`StoreTable.iterateEffective`, and the isolation layer's `alterTable`.

**Checked and clean:**
- Signature change is the only API move; `KVStore` is still imported and used elsewhere,
  no dead import.
- Dropping `getStore(...)` at the `addConstraint` call site is safe —
  `iterateEffectiveEntries` calls `ensureStore()` itself.
- Ordering guarantee holds: the non-PK UNIQUE re-validation still runs before
  `rekeyRows` / `rebuildSecondaryIndexes`, so every throw-only check precedes the first
  store mutation.
- Async-generator hygiene: a fresh generator per constraint (single-shot); `for await`
  calls `.return()` on the throw path, so an early abort still closes the store iterator.
- `iterateEffective` merges pending DELETEs, not only pending puts — the fix therefore
  also fixes the "committed duplicate, one copy deleted in this transaction" case.
- The adjacent `SET COLLATE`-on-PK `rekeyRows` hazard was correctly left alone; it is
  tracked as `bug-store-alter-rekey-ignores-pending-ops` in `tickets/fix/`.
- Deliberate absence of sqllogic coverage is correct — the logic suite runs against the
  memory backend, whose sibling fix (`bug-memory-ddl-validation-ignores-pending-rows`)
  owns that file.

**Minor — fixed in this pass:**
- The `if (coveringConstraints.length > 0)` guard in the `SET COLLATE` arm became
  vestigial once `getStore` was dropped (a `for` over an empty array is a no-op).
  Removed; replaced with a one-line comment explaining why the generator is constructed
  inside the loop.
- Test gaps. The implementer covered only pending-INSERT cases. Added two:
  `'ADD CONSTRAINT UNIQUE still rejects a duplicate that is already committed'`
  (regression guard — the fix must not lose the original committed-row check) and
  `'ADD CONSTRAINT UNIQUE accepts when a pending DELETE removes the committed duplicate'`
  (the pending-delete half of "effective", untested before).
- Docs were stale. `packages/quereus-store/README.md` documented the effective-stream
  contract for `CREATE INDEX` only. Added a bullet in the read-your-own-writes list
  covering `ADD CONSTRAINT … UNIQUE` and the `SET COLLATE` re-validation.

**Major — new ticket filed:**
- The same class of defect exists one layer up. `IsolationModule.alterTable` and
  `IsolationModule.createIndex` delegate straight to the underlying module, whose scan
  cannot see the issuing connection's isolation overlay. So under the isolation layer a
  same-transaction duplicate still survives `ADD CONSTRAINT … UNIQUE`, regardless of this
  fix or the memory-backend sibling. Filed as
  `tickets/fix/isolation-ddl-validation-ignores-overlay-rows.md`.

**Tripwires:** none. The one conditional concern considered — the validator is an O(rows)
full scan per constraint, so `SET COLLATE` on a column covered by N UNIQUE constraints
does N full scans — is not new behavior (it predates this change), N is bounded by the
declared constraints on one column, and the scan already existed on the committed path.
Nothing to park.

## Validation

- `yarn workspace @quereus/store test` — 805 passing (803 pre-existing + 2 added here;
  the implementer's 4 included).
- `yarn test` — full monorepo, no failures.
- `yarn lint` — clean (eslint + `tsc -p tsconfig.test.json --noEmit` in
  `@quereus/quereus`; every other package's no-op lint reached).
