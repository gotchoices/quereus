description: IsolationModule forwards `getMappingAdvertisements` to its underlying module so isolation-wrapped basis tables still expose tag-derived `quereus.lens.decomp.*` decompositions to the lens compiler's advertisement resolver. Forward verified correct + on the consulted path; test coverage pinned; one separate-concern gap (schema-batch hook forwarding) filed to backlog.
files: packages/quereus-isolation/src/isolation-module.ts, packages/quereus-isolation/test/isolation-layer.spec.ts, packages/quereus/src/vtab/module.ts, packages/quereus/src/schema/lens-compiler.ts, packages/quereus/src/schema/manager.ts
----

## What shipped

- `IsolationModule.getMappingAdvertisements(db, basisSchema)` forwards to
  `this.underlying.getMappingAdvertisements?.(db, basisSchema) ?? []`
  (`packages/quereus-isolation/src/isolation-module.ts:200`). The forward method
  itself was landed earlier by the triage commit `06f803d9`; this ticket's net new
  contribution is the **test coverage** that pins it plus the audit below.
- A `capability forwarding` describe block in
  `packages/quereus-isolation/test/isolation-layer.spec.ts` (3 cases): arg-passthrough
  + return identity, `?? []` empty-list fallback, and `getCapabilities` layering.

## Review findings

**Implementation correctness — CHECKED, correct.**
- Read the implement diff (`890c721b`) with fresh eyes before the handoff. The diff
  touches only the test file + ticket move; the one-line forward came from `06f803d9`,
  as the handoff honestly disclosed. Verified `git show 06f803d9` — the forward is the
  correct single-line delegate and its doc comment is accurate.
- **Verified the forward is on the consulted path** (the crux the implementer asserted
  but did not prove). `collectAdvertisements` (`schema/lens-compiler.ts`) reaches each
  basis table's `vtabModule` and calls `getMappingAdvertisements?.(db, basis)`. Confirmed
  `TableSchema.vtabModule` is set to the **registered** module — `vtabModule:
  moduleInfo.module` in `schema/manager.ts` (`buildTableSchema` ~1087 and
  `finalizeCreatedTableSchema` ~1343). So a table created `USING isolated` carries the
  `IsolationModule` as `vtabModule`, the resolver hits the wrapper, and the forward is
  both necessary and correct. Signature `(db: Database, basisSchema: Schema): readonly
  MappingAdvertisement[]` matches the consumer and the interface in `vtab/module.ts`.

**Tests — CHECKED, adequate; pass.**
- `yarn workspace @quereus/isolation run typecheck` — clean.
- `yarn workspace @quereus/isolation run test` — 71 passing.
- Confirmed the new block inherits a real `Database` from the top-level `beforeEach`
  (`db = new Database()`, line 10), so the tests are sound rather than passing by accident.
- Minor observation (no change made): the stubs use `{ ...new MemoryTableModule(), ... }`,
  whose spread drops prototype methods, so the cases exercise the delegate against plain
  stubs rather than a genuine `MemoryTableModule` prototype. The `getMappingAdvertisements:
  undefined` in the fallback case is therefore belt-and-suspenders (the spread already drops
  it). Given the delegate is a trivial one-liner and all three behavioral facets (arg
  passthrough, return identity, `?? []` fallback, capability layering) are covered, a
  real-instance test would only duplicate the empty-list outcome — left as-is, not worth the
  redundancy.

**Docs — CHECKED, no update needed.**
- `docs/lens.md` describes the advertisement protocol generically ("a generic module
  (memory/store) delegates to the shared tag builder"); isolation wrapper-transparency is an
  implementation detail fully captured by the in-code doc comment on the forward. No
  isolation-specific doc claims this behavior, so nothing is stale.

**Other wrappers — CHECKED, none missing the forward.**
- `IsolationModule` is the only module that holds an `underlying: VirtualTableModule` and
  delegates (grep for `readonly underlying`/`config.underlying`/`underlying.getCapabilities`
  hits only `packages/quereus-isolation/`). No other wrapper needs the same forward.

**Optional-hook audit — one separate concern filed to backlog (MAJOR), rest in scope.**
- `beginSchemaBatch`/`endSchemaBatch` are NOT forwarded. APPLY SCHEMA's migration loop fires
  these on the registered module (the wrapper), so a batching-capable underlying loses
  single-commit batching under isolation. Confirmed via literal scan that **no production
  module (memory/store/sync) implements these hooks today**, so there is zero current impact —
  it is the same future-facing silent-degradation class as this very ticket. Filed
  `tickets/backlog/isolation-module-schema-batch-hook-forwarding.md` (it touches the
  write/commit + overlay-flush path, so it is NOT a guaranteed straight delegate — flagged the
  open question for that ticket). Not folded in here: out of scope for a lens-advertisement
  ticket.
- `supports` (push-down), `shadowName`, `concurrencyMode`/`expectedLatencyMs`: left
  un-forwarded and judged correct/intentional — isolation must see rows through its overlay
  (so blind push-down forwarding would be wrong) and imposes its own concurrency semantics. The
  backlog ticket carries a note to formally document the per-hook verdict when it lands.

**End-to-end gap — legitimately deferred (noted by implementer).**
- No SQL-level test that a `quereus.lens.decomp.*`-tagged table wrapped by isolation actually
  decomposes through the lens compiler. The consumer (`lens-multi-source-decomposition`)
  doesn't exist yet, so an e2e test cannot be written today. When it lands, add an
  isolation-wrapped decomposition case there.

## Validation

- `yarn workspace @quereus/isolation run typecheck` — clean.
- `yarn workspace @quereus/isolation run test` — 71 passing.
- No lint script for `@quereus/isolation` (only `packages/quereus` has one; this ticket's
  production change is in the isolation package).
