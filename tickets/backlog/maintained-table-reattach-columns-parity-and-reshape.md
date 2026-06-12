description: Re-attach verb (`alter table … set maintained as`) gaps surfaced by the 6.3 differ work — (1) it records `derivation.columns` inconsistently with the create path (explicit vs implicit), which 6.3 works around differ-side; (2) it cannot reshape a sugar maintained table's columns (output-column rename / rename-list change errors at apply). A verb-side fix would let the differ drop its tolerance and fully support shape-changing body edits on sugar MVs.
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # attachMaintainedDerivation: def.columns = table.columns (explicit); describeAttachShapeMismatch shape check
  - packages/quereus/src/runtime/emit/materialized-view.ts           # create path: def.columns = plan.columns (implicit/undefined for sugar)
  - packages/quereus/src/schema/schema-differ.ts                     # maintainedBodyMatches() — the differ-side tolerance that papers over the inconsistency
  - packages/quereus/src/schema/manager.ts                           # maintainedImportFromTableStmt (the import-path columns convention the verb mirrors)
  - packages/quereus/test/declarative-equivalence.spec.ts            # "a column-list (rename) change on a sugar MV emits a re-attach the verb cannot apply" pins the limitation
  - packages/quereus/test/maintained-table-attach-detach.spec.ts     # attach→importCatalog bodyHash fixed-point guard
----

# Re-attach: implicit-shape columns parity + reshape limitation

> **Update (post `mv-table-form-implicit-columns-roundtrip`):** the canonical
> table form now carries a lossless `maintained [(columns)]` rename-list clause
> (presence ⇒ explicit/arity-locked, absence ⇒ implicit/reshape-on-reopen);
> persist and import round-trip `derivation.columns` faithfully through it, and
> the attach verb's explicit recording is pinned by
> `maintained-table-attach-detach.spec.ts` (attach → persist → reopen is an
> explicit fixed point — no longer "permanently diverging"). §1 below is
> therefore no longer a round-trip bug, only the create-vs-attach
> representation inconsistency that keeps the differ's dual-hash tolerance
> alive; any §1 fix must either keep the verb explicit or update those pins
> deliberately.

Surfaced while landing ticket 6.3 (maintained-table differ transitions). The
declarative differ now treats every maintained-table body change as a re-attach
(`alter table … set maintained as <body>`). Two properties of the re-attach
**verb** (from ticket 6.2) limit that:

## 1. `derivation.columns` parity (create vs attach)

The CREATE path records `derivation.columns = plan.columns` — `undefined` for an
MV-sugar table (`create materialized view m as select id, x`). The RE-ATTACH path
(`attachMaintainedDerivation`, `materialized-view-helpers.ts`) records the
**explicit** table column names (`table.columns.map(c => c.name)`). Because
`bodyHash = computeBodyHash(viewDefinitionToCanonicalString(columns, select,
defaults))` includes the column list literally, a re-attached sugar MV's
`bodyHash` permanently diverges from its declared (implicit) form — so a re-apply
of an UNCHANGED schema would spuriously re-attach every time (non-idempotent),
and the sugar vs table-form hashes disagree.

**6.3 works around this in the differ** (`maintainedBodyMatches`): for an implicit
declared body it accepts EITHER the as-authored hash (columns `undefined`) OR the
hash computed with the live table's column names — so idempotence holds either
way. This is a band-aid. The clean fix is to make the verb record `columns`
consistently with create (record the implicit form — `undefined` — when the
body's natural output names already equal the table's column names), coordinated
with the import path (`maintainedImportFromTableStmt`) so create → attach →
persist → reopen all canonicalize identically. The attach → `importCatalog`
bodyHash fixed-point test must stay green. Once the verb is consistent, the
differ's dual-hash tolerance can be deleted.

## 2. Re-attach cannot reshape a sugar MV's columns

`set maintained as` has a strict shape check (the body output names must match the
table's current columns) and **no rename-list syntax**. So on a sugar maintained
table:

- a body change that **renames an output column** (`select id, x` → `select id,
  y`) errors at apply (`cannot attach derivation … body output column 2 is named
  'y' but the table declares 'x'`);
- a change to the **explicit rename list** (`mv (a, b)` → `mv (a, c)`) emits a
  re-attach whose body can't carry the new names → the same shape-mismatch error.

The plan-free differ correctly emits a re-attach (it cannot derive the body's
output shape to know a reshape is needed). Today the workaround is "use the
declared-shape table form, or drop+recreate manually." A real fix is one of:

- give the re-attach verb a **reshape-on-attach** capability for implicit-shape
  (sugar) maintained tables — mirror the lenient reshape the reopen path already
  does ("a widened `select *` reshapes on reopen") so the backing columns follow
  the new body; or
- have the differ **detect a rename-list change** (compare the declared
  `maintained.columns` against the live derivation's recorded columns — surfaced
  in the catalog) and emit `drop maintained → column rename ops → set maintained
  as`, the documented "re-attach with column drift" path the table form already
  takes.

Shape-PRESERVING body changes (value / source / filter, or aliasing to keep the
output names) re-attach correctly today and are covered by tests. Only
output-name-changing edits on the sugar form are blocked.

## Acceptance

- Re-applying an unchanged sugar MV stays a no-op even after a prior re-attach,
  with the differ's `maintainedBodyMatches` reduced to a single as-authored hash
  (the verb is now consistent).
- A body change that renames a sugar MV's output column applies (reshape) or is
  emitted by the differ as detach → rename → re-attach, instead of erroring.
- The attach → `importCatalog` bodyHash fixed-point and the full declarative
  suite stay green.
