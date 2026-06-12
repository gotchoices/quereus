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

/**
 * A child index whose BTree inherits from `base`'s tree (the same wiring a
 * TransactionLayer uses: `new MemoryIndex(..., parentSecondaryTree)`). Entries
 * reachable only through `base.data` are INHERITED for the child — the child's
 * per-instance `ownedEntries` WeakSet does not contain them — so add/remove must
 * copy-on-write (clone the sorted array via `slice()`) rather than mutate the
 * shared entry in place.
 */
function makeChildIndex(columns: ColumnSchema[], pkDefinition: PrimaryKeyColumnDefinition[], base: MemoryIndex): MemoryIndex {
	const pkCompare = createPrimaryKeyFunctions(makeSchema(columns, pkDefinition)).compare;
	return new MemoryIndex({ name: 'idx', columns: [{ index: 0 }] }, columns, pkCompare, base.data);
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

	// The copy-on-write discipline that keeps a layer's writes from corrupting the
	// committed base it inherits from. The container changed from `new Set(existing)`
	// to `existing.slice()`, so these guard the new sorted-array clone path.
	describe('inherited copy-on-write (array container) isolates the base', () => {
		it('inherited addEntry of a distinct composite PK does not mutate the base entry', () => {
			const columns = makeColumns(3);
			const pk = [{ index: 1 }, { index: 2 }];
			const base = makeIndex(columns, pk);
			base.addEntry(1, [10, 20]);

			const child = makeChildIndex(columns, pk, base);
			// Inherited entry (owned by `base`, not `child`): must clone before insert.
			child.addEntry(1, [10, 21]);

			// Child sees both PKs; base is untouched (no write-through to committed state).
			expect(child.getPrimaryKeys(1)).to.have.length(2);
			expect(base.getPrimaryKeys(1)).to.deep.equal([[10, 20]]);
		});

		it('inherited removeEntry that empties the entry leaves the base entry intact', () => {
			const columns = makeColumns(3);
			const pk = [{ index: 1 }, { index: 2 }];
			const base = makeIndex(columns, pk);
			base.addEntry(1, [10, 20]);

			const child = makeChildIndex(columns, pk, base);
			// Fresh equal-by-value array removes by value through the inherited COW path.
			child.removeEntry(1, [10, 20]);

			// Masked in the child (a rolled-back delete must not strip the live base PK).
			expect(child.getPrimaryKeys(1)).to.have.length(0);
			expect(base.getPrimaryKeys(1)).to.deep.equal([[10, 20]]);
		});

		it('inherited addEntry of an already-present PK does not duplicate or mutate the base', () => {
			const columns = makeColumns(3);
			const pk = [{ index: 1 }, { index: 2 }];
			const base = makeIndex(columns, pk);
			base.addEntry(1, [10, 20]);

			const child = makeChildIndex(columns, pk, base);
			child.addEntry(1, [10, 20]); // value-equal: COW no-op, still must not dup

			expect(child.getPrimaryKeys(1)).to.deep.equal([[10, 20]]);
			expect(base.getPrimaryKeys(1)).to.deep.equal([[10, 20]]);
		});
	});
});
