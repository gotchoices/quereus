description: The lens design document, the last one over the project's 12,000-word limit, was split into a short overview plus three focused documents; history was trimmed, always-true lens rules were added to the project's rule list, and every link and source comment pointing at a moved section was updated.
files:
  - docs/lens.md (hub)
  - docs/lens-default-mapper.md, docs/lens-constraints.md, docs/lens-deployment.md (new satellites, Beta)
  - docs/invariants.md (LENS-001..006)
  - docs/.doc-budget.json (lens.md ratchet entry retired), docs/.stability.json, docs/stability.md
  - docs/module-capabilities.md (stale NOT NULL clause fixed in review)
  - packages/quereus/src/** lens files (comment markers only)
----
After the human confirmed lenses had settled (Experimental → Beta), `docs/lens.md` (16,592 words) was split following `docs/doc-conventions.md`: the hub keeps the layer model, lens slot, sparse overrides, computed columns, syntax, background, implementation map and layer-wide limitations (5,863 words); `## The Default Mapper`, `## Constraint Attachment` and `## Deployment Is a Compile Step` moved whole into `lens-default-mapper.md`, `lens-constraints.md` and `lens-deployment.md`, each leaving a one-paragraph stub under the old heading so existing anchors resolve. History was cut, with its surviving reasons moved to `lens-constraints.md` § Rejected alternatives. `docs/invariants.md` gained the LENS area (LENS-001..006) with back-links from the sections they summarize. Inbound doc links were retargeted to the satellites, and `docs/lens.md § …` markers in source and test comments were rewritten (comment-only; no code change). Implementation landed in `ticket(implement): debt-docs-split-lens-when-stable`.

Five more drafted LENS invariants were held back because the register would exceed the word cap; that conflict is filed as `tickets/blocked/invariant-register-outgrows-word-cap.md` with the five entries drafted.

## Review findings

**Code diff is comment-only.** Filtered every added/removed line in `packages/` that is not a comment line: none. Verified.

**Content loss (old `lens.md` vs hub + satellites + invariants).** Ran a sentence-level coverage diff of the pre-split `lens.md` against the four lens docs plus `invariants.md`. 50 sentences fell under 60% six-word-window coverage; each was inspected. All are moved headings (re-levelled), deliberately deleted history ("is now supported", "the bare-name gate this replaces…", "auto-index is retired"), or reworded with the substance preserved (shared-key identity write rejected → `lens-default-mapper.md` § UPDATE; rule-count-independent plan cost, relation-identity gating, cross-member row-local CHECK → `lens-constraints.md`; surrogate `uuid7()` default and the "writes null or fails atomically" boundary → default-mapper limitations). One old limitation ("predicate-honest round-trip prover … not computed as deploy-time predicates") was stale against `lens-prover.md` and is correctly replaced by the narrower "outside the single-source fragment" hub limitation. No dropped content found.

**Invariants.** Each LENS entry's guard test name exists in the cited spec file, and each claim was checked against the doc section and code it cites. LENS-004's "a non-ABORT conflict clause … the write is refused" matches `rejectRowLocalDeferredConflictResolution`; the open `fix/4-bug-lens-check-skipped-when-write-uses-a-conflict-clause` is about generalizing those refusals, not a hole in them. The entries are hard-wrapped, which matches the existing register's style, so they were left as is.

**Stale source markers, fixed inline (minor):**
- `lens-ack.ts`: `§ Escalation policy` is not a heading → `docs/lens-prover.md § Acknowledging advisories, "Escalation policy"`.
- `lens-prover.ts`: `§ Round-trip` is not a heading → `§ Coverage checklist (round-trip row)`.
- `lens-compiler.ts` `inferDefaultBasis`: cited a nonexistent `§ Default-basis inference`, and its "there is no `declare lens` yet" is history. The behavior was undocumented, and `lens.md` § Syntax said a lens "must be declared" before apply, which is not true. Added one sentence to § Syntax describing the fallback binding (and its failure when there is not exactly one candidate), then pointed the marker there.
- `lens-compiler.ts`: rewrapped a JSDoc line the marker regex had merged into one 180-character line.
- `view-mutation-builder.ts` `buildDecompositionInsert` JSDoc said row-local CHECK rides the member inserts under `constraintsForOp`. The function body (and `lens-constraints.md`) evaluate it once per logical row instead. Corrected the JSDoc.

**Pre-existing doc contradiction (flagged by implementer), fixed inline:** `docs/module-capabilities.md` (`permitsGrandfatheredNotNullViolators` row) said the lens rewrite does not attach a logical NOT NULL to the basis write. `lens-enforcement.ts` synthesizes `lens:notnull:<col>` with the `NOT NULL constraint failed` message, so the row now says the write still enforces it and links `lens-constraints.md#row-local-not-null-check`.

**Left as is, with reason:**
- Open fix/backlog tickets that cite `docs/lens.md § Constraint Attachment` etc. were not edited, because other runs may hold them. Their citations still resolve through the hub stubs, and the hub's `<!-- NOTE: … -->` tells editors to link the satellite.
- History outside this split's scope (`vu-operators.md` "is now shipped", `mv-constraints.md` "auto-index is retired", user-facing error text in `decomposition.ts` / `lens-compiler.ts`): not part of this split, and the error text is user-facing behavior, not docs.
- `docs/optimizer-fd.md` is 218 words under the cap (checker notice). That is a tripwire the checker already reports, so no ticket was filed.

**Tests.** None added and none cut: the change is documentation and comments only.

**Validation.** `yarn docs:check` passes. Its only notices are near-cap warnings for `invariants.md` (150 words left) and `optimizer-fd.md` (218 left). `yarn workspace @quereus/quereus lint` passes. Full `yarn test` was not run because no executable code changed.
