description: IsolationModule now forwards `getMappingAdvertisements` to its underlying module so isolation-wrapped basis tables still expose tag-derived `quereus.lens.decomp.*` decompositions to the lens compiler's advertisement resolver. Tests pin the forward.
files: packages/quereus-isolation/src/isolation-module.ts, packages/quereus-isolation/test/isolation-layer.spec.ts, packages/quereus/src/vtab/module.ts, packages/quereus/src/schema/lens-compiler.ts
----

## What changed

- `IsolationModule.getMappingAdvertisements(db, basisSchema)` forwards to
  `this.underlying.getMappingAdvertisements?.(db, basisSchema) ?? []`
  (`packages/quereus-isolation/src/isolation-module.ts:200`). Storage/access is a
  property of the underlying basis relations and is isolation-transparent, so a
  straight delegate is correct.
- Added a `capability forwarding` describe block to
  `packages/quereus-isolation/test/isolation-layer.spec.ts` (3 cases):
  - forwards `getMappingAdvertisements` and passes `db` + `basisSchema` through to the underlying (sentinel identity check);
  - returns `[]` (not `undefined`) when the underlying omits the hook;
  - forwards `getCapabilities` while still layering `isolation`/`savepoints` on top.

## Implementation note (important for reviewer)

The core forward method was **already present in the committed tree** before this
ticket ran — it was landed by an earlier `tess: triage pre-existing test failure`
commit (`06f803d9`), not by this implement pass. This ticket's net new contribution
is the **test coverage** (the forwarding was previously unpinned) plus the audit below.
Verify the method is the correct single-line delegate and the comment is accurate.

## Validation

- `yarn workspace @quereus/isolation run typecheck` — clean.
- `yarn workspace @quereus/isolation run test` — 71 passing (was 70 + the 3 new
  cases; net 71 since one of the original ideas — "MemoryTableModule advertises
  nothing" — was wrong: MemoryTableModule *does* implement the hook via
  `buildAdvertisementsFromTags`, so the empty-list case uses a stub underlying with
  the hook explicitly unset).

## Test gaps / things to scrutinize

- **No end-to-end test.** The tests assert the wrapper delegates, but there is no
  SQL-level test that a `quereus.lens.decomp.*`-tagged table wrapped by isolation
  actually decomposes through the lens compiler. That consumer
  (`lens-multi-source-decomposition`) does not exist yet, so an e2e test cannot be
  written today. When it lands, add an isolation-wrapped decomposition case there.
- **Audit of other optional hooks (scope decision).** Optional `VirtualTableModule`
  hooks NOT forwarded by `IsolationModule`: `supports`, `shadowName`,
  `beginSchemaBatch`/`endSchemaBatch`, and the `concurrencyMode`/`expectedLatencyMs`
  properties. None are lens/decomposition-related, so they are out of scope for this
  ticket and left as-is. `beginSchemaBatch`/`endSchemaBatch` not being forwarded
  means APPLY SCHEMA loses single-commit batching under isolation — a real but
  separate concern; if the reviewer agrees it matters, file a fresh ticket rather
  than folding it in here. The lens-relevant hook (`getMappingAdvertisements`) is the
  only one this ticket needed and it is now forwarded + tested.
