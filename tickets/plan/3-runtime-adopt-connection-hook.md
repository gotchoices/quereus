----
description: The general-purpose runtime has special-case code that only works for the built-in in-memory table type, so third-party storage plugins cannot receive the same connection setup — the runtime should offer a neutral hook any table type can opt into instead.
files: packages/quereus/src/runtime/utils.ts
difficulty: medium
----
`getVTable` in the module-agnostic runtime (`runtime/utils.ts` approx lines 141-153) special-cases `vtabModuleName === 'memory'` and imports memory-vtab classes directly to inject a connection into the table instance. This bakes one specific module's internals into generic runtime code: third-party virtual-table modules that would benefit from the same connection injection cannot get it, and the runtime carries a hard dependency on the memory module.

Expected behavior: connection injection should be a capability a virtual-table module opts into through a documented, module-neutral interface — not a name check. Introduce an optional `adoptConnection()` hook on the `VirtualTable` (or the module/connection) interface; the runtime calls it when present and does nothing when absent, with no knowledge of any concrete module. The memory vtab implements the hook and the special-case branch (and its direct import) is removed.

This is a design ticket. Resolve: the exact interface surface (what `adoptConnection` receives and returns, whether it lives on `VirtualTable`, the module, or the connection object), how it interacts with the per-inner-row connect/disconnect concerns raised in the prepared-statement-overhead ticket, and lifetime/ownership of an adopted connection (who closes it). Then emit an implement ticket that adds the hook, moves memory-vtab onto it, and deletes the name check. Update the vtab framework docs (`docs/` and the memory-vtab module) to describe the new hook.
