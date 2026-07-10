description: Review an off-by-default debug check that catches silent wrong-row bugs where a streaming query operator forgets to update its "current row" bookkeeping and a later read quietly returns the wrong row.
prereq:
files: packages/quereus/src/runtime/strict-flags.ts, packages/quereus/src/runtime/strict-fork.ts, packages/quereus/src/runtime/context-helpers.ts, packages/quereus/src/runtime/parallel-driver.ts, packages/quereus/src/runtime/emit/aggregate.ts, packages/quereus/src/runtime/emit/hash-aggregate.ts, packages/quereus/src/runtime/emit/window.ts, packages/quereus/src/runtime/emit/asof-scan.ts, packages/quereus/test/runtime/fork-contract.spec.ts, packages/quereus/test-runner.mjs, packages/quereus/package.json, package.json, docs/runtime.md
difficulty: hard
----

# What was built

An env-gated, off-by-default runtime assertion — `QUEREUS_CONTEXT_STRICT` — that detects the
**operator-shadows-child stale-shadow** bug directly, modeled on the existing
`QUEREUS_FORK_STRICT` harness. When a streaming operator leaves a row context built from its
source's attribute IDs winning the shared `attributeIndex` while a child updates a newer row
for the same IDs, a downstream column read resolves to the operator's stale row — a silent
wrong result. This harness turns that into a loud `context-strict:` error.

## Shape of the change

- **`runtime/strict-flags.ts` (new).** Leaf module (no imports) exporting `FORK_STRICT` and
  `CONTEXT_STRICT` booleans, read once from env. It exists solely to break the import cycle
  that would form if `context-helpers.ts` read the flag from `strict-fork.ts`
  (`context-helpers` → flags ← `strict-fork` → `context-helpers`).
- **`runtime/strict-fork.ts`.** The existing `StrictRowContextMap` now carries *both* concerns.
  Fork-strict state is nullable; context-strict adds a monotonic `clock`, per-descriptor
  `epoch` (bumped on `set()` and each `noteRowSet()`), a per-attr `winnerByAttr` kept in
  lockstep with `attributeIndex` (updated in `set`/`delete`), a diagnostics `installer` map,
  and the `assertNoShadow` check. `createStrictRowContextMap()` returns the subclass when
  *either* flag is on, vanilla `RowContextMap` when both off.
- **`runtime/context-helpers.ts`.** `RowContextMap` gains two `declare`d optional hooks
  (`noteRowSet?`, `assertNoShadow?`) that are `undefined` on the base map and implemented as
  arrow-field overrides on the subclass. `set` takes an optional `installer` (ignored by base).
  `createRowSlot`'s per-row `set` bumps the epoch under the flag; `resolveAttribute` gets a
  single leading `if (CONTEXT_STRICT) rctx.context.assertNoShadow?.(...)`. New exported type
  `ContextInstaller` and the now-exported `descriptorEntries`.
- **`runtime/parallel-driver.ts`.** `fork()` now always builds the child context via
  `createStrictRowContextMap()` (so context-strict forks are checkable), while table-context
  wrapping and fork bookkeeping stay gated on fork-strict.
- **Emitters.** Best-effort installer labels threaded into the direct-`set` sites of
  `aggregate.ts` / `hash-aggregate.ts` / `window.ts` (operator `{nodeType,id}` object) and the
  `createRowSlot` calls in `window.ts` (source slot) and `asof-scan.ts` (`AsofScan#id:left|right`).
- **Wiring.** `--context-strict` in `test-runner.mjs`; `test:context-strict` script in the
  quereus package; root `test:context-strict` script and it added to the `check` gate after
  `test:fork-strict`.
- **Docs.** `docs/runtime.md` — the invariant section now points at the harness, and a new
  "Strict context-shadow test mode" subsection documents what it asserts, what it deliberately
  does not (the reactivate/mirror direction), gating, and entry points.

# The one design decision to scrutinize (divergence from the ticket)

The ticket's pseudocode asserts on **pure recency**: throw if any live same-attr descriptor
has `lastTouchEpoch > winnerEpoch`. That over-fires. The first full-suite run tripped on
`basic.spec.ts` "should support parameters in recursive CTE base case": the index winner was
the narrow `descendants(id)` context (attr 1708) and the "shadow" was the wider join-output
row `[d.id, t.id, t.parent_id, t.name]` — which re-carries `d.id` at its own column with the
**same value**. Reading through either context returns the same value; there is no wrong-row.

The refinement I shipped: `assertNoShadow` compares the **value at the resolved column**
(`row[col] === winnerVal`) and only throws when a strictly-newer context resolves a
**differing** value. This is the precise "observable wrong-row" condition and subsumes the
earlier object-identity idea. **Please confirm you're comfortable with this**, because it has
two consequences:

1. **It slightly weakens detection vs pure recency.** A genuine stale-shadow whose stale and
   current values happen to coincide *for a particular read* is not flagged — but that read is
   genuinely benign, and a differing-value read (same bug, different data) trips it. Sound for
   "observable wrong-row", but it is a real semantic choice, not a mechanical translation of
   the ticket.
2. **`===` on values is reference equality for blobs (`Uint8Array`).** Two distinct blob
   objects with identical bytes at a shared column would false-positive. Not observed in the
   suite (`NOTE`/tripwire-worthy). If it ever bites, swap the shared-column comparison for a
   value-aware SQL comparison. Flagged here rather than parked in code since it's a judgment
   call for the reviewer.

# Validation performed (this is a floor, not a ceiling)

- **Full logic suite green under the flag.** `yarn workspace @quereus/quereus test:context-strict`
  → EXIT 0. Cross-checked dot count (455) and exit against the normal run (`yarn test`) and the
  fork-strict run (`yarn test:fork-strict`) — all three identical (455 dots, EXIT 0). `--bail`
  is on, so any single trip → nonzero. No trips, no regressions. Note: mocha's dot reporter did
  not emit a "N passing" summary line to a redirected file on this Windows/Git-Bash setup, so I
  relied on exit code + dot parity rather than a printed count — worth a reviewer re-run if you
  want the printed summary (`yarn workspace @quereus/quereus test:context-strict --reporter spec`).
- **Focused unit tests** added to `test/runtime/fork-contract.spec.ts` (mirroring the
  strict-fork tests, `this.skip()` when the flag is unset):
  - `createStrictRowContextMap` returns a plain map (no shadow hooks) when both flags off.
  - deliberate stale-shadow (operator wins index, child sets a newer **differing** row) throws
    `/context-strict:/`.
  - correct tear-down (operator `close()`s before child advances) does not throw; read resolves
    to the child row.
  - correct `reactivate()` (operator re-wins and stays newest) does not throw.
  - two live descriptors sharing an attr but the same value do not throw.
  All 5 pass under `QUEREUS_CONTEXT_STRICT`; skip cleanly otherwise; the "returns plain" one runs
  and passes in the normal run.
- `yarn lint` clean (includes test-file typecheck via `tsconfig.test.json`). `yarn build` clean.
  `yarn docs:check` passes for `runtime.md` (ratchet bumped 13032→13477 for the required doc
  growth — reviewer/committer please note).

## Suggested reviewer checks (not yet done — the harness's own "does it catch the bug?" proof)

- **Negative-control the detector.** Temporarily break a tear-down and confirm the suite trips
  under the flag: e.g. comment out `demote()` at the end of the streaming loop in
  `emit/window.ts`, or the `cleanupPreviousGroupContext()` call before the next pull in
  `emit/aggregate.ts`. Expect a `context-strict:` throw. (I reasoned through these paths but did
  not run the mutation — it's the highest-value confirmation that detection isn't vacuous.)
- **asof-scan coverage.** The merge variant's `reactivate()` path is the designed
  not-should-trip case; confirm asof logic tests actually execute under the flag (grep the
  suite for asof coverage) rather than trusting the static argument in the code comments.
- Eyeball the `delete()` winner-rebuild vs `super.delete()`'s `attributeIndex` rebuild — both
  iterate remaining entries forward (last-wins); a divergence there would cause false
  positives/negatives at the delete boundary.

# Known gaps / deliberately out of scope

- **Mirror direction (child-shadows-operator)** — an operator that forgets `reactivate()` and a
  child's genuinely-newer look-ahead wins — is *not* detectable by recency and is parked in
  backlog `debt-context-shadow-reactivate-direction` (already exists). Not attempted.
- **Installer labels are incremental.** Threaded into the aggregate/window/asof emit sites and
  the `createRowSlot` signature; `withRowContext`/`withAsyncRowContext` accept a label param but
  their one-shot call sites pass none (degrade to attr-ID list). Detection never depends on
  labels.
- **Reader-operator field** is best-effort from `planStack` top and only populated when tracing
  is enabled; otherwise the message says `unknown (planStack empty; enable trace-plan-stack)`.
- **Cost tripwire** noted at the `resolveAttribute` call site: the per-read check is O(live
  contexts carrying the attr); if a pathological plan makes strict CI slow, index the per-attr
  candidate list.

# Pre-existing failure (not mine)

`yarn docs:check` also fails on `docs/sql.md` (28750 words > ratchet 28657, +93). `sql.md` is
unmodified in this diff and already over-ratchet at HEAD (`git show HEAD:docs/sql.md | wc -w`
= 28750). Recorded in `tickets/.pre-existing-error.md` for the triage pass. This ticket
deliberately did not touch `sql.md`'s ratchet entry.
