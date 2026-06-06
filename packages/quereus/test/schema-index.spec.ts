import { describe, it } from 'mocha';
import { Database } from '../src/index.js';
import assert from 'node:assert';

describe('schema() introspection - Internal API', () => {
	it('should store indexes in schemaManager when created', async () => {
		const db = new Database();

		await db.exec(`
			CREATE TABLE products (
				id INTEGER PRIMARY KEY,
				name TEXT,
				category TEXT
			)
		`);
		await db.exec('CREATE INDEX idx_category ON products(category)');
		await db.exec('CREATE INDEX idx_name ON products(name)');

		// Verify indexes exist in schemaManager (internal API check)
		const table = db.schemaManager.getTable('main', 'products');
		assert(table?.indexes?.length === 2, 'Should have 2 indexes in schemaManager');
		assert(table?.indexes?.[0].name === 'idx_category', 'First index name should be idx_category');
		assert(table?.indexes?.[1].name === 'idx_name', 'Second index name should be idx_name');

		// Verify index structure
		const idxCategory = table?.indexes?.[0];
		assert(idxCategory?.columns.length === 1, 'idx_category should have 1 column');
		assert(idxCategory?.columns[0].index === 2, 'idx_category should reference column index 2 (category)');
	});

	it('should store composite index structure correctly', async () => {
		const db = new Database();

		await db.exec(`
			CREATE TABLE orders (
				id INTEGER PRIMARY KEY,
				customer_id INTEGER,
				status TEXT
			)
		`);
		await db.exec('CREATE INDEX idx_customer_status ON orders(customer_id, status)');

		const table = db.schemaManager.getTable('main', 'orders');
		const index = table?.indexes?.[0];

		assert(index?.name === 'idx_customer_status', 'Index name should be idx_customer_status');
		assert(index?.columns.length === 2, 'Composite index should have 2 columns');
		assert(index?.columns[0].index === 1, 'First column should be customer_id (index 1)');
		assert(index?.columns[1].index === 2, 'Second column should be status (index 2)');
	});

	it('should store index DESC modifier in schemaManager', async () => {
		const db = new Database();

		await db.exec(`
			CREATE TABLE docs (
				id INTEGER PRIMARY KEY,
				created_at TEXT
			)
		`);
		await db.exec('CREATE INDEX idx_created_desc ON docs(created_at DESC)');

		const table = db.schemaManager.getTable('main', 'docs');
		const index = table?.indexes?.[0];

		assert(index?.columns[0].desc === true, 'Index column should have desc=true');
	});
});
