description: The 28,000-word SQL reference manual was split into six per-topic pages, with the original page turned into a short table of contents that links to them.
prereq:
files:
  - docs/sql.md (now the ~4,000-word TOC hub — §1 intro, Topic documents table, §10 errors, §11 Quereus-vs-SQLite, §12 EBNF grammar)
  - docs/sql-select.md, docs/sql-dml.md, docs/sql-ddl.md, docs/sql-views.md, docs/sql-functions.md, docs/sql-txn.md (new satellites)
  - docs/.doc-budget.json (sql.md ratchet entry removed), docs/.stability.json (6 satellites classified Stable)
  - docs/architecture.md, docs/schema.md, docs/usage.md, docs/view-updateability.md, docs/vu-operators.md, docs/vu-setops.md, docs/stability.md, docs/doc-conventions.md, docs/todo.md (inbound links / prose repointed)
difficulty: medium
----

## What shipped

`docs/sql.md` (28,745 words, the last grandfathered megadoc) is now a **hub**: §1 Introduction,
a `## Topic documents` table, and the three cross-cutting appendices (§10 Error Handling,
§11 Quereus vs. SQLite, §12 EBNF Grammar). Everything else moved into six topic satellites.
This was a **split only — no invariant register** (a reference manual documents shipped
behavior; there is no `SQL-*` area in `docs/invariants.md` and this ticket created none).

Section → file map (all section text moved **verbatim**; anchors preserved):

| File | Words | Parent sections it now holds |
| --- | --- | --- |
| `docs/sql.md` (hub) | 3,996 | §1, `## Topic documents`, §10, §11 (minus §11.4), §12 |
| `docs/sql-select.md` | 7,698 | §2 Query expressions intro, §2.1 SELECT, §3 Clauses, §4 Expressions & Operators |
| `docs/sql-dml.md` | 2,622 | §2.2 INSERT, §2.3 UPDATE, §2.4 DELETE, §2.5 RETURNING |
| `docs/sql-ddl.md` | 9,179 | §2.0 Declarative Schema, §2.6 CREATE TABLE (+2.6.1/2/3), §2.7 ALTER TABLE, §6 Virtual Tables, §7 Constraints & Indexes |
| `docs/sql-views.md` | 1,915 | §2.8 CREATE VIEW, §2.9 Updatable Views, §2.10 CREATE MATERIALIZED VIEW, §2.11 Logical Schemas and Lenses |
| `docs/sql-functions.md` | 1,949 | §5 Functions (Scalar, Aggregate, JSON, Date/Time, Window, TVF) |
| `docs/sql-txn.md` | 1,817 | §8 Transactions & Savepoints, §9 PRAGMA |

Every satellite is well under the 12,000-word cap, so **no `sql-grammar.md` split was
needed** — the hub landed at 3,996 words with §12 kept in place.

### Mechanics worth knowing for the review

- **Depth promotion.** Sections that were `###` under the (now-dropped) `## 2` container
  (§2.0, §2.1, §2.2–2.5, §2.6–2.7, §2.8–2.11) were promoted one level (`###`→`##`,
  `####`→`###`) so they sit as top-level `##` sections in their satellite. Sections already
  at `##` (§3–§9) moved unchanged. GitHub slugs depend only on heading **text**, so promotion
  preserved every anchor — verified by a slug-set diff (see below).
- **Hub stubs + duplicate anchors are intentional.** Each moved top-level section (§2–§9)
  left a one-line stub under its original `## N. Title` heading in the hub, so old
  `sql.md#<anchor>` links still resolve. This means the top-level slugs `3-clauses-and-subclauses`
  … `9-pragma-statements` deliberately exist in **two** files (hub stub + satellite real
  content) — the same pattern the MV/VU splits use. The stub-ambiguity NOTE tripwire is
  parked as an HTML comment directly under `## Topic documents` in `sql.md`.
- **§2.0 Beta section banner survived the move.** `sql-ddl.md` carries a `Stable` header
  banner under its H1 and a `Beta` **section** banner under `## 2.0 Declarative Schema` — the
  one section-level override in the original `sql.md`, preserved. The stability checker
  validates this (Check D green).
- **Cross-file anchor repoints (inside the moved content).** 7 same-page `](#…)` links whose
  target section moved to a different satellite were repointed: 6× `#29-updatable-views` →
  `sql-views.md#29-updatable-views` (in select/dml/ddl) and 1× `#27-alter-table-statement` →
  `sql-ddl.md#…` (in views). The other 11 same-page links stayed same-file and still resolve.
- **Inbound repoints (from other docs).** 9 anchored `sql.md#…` links across
  architecture/schema/usage/view-updateability/vu-operators/vu-setops were repointed to their
  satellite; one bare `sql.md` link in schema.md whose label named "Schema Search Path" was
  pointed at `sql-select.md#211-schema-search-path-with-schema`. Bare hub links (no anchor)
  were left pointing at the hub per the ticket. `stability.md` (declarative-schema row + two
  prose mentions) and `doc-conventions.md` (the section-banner example) were repointed from
  `sql.md` to `sql-ddl.md`.
- **§11.4 Future Roadmap** (three forward-looking bullets — window nav functions, recursive
  CTE, query-planning) was the only prose *removed* from the reference; it moved to
  `docs/todo.md` under "Language roadmap (relocated from the SQL reference §11.4)". Everything
  describing **current** behavior was kept (reference completeness is the invariant here).

## How to validate

- `node scripts/check-docs.mjs` (a.k.a. `yarn docs:check`) — link integrity, anchor
  resolution, stability tiers, and sizes. **Green for everything this ticket touched.** See
  "Known pre-existing failures" below for the 3 residual ratchet errors that are *not* mine.
- Heading-completeness proof: a slug-set diff of `git show HEAD:docs/sql.md` against the union
  of the 7 new files shows the **only** missing heading is `11.4 Future Roadmap` (moved to
  todo.md), and the **only** additions are the 6 satellite H1 titles plus `topic-documents`.
  Re-run to confirm nothing was dropped or silently retitled.
- Spot-check the tricky links by rendering: from `sql-dml.md`, the "§2.9 Updatable Views"
  links should jump to `sql-views.md`; from `sql-views.md` §2.10, the "§2.7" link should jump
  to `sql-ddl.md`; from `architecture.md` the "Query expressions" and "Conflict Resolution"
  links should land in `sql-select.md` / `sql-dml.md`.
- `yarn lint` — green. `yarn test` — green (all packages, ~3m). `yarn test:full` was **not**
  run: this ticket touches only Markdown + two JSON config files, no source or specs, so the
  store-backed suite adds no signal.

## Reviewer focus / known gaps

- **Prose accuracy after the cut is a floor, not a ceiling.** The split moved section blocks
  verbatim; it did **not** re-read every satellite for internal "see §N above/below" prose
  references that now cross a file boundary but were written as plain text (not markdown
  links, so the checker can't see them). Worth a skim — e.g. a satellite saying "as described
  in §7" where §7 is now in a different file. These are cosmetic, not broken links.
- **Bare hub links left in place.** `stability.md` rows 74/78/81 (Core SQL / Constraints /
  Read-only views) still link to the hub `sql.md` rather than the specific satellite. Per the
  ticket ("bare links to the hub need no change") this is intentional — the reader lands on
  the TOC and navigates — but a reviewer may prefer deep links; low stakes either way.
- **Stub link targets for §2.** The `## 2. SQL Statement Reference` hub stub links to all four
  satellites that absorbed its children (its own content scattered), unlike §3–§9 stubs which
  point at one satellite each. No inbound link targets `sql.md#2-sql-statement-reference`, so
  this stub is a pure safety net.
- The prose-reference edge case above is the main reason to treat this handoff as a starting
  point rather than a finished pass.

## Tripwires parked (fold into `## Review findings`)

- **Stub anchors duplicate satellite anchors** — `docs:check` cannot distinguish a link
  deliberately left on a hub stub from one that should have been retargeted to real satellite
  content. Parked as the HTML `NOTE:` comment directly under `## Topic documents` in
  `docs/sql.md` (mirrors the MV split).

## Known pre-existing failures (NOT introduced by this ticket)

`node scripts/check-docs.mjs` still reports 3 size-ratchet failures:

- `docs/runtime.md` — 13,840 words vs ratchet 13,477
- `docs/schema.md` — 16,029 words vs ratchet 15,690
- `docs/sync.md` — 14,516 words vs ratchet 14,321

All three are over-ratchet **at HEAD**, untouched (or token-count-neutral) by this ticket:
`schema.md` measures 16,029 words at both HEAD and worktree — the link repoints here do not
change its whitespace-token count — and `runtime.md` / `sync.md` were never edited. All three
are already listed in `tickets/.pre-existing-known.md` under the in-flight slug
**`docs-megadoc-ratchet-overage`** (dated 2026-07-11), so per the pre-existing-failure rules
they are **not** re-reported here and no `.pre-existing-error.md` was written. Aware of / not
blocking on that slug.
