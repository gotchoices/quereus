----
description: Forward the three durable-backing attach seams through IsolationModule so wrapped hosts can use maintained/derived tables.
files:
  - packages/quereus-isolation/src/isolation-module.ts
  - packages/quereus-isolation/test/attach-seam-forwarding.spec.ts
----

## Summary

`IsolationModule` now forwards all three attach-lifecycle seams to its underlying module,
each guarded by presence-mirroring so the wrapper advertises the capability iff the underlying
does:

- `ensureBackingForAttach` — engine creates the durable backing before resolving the host on a
  `set maintained` attach
- `retireBackingForAttach` — `drop maintained` migrates rows back into ordinary storage
- `discardBackingForAttach` — failed fresh attach drops the just-created (empty) backing

Each is a straight delegate via `.call(this.underlying, …)` with no overlay bookkeeping —
consistent with the existing `getBackingHost`/`createBacking` forwards (backing writes are
privileged and bypass the per-connection overlay).

## Review findings

### What was checked

- **Diff read first, fresh.** Reviewed `289ac989` before the handoff summary.
- **Seam-signature parity** — the three property declarations
  (`isolation-module.ts:199-201`) match the `VirtualTableModule` interface exactly
  (`packages/quereus/src/vtab/module.ts:310-360`): arg names, arg order, and `Promise<void>`
  return all align.
- **Presence-mirroring & binding** — the three constructor blocks
  (`isolation-module.ts:224-240`) replicate the existing `getBackingHost`/`createBacking`
  pattern precisely: assign on `this` only when `this.underlying.<seam>` is present, and delegate
  with `.call(this.underlying, …)` so `this` stays bound to the underlying.
- **Overlay correctness** — confirmed the delegates create/touch no per-connection overlay,
  matching the documented backing-write-bypasses-overlay rationale.
- **Error handling / type safety** — async rejections propagate (no swallowing); no `any`;
  signatures fully typed.
- **Validation** — `@quereus/isolation` conformance suite **133 passing** (was 128); full
  `yarn test` **green across all packages** (6368 + 133 + 73 + 671 + 429 + … passing, 9 pending,
  0 failing — the `boom`/`batch write failed` lines are intentional error-path test logs);
  `@quereus/quereus` lint clean (exit 0); new spec type-checks under `tsconfig.test.json`.

### Found & fixed inline (minor)

- **Zero in-repo coverage of the forward (fixed).** The implementer's own "Known gaps" flagged
  that nothing exercised the forwarding through an `IsolationModule` wrap — the in-`@quereus/quereus`
  `materialized-view-discard-backing.spec.ts` hits a bare `MemoryTableModule`, so the
  presence-mirroring guard and the `.call` binding were untested. Added
  `packages/quereus-isolation/test/attach-seam-forwarding.spec.ts` (5 tests, mirroring that
  spec's spy shape): positive presence-mirroring (spy underlying → all three advertised), negative
  presence-mirroring (plain memory underlying → none advertised), arg-forwarding for
  ensure/retire/discard (exact args, in order), and `this`-binding (a bare delegate would throw on
  `this.calls.push`). These directly guard the changed lines against the realistic regression
  modes (dropped guard, wrong arg order, lost `this`).

### Noted, not actioned

- **Unrelated changes bundled in the commit (NOT reverted — working-tree rule).** Commit
  `289ac989` also contains `packages/quereus/src/planner/rules/access/rule-select-access-path.ts`
  plus two sqllogic files (`02.1-bind-parameters`, `07.7.1-in-extras`) belonging to a different
  ticket (`quereus-single-element-in-list-matches-all`, already in `complete/`). These are outside
  this ticket's scope; that ticket owns their review. The full test suite and quereus lint both
  pass, so the bundling breaks nothing — flagged only for traceability. No revert performed
  (concurrent runner/human board moves are not ours to undo).

### Major findings

- **None.** No new fix/plan/backlog ticket filed.

### Coverage judgment — no follow-up ticket

The implementer's remaining "known gap" is a full engine-driven `set maintained → drop maintained`
lifecycle *through* the wrap. This is **not** filed as a major ticket: the engine-side lifecycle is
already covered on a bare module by the in-`@quereus/quereus` discard-backing spec, the only
wrap-specific risk surface (presence + binding + args) is now covered by the new unit spec, and the
true end-to-end is covered downstream by the six capability-gated lamina tests
(`maintained-isolation-wrap-lifecycle.test.ts`, auto-activating once this lands). A full
engine-through-wrap integration test would be redundant for the risk it covers.

## Downstream (informational — lives in the lamina repo)

The six capability-gated tests in `packages/lamina-quereus-test/src/maintained-isolation-wrap-lifecycle.test.ts`
activate once `wrapForwardsBackingAttachSeams()` flips true against the portal-linked checkout, and
exercise the full lifecycle through the wrap. Cannot run in this repo.
