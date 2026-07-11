description: The 28,000-word view-updateability design document was split into a short overview plus five focused documents. Needs an adversarial review before it is marked done.
prereq:
files:
  - docs/view-updateability.md (overview, ~6,266 words — was ~28,000)
  - docs/vu-operators.md, docs/vu-setops.md, docs/vu-inverses.md, docs/vu-mutation-context.md, docs/vu-roundtrip.md (new)
  - docs/.doc-budget.json (view-updateability.md ratchet entry removed)
  - docs/.stability.json (five new docs classified Beta)
  - docs/architecture.md, docs/lens.md, docs/migration.md, docs/mv-schema-change.md, docs/optimizer-fd.md, docs/sql.md (inbound links repointed)
  - tickets/.pre-existing-error.md (three unrelated docs over their ratchet at HEAD)
----

## What landed

`docs/view-updateability.md` shrank from ~28,000 words to **6,266** — under the 12,000-word
cap, so its `docs/.doc-budget.json` ratchet entry was **removed** (not lowered). The moved
subjects live in **five** new satellites, all comfortably under the cap:

| File | Words | Holds |
| --- | --- | --- |
| `docs/view-updateability.md` (overview) | 6,266 | Intro, `## Topic documents` table, Overview / View-body forms / Capabilities, Philosophy, **The Update Site Model**, Mutation Propagation (+ Identifying Predicates, Branch Consistency), Multi-Base-Table Mutations, Cycles/Self-Joins, Interaction with Constraints, `returning` Clauses, Diagnostics, Information Schema Surface, Implementation Map, Background, Departures from SQL Standard, Current limitations, and a one-line stub at each of the 7 moved top-level sections |
| `docs/vu-operators.md` | 10,403 | Per-Operator Semantics (H1): Projection, Selection (σ) + guards, Inner Join, Outer Joins + Existence columns, Union All / Union / Intersect / Except / Distinct / Sort-Limit-Offset, CTE-name and inline-subquery DML targets, Window, Aggregation |
| `docs/vu-setops.md` | 5,664 | Set-operation membership **columns** and membership **writes** |
| `docs/vu-inverses.md` | 3,161 | Scalar Invertibility, Authored inverses (`with inverse`), View defaults, Tags |
| `docs/vu-mutation-context.md` | 1,801 | Mutation Context + the two subsections |
| `docs/vu-roundtrip.md` | 1,213 | Round-Trip Laws, the derived backward walk, the three laws, the predicate-honest complement |

Content moved **verbatim**; headings were depth-shifted only (no text edited), so every
GitHub anchor slug is preserved. Each satellite carries the `> **Stability: Beta**` banner
and a one-line breadcrumb back to the overview.

## Deviation from the ticket: five satellites, not four (a `vu-setops.md` was added)

The ticket's target set was four satellites, keeping **all** of `## Per-Operator Semantics`
in `vu-operators.md`. Measured, that section is **15,991 words** — the ticket's
"28,000 / 5 ≈ 5,600 average" estimate does not hold because *Set-operation membership
writes* alone is 4,250 words and *…columns* another 1,365. A single `vu-operators.md`
would be ~16,000 words, and a brand-new doc over 12,000 words fails `check-docs.mjs` unless
force-ratcheted — which the ticket explicitly says to avoid ("Move another section out
rather than forcing `--update-ratchet --force`").

So the two Set-operation membership sections were **moved out** into `docs/vu-setops.md`.
Result: `vu-operators.md` is 10,403 and `vu-setops.md` is 5,664 — both under the cap, **no
new ratchet entries anywhere**. This is the ticket-sanctioned resolution of an
over-cap satellite; it just produces five files instead of four.

### Corrected section → file map (authoritative — supersedes the map reproduced in `2.1-docs-vu-repoint-src` and the `files:` of `2.2-docs-invariants-vu`)

| Parent `§` section | New home |
| --- | --- |
| The Update Site Model | `view-updateability.md` (overview) |
| Projection, Selection, Inner Join, Outer Joins, Existence columns, Common Table Expressions, inline-subquery DML, Union/Intersect/Except/Distinct/Sort operator semantics | `vu-operators.md` |
| **Set-operation membership columns / writes (`§ Set Operations`, `§ Set-operation membership`)** | **`vu-setops.md`** ← the only change from the original map |
| Scalar Invertibility, Authored inverses, View defaults, Tags | `vu-inverses.md` |
| Mutation Context | `vu-mutation-context.md` |
| Round-Trip Laws, The predicate-honest complement | `vu-roundtrip.md` |
| `returning`, Information Schema Surface, Diagnostics, Background, surface authority | `view-updateability.md` (overview) |

**Action for downstream:** `docs-vu-repoint-src` must route `§ Set Operations` /
`§ Set-operation membership` src comments to `vu-setops.md`, not `vu-operators.md`.
`docs-invariants-vu` should add `docs/vu-setops.md` to its `files:` list (the "set-op write
fan-out" material now lives there, not in `vu-operators.md`).

## How to validate

- **`node scripts/check-docs.mjs`** — passes for every VU file (links resolve, anchors live,
  sizes within cap, five new docs classified Beta). See *Pre-existing failure* for the three
  unrelated docs that keep the exit non-zero.
- **Heading survival (mechanical).** Diffed against `git show HEAD:docs/view-updateability.md`:
  all **51** original headings survive across the six files; the **only** additions are
  `## Topic documents`, `# Set-Operation Membership`, and `# Scalar Invertibility and
  Authored Inverses` (the two new satellite titles). The 7 moved top-level sections each
  appear exactly twice (real content + overview stub) — by design.
- **Inbound links.** 18 anchored `view-updateability.md#…` links across
  `architecture.md`, `lens.md`, `migration.md`, `mv-schema-change.md`, `optimizer-fd.md`,
  `sql.md` were repointed to the satellite that now holds the target, and each link **label**
  was fixed to name the file it opens. Two of these were genuinely **dead** after the split
  (`lens.md → #the-predicate-honest-complement`, `sql.md → #existence-columns-on-outer-joins`);
  the rest resolved on a stub but were repointed anyway per the ticket.
- **`yarn lint`** green (23s). **`yarn test`** green — 6,934 passing in `@quereus/quereus`
  plus every other workspace, 0 failing. `yarn test:full` was **not** run and is not needed:
  the diff is Markdown + two JSON config files, no source, so the store-backed suite cannot
  observe anything different (the ticket said as much).

### Reviewer worklist — where to spot-check
- **Anchor slugs** for the promoted headings: `#per-operator-semantics`, `#mutation-context`,
  `#round-trip-laws-and-the-derived-backward-walk` are now H1s in their satellites but keep
  their original slug (slug derives from text, not depth). Confirm a couple resolve.
- **Cross-satellite links** created by the split (e.g. Union All → `vu-setops.md`,
  Inner Join ↔ Mutation Context, the overview's Update-Site-Model → `vu-operators.md#outer-joins`).
  `docs:check` validates these; eyeball a few for the right file + a sensible label.
- **The `vu-setops.md` carve seam** in `vu-operators.md` (Existence columns → Union All):
  the two membership sections were excised from the middle of Per-Operator Semantics.
- **Stub honesty:** every overview stub is a heading + a one-line `Moved to […]` pointer at
  the real satellite content, never at itself.

## Known gaps (honest handoff — treat the split as the floor)

- **History / future-work disposition was mostly a no-op, deliberately.** The `## Background`
  section is an **academic bibliography** (rationale/citations), not "we used to…" changelog,
  so it stayed in the overview. A scan for narrative-history language
  (`historically|used to|previously|we now|was removed|…`) surfaced exactly one behavior-change
  passage worth a second look: **`vu-mutation-context.md` line ~29**, the "Intentional behavior
  change" callout (surrogate keys once worked with zero config; now a `default` must be
  declared). It carries load-bearing rationale (*why* the engine should not choose an ID
  policy) **and** a migration recipe, so it is not deletable cruft — but a reviewer may want
  to condense the "used to" half into a `### Rejected alternatives` bullet per
  `doc-conventions.md`. I left it verbatim rather than risk meaning-drift inside a split ticket.
- **`## Current limitations` was kept whole in the overview**, not migrated to `docs/todo.md`.
  The ticket asked to move the "design prose behind" the limitation bullets to `todo.md` and
  leave one-line pointers. On inspection the bullets *are* concise pointers already (one dense
  paragraph each, naming the deferred shape and its diagnostic); there is little separable
  design prose, and moving them wholesale would strip useful reference from the overview. If
  the reviewer disagrees, this is a mechanical follow-up — the bullets are self-contained.
- **Satellite content is unaudited against the implementation.** This was a *move*; prose is
  verbatim. `2.2-docs-invariants-vu` is the ticket that extracts the normative `VU-*`
  invariants and checks them against the code — that is where the audit belongs.

## Review findings

- **Tripwire (parked, not a ticket): a green `docs:check` cannot prove the retargeting was
  complete.** Every moved top-level section left a stub, so `view-updateability.md#mutation-context`
  and its six siblings still resolve; the checker cannot tell a link deliberately left on a stub
  from one that should have been retargeted. All 18 inbound links were repointed to real content
  by hand and none currently lands on a stub. Parked as the `NOTE:` HTML comment directly above
  the overview's `## Topic documents` table, where the next person to add a link will meet it.

## Pre-existing failure (not ours)

`node scripts/check-docs.mjs` (a.k.a. `yarn docs:check`) also fails on three **size-ratchet**
overages — `docs/runtime.md` (+363), `docs/schema.md` (+339), `docs/sync.md` (+195). All three
are **unmodified** by this ticket (`git diff` empty), so they were already over their recorded
sizes at `HEAD`: the docs gate was red before this work began, and nothing in this diff touches
their word counts. Written up in `tickets/.pre-existing-error.md` for the triage pass. No doc was
force-ratcheted to hide the growth.
