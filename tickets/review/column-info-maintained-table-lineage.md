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

## Implement handoff (2026-06-12)

Implemented. `deriveColumnInfo` (src/func/builtins/schema.ts) branches on `table.derivation` presence (structural, no name patterns) and routes through a new shared `deriveBodyColumnRows` helper — the same `updateLineage`/`baseSiteOf` walk the plain-view branch uses, so classification is reused not duplicated; registered column names are authoritative (positional override). Plan-failure degrades to conservative all-NO rows. `view_info` still excludes maintained tables (documented as deliberate). Note: an invertible expression column (`v + 1 as vp`) reports updatable=YES via its inverse — the ticket's `x + 1` read-only example predates inverse profiles; test uses a genuinely non-invertible `v * 2` for the NO case, with dynamic-agreement writes verifying each verdict. Tests in `test/logic/06.3.5-column-info.sqllogic`; docs updated (materialized-views.md write-boundary cross-ref; view-updateability.md stale claims fixed). Full suite 5909 passing.

NOTE for reviewer: the implement diff for this ticket is NOT under its own commit — a concurrent runner commit (c04e512e, "ticket(implement): maintained-table-attach-detach-verbs") swept these changes in along with ticket 6.2's work. Review the files named above within that commit.
