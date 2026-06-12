import { expect } from 'chai';
import { MemoryIndex } from '../../src/vtab/memory/index.js';
import { createPrimaryKeyFunctions } from '../../src/vtab/memory/utils/primary-key.js';
import { createDefaultColumnSchema } from '../../src/schema/column.js';
import { INTEGER_TYPE } from '../../src/types/builtin-types.js';
import type { ColumnSchema } from '../../src/schema/column.js';
import type { TableSchema, PrimaryKeyColumnDefinition } from '../../src/schema/table.js';

/**
 * Regression tests for the value-identity (vs JS reference identity) of a
 * MemoryIndex entry's `primaryKeys`. Pre-fix these used a JS `Set`, keyed by
 * SameValueZero/reference identity, which silently broke:
 *   - composite (array) PKs: a fresh equal-by-value array never matched on
 *     removeEntry and stored a duplicate on addEntry; and
 *   - scalar integer PKs across representations (`5n` vs `5`).
 * The fix keys members by the table's PK comparator via a sorted array.
 */

/** N INTEGER columns named c0..c(n-1). */
function makeColumns(n: number): ColumnSchema[] {
	return Array.from({ length: n }, (_, i) => ({
		...createDefaultColumnSchema(`c${i}`),
		logicalType: INTEGER_TYPE,
	}));
}

/** Minimal TableSchema sufficient for createPrimaryKeyFunctions. */
function makeSchema(columns: ColumnSchema[], primaryKeyDefinition: PrimaryKeyColumnDefinition[]): TableSchema {
	return {
		name: 'test',
		schemaName: 'main',
		columns,
		columnIndexMap: new Map(columns.map((c, i) => [c.name.toLowerCase(), i])),
		primaryKeyDefinition,
		checkConstraints: [],
		vtabModuleName: 'memory',
		isView: false,
	};
}

/** A single-column secondary index (on column 0) whose entries hold PKs compared by `pkCompare`. */
function makeIndex(columns: ColumnSchema[], pkDefinition: PrimaryKeyColumnDefinition[]): MemoryIndex {
	const pkCompare = createPrimaryKeyFunctions(makeSchema(columns, pkDefinition)).compare;
	return new MemoryIndex({ name: 'idx', columns: [{ index: 0 }] }, columns, pkCompare);
}

describe('MemoryIndex primaryKeys value-identity', () => {
	it('composite-PK removeEntry drops the member by value (count -> 0, entry deleted)', () => {
		const columns = makeColumns(3);
		// Composite PK over columns 1 and 2.
		const index = makeIndex(columns, [{ index: 1 }, { index: 2 }]);

		index.addEntry(1, [10, 20]);
		expect(index.getPrimaryKeys(1)).to.have.length(1);

		// Fresh array, equal by value to the stored PK — a Set would miss this.
		index.removeEntry(1, [10, 20]);
		expect(index.getPrimaryKeys(1)).to.have.length(0);
		// Emptied entry is removed from the tree, keeping distinct-key stats accurate.
		expect(index.size).to.equal(0);
	});

	it('composite-PK addEntry of an equal-by-value PK does not duplicate (count stays 1)', () => {
		const columns = makeColumns(3);
		const index = makeIndex(columns, [{ index: 1 }, { index: 2 }]);

		index.addEntry(1, [10, 20]);
		index.addEntry(1, [10, 20]); // fresh equal-by-value array
		expect(index.getPrimaryKeys(1)).to.have.length(1);
	});

	it('composite-PK keeps genuinely distinct PKs under one index key', () => {
		const columns = makeColumns(3);
		const index = makeIndex(columns, [{ index: 1 }, { index: 2 }]);

		index.addEntry(1, [10, 20]);
		index.addEntry(1, [10, 21]);
		index.addEntry(1, [11, 20]);
		expect(index.getPrimaryKeys(1)).to.have.length(3);

		index.removeEntry(1, [10, 21]); // remove the middle one by value
		const remaining = index.getPrimaryKeys(1) as number[][];
		expect(remaining).to.have.length(2);
		expect(remaining).to.deep.include.members([[10, 20], [11, 20]]);
		expect(remaining).to.not.deep.include([10, 21]);
	});

	it('single-column integer PK removes across 5n / 5 representations', () => {
		const columns = makeColumns(2);
		// Single-column PK over column 1.
		const index = makeIndex(columns, [{ index: 1 }]);

		index.addEntry(1, 5n);
		expect(index.getPrimaryKeys(1)).to.have.length(1);

		// Remove with a number where a bigint was stored — comparator treats 5n === 5.
		index.removeEntry(1, 5);
		expect(index.getPrimaryKeys(1)).to.have.length(0);
		expect(index.size).to.equal(0);
	});

	it('single-column integer PK dedups 5n vs 5 on add', () => {
		const columns = makeColumns(2);
		const index = makeIndex(columns, [{ index: 1 }]);

		index.addEntry(1, 5n);
		index.addEntry(1, 5); // value-equal under the integer comparator
		expect(index.getPrimaryKeys(1)).to.have.length(1);
	});
});
