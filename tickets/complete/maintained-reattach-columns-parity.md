description: Complete — the re-attach verb (`alter table … set maintained as`) now records `derivation.columns` as the implicit form (`undefined`), matching the create path; the differ's dual-hash tolerance (`maintainedBodyMatches`'s `liveColumnNames` variant) is collapsed to a single as-authored hash. Create-vs-attach `columns` parity confirmed, no spurious re-attach churn, explicit-rename-list branch untouched.
files:
  - packages/quereus/src/runtime/emit/alter-table.ts                 # runSetMaintained — passes `undefined` for recordedColumns
  - packages/quereus/src/schema/schema-differ.ts                     # maintainedBodyMatches (variants → [declared.columns]) + applyMaintainedTransition (liveColumnNames param dropped) + 2 call sites
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # attachMaintainedDerivation docstring (recordedColumns contract)
  - packages/quereus/test/maintained-table-attach-detach.spec.ts     # importCatalog round-trip — exported DDL assertion flipped to implicit `maintained as`
  - packages/quereus/test/declarative-equivalence.spec.ts            # new regression: verb re-attach of a sugar MV records implicit ⇒ unchanged declaration does not churn
  - docs/materialized-views.md                                       # SET MAINTAINED AS section — verb records the implicit form
----

# Complete: re-attach `derivation.columns` parity (create vs attach)

## What the change does

The re-attach verb (`runSetMaintained` in `alter-table.ts`) previously recorded the
**explicit** live table column names (`live.columns.map(c => c.name)`) as
`derivation.columns`, while the create-sugar path recorded the **implicit** form
(`undefined`). A sugar MV re-attached via the verb therefore flipped its recorded
form implicit→explicit, diverging its `bodyHash` from the (implicit) declared form.
The 6.3-era differ papered over this with a dual-hash tolerance in
`maintainedBodyMatches` (accept EITHER the as-authored hash OR the hash recomputed
with the live column names).

This ticket removed the root cause: the verb now records `undefined`, and the
`liveColumnNames` variant (plus the threaded `applyMaintainedTransition` parameter
and both `computeTableAlterDiff` call sites) is deleted. The in-diff
rename-reconcile arm (`reconciledDeclaredViewDefinition`) is kept.

## Review findings

The adversarial pass read the full implement diff (`a3316d43`) with fresh eyes
before the handoff, traced the load-bearing invariant into the source, checked both
call paths, and ran lint + the full test suite. Result: **the implementation is
correct, complete, and well-tested. No minor fixes were needed and no blocking
issues were found.** One obscure pre-existing-class edge was identified and mapped
to the existing backlog ticket (below).

### What was checked and what was found

- **Core invariant (recording `undefined` is lossless for the verb) — VERIFIED.**
  Traced into `describeAttachShapeMismatch(table, shape, /*skipNames*/ false)`
  (`materialized-view-helpers.ts`): with `positionalRename` false (the verb path) it
  performs a per-column NAME comparison and rejects any body whose natural output
  names differ from the table's declared columns. So a recorded body always has
  `body names == table columns`; the implicit canonical string
  (`viewDefinitionToCanonicalString(undefined, …)` — confirmed to omit the `(cols)`
  rename list only when `columns?.length`) is therefore identical to what
  create-sugar records, and `buildTableDerivation`'s `bodyHash` matches. The claim
  holds — implicit is lossless here, not a lossy approximation.

- **`maintainedBodyMatches` collapse — CORRECT.** `const variants = [declared.columns]`
  is a single-element array still iterated in the `for…of` with the
  rename-reconcile arm inside. Verified the reconcile arm (`hasRenames && …
  reconciledDeclaredViewDefinition`) is byte-for-byte preserved — the
  "rename does not churn a re-attach" tests depend on it and stay green. A genuine
  body/clause edit (including an explicit rename-list change b→c) still fails the
  compare, so nothing is masked. The single-element loop is correct; left as-is to
  preserve the reconcile arm verbatim (the implementer's noted stylistic call —
  agreed, not worth churning).

- **Both `attachMaintainedDerivation` callers — AUDITED.** Only two exist:
  `runSetMaintained` (verb → now `undefined`, fixed) and `createMaintainedTable`
  (→ `explicit ? table.columns.map(c => c.name) : undefined`, untouched and
  correct — the explicit `maintained (cols)` / `mv (a,b)` create forms still record
  the declared names). The explicit create path is genuinely unaffected, as the
  ticket claimed.

- **importCatalog round-trip — VERIFIED IMPLICIT FIXED POINT.** The
  `maintained-table-attach-detach.spec.ts` round-trip test (exported DDL flipped to
  `/create table .* maintained as /i` + `not.match(/maintained \(/i)`, `bodyHash`
  fixed-point + byte-identical-export assertions unchanged) passes. No persist/import
  code change was required (`generateMaintainedTableDDL` already emits the bare
  `maintained as` for an implicit record; the import helper restores
  `columns: undefined`) — confirmed by the passing fixed-point test, not just the
  docstring.

- **Regression test soundness — VERIFIED IT GUARDS THE FIX.** The new
  `declarative-equivalence.spec.ts` test's first assertion (verb re-attach ⇒ bodyHash
  unchanged) is the discriminating one: under the old behavior the verb recorded
  `[id, x]` and the hash would diverge, failing the test. The second assertion (no
  setMaintained on the unchanged declaration) is correct but would also have passed
  under the old band-aid — noted as non-discriminating, not a defect.

- **Edge cases / error paths — EXERCISED.** Explicit-form round-trips, the
  rename-does-not-churn suite, the explicit rename-list "known limitation" test, and
  the verify-by-diff fidelity tests (attach-over-identical writes nothing /
  attach-over-divergent dispatches the minimal keyed diff) all stay green — recording
  `undefined` changes only the recorded `columns`/`bodyHash`, never the reconcile.

- **Docs — READ AND CONFIRMED CURRENT.** The `docs/materialized-views.md` addition
  and the `attachMaintainedDerivation` docstring accurately describe the new
  recordedColumns contract (implicit for both create-sugar and the verb). No stale
  references to the old explicit-verb behavior remain in the touched files.

### Findings filed

- **Minor (fixed inline): none.** The diff needed no corrective edits.

- **Major (new ticket): none.** One obscure edge was identified but maps to an
  existing backlog ticket (see below), so no new ticket was filed.

### Identified edge — subsumed by an existing backlog ticket (no new ticket)

A **redundant-explicit** declared MV whose rename list already equals its body's
natural names — e.g. `materialized view mv (id, x) as select id, x` — that is then
**manually** re-attached via the verb (`alter table mv set maintained as select id,
x`) flips its live record implicit while the declaration stays explicit. The next
declarative diff compares declared-explicit `[id, x]` against live-implicit
`undefined`, whose canonical strings differ, and emits a re-attach that never
converges (each verb re-attach re-records implicit). Before this ticket the verb
recorded the matching explicit names, so this narrow case did not churn.

Assessment — **acceptable for the current phase, no new ticket:**
- **No data loss / no correctness failure** — the emitted re-attach succeeds (body
  names match the table columns); it is purely a non-converging idempotency churn.
- **Requires mixing the imperative verb with declaratively-managed schema** over an
  unusual redundant-explicit declaration — purely declarative workflows never reach
  it (declarative create of an explicit MV records explicit, matching).
- **Same root gap** as the open backlog ticket
  `maintained-reattach-explicit-rename-list-reshape`: `CatalogTable.maintained`
  surfaces only `bodyHash`, not `derivation.columns`, so the differ cannot compare
  the implicit/explicit representation directly. That ticket's recommended approach
  (surface `derivation.columns`, reconcile in the differ) resolves this edge as a
  by-product. Folding it there avoids a duplicate ticket for the same prerequisite.

### Out of scope (confirmed, unchanged by this ticket)

- **Explicit rename-list reshape via the verb** (`mv (a,b)` → `mv (a,c)`) still emits
  a re-attach the verb cannot apply — pinned by the existing "known limitation" test
  and tracked by `maintained-reattach-explicit-rename-list-reshape`.

## Validation performed (review pass, re-run from scratch)

- `yarn workspace @quereus/quereus run lint` → **clean (exit 0)**.
- `yarn workspace @quereus/quereus run build` (tsc) → **clean (exit 0)**.
- The two touched spec files in isolation → **147 passing**.
- `yarn workspace @quereus/quereus test` (full memory-backed suite) →
  **6015 passing, 9 pending**.

## Deferred (not run, documented per ticket wall-clock guidance)

- **`yarn test:store`** (slower LevelDB-store path) was NOT run — not in the ticket's
  run list and slow per the agent-runnable guidance. The recorded-columns change flows
  through the backing-agnostic `generateMaintainedTableDDL` / import path, which the
  memory-backed importCatalog round-trip already exercises; a store-path run (CI /
  out-of-band) would close the loop on persistence under a real store module. The
  reviewer concurs this is acceptable to defer.
- **Pre-existing persisted DBs** that recorded explicit verb columns under the old
  behavior re-import through the canonical DDL (regenerated from the now-implicit
  record on the next persist); no migration code is needed for the current phase
  (AGENTS.md: backwards compatibility deferred). Reviewer concurs.

## Pre-existing diagnostics (not this ticket)

- `alter-table.ts` `rebuildViaShadowTable` declares an unused `schema` parameter
  (TS6133) — outside this diff (PK-rebuild path), does not fail lint or tsc, predates
  the ticket. Left untouched.

## End
