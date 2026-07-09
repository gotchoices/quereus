description: Three more design documents are large enough that nobody reads them end to end and checks them against the code — the same condition that let two other documents drift. Once the tooling and convention for splitting a document exist, apply them to these three.
files:
  - docs/sql.md (~28,700 words)
  - docs/view-updateability.md (~28,000 words)
  - docs/lens.md (~17,900 words)
  - docs/doc-conventions.md, scripts/check-docs.js, docs/.doc-budget.json (the machinery this work uses)
----

## What this is

A separate effort (tickets `docs-doc-conventions-and-checker`,
`docs-optimizer-extract-fd`, `docs-optimizer-split-satellites`, `docs-mv-split`,
`docs-invariants-optimizer`, `docs-invariants-mv`) established that a design
document past roughly 12,000 words stops being reviewable against the code and
starts to drift, and built three things to fix it:

- a written convention for sorting doc prose into rules the code must obey,
  reasons the design is the way it is, and history of how it got there
  (`docs/doc-conventions.md`),
- a checker that fails the build on a broken doc link, a stale code pointer, or a
  document that grew past its recorded size (`scripts/check-docs.js`),
- a register of numbered, code-pointing invariants (`docs/invariants.md`).

That effort was **scoped to `optimizer.md` and `materialized-views.md` only** —
the two worst cases. Three documents remain above the cap and are recorded as
grandfathered entries in `docs/.doc-budget.json`, meaning they cannot grow but
have not shrunk:

| Document | Words | Note |
| --- | --- | --- |
| `docs/sql.md` | ~28,700 | The SQL dialect reference. Splits naturally by statement class. Its audience is users, not engine developers, so the invariant register may not apply — a reference manual's job is completeness, not reviewability. Worth deciding before splitting. |
| `docs/view-updateability.md` | ~28,000 | Predicate-driven view updateability. Dense with normative round-trip laws that already have a property-test guard (`test/property.spec.ts` § View Round-Trip Laws) — the best `guard:` coverage of any doc in the repo, so a `VU-*` invariant area would be unusually well-backed. |
| `docs/lens.md` | ~17,900 | Layered schemas / lenses. The most speculative subsystem in the repo (`docs-stability-tiers` proposes labelling it **Experimental**), which argues for splitting it *later*, not sooner — an experimental design that is still moving is the one place narrative history genuinely earns its keep. |

## Why it is not queued now

Three reasons, in order of weight:

1. **The machinery should be proven on two documents before being applied to five.**
   The checker's slug handling, the ratchet's ergonomics, and the invariant-block
   format all get their first real exercise on the optimizer and materialized-view
   splits. Wait for the review findings from those.
2. **`sql.md` may not want the same treatment.** It is a user-facing reference, and
   reference manuals are supposed to be exhaustive. The right move there might be a
   split by statement class with no invariant register at all — or nothing. Decide
   before doing.
3. **`lens.md` is a moving target.** Splitting a document whose subject is still
   being designed produces churn, not clarity.

## What a future pass would do

For each document, in whatever order the maintainer prefers:

- Decide whether it is a *design* doc (split + invariants) or a *reference* doc
  (split only, or leave alone), and record the reasoning.
- Split along the boundary its own outline already suggests, following the rules in
  `docs/doc-conventions.md`: cut at headings, promote depth by one, leave a stub
  and a link, sort prose into invariant / rationale / history, delete the history.
- Repoint inbound doc anchors and the `docs/*.md` references in source comments.
  The checker names them all.
- Lower or remove the document's `docs/.doc-budget.json` entry.
- If it is a design doc, add an area to `docs/invariants.md` — `VU-*` for view
  updateability, `LENS-*` for lenses (both IDs are already reserved).

`view-updateability.md` is the strongest candidate to go first: it is a design doc,
its round-trip laws are already invariant-shaped, and it already has the test
harness a `guard:` line wants to point at.
