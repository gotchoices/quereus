description: Add createBacking? seam to VirtualTableModule; createBackingTable prefers it over create (+ IsolationModule forward)
files:
  - packages/quereus/src/vtab/module.ts — optional createBacking?() on VirtualTableModule interface
  - packages/quereus/src/schema/manager.ts — createBackingTable prefers createBacking over create; docstring updated
  - packages/quereus/test/vtab/create-backing-seam.spec.ts — seam regression tests
  - packages/quereus-isolation/src/isolation-module.ts — forwards createBacking to underlying (presence-mirrored, like getBackingHost)
  - packages/quereus-isolation/test/isolation-layer.spec.ts — createBacking forwarding tests
----

## Summary

Adds an optional `createBacking?(db, tableSchema): Promise<TTable>` hook to the
`VirtualTableModule` interface. `SchemaManager.createBackingTable` (the
materialized-view backing path) now prefers it over `create`
(`createBacking?.() ?? create()`), so a durable-backing module (Lamina) can
route the MV backing into its durable store. Modules that omit it fall through
to `create` — today's behavior is preserved.

This unblocks Lamina's already-shipped `LaminaModule.createBacking`, lets the
`it.skip` round-trip in lamina's `mv-backing-installer-enablement-e2e` test be
un-skipped, and clears lamina's `lamina-mv-backing-general-body-golden` ticket.

## Review findings

### Scrutinized

- **Implement diff** (commit `6c347083`): the three quereus-side changes —
  interface hook, `createBackingTable` preference, two seam tests.
- **The seam wiring** — `createBacking?.bind ?? create.bind` correctly preserves
  `this` and presence-as-capability semantics; type-safe (no `any`).
- **The deployment shape** — durable-backing modules are wrapped by
  `IsolationModule` (the reason its `getBackingHost` forward exists), so the seam
  had to be checked through the wrapper, not just direct registration.
- **Error-message rename** ("create failed" → "backing create failed").
- **Rollback/cleanup** — MV-fill failure → `dropTable` → module `destroy`.
- **Docs** — the `createBackingTable` docstring and the new interface docstring.
- **lint** (`@quereus/quereus`), **build**, **quereus test suite**, **isolation
  test suite**, **isolation typecheck**.

### Found & fixed in this pass (minor)

- **MAJOR-shaped gap, fixed inline because it is the direct completion of this
  seam: `IsolationModule` did not forward `createBacking`.**
  `IsolationModule` is a transparent wrapper that presence-mirrors optional
  capability hooks to the underlying module; its `getBackingHost` is forwarded
  precisely so an isolation-wrapped durable module owns the MV backing host. The
  implement diff added `createBacking` to the interface and the engine seam but
  **not** the wrapper forward. Consequence under isolation (the real Lamina
  deployment): `createBackingTable` calls `wrapper.createBacking?.()` → undefined
  → falls back to `wrapper.create()` → `underlying.create()` (an ordinary table),
  while the *forwarded* `getBackingHost` then looks for a durable host that was
  never created — so MV creation under isolation would silently bypass durable
  routing (and likely fail host resolution). The interface docstring's own stated
  purpose ("so the subsequent getBackingHost resolves a real host") would not
  hold under isolation. The existing `capability forwarding` test block even
  warns: "These tests pin the forwards so a future hook is not forgotten" — this
  hook was forgotten.
  - **Fix:** `isolation-module.ts` now assigns `createBacking` in the constructor
    iff the underlying declares it (presence mirrors, exactly like
    `getBackingHost`); the body mirrors `create` (wrap in `IsolatedTable`, record
    underlying state) but builds the underlying via `underlying.createBacking`.
    `destroy` already removes underlying state for both paths, so rollback cleanup
    is unchanged.
  - **Tests added** (`isolation-layer.spec.ts`, `capability forwarding` block):
    presence-mirroring (defined iff underlying declares it) + an end-to-end
    `create materialized view ... using isolated` that asserts `createBacking` is
    preferred over `create` through the wrapper and the fill completes (proving
    the forwarded `getBackingHost` resolves a real host).

- **Stale docstring (minor):** `createBackingTable`'s JSDoc still described the
  path as "`module.create` → finalize → addTable". Updated to reflect
  `createBacking?() ?? create()`.

### Checked, no action

- **Error-message rename:** no source or test fixture matches the old string
  `"create failed for backing table"` — only stale `dist/` build artifacts
  (`quereus-vscode/server/dist`, `quoomb-web/dist`) reference it, and those
  regenerate on build. No breakage.
- **Docs:** no doc file enumerates the module's optional capability hooks
  (`getBackingHost`/`createBacking`/etc.); the interface JSDoc is the
  authoritative description, and it is accurate. Nothing to update.
- **Type safety:** no `any` introduced in production code; the isolation forward
  is typed `(db, tableSchema) => Promise<IsolatedTable>`. Test stubs use `any`
  consistently with the surrounding forwarding tests.
- **Other wrapper modules:** `IsolationModule` is the only in-repo module that
  delegates `create` to an underlying; no other wrapper needs the forward.

### Lamina integration (out of scope, downstream)

No Lamina test lives in this repo (sibling repo). The quereus + isolation tests
prove the seam and its forward; end-to-end durable routing is covered by lamina's
own (now un-blockable) tests.

## Validation

- `yarn workspace @quereus/quereus run lint` — pass (eslint + test typecheck)
- `yarn workspace @quereus/quereus run build` — pass
- `yarn workspace @quereus/quereus run test` — 6330 passing, 9 pending, 0 failing
- `yarn workspace @quereus/isolation run test` — 128 passing, 0 failing
- `yarn workspace @quereus/isolation run typecheck` — pass
