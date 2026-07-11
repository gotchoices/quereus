description: The view-updateability design document is 28,000 words — too long for anyone to read against the code and confirm it still matches. Split it into a short overview plus four focused documents, one per subject.
prereq:
files:
  - docs/view-updateability.md (~28,000 words → shrinks to an overview hub)
  - docs/vu-operators.md, docs/vu-inverses.md, docs/vu-mutation-context.md, docs/vu-roundtrip.md (new)
  - docs/.doc-budget.json (remove or lower the view-updateability.md ratchet entry)
  - docs/.stability.json (classify the four new docs — Beta, matching the parent)
  - docs/doc-conventions.md, scripts/check-docs.mjs (the machinery — read, do not change here)
  - docs/architecture.md, docs/migration.md, docs/stability.md, docs/schema.md, docs/lens.md, docs/optimizer-fd.md, docs/mv-schema-change.md, docs/materialized-views.md, docs/sql.md (inbound doc links to repoint)
  - docs/todo.md (receives any future-work prose deleted from the doc)
difficulty: hard
----

## What this is

`docs/view-updateability.md` is one of three docs still over the 12,000-word cap
(recorded in `docs/.doc-budget.json` as grandfathered — it may not grow but has not
shrunk). It is a **design doc**, so it gets the full treatment the optimizer and
materialized-view docs already got: split into an overview + focused satellites, sort
prose into invariant / rationale / history per `docs/doc-conventions.md`, delete the
history. This ticket does the **split**; a follow-up (`docs-invariants-vu`) extracts the
normative `VU-*` invariants into `docs/invariants.md`, and another (`docs-vu-repoint-src`)
repoints the source-comment section markers. Both are `prereq`-chained on this ticket.

Model the whole thing on the completed materialized-view split
(`tickets/complete/3.3-docs-mv-split.md`) — same overview-plus-stubs shape, same
`## Topic documents` table, same history-deletion and `## Rejected alternatives`
condensation rules.

## Target file set

The parent doc's own outline suggests the seams. Cut at headings, promote depth by one
in each satellite, leave a stub + link at each moved heading in the overview.

| File | Holds (parent headings) |
| --- | --- |
| `docs/view-updateability.md` (overview) | Overview / View-body forms / Capabilities at a glance, Philosophy: Predicates Rule, **The Update Site Model**, Mutation Propagation (Identifying Predicates, Branch Consistency), Multi-Base-Table Mutations, Cycles/Self-Joins/Recursive Composition, Interaction with Constraints, `returning` Clauses, Diagnostics, Information Schema Surface (+ `column_info`), Implementation Map, Background, Departures from SQL Standard, Current limitations, a new `## Topic documents` table, and one stub per moved section |
| `docs/vu-operators.md` | Per-Operator Semantics + Projection, Selection (σ), Inner Join, Outer Joins, Set-operation membership columns, Set-operation membership writes, Union All, Union (distinct), Intersect, Except, Distinct, Sort/Limit/Offset, Common Table Expressions and the CTE-name DML target, Inline subquery DML target, Window Functions, Aggregation |
| `docs/vu-inverses.md` | Scalar Invertibility, Authored inverses (`with inverse`), View defaults, Tags |
| `docs/vu-mutation-context.md` | Mutation Context and its subsections (shared keys as defaults, `new.<col>` minting vs resolving) |
| `docs/vu-roundtrip.md` | Round-Trip Laws and the Derived Backward Walk (the derived-dual note, the three laws, the predicate-honest complement) |

Why **The Update Site Model** stays in the overview: `lens.md` and
`packages/quereus/src/planner/analysis/update-lineage.ts` both cross-reference it, and it
is the conceptual foundation the satellites build on — it belongs in the doc a reader opens
first. Same reasoning keeps Diagnostics, Information Schema Surface, `returning`, and
Background in the overview.

Each satellite lands comfortably under 12,000 words (28,000 / 5 ≈ 5,600 average, matching
the MV satellites). None needs a `.doc-budget.json` entry. If the overview itself is still
over 12,000 after the cut, move the largest kept section (likely Information Schema Surface
or the operator-independent parts of Mutation Propagation) into a satellite until it fits —
measure with `node scripts/check-docs.mjs`, do not guess.

## Section → file map (authoritative — the src-repoint and invariants tickets use this)

This is the canonical mapping the whole VU effort keys off. A source comment or inbound
link naming `§ <Section>` retargets to the file below.

| Parent `§` section | New home |
| --- | --- |
| The Update Site Model | `view-updateability.md` (overview) |
| Projection, Selection, Inner Join, Outer Joins, Set Operations / Set-operation membership, Common Table Expressions | `vu-operators.md` |
| Scalar Invertibility, Authored inverses, View defaults, Tags | `vu-inverses.md` |
| Mutation Context | `vu-mutation-context.md` |
| Round-Trip Laws and the Derived Backward Walk, The predicate-honest complement | `vu-roundtrip.md` |
| `returning`, Information Schema Surface, Diagnostics, Background, Current limitations, surface authority | `view-updateability.md` (overview) |

Note the source comments spell some section names loosely (`§ Set Operations` for the
`Set-operation membership …` headings, `§ surface authority` for a phrase inside
Information Schema Surface). Map by subject, not by exact string.

## Inbound links to repoint (this ticket, docs only)

`yarn docs:check` enumerates every one; these are the known set. Each links into a
`view-updateability.md#anchor` whose section moved — repoint to the satellite, or (if the
target stayed in the overview) leave it. Where a moved section leaves a stub, an inbound
link resolves either way, but the **label** must still name the file it opens.

- `docs/architecture.md` — `#mutation-context` (→ vu-mutation-context.md), plus the prose
  reference to Round-Trip Laws (→ vu-roundtrip.md).
- `docs/lens.md` — `#mutation-context` (×3), `#the-update-site-model` (overview),
  `#authored-inverses-with-inverse`, `#scalar-invertibility`, `#interaction-with-constraints`
  (overview), `#the-predicate-honest-complement`, `#diagnostics` (overview), `#background`
  (overview), `#current-limitations` (overview).
- `docs/migration.md` — `#scalar-invertibility`, `#authored-inverses-with-inverse` (×2).
- `docs/schema.md` — bare `view updateability` link (overview, fine).
- `docs/optimizer-fd.md` — `#round-trip-laws-and-the-derived-backward-walk` (→ vu-roundtrip.md).
- `docs/mv-schema-change.md` — `#view-defaults` (→ vu-inverses.md).
- `docs/materialized-views.md` — several bare + `#information-schema-surface` (overview).
- `docs/sql.md` — `#authored-inverses-with-inverse` (vu-inverses), `#view-defaults`
  (vu-inverses), `#set-operations` prose (vu-operators), bare (overview). **Coordinate
  with `docs-sql-split`** — if that ticket runs first, these live in a `sql-*.md`
  satellite; the checker names the current location either way.
- `docs/stability.md` — the assignment-table row (overview, fine).

Source-comment section markers in `packages/*/src` are **out of scope for this ticket** —
they are handled by `docs-vu-repoint-src`. They do not break the build (the checker
validates the `docs/foo.md` path, which the surviving overview keeps, not the `§` marker —
`scripts/check-docs.mjs` `bareDocRefs`), and the overview stubs keep them navigable in the
meantime.

## History / future-work disposition

- Delete narrative history outright (do not archive). The `## Background` section is the
  likely home of "we used to…" prose — condense any load-bearing "why not Y" into a
  `### Rejected alternatives` bullet in the relevant satellite, delete the rest.
- Move future-work prose to `docs/todo.md` (add a `§ View updateability` subsection if
  absent), leaving at most a one-line pointer under `## Current limitations`. The parent's
  `## Current limitations` already gestures at unimplemented widenings (join/decomposition
  round-trip); those bullets stay as pointers, the design prose behind them moves.

## Stability banners

Each of the four new docs is Beta (the parent's tier). Add each to `docs/.stability.json`
under `docs` as `"Beta"`, and give each a header banner directly under its `#` heading:

```markdown
> **Stability: Beta** — see [Stability Tiers](stability.md#tiers).
```

The parent keeps its existing banner. No section-level banner overrides are needed (VU has
none today).

## TODO

Phase 1 — cut
- Snapshot the pre-split heading set (`git show HEAD:docs/view-updateability.md`) so Phase 4
  can prove every heading survived in exactly one file.
- Create the four satellites, moving each section's content verbatim, promoting heading depth
  by one. Add the header banner to each.
- Replace each moved section in the overview with a one-line stub linking to its new home;
  add the `## Topic documents` table listing the four satellites.
- Delete narrative history; condense rejected-alternative rationale into
  `### Rejected alternatives`; move future-work prose to `docs/todo.md`.

Phase 2 — reclassify + rebudget
- Add the four docs to `docs/.stability.json` (`Beta`).
- If the overview is now under 12,000 words, remove the `docs/view-updateability.md` entry
  from `docs/.doc-budget.json`; otherwise lower it with
  `node scripts/check-docs.mjs --update-ratchet` (it only lowers).

Phase 3 — repoint inbound doc links
- Repoint every inbound `view-updateability.md#…` link listed above to the satellite that
  now holds the target, fixing the link **label** to name that file. Hold word counts flat
  in `lens.md`/`schema.md` etc. so their ratchet entries still pass.

Phase 4 — verify
- `yarn docs:check` (`node scripts/check-docs.mjs`) green — links, anchors, sizes, stability.
- Prove every `##`/`###`/`####` heading from the pre-split file appears in exactly one of the
  five files (mechanical diff against the Phase-1 snapshot). The only additions are the four
  titles, the stubs, `## Topic documents`, and any `### Rejected alternatives`.
- `yarn lint` and `yarn test` green (this ticket touches only Markdown + two JSON config
  files; no source, so `yarn test:full` is not required — say so in the handoff).

## Edge cases & interactions

- **Stub vs repoint ambiguity.** A moved section leaves a stub, so both
  `view-updateability.md#inner-join` and `vu-operators.md#inner-join` resolve. The MV split
  recorded this as a tripwire: `docs:check` cannot tell a link deliberately left on a stub
  from one that should have been retargeted. Repoint every inbound link to the real content;
  park the same `NOTE:` tripwire above the overview's `## Topic documents` table.
- **Anchor slug drift.** Promoting a `###` to `##` does not change its GitHub slug (slug is
  derived from heading text, not depth), so inbound `#anchor` links survive the promotion.
  Verify anyway — a heading whose text you tidy during the move silently breaks its anchor.
- **`sql.md`/`docs-sql-split` overlap.** Both tickets touch `docs/sql.md`. They have no
  `prereq` between them; whichever lands second rebases its link edits onto the other's
  result. Keep this ticket's `sql.md` edits confined to the VU anchors listed above.
- **Cross-satellite references.** Sections that moved to different files but reference each
  other (e.g. Authored inverses ↔ Round-Trip Laws) become cross-file links, not same-page
  anchors. `docs:check` validates these; make sure the target file is named.
- **Overview still over cap.** If the cut leaves the overview above 12,000 words, the build
  fails on the ratchet. Move another section out rather than forcing `--update-ratchet --force`.
- **`incremental-maintenance.md` / other bare refs.** Any doc referencing VU without an
  anchor (`[view updateability](view-updateability.md)`) needs no change — the overview file
  keeps that path.
