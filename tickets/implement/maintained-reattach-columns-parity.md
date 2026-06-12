description: Make the re-attach verb (`alter table … set maintained as`) record `derivation.columns` consistently with the create path (implicit/`undefined`), and collapse the differ's dual-hash tolerance (`maintainedBodyMatches`) to a single as-authored hash. Removes the 6.3 band-aid that papered over the create-vs-attach `columns` inconsistency.
files:
  - packages/quereus/src/runtime/emit/alter-table.ts                 # runSetMaintained — stop recording live.columns; record undefined
  - packages/quereus/src/schema/schema-differ.ts                     # maintainedBodyMatches + applyMaintainedTransition — drop the liveColumnNames dual variant
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # attachMaintainedDerivation docstring (recordedColumns contract)
  - packages/quereus/test/maintained-table-attach-detach.spec.ts     # the attach → persist → reopen pin currently asserts EXPLICIT `maintained (id, v)`
  - packages/quereus/test/declarative-equivalence.spec.ts            # add: unchanged sugar MV stays a no-op after a prior re-attach
difficulty: medium
----

# Re-attach `derivation.columns` parity (create vs attach)

## Background

A maintained table's `derivation.columns` is the lossless implicit/explicit
shape signal:

- `undefined` ⇒ **implicit** ("the body owns the shape"; the canonical
  table-form DDL omits the `maintained (…)` rename list and the table reshapes
  to follow its source on reopen);
- a names array ⇒ **explicit** (an MV-sugar / table-form rename list; arity-
  locked, the clause is emitted).

`buildTableDerivation` (`materialized-view-helpers.ts`) hashes `columns`
literally into `bodyHash = computeBodyHash(viewDefinitionToCanonicalString(columns,
select, defaults))`, so the recorded form changes the hash.

The **create** path records the implicit form for an MV-sugar table
(`create materialized view m as select id, x` → `columns: undefined`). The
**re-attach verb** path records the **explicit** table column names:
`runSetMaintained` passes `live.columns.map(c => c.name)` to
`attachMaintainedDerivation`. So a sugar MV that is re-attached flips its
recorded form from implicit to explicit, and its `bodyHash` diverges from the
declared (implicit) form. Both are individually fixed points (persist/import
round-trip each faithfully — the `mv-table-form-implicit-columns-roundtrip`
ticket landed that), but they differ from each other.

The 6.3 differ works around this in `maintainedBodyMatches`: for an implicit
**declared** body (`declared.columns === undefined`) it accepts EITHER the
as-authored hash (`columns: undefined`) OR the hash recomputed with the live
table's column names — so a re-applied unchanged sugar MV stays idempotent
whichever form the verb happened to record. That dual-hash tolerance is the
band-aid this ticket removes.

## The fix

The re-attach verb's strict declared-shape check
(`describeAttachShapeMismatch(table, shape, /*skipNames*/ false)`) **guarantees**
the body's natural output names already equal the table's column names — the
verb has no rename-list syntax, so a body whose names differ is rejected, not
recorded. Therefore recording the **implicit form (`undefined`)** is lossless
for the verb and identical to what create-sugar records. The body's natural
names equal the table columns ⇒ implicit, exactly the create-path rule.

With the verb recording `undefined`:

- a sugar MV's recorded form no longer flips on re-attach (implicit before and
  after) → re-applying an unchanged schema computes the same implicit `bodyHash`
  → no spurious re-attach;
- the persist → import round-trip stays a fixed point — now an **implicit** one:
  `generateMaintainedTableDDL` emits the bare `maintained as …` (no rename list),
  `maintainedImportFromTableStmt` restores `columns: undefined`. No persist/import
  changes are needed (already covered by the live-exec table-form tests in
  `maintained-table-attach-detach.spec.ts`);
- `maintainedBodyMatches` collapses to a single as-authored hash:
  `const variants = [declared.columns]` — the `liveColumnNames` fallback (and its
  threaded parameter) is deleted.

### Explicit declared forms are unaffected

`maintainedBodyMatches`'s explicit branch (`declared.columns !== undefined ⇒
[declared.columns]`) is unchanged, so a never-changed explicit table-form / sugar
rename (`maintained (a, b)`) still matches its explicit live hash with no churn.
A genuine rename-list change on an explicit form (`mv (a,b)` → `mv (a,c)`) is a
separate, currently-pinned limitation tracked by
`maintained-reattach-explicit-rename-list-reshape` (backlog) — out of scope here.

### Backwards compatibility

Per AGENTS.md ("Don't worry about backwards compatibility yet"), a pre-existing
persisted DB that recorded explicit verb columns under the old behavior is not a
migration concern — it re-imports through the canonical DDL, which is regenerated
from the (now implicit) record on the next persist.

## Edge cases & interactions

- **Fresh attach to a plain table** (`set maintained as` where the table was
  plain): the strict name check still applies, so the body must alias to the
  plain table's declared column names; recording `undefined` is correct (body
  names == table columns). No reshape here — that is the sibling ticket.
- **Re-attach over identical content**: the verify-by-diff fidelity tests
  (`maintained-table-attach-detach.spec.ts` "attach over IDENTICAL content
  writes nothing") must stay green — recording `undefined` changes only the
  recorded `columns`/`bodyHash`, never the reconcile.
- **`create table … maintained (cols) as` (explicit table form)** and
  **`create materialized view m (a,b) as` (explicit sugar)**: still record the
  declared names (explicit). Unchanged — this ticket touches only the
  `runSetMaintained` verb path, not `createMaintainedTable`.
- **The attach → `importCatalog` bodyHash fixed point**
  (`maintained-table-attach-detach.spec.ts` "an attach-created derivation
  round-trips through importCatalog") MUST stay green — but its *assertion of the
  exported DDL shape changes* from explicit `maintained (id, v) as` to the
  implicit `maintained as` (no rename list). Update the regex (line ~229) and
  keep the `bodyHash` / byte-identical-export assertions.
- **In-diff rename reconciliation**: `maintainedBodyMatches` still re-compares
  each (now single) variant under `reconciledDeclaredViewDefinition` when
  table/column renames are present, so a pure source rename converges via the
  rename propagation, not a re-attach. Keep that arm; only the `liveColumnNames`
  variant is removed.
- **`applyMaintainedTransition` signature**: `liveColumnNames` is threaded in
  (`computeTableAlterDiff` passes `actualTable.columns.map(c => c.name)`) ONLY to
  reach `maintainedBodyMatches`. Remove it from both signatures and the call site
  once the variant is gone — confirm it has no other reader.

## TODO

- In `runSetMaintained` (`alter-table.ts`): change the
  `attachMaintainedDerivation(rctx.db, live, select, insertDefaults,
  live.columns.map(c => c.name))` call to pass `undefined` for `recordedColumns`.
  Rewrite the leading comment to explain: the verb has no rename-list syntax and
  the strict name check guarantees body names == table columns, so the implicit
  form is recorded (consistent with create-sugar).
- In `schema-differ.ts`: reduce `maintainedBodyMatches`'s `variants` to
  `[declared.columns]`; delete the `liveColumnNames` parameter and the dual-hash
  fallback. Update its docstring (remove the create-vs-attach inconsistency note
  and the "tracked for a verb-side cleanup" sentence).
- Remove `liveColumnNames` from `applyMaintainedTransition` and the
  `computeTableAlterDiff` call site (line ~1916) if it has no remaining reader.
- Update `attachMaintainedDerivation`'s docstring (`materialized-view-helpers.ts`)
  where it says the attach verb records "the declared column names for the
  explicit forms (the attach verb, …)": the attach verb now records `undefined`
  (implicit). Keep the create-form (`positionalRename`) explicit-recording
  description intact.
- Update `maintained-table-attach-detach.spec.ts`:
  - "an attach-created derivation round-trips through importCatalog" — change the
    exported-DDL assertion from `/maintained \(id, v\) as/i` to assert the bare
    `/maintained as /i` form and `not.match(/maintained \(/i)`; update the inline
    comment (attach now records the IMPLICIT form). Keep the `bodyHash` fixed
    point and byte-identical-export assertions.
- Add a regression to `declarative-equivalence.spec.ts` (acceptance bullet 1):
  declare a sugar MV (`materialized view mv as select id, x from t`), `apply
  schema`, then force a re-attach (e.g. a content-only divergence via a direct
  source change, or a redundant `apply schema` after a no-op body edit and back),
  and assert a subsequent `computeSchemaDiff` of the UNCHANGED declaration yields
  no `setMaintained` on `mv` and no drop — proving the differ no longer churns
  now that the verb records implicit. (Simplest construction: attach via the verb
  `alter table … set maintained as <same body>`, then diff the declared sugar MV
  against the catalog and assert no re-attach.)
- Run: `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/parity.log; tail -n 60 /tmp/parity.log`
  and `yarn workspace @quereus/quereus run lint` (single-quote globs on Windows).
