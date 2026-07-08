description: The engine's lock queue was a single process-wide table so two independent databases sharing a key string fought over one lock; it is now scoped per-database with a backward-compatible global fallback, and this reviewed change confirms the scoping is correct.
files:
  - packages/quereus/src/util/latches.ts (Latches: static-only → instance-based + static delegation to a process-global default)
  - packages/quereus/src/core/database.ts (new `public readonly latches = new Latches()` field + import)
  - packages/quereus/src/vtab/memory/layer/manager.ts (14 call sites: `Latches.acquire` → `this.db.latches.acquire`; import removed)
  - packages/quereus/test/util/latches.spec.ts (new `instance scoping` describe block, 2 tests)
  - .gitignore (added `*.log` — review fix)
----

## What landed

`util/latches.ts` held its lock queues in a process-global `static Map`, shared
across **all** `Database` instances. Two independent databases passing the same
key contended on one latch. The change scopes the registry per-database:

- `Latches` is now instance-based — `lockQueues` is a `private readonly` instance
  field and `acquire()` is an instance method; timeout/deadlock-guard body
  unchanged.
- A `private static readonly global = new Latches()` backs a kept static
  `Latches.acquire` delegate, preserving the old shared-queue entry point for
  external (published-package) callers holding no `Database`. Static + instance
  method of the same name coexist.
- `Database` owns one instance: `public readonly latches = new Latches()`.
- All 14 memory-manager call sites now use `this.db.latches.acquire(...)`; the
  `import { Latches }` was dropped from manager.ts. Lock-key strings unchanged.

## Review findings

Adversarial pass over the implement diff (commit `30556233`), read before the
handoff summary. Scrutinized correctness, isolation semantics, resource cleanup,
type safety, DRY, test coverage, docs.

- **Correctness / isolation — CONFIRMED correct.** Each `Database` gets its own
  `Latches` → its own `lockQueues` map; same key in two databases → two
  independent queues. Within one database, tail-chaining serialization is byte-
  identical to before (same map, same body). Directly unit-tested both ways.
- **Resource cleanup — no leak.** `release()` deletes the key from the map when
  no waiter queued behind it (`latches.ts:61`), so the per-database and the
  process-global maps stay bounded exactly as the prior static map did.
- **All 14 call sites converted — CONFIRMED.** `find_references Latches.acquire`
  across `packages/` returns only the static definition/delegate in `latches.ts`
  and the test file — zero live static call sites in `src/`. `this.db` is a valid
  manager field (used elsewhere for `this.db.options`, `getConnectionsForTable`).
- **Static `global` fallback has NO in-repo caller.** Grep of `Latches` in all
  packages outside `quereus/` = zero matches; only `index.ts:200` re-exports the
  class. The delegate is therefore dead weight *within the repo*, kept purely for
  external consumers of the published `Latches` export — a defensible API-stability
  choice, matching the ticket's explicit "do not silently break the export"
  requirement. Left as-is; not a defect.
- **Docs — checked, accurate.** The `latches.ts` class docstring and the new
  `database.ts` field comment both describe the instance/global split and match
  the code. The stale NOTE pointing at this ticket slug is gone. No `docs/` file
  or README references the latch registry, so nothing else needed updating.
- **Test coverage — adequate.** Instance-scoping (two instances don't contend),
  same-instance serialization, and the pre-existing timeout deadlock-guard paths
  are all covered (5 passing). The "no contend" test correctly fails via Mocha
  timeout if `b` were wrongly blocked.

### Finding fixed inline (minor)

- **Stray build cruft committed.** The implement commit tracked two binary log
  files at repo root — `test.log` (31 KB) and `teststore.log` — leftover `tee`
  output from the implementer's validation runs; root `.gitignore` did not cover
  them. Removed via `git rm`, and added `*.log` to `.gitignore` so agent
  validation logs can't be committed again. No source impact.

### Tripwire / deferred (not a ticket)

- **No end-to-end integration test through two live `Database` objects** hammering
  an identically-named table concurrently. The instance-level unit test is a
  faithful model (same key, two instances), so this is belt-and-suspenders, not a
  gap — deliberately not filed. Noted here only so a future reader knows the
  coverage boundary.

### Major findings

None. No new latch introduced, no lock-key string changed → ordering/deadlock
characteristics identical to HEAD; the change only relocates *where* the registry
lives.

## Validation

- `yarn workspace @quereus/quereus run build` → exit 0
- `yarn workspace @quereus/quereus run lint` → exit 0 (eslint + tsc on test files)
- `node packages/quereus/test-runner.mjs --grep "Latches"` → 5 passing, exit 0
- `yarn workspace @quereus/quereus run test` → 6481 passing, 9 pending, exit 0
