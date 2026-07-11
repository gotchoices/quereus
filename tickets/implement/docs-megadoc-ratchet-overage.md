description: Three docs (runtime.md, schema.md, sync.md) grew past their recorded size limits, so `yarn check` is red. Trim each back under its limit — deleting changelog-style history and future-work prose, not the real content — to make the check green again.
prereq:
files:
  - docs/runtime.md (13840 words, ratchet 13477, need −363)
  - docs/schema.md (16029 words, ratchet 15690, need −339)
  - docs/sync.md (14516 words, ratchet 14321, need −195)
  - docs/.doc-budget.json (the three ratchet entries)
  - docs/doc-conventions.md (§ The three vocabularies, § Where each one goes, § The size ratchet)
  - scripts/check-docs.mjs (Check C — the size ratchet; --update-ratchet / --force flags)
difficulty: medium
----

## Problem (confirmed at HEAD)

`node scripts/check-docs.mjs` (a.k.a. `yarn docs:check`, first link in `yarn check`) is red:

```
docs/runtime.md: 13840 words exceeds its ratchet of 13477 (+363) — a doc may shrink, never grow
docs/schema.md: 16029 words exceeds its ratchet of 15690 (+339) — a doc may shrink, never grow
docs/sync.md: 14516 words exceeds its ratchet of 14321 (+195) — a doc may shrink, never grow

3 documentation failure(s). See docs/doc-conventions.md.
```

Working tree == HEAD for all three — committed-state failure, not a dirty-tree artifact.

## Cause

Each doc grew via legitimate normative content from unrelated tickets that never trimmed
elsewhere nor raised the ratchet with a reason. The added content is genuine (RENAME TABLE
two-phase `finalizeRename`, inner-scan connection-reuse contract, sync `protocolVersion`
handshake) — **not bloat, do not delete it.** The gate went red because the ratchet baseline
was never reconciled. See the source fix ticket for per-commit attribution.

## What to do — trim back under the recorded ratchet (preferred)

Per `docs/doc-conventions.md`: narrative history is deleted (git log + `tickets/complete/`
already hold it); future/planned work leaves the docs for `docs/todo.md` or a backlog ticket
(leave at most a one-line `## Current limitations` pointer); normative invariants and
load-bearing rationale stay. Reclaim ~897 words total. Concrete candidates already scouted
(verify each is history/future/redundancy before cutting — do **not** cut normative rules):

### sync.md — need −195 (most slack here)
- `## Implementation Status` → `### Completed` + `### Remaining Work` (approx L1600–1775).
  "Completed" is a changelog; "Remaining Work" is future-work. Per conventions both leave the
  doc — delete Completed, move Remaining Work to `docs/todo.md`/backlog with a one-line pointer.
  This alone likely covers the 195 with margin.
- Secondary if needed: `### Single-Database Architecture (Store Phase 7) ✓` / `### Store
  Isolation (Store Phase 8 - Future)` phase-marker framing (L532, L552); the two long code
  walkthroughs `### Streaming Snapshot Example` (L1534) and `### Store Adapter for Remote
  Changes` (L1571) can be condensed.

### schema.md — need −339
- `### DDL Generation` (L243) and `### Catalog Import` (L225) prose verbosity.
- Legacy-reopen narrative around `store-pk-collate-legacy-reopen-divergence` (L435, L461) —
  keep the invariant/rationale, cut any "used to / historical behavior" narration.
- `### Store catalog persistence` (L283–521) is long; look for redundancy vs the type defs
  at the top, not for normative deletions.

### runtime.md — need −363
- `## Debugging and Common Pitfalls` (L1723–end): `### Debugging Techniques`, trace-command
  code samples (L1842–1864), `### Scope Resolution Debugging`, `### Context Lifecycle
  Management` — debugging narrative, high redundancy, prime trim target.
- `## Common Patterns` (L1329) example blocks — condense samples, keep the contract text.
- `## Context Debugging and Tracing` (L570) trace-env-var listing.

Word count = whitespace tokens over the whole file, **fenced code included** — condensing a
verbose code sample counts just as much as cutting prose.

## Fallback — raise the ratchet with a recorded reason

Only if a doc genuinely has no reclaimable slack after an honest trim pass:

```bash
node scripts/check-docs.mjs --update-ratchet --force
```

Do this per-doc, not blanket. `--force` raises **every** over-ratchet entry at once, so if you
only mean to raise one, trim the others under first, then run `--force`. The commit message
(runner writes it) must name which doc was raised and why — carry the reason in your handoff
so it lands in the commit. An unexplained raise is exactly what the ratchet exists to prevent,
and the repo direction is shrink (`debt-docs-shrink-remaining-megadocs`, commit fe4dae4a): all
three are already over the 12,000-word readability cap, so raising entrenches debt the team is
paying down. Prefer trim.

## Constraints

- **Preserve normative content.** RENAME TABLE two-phase protocol, inner-scan connection-reuse
  contract, sync `protocolVersion` strict-equality check are code-obeyed rules — they stay.
- **FORBIDDEN:** deleting the new normative content, loosening `check-docs.mjs`, editing the
  frozen `review.md`/`review.html`.
- **Out of scope:** the megadoc-split plan (`sql.md`, `view-updateability.md`, `lens.md`).
  This is the orthogonal ratchet-overage fix — don't conflate.
- Doc prose + one JSON ratchet file only. No invariant-register / determinism / byte-format /
  golden-fixture / migration obligations triggered.

## Verify

```bash
node scripts/check-docs.mjs        # must exit 0: "Docs OK: … sizes within ratchet …"
```

After trimming, lower the ratchet entries to the new sizes:

```bash
node scripts/check-docs.mjs --update-ratchet    # only ever lowers; expected routine
```

Then re-run the check to confirm green. If any entry was raised via `--force` instead of
trimmed, say which and why in the review handoff.

## TODO

- [ ] Trim sync.md under 14321 (start with `## Implementation Status`; move Remaining Work to todo.md/backlog).
- [ ] Trim schema.md under 15690 (DDL Generation / Catalog Import verbosity, legacy-reopen narration).
- [ ] Trim runtime.md under 13477 (Debugging and Common Pitfalls block, Common Patterns samples).
- [ ] For any doc with no slack: `--update-ratchet --force` that entry, record reason for commit.
- [ ] `node scripts/check-docs.mjs --update-ratchet` to lower trimmed entries.
- [ ] `node scripts/check-docs.mjs` exits 0.
- [ ] Confirm no normative content (RENAME TABLE protocol, connection-reuse, protocolVersion) was cut.
