description: Docs for the isolation layer previously claimed snapshot isolation; corrected to describe the actual guarantee (read-committed + read-your-own-writes, no write-write conflict detection), since the original claim would mislead anyone relying on it.
files:
  - packages/quereus-isolation/README.md
  - docs/design-isolation-layer.md
  - packages/quereus-isolation/src/isolation-module.ts
  - AGENTS.md
difficulty: easy
----

## What changed

Pure documentation/comment correction — no runtime behavior changed. The
implementation provides **read-committed reads of shared state + read-your-own-writes**
with **no write-write conflict detection**, not the snapshot isolation the docs
previously promised. Team decision: do NOT implement snapshot isolation / conflict
detection in this layer; snapshotting is the underlying module's job.

Corrected in:
- `packages/quereus-isolation/README.md` — overview bullets + new `## Isolation Level` section.
- `docs/design-isolation-layer.md` — opening paragraph, Desired State bullet, new
  `## Isolation Level Provided` section, `ModuleCapabilities.isolation` doc-comment.
- `packages/quereus-isolation/src/isolation-module.ts` — `IsolationModule` class doc-comment.
- `AGENTS.md` — project-structure comment (added in review, see findings).

## Review findings

Read the full implement diff (`6c865ad6`) with fresh eyes before the handoff summary,
then independently verified the code behavior the docs now claim.

**Code-vs-docs accuracy (CONFIRMED correct):**
- Live shared reads: verified the overlay merges against the live underlying table —
  docs claim holds.
- Last-writer-wins / no conflict detection: verified `IsolatedTable.commit` →
  `flushAndClearOverlay` → `flushOverlayToUnderlying` (`isolated-table.ts:1295-1353`)
  flushes the overlay straight to the underlying with no cross-connection conflict
  check. Docs claim holds.

**Missed site — fixed inline (minor):**
- `AGENTS.md:47` still labeled the package `# Snapshot isolation layer` — the exact
  false claim this ticket exists to remove, missed by the implement pass (the
  implementer swept `packages/quereus-isolation` + `docs/` but not the root
  `AGENTS.md`, which `CLAUDE.md` imports). Corrected to
  `# Transaction isolation layer (read-your-own-writes; not snapshot isolation)`.

**Sweep — no other misleading claims (checked, empty for a reason):**
- Grepped `snapshot isolation|consistent reads|MVCC` across the package, `docs/`,
  `AGENTS.md`, `CLAUDE.md`. Remaining hits all belong to unrelated subsystems that
  genuinely do (or aspire to) provide snapshot semantics at their own layer and were
  correctly left alone: `docs/coordinator.md` (store-coordinator vs memory-layers
  comparison), `docs/memory-table.md` / `docs/runtime.md` / `docs/materialized-views.md`
  (memory vtab copy-on-write MVCC), `docs/store.md` (future `quereus-store` direction),
  and `design-isolation-layer.md:499` (correct — refers to the *overlay* module's own
  snapshot capability). `package.json` description was already neutral.
- Anchor links verified: README `#isolation-level` and design-doc
  `#isolation-level-provided` both resolve to their new headings.

**Style (noted, not changed):**
- The new README `## Isolation Level` (h2) sits directly before `### Key Features`
  (h3), so Key Features now nests under Isolation Level rather than the Architecture
  section it described before. Mildly awkward grouping but content stays correct and
  discoverable; the implementer flagged section-placement as a reasonable style call,
  and left as-is to keep the diff auditable. No functional impact.

**Tests / build:**
- `yarn workspace @quereus/isolation run build` — clean (exit 0).
- `yarn workspace @quereus/isolation run test` — 133 passing, 0 failing. No new tests
  added (docs/comment-only change; nothing new to assert in code — the existing suite
  is the only regression signal, which is appropriate here).
- No tripwires recorded — nothing conditional surfaced.
