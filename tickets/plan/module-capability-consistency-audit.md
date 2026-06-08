description: Survey the `VirtualTableModule` contract for points where the engine assumes a uniform behavior that modules implement inconsistently — or cannot satisfy — and recommend a single consistent capability-negotiation pattern. Prompted by the PK-collation case: the `setCollation` contract mandates a physical re-key the store can't do, and capability signaling today is an ad-hoc mix of "presence = capability", `getCapabilities()` flags, and `concurrencyMode`.
files: packages/quereus/src/vtab/module.ts, packages/quereus/src/vtab/capabilities.ts, packages/quereus-store/src/common/store-module.ts, packages/quereus/src/vtab/memory/module.ts, packages/quereus-isolation/src/isolation-module.ts, docs/module-authoring.md, docs/architecture.md
----

## Why

The PK-collation divergence (the store can't honor the `setCollation` re-key the contract
mandates — `module.ts:412-415`) is likely **one of several** places where the engine assumes a
behavior not every module provides. Capability signaling is currently inconsistent:

- some capabilities are signaled by **method presence** (`alterTable`, `renameTable`,
  `getMappingAdvertisements`, `shadowName`, `getBestAccessPlan`),
- some by **`getCapabilities()` flags** (`ModuleCapabilities`),
- and concurrency by a dedicated **`concurrencyMode`** field.

The result is that an out-of-contract module either **silently diverges** (the collation case)
or **fails at runtime** rather than at a negotiated boundary. This ticket inventories the surface
and recommends one consistent pattern.

## Scope (a survey + recommendation, not an implementation)

Inventory every `VirtualTableModule` contract point where the engine assumes a behavior, and for
each, classify the signaling and the unsupported-path handling:

- **ALTER column arms** (`module.ts:399-423`): `setNotNull`, `setDataType`, `setDefault`,
  `setCollation` — what mandate does each impose, and can the store / isolation modules satisfy
  it? (`setCollation` re-key is the known gap; check `setDataType` physical-conversion and
  `setNotNull` backfill on each module.)
- **`alterTable` / `renameTable`** presence-capabilities and their declared fallback ("if not
  implemented, the engine rejects / treats as schema-only").
- **`getBestAccessPlan` / `supports()`**, `getMappingAdvertisements`, `shadowName`.
- **`concurrencyMode`** — already a clean capability; is it the model to generalize toward?
- **Transaction / savepoint / FK / constraint enforcement** responsibilities split between
  engine and module — where is the split assumed rather than negotiated?

For each surface, record: which signaling style it uses, whether the unsupported path is a
**negotiated rejection**, an **engine-side fallback**, or a **silent divergence / runtime throw**,
and whether memory / store / isolation / (and the leveldb / indexeddb plugins) actually conform.

## Output

- A findings doc (or a `docs/module-authoring.md` update) tabulating the surfaces and their
  conformance / signaling / fallback classification.
- A recommendation for a **single consistent capability-negotiation surface** — extend
  `ModuleCapabilities`? a per-feature `supports()`-style echo? presence + a declared fallback
  policy? — that the engine consults before invoking a contract method, so the unsupported case
  is always a clean rejection or a defined fallback, never a silent divergence.
- One or more follow-up tickets for the genuine gaps the survey turns up. The concrete
  `store-pk-collate-module-capability` ticket is the first instance and should adopt whatever
  pattern this recommends.

## Notes

- **Cross-platform:** capabilities differ by module/platform (memory vs. LevelDB vs. IndexedDB
  vs. the isolation snapshot layer vs. React-Native LevelDB), so the negotiation must be
  declarative and queryable, not hard-coded per call site.
- Don't boil the ocean in the implementation that follows — the value here is the **inventory +
  one agreed pattern**; migrating each surface to it can be incremental follow-up tickets.
