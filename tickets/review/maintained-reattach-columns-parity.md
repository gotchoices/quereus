description: Review — the re-attach verb (`alter table … set maintained as`) now records `derivation.columns` as the implicit form (`undefined`), matching the create path; the differ's dual-hash tolerance (`maintainedBodyMatches`'s `liveColumnNames` variant) is collapsed to a single as-authored hash. Verify the create-vs-attach `columns` parity, that no spurious re-attach churn returns, and that the explicit-rename-list branch is untouched.
files:
  - packages/quereus/src/runtime/emit/alter-table.ts                 # runSetMaintained — now passes `undefined` for recordedColumns
  - packages/quereus/src/schema/schema-differ.ts                     # maintainedBodyMatches (variants → [declared.columns]) + applyMaintainedTransition (liveColumnNames param dropped) + 2 call sites
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # attachMaintainedDerivation docstring (recordedColumns contract)
  - packages/quereus/test/maintained-table-attach-detach.spec.ts     # importCatalog round-trip — exported DDL assertion flipped to implicit `maintained as`
  - packages/quereus/test/declarative-equivalence.spec.ts            # new regression: verb re-attach of a sugar MV records implicit ⇒ unchanged declaration does not churn
  - docs/materialized-views.md                                       # SET MAINTAINED AS section — note the verb records the implicit form
difficulty: medium
----

# Review: re-attach `derivation.columns` parity (create vs attach)

## What changed and why

A maintained table's `derivation.columns` is the lossless implicit/explicit shape
signal: `undefined` ⇒ implicit (the body owns the shape; canonical DDL omits the
`maintained (…)` rename list and the table reshapes its source on reopen); a names
array ⇒ explicit (arity-locked, the clause is emitted). `buildTableDerivation`
hashes `columns` into `bodyHash`, so the recorded form changes the hash.

Before this ticket the **create** path recorded the implicit form for a sugar MV
(`create materialized view m as select id, x` → `columns: undefined`), but the
**re-attach verb** (`runSetMaintained`) recorded the **explicit** live table column
names (`live.columns.map(c => c.name)`). So a sugar MV re-attached via the verb
flipped its recorded form implicit→explicit, diverging its `bodyHash` from the
declared (implicit) form. Both were individually fixed points, but they differed
from each other. The 6.3 differ papered over this in `maintainedBodyMatches` with a
**dual-hash tolerance**: for an implicit declared body it accepted EITHER the
as-authored hash OR the hash recomputed with the live column names.

The fix removes the root cause instead of the band-aid:

- **`runSetMaintained` now records `undefined`.** The verb has no rename-list
  syntax, and its strict declared-shape check (`describeAttachShapeMismatch(table,
  shape, /*skipNames*/ false)`) guarantees the body's natural output names already
  equal the table's column names — a body whose names differ is *rejected, not
  recorded*. So the implicit form is lossless for the verb and identical to what
  create-sugar records.
- **`maintainedBodyMatches` collapses to `const variants = [declared.columns]`.**
  The `liveColumnNames` parameter (and the threaded `applyMaintainedTransition`
  param + both `computeTableAlterDiff` call sites) is deleted. The in-diff
  rename-reconcile arm (`reconciledDeclaredViewDefinition`) is **kept** — only the
  live-names variant is removed.

No persist/import changes were needed: `generateMaintainedTableDDL` already emits
the bare `maintained as …` for an implicit record, and `maintainedImportFromTableStmt`
restores `columns: undefined`.

## Use cases / behaviors to validate

These are the floor, not the finish line — the reviewer should probe beyond them.

1. **Create-vs-attach parity (the core invariant).** A sugar MV created, then
   re-attached via the verb with the SAME body, keeps `derivation.columns === undefined`
   and an unchanged `bodyHash`. The new regression in `declarative-equivalence.spec.ts`
   ("a sugar MV re-attached via the verb (same body) records the IMPLICIT form…")
   asserts the bodyHash is unchanged across the verb re-attach AND that a subsequent
   `computeSchemaDiff` of the unchanged declaration yields no `setMaintained` on `mv`
   and no drop.
2. **No spurious re-attach churn.** With the band-aid gone, idempotency now depends
   on the verb recording implicit. Confirm a redundant `apply schema` over a
   verb-attached sugar MV produces an empty diff (covered by #1 and the existing
   "re-applying an unchanged MV is a no-op" test).
3. **importCatalog round-trip is now an IMPLICIT fixed point.** The
   `maintained-table-attach-detach.spec.ts` "an attach-created derivation round-trips
   through importCatalog (bodyHash fixed point)" test's exported-DDL assertion flipped
   from `/maintained \(id, v\) as/i` to `/create table .* maintained as /i` +
   `not.match(/maintained \(/i)`. The `bodyHash` fixed-point and byte-identical-export
   assertions are unchanged and still green.
4. **Explicit forms are unaffected.** `create table … maintained (cols) as` and
   `create materialized view m (a,b) as` still record the declared names (explicit) —
   this ticket touched only the verb path, not `createMaintainedTable`. The existing
   "explicit column-list MV round-trips" and "MV sugar with an explicit column list
   (renames) round-trips through the table form" tests cover this.
5. **Explicit rename-list change still re-attaches (and still can't be applied by the
   verb).** `maintainedBodyMatches`'s explicit branch is unchanged, so `mv (a,b)` →
   `mv (a,c)` still drifts the hash and emits a re-attach. The "a column-list (rename)
   change on a sugar MV emits a re-attach the verb cannot apply (known limitation)"
   test still passes. That reshape limitation is **out of scope** — tracked by the
   backlog ticket `maintained-reattach-explicit-rename-list-reshape`.
6. **Fresh attach to a plain table.** The strict name check applies, body names must
   equal the plain table's declared columns, recording `undefined` is correct. No
   reshape (that's the sibling ticket).
7. **Re-attach over identical / divergent content.** The verify-by-diff fidelity
   tests ("attach over IDENTICAL content writes nothing", "attach over DIVERGENT
   content dispatches exactly the minimal keyed diff") must stay green — recording
   `undefined` changes only the recorded `columns`/`bodyHash`, never the reconcile.

## Validation performed

- `yarn workspace @quereus/quereus test` → **6015 passing, 9 pending** (full memory-backed suite).
- `yarn workspace @quereus/quereus run lint` → clean (exit 0).
- `yarn workspace @quereus/quereus run build` (tsc) → clean (exit 0).
- The two touched spec files run in isolation → **147 passing**, including the new
  regression and the updated round-trip assertion.

## Known gaps / things for the reviewer to scrutinize

- **`yarn test:store` was NOT run** (slower LevelDB-store path; not in the ticket's
  run list). This change flows through the maintained-table attach + canonical-DDL
  persist/import path, which store-backed catalogs re-persist on
  `materialized_view_modified`. The memory suite covers the importCatalog round-trip,
  and the recorded-columns change goes through the same `generateMaintainedTableDDL`
  / import code regardless of backing — but a store-path run (or CI) would close the
  loop on persistence under a real store module. Flagging, not chasing, per the
  ticket's wall-clock guidance.
- **Pre-existing persisted DBs** that recorded explicit verb columns under the old
  behavior are not a migration concern (AGENTS.md: "Don't worry about backwards
  compatibility yet") — they re-import through the canonical DDL, regenerated from the
  now-implicit record on the next persist. No migration code was added; confirm the
  reviewer agrees this is acceptable for the current phase.
- **`const variants = [declared.columns]`** is now a single-element array still
  iterated in a `for…of` with the rename-reconcile arm inside. Kept structurally
  identical to minimize the diff and preserve the reconcile arm verbatim; a reviewer
  may prefer it inlined, but the loop is correct and the rename arm is load-bearing
  (the "rename does not churn a re-attach" tests depend on it).
- **Pre-existing unrelated diagnostic:** `alter-table.ts` `rebuildViaShadowTable`
  declares an unused `schema` parameter (TS6133). It is outside this diff (PK-rebuild
  path, not the maintained path), does not fail lint or tsc, and predates this ticket.
  Left untouched.
