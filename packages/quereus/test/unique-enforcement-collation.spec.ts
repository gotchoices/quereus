/**
 * Conformance lock for the memory module's `checkUniqueViaIndex` per-column
 * UNIQUE-enforcement collation resolution (ticket
 * `unify-unique-enforcement-collation-resolver`, the "fourth copy").
 *
 * The shared {@link uniqueEnforcementCollations} helper resolves the enforcement
 * collation per constrained column from `(schema, uc)`, looking the index up BY
 * NAME via `uc.derivedFromIndex`. store/isolation import that helper directly, so
 * their copies cannot drift. Memory's `checkUniqueViaIndex` cannot share the
 * import: it reads the collation from the *live* `MemoryIndex` handle that
 * `findIndexForConstraint` resolves BY COLUMN-SET —
 * `index.specColumns[i]?.collation ?? schema.columns[col].collation`. The two
 * resolution paths agree per column for every NORMAL shape — at most one UNIQUE
 * index per column-set — and a drift on those would re-open the covering-MV
 * subset-miss (or over-reject). They do NOT agree when two UNIQUE indexes cover
 * the SAME column-set with different collations: by-name resolves each UC's own
 * index, by-column-set resolves the first index in `schema.indexes`, so memory
 * can under-enforce a coarser-declared UNIQUE (a pre-existing memory-enforcement
 * bug independent of this unification — see fix ticket
 * `memory-multi-index-unique-collation-resolution`). The shapes below stay within
 * the single-index-per-column-set regime where agreement is the contract.
 *
 * This suite drives those shapes through BOTH paths and asserts equal per-column
 * output. A drift here is a genuine finding (the two index-resolution paths
 * disagree on a shape that should agree), NOT a reason to widen the helper's
 * signature.
 */

import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import { uniqueEnforcementCollations } from '../src/schema/unique-enforcement.js';
import { normalizeCollationName } from '../src/util/comparison.js';
import { MemoryTableModule } from '../src/vtab/memory/module.js';
import type { MemoryTableManager } from '../src/vtab/memory/layer/manager.js';
import type { MemoryIndex } from '../src/vtab/memory/index.js';
import type { TableSchema, UniqueConstraintSchema } from '../src/schema/table.js';

/**
 * Reaches the {@link MemoryTableManager} backing a memory table — the engine no
 * longer addresses it directly (it routes through the backing-host capability),
 * so the test resolves it from the module's table map (cf.
 * `maintenance-replace-all.spec.ts`).
 */
function getBackingManager(schema: TableSchema): MemoryTableManager {
	expect(schema.vtabModule, `'${schema.name}' module`).to.be.instanceOf(MemoryTableModule);
	const manager = (schema.vtabModule as MemoryTableModule).tables
		.get(`${schema.schemaName}.${schema.name}`.toLowerCase());
	expect(manager, `memory manager for '${schema.name}'`).to.not.be.undefined;
	return manager!;
}

/**
 * The live `MemoryIndex` enforcing `uc`, resolved EXACTLY as
 * `MemoryTableManager.findIndexForConstraint` does for the non-MV path: the first
 * secondary index whose column SET matches `uc.columns` positionally, fetched
 * from the committed layer. This is the source `checkUniqueViaIndex` reads — note
 * it matches by column-set, not by `uc.derivedFromIndex` name.
 */
function resolveLiveIndex(
	manager: MemoryTableManager,
	schema: TableSchema,
	uc: UniqueConstraintSchema,
): MemoryIndex | undefined {
	const idx = schema.indexes?.find(ix =>
		ix.columns.length === uc.columns.length &&
		ix.columns.every((col, i) => col.index === uc.columns[i]),
	);
	if (!idx) return undefined;
	return manager.currentCommittedLayer.getSecondaryIndex?.(idx.name);
}

/**
 * The `checkUniqueViaIndex` per-column collation expression evaluated against the
 * live index handle: `index.specColumns[i]?.collation ?? schema.columns[col].collation`.
 */
function viaLiveIndexCollations(
	index: MemoryIndex,
	schema: TableSchema,
	uc: UniqueConstraintSchema,
): (string | undefined)[] {
	return uc.columns.map((col, i) => index.specColumns[i]?.collation ?? schema.columns[col].collation);
}

/** Compare collations the way the runtime does — an absent name behaves as BINARY,
 *  and SQLite treats collation names case-insensitively. */
const norm = (c: string | undefined): string => normalizeCollationName(c ?? 'BINARY');

interface Shape {
	name: string;
	ddl: string[];
	/** The base table whose UNIQUE constraint is under test. */
	table: string;
	/** Expected normalized per-column enforcement collation (sanity floor that the
	 *  shapes actually exercise the distinctions they claim to). */
	expected: string[];
}

const SHAPES: Shape[] = [
	{
		// Finer index than the column: BINARY index over a NOCASE column.
		name: 'finer (BINARY index / NOCASE column)',
		ddl: [
			'create table t (id integer primary key, b text collate nocase)',
			'create unique index ix on t (b collate binary)',
		],
		table: 't',
		expected: ['BINARY'],
	},
	{
		// Coarser index than the column: NOCASE index over a BINARY column.
		name: 'coarser (NOCASE index / BINARY column)',
		ddl: [
			'create table t (id integer primary key, b text collate binary)',
			'create unique index ix on t (b collate nocase)',
		],
		table: 't',
		expected: ['NOCASE'],
	},
	{
		name: 'equal (NOCASE index / NOCASE column)',
		ddl: [
			'create table t (id integer primary key, b text collate nocase)',
			'create unique index ix on t (b collate nocase)',
		],
		table: 't',
		expected: ['NOCASE'],
	},
	{
		// No explicit index COLLATE — both paths fall back to the declared collation.
		name: 'plain (no index COLLATE)',
		ddl: [
			'create table t (id integer primary key, b text collate nocase)',
			'create unique index ix on t (b)',
		],
		table: 't',
		expected: ['NOCASE'],
	},
	{
		// Composite: column 0 carries an explicit (finer) index COLLATE, column 1
		// has none and falls back to its declared collation — exercises index 1.
		name: 'composite (one finer, one plain)',
		ddl: [
			'create table t (id integer primary key, a text collate nocase, b text collate nocase)',
			'create unique index ix on t (a collate binary, b)',
		],
		table: 't',
		expected: ['BINARY', 'NOCASE'],
	},
	{
		// Non-derived, table-level UNIQUE: `derivedFromIndex` unset ⇒ the helper
		// falls back to declared per column; the auto-built `_uc_*` covering index
		// carries the declared collation, so the live path agrees.
		name: 'non-derived (table-level UNIQUE)',
		ddl: [
			'create table t (id integer primary key, b text collate nocase, unique (b))',
		],
		table: 't',
		expected: ['NOCASE'],
	},
	{
		// Non-derived composite, for good measure: two declared collations, no index.
		name: 'non-derived composite (table-level UNIQUE)',
		ddl: [
			'create table t (id integer primary key, a text collate binary, b text collate nocase, unique (a, b))',
		],
		table: 't',
		expected: ['BINARY', 'NOCASE'],
	},
];

describe('uniqueEnforcementCollations ⇔ memory checkUniqueViaIndex (#4 conformance lock)', () => {
	for (const shape of SHAPES) {
		it(`agree on: ${shape.name}`, async () => {
			const db = new Database();
			try {
				for (const stmt of shape.ddl) await db.exec(stmt);

				const schema = db.schemaManager.getTable('main', shape.table)!;
				expect(schema, `table '${shape.table}'`).to.not.be.undefined;
				const uc = schema.uniqueConstraints![0];
				expect(uc, 'UNIQUE constraint under test').to.not.be.undefined;

				// The shared helper — resolves the index BY NAME (uc.derivedFromIndex).
				const helper = uniqueEnforcementCollations(schema, uc);

				// The memory #4 path — the live index resolved BY COLUMN-SET.
				const manager = getBackingManager(schema);
				const index = resolveLiveIndex(manager, schema, uc);
				expect(index, 'live enforcing MemoryIndex for the constraint').to.not.be.undefined;
				const viaIndex = viaLiveIndexCollations(index!, schema, uc);

				expect(helper.length, 'one collation per constrained column').to.equal(uc.columns.length);
				expect(viaIndex.length, 'live path matches arity').to.equal(uc.columns.length);

				const helperNorm = helper.map(norm);
				const viaIndexNorm = viaIndex.map(norm);
				// The lock: the name-resolved helper and the column-set-resolved live
				// index produce the same per-column enforcement collation.
				expect(helperNorm, 'helper (by-name) vs live index (by-column-set) must agree')
					.to.deep.equal(viaIndexNorm);
				// Sanity floor: and they match the shape's intended distinction.
				expect(helperNorm, 'shape exercises the intended collation').to.deep.equal(shape.expected);
			} finally {
				await db.close();
			}
		});
	}
});
