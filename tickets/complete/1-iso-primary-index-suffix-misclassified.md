---
description: A read-by-primary-key on an isolation-wrapped table used to crash ("Secondary index not found") whenever the table had a buffered write and the underlying storage named its primary key index with a numeric suffix; this fixed the crash and added regression tests.
prereq:
files: packages/quereus-isolation/src/isolated-table.ts (PK_INDEX_NAME_RE / SUFFIXED_PK_IDXSTR_RE ~line 32, parseIndexFromFilterInfo ~463, adaptFilterInfoForOverlay ~511), packages/quereus-isolation/test/isolation-layer.spec.ts (describe "suffixed primary-key index name (underlying-advertised)")
difficulty: medium
---

# Complete: quereus-isolation misclassified suffixed primary-index names as secondary

## What the bug was

Isolation layer wraps an underlying virtual table with a per-connection **overlay**
(a MemoryTable holding uncommitted writes). On read it merges overlay + underlying.
To pick the merge strategy it parses the scan's `idxStr` to decide *primary-key scan*
vs *secondary-index scan* (`parseIndexFromFilterInfo`).

Underlying tables may advertise their PK access plan under a **suffixed** name.
lamina-quereus appends a monotonic counter to recover the exact plan later
(`_primary_` → `_primary_1`, `_primary_2`, …). With a live overlay a PK lookup carried
`idxStr=idx=_primary_1(...)`. The old classifier only matched the exact string
`_primary_`, so `_primary_1` fell to `secondary` and was forwarded to the overlay
MemoryTable as a secondary-index scan — which has no index named `_primary_1`, throwing
`QuereusError: Secondary index '_primary_1' not found.`

## What the fix did

Two edits, both inside the isolation layer (`isolated-table.ts`):

1. **Classification** (`parseIndexFromFilterInfo`): `PK_INDEX_NAME_RE = /^_primary_\d*$/`
   matches the PK family (base `_primary_` plus optional numeric suffix) → `{ type: 'primary' }`,
   routing to the position-based PK merge instead of the secondary path.
2. **Overlay re-plan** (`adaptFilterInfoForOverlay`, previously pass-through): even on the
   primary merge path the overlay MemoryTable is queried with the same filterInfo, and its
   own scan planner would re-throw the same error on `_primary_1`. So
   `SUFFIXED_PK_IDXSTR_RE = /(^|;)idx=_primary_\d+\(/` rewrites the suffixed
   `idx=_primary_<n>(...)` token back to `idx=_primary_(...)` **only for the overlay query**.
   The underlying still receives the original suffixed idxStr (it recovers it via its own
   registry).

Both patterns anchor to a **numeric** suffix, so genuine secondary names never match. No
persisted-state impact — planner/classification control flow only.

## Review findings

**Checked:** implement diff (src + tests) read fresh before the handoff; classifier ↔ overlay-strip
consistency; every call site of `parseIndexFromFilterInfo` / `adaptFilterInfoForOverlay`;
every literal `_primary_` occurrence in the isolation src; docs (`packages/quereus-isolation/README.md`)
for stale references; typecheck; full package test suite.

- **Correctness — classifier / strip consistency: confirmed.** Classification RE allows zero
  digits (`\d*`, so bare `_primary_` counts as PK) while the overlay-strip RE requires at least
  one (`\d+`, so bare `_primary_` is left alone) — the intended asymmetry. `idxMatch`
  (`/^(.*?)\((\d+)\)$/`) strips the `(n)` before the PK RE runs, so `_primary_1(3)` classifies
  as primary and strips to `idx=_primary_(3)` preserving the trailing args and any `;plan=…`
  suffix. Both RE are non-global — no `lastIndex`/`.replace` state hazards.
- **Primary-path re-plan wiring: confirmed.** `mergedQuery` line 380 calls
  `adaptFilterInfoForOverlay` on the primary path and forwards the *original* (suffixed)
  filterInfo to the underlying at line 382 — overlay gets the base name, underlying recovers
  its own suffix. Both streams end up PK-sorted, so the position-based merge stays consistent.
- **Blast radius: confirmed contained.** The isolation layer's own hand-built PK filters
  (`buildPKPointLookupFilter`, lines 1017/1116/1466) always use bare `idx=_primary_(0)`, which
  the overlay resolves natively and which the strip RE ignores — unaffected. No other literal
  `_primary_` comparison exists in the isolation src.
- **Docs: no update needed (stated, not silent).** `README.md` is the only markdown in the
  package and documents user-facing behavior, not idxStr classification internals; no doc
  references the changed symbols. Verified by grep — nothing stale.
- **Tests: pass.** `yarn workspace @quereus/isolation typecheck` clean;
  `yarn workspace @quereus/isolation test` → 137 passing (4 new). New suite covers PK point
  lookup through a live overlay (the original repro), bare `_primary_` with no overlay
  (pass-through), PK range scan through an overlay, and a genuine secondary index (`idx_email`)
  through an overlay (proves the PK-suffix rewrite does not disturb real secondary routing).
- **Test-mock DRY (minor, no action):** the spec's `recoverSuffixedPk` re-declares the strip
  regex rather than importing `SUFFIXED_PK_IDXSTR_RE`. Left as-is intentionally — it mocks the
  *underlying-side* plan-recovery (mimicking lamina's private registry), a deliberately separate
  concern from the fix; coupling the test to the source constant would misrepresent it.
- **`_primary_extra_idx` anchor edge case (reviewer-optional, NOT filed):** the non-numeric-suffix
  anchor is proven by construction (`/^_primary_\d*$/` cannot match a non-numeric suffix) and by
  the `idx_email` secondary test, but has no dedicated runtime test naming an index `_primary_extra`
  and scanning it under a live overlay. The implementer skipped it (unsure the engine permits a
  `_primary_`-prefixed user index name); belt-and-suspenders only. Not a defect — no ticket.
- **Numeric-suffix assumption (tripwire, parked in code):** the fix assumes the underlying's PK
  suffix is a bare numeric counter. A `NOTE:` tripwire sits at the regex definitions
  (`isolated-table.ts` ~line 27) — greppable, not filed as a ticket. If an underlying ever mints a
  non-numeric unique PK name, both patterns and the overlay-strip need widening.
- **`checkMergedPKConflict` unused `tombstoneIndex` param (pre-existing, not this diff):** flagged
  by the editor only because the constant insertion shifted its line number; predates this change,
  no `noUnusedParameters` in the package tsconfig so not a build error. Out of scope — left untouched.

**Empty categories:** no major findings (nothing warranting a new ticket); no new bugs surfaced by
the added edge/error-path coverage; no security or resource-cleanup concerns (control-flow-only change).

## Out-of-band confirmation

`dist` is gitignored and was NOT rebuilt. Linked consumers (SiteCAD's `lamina-scope-switch.test.ts`,
importing this package via `portal:` → `dist`) need `yarn build` in `packages/quereus-isolation` to
pick up the fix. That external "1 failed → 0" confirmation is out-of-band per the original ticket.
