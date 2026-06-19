----
description: Turning a table into or out of a maintained/derived table fails when the engine runs inside the transaction-isolation wrapper, because the wrapper only forwards two of the five backing-store setup calls through to the real module; forward the other three so wrapped hosts can use maintained tables.
prereq:
files:
  - packages/quereus-isolation/src/isolation-module.ts   # constructor ~196-215: forward the 3 attach seams beside the 2 existing resolve-seam forwards (200-212)
  - packages/quereus/src/runtime/emit/alter-table.ts      # drives ensureBackingForAttach? / retireBackingForAttach? against the registered (wrapped) module
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # maintained-lifecycle attach/detach path
difficulty: easy
----

# `IsolationModule` must forward the durable-backing ATTACH seams

> **Design is fully resolved — implement-ready.** This is a self-contained, mechanical
> change following an existing in-file pattern; the plan pass should be a quick
> confirm-and-emit (run the conformance suite, enumerate the edge cases below, hand to
> implement). Surfaced from the lamina repo, where the consumer (`lamina-quereus-test`)
> already has six capability-gated tests waiting to auto-activate once this lands.

## Gap

`IsolationModule` implements the engine's backing-host capability across **five** optional
`VirtualTableModule` seams:

- **resolve seams** — `getBackingHost`, `createBacking`
- **attach seams** — `ensureBackingForAttach`, `retireBackingForAttach`, `discardBackingForAttach`

The constructor (`isolation-module.ts` ~196–215) forwards only the **two resolve seams** to
`this.underlying` — see the `underlyingGetBackingHost` block at ~200–204 and the
`underlyingCreateBacking` block at ~206–212, each assigned only when the underlying implements
it so method PRESENCE mirrors the underlying. It does **not** forward the three attach seams.

The engine drives the maintained-lifecycle verbs against the **registered** (wrapped) module —
`requireVtabModule(table)` → `runtime/emit/alter-table.ts` + `runtime/emit/materialized-view-helpers.ts`:

- `alter table … set maintained` → `module.ensureBackingForAttach?.(...)` then
  `resolveBackingHost` → `module.getBackingHost(...)`
- `alter table … drop maintained` → `module.retireBackingForAttach?.(...)`
- failed fresh attach → `module.discardBackingForAttach?.(...)`

Because the wrap drops `ensureBackingForAttach`, the optional call no-ops, the durable basis
`RowStore` is never created, and the immediately-following (forwarded) `getBackingHost` resolves
no store → **`QuereusError: backing host not found for 'main.<table>'`**. A maintained↔ordinary
transition through the wrap is impossible today. The bare-module path works (the underlying
implements all five); the gap is purely the wrap's missing forwards.

This blocks **any** wrapped host from `set maintained` / `drop maintained` /
`create … maintained`-detach. The motivating consumer — the SiteCAD worker on Lamina — always
registers `new IsolationModule({ underlying: laminaModule })`, never the bare module, so this is
the hard blocker for its maintained/derived tables.

## Fix

In the constructor, forward all three attach seams with the **same presence-mirroring pattern**
the two resolve seams already use — assign on `this` only when `this.underlying.<seam>` is a
function, so the wrapper advertises the capability iff the underlying does. Each is a **straight
delegate**; backing writes are privileged and bypass the per-connection overlay entirely (exactly
the rationale already documented on the `getBackingHost` forward), so there is **no** overlay
bookkeeping — unlike `createBacking`, these do not wrap a result in `IsolatedTable`:

```ts
const underlyingEnsure = this.underlying.ensureBackingForAttach;
if (underlyingEnsure) {
	this.ensureBackingForAttach = (...args) => underlyingEnsure.call(this.underlying, ...args);
}
// …identical for retireBackingForAttach and discardBackingForAttach
```

Match each seam's exact signature from the `VirtualTableModule` interface (the same interface the
underlying module declares the impls against).

## Edge cases & interactions

- **Presence mirroring is the contract.** The wrapper must advertise each attach seam iff the
  underlying does — never assign an attach forward unconditionally (a wrapper around a
  non-backing-host module must stay non-backing-host). Mirror the existing resolve-seam guards.
- **No overlay involvement.** Confirm the delegates do not create/touch a per-connection overlay
  — backing writes bypass the overlay (the `getBackingHost` doc comment is the precedent).
- **`discardBackingForAttach` on the failed-attach path** must reach the underlying so a failed
  fresh attach cleans up its partially-created backing rather than leaking it.
- **Re-attach across a second transition** (drop maintained → set maintained again) must work
  through the wrap, not just the first transition.

## Acceptance

- `@quereus/isolation`'s own conformance suite (`quereus-isolation/test/*.spec.ts`) stays green.
- No new persisted byte shape; no determinism / byte-format / migration obligation
  (forwarding-only change).
- **Downstream (informational — lives in the lamina repo, not this one):** the six
  capability-gated tests in `packages/lamina-quereus-test/src/maintained-isolation-wrap-lifecycle.test.ts`
  activate (the probe `wrapForwardsBackingAttachSeams()` flips true) and pass once this forward
  lands against the portal-linked checkout — set-maintained straddle (derived-wins), live
  maintenance propagation, drop-maintained straddle + ordinary writability, re-attach across a
  second transition, per-connection begin/commit overlay coherence, reshape-on-attach column
  coherence.
