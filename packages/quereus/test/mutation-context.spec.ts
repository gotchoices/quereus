import { describe, it } from 'mocha';
import { expect } from 'chai';
import { Database } from '../src/core/database.js';

describe('Mutation Context (Programmatic Tests)', () => {
	it('should validate schema mutation context metadata', async () => {
		const db = new Database();

		await db.exec(`
			CREATE TABLE users (
				id INTEGER PRIMARY KEY,
				name TEXT,
				created_by TEXT DEFAULT actor_name
			) USING memory
			WITH CONTEXT (
				actor_name TEXT,
				operation_signature BLOB NULL
			)
		`);

		const schema = db.schemaManager.getTable('main', 'users');
		expect(schema).to.exist;
		expect(schema?.mutationContext).to.have.lengthOf(2);
		expect(schema?.mutationContext?.[0].name).to.equal('actor_name');
		expect(schema?.mutationContext?.[0].notNull).to.be.true;
		expect(schema?.mutationContext?.[1].name).to.equal('operation_signature');
		expect(schema?.mutationContext?.[1].notNull).to.be.false;
	});
});

