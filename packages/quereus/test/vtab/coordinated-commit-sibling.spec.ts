/**
 * Reproduction: MemoryTableManager.commitTransaction sibling path drops a
 * previously-committed sibling connection's changes (last-writer-wins loss).
 *
 * Two connections to the same memory table each open a transaction while the
 * committed head is the same base layer B, and each writes a DISJOINT row into
 * its own pending layer (P1, P2 — both parented on B). They commit sequentially:
 *
 *   conn1.commit  →  head = P1  (chain B ← P1)
 *   conn2.commit  →  sibling branch fires: P2's parent (B) is an ancestor of the
 *                    current head P1, so `foundCommittedLayer` becomes true and
 *                    the manager sets head = P2 (chain B ← P2) — WHOLESALE,
 *                    discarding P1. conn1's committed row vanishes.
 *
 * Expected (post-fix): both rows survive in the committed chain.
 */
import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { MemoryTableModule } from '../../src/vtab/memory/module.js';
import type { MemoryTableManager } from '../../src/vtab/memory/layer/manager.js';
import type { Row } from '../../src/common/types.js';

function getManager(db: Database, tableName: string): MemoryTableManager {
	const mod = db._getVtabModule('memory')?.module as MemoryTableModule | undefined;
	if (!mod) throw new Error('memory module not registered');
	const manager = mod.tables.get(`main.${tableName}`.toLowerCase());
	if (!manager) throw new Error(`no memory manager for table '${tableName}'`);
	return manager;
}

/** Every row currently visible in the committed head, ascending by PK. */
function committedRows(manager: MemoryTableManager): Row[] {
	const tree = manager.currentCommittedLayer.getModificationTree('primary');
	if (!tree) return [];
	return [...tree.entries()];
}

describe('coordinated-commit sibling layer (last-writer-wins loss)', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	it('does not drop a sibling connection\'s already-committed disjoint row', async () => {
		await db.exec('create table t (id integer primary key, v text)');
		await db.exec("insert into t values (1, 'base')");

		const manager = getManager(db, 't');

		// Two connections, both reading the same committed base head B.
		const conn1 = manager.connect();
		const conn2 = manager.connect();
		conn1.explicitTransaction = true;
		conn2.explicitTransaction = true;

		// Each writes a disjoint row into its own pending layer (parented on B).
		await manager.performMutation(conn1, 'insert', [100, 'from-conn1']);
		await manager.performMutation(conn2, 'insert', [200, 'from-conn2']);

		// Sequential commit — the second must not discard the first's row.
		await manager.commitTransaction(conn1);
		await manager.commitTransaction(conn2);

		const ids = committedRows(manager).map(r => r[0]).sort((a, b) => (a as number) - (b as number));
		expect(ids).to.deep.equal([1, 100, 200]);
	});
});
