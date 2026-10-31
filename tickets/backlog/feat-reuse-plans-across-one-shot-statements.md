description: Running the same query text repeatedly through the convenience calls (`db.get`, `db.eval`, `db.exec`) re-plans it from scratch every time, and planning a simple lookup takes several times longer than executing it — a cache of compiled plans keyed by query text would remove that cost.
files: packages/quereus/src/core/database.ts, packages/quereus/src/core/statement.ts, packages/quereus/src/core/internal-statement-cache.ts, packages/quereus/src/core/database-cardinality-feedback.ts, docs/usage.md, docs/progressive-optimizer.md
tradeoffs: Hosts that care can already prepare a statement once and reuse it, and a shared plan cache adds lifecycle questions (schema invalidation, busy statements, parameter types, feedback re-plans, memory) to every convenience call, for a saving that only matters when the same text runs in a tight loop.
----

# Reuse compiled plans across one-shot calls

## The cost, measured

On one machine (AMD Ryzen AI 9 HX 370, Node 24.2, built `dist` at `c69c38315`), timing parse, build and optimize separately for a handful of shapes over small memory tables:

| statement | parse | build | optimize | warm execute |
|---|---|---|---|---|
| `select val from a where id = ?` | 9 µs | 69 µs | ~0.9 ms | 0.22 ms |
| two-table join with a filter | 16 µs | 218 µs | ~2.2 ms | 5.8 ms |
| four-table join | 20 µs | 132 µs | ~9.3 ms | 12 ms |

A prepared `Statement` pays this once and reuses its plan. `db.get`, `db.eval` and `db.exec` prepare (or build and optimize) afresh on every call, so a host calling `db.get('select … where id = ?', [k])` in a loop spends most of each call planning. Per-pass timing of the point query puts most of the optimizer's time in constant folding (~0.3 ms) and structural rewrites (~0.45 ms), which every plan needs — so a cheaper optimization "tier" does not remove it (see `docs/progressive-optimizer.md` § Rejected alternatives); only not planning again does.

The engine already has the pattern for internal callers: `InternalStatementCache` (`core/internal-statement-cache.ts`) keeps a per-`Database` LRU of compiled statements keyed by exact SQL text for the FK/DDL enforcement probes, falls back to a one-shot statement when the cached one is mid-iteration, and relies on `Statement`'s own schema-change invalidation.

## What the original adaptive-optimizer design worked out (carried forward)

**What to key on.** Three candidates were weighed: (A) the parsed AST with literals and parameter values normalized — cheap, since parsing already happens, and catches the dominant case of one text run with different parameter values; (B) the built logical plan — shares more (view expansion, aliasing) but pays the whole build before any cache benefit, and attribute ids would need positional normalization; (C) SQL text with lexer-level literal normalization — cheapest, but brittle and effectively a second partial parser. A was judged the sweet spot; exact SQL text (as `InternalStatementCache` uses) is the simplest version of it and already covers parameterized statements, whose literals are `?`.

**What the cache holds.** Holding only metadata leaves each statement compiling for itself; holding compiled plans shares work but raises lifecycle questions — who owns a plan, schema objects and module instances captured at emit time, per-statement invalidation, and two callers wanting the same entry at once. Holding the post-structural plan and finishing per caller is unsound, because cost-based decisions are made in the Structural pass too.

## What a design must settle

- Key: SQL text plus the established parameter types (a statement's plan is typed by its first binding) plus the schema path in force.
- Invalidation: schema changes (already per-statement), cardinality-feedback shifts (`cardinality-feedback-replan` marks live statements — a cached idle statement must be among them), and options baked in at emit time (`trace_plan_stack`, `runtime_fuse_scalars`).
- Concurrency: an entry mid-iteration must not be handed out (the busy fallback); `readConcurrency: 'committed'` reads hold no mutex.
- Bounds: LRU capacity, and whether `db.exec` batches participate.

## Related

`feat-reusable-statement-across-concurrent-reads` (one statement serving overlapping executions) is the other half of making a compiled plan reusable.
