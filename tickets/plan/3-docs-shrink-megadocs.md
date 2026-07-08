description: Two of the project's design documents have grown so large — hundreds of kilobytes each, mixing current rules with the history of how they came to be — that no one can realistically check them against the code anymore, and they have started to drift; plan how to split the durable rules out from the narrative so the docs stay trustworthy.
files:
  - docs/optimizer.md (~281 KB)
  - docs/materialized-views.md (~204 KB)
  - docs/architecture.md (the intended home for cross-cutting normative invariants)
  - docs (overall topic-doc set — 800 KB+ total, noted as drifting)
----

## Problem

Two topic docs have grown past the point of being reviewable against the code:
`optimizer.md` (~281 KB) and `materialized-views.md` (~204 KB). The review
(strategic recommendation #9) found four concrete doc drifts overall (fixed
separately in `docs-fix-verified-drift`) and flags these two mega-docs as the
structural cause: they interleave **normative invariants** (the rules the code must
uphold — the durable, checkable statements) with **narrative history** (how a
feature evolved, ticket-by-ticket rationale, superseded designs). Once a doc is
that large and that mixed, nobody re-reads it end-to-end against the code, so it
drifts unnoticed — the architecture assessment names 800 KB+ of topic docs already
drifting and *maintainer attention* as the endangered resource.

## Goal

Shrink and true-up the two mega-docs so their load-bearing content is small enough
to be checked against the code and stays that way. The mechanism the review
recommends: **extract the normative invariants from the narrative history**.

- **Normative invariants** — the statements the code must satisfy (e.g. cost-model
  conventions, side-effect audit rules, MV maintenance guarantees, round-trip laws)
  — become a compact, reviewable core that can be diffed against the implementation.
- **Narrative history** — evolution, rationale, superseded approaches — is either
  archived, condensed, or moved out of the normative core so it stops burying the
  rules and stops being mistaken for current truth.

## To resolve in this plan

- **What counts as normative** in each doc and where the extracted invariants live:
  a slim invariants section at the top of each topic doc, or promoted into
  `architecture.md` as cross-cutting invariants with the topic doc linking to them.
- **What to do with the narrative**: archive vs. condense vs. delete. History has
  value; the goal is to *separate* it from the checkable rules, not necessarily
  destroy it.
- **A size/reviewability target** and a lightweight convention that keeps future
  additions from re-growing the same blob (e.g. new rationale goes to a changelog /
  history file, not into the normative section).
- **Which invariants are worth a machine check**: some normative statements (cost
  conventions, sideEffectMode registration) already have or could have runtime/test
  assertions — note where extraction should hand off to an actual guard rather than
  staying prose. (Coordinate with the cost-model and context-shadowing invariant
  work tracked in their own tickets — don't duplicate, just cross-reference.)

## Non-goals

- Fixing the four already-identified drifts — that is `docs-fix-verified-drift`.
- Rewriting the *code* any doc describes — this is a documentation-structure effort.
- The stability-tier labeling — that is `docs-stability-tiers` (related, separate).
