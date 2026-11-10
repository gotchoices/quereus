/**
 * The read path of the KVStore-backed virtual table: turning a pushed predicate
 * into a byte window over the data store or a secondary index, iterating that
 * window, and re-checking every pushed constraint under the column's real
 * collation.
 *
 * Second layer of the store-table chain:
 *   StoreTableBase -> StoreTableScan -> StoreTableConstraints -> StoreTable
 */

import {
	IndexConstraintOp,
	QuereusError,
	StatusCode,
	compareSqlValuesFast,
	createTypedComparator,
	hasSemanticOrdering,
	BINARY_COLLATION,
	decodeIdxStr,
	idxStrWalksReverse,
	planKindFromCode,
	type IdxStrSpec,
	type CollationFunction,
	type ColumnSchema,
	type CompareFn,
	type LogicalType,
	type TableIndexSchema,
	type Row,
	type FilterInfo,
	type SqlValue,
} from '@quereus/quereus';

import type { IterateOptions, KVStore } from './kv-store.js';
import type { KeyValueTransform } from './encoding.js';
import { bytesToHex, compareBytes } from './bytes.js';
import {
	buildIndexKey,
	buildIndexPrefixBounds,
	buildFullScanBounds,
} from './key-builder.js';
import {
	deserializeRow,
} from './serialization.js';
import { indexPrefixSeekIsCollationExact, indexRangeAtPositionIsOrderSafe, pkOrderPreservingPrefixLength, resolveIndexKeyCollations, resolveIndexKeyTransforms, semanticProbeIsKeyFaithful, storeSemanticKeyTransform } from './pk-key-resolution.js';

import { StoreTableBase } from './store-table-base.js';

/**
 * The pushed constraint ops that bound a byte window from one side. The scan-side twin of
 * `store-module-access-plan.ts`'s `LOWER_BOUND_OPS` / `UPPER_BOUND_OPS` (which name the same
 * four in the planner's `PredicateConstraint` spelling), shared by all three window builders below so a new
 * bound operator cannot reach one arm and not the others.
 */
const RANGE_CONSTRAINT_OPS: readonly IndexConstraintOp[] = [
	IndexConstraintOp.LT,
	IndexConstraintOp.LE,
	IndexConstraintOp.GT,
	IndexConstraintOp.GE,
];

/**
 * Index entries per row-resolution batch: the scan arms below collect up to this many
 * surviving index entries (or multi-seek point keys) and resolve them with ONE
 * {@link StoreTableBase.readEffectiveRowsByKeys} call, so an indexed read of N rows
 * costs on the order of N / 256 store round trips instead of N serialized point reads
 * (on IndexedDB, one readonly transaction instead of N). This is the bound
 * {@link KVStore.getMany}'s "bounded by the caller" note refers to.
 *
 * 256 matches the iterate pager's default page (`paged-iterate.ts` DEFAULT_BATCH_SIZE)
 * and makes the same trade that pager already makes and the {@link KVStore.iterate}
 * contract documents: a little early-termination cost for throughput — `limit 1`
 * collects one batch rather than one row — while keeping peak memory independent of
 * the range size.
 *
 * NOTE: that early-termination cost is bounded but not free — `limit 1` deserializes up
 * to 256 rows to yield one, and holds them all at once. It is charged against ROUND
 * TRIPS, which is what dominates on the backends this exists for (the index side already
 * pages 256 entries per read, so a stopped scan costs one data round trip either way),
 * so it is accepted as-is. Revisit if a `limit`-shaped query (a correlated `EXISTS`, a
 * semi-join probe) shows up in a profile as row-decode or allocation cost: the fix is a
 * SMALLER FIRST batch that ramps toward this bound, which keeps a drain's round-trip
 * count within a log factor while making a stopped scan cost ~one row again.
 */
export const ROW_RESOLUTION_BATCH = 256;

/**
 * Read-path layer of the generic KVStore-backed virtual table.
 *
 * Every arm below reads the EFFECTIVE row state (see
 * {@link StoreTableBase.iterateEffective}), so a byte window narrowed here still
 * honors read-your-own-writes.
 */
export abstract class StoreTableScan extends StoreTableBase {
	/**
	 * Query the table with optional filters.
	 *
	 * All three access arms read the EFFECTIVE row state: the committed store
	 * merged with this table's coordinator's pending ops when a transaction is
	 * active (read-your-own-writes — see {@link iterateEffective} /
	 * {@link readLiveRowByPk}). Merged emission stays in encoded key order (reversed for
	 * a backwards walk), preserving the module's `providesOrdering` / `monotonicOn`
	 * advertisements.
	 */
	async *query(filterInfo: FilterInfo): AsyncIterable<Row> {
		const store = await this.ensureStore();

		// Multi-seek (`plan=5`, an IN-list served as N point seeks) dispatches FIRST —
		// before analyzePKAccess: the FilterInfo carries N*W EQ constraints, so on a
		// table whose PK column is also the leading column of the chosen index,
		// analyzePKAccess would match the FIRST equality and answer a single-value
		// point lookup — one list value's rows, a silent wrong result.
		const idxSpec = decodeIdxStr(filterInfo.idxStr);
		if (idxSpec && planKindFromCode(idxSpec.plan) === 'multiSeek') {
			yield* this.scanMultiSeek(idxSpec, filterInfo);
			return;
		}

		// A backwards walk (`reverse=1`, stamped from the plan's reversed descriptor) iterates
		// the same byte window with `reverse: true`. Windows are `[gte, lt)` ranges, so the
		// result is the exact reverse of the forward read — the order the isolation overlay
		// merges a reversed scan in. A PK point lookup yields one row and ignores it.
		const reverse = idxStrWalksReverse(idxSpec);
		const pkAccess = this.analyzePKAccess(filterInfo);

		if (pkAccess.type === 'point') {
			const row = await this.readLiveRowByPk(pkAccess.values);
			if (row && this.matchesFilters(row, filterInfo, this.resolveFilterCollations(filterInfo))) {
				yield row;
			}
			return;
		}

		if (pkAccess.type === 'range') {
			yield* this.scanPKRange(store, pkAccess, filterInfo, reverse);
			return;
		}

		// Secondary-index scan arm — reached when the predicate did not resolve to a PK
		// point, and the plan did not name `_primary_` for a PK window (see
		// {@link analyzePKAccess}, which never builds a window under a plan naming a
		// secondary index). When the planner chose a secondary index (idxStr carries
		// `idx=<name>(…)`), derive its byte window and iterate it instead of full-scanning.
		const indexAccess = this.analyzeIndexAccess(filterInfo);
		if (indexAccess) {
			const indexStore = await this.ensureIndexStore(indexAccess.index.name);
			yield* this.scanIndex(indexStore, indexAccess, filterInfo, reverse);
			return;
		}

		// Full table scan — also the arm an ordering-only `_primary_` walk lands on, since
		// `resolveIndexFromIdxStr` answers null for `_primary_`.
		const collations = this.resolveFilterCollations(filterInfo);
		const bounds = buildFullScanBounds();
		for await (const entry of this.iterateEffective(store, bounds, reverse)) {
			const row = deserializeRow(entry.value);
			if (this.matchesFilters(row, filterInfo, collations)) {
				yield row;
			}
		}
	}

	/**
	 * True when a byte window bounded on PK member `position` reproduces the comparator's
	 * order — the precondition a bound in {@link buildPKRangeBounds} needs, and the exact
	 * condition `computeBestAccessPlan` (store-module-access-plan.ts) uses before claiming
	 * the range filters handled (`pkOrderPreservingPrefix > position`). When false, the
	 * bound is not windowed: the leading-member range degrades to a full scan, and a prefix
	 * window's trailing bound to the plain prefix, with `matchesFilters` as the residual.
	 */
	protected pkRangeAtPositionIsOrderSafe(position: number): boolean {
		return pkOrderPreservingPrefixLength(
			this.db,
			this.tableSchema!,
			this.pkKeyCollations,
			this.encodeOptions.collation ?? 'NOCASE',
		) > position;
	}

	/**
	 * True when some PK member's logical type carries semantic ordering (TIMESPAN,
	 * JSON) — the gate {@link scanMultiSeekPrimary} declines on.
	 *
	 * A primary-key multi-seek merges N byte windows with the residual Filter already
	 * dropped, and has no degradation available: a window that under-fetches loses rows
	 * outright, and falling back to the scan arm would AND N mutually-exclusive
	 * equalities to zero rows. So it fails loudly instead. Re-opening it is backlog
	 * `feat-store-semantic-key-multiseek`.
	 *
	 * NOT a gate on the single-value point arm any more: both types' key transforms (see
	 * {@link storeSemanticKeyTransform}) make byte equality exactly the type's equality
	 * ('PT1H' and 'PT60M' land on one key), so {@link analyzePKAccess} admits a point
	 * window per PROBE ({@link semanticProbeIsKeyFaithful}) rather than declining per
	 * schema. A single point window CAN degrade to the scan arm; N merged ones cannot.
	 */
	protected pkHasSemanticOrderingMember(): boolean {
		const schema = this.tableSchema!;
		return schema.primaryKeyDefinition.some(def =>
			hasSemanticOrdering(schema.columns[def.index]?.logicalType));
	}

	/**
	 * Analyze filter info to determine the PK access pattern. Three shapes, in the order
	 * they are tried:
	 *
	 *  - a full-key equality → a `point` read (whatever index the plan named: it yields at
	 *    most one row, so it cannot contradict any ordering claim);
	 *  - when the idxStr names `_primary_`, a leading-prefix equality → a `range` window
	 *    over the rows sharing that prefix, bounded on the next member when the plan is a
	 *    `prefixRangeSeek` ({@link pkPrefixWindow});
	 *  - when the idxStr names no secondary index, a bound on the leading member → a
	 *    `range` window with an empty prefix.
	 *
	 * Otherwise `scan`, which {@link query} reads as "not a PK access" and hands to the
	 * secondary-index arm, else the full scan.
	 *
	 * The two window arms are gated on the idxStr because {@link query} tries this before
	 * the secondary-index arm. Ungated, a plan that chose `ic (a, c desc)` for
	 * `where a = 2 order by c` over `primary key (a, b)` would be served from the primary
	 * key window in `b` order after the Sort was dropped. The leading-range gate is "not a
	 * secondary index" rather than "is `_primary_`", so a FilterInfo built without an index
	 * name keeps its range window.
	 */
	protected analyzePKAccess(filterInfo: FilterInfo): PKAccessPattern {
		const schema = this.tableSchema!;
		const pk = schema.primaryKeyDefinition;

		if (pk.length === 0) {
			return { type: 'scan' };
		}

		const eqRun = this.pkEqualityRun(filterInfo);

		// A full-PK equality is a point window, provided every probe has a faithful byte
		// position under its column's type — an unfaithful one declines the point arm here
		// ({@link semanticProbeIsKeyFaithful} states why, per arm); under a `_primary_` plan
		// it then lands on the prefix window cut short at that probe.
		//
		// Declining at RUNTIME is safe even though `computeBestAccessPlan`'s
		// full-PK-equality arm (store-module-access-plan.ts) already claimed the filters
		// handled and the engine dropped the residual Filter: a wider window or
		// `{ type: 'scan' }` still applies {@link matchesFilters}, which ANDs each pushed
		// constraint under the column's real comparator. The plan's claim is about which
		// FILTERS the module honours, not about which physical arm serves them.
		//
		// NOTE: for a TIMESPAN member the gate parses the probe (`groupKey`) and
		// `encodeDataKey`'s transform then parses it again — two duration parses per SEEK,
		// not per scanned row. `query()` runs once per seek, so a nested-loop join driving
		// N point lookups pays it N times. Fine now; if a point-lookup-heavy TIMESPAN-keyed
		// workload ever shows it, have the gate hand its parsed value back so the encode
		// can reuse it.
		if (eqRun.length === pk.length && eqRun.every((v, i) =>
			semanticProbeIsKeyFaithful(schema.columns[pk[i].index]?.logicalType, v))) {
			return { type: 'point', values: eqRun };
		}

		const spec = decodeIdxStr(filterInfo.idxStr);
		if (spec && spec.indexName.toLowerCase() === '_primary_') {
			const window = this.pkPrefixWindow(filterInfo, eqRun);
			if (window) return window;
		}

		if (this.resolveIndexFromIdxStr(filterInfo.idxStr) !== null) return { type: 'scan' };

		// A range window is only sound when the leading PK column's key bytes order the way
		// its comparator does; otherwise fall through to the full scan, where matchesFilters
		// applies the range under the real comparator.
		const rangeConstraints = this.rangeConstraintsOn(filterInfo, pk[0].index);
		if (rangeConstraints.length > 0 && this.pkRangeAtPositionIsOrderSafe(0)) {
			return { type: 'range', prefixValues: [], constraints: rangeConstraints };
		}

		return { type: 'scan' };
	}

	/**
	 * The values of the leading run of primary-key members that carry a pushed EQ, in
	 * primary-key order: per member the FIRST EQ on its column, ending the run at a
	 * member with none (or with an unbound one).
	 */
	private pkEqualityRun(filterInfo: FilterInfo): SqlValue[] {
		const values: SqlValue[] = [];
		for (const member of this.tableSchema!.primaryKeyDefinition) {
			const eq = filterInfo.constraints?.find(
				c => c.constraint.iColumn === member.index && c.constraint.op === IndexConstraintOp.EQ);
			if (!eq || eq.argvIndex <= 0) break;
			values.push(filterInfo.args[eq.argvIndex - 1]);
		}
		return values;
	}

	/**
	 * The primary-key prefix window for a `_primary_` plan whose leading members carry an
	 * equality (`pkPrefixPlan` in store-module-access-plan.ts), or null when no member
	 * does. `eqRun` is {@link pkEqualityRun}'s output.
	 *
	 * The run is cut at the first probe with no faithful byte position under its member's
	 * logical type ({@link semanticProbeIsKeyFaithful}), the widening
	 * {@link analyzeIndexAccess} makes: the shorter prefix is a superset, and
	 * {@link matchesFilters} re-checks the dropped equality under the type's own compare.
	 * Rows equal under that compare share transformed key bytes, so they stay one
	 * contiguous run of the primary-key walk and the plan's ordering claim survives the
	 * widening. (A secondary index cut to nothing falls back to the data store instead,
	 * which is why {@link analyzeIndexAccess} carries an ordering NOTE and this does not.)
	 *
	 * A `prefixRangeSeek` adds its LT/LE/GT/GE bounds on member `prefixLen` (read from the
	 * idxStr, as {@link prefixRangeSeekLength} does for an index). They are dropped, leaving
	 * the plain prefix window, when an unfaithful probe cut the run shorter than
	 * `prefixLen` (the bound then belongs to a member the window no longer reaches) or when
	 * that member's key bytes do not order like its comparator (the planner degrades the
	 * same way).
	 */
	private pkPrefixWindow(filterInfo: FilterInfo, eqRun: readonly SqlValue[]): PKAccessPattern | null {
		const schema = this.tableSchema!;
		const pk = schema.primaryKeyDefinition;
		let runLength = 0;
		while (runLength < eqRun.length
			&& semanticProbeIsKeyFaithful(schema.columns[pk[runLength].index]?.logicalType, eqRun[runLength])) {
			runLength++;
		}
		if (runLength === 0) return null;

		const prefixLen = this.pkPrefixRangeSeekLength(filterInfo);
		if (prefixLen !== null && prefixLen <= runLength && this.pkRangeAtPositionIsOrderSafe(prefixLen)) {
			return {
				type: 'range',
				prefixValues: eqRun.slice(0, prefixLen),
				constraints: this.rangeConstraintsOn(filterInfo, pk[prefixLen].index),
			};
		}
		return { type: 'range', prefixValues: eqRun.slice(0, runLength), constraints: [] };
	}

	/**
	 * The prefix length a `_primary_` `prefixRangeSeek` (`plan=7`) FilterInfo declares, or
	 * null when this FilterInfo is not one. The primary-key twin of
	 * {@link prefixRangeSeekLength}, loud for the same reason: a value outside
	 * `1 … pk.length - 1` cannot describe a window over this key.
	 */
	private pkPrefixRangeSeekLength(filterInfo: FilterInfo): number | null {
		const spec = decodeIdxStr(filterInfo.idxStr);
		if (!spec || planKindFromCode(spec.plan) !== 'prefixRangeSeek') return null;
		const pkLength = this.tableSchema!.primaryKeyDefinition.length;
		const raw = spec.params.get('prefixLen');
		const prefixLen = Number.parseInt(raw ?? '', 10);
		if (!Number.isInteger(prefixLen) || prefixLen < 1 || prefixLen >= pkLength) {
			this.malformedFilterInfo('primary-key prefix-range seek', filterInfo,
				`prefixLen=${raw} against the ${pkLength}-column primary key`);
		}
		return prefixLen;
	}

	/**
	 * Convert a primary-key window access into one seek + early-terminate iterate window:
	 * the rows whose leading members equal `prefixValues`, further bounded by the
	 * LT/LE/GT/GE `constraints` on the member right after them. An empty prefix is the
	 * leading-member range; empty constraints are the plain prefix window.
	 *
	 * Every value is encoded under the SAME per-column DESC directions and key collations
	 * as the data keys (via {@link encodePkPrefixBounds}); the bound arithmetic is
	 * {@link foldRangeWindow}'s, shared with the secondary-index windows, whose doc comment
	 * carries the op/direction table and the widen-don't-decline rules (a NULL or
	 * unfaithful semantic bound value is skipped, which only widens the window).
	 *
	 * NOTE: a bounded window over a text PK member is sound only when the member's key
	 * normalizer is ORDER-preserving with respect to its comparator — i.e. the comparator
	 * orders two strings the way memcmp orders their normalized bytes. That is NOT implied
	 * by `db.registerCollation`'s normalizer contract, which promises only an equality
	 * partition, and a built-in NAME may be re-registered with a comparator + normalizer
	 * pair that preserves equality while inverting order. A bound therefore only ever
	 * reaches here under {@link pkRangeAtPositionIsOrderSafe} at its member's position —
	 * enforced by {@link analyzePKAccess} here and mirrored by `computeBestAccessPlan`
	 * (store-module-access-plan.ts) before it claims the range filters handled. A
	 * collation without the `orderPreserving` assertion costs the seek, never a row.
	 */
	protected buildPKRangeBounds(access: PKWindowAccess): IterateOptions {
		const position = access.prefixValues.length;
		const schema = this.tableSchema!;
		const boundType = schema.columns[schema.primaryKeyDefinition[position]?.index]?.logicalType;
		return foldRangeWindow(
			access.prefixValues,
			access.constraints,
			this.pkDirections[position] ?? false,
			boundType,
			values => this.encodePkPrefixBounds(values),
		);
	}

	/**
	 * Scan a primary-key window, seeking to the window start and early-terminating at its
	 * end.
	 *
	 * {@link buildPKRangeBounds} converts the prefix and its bounds into one encoded-byte
	 * `gte`/`lt` window under the same per-column DESC directions and key collations the
	 * data keys use, so the iterate visits a SUPERSET of the qualifying rows (a collation
	 * widening or the bound-byte increment can over-fetch, never under-fetch).
	 * {@link matchesFilters} stays the authoritative collation-aware row filter.
	 * {@link iterateEffective} restricts the pending merge to the same `bounds`, so
	 * read-your-own-writes holds on the narrowed window.
	 */
	protected async *scanPKRange(
		store: KVStore,
		access: PKWindowAccess,
		filterInfo: FilterInfo,
		reverse: boolean,
	): AsyncIterable<Row> {
		const collations = this.resolveFilterCollations(filterInfo);
		const bounds = this.buildPKRangeBounds(access);
		for await (const entry of this.iterateEffective(store, bounds, reverse)) {
			const row = deserializeRow(entry.value);
			if (this.matchesFilters(row, filterInfo, collations)) {
				yield row;
			}
		}
	}

	/**
	 * Resolve the secondary index chosen by the planner from `filterInfo.idxStr`.
	 *
	 * The planner emits `idx=<name>(<n>);plan=…` when its access plan set both an
	 * `indexName` and `seekColumnIndexes` (see `getBestAccessPlan` and
	 * rule-select-access-path.ts). Decoding goes through the engine's shared
	 * `decodeIdxStr`, so the store, the in-memory vtab, and the isolation overlay all
	 * read one format. Returns null for the PK/scan sentinels (`_primary_`, `fullscan`,
	 * `empty`), an idxStr that names no index, or a name absent from `schema.indexes` —
	 * every one of which routes back to a PK/full-scan arm.
	 */
	protected resolveIndexFromIdxStr(idxStr: string | null): TableIndexSchema | null {
		const spec = decodeIdxStr(idxStr);
		if (!spec) return null;
		const name = spec.indexName;
		if (!name || name === '_primary_') return null;
		const indexes = this.tableSchema?.indexes ?? [];
		return indexes.find(i => i.name.toLowerCase() === name.toLowerCase()) ?? null;
	}

	/**
	 * Analyze filter info to determine a secondary-index access pattern, mirroring
	 * {@link analyzePKAccess} but over the index chosen in `idxStr`.
	 *
	 * Three window shapes, in the order they are tried:
	 *
	 *  - a contiguous leading-prefix EQ plus a LT/LE/GT/GE bound on the NEXT index column
	 *    (the `prefixRangeSeek` / `plan=7` plan) — one `range` window covering just the
	 *    bounded slice INSIDE the prefix;
	 *  - a contiguous leading-prefix EQ alone → a `point` window (the prefix covers every
	 *    entry sharing those leading values — an index seek is a PREFIX scan, not a single
	 *    row, since the index need not be unique and the PK suffix varies);
	 *  - otherwise a range (LT/LE/GT/GE) on the LEADING index column → a `range` window.
	 *
	 * Returns null when none applies or when the index is unresolved.
	 * {@link matchesFilters} stays the authoritative row filter, so the window need only be
	 * a SUPERSET — which is why every degraded path below WIDENS (a prefix-range that
	 * cannot narrow falls back to the prefix window, a prefix that cannot encode a member
	 * stops short) rather than declining outright.
	 *
	 * Index-column bytes are encoded under each column's own key collation
	 * ({@link indexKeyCollations}); {@link matchesFilters} re-checks a fetched row under the
	 * index column's `COLLATE` else the table column's declared collation. The EQ/prefix
	 * window is EXACTLY the qualifying set when those two agree, which
	 * {@link indexPrefixSeekIsCollationExact} decides; a RANGE window additionally equates
	 * memcmp of the key bytes with the residual's comparison ORDER at the bounded column's
	 * position, which {@link indexRangeIsOrderSafe} decides. `tryIndexAccessPlan`
	 * (store-module-access-plan.ts) consults the SAME two predicates, at the same positions,
	 * before claiming the filters handled, so the two decisions cannot disagree. An EQ-prefix
	 * failure returns null and the caller full-scans, where the residual is authoritative.
	 */
	protected analyzeIndexAccess(filterInfo: FilterInfo): IndexAccessPattern | null {
		const index = this.resolveIndexFromIdxStr(filterInfo.idxStr);
		if (!index) return null;

		// An ordering-only walk (`plan=0`): the planner chose this index for its EMISSION
		// ORDER (`chooseOrderingPlan`, store-module-access-plan.ts) and pushed no window at
		// all. There is nothing to derive — walk the index store end to end. Index stores
		// are per-index, so an unbounded `buildFullScanBounds()` is exactly this index's
		// entries and nothing else. Gated on the DECODED PLAN KIND, not on an absence of
		// constraints: an explicit `plan=0` is the planner stating its intent (the Sort is
		// already deleted on the strength of this walk's order), and reading it explicitly
		// keeps a plan/scan disagreement loud — falling through to the constraint arms
		// below would degrade to a DATA-store scan in primary-key order, a silent
		// wrong-order answer. (A `plan=0` naming `_primary_` never reaches here:
		// `resolveIndexFromIdxStr` returns null for it and the caller full-scans the data
		// store, which IS the advertised primary-key order.)
		const spec = decodeIdxStr(filterInfo.idxStr);
		if (spec && planKindFromCode(spec.plan) === 'scan') {
			return { index, type: 'range', bounds: buildFullScanBounds() };
		}

		const indexCols = index.columns.map(c => c.index);
		const indexDirections = index.columns.map(c => !!c.desc);
		const indexCollations = this.indexKeyCollations(index);

		// Contiguous leading-prefix EQ → point/prefix window. A member whose PROBE has no
		// faithful byte position under its logical type ({@link semanticProbeIsKeyFaithful}
		// — a numeric or unparseable TIMESPAN probe, a blob/bigint JSON probe) STOPS the
		// prefix here, the widening that arm can afford; the shorter window is a strict
		// SUPERSET and {@link matchesFilters} re-checks the dropped column under the type's
		// own compare. Stopping at position 0 leaves `eqValues` empty and falls through to
		// the range arm below.
		const eqValues: SqlValue[] = [];
		for (let i = 0; i < indexCols.length; i++) {
			const eq = filterInfo.constraints?.find(
				c => c.constraint.iColumn === indexCols[i]
					&& c.constraint.op === IndexConstraintOp.EQ
					&& c.argvIndex > 0,
			);
			if (!eq) break;
			const value = filterInfo.args[eq.argvIndex - 1];
			if (!semanticProbeIsKeyFaithful(this.tableSchema!.columns[indexCols[i]]?.logicalType, value)) break;
			eqValues.push(value);
		}
		if (eqValues.length > 0) {
			// Decline rather than fall through to the range arm: an EQ prefix whose key
			// collation differs from the residual's comparison collation would under-fetch,
			// and the planner declined the same shape, so the residual Filter is still there.
			if (!indexPrefixSeekIsCollationExact(this.tableSchema!.columns, index, indexCollations, eqValues.length)) {
				return null;
			}

			// Prefix-equality + trailing-range. `prefixLen` comes from the idxStr rather
			// than being re-inferred from the constraint list, so a plan that meant a
			// different prefix length is caught instead of silently windowing the wrong
			// columns. `prefixLen > eqValues.length` means an unfaithful semantic probe cut
			// the prefix short above; the bound then belongs to a column the window no
			// longer reaches, so it is dropped and the shorter prefix window (a strict
			// superset) serves — {@link matchesFilters} still applies it.
			const prefixLen = this.prefixRangeSeekLength(filterInfo, index);
			if (prefixLen !== null && prefixLen <= eqValues.length) {
				const bounds = this.buildPrefixRangeWindow(filterInfo, index, eqValues.slice(0, prefixLen));
				if (bounds) return { index, type: 'range', bounds };
			}

			const bounds = buildIndexPrefixBounds(
				eqValues,
				this.encodeOptions,
				indexDirections.slice(0, eqValues.length),
				indexCollations.slice(0, eqValues.length),
				this.indexKeyTransforms(index).slice(0, eqValues.length),
			);
			return { index, type: 'point', bounds };
		}

		// Else a range on the LEADING index column.
		const leadingCol = indexCols[0];
		const rangeConstraints = this.rangeConstraintsOn(filterInfo, leadingCol);
		if (rangeConstraints.length > 0 && this.indexRangeIsOrderSafe(index, 0)) {
			const bounds = this.buildIndexRangeBounds(
				[],
				rangeConstraints,
				indexDirections.slice(0, 1),
				indexCollations.slice(0, 1),
				this.tableSchema!.columns[leadingCol]?.logicalType,
				this.indexKeyTransforms(index).slice(0, 1),
			);
			return { index, type: 'range', bounds };
		}

		// NOTE: a null here makes `query()` scan the DATA store in primary-key order. That is
		// the right row set, but if the plan claimed this index's ordering (forwards or
		// backwards) the Sort is already gone and the order is wrong. The planner gates on
		// the same collation predicates, so the one known way here under a claim is an
		// unfaithful semantic probe on the leading eq column (`semanticProbeIsKeyFaithful`
		// above), which the planner cannot see. If such a probe can ever match a row, the
		// planner must stop claiming order through a pinned semantic-ordering column.
		return null;
	}

	/**
	 * The prefix length a `prefixRangeSeek` (`plan=7`) FilterInfo declares, or null when
	 * this FilterInfo is not one.
	 *
	 * Honoring the plan's own `prefixLen` — rather than re-deriving it from the constraint
	 * list — is what makes a plan/scan disagreement LOUD: a value outside `1 …
	 * index.columns.length - 1` cannot describe a window over this index, and the plan
	 * already dropped the residual for the filters it claimed, so guessing a length would
	 * silently address the wrong columns.
	 */
	private prefixRangeSeekLength(filterInfo: FilterInfo, index: TableIndexSchema): number | null {
		const spec = decodeIdxStr(filterInfo.idxStr);
		if (!spec || planKindFromCode(spec.plan) !== 'prefixRangeSeek') return null;
		const raw = spec.params.get('prefixLen');
		const prefixLen = Number.parseInt(raw ?? '', 10);
		if (!Number.isInteger(prefixLen) || prefixLen < 1 || prefixLen >= index.columns.length) {
			this.malformedFilterInfo('prefix-range seek', filterInfo,
				`prefixLen=${raw} against ${index.name}'s ${index.columns.length} columns`);
		}
		return prefixLen;
	}

	/** The pushed LT/LE/GT/GE constraints on `columnIndex`, paired with their bound values. */
	private rangeConstraintsOn(
		filterInfo: FilterInfo,
		columnIndex: number,
	): RangeBound[] {
		return (filterInfo.constraints ?? [])
			.filter(c => c.constraint.iColumn === columnIndex && RANGE_CONSTRAINT_OPS.includes(c.constraint.op))
			.map(c => ({
				op: c.constraint.op,
				value: c.argvIndex > 0 ? filterInfo.args[c.argvIndex - 1] : undefined,
			}));
	}

	/**
	 * The narrowed window for a prefix-equality + trailing-range seek: the equality prefix
	 * bytes, further bounded by the LT/LE/GT/GE constraints on the index column right after
	 * it. Null when the trailing bound cannot be used, in which case the caller falls back
	 * to the plain prefix window — a strict SUPERSET, so the answer is unchanged and only
	 * the narrowing is lost. Two reasons for that:
	 *
	 *  - the trailing column's key bytes do not reproduce its residual comparator's ORDER
	 *    ({@link indexRangeIsOrderSafe}) — `tryIndexAccessPlan` degrades to the plain prefix
	 *    seek through the same predicate, so this is the matching scan-side move rather than
	 *    a disagreement;
	 *  - no bound constraint survived on that column at all (nothing to narrow with).
	 */
	private buildPrefixRangeWindow(
		filterInfo: FilterInfo,
		index: TableIndexSchema,
		prefixValues: SqlValue[],
	): IterateOptions | null {
		const position = prefixValues.length;
		const trailingCol = index.columns[position]?.index;
		if (trailingCol === undefined) return null;
		if (!this.indexRangeIsOrderSafe(index, position)) return null;

		// NOTE: a `plan=7` with NO bound on the trailing column is as structurally impossible
		// as a bad `prefixLen` — `rule-select-access-path` only emits the plan once it has
		// found a lower or upper bound, and `seekColumns` is advertised in index-column
		// order, so `index.columns[prefixLen]` IS the column the rule bounded. It stays SOFT
		// anyway because the two impossibilities fail differently: a wrong `prefixLen` would
		// address the wrong columns (an under-fetch, a wrong answer), while a missing bound
		// only fails to narrow. If a plan source ever does hand this over, the symptom is a
		// slow query, not a wrong one — make it loud only if that silence starts hiding a
		// real disagreement.
		const rangeConstraints = this.rangeConstraintsOn(filterInfo, trailingCol);
		if (rangeConstraints.length === 0) return null;

		const width = position + 1;
		return this.buildIndexRangeBounds(
			prefixValues,
			rangeConstraints,
			index.columns.slice(0, width).map(c => !!c.desc),
			this.indexKeyCollations(index).slice(0, width),
			this.tableSchema!.columns[trailingCol]?.logicalType,
			this.indexKeyTransforms(index).slice(0, width),
		);
	}

	/**
	 * Lazy cache behind {@link indexKeyCollations}: one resolved array per index-schema
	 * object, invalidated when the column array it was resolved against is replaced (an
	 * ALTER can retype a column without minting new index objects, so the index identity
	 * alone is not a safe key).
	 */
	private readonly indexKeyCollationsCache = new WeakMap<
		TableIndexSchema,
		{ columns: ReadonlyArray<ColumnSchema>; collations: (string | undefined)[] }
	>();

	/**
	 * Per-column KEY collation for `index`'s own columns, memoized — see
	 * {@link resolveIndexKeyCollations}. The one resolution every scan-side encode site
	 * ({@link analyzeIndexAccess}, {@link buildIndexRangeBounds}, {@link scanMultiSeek})
	 * threads into `buildIndexPrefixBounds`, so a scan window can never address
	 * different bytes than the maintenance writes.
	 */
	protected indexKeyCollations(index: TableIndexSchema): (string | undefined)[] {
		const columns = this.tableSchema!.columns;
		const cached = this.indexKeyCollationsCache.get(index);
		if (cached && cached.columns === columns) return cached.collations;
		const collations = resolveIndexKeyCollations(index, columns);
		this.indexKeyCollationsCache.set(index, { columns, collations });
		return collations;
	}

	/**
	 * Lazy cache behind {@link indexKeyTransforms} — the transform twin of
	 * {@link indexKeyCollationsCache}, with the same columns-identity invalidation rule
	 * (an ALTER can retype a column without minting new index objects).
	 */
	private readonly indexKeyTransformsCache = new WeakMap<
		TableIndexSchema,
		{ columns: ReadonlyArray<ColumnSchema>; transforms: (KeyValueTransform | undefined)[] }
	>();

	/**
	 * Per-column key VALUE TRANSFORM for `index`'s own columns, memoized — see
	 * {@link resolveIndexKeyTransforms}. Threaded, like {@link indexKeyCollations},
	 * into every scan-side `buildIndexPrefixBounds` call ({@link analyzeIndexAccess},
	 * {@link buildIndexRangeBounds}, {@link scanMultiSeek}) so a scan window addresses
	 * the same TRANSFORMED bytes `buildIndexKey` wrote for a semantic-ordering column.
	 * The point/multi-seek callers only ever see `undefined` entries today (their arms
	 * still decline semantic-ordering prefixes), but threading all three uniformly is
	 * the point — an arm re-opened later cannot silently address raw-value bytes.
	 */
	protected indexKeyTransforms(index: TableIndexSchema): (KeyValueTransform | undefined)[] {
		const columns = this.tableSchema!.columns;
		const cached = this.indexKeyTransformsCache.get(index);
		if (cached && cached.columns === columns) return cached.transforms;
		const transforms = resolveIndexKeyTransforms(index, columns);
		this.indexKeyTransformsCache.set(index, { columns, transforms });
		return transforms;
	}

	/**
	 * Per-column comparators stating the store's actual index-key BYTE order for
	 * `indexName` — the `VirtualTable.getIndexComparator` isolation hook, mirroring
	 * `MemoryTable.getIndexComparator`. The isolation layer merges the overlay's pending
	 * rows against this table's index scan by `(indexKey, PK)` sort key and prefers these
	 * over its descriptor-derived fallback, so each column's comparator must reproduce
	 * the order {@link scanIndex} emits in:
	 *   - the column's KEY collation ({@link indexKeyCollations}: index COLLATE, else the
	 *     table column's declared collation, else BINARY) for text;
	 *   - the logical type's `compare` for a semantic-ordering column (its key bytes
	 *     encode through an order-preserving transform — see `storeSemanticKeyTransform`);
	 *   - negated for a DESC column (its key bytes are bit-inverted).
	 * Resolved against the MATERIALIZED schema so a hidden `_uc_*` name resolves too.
	 *
	 * NOTE: for a text column this states the COMPARATOR's order, which is the byte order
	 * only while the collation's key normalizer preserves order (`_isCollationOrderPreserving`
	 * — asserted by the built-ins, opt-in for a custom one; see keyOrderMatchesCollation).
	 * Under an equality-only custom collation the emitted byte order and this comparator can
	 * disagree, misplacing an overlay row within an index-key-equal group. Same exposure the
	 * isolation layer's descriptor fallback carried before this method existed, so nothing
	 * regressed; if a custom equality-only collation on an INDEX column ever ships, gate this
	 * on the assertion (returning undefined declines to the fallback, which is no better —
	 * the real fix is to make the store emit in comparator order or the merge tolerate it).
	 */
	getIndexComparator(indexName: string): CompareFn[] | undefined {
		const schema = this.materializedSchema;
		const index = schema.indexes?.find(ix => ix.name.toLowerCase() === indexName.toLowerCase());
		if (!index) return undefined;
		const keyCollations = this.indexKeyCollations(index);
		return index.columns.map((col, i) => {
			const columnSchema = schema.columns[col.index];
			const name = keyCollations[i];
			const collationFunc = name ? this.collationResolver(name) : undefined;
			const typedComparator = createTypedComparator(columnSchema.logicalType, collationFunc);
			return col.desc
				? (a: SqlValue, b: SqlValue): number => -typedComparator(a, b)
				: typedComparator;
		});
	}

	/**
	 * True when a byte window bounded on index column `position` reproduces the order the
	 * residual comparison uses there. Delegates to {@link indexRangeAtPositionIsOrderSafe} —
	 * the SAME call `tryIndexAccessPlan` (store-module-access-plan.ts) makes, at the same
	 * position, before it marks the range filters handled, so the "build a window" and "mark
	 * handled" decisions cannot disagree. The memoized {@link indexKeyCollations} is passed
	 * as the key side, so the predicate judges the bytes this scan actually addresses.
	 *
	 * `position` is 0 for a standalone leading-column range and the prefix length for a
	 * prefix-equality + trailing-range window.
	 */
	protected indexRangeIsOrderSafe(index: TableIndexSchema, position: number): boolean {
		return indexRangeAtPositionIsOrderSafe(
			this.db, this.tableSchema!.columns, index, this.indexKeyCollations(index), position);
	}

	/**
	 * Convert LT/LE/GT/GE constraints on ONE index column into a single encoded-byte
	 * `gte`/`lt` window, optionally nested inside a fixed equality prefix — the
	 * secondary-index analogue of {@link buildPKRangeBounds}, over the same
	 * {@link foldRangeWindow}.
	 *
	 * The bounded column sits at position `prefixValues.length`; `directions`,
	 * `collations` and `transforms` are the index's own per-column arrays sliced to cover
	 * the prefix AND that column. An empty `prefixValues` is the standalone leading-column
	 * range; a non-empty one is the trailing bound of a `prefixRangeSeek`. Each value is
	 * encoded under its column's own key collation ({@link indexKeyCollations}), DESC
	 * direction and key value transform ({@link indexKeyTransforms}) — exactly as
	 * {@link buildIndexKey} encodes that column — via {@link buildIndexPrefixBounds}, so a
	 * surviving bound addresses the same transformed bytes the index store holds.
	 */
	protected buildIndexRangeBounds(
		prefixValues: readonly SqlValue[],
		constraints: readonly RangeBound[],
		directions: ReadonlyArray<boolean>,
		collations: ReadonlyArray<string | undefined>,
		logicalType: LogicalType | undefined,
		transforms: ReadonlyArray<KeyValueTransform | undefined>,
	): IterateOptions {
		return foldRangeWindow(
			prefixValues,
			constraints,
			directions[prefixValues.length] ?? false,
			logicalType,
			values => buildIndexPrefixBounds(
				values,
				this.encodeOptions,
				directions.slice(0, values.length),
				collations.slice(0, values.length),
				transforms.slice(0, values.length),
			),
		);
	}

	/**
	 * Scan a secondary index over `access.bounds`, resolving each index entry to its
	 * base row and re-filtering.
	 *
	 * One window of the producer/consumer pair below: {@link produceIndexEntries}
	 * walks the window's index entries and {@link resolveIndexEntries} resolves them
	 * to rows in {@link ROW_RESOLUTION_BATCH}-bounded batches — one
	 * {@link StoreTableBase.readEffectiveRowsByKeys} round trip per batch instead of
	 * one awaited point read per entry. A multi-seek runs the SAME consumer over the
	 * concatenation of every window's producer instead of calling this method — see
	 * {@link scanMultiSeek}.
	 */
	protected async *scanIndex(
		indexStore: KVStore,
		access: IndexAccessPattern,
		filterInfo: FilterInfo,
		reverse: boolean,
	): AsyncIterable<Row> {
		// Re-check each resolved row under the INDEX's per-column collation (see
		// matchesFilters): the planner dropped the residual based on the index
		// column's collation, which an explicit index `COLLATE` can make differ from
		// the table column's declared collation.
		const indexCollations = this.resolveFilterCollations(filterInfo, this.indexColumnCollations(access.index));
		yield* this.resolveIndexEntries(
			this.produceIndexEntries(indexStore, access.bounds, [filterInfo], reverse),
			indexCollations,
		);
	}

	/**
	 * Producer half of the index-scan pair: walk one byte window's index entries —
	 * {@link iterateEffective} yields the committed entries merged with this
	 * transaction's pending index puts/deletes (read-your-own-writes over the index),
	 * in index-key byte order (descending when `reverse`), the order the isolation
	 * overlay merge relies on (`isolated-table.ts` § buildSortKey) — and yield, per
	 * surviving entry, its data key plus the FilterInfos a resolved row may match.
	 * Entries stay in visit order end to end, so index-key order is preserved through the
	 * batching consumer.
	 *
	 * Only the defenses that need nothing but the entry itself run here, BEFORE the
	 * row read; everything row-dependent lives in {@link resolveRowBatch}.
	 */
	private async *produceIndexEntries(
		indexStore: KVStore,
		bounds: IterateOptions,
		infos: readonly FilterInfo[],
		reverse: boolean,
		seen?: Set<string>,
	): AsyncIterable<PendingIndexEntry> {
		for await (const entry of this.iterateEffective(indexStore, bounds, reverse)) {
			// NOTE: a legacy index store (written before index values carried the data
			// key) holds EMPTY values; a zero-length data key is not a row key, so skip
			// it rather than resolve it to the wrong row. Because the access plan marked
			// the filter handled and dropped the residual, an indexed query over such a
			// store returns NOTHING rather than the matching rows — a silent wrong
			// result, not an error. Backwards compatibility is waived project-wide
			// (AGENTS.md) and no test provider carries on-disk data, so nothing exercises
			// this today. If real persisted stores predating this format come into play,
			// their indexes must be dropped + recreated (or the table rebuilt); the
			// durable fix is to version-stamp the index store and rebuild on open, or to
			// fall back to a full scan the first time an empty value is seen. The
			// ordering-only walk (`plan=0`) shares this exposure: over such a store it
			// would return NOTHING for the whole table rather than a narrowed window's rows.
			if (entry.value.length === 0) continue;
			// Cross-window dedup for a multi-seek: a data key an EARLIER window already
			// YIELDED is skipped before the data-store read, so a duplicate costs no
			// extra point read. This is only a PRE-check — a duplicate inside one
			// not-yet-resolved batch is invisible to it and is caught by
			// {@link resolveRowBatch}'s post-read re-check. The seen-set is only ever
			// ADDED to on a yield (there) — adding at visit time would let a stale index
			// entry that fails its residual poison the set and suppress the row's live
			// entry in a later window.
			let dataKeyHex: string | undefined;
			if (seen) {
				dataKeyHex = bytesToHex(entry.value);
				if (seen.has(dataKeyHex)) continue;
			}
			yield { dataKey: entry.value, dataKeyHex, infos };
		}
	}

	/**
	 * Consumer half of the index-scan pair: collect up to {@link ROW_RESOLUTION_BATCH}
	 * produced entries and resolve each batch through {@link resolveRowBatch} — one
	 * store round trip per batch. Batching changes the round-trip count, never the row
	 * set or its order: batches are resolved and yielded in entry order.
	 *
	 * Early termination: a downstream `break` mid-batch finishes this generator, whose
	 * `for await` closes `entries` — and the iterate cursor under it — on the way out;
	 * no further batch is collected or read.
	 */
	private async *resolveIndexEntries(
		entries: AsyncIterable<PendingIndexEntry>,
		collations: ReadonlyMap<number, CollationFunction>,
		seen?: Set<string>,
	): AsyncIterable<Row> {
		let batch: PendingIndexEntry[] = [];
		for await (const entry of entries) {
			batch.push(entry);
			if (batch.length >= ROW_RESOLUTION_BATCH) {
				yield* this.resolveRowBatch(batch, collations, seen);
				batch = [];
			}
		}
		if (batch.length > 0) {
			yield* this.resolveRowBatch(batch, collations, seen);
		}
	}

	/**
	 * Resolve one bounded batch of index entries to rows — a single
	 * {@link StoreTableBase.readEffectiveRowsByKeys} call (which applies this
	 * transaction's pending deletes/puts BEFORE touching the committed store; the
	 * precedence is not re-implemented here) — then run the row-dependent defenses in
	 * entry order, mirroring the memory layer's live-recheck:
	 *
	 *  - a resolved-null row (the entry's row was deleted — a pending index delete
	 *    would normally suppress the entry, but a committed entry can lag) is skipped,
	 *    and cannot shift later positions (the read answers positionally);
	 *  - the multi-seek `seen` set is RE-checked after the read: the producer's
	 *    pre-check ran before this batch was collected, so two entries at one data key
	 *    inside a single batch (a stale index entry) are only caught here — without
	 *    the re-check the row would yield twice;
	 *  - a row is accepted when it matches ANY of the entry's FilterInfos (the byte
	 *    window is only a superset, and a stale entry whose indexed column no longer
	 *    matches is dropped), and `seen` is added to on yield ALONE — a stale entry
	 *    that fails its residual must not suppress the row's live entry later.
	 *
	 * NOTE: still one data-store point read per matched index entry — the row lives in
	 * the data store, not the index (the index value carries only the data key, no
	 * covering payload); batching collapses the reads' round trips, not their count.
	 * If index-covered scans ever dominate a profile, consider storing the serialized
	 * row as a covering index value, at the cost of an index rewrite on EVERY column
	 * change (not just indexed columns) — deliberately not done here.
	 */
	private async *resolveRowBatch(
		batch: readonly PendingIndexEntry[],
		collations: ReadonlyMap<number, CollationFunction>,
		seen?: Set<string>,
	): AsyncIterable<Row> {
		const rows = await this.readEffectiveRowsByKeys(batch.map(e => e.dataKey));
		for (let i = 0; i < batch.length; i++) {
			const row = rows[i];
			if (!row) continue;
			const { dataKeyHex, infos } = batch[i];
			if (seen && dataKeyHex !== undefined && seen.has(dataKeyHex)) continue;
			if (infos.some(fi => this.matchesFilters(row, fi, collations))) {
				if (seen && dataKeyHex !== undefined) seen.add(dataKeyHex);
				yield row;
			}
		}
	}

	/**
	 * Fail loudly on a structurally impossible FilterInfo — one whose own idxStr describes
	 * an access this table's schema cannot express. Not a soundness fallback: everything
	 * that is merely UNSERVEABLE degrades to a wider window plus the {@link matchesFilters}
	 * residual instead of raising. `kind` names the plan shape for the message.
	 */
	private malformedFilterInfo(kind: string, filterInfo: FilterInfo, why: string): never {
		throw new QuereusError(
			`Malformed ${kind} FilterInfo (idxStr '${filterInfo.idxStr}') on ${this.schemaName}.${this.tableName}: ${why}`,
			StatusCode.INTERNAL,
		);
	}

	/**
	 * Fail loudly on a multi-seek FilterInfo this table cannot serve. The plan already
	 * dropped the residual Filter, and {@link matchesFilters} ANDs every pushed
	 * constraint — so falling through to the scan arm would AND N mutually-exclusive
	 * equalities and return zero rows: a silent wrong answer, not a slow one.
	 */
	private multiSeekMalformed(filterInfo: FilterInfo, why: string): never {
		this.malformedFilterInfo('multi-seek', filterInfo, why);
	}

	/**
	 * Decode a multi-seek FilterInfo into its N seek tuples of width W. Tuple i pairs
	 * `args[i*W … i*W+W-1]` with the same slice of `constraints` (argvIndex runs
	 * 1…N*W in order — see rule-select-access-path's multiSeek emission). A tuple with
	 * a NULL/undefined component is dropped: IN is set membership and a NULL component
	 * matches nothing. The planner pre-reduces literal lists, but a parameter-bound /
	 * mixed-binding list reaches here unreduced, so this skip is the only line of
	 * defense for those.
	 */
	private decodeMultiSeekTuples(
		spec: IdxStrSpec,
		filterInfo: FilterInfo,
	): { tuples: MultiSeekTuple[]; seekWidth: number } {
		const seekWidth = Number.parseInt(spec.params.get('seekWidth') ?? '1', 10);
		const inCount = Number.parseInt(spec.params.get('inCount') ?? '0', 10);
		if (!Number.isInteger(seekWidth) || seekWidth < 1) {
			this.multiSeekMalformed(filterInfo, `seekWidth=${spec.params.get('seekWidth')}`);
		}
		if (!Number.isInteger(inCount) || inCount < 1) {
			this.multiSeekMalformed(filterInfo, `inCount=${spec.params.get('inCount')}`);
		}
		const constraints = filterInfo.constraints ?? [];
		if (constraints.length < inCount * seekWidth) {
			this.multiSeekMalformed(filterInfo, `${constraints.length} constraints for ${inCount}×${seekWidth} seek keys`);
		}
		if (filterInfo.args.length < inCount * seekWidth) {
			this.multiSeekMalformed(filterInfo, `${filterInfo.args.length} args for ${inCount}×${seekWidth} seek keys`);
		}

		const tuples: MultiSeekTuple[] = [];
		for (let t = 0; t < inCount; t++) {
			const entries = constraints.slice(t * seekWidth, (t + 1) * seekWidth);
			if (entries.some(e => e.constraint.op !== IndexConstraintOp.EQ || e.argvIndex <= 0)) {
				this.multiSeekMalformed(filterInfo, `seek tuple ${t} carries a non-EQ or unbound constraint`);
			}
			const values = entries.map(e => filterInfo.args[e.argvIndex - 1]);
			if (values.some(v => v === null || v === undefined)) continue;
			tuples.push({ entries, values });
		}
		return { tuples, seekWidth };
	}

	/**
	 * Order one tuple's values to match `keyCols` (the leading index columns, or the
	 * PK definition) using each constraint entry's column. The plan's seek columns and
	 * the constraint list must agree; a tuple that does not cover exactly those
	 * columns is malformed.
	 */
	private orderTupleValues(
		tuple: MultiSeekTuple,
		keyCols: readonly number[],
		filterInfo: FilterInfo,
	): SqlValue[] {
		const byCol = new Map<number, SqlValue>();
		tuple.entries.forEach((e, i) => byCol.set(e.constraint.iColumn, tuple.values[i]));
		if (byCol.size !== keyCols.length) {
			this.multiSeekMalformed(filterInfo, `seek tuple covers ${byCol.size} columns, expected ${keyCols.length}`);
		}
		return keyCols.map(colIdx => {
			if (!byCol.has(colIdx)) this.multiSeekMalformed(filterInfo, `seek tuple missing column ${colIdx}`);
			return byCol.get(colIdx)!;
		});
	}

	/**
	 * Serve a multi-seek (`plan=5`) FilterInfo: one point window per distinct
	 * IN-list tuple, scanned in ascending encoded-key order.
	 *
	 * Window order is not cosmetic. Encoded-byte order IS index-key order (per-column
	 * DESC inversion is baked into the bytes), and the isolation overlay merges an
	 * index scan with its pending rows by (indexKey, PK) — an out-of-order underlying
	 * stream misplaces overlay rows in the output. Two overlap hazards are folded
	 * away before scanning:
	 *   - Tuples whose encoded prefix byte-matches (duplicate bound parameters, or
	 *     case variants under a NOCASE key collation C) share ONE window, each kept
	 *     as a residual alternative — see {@link PendingIndexEntry}.
	 *   - A window with no finite upper bound (all-0xff prefix — see
	 *     buildIndexPrefixBounds) contains every later-sorting window outright (any
	 *     key ≥ an all-0xff prefix necessarily starts with it), so those windows fold
	 *     into it instead of re-scanning an overlapping range out of order.
	 *
	 * Emission is lazy and batched ACROSS windows: every window's
	 * {@link produceIndexEntries} feeds ONE {@link resolveIndexEntries} consumer, whose
	 * batches are bounded by ENTRY count, not window count — so a hundred single-row
	 * windows collapse into a single row-resolution round trip, and
	 * `… in (…) limit 1` materializes at most one {@link ROW_RESOLUTION_BATCH} batch
	 * rather than every window. Each window's entries still come from
	 * {@link iterateEffective}, so read-your-own-writes and the stale-entry /
	 * deleted-row defenses hold per seek key.
	 */
	protected async *scanMultiSeek(spec: IdxStrSpec, filterInfo: FilterInfo): AsyncIterable<Row> {
		// Neither the primary-key nor the secondary arm has a backwards mode (both sort their
		// windows ascending), and the access planner never claims a reverse multi-seek.
		// Serving one forwards would hand a reversed ordering claim ascending rows.
		if (idxStrWalksReverse(spec)) this.multiSeekMalformed(filterInfo, 'a multi-seek cannot walk backwards');
		const { tuples, seekWidth } = this.decodeMultiSeekTuples(spec, filterInfo);

		if (spec.indexName === '_primary_') {
			yield* this.scanMultiSeekPrimary(tuples, seekWidth, filterInfo);
			return;
		}

		const index = this.resolveIndexFromIdxStr(filterInfo.idxStr);
		if (!index) this.multiSeekMalformed(filterInfo, `no index named '${spec.indexName}'`);
		const indexCols = index.columns.map(c => c.index);
		const indexDirections = index.columns.map(c => !!c.desc);
		if (seekWidth > indexCols.length) {
			this.multiSeekMalformed(filterInfo, `seekWidth ${seekWidth} exceeds ${index.name}'s ${indexCols.length} columns`);
		}
		const seekCols = indexCols.slice(0, seekWidth);
		// The merged byte windows below ARE the whole access — no residual can resurrect a
		// row they skip, and a single unfaithful probe has nowhere to degrade to. A
		// single-window arm can decline to the full scan ({@link analyzePKAccess}) or stop
		// its prefix short ({@link analyzeIndexAccess}); neither move exists here, and an
		// unfaithful probe would either silently drop its tuple's rows or raise out of the
		// key encoder (`jsonStructuralKey` throws INTERNAL for a blob probe). So a
		// semantic-ordering seek column is refused outright.
		// `tryIndexAccessPlan` (store-module-access-plan.ts) declines such plans; one
		// arriving anyway is malformed. Re-opening is backlog
		// `feat-store-semantic-key-multiseek`.
		if (seekCols.some(colIdx => hasSemanticOrdering(this.tableSchema!.columns[colIdx]?.logicalType))) {
			this.multiSeekMalformed(filterInfo, 'semantic-ordering seek column');
		}
		// Same rationale for the collation gate: the merged windows drop any tuple the
		// bytes exclude, so a prefix whose key collation differs from the one the residual
		// re-compares under would under-fetch with nothing left to repair it.
		// `tryIndexAccessPlan` declines such plans through this same predicate; one
		// arriving anyway is malformed. {@link analyzeIndexAccess} makes the point-window
		// twin of this check.
		const indexKeyCollations = this.indexKeyCollations(index);
		if (!indexPrefixSeekIsCollationExact(this.tableSchema!.columns, index, indexKeyCollations, seekWidth)) {
			this.multiSeekMalformed(filterInfo, 'index key collation differs from the comparison collation');
		}

		// One window per distinct encoded tuple prefix (each column under its own key
		// collation C — see indexKeyCollations); C-equal tuples merge into one window,
		// each kept as a residual alternative.
		const seekCollations = indexKeyCollations.slice(0, seekWidth);
		const seekTransforms = this.indexKeyTransforms(index).slice(0, seekWidth);
		const windows = new Map<string, MultiSeekWindow>();
		for (const tuple of tuples) {
			const ordered = this.orderTupleValues(tuple, seekCols, filterInfo);
			const bounds = buildIndexPrefixBounds(ordered, this.encodeOptions, indexDirections.slice(0, seekWidth), seekCollations, seekTransforms);
			const hex = bytesToHex(bounds.gte);
			const info: FilterInfo = { ...filterInfo, constraints: tuple.entries };
			const existing = windows.get(hex);
			if (existing) existing.infos.push(info);
			else windows.set(hex, { bounds, infos: [info] });
		}
		if (windows.size === 0) return; // every tuple had a NULL component — nothing matches

		const sorted = [...windows.values()].sort((a, b) => compareBytes(a.bounds.gte, b.bounds.gte));
		const disjoint: MultiSeekWindow[] = [];
		for (const w of sorted) {
			const last = disjoint[disjoint.length - 1];
			if (last && last.bounds.lt === undefined) last.infos.push(...w.infos);
			else disjoint.push(w);
		}

		const indexStore = await this.ensureIndexStore(index.name);
		// Identical for every window (resolveFilterCollations dedups by column), so
		// resolve once and thread it through.
		const collations = this.resolveFilterCollations(filterInfo, this.indexColumnCollations(index));
		// Data-key hexes already YIELDED, across ALL windows — the multi-seek dedup set
		// (see produceIndexEntries / resolveRowBatch for the pre-check / add-on-yield
		// split). NOTE: holds one hex string per row the multi-seek yields, for the
		// whole seek — the only unbounded allocation on this path. Windows are
		// byte-disjoint, so the only real duplicate source is a stale index entry; if a
		// large-result `IN` ever shows up as a memory problem, the set can be scoped
		// per window (or dropped for a consistent store).
		const seen = new Set<string>();
		// ONE consumer over the concatenation of every window's producer: the windows
		// are sorted disjoint by encoded key, so the concatenation is already the
		// emission order, and bounding batches by entry count gives the cross-window
		// collapse (a hundred single-row windows become one round trip).
		yield* this.resolveIndexEntries(
			this.produceMultiSeekEntries(indexStore, disjoint, seen),
			collations,
			seen,
		);
	}

	/**
	 * Concatenate the disjoint multi-seek windows' producers, in window (byte) order.
	 * Each entry carries its window's full FilterInfo list — the primary tuple plus
	 * the byte-equal merged alternatives — so acceptance stays per row, in order (see
	 * {@link PendingIndexEntry}).
	 */
	private async *produceMultiSeekEntries(
		indexStore: KVStore,
		windows: readonly MultiSeekWindow[],
		seen: Set<string>,
	): AsyncIterable<PendingIndexEntry> {
		for (const w of windows) {
			yield* this.produceIndexEntries(indexStore, w.bounds, w.infos, false, seen);
		}
	}

	/**
	 * Multi-seek over the PRIMARY key: each tuple is a full PK, resolved by a point
	 * read in ascending encoded-data-key order (the table's native emission order).
	 *
	 * Reached from `computeBestAccessPlan`'s primary-key multi-seek arm
	 * (store-module-access-plan.ts), which claims a whole-primary-key `IN` — literal list
	 * or runtime-valued set — through `EQ_OR_IN_OPS` and advertises `_primary_` with every
	 * PK column as its seek columns. That arm declines exactly the two shapes the
	 * {@link multiSeekMalformed} throws below assert against (over the seek cap, and a
	 * semantic-ordering PK member), so a throw here means the plan and the scan disagreed.
	 *
	 * The ascending-encoded-key emission order is a contract, not an implementation
	 * detail: the isolation layer merges this stream with its overlay by primary key
	 * (`bug-isolation-multiseek-merge-order`), and the arm advertises PK ordering off it.
	 */
	protected async *scanMultiSeekPrimary(
		tuples: MultiSeekTuple[],
		seekWidth: number,
		filterInfo: FilterInfo,
	): AsyncIterable<Row> {
		const pkColumns = this.tableSchema!.primaryKeyDefinition.map(pk => pk.index);
		if (pkColumns.length === 0) {
			this.multiSeekMalformed(filterInfo, 'primary-key multi-seek on a table with no primary key');
		}
		if (seekWidth !== pkColumns.length) {
			this.multiSeekMalformed(filterInfo, `seekWidth ${seekWidth} does not cover the ${pkColumns.length}-column primary key`);
		}
		// Same rule as the secondary-index branch (see scanMultiSeek): with the residual
		// gone and N windows merged there is no scan to degrade to and no prefix to stop
		// short, so fail loudly rather than risk an under-fetch. `analyzePKAccess`'s
		// SINGLE-value point arm has that escape and no longer declines — see
		// pkHasSemanticOrderingMember.
		if (this.pkHasSemanticOrderingMember()) {
			this.multiSeekMalformed(filterInfo, 'semantic-ordering primary-key member');
		}

		// Dedup by encoded data key (collapses K-equal tuples), keeping every merged
		// tuple's residual as an alternative — same rationale as the index branch.
		const points = new Map<string, { key: Uint8Array; infos: FilterInfo[] }>();
		for (const tuple of tuples) {
			const ordered = this.orderTupleValues(tuple, pkColumns, filterInfo);
			const key = this.encodeDataKey(ordered);
			const hex = bytesToHex(key);
			const info: FilterInfo = { ...filterInfo, constraints: tuple.entries };
			const existing = points.get(hex);
			if (existing) existing.infos.push(info);
			else points.set(hex, { key, infos: [info] });
		}

		const collations = this.resolveFilterCollations(filterInfo);
		const sorted = [...points.values()].sort((a, b) => compareBytes(a.key, b.key));
		// Bounded batches over the sorted, deduplicated key list — "fetch N rows by
		// key" is exactly the shape readEffectiveRowsByKeys batches (one round trip
		// per ROW_RESOLUTION_BATCH keys, pending overlay resolved first, positional
		// nulls for missing keys). Emission order is unchanged (ascending encoded data
		// key), and a downstream break mid-batch reads no further batch.
		for (let start = 0; start < sorted.length; start += ROW_RESOLUTION_BATCH) {
			const slice = sorted.slice(start, start + ROW_RESOLUTION_BATCH);
			const rows = await this.readEffectiveRowsByKeys(slice.map(p => p.key));
			for (let i = 0; i < slice.length; i++) {
				const row = rows[i];
				if (row && slice[i].infos.some(fi => this.matchesFilters(row, fi, collations))) {
					yield row;
				}
			}
		}
	}

	/**
	 * Check if a row matches the filter constraints.
	 *
	 * `collations` maps a constrained column index to the comparison function that
	 * column must be re-checked under; every caller builds it once per scan with
	 * {@link resolveFilterCollations}, whose doc comment explains how the name is
	 * chosen. A column absent from the map compares BINARY — the same result
	 * {@link resolveFilterCollations} produces for an undeclared collation, and the
	 * only reachable absence, since both walk the constraint list under identical
	 * skip conditions.
	 */
	protected matchesFilters(
		row: Row,
		filterInfo: FilterInfo,
		collations: ReadonlyMap<number, CollationFunction>,
	): boolean {
		if (!filterInfo.constraints || filterInfo.constraints.length === 0) {
			return true;
		}

		for (const constraintEntry of filterInfo.constraints) {
			const { constraint, argvIndex } = constraintEntry;
			if (constraint.iColumn < 0 || argvIndex <= 0) {
				continue;
			}

			const rowValue = row[constraint.iColumn];
			const filterValue = filterInfo.args[argvIndex - 1];
			const collation = collations.get(constraint.iColumn) ?? BINARY_COLLATION;

			// A semantic-ordering column (TIMESPAN, JSON) must filter under the type's
			// compare — the same order the engine's operators and Sort use — or a pushed
			// `d > 'PT90M'` would text-compare and drop rows the predicate admits. The
			// comparator is built per row only on this rare column kind; if a profile
			// ever shows it, resolve it once per scan alongside the collations.
			const logicalType = this.tableSchema!.columns[constraint.iColumn]?.logicalType;
			const compare = hasSemanticOrdering(logicalType)
				? createTypedComparator(logicalType, collation)
				: undefined;

			if (!this.compareValues(rowValue, constraint.op, filterValue, collation, compare)) {
				return false;
			}
		}

		return true;
	}

	/**
	 * Resolve, ONCE per scan, the comparison collation function for every pushed
	 * constraint column, keyed by column index.
	 *
	 * The name for a column is its DECLARED collation (absent ⇒ BINARY) — the same
	 * resolution the access path's collation-cover analysis uses
	 * (indexColumnCollationLookup / primaryKeyCollationLookup) when it decides a
	 * pushed constraint is fully covered, and the same source `StoreTableConstraints`'
	 * UNIQUE checks compare under. On a collation MATCH the planner drops the residual
	 * Filter, so {@link matchesFilters} alone must reproduce the predicate.
	 *
	 * `indexCollationNames` (from {@link indexColumnCollations}) overrides the
	 * declared name for the secondary-index scan arm: the planner's MATCH there is
	 * against the INDEX column's collation, which an explicit `COLLATE` on the index
	 * can make differ from the table column's.
	 *
	 * Names resolve against {@link collationResolver}, so an unregistered collation
	 * raises `no such collation sequence` at scan setup rather than byte-ordering
	 * every row.
	 *
	 * NOTE: rebuilt on every `query()` / `scanPKRange()` / `scanIndex()` call — one
	 * registry lookup per distinct constrained column, dwarfed by the scan's I/O. If a
	 * point-lookup-heavy profile ever shows it, memoize on the `FilterInfo`.
	 */
	protected resolveFilterCollations(
		filterInfo: FilterInfo,
		indexCollationNames?: ReadonlyMap<number, string | undefined>,
	): ReadonlyMap<number, CollationFunction> {
		const resolved = new Map<number, CollationFunction>();
		if (!filterInfo.constraints) return resolved;

		for (const { constraint, argvIndex } of filterInfo.constraints) {
			if (constraint.iColumn < 0 || argvIndex <= 0) continue;
			if (resolved.has(constraint.iColumn)) continue;

			const name = indexCollationNames?.has(constraint.iColumn)
				? indexCollationNames.get(constraint.iColumn)
				: this.tableSchema!.columns[constraint.iColumn]?.collation;
			resolved.set(constraint.iColumn, name ? this.collationResolver(name) : BINARY_COLLATION);
		}

		return resolved;
	}

	/**
	 * Effective per-column comparison collation for a secondary index's columns:
	 * the index column's own `COLLATE` when present, else the underlying table
	 * column's declared collation. Mirrors the resolution `StoreModule`'s
	 * index-maintenance UNIQUE dedup uses (`indexCol.collation ?? tableColumn`), so
	 * a re-checked index-scan row compares under the same collation the planner used
	 * to justify dropping (or keeping) the residual Filter.
	 */
	protected indexColumnCollations(index: TableIndexSchema): Map<number, string | undefined> {
		const cols = this.tableSchema!.columns;
		const map = new Map<number, string | undefined>();
		for (const c of index.columns) {
			map.set(c.index, c.collation ?? cols[c.index]?.collation);
		}
		return map;
	}

	/**
	 * Compare two values according to an operator, under `collationFunc` (already
	 * resolved by {@link resolveFilterCollations} against this database's collation
	 * registry). So the LT/LE/GT/GE range bounds honour a NOCASE/RTRIM/custom column
	 * collation rather than a raw BINARY JS comparison — the capability
	 * `StoreModule.getBestAccessPlan` advertises via `honorsCollatedRangeBounds`.
	 * NULL on either side fails every operator except EQ-with-both-NULL (the
	 * internal point-lookup convention; the planner never pushes `= NULL`).
	 */
	protected compareValues(
		a: SqlValue,
		op: IndexConstraintOp,
		b: SqlValue,
		collationFunc: CollationFunction,
		semanticCompare?: (a: SqlValue, b: SqlValue) => number,
	): boolean {
		if (a === null || b === null) {
			return op === IndexConstraintOp.EQ ? a === b : false;
		}

		const cmp = semanticCompare ? semanticCompare(a, b) : compareSqlValuesFast(a, b, collationFunc);
		switch (op) {
			case IndexConstraintOp.EQ: return cmp === 0;
			case IndexConstraintOp.NE: return cmp !== 0;
			case IndexConstraintOp.LT: return cmp < 0;
			case IndexConstraintOp.LE: return cmp <= 0;
			case IndexConstraintOp.GT: return cmp > 0;
			case IndexConstraintOp.GE: return cmp >= 0;
			default: return true;
		}
	}

}

/** One pushed LT/LE/GT/GE constraint paired with its bound value (undefined when unbound). */
interface RangeBound {
	op: IndexConstraintOp;
	value?: SqlValue;
}

/**
 * A primary-key byte window: the rows whose leading members equal `prefixValues`,
 * further bounded by `constraints` on the member right after them. An empty prefix is the
 * leading-member range; empty constraints are the plain prefix window.
 */
interface PKWindowAccess {
	type: 'range';
	prefixValues: readonly SqlValue[];
	constraints: readonly RangeBound[];
}

/** PK access pattern analysis result — see {@link StoreTableScan.analyzePKAccess}. */
type PKAccessPattern =
	| { type: 'point'; values: SqlValue[] }
	| PKWindowAccess
	| { type: 'scan' };

/**
 * Fold LT/LE/GT/GE `constraints` on ONE key column into a single encoded-byte `gte`/`lt`
 * window nested inside a fixed equality prefix — the bound arithmetic shared by the
 * primary-key windows ({@link StoreTableScan.buildPKRangeBounds}) and the secondary-index
 * ones ({@link StoreTableScan.buildIndexRangeBounds}), which differ only in `encodePrefix`.
 *
 * `encodePrefix(values)` must answer the byte region `[lo, hi)` of every key whose leading
 * columns equal `values`, encoded exactly as the store's keys are (per-column DESC
 * inversion, key collation, key value transform), and full-scan bounds for an empty list.
 * The bounded column sits at position `prefixValues.length`; `boundDesc` is its direction
 * and `boundType` its logical type.
 *
 * Each bound value is encoded BEHIND the prefix (`encodePrefix([...prefix, value])`),
 * and the op maps that region's endpoints onto `gte`/`lt`. Because a DESC column
 * bit-inverts its bytes (larger value ⇒ smaller bytes), the lower/upper assignment swaps
 * with the BOUNDED column's direction alone — a DESC prefix column merely inverts bytes
 * inside a prefix that stays fixed:
 *
 *   | op | ASC      | DESC     |
 *   |----|----------|----------|
 *   | GE | gte = lo | lt  = hi |
 *   | GT | gte = hi | lt  = lo |
 *   | LE | lt  = hi | gte = lo |
 *   | LT | lt  = lo | gte = hi |
 *
 * Both sides START at the prefix's own window (`[P, incr(P))`, or unbounded for an empty
 * prefix) and are then tightened: keep the MAX lower and MIN upper across constraints
 * (BETWEEN ⇒ one lower + one upper; a redundant same-side pair ⇒ the tighter wins). So
 * every degraded path lands back on the prefix window, never wider — widen, don't
 * decline. Skipped, each only widening the window, while the scan's `matchesFilters`
 * stays the authoritative row filter:
 *
 *  - an `undefined` upper (an `hi` whose increment overflowed all-0xff);
 *  - a NULL/missing bound value (the planner never pushes `= NULL`, and a range op
 *    against NULL rejects every row in `matchesFilters`);
 *  - a bound over a semantic-ordering column whose VALUE has no faithful byte position
 *    ({@link semanticProbeIsKeyFaithful} — a numeric or unparseable TIMESPAN probe, a
 *    blob/bigint JSON probe). The plan claimed the range handled from the schema alone,
 *    so `matchesFilters` reproduces the dropped predicate under the type's own compare.
 *    The EQUALITY arms cannot widen this way and degrade differently — see
 *    {@link semanticProbeIsKeyFaithful}'s per-arm table.
 */
function foldRangeWindow(
	prefixValues: readonly SqlValue[],
	constraints: readonly RangeBound[],
	boundDesc: boolean,
	boundType: LogicalType | undefined,
	encodePrefix: (values: SqlValue[]) => { gte: Uint8Array; lt?: Uint8Array },
): IterateOptions {
	const base = encodePrefix([...prefixValues]);
	let gte: Uint8Array = base.gte;
	let lt: Uint8Array | undefined = base.lt;

	for (const c of constraints) {
		if (c.value === undefined || c.value === null) continue;
		if (!semanticProbeIsKeyFaithful(boundType, c.value)) continue;
		const { gte: lo, lt: hi } = encodePrefix([...prefixValues, c.value]);
		const lower = !boundDesc
			? (c.op === IndexConstraintOp.GE ? lo : c.op === IndexConstraintOp.GT ? hi : undefined)
			: (c.op === IndexConstraintOp.LE ? lo : c.op === IndexConstraintOp.LT ? hi : undefined);
		const upper = !boundDesc
			? (c.op === IndexConstraintOp.LE ? hi : c.op === IndexConstraintOp.LT ? lo : undefined)
			: (c.op === IndexConstraintOp.GE ? hi : c.op === IndexConstraintOp.GT ? lo : undefined);
		if (lower && compareBytes(lower, gte) > 0) gte = lower;
		if (upper && (lt === undefined || compareBytes(upper, lt) < 0)) lt = upper;
	}

	return lt === undefined ? { gte } : { gte, lt };
}

/**
 * Secondary-index access pattern analysis result: the chosen index plus the
 * encoded byte window {@link StoreTableScan.scanIndex} iterates. `point` is a
 * leading-prefix EQ window; `range` is an LT/LE/GT/GE window, either on the leading
 * column or nested inside an equality prefix (`prefixRangeSeek`). Both resolve to a
 * `bounds` scan (an index seek is always a prefix scan, never a single entry) — nothing
 * downstream branches on the tag, which is descriptive only.
 */
interface IndexAccessPattern {
	index: TableIndexSchema;
	type: 'point' | 'range';
	bounds: IterateOptions;
}

/** One pushed-constraint entry, as {@link FilterInfo.constraints} carries it. */
type ConstraintEntry = FilterInfo['constraints'][number];

/**
 * One multi-seek tuple: its W constraint entries and their bound values, in
 * constraint order (see {@link StoreTableScan.decodeMultiSeekTuples}).
 */
interface MultiSeekTuple {
	entries: ConstraintEntry[];
	values: SqlValue[];
}

/** One multi-seek byte window and the tuples (as per-tuple FilterInfos) it serves. */
interface MultiSeekWindow {
	bounds: { gte: Uint8Array; lt?: Uint8Array };
	infos: FilterInfo[];
}

/**
 * One surviving index entry awaiting row resolution — what
 * {@link StoreTableScan}'s producer half (`produceIndexEntries`) hands its batching
 * consumer (`resolveIndexEntries`).
 *
 * `dataKey` — the entry's stored index VALUE: the encoded data-store key of the row.
 *
 * `dataKeyHex` — hex of `dataKey`, computed only when a multi-seek `seen` set is
 * tracking duplicates (it doubles as the set key, saving a re-encode at the post-read
 * check); undefined for an ordinary single-window scan, which has no dedup to do.
 *
 * `infos` — the FilterInfos a resolved row may match; the row is accepted when it
 * matches ANY. For a single-window scan this is just the scan's own FilterInfo. For a
 * multi-seek window it is the primary tuple plus every merged alternative — seek
 * tuples whose encoded window byte-equals it (duplicate bound parameters, or
 * case-variant values under a NOCASE key collation). Index bytes encode under the
 * same collation C the residual compares under (`indexKeyCollations`), so byte-equal
 * tuples are C-equal and each merged tuple's residual admits the same rows — the OR
 * is redundancy, kept because it is what makes the fold safe by construction rather
 * than by that argument, and it is what a custom equality-only normalizer
 * (byte-equal ⇏ comparator-equal order but equal partition) still relies on.
 */
interface PendingIndexEntry {
	dataKey: Uint8Array;
	dataKeyHex?: string;
	infos: readonly FilterInfo[];
}
