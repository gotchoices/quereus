description: Once the persistent store commits whole transactions atomically, let a materialized view trust its saved-to-disk contents after a crash instead of always rebuilding them on reopen — but first settle how the engine should remember, durably, which views had gone out-of-date before the crash, since atomic commit alone does not cover that case.
prereq: store-module-wide-coordinator
files:
  - packages/quereus-store/src/common/store-module.ts          # rehydrateCatalog trust computation; consumeCleanShutdownMarker; closeAll stale-set
  - packages/quereus/src/core/database-materialized-views.ts    # where mv.derivation.stale is set (~537, ~737) / cleared
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts # stale clear on refresh/recompile (~2736); mvStaleKey
  - docs/materialized-views.md                                  # § Cross-module atomicity, gates 4–5 + caveats
difficulty: hard
----

# Drop the MV adopt clean-shutdown gate for same-module backings in an atomic domain

The MV "adopt-without-refill" fast path (`docs/materialized-views.md`
§ Cross-module atomicity) registers a pre-existing durable backing as-is on
reopen iff five gates hold. **Gate 5** (host attested a clean shutdown AND the MV
was not stale-at-close) exists only because, historically, "same module" did
**not** imply one atomic commit — coordinators were per-table and each KV store
committed its own batch, so a crash could leave a source and a backing divergent
*inside one module*. The prereq `store-module-wide-coordinator` closes that
crash-divergence window: with `provider.beginAtomicBatch` present, a source and a
same-module backing now commit/roll back in one all-or-nothing batch.

The payoff this ticket targets: when the atomic capability is present, **gate 4
alone** (every source in the backing's module; MV-over-MV upstreams adopted)
should suffice for same-module backings, so the common durable path adopts without
refill **after a crash** too — not only after a clean reopen. Today a crash leaves
no clean-shutdown marker, so `consumeCleanShutdownMarker` returns
`{ trusted: false }` and `rehydrateCatalog` (`store-module.ts:2216`,
`trustBackings: trusted && !staleAtClose.has(entry.name)`) refills everything.

## The unresolved design question — why this stays in plan, not implement

**Gate 5 conflates two distinct windows, and the atomic domain closes only one:**

1. **Crash divergence** — source written, backing not (or vice versa) at the
   moment of a crash. **The atomic commit domain closes this.** ✔

2. **Logical staleness** — an MV whose row-time maintenance was *detached
   mid-session* by a body-relevant source schema change (`mv.derivation.stale =
   true`, set in `database-materialized-views.ts:537/737`) and never re-armed by a
   `refresh`. Subsequent source writes simply **never reached** the backing — the
   backing was not written, so there is nothing for atomicity to make consistent.
   **The atomic domain does NOT close this.** ✘

`mv.derivation.stale` is **in-memory-only runtime state**. The *only* durable
record of staleness today is the clean-shutdown marker's `staleAtClose` payload,
written by `closeAll` (`store-module.ts:2574`). A crash loses the marker, so after
a crash **we do not know which MVs were stale.** Adopting a stale backing is
unsound: its content is permanently behind (the missed updates are never
re-applied once maintenance re-arms on reopen), so queries read stale results
forever — exactly the "unsound adopt resurrects divergence forever" failure the
doc warns about.

**Is this hole real, or does another gate catch it?** Partially caught, not fully:

- A staleness-causing change that alters the body's **output shape**
  (columns/types/PK/collation of an *output* column) is caught by **gate 2**
  (`backingShapeMatches`) on reopen → refill. Sound without any staleness record.
- But staleness also fires when `tryRecompileMaterializedViewLive` fails on a
  change that is shape-stable yet content-significant — e.g. a `set collate` (or
  type change) on a source column used only in a `where`/`group by`, not an output
  column. Gate 2 passes (output shape unchanged) while the rows/groups that should
  appear changed. **This residual case would be adopted unsoundly after a crash.**

So "atomic domain ⇒ gate 4 alone is enough" is **not** sound as stated: it needs a
**durable** staleness signal that survives a crash. Resolving *how* to make
staleness durable is the substance of this plan pass — it touches engine MV
internals, not just the store, and has several viable shapes with non-trivial
tradeoffs. That is why this is a plan ticket: emitting an implement ticket now
would either ship the unsound version or leave the load-bearing decision to the
implementer.

## Recommended direction (to validate/refine in this pass)

**Durable incremental stale-set, ideally folded into the atomic commit.** The
store already subscribes to engine schema-change events
(`ensureSchemaSubscription`). The transition that creates staleness
(`mv.derivation.stale = true` on a body-relevant source `table_modified`) and the
transitions that clear it (`refresh` / `recompileMaterializedViewLive` /
re-register, `materialized-view-helpers.ts:2736`) are observable points. The
store can persist the current stale set — the same
`getAllMaintainedTables().filter(mv => mv.derivation.stale)` computation `closeAll`
already does — to a durable catalog meta entry whenever it changes, so the set
survives a crash. Then in the atomic domain `rehydrateCatalog` trusts
`!durableStale.has(entry.name)` **without** requiring the marker; the non-atomic
domain keeps the marker path exactly as today.

The elegant variant the new capability unlocks: write the updated stale-set
**inside the same atomic batch** as the DDL transaction that causes the staleness,
so a crash yields either the pre-DDL state (MV not yet stale, backing consistent)
or the post-DDL state (MV stale AND recorded) — never a torn pair. The atomic
domain then makes the durable stale-set always consistent with the actual backing
state.

### Open questions for the pass to settle

- **Where the staleness signal crosses engine→store.** Does the store reliably
  observe every staleness transition via existing schema-change events, including
  **MV-over-MV cascade** staleness (`emitBackingInvalidation` fires with same
  old/new object — does that reach the store listener)? If not, what minimal
  engine hook/event carries "these qualified names are now stale / no longer
  stale"? Prefer reusing the existing notifier over a new surface.
- **Persist cadence & cost.** Recompute-and-write the whole set on every relevant
  schema event (rare, simple, idempotent) vs. incremental add/remove. Schema
  changes are infrequent, so a full recompute-and-write is likely fine.
- **Atomicity of the stale-set write vs. the DDL commit.** Fold into the DDL
  transaction's atomic batch (best), or a synced point-write (like the existing
  marker-consume `sync: true` delete in `store-marker-sync-durability`)?
- **Coexistence with the clean-shutdown marker.** Keep writing the marker for the
  non-atomic path; in the atomic path the durable stale-set supersedes the marker's
  `staleAtClose` payload (and the marker's *clean-shutdown attestation* purpose is
  obsolete). Decide whether the marker is still written at all in a pure-atomic
  deployment, and how a mixed history (capability gained between sessions) behaves.
- **`staleAtClose` semantics parity.** The durable set must capture exactly what
  `closeAll` captures (lowercased qualified `schema.mv`, live-vs-memory-backed
  filtering is harmless per the existing `closeAll` note).

## Requirements / acceptance (for the implement ticket this pass produces)

- With `provider.beginAtomicBatch` present, MV adopt succeeds across a **simulated
  crash** (no clean-shutdown marker) for a **non-stale** same-module backing —
  gate 4 alone governs, gate 5's marker requirement is skipped.
- With the capability present, a **stale-at-close** MV still **refills** across a
  simulated crash (durable stale-set, not the lost marker, drives the exclusion) —
  proving the residual logical-staleness window stays sound.
- Without the capability (LevelDB w/o the shared root, any minimal provider), the
  marker gate governs **exactly as today** — full fallback parity.
- The residual shape-stable-but-content-stale case (e.g. source `set collate` on a
  filter/group column) refills after a crash in the atomic domain (regression test
  for the specific hole this pass identified).
- `docs/materialized-views.md` gate 5 + caveats updated: gate condition becomes a
  runtime capability check; the durable stale-set mechanism documented; the
  "subsuming fix tracked under backlog" notes resolved.
- `yarn test` / store typecheck green; MV adopt suite extended.

## Edge cases the eventual implement ticket must enumerate

- MV-over-MV chains: an upstream that refills must still force dependents to refill
  (the `adoptedBackings` ledger composes through fixpoint rounds — durable staleness
  must not bypass that).
- Capability appears/disappears between sessions (provider upgraded): a session that
  recorded a durable stale-set under the capability, reopened by a build without it,
  and vice versa.
- An MV that went stale then was `refresh`ed (cleared) in the same session — the
  durable set must reflect the clear, or it wrongly refills a healthy backing.
- Crash mid-DDL-commit that was writing both the source change and the stale-set
  entry — atomic batch must make these all-or-nothing together.
- A memory-backed MV (no durable backing) appearing in the stale-set — harmless
  (always refills), parity with the existing `closeAll` note.
