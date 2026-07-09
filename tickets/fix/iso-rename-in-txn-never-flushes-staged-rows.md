---
description: Renaming a table in the middle of a transaction makes the transaction's writes vanish — the commit reports success, but the rows were never saved, and later reads on the same connection keep showing them as if they had been.
prereq:
files: packages/quereus-isolation/src/isolation-module.ts, packages/quereus-isolation/test/isolation-layer.spec.ts, docs/design-isolation-layer.md
difficulty: medium
---

# Rename inside a transaction silently discards the transaction's writes

## Reproduction

Confirmed against `packages/quereus-isolation` at commit `d6174923`, using the plain
in-memory storage module as the thing being wrapped:

```ts
const db = new Database();
const mod = new IsolationModule({ underlying: new MemoryTableModule() });
db.registerModule('isolated', mod);

await db.exec(`create table t (id integer primary key, v text) using isolated`);
await db.exec('begin');
await db.exec(`insert into t values (1, 'a')`);
await db.exec(`alter table t rename to t2`);
await db.exec('commit');          // reports success

db.eval('select id, v from t2')            // → [{id: 1, v: 'a'}]   (looks fine)
db.eval('select id, v from committed.t2')  // → []                  (nothing was stored)
```

`committed.<table>` is the engine's read-through-to-storage syntax; it bypasses the
isolation layer's staging area. It comes back empty: the row never reached storage.

Three things go wrong at once, and they compound:

1. **The write is lost.** Nothing was written to storage, ever.
2. **The commit lies.** `commit` returns success rather than raising an error.
3. **The loss is masked.** Every later read on that same connection still shows the row,
   because the abandoned staging area is never cleaned up and keeps getting merged into
   reads. The data only visibly disappears once the process restarts or another connection
   looks — i.e. long after anyone could connect it to the rename.

Dropping a table mid-transaction (`begin; insert; drop table; commit`) reaches the same
code path. The lost write is arguably fine there — the table is gone — but the abandoned
staging area still leaks for the lifetime of the module.

## Mechanism

The isolation layer holds two maps, and the commit flush has to cross between them:

| map | keyed by |
|---|---|
| `underlyingTables` | `"<schema>.<table>"` |
| `connectionOverlays` | `"<connectionId>:<schema>.<table>"` — one staging area per connection per table |

`IsolationModule.renameTable()` (`isolation-module.ts` ~line 981) does two things:

- `removeUnderlyingState(schemaName, oldName)` — drops the storage handle for the old name,
  deliberately, because some storage modules close and reopen their files across a rename and
  the cached handle would be stale. It does **not** register a handle under the new name; the
  next `connect()` is expected to fetch a fresh one.
- `rekeyConnectionScopedMap(...)` — moves the staging area from `<id>:main.t` to `<id>:main.t2`,
  so writes staged before the rename stay visible after it.

If the transaction commits before anything reconnects under the new name — which is exactly
what `begin; …; alter table … rename to …; commit` does — then at commit time the staging area
exists under `main.t2` and `underlyingTables` has an entry for neither `main.t` nor `main.t2`.

`commitConnectionOverlays` (~line 418) walks the staging areas, strips the connection-id prefix,
looks the rest up in `underlyingTables`, misses, and hits:

```ts
if (!underlyingState) continue; // no underlying to flush (defensive)
```

The `continue` skips both the flush **and** the cleanup — the staging area is left in the map,
which is where the masking in (3) comes from.

That `continue` is the same line that made
`tickets/complete/1-iso-overlay-key-from-connect-args.md` a data-loss bug. That ticket removed
the isolation layer's *own* way of reaching it (a table whose identity disagreed between the two
maps). It deliberately left the `continue` in place, noting the mechanism still existed. This
ticket is the remaining live path to it.

## Expected behavior

A committed transaction's writes must be in storage when `commit` returns, or `commit` must fail
loudly. Concretely:

- `begin; insert; alter table t rename to t2; commit` leaves the inserted rows readable through
  `committed.t2`, from a fresh connection, and after a restart.
- Whatever the resolution, no staging area outlives the transaction that created it. A leaked one
  keeps masking the loss on subsequent reads, which is what makes this so hard to spot.
- `begin; insert; drop table t; commit` need not preserve the rows, but must not leak the staging
  area either.
- The `continue` at ~line 434 should end up unreachable, or reachable only in a case that is
  genuinely a no-op. Once it is, it wants to be a hard internal error rather than a silent skip:
  silently discarding staged rows is precisely the failure mode this whole class of bug keeps
  reproducing. Any change that makes it throw must first be sure every legitimate caller is
  covered, or a working commit turns into a spurious failure.

Rollback after a mid-transaction rename must still discard, as it does today.

## Notes for whoever picks this up

The two obvious shapes are: re-register the storage handle under the new name during
`renameTable` (which reintroduces the stale-handle problem the removal was there to avoid), or
teach the commit flush to resolve a storage handle on demand when the map has no entry. The
second keeps the "fetch a fresh handle lazily" property the current code is reaching for. Neither
is obviously right — this is worth thinking through before writing code.

Regression coverage belongs in `packages/quereus-isolation/test/isolation-layer.spec.ts`, and must
assert through `committed.<table>` or through the storage module directly. Asserting through a
plain `select` on the writing connection passes even with the bug present — that is exactly the
masking described above.
