---
description: When the query planner picks an index, it only records that choice as a hand-rolled text string that three different modules re-parse by hand. Give the planner a proper typed record of the chosen index alongside the string, so consumers stop guessing.
files:
  - packages/quereus/src/vtab/best-access-plan.ts        # BestAccessPlanResult; add indexDescriptor + validation
  - packages/quereus/src/vtab/filter-info.ts             # FilterInfo; add accessPath + shared builders
  - packages/quereus/src/vtab/index-descriptor.ts        # NEW — IndexDescriptor / AccessPath / resolveIndexDescriptor
  - packages/quereus/src/vtab/idx-str.ts                 # NEW — encodeIdxStr / decodeIdxStr / retargetIdxStr
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts  # ~297-1230: every FilterInfo construction site
  - packages/quereus/src/planner/stats/analyze.ts        # ~47-58: hand-built full-scan FilterInfo
  - packages/quereus/src/vtab/memory/layer/scan-plan.ts  # ~77-120, 278-394: private idxStr parser -> shared decoder
  - packages/quereus-store/src/common/store-table.ts     # ~1135-1190: resolveIndexFromIdxStr -> shared decoder
  - packages/quereus/src/index.ts                        # ~32, 66-67: exports
  - docs/module-authoring.md                             # new module contract
difficulty: hard
---

## Background — what is actually going on

When Quereus plans a read of a table, the optimizer rule
`packages/quereus/src/planner/rules/access/rule-select-access-path.ts` asks the table's
module which index it wants (`getBestAccessPlan`), then builds a `FilterInfo` object and
hands it to `VirtualTable.query()` at runtime.

The *only* place the chosen index is recorded on that `FilterInfo` is a free-text field
called `idxStr`, which the rule formats by hand:

```
idx=<indexName>(0);plan=2                                  // equality seek
idx=<indexName>(0);plan=3                                  // range seek
idx=<indexName>(0);plan=5;inCount=3;seekWidth=2            // IN-list multi-seek
idx=<indexName>(0);plan=6;rangeCount=2;rangeOps=ge:lt,gt   // OR-range multi-seek
idx=<indexName>(0);plan=7;prefixLen=1                      // prefix-equality + trailing range
idx=<indexName>(0);plan=0                                  // ordered index walk, no bounds
fullscan                                                    // no index
empty                                                       // provably no rows
```

Three separate places then re-parse that string with their own hand-written splitters:

| Parser | File |
| --- | --- |
| in-memory vtab | `packages/quereus/src/vtab/memory/layer/scan-plan.ts` (`parseIdxStrParameters`, `resolveIndexName`) |
| store module | `packages/quereus-store/src/common/store-table.ts` (`resolveIndexFromIdxStr`) |
| isolation layer | `packages/quereus-isolation/src/isolated-table.ts` (`parseIndexFromFilterInfo`) |

Nothing types, versions, or validates the format. Correcting the original plan ticket:
the string is **produced by the engine**, not by the storage module — so the fix is
entirely inside the engine's own seam, and no cross-package protocol negotiation is
needed.

### Why this is a correctness problem, not just ugliness

The isolation layer merges a per-connection overlay against the underlying table, and it
must merge **in the sort order the underlying scan is emitting**. It decides that order by
parsing `idxStr` to learn which index the scan walks:

- If it reads a *secondary index* name, it merges by `(indexKey…, pk…)`.
- If it reads anything it does not recognise, it falls through to `{ type: 'primary' }`
  and merges by primary key.

That fallback is not a slow path — it is a **wrong** path. A scan that is physically
emitting rows in secondary-index order, merged as if it were in primary-key order, yields
overlay rows interleaved at the wrong positions. The query returns rows in an order the
planner told the rest of the pipeline to trust. A `LIMIT`, a merge join, or a consumed
`ORDER BY` above it then reads the wrong answer.

The fallback fires today whenever an index name is not literally resolvable from the table
schema. A concrete live case: a downstream module (`lamina-quereus`) mints a per-plan
unique alias for the primary-key index — `_primary_`, `_primary_1`, `_primary_2`, … — so
it can recover which plan produced a given scan. The isolation layer papers over that with
two regexes (`PK_INDEX_NAME_RE`, `SUFFIXED_PK_IDXSTR_RE`) that assume the alias suffix is a
bare number. A module that aliased to `_primary_a` would be classified as a secondary index,
find no such index in the schema, get an empty key-column list, and merge by an empty sort
key — silently corrupting scan order.

### The missing seam

`BestAccessPlanResult` (`packages/quereus/src/vtab/best-access-plan.ts`) already carries
`indexName` and `seekColumnIndexes`, but neither says *what the index is*: whether it is the
primary key, what its full key columns are, or whether it is unique. Only the module knows
that when the name is an alias. The rule then throws all of that away into a string.

This ticket adds the typed record, keeps `idxStr` as the wire format the runtime paths
already read, and makes `idxStr` a **projection of** the typed record rather than an
independent invention at each of the ~10 construction sites.

## Design

### New file: `packages/quereus/src/vtab/index-descriptor.ts`

```ts
/** One key column of an index, expressed table-relative. */
export interface IndexKeyColumn {
	/** 0-based index into `TableSchema.columns`. */
	readonly columnIndex: number;
	/** true ⇒ this key column is ordered descending within the index. */
	readonly desc: boolean;
	/** Declared collation name for this key column; undefined ⇒ BINARY. */
	readonly collation?: string;
}

/**
 * Structured identity of the index an access plan iterates.
 *
 * `name` is the module's own name for the index and is what appears in `idxStr`;
 * it may be a per-plan alias that resolves to nothing in the table schema. `role`
 * is therefore authoritative, not the name: a descriptor with `role: 'primary'`
 * IS the table's primary key however it is named.
 */
export interface IndexDescriptor {
	readonly name: string;
	readonly role: 'primary' | 'secondary';
	/** The index's FULL key columns, in index order (not just the seek prefix). */
	readonly keyColumns: readonly IndexKeyColumn[];
	/** true ⇒ a walk of this index yields at most one row per distinct key. */
	readonly unique: boolean;
}

/**
 * Which seek/scan strategy the planner chose over an `IndexDescriptor`.
 * One-to-one with the legacy `plan=N` codes in `idxStr`.
 */
export type IndexPlanKind =
	| 'scan'             // plan=0 — ordered walk, no bounds
	| 'eqSeek'           // plan=2
	| 'rangeSeek'        // plan=3
	| 'multiSeek'        // plan=5 (IN list)
	| 'multiRangeSeek'   // plan=6 (OR_RANGE)
	| 'prefixRangeSeek'; // plan=7

/** Structured description of the access path chosen for one table reference. */
export type AccessPath =
	| { readonly kind: 'fullScan' }
	| { readonly kind: 'empty' }
	| { readonly kind: 'index'; readonly index: IndexDescriptor; readonly plan: IndexPlanKind }
	/** The plan named an index the engine could not resolve; the module must
	 *  supply `indexDescriptor` for it. Consumers that need the index identity
	 *  MUST fail loudly rather than guess. */
	| { readonly kind: 'unresolvedIndex'; readonly indexName: string; readonly plan: IndexPlanKind };
```

Plus:

```ts
/** The table's primary key as an IndexDescriptor, named `_primary_`. */
export function primaryKeyDescriptor(tableSchema: TableSchema): IndexDescriptor;

/**
 * Resolve the structured identity of `indexName` for this plan. Resolution order:
 *   1. `accessPlan.indexDescriptor`, when the module supplied one (authoritative).
 *   2. `indexName` is `_primary_` or `primary`  ⇒ primaryKeyDescriptor(tableSchema).
 *   3. Case-insensitive hit in `tableSchema.indexes`.
 *   4. undefined — caller emits `{ kind: 'unresolvedIndex' }` and logs.
 */
export function resolveIndexDescriptor(
	tableSchema: TableSchema,
	accessPlan: BestAccessPlanResult,
	indexName: string,
): IndexDescriptor | undefined;
```

`resolveIndexDescriptor` takes `indexName` explicitly rather than reading
`accessPlan.indexName`: the ordering-only arm of the rule uses `accessPlan.orderingIndexName`
and the legacy arms hardcode `_primary_`, so the name that lands in `idxStr` is not always
`accessPlan.indexName`. The descriptor must describe the index that is actually walked.

### New file: `packages/quereus/src/vtab/idx-str.ts`

One encoder, one decoder, replacing three hand-rolled splitters.

```ts
export interface IdxStrSpec {
	readonly indexName: string;
	/** The `(n)` group after the name. The planner always emits 0; aliasing modules may not. */
	readonly nameArg: number;
	/** The legacy numeric `plan=` code. */
	readonly plan: number;
	/** Remaining `k=v` parameters in source order (inCount, seekWidth, prefixLen, rangeCount, rangeOps, …). */
	readonly params: ReadonlyMap<string, string>;
}

export function encodeIdxStr(spec: IdxStrSpec): string;

/** null for `null`, `'fullscan'`, `'empty'`, and any string without a parseable `idx=name(n)`. */
export function decodeIdxStr(idxStr: string | null): IdxStrSpec | null;

/** Distinguishes the two sentinel strings from a genuine index string. */
export function idxStrSentinel(idxStr: string | null): 'fullScan' | 'empty' | null;

/** Rename the index inside an idxStr, preserving `plan`, `nameArg`, and every param verbatim. */
export function retargetIdxStr(idxStr: string | null, newIndexName: string): string | null;

export function planKindFromCode(code: number): IndexPlanKind | undefined;
export function planCodeFromKind(kind: IndexPlanKind): number;
```

`params` must be insertion-ordered so `decodeIdxStr` → `encodeIdxStr` round-trips byte-for-byte
on every string the planner emits. `retargetIdxStr` is implemented as decode → swap name →
encode, so it cannot corrupt params it does not understand (this is what lets the isolation
layer safely rewrite an aliased PK name without knowing what `plan=7;prefixLen=1` means).

Note the codes `plan=1` and `plan=4` (descending variants) and the `ordCons=DESC` /
`argvMap=[…]` params are recognised by `scan-plan.ts` but are emitted by nothing in this
repo. `IndexPlanKind` deliberately does not model scan direction — leave that in `idxStr`
and say so in the doc comment, rather than adding a field no producer sets.

### `BestAccessPlanResult` — new optional field

```ts
/**
 * Structured identity of the index named by `indexName`.
 *
 * OPTIONAL when `indexName` is `_primary_` or names an index present in the table
 * schema — the engine resolves those itself. REQUIRED when the module names the
 * index anything else (e.g. a per-plan alias like `_primary_1`): without it the
 * engine cannot tell a primary-key walk from a secondary-index walk, and consumers
 * that depend on scan order (the isolation layer) will refuse the plan.
 */
indexDescriptor?: IndexDescriptor;
```

- `AccessPlanBuilder.setIndexDescriptor(d)`.
- `validateAccessPlan` additions:
  - if `indexDescriptor` is set, `indexDescriptor.name` must equal `indexName` (FORMAT error);
  - `keyColumns` must be non-empty and every `columnIndex` in `[0, request.columns.length)`.

### `FilterInfo` — new optional field

```ts
/**
 * Structured description of the access path this FilterInfo drives — the typed,
 * validated form of what `idxStr` encodes as text. Populated by
 * `rule-select-access-path`; consumers should read this, not parse `idxStr`.
 *
 * Absent ⇒ this FilterInfo was hand-built by a caller that declared no access path.
 * A consumer that needs the access path MUST fail loudly rather than infer one from
 * `idxStr`; the engine's own builders below always populate it.
 */
readonly accessPath?: AccessPath;
```

Plus shared builders in `vtab/filter-info.ts`, so the many literal constructions collapse:

```ts
export function makeFullScanFilterInfo(cost?: number, rows?: number): FilterInfo;   // accessPath: { kind: 'fullScan' }
export function makeEmptyFilterInfo(): FilterInfo;                                   // accessPath: { kind: 'empty' }
export function makeIndexEqSeekFilterInfo(
	index: IndexDescriptor,
	seekColumnIndexes: readonly number[],
	values: readonly SqlValue[],
): FilterInfo;                                                                       // accessPath: { kind: 'index', plan: 'eqSeek' }

/** Rewrite the index name across `idxStr`, `indexInfoOutput.idxStr`, and `accessPath.index.name`. */
export function retargetFilterInfoIndex(filterInfo: FilterInfo, newIndexName: string): FilterInfo;
```

`makeFullScanFilterInfo` / `makeIndexEqSeekFilterInfo` already exist, duplicated, in
`packages/quereus-isolation/src/filter-info.ts`. Move them to the engine; the isolation
package re-exports or calls the engine's. `planner/stats/analyze.ts` switches to
`makeFullScanFilterInfo()` too.

### Populating `accessPath` in `rule-select-access-path.ts`

Every arm already knows its index name and its plan kind — it is literally interpolating
both into `idxStr` on the next line. So each arm:

1. calls `resolveIndexDescriptor(tableRef.tableSchema, accessPlan, idxStrName)`;
2. builds `accessPath` = `{ kind: 'index', index, plan }` if resolved, else
   `{ kind: 'unresolvedIndex', indexName: idxStrName, plan }` **and logs at warn level**
   (`log('access plan named index %s which the engine cannot resolve; module should return indexDescriptor', name)`);
3. formats `idxStr` via `encodeIdxStr` instead of a template literal.

The seq-scan arms get `{ kind: 'fullScan' }`; `createEmptyResultNode` gets `{ kind: 'empty' }`.
Both `selectPhysicalNodeFromPlan` and `selectPhysicalNodeLegacy` are covered.

### Refactoring the two existing consumers

Both keep reading `idxStr` (do **not** switch them to `accessPath` in this ticket — they are
also fed hand-built `FilterInfo`s from tests). They only swap their private parsers for
`decodeIdxStr`:

- `scan-plan.ts` — `parseIdxStrParameters` + `resolveIndexName` + `parseArgvMappings` become
  a `decodeIdxStr` call. Preserve today's exact degenerate behaviour: a null decode ⇒
  `indexName: 'primary'`, `planType: 0`. Preserve the local `_primary_` → `'primary'` rename.
- `store-table.ts` — `resolveIndexFromIdxStr` becomes `decodeIdxStr` + a schema lookup.
  It already returns null for the PK/scan sentinels; keep that.

Behaviour must be byte-identical. This is a de-duplication, not a semantic change.

### Explicitly out of scope

`indexInfoOutput.idxStr` is left stale (`'fullscan'`) by every seek arm — the arms set the
top-level `idxStr` but spread an `indexInfoOutput` built before the index was chosen. This
surfaces as a wrong `usableIndex` in EXPLAIN output. Filed separately as
`backlog/bug-explain-usable-index-always-fullscan` so this ticket does not have to churn
golden plan tests. `retargetFilterInfoIndex` must still rewrite `indexInfoOutput.idxStr`
when present, so it stays correct once that bug is fixed.

## Edge cases & interactions

- **Round-trip fidelity.** `decodeIdxStr(encodeIdxStr(spec))` must equal `spec` for every
  string the planner emits, including `plan=6;rangeCount=2;rangeOps=ge:lt,gt` (the `rangeOps`
  value contains `:` and `,`, and `split('=', 2)` on `k=v` must not eat a `=` inside a value).
  Test each of the seven emitted shapes.
- **`retargetIdxStr` on an unknown-param string.** Given `idx=_primary_7(3);plan=9;wat=x`,
  renaming to `_primary_` must yield `idx=_primary_(3);plan=9;wat=x` — `nameArg`, unknown
  plan code, and unknown param all preserved.
- **Sentinels.** `decodeIdxStr('fullscan')`, `decodeIdxStr('empty')`, `decodeIdxStr(null)`,
  `decodeIdxStr('')` all return `null`; `idxStrSentinel` distinguishes the first two.
- **Alias with a non-numeric suffix.** A module returning `indexName: '_primary_a'` *without*
  a descriptor must produce `{ kind: 'unresolvedIndex' }` and a log line — never a guess.
  With `indexDescriptor: { name: '_primary_a', role: 'primary', … }` it must produce a
  resolved primary descriptor. Both cases need a test module.
- **Name collision.** A *secondary* index genuinely named `_primary_extra` must resolve to
  `role: 'secondary'` via the schema lookup, not be swept up by any prefix rule. There is no
  prefix rule any more — assert it.
- **Descriptor / indexName disagreement.** `indexDescriptor.name !== indexName` must throw
  `FORMAT` from `validateAccessPlan`, not be silently reconciled.
- **`orderingIndexName !== indexName`.** The ordering-only arm walks `orderingIndexName`.
  The descriptor must describe *that* index. `validateAccessPlan` already forbids the two
  from disagreeing when both are set, but the arm is reachable with `indexName` undefined.
- **Legacy arms.** `selectPhysicalNodeLegacy` fires when a module gives no
  `indexName`/`seekColumnIndexes`. Its PK arms must emit a resolved primary descriptor, and
  its ordering arm may use `accessPlan.orderingIndexName`.
- **Empty / impossible predicate.** `createEmptyResultNode`'s FilterInfo gets
  `{ kind: 'empty' }`, not `{ kind: 'fullScan' }` — a consumer must be able to tell "no index"
  from "no rows".
- **Composite `IN` seeks.** `plan=5;inCount=N;seekWidth=W` — `seekWidth > 1` params must
  survive encode/decode; `scan-plan.ts` groups args by them and mis-parsing silently returns
  wrong rows rather than erroring.
- **Store `getBestAccessPlan` returns a cost-only plan** (index named, no `seekColumns`).
  That routes to `selectPhysicalNodeLegacy` today because the index-aware branch requires
  a non-empty `seekColumnIndexes`. Confirm the resulting `accessPath` still names the index
  the runtime actually walks (or `fullScan` if it walks the PK).
- **Zero-column tables / no primary key.** `primaryKeyDescriptor` on a table with an empty
  `primaryKeyDefinition` must not produce a descriptor with an empty `keyColumns` that then
  trips `validateAccessPlan`. Decide and test: return `undefined` (⇒ `fullScan`).
- **Cross-package type export.** `IndexDescriptor`, `AccessPath`, `IndexPlanKind`,
  `IndexKeyColumn`, and the `idx-str` / `filter-info` helpers must all be exported from
  `packages/quereus/src/index.ts` — the isolation and store packages consume them.

## Expected tests

New `packages/quereus/test/vtab/idx-str.spec.ts`:
- round-trip each of the seven planner-emitted shapes;
- `retargetIdxStr` preserves `nameArg` + unknown params;
- sentinel handling.

New `packages/quereus/test/vtab/index-descriptor.spec.ts`:
- `resolveIndexDescriptor` precedence (explicit descriptor > `_primary_` > schema lookup > undefined);
- `_primary_extra` resolves as secondary;
- descriptor/`indexName` mismatch throws FORMAT.

New `packages/quereus/test/vtab/access-path.spec.ts` (or extend `test/plan/`):
- a test module aliasing the PK to `_primary_1` **without** a descriptor plans to
  `{ kind: 'unresolvedIndex' }`;
- the same module **with** a descriptor plans to `{ kind: 'index', index.role: 'primary' }`;
- an eq seek on a real secondary index plans to `{ kind: 'index', plan: 'eqSeek' }` with the
  index's full `keyColumns` (not just the seek prefix);
- `select * from t` plans to `{ kind: 'fullScan' }`;
- `where pk = 1 and pk = 2` (impossible) plans to `{ kind: 'empty' }`.

Existing `test/vtab/scan-plan-bounds.spec.ts`, `test/memory-vtable.spec.ts`,
`test/optimizer/in-multiseek-incount.spec.ts` must pass unchanged — they assert the exact
`idxStr` text, which is the regression net for `encodeIdxStr`.

## TODO

### Phase 1 — types and codec

- Add `packages/quereus/src/vtab/index-descriptor.ts` with `IndexKeyColumn`,
  `IndexDescriptor`, `IndexPlanKind`, `AccessPath`, `primaryKeyDescriptor`,
  `resolveIndexDescriptor`.
- Add `packages/quereus/src/vtab/idx-str.ts` with `IdxStrSpec`, `encodeIdxStr`,
  `decodeIdxStr`, `idxStrSentinel`, `retargetIdxStr`, `planKindFromCode`, `planCodeFromKind`.
- Write `test/vtab/idx-str.spec.ts` and `test/vtab/index-descriptor.spec.ts` first (TDD);
  derive the seven expected strings from the current `rule-select-access-path.ts` literals.

### Phase 2 — engine seam

- Add `indexDescriptor?: IndexDescriptor` to `BestAccessPlanResult`; add
  `AccessPlanBuilder.setIndexDescriptor`; extend `validateAccessPlan`.
- Add `accessPath?: AccessPath` to `FilterInfo`.
- Move `makeFullScanFilterInfo` / `makeIndexEqSeekFilterInfo` (currently in the isolation
  package) into `vtab/filter-info.ts`; add `makeEmptyFilterInfo` and
  `retargetFilterInfoIndex`.
- Export everything new from `packages/quereus/src/index.ts`.

### Phase 3 — populate and de-duplicate

- Rewrite every `idxStr` template literal in `rule-select-access-path.ts` as `encodeIdxStr`,
  and set `accessPath` on the same `FilterInfo`. Cover both `selectPhysicalNodeFromPlan`
  and `selectPhysicalNodeLegacy`, the seq-scan arms, and `createEmptyResultNode`.
- Log at warn level on `unresolvedIndex`, naming the table and the index.
- Point `planner/stats/analyze.ts` at `makeFullScanFilterInfo()`.
- Replace `scan-plan.ts`'s `parseIdxStrParameters` / `resolveIndexName` / `parseArgvMappings`
  with `decodeIdxStr`, preserving the `null ⇒ primary/plan 0` degenerate case exactly.
- Replace `store-table.ts`'s `resolveIndexFromIdxStr` internals with `decodeIdxStr`.

### Phase 4 — validate and document

- Add `test/vtab/access-path.spec.ts`.
- `yarn build`, then `yarn test 2>&1 | tee /tmp/t.log; tail -n 80 /tmp/t.log`, then `yarn lint`.
- `docs/module-authoring.md`: document `indexDescriptor` — when it is optional, when it is
  required (aliased index names), and that a module which aliases without supplying one
  will have its plan rejected by order-sensitive consumers.
- `docs/optimizer.md`: one paragraph on `FilterInfo.accessPath` as the typed access-path
  seam, with `idxStr` as its text projection.
