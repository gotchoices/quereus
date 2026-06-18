/**
 * Tests for shared serialization utilities.
 */

import { expect } from 'chai';
import {
	createHLC,
	generateSiteId,
	siteIdToBase64,
	type ChangeSet,
	type SnapshotChunk,
	type SchemaMigration,
} from '@quereus/sync';
import {
	serializeChangeSet,
	deserializeChangeSet,
	serializeSnapshotChunk,
	deserializeSnapshotChunk,
} from '../src/common/serialization.js';

function makeTestHLC() {
	return createHLC(BigInt(Date.now()) * 1000n, 0, generateSiteId());
}

function makeTestChangeSet(): ChangeSet {
	const siteId = generateSiteId();
	const hlc = createHLC(BigInt(Date.now()) * 1000n, 1, siteId);
	return {
		siteId,
		transactionId: 'tx-123',
		hlc,
		changes: [
			{
				type: 'column' as const,
				schema: 'main',
				table: 'users',
				pk: ['user-1'],
				column: 'name',
				value: 'Alice',
				hlc: createHLC(BigInt(Date.now()) * 1000n, 2, siteId),
			},
		],
		schemaMigrations: [
			{
				type: 'create-table' as const,
				schema: 'main',
				table: 'users',
				hlc: createHLC(BigInt(Date.now()) * 1000n, 3, siteId),
				sql: 'create table users (id text primary key, name text)',
			} as SchemaMigration,
		],
	};
}

describe('Serialization', () => {
	describe('serializeChangeSet / deserializeChangeSet', () => {
		it('should round-trip a ChangeSet through serialize then deserialize', () => {
			const original = makeTestChangeSet();
			const serialized = serializeChangeSet(original);
			const deserialized = deserializeChangeSet(serialized);

			// siteId should round-trip
			expect(siteIdToBase64(deserialized.siteId)).to.equal(siteIdToBase64(original.siteId));
			expect(deserialized.transactionId).to.equal(original.transactionId);

			// HLC should round-trip (compare wallTime and counter)
			expect(deserialized.hlc.wallTime).to.equal(original.hlc.wallTime);
			expect(deserialized.hlc.counter).to.equal(original.hlc.counter);

			// Changes should round-trip
			expect(deserialized.changes).to.have.length(1);
			const change = deserialized.changes[0] as any;
			expect(change.type).to.equal('column');
			expect(change.schema).to.equal('main');
			expect(change.table).to.equal('users');
			expect(change.value).to.equal('Alice');
			expect(change.hlc.wallTime).to.equal((original.changes[0] as any).hlc.wallTime);

			// Schema migrations should round-trip
			expect(deserialized.schemaMigrations).to.have.length(1);
			const migration = deserialized.schemaMigrations[0] as any;
			expect(migration.type).to.equal('create-table');
			expect(migration.hlc.wallTime).to.equal((original.schemaMigrations[0] as any).hlc.wallTime);
		});

		it('should produce JSON-safe output (no BigInt, no Uint8Array)', () => {
			const original = makeTestChangeSet();
			const serialized = serializeChangeSet(original);

			// Should be JSON-serializable without error
			const json = JSON.stringify(serialized);
			expect(json).to.be.a('string');

			// siteId should be a base64 string
			expect((serialized as any).siteId).to.be.a('string');
			// hlc should be a base64 string
			expect((serialized as any).hlc).to.be.a('string');
		});

		it('should handle empty changes and schemaMigrations', () => {
			const siteId = generateSiteId();
			const cs: ChangeSet = {
				siteId,
				transactionId: 'tx-empty',
				hlc: makeTestHLC(),
				changes: [],
				schemaMigrations: [],
			};

			const serialized = serializeChangeSet(cs);
			const deserialized = deserializeChangeSet(serialized);

			expect(deserialized.changes).to.have.length(0);
			expect(deserialized.schemaMigrations).to.have.length(0);
			expect(deserialized.transactionId).to.equal('tx-empty');
		});
	});

	describe('before-image (prior) round-trip', () => {
		it('keeps the before-image absent when the source had none', () => {
			const siteId = generateSiteId();
			const hlc = createHLC(BigInt(Date.now()) * 1000n, 0, siteId);
			const cs: ChangeSet = {
				siteId,
				transactionId: 'tx-absent',
				hlc,
				changes: [
					{ type: 'column', schema: 'main', table: 'users', pk: [1], column: 'name', value: 'Alice', hlc },
					{ type: 'delete', schema: 'main', table: 'users', pk: [2], hlc },
				],
				schemaMigrations: [],
			};

			const serialized = serializeChangeSet(cs) as any;
			expect(serialized.changes[0]).to.not.have.property('priorValue');
			expect(serialized.changes[0]).to.not.have.property('priorHlc');
			expect(serialized.changes[1]).to.not.have.property('priorRow');

			const result = deserializeChangeSet(serialized);
			const col = result.changes[0];
			const del = result.changes[1];
			expect('priorValue' in col).to.equal(false);
			expect('priorHlc' in col).to.equal(false);
			expect('priorRow' in del).to.equal(false);
		});

		it('round-trips a column before-image incl. Uint8Array and bigint', () => {
			const siteId = generateSiteId();
			const hlc = createHLC(BigInt(Date.now()) * 1000n, 5, siteId);
			const priorHlc = createHLC(BigInt(1234567890), 7, siteId, 3);
			const priorBlob = new Uint8Array([0, 1, 127, 255]);
			const cs: ChangeSet = {
				siteId,
				transactionId: 'tx-prior-col',
				hlc,
				changes: [
					{
						type: 'column', schema: 'main', table: 'docs', pk: [1], column: 'blob',
						value: 'v2', hlc, priorValue: priorBlob, priorHlc,
					},
					{
						type: 'column', schema: 'main', table: 'docs', pk: [2], column: 'big',
						value: 'v2', hlc, priorValue: 9007199254740993n, priorHlc,
					},
				],
				schemaMigrations: [],
			};

			// Route through actual JSON.stringify/parse — the real wire hop — so a value
			// that slipped through unencoded (a raw bigint/Uint8Array) would throw or
			// corrupt here rather than pass silently on an in-process object.
			const result = deserializeChangeSet(JSON.parse(JSON.stringify(serializeChangeSet(cs))));
			const blobChange = result.changes[0] as any;
			const bigChange = result.changes[1] as any;
			expect(blobChange.priorValue).to.be.instanceOf(Uint8Array);
			expect(Array.from(blobChange.priorValue as Uint8Array)).to.deep.equal([0, 1, 127, 255]);
			expect(blobChange.priorHlc.wallTime).to.equal(BigInt(1234567890));
			expect(blobChange.priorHlc.counter).to.equal(7);
			// The before-image HLC's per-transaction sub-order survives the wire too.
			expect(blobChange.priorHlc.opSeq).to.equal(3);
			expect(bigChange.priorValue).to.equal(9007199254740993n);
		});

		it('round-trips a delete priorRow incl. Uint8Array, bigint, and null cells', () => {
			const siteId = generateSiteId();
			const hlc = createHLC(BigInt(Date.now()) * 1000n, 0, siteId);
			const blob = new Uint8Array([9, 8, 7]);
			const cs: ChangeSet = {
				siteId,
				transactionId: 'tx-prior-row',
				hlc,
				changes: [
					{
						type: 'delete', schema: 'main', table: 'users', pk: [1], hlc,
						priorRow: [42n, 'Alice', blob, null],
					},
				],
				schemaMigrations: [],
			};

			const result = deserializeChangeSet(JSON.parse(JSON.stringify(serializeChangeSet(cs))));
			const del = result.changes[0] as any;
			expect(del.priorRow).to.not.be.undefined;
			expect(del.priorRow[0]).to.equal(42n);
			expect(del.priorRow[1]).to.equal('Alice');
			expect(del.priorRow[2]).to.be.instanceOf(Uint8Array);
			expect(Array.from(del.priorRow[2] as Uint8Array)).to.deep.equal([9, 8, 7]);
			expect(del.priorRow[3]).to.be.null;
		});

		it('preserves the empty-array priorRow boundary (present [] vs absent)', () => {
			const siteId = generateSiteId();
			const hlc = createHLC(BigInt(Date.now()) * 1000n, 0, siteId);
			const cs: ChangeSet = {
				siteId,
				transactionId: 'tx-empty-row',
				hlc,
				changes: [
					{ type: 'delete', schema: 'main', table: 'users', pk: [1], hlc, priorRow: [] },
					{ type: 'delete', schema: 'main', table: 'users', pk: [2], hlc },
				],
				schemaMigrations: [],
			};

			const serialized = serializeChangeSet(cs) as any;
			expect(serialized.changes[0]).to.have.property('priorRow');
			expect(serialized.changes[0].priorRow).to.have.lengthOf(0);
			expect(serialized.changes[1]).to.not.have.property('priorRow');

			const result = deserializeChangeSet(serialized);
			const present = result.changes[0] as any;
			const absent = result.changes[1];
			expect(present.priorRow).to.not.be.undefined;
			expect(present.priorRow).to.have.lengthOf(0);
			expect('priorRow' in absent).to.equal(false);
		});
	});

	describe('serializeSnapshotChunk', () => {
		it('should serialize header chunk with base64 fields', () => {
			const siteId = generateSiteId();
			const hlc = makeTestHLC();
			const chunk: SnapshotChunk = {
				type: 'header',
				siteId,
				hlc,
				tableCount: 3,
				migrationCount: 1,
				snapshotId: 'snap-1',
			};

			const serialized = serializeSnapshotChunk(chunk) as any;

			expect(serialized.type).to.equal('header');
			expect(serialized.siteId).to.be.a('string');
			expect(serialized.hlc).to.be.a('string');
			expect(serialized.tableCount).to.equal(3);
			expect(serialized.snapshotId).to.equal('snap-1');

			// Should be JSON-safe
			expect(() => JSON.stringify(serialized)).to.not.throw();
		});

		it('should serialize column-versions chunk with base64 HLCs', () => {
			const hlc = makeTestHLC();
			const chunk: SnapshotChunk = {
				type: 'column-versions',
				schema: 'main',
				table: 'users',
				entries: [['key1', hlc, 'value1']],
			};

			const serialized = serializeSnapshotChunk(chunk) as any;

			expect(serialized.type).to.equal('column-versions');
			expect(serialized.entries).to.have.length(1);
			expect(serialized.entries[0][0]).to.equal('key1');
			expect(serialized.entries[0][1]).to.be.a('string'); // HLC as base64
			expect(serialized.entries[0][2]).to.equal('value1');
		});

		it('should serialize schema-migration chunk with base64 HLC', () => {
			const hlc = makeTestHLC();
			const chunk: SnapshotChunk = {
				type: 'schema-migration',
				migration: {
					type: 'create-table',
					schema: 'main',
					table: 'items',
					hlc,
					sql: 'create table items (id text primary key)',
				} as SchemaMigration,
			};

			const serialized = serializeSnapshotChunk(chunk) as any;

			expect(serialized.type).to.equal('schema-migration');
			expect(serialized.migration.hlc).to.be.a('string');
			expect(serialized.migration.type).to.equal('create-table');
		});

		it('should pass through table-start/table-end/footer chunks unchanged', () => {
			const tableStart: SnapshotChunk = {
				type: 'table-start',
				schema: 'main',
				table: 'users',
				estimatedEntries: 100,
			};
			const tableEnd: SnapshotChunk = {
				type: 'table-end',
				schema: 'main',
				table: 'users',
				entriesWritten: 95,
			};
			const footer: SnapshotChunk = {
				type: 'footer',
				snapshotId: 'snap-1',
				totalTables: 3,
				totalEntries: 200,
				totalMigrations: 1,
			};

			expect(serializeSnapshotChunk(tableStart)).to.deep.equal(tableStart);
			expect(serializeSnapshotChunk(tableEnd)).to.deep.equal(tableEnd);
			expect(serializeSnapshotChunk(footer)).to.deep.equal(footer);
		});
	});

	describe('deserializeSnapshotChunk (round-trip)', () => {
		it('should round-trip header chunk through serialize then deserialize', () => {
			const siteId = generateSiteId();
			const hlc = makeTestHLC();
			const original: SnapshotChunk = {
				type: 'header',
				siteId,
				hlc,
				tableCount: 5,
				migrationCount: 2,
				snapshotId: 'snap-rt-1',
			};

			const serialized = serializeSnapshotChunk(original);
			const deserialized = deserializeSnapshotChunk(serialized);

			expect(deserialized.type).to.equal('header');
			const hdr = deserialized as typeof original;
			expect(siteIdToBase64(hdr.siteId)).to.equal(siteIdToBase64(siteId));
			expect(hdr.hlc.wallTime).to.equal(hlc.wallTime);
			expect(hdr.hlc.counter).to.equal(hlc.counter);
			expect(hdr.tableCount).to.equal(5);
			expect(hdr.migrationCount).to.equal(2);
			expect(hdr.snapshotId).to.equal('snap-rt-1');
		});

		it('should round-trip column-versions chunk through serialize then deserialize', () => {
			const hlc = makeTestHLC();
			const original: SnapshotChunk = {
				type: 'column-versions',
				schema: 'main',
				table: 'items',
				entries: [
					['pk1', hlc, 'value-a'],
					['pk2', hlc, 42],
				],
			};

			const serialized = serializeSnapshotChunk(original);
			const deserialized = deserializeSnapshotChunk(serialized);

			expect(deserialized.type).to.equal('column-versions');
			const cv = deserialized as typeof original;
			expect(cv.schema).to.equal('main');
			expect(cv.table).to.equal('items');
			expect(cv.entries).to.have.length(2);
			expect(cv.entries[0][0]).to.equal('pk1');
			expect(cv.entries[0][1].wallTime).to.equal(hlc.wallTime);
			expect(cv.entries[0][2]).to.equal('value-a');
			expect(cv.entries[1][0]).to.equal('pk2');
			expect(cv.entries[1][2]).to.equal(42);
		});

		it('should round-trip schema-migration chunk through serialize then deserialize', () => {
			const hlc = makeTestHLC();
			const original: SnapshotChunk = {
				type: 'schema-migration',
				migration: {
					type: 'create-table',
					schema: 'main',
					table: 'products',
					hlc,
					sql: 'create table products (id text primary key, name text)',
				} as SchemaMigration,
			};

			const serialized = serializeSnapshotChunk(original);
			const deserialized = deserializeSnapshotChunk(serialized);

			expect(deserialized.type).to.equal('schema-migration');
			const sm = deserialized as typeof original;
			expect(sm.migration.type).to.equal('create-table');
			expect(sm.migration.hlc.wallTime).to.equal(hlc.wallTime);
			expect((sm.migration as any).sql).to.equal('create table products (id text primary key, name text)');
		});

		it('should round-trip pass-through chunks unchanged', () => {
			const footer: SnapshotChunk = {
				type: 'footer',
				snapshotId: 'snap-2',
				totalTables: 10,
				totalEntries: 500,
				totalMigrations: 3,
			};

			const serialized = serializeSnapshotChunk(footer);
			const deserialized = deserializeSnapshotChunk(serialized);

			expect(deserialized).to.deep.equal(footer);
		});

		it('should survive JSON.stringify/parse round-trip (simulates S3 storage)', () => {
			const siteId = generateSiteId();
			const hlc = makeTestHLC();
			const chunks: SnapshotChunk[] = [
				{
					type: 'header',
					siteId,
					hlc,
					tableCount: 1,
					migrationCount: 0,
					snapshotId: 'snap-json-rt',
				},
				{
					type: 'table-start',
					schema: 'main',
					table: 'data',
					estimatedEntries: 2,
				},
				{
					type: 'column-versions',
					schema: 'main',
					table: 'data',
					entries: [['row1', hlc, 'hello']],
				},
				{
					type: 'table-end',
					schema: 'main',
					table: 'data',
					entriesWritten: 1,
				},
				{
					type: 'footer',
					snapshotId: 'snap-json-rt',
					totalTables: 1,
					totalEntries: 1,
					totalMigrations: 0,
				},
			];

			// Simulate S3 store/download: serialize → JSON.stringify → JSON.parse → deserialize
			const serialized = chunks.map(c => serializeSnapshotChunk(c));
			const json = JSON.stringify(serialized);
			const parsed = JSON.parse(json) as unknown[];
			const restored = parsed.map(c => deserializeSnapshotChunk(c));

			expect(restored).to.have.length(5);
			expect(restored[0].type).to.equal('header');
			const hdr = restored[0] as any;
			expect(siteIdToBase64(hdr.siteId)).to.equal(siteIdToBase64(siteId));
			expect(hdr.hlc.wallTime).to.equal(hlc.wallTime);

			expect(restored[2].type).to.equal('column-versions');
			const cv = restored[2] as any;
			expect(cv.entries[0][0]).to.equal('row1');
			expect(cv.entries[0][1].wallTime).to.equal(hlc.wallTime);
			expect(cv.entries[0][2]).to.equal('hello');

			expect(restored[4].type).to.equal('footer');
		});
	});
});
