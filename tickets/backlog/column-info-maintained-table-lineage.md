description: column_info('mv') should report a maintained table's columns through the view-lineage surface (per-column updateability), not as plain base columns
files:
  - packages/quereus/src/func/builtins/schema.ts   # deriveColumnInfo — base-table branch currently wins for maintained tables
  - packages/quereus/src/schema/derivation.ts      # TableDerivation (body AST for lineage derivation)
difficulty: easy
----

# column_info on a maintained table: lineage fidelity

Since the unified maintained-table model, `column_info('mv')` resolves a
materialized view through the **base-table branch** and reports its registered
columns as ordinary updatable base columns (pre-unification the MV name was not
a table, so it threw not-found — consistent with `view_info` excluding MVs).

That overstates updateability: write-through to a maintained table inherits the
view-updateability rules, so a **deterministic-expression** output column (e.g.
`x + 1 as y`) is read-only (`no-inverse` on write), and a column pinned by an
equality selection predicate has constrained insert semantics. `column_info`
should reflect that per-column reality rather than presenting every column as a
writable base column.

Expected behavior:

- `column_info('mv')` derives per-column lineage from the derivation body (the
  same classification the write-through rewrite applies): passthrough/rename
  columns report their base column and updatable=yes; expression columns report
  updatable=no.
- `view_info` continues to exclude maintained tables (its per-view lineage
  surface stays plain-view-only), or is extended deliberately — either way the
  two functions should tell one consistent story.
- Document the chosen surface in docs/materialized-views.md (write-boundary
  section cross-reference).
