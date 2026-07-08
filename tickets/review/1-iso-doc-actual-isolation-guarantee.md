description: Docs for the isolation layer previously claimed snapshot isolation; corrected to describe the actual guarantee (read-committed + read-your-own-writes, no write-write conflict detection), since the original claim would mislead anyone relying on it.
files:
  - packages/quereus-isolation/README.md
  - docs/design-isolation-layer.md
  - packages/quereus-isolation/src/isolation-module.ts
difficulty: easy
----

## What changed

Pure documentation/comment correction — no runtime code touched, no behavior
changed. Confirmed via `docs/review.html` (an earlier automated review of this repo)
that this exact gap was already flagged as HIGH severity: "Isolation layer doesn't
deliver its documented snapshot isolation (reads see live shared state; no
write-write conflict detection)" at `quereus-isolation/src/isolated-table.ts:315,1325`.
This ticket closes that finding on the docs side, per team decision to *not*
implement snapshot isolation or write-write conflict detection in this layer.

1. **`packages/quereus-isolation/README.md`**
   - Overview bullet list (`Snapshot isolation — Consistent reads throughout the
     transaction`) replaced with an accurate bullet describing read-committed reads
     of shared state, plus a new "No write-write conflict detection" bullet.
   - New `## Isolation Level` section added right after the Architecture diagram,
     spelling out: read-your-own-writes, live (non-snapshot) reads of the underlying
     table, no write-write conflict detection, and that stable-snapshot semantics are
     delegated to whatever module is wrapped by `underlying` (with a note that an
     optional snapshotting pass-through module may be added below the isolation layer
     in future — doesn't exist today).
   - Dropped the "MVCC-style" framing from the package overview sentence (line 7),
     since it implies snapshot semantics this layer doesn't provide.

2. **`docs/design-isolation-layer.md`**
   - Opening paragraph (line 5) no longer claims snapshot isolation; explicitly
     states it's not provided and points to the new section.
   - "Desired State" bullet list corrected (was "consistent MVCC-style isolation
     semantics").
   - New `## Isolation Level Provided` section added after the "Per-Connection
     Overlay Architecture" subsection (before "Core Concepts"), with the same
     four-point guarantee as the README, phrased with references to the actual
     mechanism (`IsolatedTable.query` merging against the live underlying table,
     `flushOverlayToUnderlying` being the last-writer-wins commit path).
   - `ModuleCapabilities.isolation` doc-comment corrected — no longer says "snapshot
     reads"; now notes RYOW only, and that snapshot behavior (if any) is
     module-specific.
   - Left `docs/store.md:472` and `docs/runtime.md:971` and
     `docs/materialized-views.md:230` alone — those describe the **memory vtab
     module's own** copy-on-write snapshot mechanism and a **future/unimplemented**
     `quereus-store` direction, both unrelated subsystems that do genuinely provide
     (or aspire to provide) snapshot semantics at their own layer. Correcting those
     would be out of scope / incorrect.

3. **`packages/quereus-isolation/src/isolation-module.ts`**
   - Class-level doc comment on `IsolationModule` (~line 108) corrected from
     "Snapshot isolation (reads see consistent state)" to an accurate description
     with the same caveats as the README/design doc.

## Verification

- `yarn build` in `packages/quereus-isolation` — clean.
- `yarn test` in `packages/quereus-isolation` — 133 passing, 0 failing (unchanged
  from before; this ticket touched no runtime logic).
- Grepped both the package and `docs/` for remaining `snapshot isolation` /
  `consistent reads` / `MVCC` phrasing; every remaining hit is either a correct
  negation ("this is NOT snapshot isolation") introduced by this ticket, or belongs
  to an unrelated subsystem (see above) that wasn't touched.

## What the reviewer should sanity-check

- Whether the new "Isolation Level" / "Isolation Level Provided" wording is placed
  well relative to the rest of each doc's flow (I inserted them as new sections
  rather than editing existing prose in place, to keep the diff auditable — a
  reviewer preferring inline integration into "Key Features" / "Per-Connection
  Overlay Architecture" instead of standalone sections is a reasonable style call).
- I did not touch `packages/quereus-isolation/src/isolated-table.ts` or
  `isolated-connection.ts` beyond reading them for verification — the ticket's file
  list included them as evidence of the real behavior (merge-reads-live-underlying),
  not as places needing a doc claim fixed. I found no misleading "snapshot isolation"
  comment in either file (isolated-connection.ts:49 in the original ticket's file
  list is just `commit()` logic with no such claim in its docstring) — confirm you
  agree nothing there needs a comment update.
- No new tests were added (this is a docs-only change with nothing new to assert in
  code); the existing 133-test suite passing is the only regression signal.
