---
description: A read-by-primary-key on an isolation-wrapped table used to crash ("Secondary index not found") whenever the table had a buffered write and the underlying storage named its primary key index with a numeric suffix; this fixes the crash and adds regression tests.
prereq:
files: packages/quereus-isolation/src/isolated-table.ts (PK_INDEX_NAME_RE / SUFFIXED_PK_IDXSTR_RE near line 15, parseIndexFromFilterInfo, adaptFilterInfoForOverlay), packages/quereus-isolation/test/isolation-layer.spec.ts (describe "suffixed primary-key index name (underlying-advertised)")
difficulty: medium
---

# Review: quereus-isolation misclassified suffixed primary-index names as secondary

## What the bug was

The isolation layer wraps an underlying virtual table with a per-connection **overlay**
(a MemoryTable holding uncommitted writes). On a read it merges overlay + underlying.
To pick the merge strategy it parses the scan's `idxStr` to decide *primary-key scan*
vs *secondary-index scan* (`parseIndexFromFilterInfo`).

An underlying table may advertise its PK access plan under a **suffixed** name.
lamina-quereus does exactly this: it appends a monotonic counter so it can recover the
exact plan later (`_primary_` → `_primary_1`, `_primary_2`, …). This is intentional and
load-bearing on the lamina side — the fix is entirely inside the isolation layer.

With any buffered write (a live overlay), a PK lookup carried `idxStr=idx=_primary_1(...)`.
The old classifier only matched the exact string `_primary_`, so `_primary_1` fell to
`secondary` and was forwarded to the overlay MemoryTable as a secondary-index scan —
which has no index named `_primary_1`, throwing
`QuereusError: Secondary index '_primary_1' not found.`

## What changed (and why it took two edits, not one)

The ticket framed the fix as classification **or** suffix-stripping ("or equivalently").
In practice **both** are required:

1. **Classification** (`parseIndexFromFilterInfo`): match the PK family
   `/^_primary_\d*$/` (base `_primary_` plus optional numeric suffix) → `{ type: 'primary' }`.
   This routes to the position-based PK merge instead of the secondary path.
2. **Overlay re-plan** (`adaptFilterInfoForOverlay`, previously a pass-through): even on
   the primary merge path, the overlay MemoryTable is queried with the *same* filterInfo.
   The overlay always names its PK index `_primary_` (no suffix), and its own scan planner
   (`scan-plan.ts` `resolveIndexName` → `scan-layer.ts`) resolves `_primary_1` to a
   *secondary* scan and throws the same error. So the suffixed `idx=_primary_<n>(...)` token
   is rewritten back to `idx=_primary_(...)` **only for the overlay query**. The underlying
   still receives the original suffixed idxStr (it recovers it via its own registry).

Both patterns are anchored to a **numeric** suffix, so genuine secondary names
(`_column_2_`, `_compound_x_`, `_nd_…`, `_intersect_…`) and any `_primary_`-prefixed
non-PK name (e.g. `_primary_extra_idx`) never match. No persisted-state impact — this is
planner/classification control flow only.

## How to validate

Build + tests, from repo root:

```
yarn workspace @quereus/isolation typecheck      # tsc --noEmit, clean
yarn workspace @quereus/isolation test           # 137 passing (4 new)
```

New tests live in `test/isolation-layer.spec.ts` under
`describe('suffixed primary-key index name (underlying-advertised)')`. They install a
`SuffixedPkMemoryModule` — a `MemoryTableModule` subclass that advertises its PK plan as
`_primary_1` and Proxy-wraps its tables so the underlying recovers the suffix (mimicking
lamina's private plan registry). Coverage:

- **PK point lookup through a live overlay** — the original repro
  (`insert` to create the overlay, then `select … where id = 1`). Threw before the fix.
- **Bare `_primary_` with no live overlay** — unchanged pass-through behavior.
- **PK range scan through a live overlay** (`where id >= 2`) — exercises the range plan,
  not just the equality seek.
- **Genuine secondary index (`idx_email`) with a live overlay** — proves the PK-suffix
  rewrite does not disturb real secondary routing.

**Regression proof:** I temporarily reverted both edits and confirmed the point-lookup /
range tests fail with the exact `Secondary index '_primary_1' not found` error (thrown from
`mergedSecondaryIndexQuery`), then restored the fix and re-ran green.

## Reviewer: treat these as a floor, not a finish line

- **The `_primary_extra_idx` anchor is proven by construction, not by a runtime test.**
  The regex `/^_primary_\d*$/` cannot match a non-numeric suffix, and the "genuine
  secondary index still routes correctly" test uses a normal name (`idx_email`). I did
  **not** add an end-to-end test that names an index `_primary_extra` and scans it with a
  live overlay, because I was unsure the engine permits a `_primary_`-prefixed user index
  name and didn't want to reserve one. If you want belt-and-suspenders coverage of the
  anchor, that's the test to add (assert correct rows, not a throw).
- **The fix assumes the underlying's PK suffix is purely numeric** (lamina's current
  counter). A `NOTE:` tripwire sits at the regex definitions in `isolated-table.ts`. If an
  underlying ever mints a non-numeric unique PK name, both patterns (and the overlay strip)
  need widening. This is knowledge, not queued work — no ticket.
- **dist is gitignored and was NOT rebuilt.** Linked consumers (SiteCAD's
  `lamina-scope-switch.test.ts`, which imports this package via `portal:` → `dist`) need
  `yarn build` in `packages/quereus-isolation` to pick up the fix. That external
  confirmation (their "1 failed → 0") is out-of-band per the original ticket.

## Pre-existing, not mine

`checkMergedPKConflict` (`isolated-table.ts`) has an unused `tombstoneIndex` parameter —
flagged by the editor only because my constant insertion shifted its line number. It
predates this change, is not a build error (the package tsconfig sets no
`noUnusedParameters`), and is outside this fix's scope. Left untouched.

## Review findings

- Deviated from the ticket's "classification **or** strip" framing: both are required
  (the overlay MemoryTable re-plans the suffixed idxStr and throws even on the primary
  path). Documented above; implemented both.
- `_primary_extra_idx` anchor edge case is covered by the anchored regex but has no
  dedicated runtime test — parked as a reviewer-optional test suggestion above (not a
  ticket).
- Numeric-suffix assumption recorded as a `NOTE:` tripwire at the regex site in
  `isolated-table.ts` (greppable), not filed as a ticket.
