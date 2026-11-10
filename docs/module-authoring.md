# Virtual Table Module Authoring Guide

> **Stability: Stable** — see [Stability Tiers](stability.md#tiers).

This guide provides documentation for implementing virtual table modules in Quereus. It covers the architecture, optimization integration, and best practices for module authors.

## Topic documents

This document is the **hub**: the retrieve boundary, the capability APIs in outline, the transaction hooks, schema-change handling, and the mutation surface. The subsystems large enough to read on their own live in the topic documents below.

<!-- NOTE: a section that moved into a satellite left a one-line stub behind under its original
     heading, so its old anchor still resolves here. `yarn docs:check` therefore cannot tell a
     link deliberately left on a stub from one that should have been retargeted and was not.
     When linking real content that lives in a satellite, link the satellite — not the stub. -->

| Document | Covers |
| --- | --- |
| [Module Capability Negotiation](module-capabilities.md) | The inventory of every negotiation surface on the `VirtualTableModule` contract: how each one is signaled, the engine's fallback when a module omits it, the DDL transactionality tiers, and the per-arm `alterTable` mandate. |
| [Committed-Snapshot Reads](module-committed-reads.md) | The `readCommittedSnapshot` declaration: the obligation it takes on, the implementation shapes that meet it, what a wrapper module owes a snapshot-safe underlying, and the conformance harness. |
| [Schema Changes (`SchemaChangeInfo`)](module-authoring-schema-changes.md) | Every `alterTable` arm and its per-arm mandate, the `ddl` emit-iff-set rule, the engine-side rebuild fallback when a module cannot honor an arm natively, and the optional `alterTags` hook. |
| [Module Transactions and Connections](module-authoring-transactions.md) | The obligations of DDL inside an open transaction, the `IssuerRowSources` bundle a wrapper passes down, connection registration, eviction, reuse, and adoption, and the lifecycle the engine promises a registered connection. |
| [Module Statistics](module-authoring-statistics.md) | What `getStatistics()` reports exactly, what `ANALYZE` scans for the rest, and persisting a statistics snapshot across a reopen. |

## Overview

Virtual table modules are the primary extension point for custom data sources in Quereus. A module implements the `VirtualTableModule` interface and provides instances of `VirtualTable` that handle data access, updates, and query optimization.

### Key Concepts

- **Module**: Factory that creates table instances; implements `create()`, `connect()`, and optimization methods
- **Table Instance**: Represents a specific table; implements `query()`, `update()`, and transaction support
- **Optimization Integration**: Modules communicate capabilities to the optimizer via `BestAccessPlan` API or `supports()` method
- **Retrieve Boundary**: The optimizer wraps all table references in `RetrieveNode`, marking where data transitions from module execution to Quereus execution

## Architecture: Retrieve-Based Push-down

### The Retrieve Node Boundary

Every table reference is automatically wrapped in a `RetrieveNode` at build time:

```
RetrieveNode (optimizer boundary)
  └─ pipeline: RelationalPlanNode (module-supported operations)
      └─ TableReferenceNode (leaf table reference)
```

**Key principle**: Operations inside the `RetrieveNode` pipeline are executed by the module; operations above are executed by Quereus.

### How Push-down Works

1. **Predicate Normalization**: The optimizer normalizes filter predicates and extracts constraints
2. **Supported-only Placement**: Only predicates the module can handle are pushed into the `Retrieve` pipeline
3. **Residual Predicates**: Unsupported predicates remain above the `Retrieve` boundary
4. **Binding Capture**: Parameters and correlated column references are captured in `Retrieve.bindings`

Example:
```sql
select * from users where id = 1 and name like 'A%' and age > 30;
```

If the module supports equality on `id` but not LIKE or range comparisons:
```
Filter (name LIKE 'A%' AND age > 30)  ← Quereus executes
  └─ Retrieve
      └─ Filter (id = 1)              ← Module executes
          └─ TableReference
```

### Retrieve Node Structure

The `RetrieveNode` contains:
- **pipeline**: The operations the module will execute (initially just `TableReferenceNode`, but grows as predicates are pushed down)
- **bindings**: Parameters and correlated column references captured from pushed-down operations

At runtime:
1. Bindings are evaluated to produce concrete values
2. The module receives these values via `FilterInfo.args` (for index-based) or as part of the plan (for query-based)
3. The module executes the pipeline and returns rows
4. Quereus applies any residual operations above the `Retrieve` boundary

### Supported-only Placement Policy

The optimizer enforces a strict policy: **only operations the module can handle are placed inside the Retrieve boundary**. This is determined by:

1. **For query-based modules**: The `supports()` method returns a result
2. **For index-based modules**: The `getBestAccessPlan()` method marks filters as handled via `handledFilters` array

If a module claims to handle an operation but fails at runtime, data corruption can result. Always be conservative in capability reporting. See *Claiming `handledFilters`* below for the exact per-column, per-role rule the planner applies.

## Module Capability APIs

Modules communicate their capabilities through two complementary interfaces:

### 1. Query-Based Push-down (Advanced)

Implement `supports()` to analyze entire query pipelines:

```typescript
interface VirtualTableModule {
  supports?(node: PlanNode): SupportAssessment | undefined;
}

interface SupportAssessment {
  cost: number;           // Module's cost estimate
  ctx?: unknown;          // Opaque context for runtime
}
```

**When to use**: SQL federation, document databases, remote APIs that can execute complex queries.

**Important**: If `supports()` returns a result, the module **must** implement `executePlan()` to execute the pipeline. The optimizer will call `executePlan()` at runtime with the same plan node and context.

**Example**: A PostgreSQL federation module analyzing a Filter+Project+Sort pipeline:
```typescript
supports(node: PlanNode): SupportAssessment | undefined {
  if (node instanceof FilterNode) {
    // Check if predicate is SQL-compatible
    if (this.canTranslatePredicate(node.predicate)) {
      return { cost: 10, ctx: { sql: this.generateSQL(node) } };
    }
  }
  return undefined; // Can't handle this pipeline
}

// At runtime, executePlan() receives the same node and ctx
async* executePlan(db: Database, node: PlanNode, ctx?: unknown): AsyncIterable<Row> {
  const sql = (ctx as any)?.sql;
  // Execute the SQL against the remote database
  const results = await this.executeRemoteSQL(sql);
  for (const row of results) {
    yield row;
  }
}
```

### 2. Index-Based Access (Standard)

> **Invariant:** [OPT-060](invariants.md#opt-060--an-ordering-claim-over-a-descending-key-column-excludes-nulls)

Implement `getBestAccessPlan()` to expose index capabilities:

```typescript
interface VirtualTableModule {
  getBestAccessPlan?(
    db: Database,
    tableInfo: TableSchema,
    request: BestAccessPlanRequest
  ): BestAccessPlanResult;
}

interface BestAccessPlanRequest {
  columns: readonly ColumnMeta[];
  filters: readonly PredicateConstraint[];
  requiredOrdering?: OrderingSpec;
  limit?: number | null;   // present ONLY when stopping early is provably safe — see below
  offset?: number | null;  // travels with `limit`; the bound is `limit + offset`
  estimatedRows?: number;
}

interface PredicateConstraint {
  columnIndex: number;
  op: ConstraintOp;
  value?: SqlValue;              // the plan-time value, when there is one
  usable: boolean;
  ranges?: RangeSpec[];          // OR_RANGE only
  runtimeSet?: RuntimeSetSpec;   // an IN whose members arrive at query time
  collation?: string;            // normalized collation the comparison runs under; absent = BINARY
}
```

**`collation` names the collation the comparison runs under** — `'NOCASE'` for `b = 'x' collate nocase`, or for a plain `b = 'x'` on a column declared `collate nocase`. It is normalized, and absent means BINARY. Read it before offering an index for a filter; let `C` be the collation of the index column the filter would use:

- **An equality** (`=`, `IN`) seeks that column, and counts as pinning it to one value for an ordering claim, only when `collationRefines(constraint.collation ?? 'BINARY', C)` (exported from `@quereus/quereus`): the predicate is BINARY, or equal to `C`. A coarser one does neither. `b = 'x' collate nocase` over a BINARY `(b, c)` matches the `'X'` and `'x'` groups, so a seek would miss rows and `c` restarts in each group.
- **A range bound or `OR_RANGE`** is served by that column only when its collation equals `C`. For a non-BINARY `C`, your runtime must also filter the bounds under `C` and you must advertise `honorsCollatedRangeBounds`.
- **A prefix-range seek** (equalities on leading columns, then a range on the next) holds its prefix equalities to the range rule: each must equal its column's `C`, not merely refine it. The planner checks the whole prefix-range as range bounds, so a BINARY prefix over a NOCASE column gets the seek declined to a full scan. Offer the equality-only prefix seek instead and leave the range unhandled.
- **Only the first filter of each role on a column counts.** The planner seeks the first equality, the first lower bound and the first upper bound on every column you mark handled. If that first filter fails the test, claim nothing on that column for this index: not a later filter that passes, and not a range beside an equality that fails. Leave the filter unhandled and it becomes a residual.

`equalityServesKeyColumn(constraint, keyCol)` and `rangeServesKeyColumn(constraint, keyCol)` (exported from `@quereus/quereus`) are the first two tests ready-made, taking the index column's (or primary-key member's) `IndexColumnSchema`. Both bundled modules use them; the positional pick stays yours, since it depends on how you track roles.

The engine does not depend on your answer. It declines a mismatched seek to a scan plus a residual, and refuses an ordering claim the predicate's collation breaks (`orderingClaimSurvivesCollation`), so a module that ignores the field still returns the right rows. Reading it stops you offering plans the engine will discard: such a plan is costed as the seek you described, can win that comparison, and is then rebuilt as a scan.

**It is called more than once per statement, so keep it pure and cheap.** Planning probes the
same table several times with different requests and keeps only the answer it wants: the
retrieve-growth rule asks once for the plan it is considering, re-asks without `limit` when the
limit turns out not to be truncation-safe, and asks a third time with `filters`, `requiredOrdering`,
`limit` and `offset` all stripped to get the whole-table baseline it compares that plan against
(`baselineScanCost`, see [Optimizer costing § Where a module's own size fits](optimizer-costing.md)).
A discarded probe must leave nothing behind — no cursor opened, no cache mutated, no counter
advanced — and asking about a filter-free request must be as cheap as asking about a filtered one.
A module that cannot answer cheaply should memoize its own answer; the engine does not memoize for
you.

**`limit` is a licence, not a hint.** When it is present the engine has already proven
that nothing between your scan and the `LIMIT` can discard a row, so you may both price
against it and truncate to it. When it cannot prove that, the field is *absent* rather
than advisory — there is no "limit you should ignore". It arrives with `requiredOrdering`
for a LIMIT the user wrote above an `ORDER BY` when the LIMIT and OFFSET are both
constants (`order by date limit 20 offset 40` sends `limit: 20, offset: 40`), and for
the one-row boundary read the engine synthesizes for `min` / `max`. A placeholder LIMIT
(`limit ?`) does not reach you yet. Two rules follow:

- The bound is `limit + offset`, never `limit` alone. The engine's `LimitOffsetNode` still
  discards `offset` rows above whatever you emit, so stopping at `limit` underproduces.
- Apply it only to a candidate that **provides the requested ordering**, and only when
  that candidate **claims every filter**. A plan that provides no ordering gets a Sort
  above it, which drains its input before emitting anything; a plan that leaves a filter
  in the residual gets a `Filter` above it, which can reject rows you already produced. If
  you price *some* candidates against the bound and not others, you have not made your
  cost model more accurate — you have put a thumb on the scale between them.

`StoreModule` does exactly this in `rowsToProduce`
(`packages/quereus-store/src/common/store-module-access-plan.ts`), applied uniformly to
its seek arms, its ordering walk, and its full scan.

```typescript
interface BestAccessPlanResult {
  handledFilters: readonly boolean[];  // Which filters the module handles
  cost: number;                        // Cost estimate
  rows: number | undefined;            // Cardinality ESTIMATE, never a proof
  provablyEmpty?: boolean;             // Proof that nothing can match the claimed filters
  providesOrdering?: readonly OrderingSpec[]; // If module provides ordering
  indexName?: string;                  // Name of the chosen index ('_primary_' or a secondary)
  indexDescriptor?: IndexDescriptor;   // Structured identity of that index (see below)
  seekColumnIndexes?: readonly number[]; // Columns forming the seek key
  isSet?: boolean;                     // If result is guaranteed unique
  explains?: string;                   // Free-text explanation for debugging
  residualFilter?: (row: any) => boolean; // Optional JS filter for residual predicates

  // Optional monotonic-storage advertisements. The optimizer lifts these onto
  // the physical leaf node's `physical.monotonicOn` / `physical.accessCapabilities`
  // and downstream rules use them to license rewrites that depend on
  // total-order emit (streaming asof, monotonic merge join, ordinal-seek
  // pushdown). Not propagated through pass-through nodes.
  monotonicOn?: { columnIndex: number; direction: 'asc' | 'desc'; strict: boolean };
  supportsOrdinalSeek?: boolean;       // Implies monotonicOn; O(log N) seek to kth row
  supportsAsofRight?: boolean;         // Implies monotonicOn; forward-only repositioning
}
```

**Capability contracts**:
- `providesOrdering` must carry each key column's *actual* emit direction. A key declared `PRIMARY KEY (id DESC)` is walked descending, so its spec is `desc: true` — advertising `desc: false` over it lets the merge-join rule skip the Sort it needs, and the join silently drops rows. Derive the flag from the column definition (`desc: !!col.desc`); never hard-code it.
- **A required ordering may be served by walking a matching index backwards.** After the key columns pinned by equality are skipped, if every column of `requiredOrdering` matches its key column with the *opposite* direction (`required.desc === !keyCol.desc`), a backwards walk of the index delivers it — this is how `order by c desc` is answered from an ascending index on `c`, or `order by id desc` from an ascending primary key. All matched columns must agree on one direction: a partial flip (`order by a desc, b asc` over `(a, b)`) is neither the index order nor its reverse and still needs a Sort. Claim it like a forward match (`providesOrdering` = the request, `orderingIndexName` = the index) and also return `indexDescriptor` with `reverse: true`; `reversedIndexDescriptor(tableInfo, indexName)` builds that from the schema. The planner then adds `reverse=1` to the `idxStr` it hands your runtime (test it with `idxStrWalksReverse(decodeIdxStr(idxStr))`), so text and descriptor state one fact. Claim a backwards walk only when a request asks for one, and never set `reverse` on a plan that claims no ordering — the planner rejects that with an internal error, because a forward scan under a reversed claim returns rows in the wrong order. A backwards walk must emit the exact reverse of the forward walk of the same window, including the order of rows that share one secondary-index value (reverse primary-key order): the isolation overlay merges against the negated forward order.
- **`providesOrdering` also claims NULL placement, and the engine's placement is absolute.** `ORDER BY` puts NULLs FIRST for *both* directions (`orderByNullResult`, `util/comparison.ts`). Both shipped backends store NULL as a column's lowest key value, so a walk emits a column's NULLs first when it runs that column ascending — an ASC column walked forwards, or a DESC column walked backwards — and last when it runs it descending. Do not re-derive the rule: `nullSafeOrderingPrefixLength(tableInfo, request, keyColumns, orderPreservingPrefix, pinnedCols, reverse?)` is exported from `@quereus/quereus` and is what both shipped backends use. Notes on calling it:
  - Pass `reverse: true` for a claim served by a backwards walk. The gate applies to each column's effective direction (`col.desc !== reverse`): a nullable ASC column walked backwards needs a NULL-excluding filter, and a nullable DESC column walked backwards does not.
  - `keyColumns` is an `IndexColumnSchema[]`, so an index's `columns` and a table's `primaryKeyDefinition` both go in unchanged — **a nullable descending primary-key member is exposed by the same reasoning, with no `CREATE INDEX` involved.**
  - Truncating the returned prefix is the general form. A caller that claims a required ordering verbatim (all or nothing) wants the boolean `nullSafeOrderingPrefixLength(…) === matchedLength` instead.
  - Gate **every** claim, not only the one a `requiredOrdering` asked for: a bare advertisement made with no request is read by the merge-join rule under the same NULLs-first rule, and a `monotonicOn` `direction: 'desc'` (plus `supportsAsofRight`, which implies it) asserts the same physical order.
- **`providesOrdering` and `monotonicOn` are read under each table column's declared collation,** whatever collation your key is stored under. `ORDER BY` and merge join both compare under the column's own, so a key on `(k collate nocase)` over a BINARY `k` claims nothing on `k`: it emits `'a'` before `'B'` and they want the reverse. The engine also checks the opposite direction, a predicate whose collation differs from your index, as a backstop for modules that do not read `PredicateConstraint.collation`. See `orderingClaimSurvivesCollation`.
- `monotonicOn` is the leaf's natural emit order (storage property, not request-dependent). Stronger than `providesOrdering` — implies a total order with no gaps in coverage.
- `supportsOrdinalSeek` enables the `monotonic-limit-pushdown` rule: when advertised, the runtime may stamp `FilterInfo.offset`/`FilterInfo.limit` and the module must seek directly to the kth monotonic row (see `query()` contract above). Modules that advertise `supportsOrdinalSeek` but ignore the directives at runtime degrade to a streaming `LIMIT` (the rule's slice operator enforces the cap above the leaf).
- `supportsAsofRight` enables the `lateral-top1-asof` rule: forward-only repositioning per left row.

**Row counts — `rows` is an estimate, with no exception**:

`request.estimatedRows` is the planner's size for the table — your module's `getRowCount` answer, an observed count or the `ANALYZE` count, ranked as in [Optimizer Cost and Statistics § Base-table row estimates](optimizer-costing.md#statistics-abstraction); `undefined` means unknown. Defer to a supplied hint, or the access path is costed against a different figure than the plan around it. `rows` in the result is an estimate the engine costs with and nothing more — `rows: 0` is a very selective estimate, not an assertion about the result set, and the engine will still read your table and enforce the filters.

**Unknown is sent as unknown.** Every site in the planner that builds a request now sends `undefined` for a table whose size nobody has measured — no site substitutes a placeholder row count of its own. So a self-sizing module should report through `getRowCount` ([contract](module-capabilities.md#surface-inventory)), and a module that cannot size itself must supply its own fallback (`request.estimatedRows ?? 1000` or whatever suits its storage), because nothing upstream will. Three spellings, all distinct: `undefined` is "nobody knows", `0` is "measured, and empty" (price against it — do **not** read it as unknown — but floor it at one row when turning it into a cost, as both shipped modules do: a zero goes stale on the first insert, and a full scan priced at nothing undercuts every seek; see [Optimizer costing § Base-table row estimates](optimizer-costing.md#statistics-abstraction)), and `n > 0` is a measurement to defer to. Use `??`, not `||`, when reading it, or a measured empty table silently becomes your default. `validateAccessPlanRequest` rejects a negative or non-integer `estimatedRows`; `undefined` and `0` both pass.

**`provablyEmpty` is the proof channel.** Set it only when your module has *proven* that no row can satisfy the filters it claimed in `handledFilters` — `IS NULL` on a NOT NULL column is the canonical case. The planner then replaces the entire table access with a static empty relation and your table is never read. Two consequences:

- **Never set it because the table is empty right now.** Planning precedes execution, and a statement can write rows into a table before reading them back (a view update materializing its missing non-preserved-side row does exactly that). "Empty at plan time" is a row count, not a proof.
- **Declining is always safe.** Leaving it absent costs one optimization and can never produce a wrong answer.

Build the answer with `AccessPlanBuilder.empty(handledFilters)`, which sets cost 0, `rows: 0`, your filter claims and the flag together. `validateAccessPlan` rejects the two half-expressed shapes as module bugs: `provablyEmpty` with no filter claimed handled (you cannot prove a predicate unsatisfiable without claiming the predicate), and `provablyEmpty` with `rows` other than 0.

> **Contract change.** `rows: 0` on a plan claiming every filter used to mean "unsatisfiable" and folded the table access away. It no longer does: such a plan is now READ and its filters enforced normally. A third-party module that relied on the old overload must set `provablyEmpty` (or call `AccessPlanBuilder.empty`) to keep the fold; one that reported an honest 0 gets the correct answer where it previously got none.

**Sizing `rows` per predicate: read `tableInfo.statistics`.**

`getBestAccessPlan` is handed the `TableSchema` itself, so everything `ANALYZE` collected
is already in scope. `tableInfo.statistics` is a `TableStatistics` — `rowCount`,
`lastAnalyzed`, and a `columnStats` map **keyed by lowercase column name** — where each
`ColumnStatistics` carries `distinctCount`, `nullCount`, `minValue`/`maxValue` and an
optional equi-height `histogram`. It is `undefined` until statistics exist for the table —
either because someone ran `ANALYZE` this session, or because a module that persists them
([Persisting statistics across a reopen](module-authoring-statistics.md#persisting-statistics-across-a-reopen)) stamped a
saved snapshot back onto the schema at open. A column ADDED since those statistics were
collected simply has no entry; a RENAMED one keeps its entry, re-keyed onto the new name by
the engine (see [Optimizer costing § Statistics across DDL](optimizer-costing.md)). Nothing
else on the request carries these numbers; there is no separate hook to implement.

Two rules make a module's estimate usable rather than merely present:

- **Produce the number the engine would produce for the same predicate.** A seek's
  advertised `rows` and the estimate a residual `Filter` above it carries describe the same
  row set; if they disagree the optimizer is comparing two different worlds. The engine's
  `CatalogStatsProvider` prices `c = v` as `1 / max(distinctCount, 1)` and a bound as the
  histogram's verdict, then combines conjuncts with damped independence — so use the two
  exported helpers, `selectivityFromHistogram(histogram, op, value, rowCount)` and
  `combineConjunctive(factors)`, rather than restating either formula.
- **Fall back wholesale, not partially.** If any column your plan pins has no statistics,
  size the whole access from your shape constant instead of mixing a measured factor with a
  guess. Look statistics up as index → the column's *current* name → `columnStats`: an
  added column then misses cleanly, and a dropped column cannot borrow a neighbour's
  numbers. Treat `rowCount === 0` as no statistics at all: a snapshot taken while the table
  was empty (an `ANALYZE` that ran before the data load) has a `distinctCount` of 0 for
  every column, which `1 / max(distinctCount, 1)` reads as "matches every row" — the
  opposite of the truth, and enough to disable your index arms until someone re-analyzes.
  `CatalogStatsProvider` short-circuits the same case rather than applying it.

- **`rows` counts rows MATCHED, not seek keys issued.** The two coincide on a unique index
  and diverge everywhere else: `k = 5` is one seek key against a column with four distinct
  values over 2000 rows, and returns 500. `AccessPlanBuilder.eqMatch(n)` derives both cost
  and `rows` from one argument, which is convenient only when they agree — cost scales with
  the seek keys, `rows` with what they match — so pass the key count to `eqMatch` and set
  the row count separately with `.setRows(...)`. Clamp to the table size: a seek cannot
  return more rows than the table holds. The engine relays this number straight onto the
  physical seek node, where it is the input to join-algorithm selection, cache admission
  and sort costing above the seek; under-estimating it is the more dangerous direction.

`@quereus/quereus` exports `TableStatistics`, `ColumnStatistics`, `EquiHeightHistogram`,
`HistogramBucket`, `selectivityFromHistogram` and `combineConjunctive` for exactly this.
The store module (`packages/quereus-store/src/common/store-module-access-plan.ts`) is the
worked example; the memory module's equality arm (`vtab/memory/module.ts`,
`estimateEqualityRows`) is the small one.

**Claiming `handledFilters` — the positional contract**:

A module may set `handledFilters[i] = true` only for a filter it will actually apply.
For the seek-family operators (`=`, `IN`, `<`, `<=`, `>`, `>=`, `OR_RANGE`) the planner
consumes at most one filter per column per role — the first `=`, the first lower bound,
the first upper bound, **in `request.filters` order**. Claim positionally: mark the first
match, leave redundant same-column same-role filters unhandled so they survive as a
residual `Filter`. The planner reattaches any claimed filter it did not consume, so without
a LIMIT an over-claiming module costs a redundant filter, not a wrong answer.

Ops outside the seek family (`IS NULL`, `IS NOT NULL`, `LIKE`, `GLOB`, `MATCH`, `NOT IN`)
never become seek bounds, so the engine re-checks a claim on one above your scan and the
filter stays in the plan. The exception is `IS NOT NULL` on a `NOT NULL` column, which no
row can fail. The re-check does not mean your scan is distrusted: under the isolation layer
it is what removes staged rows, which your scan never sees.

Such a claim still does two things. It feeds your own pricing, and it counts toward the
licence to truncate: the engine keeps a plan that stops at `request.limit` only when that
plan claimed every filter. So claim a non-seek filter only if your scan applies it. If you
claim one you do not apply and stop at `limit + offset`, the re-check discards some of the
rows you counted and the query returns too few.

Three corollaries worth spelling out:

- **Count distinct columns, not filters.** `a = 1 and a = 2` on a composite primary key
  `(a, b)` is *not* a full key match. Deduplicate by `columnIndex` before deciding that
  every key column is pinned.
- **Claim a seek-family filter only if you can seek it.** A range on a non-leading key
  column, for instance, is not turned into a bound; leave it unhandled.
- **A range bound is seeked only on the leading seek column.** A range on a later seek
  column is usable only as the trailing bound of a prefix seek, and only when every
  preceding seek column is pinned by a *single-valued* equality (`a = 1`, or `a in (1)`
  — not `a in (1, 2)`). Otherwise the planner declines the seek entirely and scans.
- **The residual only exists on the planned path.** Declining a filter here is safe
  because the engine reattaches it above the module. A caller that drives
  `VirtualTable.query()` *directly*, outside the planner — the isolation layer's
  primary-key probes are the in-repo example — has no engine above it to reattach
  anything, so the constraints in its hand-built `FilterInfo` are a **request**, not a
  contract. Such a caller owns re-checking every row you return, and must stay correct
  when you answer a seek with the whole table. Do not treat a direct `query()` call as
  permission to skip the negotiation: your module remains free to decline.

**Runtime-valued `IN` sets**:

`where col in (select …)` has no plan-time values. It arrives with `op: 'IN'`, **no
`value`**, and `runtimeSet: { maxCount, estimatedCount? }` instead — *"an `IN` over
`columnIndex` with 1..`maxCount` values I cannot name"*. The two fields are mutually
exclusive; `estimatedCount` is an advisory integer in `0..maxCount`.

Accepting it (`handledFilters[i] = true`, plus `indexName` and `seekColumnIndexes`)
promises one thing: you can serve that column as a multi-seek on the named index. In
return, `query()` gets an ordinary `plan=5` multi-seek `FilterInfo` — `K` EQ constraints
and `K` values in `args`, `1 ≤ K ≤ maxCount` — indistinguishable from a literal list, so
**your runtime does not change**. The engine, not the module, enforces `maxCount`: an empty
or oversized set falls back to a scan and never reaches you. Only single-column runtime
sets exist today.

Declining is always correct; only the speed-up is lost. A module predating `runtimeSet`
declines automatically, since `Array.isArray(f.value) && f.value.length > 0` is false.

**But never answer a `runtimeSet` request with your own scan verdict.** A request carrying
`runtimeSet` on any filter is engine-synthesized: `rule-key-set-seek` probes the module
twice, at 2 keys and at `maxCount`, and reads *either* answer that names no index as "the
module declined", abandoning the whole rewrite. So a module that otherwise compares its
seek against a sequential scan and returns the scan when the seek looks worse must skip that
comparison here, and answer with the seek plan and its honest cost. The engine makes the
scan comparison itself — it interpolates a break-even key count from the two costs you
return, so what it needs from you is a *cost that varies with `maxCount`*, not a verdict.
Keep that cost as close to linear in the key count as you can: two points are all the engine
gets, so a sharply non-linear cost makes its interpolation meaningless.

If you accept one: claim `providesOrdering` or `monotonicOn` over its column only if your
multi-seek emits in the index's own KEY order — which the hard requirement below obliges
it to anyway. A multi-seek that walks in seek-argument order must claim neither, or the
planner elides a `Sort` it needs. The store's `_primary_` arm is the worked example: it
sorts its points by encoded key and so does advertise primary-key order, which is what
lets `where pk in (select …) order by pk` drop its Sort. Also
apply your existing safety gates — collation windows that may under-fetch, semantically
compared seek columns, your own cross-product cap — against `maxCount`, the worst case you
could be handed. Use the exported `equalitySeekKeyCount(filter)` (seek keys it contributes
as an equality, or `null` when it fills no equality role) and `isMultiValueEquality(filter)`
rather than re-deriving the four `IN` shapes.

**Naming the chosen index — `indexName` and `indexDescriptor`**:

When a module sets `indexName` (and `seekColumnIndexes`) the engine records the choice on
the physical leaf as both a text `idxStr` and a structured `FilterInfo.accessPath`. Order-
sensitive consumers — most importantly the transaction-isolation overlay, which must merge
its per-connection changes in the *same sort order the underlying scan emits* — read the
structured form to learn what the index actually is: whether it is the primary key, its full
key columns, and whether it is unique.

The engine resolves that structure itself in two cases:

- `indexName` is `_primary_` (the primary key), or
- `indexName` matches an index present in `tableInfo.indexes` (case-insensitive).

If your module names the index anything else — most commonly a **per-plan alias** for the
primary key, e.g. `_primary_1`, minted so a downstream layer can recover which plan produced
a given scan — the engine cannot resolve it from the schema. You **must** then also return an
`indexDescriptor`:

```typescript
interface IndexDescriptor {
  name: string;                 // must equal the plan's indexName
  role: 'primary' | 'secondary';
  keyColumns: readonly { columnIndex: number; desc: boolean; collation?: string }[]; // FULL key, in index order
  unique: boolean;
  reverse?: boolean;            // true ⇒ the scan walks this index in reverse of keyColumns order
}
```

`role` is authoritative, not `name`: a descriptor with `role: 'primary'` **is** the primary
key however it is named. `validateAccessPlan` rejects a descriptor whose `name` disagrees with
the plan's index name.

The planner's collation checks — whether a seek fully answers a predicate, needs it re-checked
above the seek, or must be declined to a scan, and whether an ordering claim survives a collated
predicate — resolve the index the same way and read each key column's collation from
`keyColumns[].collation` (absent ⇒ BINARY). A module whose physical key folds case should say so
there: a descriptor stating `NOCASE` gets a NOCASE seek for `k = 'x' collate nocase` and a seek
plus re-check for a BINARY `k = 'x'`. (For `_primary_` with no descriptor of yours, the engine
reads each key column's declared collation.) An index the engine cannot resolve has an unknown
collation, so the checks assume the worst: a BINARY equality keeps the seek and re-checks the
predicate above it, since a BINARY-equal key is equal under any collation; any other equality or
range on that index is declined to a scan, and an ordering claim over it does not replace a
`Sort` when such a constraint bears on it.

Scan **direction** matters to the same order-sensitive consumers: a module that walks an index in
reverse **must** set `reverse: true` on the descriptor, whether or not its `idxStr` or a per-plan
index name also records the direction. An emission-order consumer (the isolation overlay's merged
read) learns direction only from `reverse`, for a primary-key plan and a secondary-index plan
alike. Without it, the consumer merges a reversed stream against a forward comparator, which
scrambles row order and can return a committed row alongside its staged replacement. The planner
projects the descriptor's `reverse` into the `idxStr` it builds as the `reverse=1` parameter
(`REVERSE_PARAM`), which is how a module runtime learns the direction it was asked to walk. Code
that builds a `FilterInfo` by hand stamps it the same way, with `withWalkDirection(params, descriptor)`.

**Multi-seek key order is a hard requirement, independent of `providesOrdering`.** A
`multiSeek` access path (`plan=5`) must emit its rows in the scanned index's own key
order, never in seek-argument order (the order the `IN` list appears in the SQL text, or
a runtime set's iteration order) — even though the guidance above says not to *claim*
`providesOrdering` over such a plan. The transaction-isolation overlay's merge assumes an
index access path emits in index-key order for any plan kind whose resolved index has
`role: 'primary'` or names a known secondary index (see Scan direction, above, for the
`reverse` half of the same contract); it mis-pairs overlay rows against stale stored rows
when that assumption is violated (fix/bug-isolation-multiseek-merge-order). Both shipped
backends (the in-memory table and the persistent store) sort their multi-seek keys under
the index's own key comparator before visiting them for exactly this reason. A module
whose multi-seek does not sort equivalently corrupts reads for any table wrapped in
`create table ... using isolated`.

A module that aliases an index name **without** supplying a matching `indexDescriptor` has its
access path recorded as `{ kind: 'unresolvedIndex' }` (and the engine logs a warning). Order-
sensitive consumers refuse an unresolved plan rather than guess — so the alias-without-
descriptor path is a correctness bug in the module, not a slow path. Name the primary key
`_primary_` or supply the descriptor.

**When to use**: Most modules (in-memory tables, file-based storage, traditional indexes).

**Example**: [Indexed Table](#indexed-table), under Common Patterns.

### 3. Concurrency Mode (Parallel Runtime)

> **Stability: Experimental** — see [Stability Tiers](stability.md#tiers).

When a parallel-runtime consumer (e.g. fan-out lookup join) wants to issue
multiple vtab calls in flight on a single connection, it consults the
module's declared `concurrencyMode`. By default, modules opt out of
parallelism — the runtime acquires a per-connection lock so calls are
serialized.

```typescript
interface VirtualTableModule {
  readonly concurrencyMode?: 'serial' | 'reentrant-reads' | 'fully-reentrant';
}
```

| Mode | Per-connection guarantee from the module |
| --- | --- |
| `'serial'` (default) | Nothing. Runtime serializes via `acquireConnectionLock`. |
| `'reentrant-reads'` | Concurrent `query()` is safe; writes still serialize. |
| `'fully-reentrant'` | All operations are safe to interleave on one connection. |

**Default is `'serial'`** — the safe choice for any module that hasn't
been audited. The cost is that parallel consumers fall back to lock
serialization on shared connections, defeating parallelism for that
module. The declaration is the knob that actually buys parallelism;
nothing else needs to change.

**Upgrading a module:**

1. Identify the connection-level state mutated by `query()`, `update()`,
   savepoints, etc. If `query()` snapshots its working set at call entry
   and never touches state another call writes, `'reentrant-reads'` is
   safe.
2. Walk through the worst-case interleavings under
   single-threaded JS: torn reads can only happen if a write publishes
   state in more than one statement step. Atomic single-statement
   pointer swaps are safe; multi-step state machines aren't.
3. For `'fully-reentrant'`, the same holds for writes. This is a much
   higher bar and is usually not worth it — `'reentrant-reads'` is the
   common upgrade target.

The runtime helpers live at `vtab/concurrency.ts`:

```typescript
import { getModuleConcurrencyMode, acquireConnectionLock } from '@quereus/quereus';

const mode = getModuleConcurrencyMode(module);
if (mode === 'serial') {
  const release = await acquireConnectionLock(connection);
  try {
    for await (const row of vtab.query(filterInfo)) yield row;
  } finally {
    release();
  }
}
```

Memory vtab declares `'reentrant-reads'`: `query()` captures the
connection's read or pending layer at call entry and iterates that
captured BTree, so concurrent reads on one connection see consistent,
non-mutating snapshots. Writes serialize because, once a transaction is
open, subsequent writes mutate the existing pending layer's BTree in
place — `'fully-reentrant'` would require either fresh-per-write layers
or an iterator-safe mutation path. Layered stores, isolation wrappers,
and persistent plugins stay default until their owners audit them.

### 4. Committed-Snapshot Reads (`_readCommitted`)

The `readCommittedSnapshot` declaration — the obligation a module takes on by promising a
consistent committed state to a read that overlaps another connection's commit, the two
implementation shapes that meet it, what a wrapper module must do to avoid degrading a
snapshot-safe underlying, and the `runCommittedReadConformance` harness that proves it —
lives in [module-committed-reads.md](module-committed-reads.md).

### 5. Backing Host (Materialized-View Backing Tables)

A module may volunteer to host materialized-view backing tables by implementing
the optional `getBackingHost` hook — presence of the method is the capability
(the `getMappingAdvertisements` signaling style):

```typescript
interface VirtualTableModule {
  getBackingHost?(db: Database, schemaName: string, tableName: string): BackingHost | undefined;
}
```

`BackingHost` (`vtab/backing-host.ts`; `BackingHost`, `BackingScanRequest`,
`MaintenanceOp`, and `BackingRowChange` are exported from the package root) is
the privileged per-table surface the engine drives MV maintenance through:

- `ownsConnection(conn)` — true when `conn` is a live connection to **this**
  backing-table incarnation. The host must be pinned to one incarnation (capture
  the table's internal handle by reference at resolve time): after a
  drop+recreate of the same name, the new host must reject the old
  incarnation's connections.
- `connect()` — a fresh `VirtualTableConnection`; the engine registers it so
  coordinated commit/rollback (savepoint replay included) covers its pending
  state in lockstep with the source write.
- `applyMaintenance(conn, ops)` — apply an ordered `MaintenanceOp` batch
  (`delete-key` / `upsert` / `delete-by-prefix` / `replace-all`) to `conn`'s
  **pending** transaction state, bypassing user-DML read-only enforcement while
  keeping secondary-index / change-tracking bookkeeping. Returns the
  **effective** `BackingRowChange`s realized — exact reporting is part of the
  contract (the MV-over-MV cascade replays them; no-op ops yield nothing,
  `replace-all` yields the minimal keyed diff). Later reads on `conn` must
  observe the applied ops (reads-own-writes).
- `replaceContents(rows, onDuplicateKey?)` — atomically replace the
  **committed** contents (the create-fill of a new backing); throw `onDuplicateKey()` (or a
  generic `CONSTRAINT`) on a duplicate PK; concurrent readers see pre- or
  post-swap state, never partial.
- `scanEffective(conn, { equalityPrefix?, descending? })` — reads-own-writes
  scan over `conn`'s effective state in PK order, honoring `equalityPrefix` as a
  seek + early-terminate leading-PK prefix range.

**Cost contract:** PK-ordered storage with O(log n) keyed
upsert/delete/point-lookup **and** the ordered prefix-range scan are required —
do not advertise the capability without them (the engine does not gate per
maintenance arm). A backing table must reject user DML (READONLY) while
admitting the privileged surface, and the engine adds no latching around it —
the host owns its own concurrency discipline under the module's declared
`concurrencyMode`. The memory module is the reference implementation
(`MemoryTableModule.getBackingHost`); the store module is the second realized
host (`StoreBackingHost` in `@quereus/store` — pending state on the per-table
`TransactionCoordinator`, reads-own-writes via the store's pending-merge read
paths, with the isolation wrapper forwarding the capability conditionally); see
[`docs/mv-backing-host.md`](mv-backing-host.md#backing-host-capability)
for the engine-side view.

A capability-advertising module is selectable as an MV's backing host via
`create materialized view mv using <module>(args) as <body>` (omitting the
clause defaults to memory) — the create builder and the catalog-import path
both gate on `getBackingHost` presence and reject a capability-less module with
a sited `UNSUPPORTED`. One soft edge rides on `alterTable` rather than the
capability itself: source column-rename propagation renames the backing's
shifted columns through the host module's `alterTable`; a host without it
throws `UNSUPPORTED` and the propagation's failure path marks the MV stale
(recoverable by `refresh`) instead of renaming in place.

**Durable hosts and the rehydrate adopt fast path.** By default, catalog import
drops a pre-existing same-module `_mv_<name>` table and refills it from the body
— always correct, never trusting persisted derived rows. A durable host that
wants the adopt-without-refill fast path on reopen does two things: persist its
backing as an **ordinary table entry** in its catalog (so its own rehydration
phase 1 reconnects the table before the MV entries import), and pass
`importCatalog`'s `trustBackings: true` (plus one shared `adoptedBackings` set
across the session's calls) **only when it can attest no crash since the last
open** — the store module's vehicle is a single-use clean-shutdown catalog
marker written by `closeAll` and consumed at `rehydrateCatalog`. Never pass
`trustBackings` unconditionally: the engine's remaining gates are DDL-level and
cannot see content divergence from a crash. See
[`docs/mv-backing-host.md` § Cross-module atomicity](mv-backing-host.md#cross-module-atomicity)
for the full gate set.

## `normalizeCreateSchema` — "what would this schema become?"

Some modules rewrite a table schema on the way through `create`. The store module
supplies its table-level key collation `K` to a text primary-key column that declares
no `COLLATE` clause, so `create table t (a text primary key) using store` registers `a`
as `COLLATE NOCASE`, not the engine's BINARY default.

That rewrite is invisible to the engine, which mattered in one place: a materialized
view's backing. The engine re-derives the backing's shape from the body on reopen and on
refresh and compares it to the live table. Derivation produces the *pre*-rewrite shape
while the live table carries the *post*-rewrite one, so the comparison reported a
difference that did not exist — a text-keyed backing failed the adopt gate and re-ran its
whole body on **every** reopen.

The optional hook lets the engine ask the module the question directly, without creating
anything:

```typescript
interface VirtualTableModule {
  /** Deterministic, side-effect free. May adjust per-column attributes the module owns
   *  physically; may NOT add, remove, reorder, or rename columns. */
  normalizeCreateSchema?(tableSchema: TableSchema): TableSchema;
}
```

Rules for an implementor:

- **Route your own `create` through it.** The rewrite must have exactly one owner, or the
  engine's answer and your actual create can drift. `StoreModule.create` calls
  `this.normalizeCreateSchema(tableSchema)` instead of the rewrite directly.
- **Read your configuration off the schema.** The hook takes no extra parameters; the
  store reads `K` from `tableSchema.vtabArgs`, so the answer is a pure function of the
  input.
- **Stay pure and shape-preserving.** The engine calls it on a *probe* schema (columns,
  column-index map, physical primary key, `vtabArgs` — no module state, no table
  behind it) outside any create, and may call it more than once. Changing the column
  count, or a column's name or position, is a contract violation and raises `INTERNAL`
  rather than being read as a shape difference.
- **Omit it** if your module creates schemas verbatim — the engine then treats
  normalization as the identity (memory, and every module written before the hook
  existed).
- **A wrapper module must forward it** by presence, exactly like `getBackingHost` and
  `createBacking` — `IsolationModule` assigns it in its constructor only when the
  underlying module implements it. A wrapper that delegates `create` but hides the hook
  reintroduces the asymmetry the hook exists to close.

Engine side: `deriveBackingShape` applies it (`normalizeBackingShape` in
`runtime/emit/materialized-view-helpers.ts`) before any comparison against a live table,
so `backingShapeMatches`, `describeBackingShapeMismatch`, the refresh reshape classifier
and the rename-propagation assertion all see post-normalization shapes. One subtlety: an
attribute the body left *implicit* is ambiguous once a table exists, because explicitness
is not persisted (`ColumnSchema.collationExplicit` — a declared `COLLATE BINARY` reloads
indistinguishable from no clause). Such a column is therefore compatible with either its
own declared value or the module's normalized one, and the reading that agrees with the
live table wins — so a `create table … maintained` whose text key is declared
`COLLATE BINARY` keeps matching its own declaration. A value matching neither reading is
still a real mismatch.

## Capability negotiation surface

The inventory of every negotiation surface on the `VirtualTableModule` contract — how each
one is signaled, what the engine substitutes when a module omits it, which built-in modules
implement it, the DDL transactionality tiers, the per-arm `alterTable` mandate table, and the
negotiation pattern new modules should follow — lives in
[module-capabilities.md](module-capabilities.md).

## Runtime Execution Modes

### Query-Based Execution

If module implements `supports()`, implement `executePlan()`:

```typescript
interface VirtualTable {
  executePlan?(
    db: Database,
    plan: PlanNode,
    ctx?: unknown
  ): AsyncIterable<Row>;
}
```

The module receives the entire pipeline and executes it within its own context.

### Index-Based Execution

If module implements `getBestAccessPlan()`, implement `query()`:

```typescript
interface VirtualTable {
  query?(filterInfo: FilterInfo): AsyncIterable<Row>;
}

interface FilterInfo {
  args: SqlValue[];           // Constraint values
  argIndices: number[];       // Which constraints are provided
  limit?: number;             // Optional row cap (LIMIT pushdown)
  offset?: number;            // Optional kth-row seek (only valid when supportsOrdinalSeek was advertised)
  requiredColumns?: ReadonlySet<number>; // Columns the plan reads from emitted rows; absent = all
}
```

The module receives individual constraints and returns matching rows.

### Required columns

`FilterInfo.requiredColumns` names the table columns (0-based indexes into the table schema's `columns`) that the plan reads from the rows this scan emits. A column store can use it to skip assembling the rest: for `select count(*) from t` the set is empty, and for `select a from t where b > 1` it is `{a, b}` unless the module claimed `b > 1`, in which case nothing above the scan reads `b` and the set is `{a}`.

- **Absent means every column.** The engine sets the field only when it has proven the set from the final plan, so a module never narrows a read on a guess. Everything the engine cannot see through — `insert`/`update`/`delete` and their `returning`, constraint and foreign-key checks, set operations, `distinct`, window functions, and any operator the analysis does not model — counts as reading every column of its input rows, so a scan feeding one (directly, or through filters, sorts, limits and joins) arrives with the field absent. A projection or aggregate in between stops that: it reads only the columns its expressions name, so `select a from t union select v from u` still narrows both scans.
- **Honouring it is optional.** A module that ignores it is correct. A module that honours it fills only the listed columns of each emitted row; every other position may hold any valid SQL value (null is the natural choice) and the engine never reads it. The row keeps the table's full width.
- **It says nothing about constraints.** A claimed constraint on a column the plan does not read still has to be applied; the column is simply absent from the set because nothing above the scan looks at it afterwards.
- **A wrapping module adds what it reads.** A module that forwards `FilterInfo` to another module and then reads columns of the rows it gets back must add those columns first. The isolation layer adds the primary-key columns and the walked index's key columns before a merged read, since it merges the overlay and the underlying stream by those keys.
- **The planning request does not carry it.** `getBestAccessPlan` runs while the plan above the scan is still being rewritten, and a module has no way to carry a planning-time answer into `query()`, so the set is computed once from the final plan and delivered with the `FilterInfo`.

The analysis lives in `planner/analysis/required-columns.ts` (optimizer pass `required-columns`, which runs after materialization and before final estimates). The `QUEREUS_COLUMNS_STRICT=1` harness (`yarn workspace @quereus/quereus test:columns-strict`) nulls every unlisted column at the scan boundary for every module, which turns a consumer the analysis missed into a wrong answer the test corpus catches.

**Pushdown directives**: `FilterInfo.limit` is a *runtime* row cap and — unlike the plan-time `BestAccessPlanRequest.limit` above — genuinely soft: a streaming guard above the leaf enforces the count either way, so ignoring it costs work, never answers. Modules may stop emitting once `limit` rows have been yielded. `FilterInfo.offset` is a seek-to-kth-row directive and is only set when the access plan advertised `supportsOrdinalSeek` for this query — modules without ordinal-seek support can ignore both fields safely (a streaming guard above the leaf still enforces correctness).

## Optimization Integration Points

### Physical Property Computation

Modules should communicate:
- **Cardinality**: Estimated row count
- **Ordering**: If module provides sorted output
- **Uniqueness**: If result is guaranteed unique

These properties enable the optimizer to make better decisions about join order, aggregation strategy, and materialization.

### Declaring a cost profile

Storage slower than memory declares `costProfile`: spread the `COST_PRESETS` entry for its category and override only measured fields — `{ ...COST_PRESETS.network, perRowLatencyMs: 0.02 }`. A plan-choice hint; results never depend on it. Presets, sources, paging backends: [Optimizer Costing § Module cost profile](optimizer-costing.md#module-cost-profile).

### Binding Capture

When predicates are pushed into the `Retrieve` pipeline, parameters and correlated column references are captured:

```typescript
// Query with parameter
select * from users where id = ?;

// Retrieve.bindings contains: [ParameterReference(1)]
// At runtime, the module receives the parameter value via FilterInfo.args
```

This enables efficient parameterized queries and correlated subqueries.

An `OR_RANGE` constraint can carry non-literal bounds. Such a bound in `ranges[i].lower` or `ranges[i].upper` has `value: undefined`, plus a `valueExpr` and a per-bound `bindingKind`. The constraint's own `bindingKind` summarizes its bounds, and is `'mixed'` when they differ. A `'parameter'` bound keeps one value for a whole execution of the statement, but can change when the prepared statement is rebound and run again, so don't carry its value across `query()` calls. A `'correlated'` bound can change per outer row, and its `correlated` flag is `true`.

## Transaction Support

Modules can implement transaction methods for ACID compliance:

```typescript
interface VirtualTable {
  begin?(): Promise<void>;
  commit?(): Promise<void>;
  rollback?(): Promise<void>;
  savepoint?(index: number): Promise<void>;
  rollbackTo?(index: number): Promise<void>;
  release?(index: number): Promise<void>;
}
```

See [runtime.md](runtime.md) for transaction semantics.

### DDL inside an open transaction

What a module owes `createIndex` and the row-validating `alterTable` arms when the calling
connection has uncommitted writes — validating the effective rows, enforcing the new constraint
for the rest of the transaction, leaving nothing behind on a refusal, and the `IssuerRowSources`
bundle a wrapper passes when the pending rows live outside the module — lives in
[module-authoring-transactions.md](module-authoring-transactions.md#ddl-inside-an-open-transaction).

### Connection Registration

Registering a connection for transaction coordination, the `DatabaseInternal` methods, evicting
connections on `renameTable`, the connection reuse pattern, and the `adoptConnection` hook live in
[module-authoring-transactions.md](module-authoring-transactions.md#connection-registration).

## Identifier casing in module-facing calls

Every SchemaManager → module hook receives **canonical stored names**, never the raw spelling of the triggering statement:

- `schemaName` is **canonical** — lowercase, folded through `SchemaManager.canonicalSchemaName`. A `MAIN.t` qualifier, or an unqualified statement under a non-`main` current schema, reaches the module as `main` / `aux` / … exactly as `getCurrentSchemaName()` would resolve it.
- An existing object's **own name** (table name to `connect` / `createIndex` / `dropIndex` / `destroy`, the index name to `dropIndex`) is its **stored display casing** — the casing captured when the object was created — not the casing used in the `create index … on T` / `drop index iDx` / `drop table T` that triggered the call.

This holds for the whole hook surface: `create`, `connect`, `createIndex`, `dropIndex`, `destroy`, `alterTable`, `alterTags`, `renameTable`, `getBackingHost`, and the auto-emitted schema-change events. Because the names are stored and stable, a module **may** key its storage, physical stores, and internal registries by the call arguments verbatim — a table created under one casing and later dropped/queried under another will address the same key. (`create` is handed the full canonical `TableSchema`, so its `tableSchema.schemaName` / `tableSchema.name` follow the same rule.)

**The one as-spelled exception** is a *new* object's own name — the index name in `createIndex` (`indexSchema.name`) and `newName` in `renameTable`. These are not yet stored; they *become* the stored name, carrying the casing as written in the DDL (the same way `CREATE TABLE Foo` stores `Foo`). A module that persists the new object should adopt that casing as its stored display name.

This is the module-call analogue of the schema-change event naming contract; see [schema § Schema Change Events](schema.md#event-types).

## Best Practices

### 1. Estimate honestly

`cost` and `rows` drive join order, aggregation strategy, and materialization decisions, so
a wrong estimate buys a wrong plan. Charge `O(n)` for a sequential scan, `O(log n)` for an
index seek, `O(k + log n)` for an index scan returning `k` rows. Push filtering in wherever
you can: what you decline stays a residual above the boundary, so a pushed filter costs
nothing and saves transfer.

Charge the work your seek actually does. `AccessPlanBuilder.eqMatch` / `.rangeScan` price
walking a matched window and nothing more, so a module whose secondary index stores row
IDENTIFIERS rather than rows — it must read each matched row out of a second place — pays a
per-row term those shapes do not model. Add it with `addCost(rows * yourPerRowCost)` rather
than recomputing the factory's formula, so your arm cannot drift from the shape it started
from. The store module does exactly this (the `pointRead` term in
`store-module-access-plan.ts`).

What that per-row term costs may depend on the BACKEND rather than on the module: a random
row read is nearly free in-process and block-cached, and is a separate request across an IPC
boundary in a browser. If your module runs over more than one backend, let each backend
declare the ratio and price your arms from the declaration rather than from one constant —
the store module's `KVCostProfile` (`@quereus/store`, `src/common/cost-profile.ts`) is the
worked example, including its unit (one sequentially scanned row = 1.0) and its rule that an
undeclared backend must plan exactly as it did before the knob existed.

**Nothing compares your plan with an alternative.** `rule-select-access-path` takes the
single plan you return and uses it, so an index seek priced ABOVE your own sequential scan
still wins unless you reject it yourself: compare the seek's cost against the scan's and
return the scan when the seek loses. Losing that way is safe — a scan that claims no
filters leaves every predicate in the residual, so the rows are identical and only the
speed changes.

### 2. Report capabilities conservatively

If `supports()` returns a result, the module must execute that pipeline correctly; if
`getBestAccessPlan()` marks a filter handled, the module must apply it. Over-reporting
yields silent wrong answers, not slow ones.

### 3. Preserve Attribute IDs

When implementing `xExecutePlan()`, preserve the attribute IDs from the input plan:
- Column references use stable attribute IDs
- Transformations must maintain these IDs
- See [runtime.md](runtime.md) for attribute system details

## Common Patterns

### Indexed Table

A scan-only module is this one minus the seek arm: return `handledFilters` all-false with
scan cost and let every predicate stay residual.

```typescript
class IndexedTable extends VirtualTable {
  private index = new Map<SqlValue, Row[]>();

  getBestAccessPlan(req: BestAccessPlanRequest): BestAccessPlanResult {
    // Claim the FIRST '=' on column 0 only — a second `id = ...` is never seeked
    // and must stay residual. See "Claiming handledFilters" above.
    const eqIndex = req.filters.findIndex(f => f.op === '=' && f.columnIndex === 0);
    if (eqIndex >= 0) {
      return {
        handledFilters: req.filters.map((_f, i) => i === eqIndex),
        cost: 1,
        rows: 1,
        isSet: true,
        explains: 'Index equality seek'
      };
    }
    return {
      handledFilters: req.filters.map(() => false),
      cost: 100,
      rows: 100,
      explains: 'Full table scan'
    };
  }

  async* query(filterInfo: FilterInfo): AsyncIterable<Row> {
    if (filterInfo.argIndices.length > 0) {
      const key = filterInfo.args[0];
      yield* this.index.get(key) || [];
    } else {
      for (const rows of this.index.values()) {
        yield* rows;
      }
    }
  }

  async update(op: string, values?: Row, oldKeys?: Row): Promise<Row | undefined> {
    if (op === 'insert' && values) {
      const key = values[0];
      if (!this.index.has(key)) this.index.set(key, []);
      this.index.get(key)!.push(values);
    }
    return undefined;
  }

  async disconnect(): Promise<void> {}
}
```

## Statistics for Cost-Based Optimization

Moved to [Module Statistics](module-authoring-statistics.md): what `getStatistics()` reports, what `ANALYZE` fills in, and persisting statistics across a reopen.

## Update results and REPLACE displacement

`update()` returns an `UpdateResult`. On success (`{ status: 'ok', … }`) it reports what the call actually did through `row`, plus — via two **independent, additive, optional** channels — any rows this same call displaced through `OR REPLACE` conflict resolution. A module that reports neither displacement channel behaves exactly as it would have before they existed, so those two are purely opt-in; `row` is not.

```typescript
type UpdateResult =
  | { status: 'ok'; row?: Row; replacedRow?: Row; evictedRows?: readonly Row[] }
  | { status: 'constraint'; constraint: ConstraintType; message?: string; existingRow?: Row; onConflict?: ConflictResolution };
```

- **`row`** — **whether** you return it says a row really was written or removed; **what** you return is the row you stored. Leaving it out is how you report that nothing changed — a key-not-found UPDATE/DELETE, or a conflict you resolved as IGNORE — and the executor then skips the entire post-write pipeline and emits no row downstream. So return it on every real write, on all four operations. Its contents matter for INSERT/UPDATE: `row` is `args.values` after your own coercion to the declared column logical types. **If you coerce, return the coerced row.** The executor reports `row` — not the values it handed you — to every post-write consumer: `RETURNING`, change tracking, row-time materialized-view maintenance, FK cascades, and data-change events. Returning the raw input from a coercing module makes `RETURNING` disagree with a subsequent `select` of the same row (a `json` column would report the input TEXT while the table holds a parsed JSON value). Nothing is coerced above `update()`, so your pass is the only one — you will never be handed a value you already converted. A row whose width is not the table's column count makes the executor fall back to the proposed values. For DELETE the contents are never read (the OLD image comes from the source scan), so a PK-only placeholder is fine.
- **`replacedRow`** — the row displaced at the **same primary key** by a PK-collision REPLACE (the new row landed on an occupied PK; the old row had the same PK). The executor models it as an update-in-place of that PK slot: change-tracking as `update(replacedRow → newRow)` on the INSERT path (or `delete(replacedRow)` on a UPDATE move), with foreign-key actions fired as a *delete* of the old image.
- **`evictedRows`** — rows at **other primary keys** fully removed because REPLACE resolved a **non-PK UNIQUE** conflict for this same `update()` call. Report them in **user-facing schema** (no internal/overlay columns). The executor models **each** as a full DELETE — change-tracking, row-time materialized-view maintenance, foreign-key `ON DELETE` actions (CASCADE / SET NULL / …), and a delete event — fired **before** the new row's own bookkeeping, matching the substrate's evict-then-write order.

Report `evictedRows` whenever your `update()` internally deletes a row at a different PK to resolve a secondary-UNIQUE REPLACE; otherwise those cross-cutting effects (FK cascades, change subscriptions, events, covering-MV backing maintenance) silently do **not** run for the evicted row. Detection is necessarily module-specific (each module enumerates its current rows its own way), but the maintenance and cascades are **not** — reporting the eviction lets the engine's single post-write pipeline handle them uniformly. The two channels are independent and both appear on one result when a PK-collision REPLACE also evicts on a secondary UNIQUE: resolving the PK by REPLACE does **not** exempt the row from the table's other UNIQUE constraints — check each under its own action (statement OR > constraint default > ABORT) before writing, exactly as for a non-colliding insert. The executor handles both channels on one result.

On a violation, **`onConflict`** reports the action you resolved for this conflict: the statement's `args.onConflict`, else the violated constraint's own declared default, else ABORT. Resolve it per constraint, because each UNIQUE constraint and the primary key can declare a different action. The executor raises its error from this field, so `FAIL` and `ROLLBACK` take effect and any other value is a plain constraint failure. The field is optional: if you omit it, the executor falls back to the statement's `OR` clause alone, so `insert or rollback` still works but a declared `on conflict rollback` acts as ABORT.

> **`ON DELETE RESTRICT` / `NO ACTION` enforcement for evictions.** The executor enforces FK `RESTRICT` / `NO ACTION` for an evicted row alongside the FK *actions* (`CASCADE` / `SET NULL` / `SET DEFAULT`). The substrate has already physically deleted the row by the time it reports `evictedRows`, so there is no pre-mutation point to block at; instead the executor runs the transitive RESTRICT scan **post-eviction** (the child rows it keys off remain) and, on a violation, throws — the statement-scope savepoint then rolls back, unwinding both the eviction and the writing row. A secondary-UNIQUE REPLACE that would orphan a `RESTRICT` (or default `NO ACTION`) child therefore fails the statement and leaves data unchanged, matching SQLite. Enforced on the key-based memory, direct-store, and isolation-wrapped substrates; rowid-chained backends (lamina) remain out of scope (the post-eviction transitive recursion cannot dereference the already-removed parent), mirroring the documented SET-DEFAULT recursion gap.

## Mutation Statements

Virtual table modules can opt-in to receive deterministic mutation statements for each row-level operation. This enables replication, audit logging, and change data capture with guaranteed reproducibility.

### Overview

When a module sets `wantStatements: true`, Quereus provides a `mutationStatement` string with each `update()` call. This statement:

- Represents the **bottom-level mutation** at the VirtualTable.update() level (not the top-level DML statement)
- Contains all values as **literals** (no parameters; non-deterministic source expressions like `random()` or `datetime('now')` are already resolved to the concrete per-row values the engine evaluated)
- Includes **resolved mutation context** values as literals in the WITH CONTEXT clause
- Is the **audit / transport encoding** of the resolved per-row primitive that hit the module; replay is the act of applying that primitive at the same module boundary on another instance — not re-parsing the captured SQL through the full DML pipeline (re-execution would re-fire CHECKs, default evaluation, and generated-column computation, which is explicitly not the supported replay path)

### Module Opt-In

Modules enable mutation statements by setting a property:

```typescript
class MyReplicatedTable extends VirtualTable {
  // Opt-in to mutation statements
  wantStatements = true;

  async update(args: UpdateArgs): Promise<Row | undefined> {
    // args.mutationStatement contains the deterministic SQL statement
    if (args.mutationStatement) {
      await this.replicationLog.append(args.mutationStatement);
    }

    // Perform the actual mutation
    return this.performUpdate(args);
  }
}
```

### Statement Format

Mutation statements use Quereus SQL syntax with all values as literals:

**INSERT Example:**
```sql
-- Original statement with parameters
insert into orders (id, amount) values (:id, :amount)

-- Logged mutation statement (per row)
insert into orders (id, amount) values (1, 100)
```

**INSERT with Mutation Context:**
```sql
-- Original statement
insert into orders (id, amount, created_at)
with context now = datetime('now')
values (1, 100, now)

-- Logged mutation statement (context resolved to literal)
insert into orders (id, amount, created_at) with context now = '2024-01-15T10:30:00Z' values (1, 100, '2024-01-15T10:30:00Z')
```

**UPDATE Example:**
```sql
-- Original statement
update users set name = :newName where id = :userId

-- Logged mutation statement (per row)
update users set name = 'Alice' where id = 1
```

**DELETE Example:**
```sql
-- Original statement
delete from sessions where user_id = :userId

-- Logged mutation statement (per row)
delete from sessions where user_id = 42 and session_id = 'abc123'
```

### Determinism Guarantees

The mutation statement system ensures determinism by:

1. **Resolving Execution Parameters**: All `:name` and `?` parameters are replaced with their literal values
2. **Resolving Mutation Context**: All context variables are evaluated once per statement and emitted as literals
3. **Resolving Defaults / Generated Columns**: DEFAULT and `GENERATED ALWAYS AS` expressions are evaluated per row and emitted as literal values — this is true even when the source expressions contain non-deterministic functions (allowed under `pragma nondeterministic_schema = true`; see [Determinism Validation](determinism.md))
4. **Preserving Order**: Mutations are logged in the order they're applied to the virtual table

Replay then means: take the captured primitive and re-apply it at the module boundary (e.g. feed `mutationStatement` rows back through `vtab.update()` on the replica), not re-execute the SQL through the full DML pipeline. The atomicity of the original commit — including deferred CHECKs that were evaluated once at commit time — is preserved by replaying the transaction's writes as a unit.

### Use Cases

**Replication:**
```typescript
class ReplicatedTable extends VirtualTable {
  wantStatements = true;

  async update(args: UpdateArgs): Promise<Row | undefined> {
    // Send mutation to replicas
    await this.replicator.broadcast(args.mutationStatement!);

    // Apply locally
    return this.storage.update(args);
  }
}
```

**Audit Logging:**
```typescript
class AuditedTable extends VirtualTable {
  wantStatements = true;

  async update(args: UpdateArgs): Promise<Row | undefined> {
    // Log mutation with timestamp and user
    await this.auditLog.record({
      timestamp: Date.now(),
      user: this.currentUser,
      statement: args.mutationStatement!
    });

    return this.storage.update(args);
  }
}
```

**Change Data Capture:**
```typescript
class CDCTable extends VirtualTable {
  wantStatements = true;

  async update(args: UpdateArgs): Promise<Row | undefined> {
    // Publish change event
    await this.eventBus.publish({
      table: this.tableName,
      operation: args.operation,
      statement: args.mutationStatement!
    });

    return this.storage.update(args);
  }
}
```

The database-level event system a module feeds — `getEventEmitter()`, the auto-event path,
transaction batching, and the row-shape / table-name / row-key contract across mid-transaction
ALTER — is documented separately in [Database-Level Event System](module-events.md).

**A module that raises its own data-change events owes two more guarantees**, on top of the
as-of-delivery ones above. A module without an emitter owes nothing here: the engine's
auto-event path produces both for it.

- **`key` is the primary key projected out of the event's own row image** — out of `newRow` for
  an `insert` and an `update`, out of `oldRow` for a `delete`. Never the pre-image key of an
  update, and never a key your storage layer normalized away from the values the row holds.
- **An `update` event never moves a row.** If a write relocates a row — its key values differ
  under the primary key's own comparator, which is per-column collation- and type-aware, not
  byte identity — emit a `delete` at the old key followed by an `insert` at the new key, in
  that order, instead of one `update`. Test relocation with the same comparator (or the same
  encoded key) your storage uses to address rows, never raw value equality: under a `NOCASE`
  key, rewriting `'apple'` to `'APPLE'` moves nothing and stays a single `update`, keyed by
  the post-image. Consumers are promised the ordering but **not** adjacency, so you may
  interleave other events between the pair.

Both are what lets a listener retire a row's old identity without knowing which columns form
the key — see [Event System § Subscribing to Data Changes](usage-events.md#subscribing-to-data-changes).

## Write scope

A module that queues writes for later — an offline store, a sync client — can opt in with `wantWriteScope = true` to receive, with each row it is asked to write, `UpdateArgs.writeScope`: the [write-scope](write-scope.md) `TableWrite` of the statement write that row belongs to (how it chose its target rows, where each written value comes from, which constraints could reject it), so it can decide at staging time whether another writer could make the queued write fail on replay.

- **Opt-in.** Unset, the engine runs no analysis and `writeScope` is absent.
- **Parameters are bound** — on a prepared statement and on `db.exec` alike — so `selection.values` holds literal keys.
- **One object per execution.** Every row receives the same reference; treat it as read-only. An upsert's DO UPDATE arm receives the INSERT's object.
- **Only the statement's own writes.** An FK cascade child write carries none (`db._isFkCascadeReentry()` identifies one); REPLACE displacement happens inside the module with no `update()` call.
- **Independent of `mutationStatement`**; a module may take either or both.
- **Behind `@quereus/isolation`** the opt-in is mirrored from the underlying table, but the description reaches only the overlay, not the underlying `update()` at commit.

The full contract and an example decision are in [write-scope.md § Module hook](write-scope.md#module-hook).

## See Also

- [Database-Level Event System](module-events.md) - Data and schema change events
- [Optimizer Documentation](optimizer.md) - Detailed optimization architecture
- [Runtime Documentation](runtime.md) - Execution model and context system
- [Plugins Documentation](plugins.md) - Plugin packaging and discovery

