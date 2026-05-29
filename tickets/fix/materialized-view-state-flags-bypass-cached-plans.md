description: A materialized view's build-time `stale` read-state guard is bypassed by already-cached prepared-statement plans — a query planned before the source schema changed keeps reading the backing table and returns stale rows with no error/re-validation, defeating the "no silent stale reads" guarantee.
prereq: materialized-view-rowtime-only-consolidation
files: packages/quereus/src/planner/building/select.ts, packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/core/statement.ts, packages/quereus/src/runtime/emit/materialized-view.ts, packages/quereus/src/schema/view.ts, packages/quereus/src/schema/schema.ts
----

> **Scope note (post row-time-only consolidation).** This ticket originally
> covered **both** `diverged` and `stale`. The `diverged` flag and the entire
> post-commit divergence subsystem are removed by
> `materialized-view-rowtime-only-consolidation` (row-time maintenance is
> transactional — it cannot drift, so there is nothing to diverge). What remains
> is the `stale` half of the same cached-plan bypass, described below.

## Problem

The materialized-view `stale` read-state guard lives in `select.ts` `buildFrom`
(`mvSchema.stale` → body re-validation), i.e. it fires at **plan-build time**. A
`Statement` caches its optimized plan and only recompiles when a schema-change
*event* invalidates one of its tracked dependencies (see `statement.ts` —
`schemaChangeUnsubscriber`, `needsCompile`).

`stale` is set by the schema-change subscription when a *source* table is
dropped/altered. But a cached `select <cols> from mv` statement depends on the
**backing** table, not the source, so the source's `table_modified` /
`table_removed` event does not invalidate it. The cached plan keeps reading the
backing table directly and returns rows against a definition whose source has
structurally changed — with no `stale` re-validation.

### Reproduction shape

```ts
const stmt = await db.prepare('select id, x from mv order by id');
for await (const r of stmt.iterateRows()) { /* plan cached here */ }

await db.exec('alter table t add column z integer;');   // -> mv.stale === true

await stmt.reset();
for await (const r of stmt.iterateRows()) { /* bypasses the stale re-validation */ }
// A *fresh* db.eval('select ... from mv') re-validates correctly.
```

## Expected behavior

A read against an MV whose `stale` flag is set must observe that state regardless
of whether the reading statement's plan was cached before the flag flipped. No
code path should silently serve stale backing rows; the cached plan must
re-resolve (recompile → re-hit the build-time `stale` re-validation) when the flag
toggles.

## Notes for the implementer (design space, not a plan)

- The flag is runtime-only and currently toggles without notifying the
  statement-cache invalidation machinery. Candidate directions:
  - Emit a schema-change / invalidation signal for the MV (and/or its backing
    table) when `stale` toggles, so dependent cached plans recompile and re-hit
    the build-time guard.
  - Or move the guard from plan-build time to emit/runtime (check the live flag
    when the backing-table scan actually runs), so it is immune to plan caching.
- Regression test: prepare a statement, flip `stale` via a source schema change,
  then re-execute the *same* prepared statement and assert it re-validates
  (errors if the body no longer plans, serves correct rows otherwise) rather than
  serving the cached backing read.

## Related

- `materialized-view-rowtime-only-consolidation` (prereq) — removes `diverged`;
  leaves `stale` as the sole MV read-state flag this fix must cover.
