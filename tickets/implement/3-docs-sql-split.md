description: The SQL reference manual is 28,000 words in one file. Break it into per-topic pages (SELECT, DML, DDL, functions, …) with the main page becoming a short table of contents that links to them.
prereq:
files:
  - docs/sql.md (~28,700 words → becomes a TOC hub)
  - docs/sql-select.md, docs/sql-dml.md, docs/sql-ddl.md, docs/sql-views.md, docs/sql-functions.md, docs/sql-txn.md (new; add docs/sql-grammar.md only if the hub stays over cap)
  - docs/.doc-budget.json (remove or lower the sql.md ratchet entry)
  - docs/.stability.json (classify the new docs — Stable, matching the parent)
  - docs/architecture.md, docs/view-updateability.md, docs/migration.md, docs/stability.md, docs/materialized-views.md (inbound anchors to repoint)
difficulty: medium
----

## What this is — and how it differs from the VU/MV splits

`docs/sql.md` is the last of the three grandfathered megadocs, but it is a **reference
manual, not a design doc**. A reference manual's job is completeness, not reviewability
against the code, so it gets a **split only — no invariant register**. There is no `SQL-*`
area in `docs/invariants.md` and this ticket creates none. (This is the maintainer's
explicit call: *"sql.md is intended primarily as a reference manual. It could be broken
into sql-select.md, sql-agg.md, … with sql.md being a little more of a table of
contents."*)

`docs/sql.md` stays as the **hub**: a short intro, a `## Topic documents` table linking the
satellites, and the cross-cutting reference appendices. Everything else moves out.

This is mechanically the lightest of the three splits: `sql.md` has **zero** source-comment
references in `packages/*/src` (verified — `grep -rn "sql\.md" packages/*/src` is empty), so
there is no code-comment repoint pass. Only inbound *doc* anchors move.

## Target file set

Cut at the numbered section boundaries the doc already uses. Promote each satellite's top
sections to `##`.

| File | Holds (parent sections) |
| --- | --- |
| `docs/sql.md` (hub) | §1 Introduction, a new `## Topic documents` table, §10 Error Handling, §11 Quereus vs. SQLite, §12 EBNF Grammar |
| `docs/sql-select.md` | §2 Query expressions (intro), §2.1 SELECT, §3 Clauses (FROM, WHERE, GROUP BY, HAVING, ORDER BY, LIMIT/OFFSET, WITH), §4 Expressions and Operators |
| `docs/sql-dml.md` | §2.2 INSERT, §2.3 UPDATE, §2.4 DELETE, §2.5 RETURNING with NEW/OLD, conflict resolution (`OR` clause) |
| `docs/sql-ddl.md` | §2.0 Declarative Schema, §2.6 CREATE TABLE (+ §2.6.1 assertions, §2.6.2 mutation context, §2.6.3 metadata tags), §2.7 ALTER TABLE, §6 Virtual Tables, §7 Constraints and Indexes |
| `docs/sql-views.md` | §2.8 CREATE VIEW, §2.9 Updatable Views, §2.10 CREATE MATERIALIZED VIEW, §2.11 Logical Schemas and Lenses |
| `docs/sql-functions.md` | §5 Functions (Scalar, Aggregate, JSON, Date/Time, Window, Table-Valued) |
| `docs/sql-txn.md` | §8 Transactions and Savepoints, §9 PRAGMA Statements |

The hub keeps §10/§11/§12 because they are cross-cutting reference appendices that don't
belong to any one statement class. **Measure the hub after the cut** (`node
scripts/check-docs.mjs`): if it is still over 12,000 words — the dense §12 EBNF Grammar is
the likely cause — move §12 into a new `docs/sql-grammar.md` (Stable) and leave a stub +
link. Do not force-raise the ratchet.

Each satellite lands well under 12,000 (28,700 / 6 ≈ 4,800 average). No satellite needs a
`.doc-budget.json` entry.

## Stability

All satellites are **Stable** (the parent's tier). Add each to `docs/.stability.json` under
`docs` as `"Stable"`. Give each a header banner under its `#` heading:

```markdown
> **Stability: Beta** — see [Stability Tiers](stability.md#tiers).
```

…except the tier word is `Stable`. **One section-level banner override carries across:**
`declare schema` (§2.0 Declarative Schema) is marked **Beta** inside the otherwise-Stable
`sql.md` today (`doc-conventions.md` § The stability banner names this exact case). §2.0
moves to `sql-ddl.md`, so `sql-ddl.md` carries a **section banner** for the Declarative
Schema section (Beta) under its header banner (Stable). Preserve that override — do not
drop it in the move.

## Inbound anchors to repoint (docs only)

`yarn docs:check` names every one. Known set:

- `docs/architecture.md` — `sql.md#query-expressions` (→ `sql-select.md#query-expressions`),
  `sql.md#conflict-resolution-or-clause` (→ `sql-dml.md#…`).
- `docs/view-updateability.md` (or its satellites, if `docs-vu-split` landed first) —
  `sql.md#existence-columns-on-outer-joins` (→ `sql-select.md`, the FROM/outer-join text),
  `sql.md#set-operation-membership-columns` (→ `sql-select.md`),
  `sql.md#conflict-resolution-or-clause` (→ `sql-dml.md`).
- `docs/migration.md`, `docs/materialized-views.md`, `docs/stability.md` — any `sql.md#…`
  or bare `sql.md` links; bare links to the hub need no change, anchored links follow the
  section to its satellite.

Fix the link **label** wherever it names the document, and hold word counts flat in the
edited docs so their ratchet entries still pass.

## TODO

Phase 1 — cut
- Snapshot the pre-split heading set (`git show HEAD:docs/sql.md`).
- Create the six satellites, moving each section verbatim, promoting depth by one, adding a
  header banner (Stable) to each. Carry the §2.0 Beta section banner into `sql-ddl.md`.
- Rebuild `sql.md` as the hub: intro, `## Topic documents` table, §10/§11/§12. Leave a
  stub + link at each moved top-level section.

Phase 2 — reclassify + rebudget
- Add the satellites to `docs/.stability.json` (`Stable`).
- Remove the `docs/sql.md` entry from `docs/.doc-budget.json` if the hub is now under
  12,000; else split §12 into `sql-grammar.md` and re-measure. Lower with
  `node scripts/check-docs.mjs --update-ratchet` only if a small entry remains.

Phase 3 — repoint inbound anchors
- Repoint every inbound `sql.md#…` link listed above; fix labels.

Phase 4 — verify
- `yarn docs:check` green (links, anchors, sizes, stability classification of the new docs).
- Every `##`/`###`/`####` heading from the pre-split file appears in exactly one file
  (diff against the Phase-1 snapshot); the only additions are the satellite titles, stubs,
  and `## Topic documents`.
- `yarn lint` and `yarn test` green. This ticket touches only Markdown + two JSON config
  files — no source — so `yarn test:full` is not required; say so in the handoff.

## Edge cases & interactions

- **Internal cross-references become cross-file links.** `sql.md` is dense with same-page
  `](#anchor)` links between sections that now live in different files (e.g. INSERT →
  Constraints, SELECT → Functions). Every such link must gain the satellite filename.
  `docs:check` catches a dead anchor but **not** a link left pointing at a stub — repoint to
  real content and park the same stub-ambiguity `NOTE:` tripwire above `## Topic documents`
  that the MV split used.
- **Heading-text slugs.** Promoting `###` to `##` preserves the GitHub slug; tidying a
  heading's *text* during the move silently breaks its anchor. Move text verbatim.
- **§2.0 section banner.** The Declarative Schema Beta override must survive into
  `sql-ddl.md`; the checker enforces "never more than one banner in the window below the
  H1" for the header banner, and a section banner must sit under its own section heading —
  place it correctly or the stability check fails.
- **VU/sql.md overlap.** `docs-vu-split` also edits `docs/sql.md` (its VU anchors) and
  `docs/view-updateability.md` links into `sql.md`. No `prereq` between the two; whichever
  lands second rebases onto the other. If VU landed first, its links point into these new
  `sql-*.md` files — verify they resolve after this split rather than assuming the old
  `sql.md#` targets.
- **EBNF grammar comments.** §12's grammar has inline `(* … see view-updateability.md *)`
  prose markers (parser-grammar annotations, lines ~4102/4117 of the current file). These
  are prose, not links — they move with §12 into the hub (or `sql-grammar.md`) unchanged;
  `docs-vu-split` may adjust their target doc name but this ticket leaves them as-is.
- **Reference completeness is the invariant here.** Unlike the design-doc splits, do **not**
  delete "history" or move prose to `todo.md` wholesale — a reference manual documenting a
  shipped behavior is not drift. Only move genuinely future/unimplemented material (a
  `## Future Roadmap`, §11.4) to `todo.md` if it describes unbuilt capability; keep
  everything describing current behavior.
