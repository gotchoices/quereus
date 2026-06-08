description: Add a "no silent divergence" conformance test matrix over (module × ALTER arm), encoding the audit's hard contract that a module either honors an `alterTable` arm or throws a clean `UNSUPPORTED` — never silently no-ops. Also demote the five informational `ModuleCapabilities` flags (mark them advisory / not engine-consulted) so binding gates are distinguishable from dead metadata.
prereq: module-capability-negotiation-doc
files: packages/quereus/src/vtab/capabilities.ts, packages/quereus/test/alter-table-conformance.spec.ts, packages/quereus/test/capabilities.spec.ts, packages/quereus/src/vtab/memory/module.ts, packages/quereus-store/src/common/store-module.ts, packages/quereus/src/runtime/emit/alter-table.ts
----

## Why

The audit's core recommendation is a **hard contract**: a `VirtualTableModule` that cannot
honor an invoked `alterTable` arm MUST throw `QuereusError(StatusCode.UNSUPPORTED)` with a
sited message — it must never silently no-op (which is exactly how the store PK-collation
gap escaped: a real mandate quietly became a schema-only update). This ticket puts teeth
behind the rule with a conformance matrix that future modules/arms are checked against, so
the next divergence fails a test instead of shipping.

It also cleans up the capability bag: five of the seven `ModuleCapabilities` flags
(`isolation`, `savepoints`, `persistent`, `secondaryIndexes`, `rangeScans`) are **never
consulted by the engine** — they are asserted only in tests. Leaving them indistinguishable
from the two live gates (`delegatesNotNullBackfill`, `permitsGrandfatheredCheckViolators`)
invites authors to toggle a flag expecting an effect. Mark them advisory.

This is intentionally small and pattern-establishing, not an ocean-boiling migration. It
does **not** add fine-grained per-arm capability echoes — that lands incrementally with the
arms that need it (first: `store-pk-collate-module-capability`).

## What "conformance" asserts

For each module under test (memory; store via `@quereus/store` with an in-memory provider;
isolation-wrapped memory) and each `alterTable` arm, drive the arm through real SQL
(`ALTER TABLE …`) on a populated table and assert the outcome is exactly one of:

- **honored** — the arm applies and the post-ALTER schema/behavior reflects it, OR
- **clean reject** — a `QuereusError` with `code === StatusCode.UNSUPPORTED` (or the arm's
  declared data-dependent `CONSTRAINT` / `MISMATCH`) with a non-empty, table/column-sited
  message.

The matrix forbids the third outcome — "statement succeeds but nothing changed" — which is
the silent-divergence signature. Assert it by reading back `table_info` / a probe query
after the ALTER and verifying the claimed change actually took effect when the statement did
not throw.

## Matrix (expected outcomes — derived from the audit inventory)

| Arm | memory | store |
| --- | --- | --- |
| `addColumn` (nullable / with DEFAULT) | honored | honored |
| `addColumn NOT NULL` no default, non-empty | clean reject (`CONSTRAINT`, engine pre-check) | clean reject (`CONSTRAINT`) |
| `dropColumn` | honored | honored |
| `renameColumn` | honored | honored |
| `alterPrimaryKey` | honored via engine rebuild (memory throws `UNSUPPORTED`, engine catches) | honored in place |
| `addConstraint UNIQUE` / `FOREIGN KEY` | honored | honored |
| `addConstraint CHECK` (other types) | honored | clean reject (`UNSUPPORTED`) |
| `dropConstraint` / `renameConstraint` | honored | honored |
| `alterColumn SET/DROP NOT NULL` | honored / data-dependent `CONSTRAINT` | same |
| `alterColumn SET DATA TYPE` (lossy) | honored / data-dependent `MISMATCH` | same |
| `alterColumn SET DEFAULT` | honored | honored |
| `alterColumn SET COLLATE` non-PK UNIQUE | honored (revalidates) | honored (revalidates) |
| `alterColumn SET COLLATE` **PK column → divergent collation** | honored (re-keys) | **deferred cell — excluded here** |

**The PK-collation cell is intentionally NOT asserted in this ticket.** Today the store
silently diverges there; that is the open gap `store-pk-collate-module-capability` resolves
(it will land either honored-logical or clean-reject). Add the cell as a `skip`/`xfail` with
an inline comment pointing at that ticket, so the harness has the slot ready and the harness
itself stays green and independent. When `store-pk-collate` lands it flips the cell on.

## Edge cases & interactions

- **"Succeeded but no-op" detection must be real, not assumed.** After a non-throwing ALTER,
  re-read the schema (`table_info`, `pragma`-equivalent, or a behavioral probe — e.g. insert
  a now-violating row and expect rejection) to confirm the change is in force. A test that
  only asserts "did not throw" would itself mask divergence.
- **Populated vs empty tables.** Several arms (NOT-NULL add, lossy type change, collation
  re-validate) only exercise their mandate against existing rows — seed ≥2 rows, including a
  collision pair for the collation/UNIQUE cells, so the honored/reject branch is actually hit.
- **Isolation wrapper.** Run the matrix a third time over isolation-wrapped memory. It
  forwards `alterTable` to the underlying, so outcomes should match memory; additionally
  cover the wrapper-specific path where an open transaction has staged overlay rows (the
  issuer-own pre-validation / foreign-overlay poison in `isolation-module.ts:650`). At
  minimum assert the wrapper does not turn a memory `UNSUPPORTED`/`CONSTRAINT` into a silent
  success.
- **`alterTable` absent entirely.** Cover a stub module with no `alterTable`: every arm must
  surface the engine's sited `UNSUPPORTED` ("does not support ALTER …"), not a crash.
- **Data-dependent throws are conformant.** `CONSTRAINT` (NOT NULL backfill, UNIQUE collide)
  and `MISMATCH` (lossy type) are *correct* outcomes, not failures — assert on the code, and
  do not treat them as the divergence the matrix forbids.
- **Store path cost.** Driving the store module pulls in `@quereus/store`; use the existing
  in-memory KV provider used by `quereus-store/test` so the harness stays in the fast
  `yarn test` lane and does not require LevelDB. If wiring the store into a
  `packages/quereus` test is awkward, place the store leg in `packages/quereus-store/test`
  and keep the memory/isolation legs in `packages/quereus` — note the split in the spec.
- **Flag demotion is doc/comment-only behavior-wise.** Marking the five flags advisory must
  not change any engine path (none reads them today). Keep `capabilities.spec.ts` /
  `isolated-store.spec.ts` assertions working — they assert the *values modules report*,
  which is fine; just ensure the advisory comment doesn't break the typed shape.

## TODO

- Add `packages/quereus/test/alter-table-conformance.spec.ts` driving the matrix above over
  memory and isolation-wrapped memory via real `ALTER TABLE` SQL, with the post-ALTER
  read-back that detects silent no-ops.
- Add the store leg (in `quereus` if the in-memory provider wires cleanly, else in
  `quereus-store/test`), reusing the in-memory KV provider so it stays in `yarn test`.
- Add the `alterTable`-absent stub-module case asserting the engine's sited `UNSUPPORTED`.
- Add the PK-collation store cell as `skip`/`xfail` with a comment referencing
  `store-pk-collate-module-capability`.
- In `capabilities.ts`, group/annotate `isolation`, `savepoints`, `persistent`,
  `secondaryIndexes`, `rangeScans` as advisory (engine does not consult them) and keep
  `delegatesNotNullBackfill` / `permitsGrandfatheredCheckViolators` documented as binding
  gates. No behavior change.
- Run `yarn test` and `yarn workspace @quereus/quereus run lint` (single-quote globs on
  Windows); stream output with `Tee-Object`.
