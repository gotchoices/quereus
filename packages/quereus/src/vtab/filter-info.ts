import { IndexConstraintOp } from '../common/constants.js';
import type { SqlValue } from '../common/types.js';
import type { IndexConstraint, IndexInfo } from './index-info.js';
import type { AccessPath, IndexDescriptor } from './index-descriptor.js';
import { encodeIdxStr, makeIdxStrSpec, retargetIdxStr, withWalkDirection } from './idx-str.js';

/**
 * Structure to pass all necessary filter and planning information
 * to a virtual table's xOpen method when cursors are not used.
 */
export interface FilterInfo {
	/** The index number chosen by xBestIndex (output of xBestIndex) */
	idxNum: number;
	/** The index string chosen by xBestIndex (output of xBestIndex) */
	idxStr: string | null;
	/** Array of WHERE clause constraints (input to xBestIndex/xOpen) */
	constraints: ReadonlyArray<{ constraint: IndexConstraint, argvIndex: number }>;
	/** Values for ?. argvIndex in constraints (input to xOpen) */
	args: ReadonlyArray<SqlValue>;
	/**
	 * The IndexInfo object AFTER xBestIndex has populated its output fields
	 * (aConstraintUsage, orderByConsumed, estimatedCost, estimatedRows, idxFlags).
	 * This is needed by xOpen to understand how constraints were used by the planner.
	 */
	indexInfoOutput: IndexInfo;

	/**
	 * Structured description of the access path this FilterInfo drives — the typed,
	 * validated form of what `idxStr` encodes as text. Populated by
	 * `rule-select-access-path`; consumers should read this rather than parse `idxStr`.
	 *
	 * Absent ⇒ this FilterInfo was hand-built by a caller that declared no access path.
	 * A consumer that needs the access path MUST fail loudly rather than infer one from
	 * `idxStr`; the engine's own builders below always populate it.
	 */
	readonly accessPath?: AccessPath;

	/**
	 * If set, the access plan honors a soft row cap — the vtab should stop
	 * emitting after this many rows. Pushed down by OrdinalSlice / future
	 * limit-pushdown rules. Modules without limit-pushdown support may ignore
	 * this; a downstream slice operator will still enforce the cap.
	 */
	limit?: number;

	/**
	 * If set, the access plan walks its monotonic index and seeks directly
	 * to the kth row in monotonic order before emitting. Only honored when
	 * the chosen access plan advertised `supportsOrdinalSeek`; otherwise the
	 * field must be ignored (a slice operator above will buffer-and-discard).
	 */
	offset?: number;

	/**
	 * The table columns (0-based indexes into the table schema's `columns`) the plan
	 * reads from the rows this scan emits. Present only when the engine has proven the
	 * set from the final plan — see `planner/analysis/required-columns.ts`. **Absent
	 * means every column**, so a module narrows its read only on the engine's say-so.
	 *
	 * A module may honour it by filling only these columns of each emitted row; every
	 * other position may hold any valid SQL value (null is the natural choice), and the
	 * engine never reads it. The row must keep its full width. The module still applies
	 * its claimed constraints however it does — a constrained column need not be listed
	 * here when nothing above the scan reads it. Ignoring the field is always correct.
	 * See `docs/module-authoring.md` § "Required columns".
	 *
	 * A module that wraps another (the isolation layer) and reads columns of the rows it
	 * gets back — to merge by key, say — must add those columns before forwarding it.
	 */
	readonly requiredColumns?: ReadonlySet<number>;
}

/**
 * The base-column indexes a single-key equality seek looks up — sorted, de-duplicated —
 * or undefined when `filterInfo` is not one. This is the one definition of "a single-key
 * equality seek" shared by the two readers of rows-per-key feedback
 * (docs/progressive-optimizer.md §3.1): the scan leaf that counts what such a seek
 * yields and the planner that later prices it, so neither can drift on what qualifies.
 *
 * Qualifies: a resolved index (`accessPath.kind === 'index'` — an `unresolvedIndex`
 * cannot say whether it is unique) walked with plan `eqSeek` (one key tuple; a
 * `multiSeek` yields several keys' rows), every constraint an `EQ`, no pushed limit or
 * offset, and the equality set NOT a unique key: a seek that covers every key column of a
 * unique index (a whole-primary-key point seek, a unique index seek) yields at most one
 * row by proof, so there is nothing to learn from it. A prefix of a composite unique
 * index is not unique and qualifies.
 */
export function equalitySeekKeyColumns(filterInfo: FilterInfo): readonly number[] | undefined {
	const { accessPath, constraints, limit, offset } = filterInfo;
	if (accessPath?.kind !== 'index' || accessPath.plan !== 'eqSeek') return undefined;
	if (constraints.length === 0 || limit !== undefined || offset !== undefined) return undefined;
	if (constraints.some(c => c.constraint.op !== IndexConstraintOp.EQ)) return undefined;
	const columns = [...new Set(constraints.map(c => c.constraint.iColumn))].sort((a, b) => a - b);
	const { index } = accessPath;
	if (index.unique && index.keyColumns.every(key => columns.includes(key.columnIndex))) return undefined;
	return columns;
}

/** The `idxStr` sentinel meaning "no index chosen — walk every row". */
const FULL_SCAN_IDX_STR = 'fullscan';

/** The `idxStr` sentinel meaning "the predicate is unsatisfiable — emit no rows". */
const EMPTY_IDX_STR = 'empty';

/**
 * FilterInfo for a full table scan: no constraints, no index.
 *
 * Shared by the planner's sequential-scan arms, `ANALYZE`'s scan-based statistics
 * collection, and the isolation layer's overlay-merge / migration / commit-flush
 * scans — one definition keeps those sites from drifting.
 */
export function makeFullScanFilterInfo(cost = 1_000_000, rows = 1_000_000): FilterInfo {
	return {
		idxNum: 0,
		idxStr: FULL_SCAN_IDX_STR,
		constraints: [],
		args: [],
		accessPath: { kind: 'fullScan' },
		indexInfoOutput: {
			nConstraint: 0,
			aConstraint: [],
			nOrderBy: 0,
			aOrderBy: [],
			aConstraintUsage: [],
			idxNum: 0,
			idxStr: FULL_SCAN_IDX_STR,
			orderByConsumed: false,
			estimatedCost: cost,
			estimatedRows: BigInt(rows),
			idxFlags: 0,
		},
	};
}

/**
 * FilterInfo for a provably empty relation (an unsatisfiable predicate). Distinct from
 * {@link makeFullScanFilterInfo} so a consumer can tell "no index" from "no rows".
 */
export function makeEmptyFilterInfo(): FilterInfo {
	return {
		idxNum: 0,
		idxStr: EMPTY_IDX_STR,
		constraints: [],
		args: [],
		accessPath: { kind: 'empty' },
		indexInfoOutput: {
			nConstraint: 0,
			aConstraint: [],
			nOrderBy: 0,
			aOrderBy: [],
			aConstraintUsage: [],
			idxNum: 0,
			idxStr: EMPTY_IDX_STR,
			orderByConsumed: false,
			estimatedCost: 0,
			estimatedRows: 0n,
			idxFlags: 0,
		},
	};
}

/**
 * FilterInfo for an equality (point/prefix) seek over `index`: one EQ constraint per
 * entry of `seekColumnIndexes`, bound positionally to `values`.
 *
 * Used by the isolation layer's primary-key point lookups and by any caller that must
 * drive an O(log n) seek instead of a scan.
 *
 * The result is a seek REQUEST, not a negotiated access plan. `aConstraintUsage[].omit`
 * is an OUTPUT of `getBestAccessPlan` — the module's own claim that it applied a filter,
 * which is what earns the engine the right to drop the residual. A hand-built FilterInfo
 * never ran that negotiation, so this builder cannot assert `omit` on the module's
 * behalf: it reports `false`, and the caller driving `query()` directly owns re-checking
 * every returned row (there is no engine above the call to reapply anything). The
 * negotiated path in `rule-select-access-path` builds its own `aConstraintUsage` inline
 * and still sets `omit: true`, where it is earned.
 */
export function makeIndexEqSeekFilterInfo(
	index: IndexDescriptor,
	seekColumnIndexes: readonly number[],
	values: readonly SqlValue[],
): FilterInfo {
	const constraints = seekColumnIndexes.map((columnIndex, i) => ({
		constraint: { iColumn: columnIndex, op: IndexConstraintOp.EQ, usable: true },
		argvIndex: i + 1,
	}));
	const idxStr = encodeIdxStr(makeIdxStrSpec(index.name, 'eqSeek', withWalkDirection(undefined, index)));

	return {
		idxNum: 0,
		idxStr,
		constraints,
		args: values,
		accessPath: { kind: 'index', index, plan: 'eqSeek' },
		indexInfoOutput: {
			nConstraint: constraints.length,
			aConstraint: constraints.map(c => c.constraint),
			nOrderBy: 0,
			aOrderBy: [],
			aConstraintUsage: constraints.map(c => ({ argvIndex: c.argvIndex, omit: false })),
			idxNum: 0,
			idxStr,
			orderByConsumed: false,
			estimatedCost: 1,
			estimatedRows: 1n,
			idxFlags: 0,
		},
	};
}

/**
 * Rewrite the index name across `idxStr`, `indexInfoOutput.idxStr`, and
 * `accessPath.index.name` (or `accessPath.indexName` when unresolved).
 *
 * A module may advertise a per-plan alias for an index (`_primary_1`) that a wrapping
 * table's delegate does not know. Retargeting rewrites only the name; `plan`, `nameArg`,
 * and every parameter — including ones this engine does not understand — survive verbatim.
 * A FilterInfo naming no index (full scan / empty) is returned unchanged.
 */
export function retargetFilterInfoIndex(filterInfo: FilterInfo, newIndexName: string): FilterInfo {
	const idxStr = retargetIdxStr(filterInfo.idxStr, newIndexName);
	const outIdxStr = retargetIdxStr(filterInfo.indexInfoOutput.idxStr, newIndexName);
	const accessPath = retargetAccessPath(filterInfo.accessPath, newIndexName);

	if (idxStr === filterInfo.idxStr && outIdxStr === filterInfo.indexInfoOutput.idxStr && accessPath === filterInfo.accessPath) {
		return filterInfo;
	}

	return {
		...filterInfo,
		idxStr,
		...(accessPath ? { accessPath } : {}),
		indexInfoOutput: { ...filterInfo.indexInfoOutput, idxStr: outIdxStr },
	};
}

function retargetAccessPath(accessPath: AccessPath | undefined, newIndexName: string): AccessPath | undefined {
	if (!accessPath) return undefined;
	switch (accessPath.kind) {
		case 'index':
			if (accessPath.index.name === newIndexName) return accessPath;
			return { ...accessPath, index: { ...accessPath.index, name: newIndexName } };
		case 'unresolvedIndex':
			if (accessPath.indexName === newIndexName) return accessPath;
			return { ...accessPath, indexName: newIndexName };
		default:
			return accessPath;
	}
}
