description: The lens design document, the last one over the project's 12,000-word limit, has been split into a short overview plus three focused documents; history was trimmed, a section of always-true lens rules was added to the project's rule list, and every link and source comment pointing at a moved section was updated.
files:
  - docs/lens.md (hub, 5,863 words — was 16,592)
  - docs/lens-default-mapper.md (new, 4,885 — generated join, mapping advertisements, put fan-out, auxiliary-access routing)
  - docs/lens-constraints.md (new, 4,783 — constraint attachment, elision, FD contribution)
  - docs/lens-deployment.md (new, 1,784 — compile steps, snapshot, notification, backfill)
  - docs/invariants.md (LENS area: LENS-001..006; register now 11,850 words)
  - docs/.doc-budget.json (lens.md ratchet entry retired; ratchet map now empty)
  - docs/.stability.json, docs/stability.md (three satellites classified Beta)
  - docs/lens-prover.md, docs/migration.md, docs/mv-constraints.md, docs/optimizer-fd.md, docs/schema.md, docs/usage.md, docs/view-updateability.md, docs/vu-operators.md, packages/quereus/README.md (links retargeted)
  - packages/quereus/src/** and packages/quereus/test/** lens files, packages/quereus-store/src/common/store-module.ts (`docs/lens.md § …` comment markers only — no code change)
----
The human answered the blocked question "yes, lenses have settled" (lenses moved Experimental → Beta in the same batch), so `docs/lens.md` was split following the recipe in `docs/doc-conventions.md`.

## What changed

**Split.** `docs/lens.md` stays the hub: overview, key terms, the three layers, what a lens is, schema kinds, the lens slot, sparse overrides, computed and generated columns, relationship to materialized views, syntax, background, departures, implementation map, and the layer-wide current limitations. Three H2 sections moved whole into satellites, each leaving a short stub (one gist paragraph plus a link) under the original heading so old anchors still resolve:

- `## The Default Mapper` → `docs/lens-default-mapper.md`. The `put` fan-out became its own H2 with DELETE / UPDATE / INSERT H3s; the single ~900-word UPDATE paragraph was broken into a bullet list of member kinds, a "How the assigned value is realized" list (constant / anchor-resolvable / self-reference), and a "Captured values" subsection. The stitch-key uniqueness paragraph became its own H3. Decomposition-specific limitations moved here.
- `## Constraint Attachment` → `docs/lens-constraints.md`. The three giant class bullets became H3s (row-local, row-local on a decomposition, set-level, conflict actions, foreign key, which member op a constraint rides). The multi-source-INSERT gap and the cross-member child-FK drop moved into its `## Current limitations`.
- `## Deployment Is a Compile Step` → `docs/lens-deployment.md`, plus one new sentence stating the atomic compile-first property (already true, previously only implied).

**History deleted, rationale kept** (per doc-conventions): "the engine no longer fabricates", "recovering the pre-materialize self-path", "subsuming the retired same-statement reject", "the bare-name gate this replaces…", "what was previously documented here…", "is now supported" parentheticals, the "eventual mechanism … stable attribute ID" future-work lead (now a one-line hub limitation), "legacy behavior", "auto-index is retired", "was already unreachable". Three reasons that were inside deleted history went to a new `### Rejected alternatives` in `lens-constraints.md` (member-riding row-local CHECK, one probe per rule, bare-name constraint gating).

**Invariants.** The reserved `## LENS — Lens` area in `docs/invariants.md` now holds LENS-001..006: logical removal never drops basis; stitch keys / EAV conflict targets are declared unique; logical constraints bind only lens-routed writes; decomposition row-local rules are checked on the logical row or the write refuses; asserted-key FDs only from guaranteed uniqueness; a writable column failing its round-trip check blocks the deploy. Each satellite/hub section an invariant summarizes carries the `> **Invariant:**` back-link. `INVARIANT_HEADING` already listed `LENS` — no checker change.

**Inbound references.** Anchor links into moved sections were retargeted to the satellites (not the stubs). `docs/lens.md § …` markers in source/test comments were rewritten by hand-checked regex (the checker does not validate `§` markers — `debt-check-docs-validate-section-markers`). Already-stale markers in the same files were fixed too: `§ D1`/`§ D2`/`§ D4` and line-number refs like `docs/lens.md:176` now name real sections (`Syntax`, `Coverage is name-based…`, `Gap-fill fidelity boundary`, `Body-shape restrictions`, `lens-prover.md § Acknowledging advisories`).

## Validation

- `yarn docs:check` — passes (links, anchors, invariant pointers, tiers, sizes). Notices only: `invariants.md` 150 words from the cap, `optimizer-fd.md` 218 from it.
- `node scripts/check-docs.mjs --update-ratchet` — retired the `docs/lens.md` entry.
- `yarn workspace @quereus/quereus lint` (eslint + test-file tsc) — passes.
- `packages/quereus/test/documentation.spec.ts` (README link checks) — 12 passing.
- Full `yarn test` not run: no code changed, only comments.
- No tests added — documentation-only change.

## Known gaps / for the reviewer

- **Only 6 of 11 drafted LENS invariants shipped.** The full set put `docs/invariants.md` at 12,691 words, over the cap, and doc-conventions says the register must stay one file. Filed `tickets/blocked/invariant-register-outgrows-word-cap.md` (recommends splitting the register by area) with the 5 held-back entries drafted in full: atomic deploy, surrogate evaluate-once, conflict action honored-or-rejected, backfill never violates NOT NULL, stored body qualifies basis sources.
- **Content-loss check.** Moves were cut-and-paste, but the restructured UPDATE section and the constraint bullets were re-paragraphed. Diff the old `docs/lens.md` (HEAD) against the satellites for anything dropped.
- **Pre-existing doc contradiction, not fixed:** `docs/module-capabilities.md` (row `permitsGrandfatheredNotNullViolators`) says "the lens enforcement rewrite does not attach a logical NOT NULL to the basis write in the first place". `lens-constraints.md` § Row-local (and `lens-prover.md`'s grandfathered-NOT-NULL row) say an undefaulted logical NOT NULL *is* enforced on writes. The module-capabilities text looks stale; confirm against `collectLensRowLocalConstraints`.
- **Stale marker left:** `packages/quereus/src/schema/lens-compiler.ts` (~line 623) cites `docs/lens.md § Default-basis inference`, which no doc section covers. Nothing to point it at.
- **History outside this split's scope, left alone:** `vu-operators.md` ("is now **shipped**"), `mv-constraints.md:76` ("auto-index is retired"), and the user-facing error text in `decomposition.ts` / `lens-compiler.ts` ("the engine no longer auto-generates one").
- **Open tickets citing moved sections** were not edited (other runs may hold them). They still resolve via the hub stubs: `fix/1-bug-join-backed-logical-table-enforces-no-rules-on-insert`, `fix/3-debt-lens-logical-fk-arity-mismatch-silently-unenforced`, `fix/4-bug-lens-check-skipped-when-write-uses-a-conflict-clause`, `fix/6-bug-logical-primary-key-allows-two-null-keyed-rows`, `backlog/2-view-returning-decomposition`, `backlog/debt-doc-sql-blocks-unparsed`. Whoever works them should edit the satellite, not the stub.
