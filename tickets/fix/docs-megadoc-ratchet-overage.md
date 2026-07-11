description: Three grandfathered megadocs (runtime.md, schema.md, sync.md) each grew past their `docs/.doc-budget.json` size ratchet without the ratchet being trimmed back or raised-with-justification, so `yarn docs:check` (hence `yarn check`) is red at HEAD. Restore the shrink-never-grow invariant — preferably by trimming each doc back under its recorded size, per the repo's active megadoc-shrink direction.
prereq:
files:
  - docs/runtime.md (13840 words, ratchet 13477, +363)
  - docs/schema.md (16029 words, ratchet 15690, +339)
  - docs/sync.md (14516 words, ratchet 14321, +195)
  - docs/.doc-budget.json (the three ratchet entries)
  - docs/doc-conventions.md § The size ratchet (the rule + the --force escape valve)
  - scripts/check-docs.mjs (Check C — the size ratchet)
difficulty: medium
----

## Failing check

```
node scripts/check-docs.mjs        # a.k.a. `yarn docs:check`, first link in `yarn check`
```

```
docs/runtime.md: 13840 words exceeds its ratchet of 13477 (+363) — a doc may shrink, never grow
docs/schema.md: 16029 words exceeds its ratchet of 15690 (+339) — a doc may shrink, never grow
docs/sync.md: 14516 words exceeds its ratchet of 14321 (+195) — a doc may shrink, never grow

3 documentation failure(s). See docs/doc-conventions.md.
```

Reproduces at HEAD (`main`). Working tree equals HEAD for all three docs — this is a
committed-state failure, not a dirty-tree artifact.

## Root-cause hypothesis

Each doc grew via **legitimate normative content** added by unrelated tickets that then
failed to trim elsewhere or raise the ratchet, leaving `yarn check` silently red:

- `docs/runtime.md` +363 — `runtime-nlj-inner-connection-reuse` (179c1f93) added the
  "Inner-scan connection reuse" section + two `RuntimeContext` fork-policy rows;
  `runtime-amortize-prepared-statement-setup` (3079aeae) added a few words.
- `docs/schema.md` +339 — `bug-rename-table-leaves-other-tables-catalog-stale` (acb9bce4)
  added the `RENAME TABLE` two-phase `finalizeRename` protocol + accepted-residue prose.
- `docs/sync.md` +195 — `sync-protocol-migrate-and-version` (41b6ef67) added the
  `protocolVersion` handshake field + the strict-equality version-check section.

The added content is genuine, dense, invariant-level documentation of real new behavior —
**not bloat**. Deleting it to make the numbers fit would erase legitimate normative docs and
is the wrong move. The defect is a process gap: the ratchet baseline was never reconciled
with the new content (neither trimmed nor `--force`-raised-with-reason), so the gate went red.

## What the fix must do

Restore `yarn docs:check` to green **without** any FORBIDDEN outcome (no assertion loosening,
no deleting the new normative content). Choose per doc:

1. **Preferred — trim back under the recorded ratchet.** Sort each doc's prose per
   `docs/doc-conventions.md` (rules the code must obey / rationale / history) and delete the
   history and redundancy until the doc is at or below its recorded size. This keeps the new
   normative content and pays down bloat, matching the repo's active shrink direction (see
   Design constraints). ~897 words total to reclaim across three ~14–16k-word docs.
2. **Fallback — raise the ratchet with a recorded reason.** If a doc genuinely has no slack
   to trim, run `node scripts/check-docs.mjs --update-ratchet --force` for *that* entry and
   carry the reason in the commit message (per `doc-conventions.md § The size ratchet`). Do
   **not** silently `--force` — an unexplained raise is exactly what the ratchet exists to
   prevent, and blanket-raising all three entrenches over-cap debt the team is actively fighting.

## Design constraints

- **Direction is shrink, not raise.** `debt-docs-shrink-remaining-megadocs` (plan, commit
  fe4dae4a) and its children (`docs-vu-split`, `docs-sql-split`, …) treat over-cap
  grandfathered docs as **debt to pay down**, not baselines to lift. All three failing docs
  are already over the 12,000-word readability cap. Prefer trimming; reserve `--force` for
  docs with no reclaimable slack, and justify it.
- **Preserve normative content.** The `RENAME TABLE` two-phase protocol, inner-scan
  connection-reuse contract, and sync `protocolVersion` check are code-obeyed rules. They stay.
- **These three are out of the megadoc-split plan's scope** (that plan covers `sql.md`,
  `view-updateability.md`, `lens.md`). This ticket is the ratchet-overage fix, orthogonal to
  the splits — do not conflate.
- No invariant-register / determinism / byte-format / golden-fixture / migration obligations
  are triggered: this is doc prose + one JSON ratchet file only.

## Verify

`node scripts/check-docs.mjs` exits 0 (`Docs OK: … sizes within ratchet …`). If any entry was
raised, the commit message names which and why.
