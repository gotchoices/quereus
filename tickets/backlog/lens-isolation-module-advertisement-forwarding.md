description: IsolationModule does not forward `getMappingAdvertisements` to its underlying module, so when a memory/store basis table is wrapped by isolation, the lens compiler's advertisement resolver silently sees no decompositions (tag-derived `quereus.lens.decomp.*` advertisements are dropped). Harmless today (the synthesis consumer doesn't exist yet and an absent advertisement just falls back to the name-match path), but it will silently disable multi-source decomposition under isolation once `lens-multi-source-decomposition` lands.
prereq:
files: packages/quereus-isolation/src/isolation-module.ts, packages/quereus/src/schema/lens-compiler.ts, packages/quereus/src/vtab/module.ts
----

## Problem

`MappingAdvertisement` resolution (`collectAdvertisements` in `src/schema/lens-compiler.ts`) reaches each basis table's `vtabModule` and calls the optional `getMappingAdvertisements?.(db, basisSchema)` hook. Presence of the method is the capability.

`IsolationModule` (`packages/quereus-isolation/src/isolation-module.ts`) is a wrapper that holds an `underlying: VirtualTableModule` and explicitly delegates the methods it cares about. It does **not** implement `getMappingAdvertisements`. So when a memory/store table is wrapped by isolation, the basis table's `vtabModule` is the `IsolationModule` instance, `module.getMappingAdvertisements` is `undefined`, and `?? []` makes the resolver behave as if the module advertised nothing.

The consequence: `quereus.lens.decomp.*` tags on isolation-wrapped basis tables are silently ignored. Today this only means the lens stays on the name-match path (no functional break, since synthesis is deferred). Once `lens-multi-source-decomposition` consumes `slot.advertisement`, a logical table over an isolation-wrapped decomposition would silently fail to decompose — or fail body compilation with "no basis backing" — with no diagnostic pointing at isolation.

## Expected behavior

`IsolationModule.getMappingAdvertisements(db, basisSchema)` should forward to `this.underlying.getMappingAdvertisements?.(db, basisSchema) ?? []`. Storage/access is a property of the underlying basis relations and is isolation-transparent (the overlay does not change the decomposition shape), so a straight delegate is correct.

Audit the same wrapper for any other optional `VirtualTableModule` hooks that decomposition/lens will come to depend on (it already forwards `getCapabilities`); a missing-forward of an optional capability method is a silent-degradation footgun, so consider a test that asserts the wrapper forwards each optional capability hook it should.

## Notes

- Discovered during review of `lens-module-mapping-advertisement`. The implementer flagged it as an out-of-scope seam.
- This is future-facing: file it as backlog rather than fix, because it has no observable effect until the synthesis consumer lands and someone actually wraps a decomposition basis in isolation. When that combination is wired, this becomes a prereq for it.
