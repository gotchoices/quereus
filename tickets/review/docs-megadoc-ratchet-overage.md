description: Three design docs had grown past their size limits and turned the docs check red; they were trimmed back under the limits by removing changelog/future-work prose and de-duplicating repeated explanations, so the check is green again — no size limit was raised.
prereq:
files:
  - docs/sync.md (deleted "## Implementation Status"; added "## Current limitations" pointer)
  - docs/runtime.md (rewrote "## Debugging and Common Pitfalls" as a slim checklist)
  - docs/schema.md (de-duplicated store-tag-persistence prose; consolidated reserved-tag validation section)
  - docs/todo.md (added "## Sync Engine Remaining Work" — moved from sync.md)
  - docs/.doc-budget.json (ratchet entries lowered for the three docs)
  - scripts/check-docs.mjs (the gate — unchanged)
difficulty: medium
----

## What this was

`node scripts/check-docs.mjs` (first link in `yarn check`) was red: three docs exceeded
their recorded word-count ratchets (`docs/.doc-budget.json`) — `runtime.md` +363,
`schema.md` +339, `sync.md` +195. The overage was legitimate normative content added by
earlier tickets that never trimmed elsewhere; the ratchet baseline was never reconciled.

## Outcome — trimmed under, **no `--force` raise**

All three docs were brought under their **existing** ratchets by honest trimming, then the
ratchet entries were lowered to the new sizes. The gate is green:

```
node scripts/check-docs.mjs   →   exit 0
"Docs OK: links resolve, invariants well-formed, sizes within ratchet, tiers declared."
```

| doc | before | after | ratchet (lowered) |
| --- | --- | --- | --- |
| runtime.md | 13840 | 13265 | 13477 → 13265 |
| schema.md | 16029 | 15672 | 15690 → 15672 |
| sync.md | 14516 | 13511 | 14321 → 13511 |

Only prose + `docs/.doc-budget.json` changed. **No code touched**, so build / lint / test
are unaffected and were not run — the docs gate is the relevant (and passing) check.

### What was removed (per `docs/doc-conventions.md`: history deleted, future→todo, normative stays)

- **sync.md** — deleted the whole `## Implementation Status` section: `### Completed` was a
  per-phase changelog (git log + `tickets/complete/` already hold it); `### Remaining Work`
  was future-work. The genuinely-open items were moved to a new `docs/todo.md`
  §"Sync Engine Remaining Work"; a `## Current limitations` pointer replaces the section.
  Completed (`[x]`) changelog lines were dropped, not carried to todo.md. (−1005 words — well
  past the −195 needed; comfortable margin.)
- **runtime.md** — the `## Debugging and Common Pitfalls` block (993 words) was almost all
  restatement of content already canonical earlier in the same doc: context-helper API
  (`Row Context Management`, L318), `resolveAttribute` tiers (`Column Reference Resolution`,
  L356), tracing env-vars (`Context Debugging and Tracing`, L570), scope resolution. Replaced
  with a slim checklist that **keeps the one load-bearing piece** — the "avoid a per-row
  microtask hop / branch on `instanceof Promise`" performance contract (not documented
  elsewhere) — and cross-references the canonical sections for the rest.
- **schema.md** — the honest-trim work (no future/history to delete here; the doc is uniformly
  normative), three edits:
  1. De-duplicated the store-tag-persistence explanation (it was stated ~4×: the L110
     paragraph and the Tag-drift-detection paragraph both restated the full mechanism that
     lives in `### Store catalog persistence`). Trimmed to cross-references.
  2. Condensed the RENAME "full cross-table atomicity" **future-hardening** sentence.
  3. **Consolidated the 5-paragraph `#### Reserved-tag validation on the declarative path`
     section** (~700 → ~440 words) — the largest reclaim. This is the highest-risk edit; see
     review focus below.

### Protected normative content — confirmed intact (untouched by the edits)

- **RENAME TABLE two-phase `finalizeRename`** protocol + residues — `schema.md`
  §"Store catalog persistence" (`grep finalizeRename docs/schema.md` → 2 hits, unchanged).
- **Inner-scan connection-reuse contract** — `runtime.md` §"Inner-scan connection reuse"
  (L1400, unchanged; edits were confined to the trailing Debugging section).
- **sync `protocolVersion` strict-equality handshake** — `sync.md` §"Protocol version"
  (L937, unchanged; edits were confined to the trailing Implementation Status section).

## Review focus / known gaps (treat my edits as a starting point)

1. **Highest risk: the schema.md reserved-tag consolidation.** I compressed 5 paragraphs into
   ~440 words claiming to preserve *all 19* distinct rules. **Please diff before/after**
   (`git show HEAD~<n>:docs/schema.md` vs working, or the eventual commit diff) and confirm no
   rule was dropped. Rules that must survive: the five site names and their object mappings
   (`physical-table`/`-column`/`-constraint`, `view-ddl`, `physical-index`); constraint
   siting (table-level named-or-not → `physical-constraint`; inline *named* → `physical-constraint`;
   inline *unnamed* → deferred to `physical-column`, no double-validation; rename keys off
   named only); `DROP TAGS` does **no** validation on any object; the two blind spots
   (`CREATE VIEW`/`MATERIALIZED VIEW … WITH TAGS` not eagerly validated + `quereus.sync.replicate`
   silently inert on a direct create but validated on the declarative path; import/load path
   ungated by design); validation fires under `IF NOT EXISTS` and regardless of
   `nondeterministic_schema`; free-form tags skipped; helper names `raiseStmtTagDiagnostics`,
   `raiseReservedTagDiagnostics`, `columnTagDiagnostics`.
2. **Dropped source-file pointers.** The consolidation dropped a few parenthetical paths
   (`planner/building/alter-table.ts`, `planner/building/ddl.ts`, `planner/building/tag-diagnostics.ts`).
   All *symbol* names remain (greppable); restore a path if you think it earns its words.
3. **schema.md has ~zero ratchet headroom** — 15672 vs the lowered ratchet 15672. If review
   restores any word to schema.md, either re-lower the ratchet (`--update-ratchet`) or offset
   it with another trim. runtime.md (+212) and sync.md (+810) have comfortable headroom.
4. **sync.md Remaining-Work migration.** I carried only the genuinely-open (`[ ]`) items to
   `docs/todo.md`; some old lines were `[x]` (done) and were dropped as changelog. I did **not**
   re-verify each surviving item against the current code — they are as-was in the old doc.
5. **Anchors** — the sync.md `## Current limitations` pointer references two same-page anchors
   (`#transactional-integrity-during-sync`, `#store-isolation-store-phase-8---future`) and the
   new `todo.md#sync-engine-remaining-work`. All resolve (Check A green), but they're new links.

## How to validate

```bash
node scripts/check-docs.mjs            # exit 0, "Docs OK: … sizes within ratchet …"
git diff docs/schema.md                # confirm reserved-tag section preserves all 19 rules
grep -c finalizeRename docs/schema.md  # 2 — RENAME two-phase protocol intact
```

Tripwire (noted, not filed): the docs remain **over the 12,000-word readability cap** the
project is paying down (`debt-docs-shrink-remaining-megadocs`). This ticket reconciled the
ratchet, not the cap; the megadoc-split plan (`sql.md`/`view-updateability.md`/`lens.md`) is
the separate track for that. Recorded here so it surfaces to whoever reads this handoff.
