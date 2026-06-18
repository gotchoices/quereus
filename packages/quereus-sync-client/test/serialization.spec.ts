import { expect } from 'chai';
import {
  serializeChangeSet,
  deserializeChangeSet,
  serializeHLCForTransport,
  deserializeHLCFromTransport,
} from '../src/serialization.js';
import { generateSiteId, type ChangeSet, type HLC } from '@quereus/sync';

describe('Serialization', () => {
  describe('HLC serialization', () => {
    it('should round-trip an HLC', () => {
      const siteId = generateSiteId();
      const hlc: HLC = {
        wallTime: BigInt(Date.now()),
        counter: 42,
        siteId, opSeq: 0
      };

      const serialized = serializeHLCForTransport(hlc);
      expect(serialized).to.be.a('string');

      const deserialized = deserializeHLCFromTransport(serialized);
      expect(deserialized.wallTime).to.equal(hlc.wallTime);
      expect(deserialized.counter).to.equal(hlc.counter);
      expect(deserialized.siteId).to.deep.equal(hlc.siteId);
    });
  });

  describe('ChangeSet serialization', () => {
    it('should round-trip a ChangeSet with column changes', () => {
      const siteId = generateSiteId();
      const hlc: HLC = {
        wallTime: BigInt(Date.now()),
        counter: 1,
        siteId, opSeq: 0
      };

      const changeSet: ChangeSet = {
        siteId,
        transactionId: 'tx-123',
        hlc,
        changes: [
          {
            type: 'column',
            schema: 'main',
            table: 'users',
            pk: [1],
            column: 'name',
            value: 'Alice',
            hlc,
          },
        ],
        schemaMigrations: [],
      };

      const serialized = serializeChangeSet(changeSet);
      expect(serialized.siteId).to.be.a('string');
      expect(serialized.transactionId).to.equal('tx-123');
      expect(serialized.hlc).to.be.a('string');
      expect(serialized.changes).to.have.lengthOf(1);
      expect(serialized.changes[0].hlc).to.be.a('string');

      const deserialized = deserializeChangeSet(serialized);
      expect(deserialized.siteId).to.deep.equal(siteId);
      expect(deserialized.transactionId).to.equal('tx-123');
      expect(deserialized.hlc.wallTime).to.equal(hlc.wallTime);
      expect(deserialized.changes).to.have.lengthOf(1);
      expect(deserialized.changes[0].type).to.equal('column');
      const change = deserialized.changes[0];
      if (change.type === 'column') {
        expect(change.column).to.equal('name');
        expect(change.value).to.equal('Alice');
      }
    });

    it('should round-trip a ChangeSet with delete changes', () => {
      const siteId = generateSiteId();
      const hlc: HLC = {
        wallTime: BigInt(Date.now()),
        counter: 2,
        siteId, opSeq: 0
      };

      const changeSet: ChangeSet = {
        siteId,
        transactionId: 'tx-456',
        hlc,
        changes: [
          {
            type: 'delete',
            schema: 'main',
            table: 'users',
            pk: [99],
            hlc,
          },
        ],
        schemaMigrations: [],
      };

      const serialized = serializeChangeSet(changeSet);
      const deserialized = deserializeChangeSet(serialized);

      expect(deserialized.changes[0].type).to.equal('delete');
      expect(deserialized.changes[0].pk).to.deep.equal([99]);
    });

    it('should round-trip a ChangeSet with schema migrations', () => {
      const siteId = generateSiteId();
      const hlc: HLC = {
        wallTime: BigInt(Date.now()),
        counter: 3,
        siteId, opSeq: 0
      };

      const changeSet: ChangeSet = {
        siteId,
        transactionId: 'tx-789',
        hlc,
        changes: [],
        schemaMigrations: [
          {
            type: 'create_table',
            schema: 'main',
            table: 'new_table',
            ddl: 'CREATE TABLE new_table (id INTEGER PRIMARY KEY)',
            hlc,
            schemaVersion: 1,
          },
        ],
      };

      const serialized = serializeChangeSet(changeSet);
      expect(serialized.schemaMigrations).to.have.lengthOf(1);

      const deserialized = deserializeChangeSet(serialized);
      expect(deserialized.schemaMigrations).to.have.lengthOf(1);
      expect(deserialized.schemaMigrations[0].type).to.equal('create_table');
      expect(deserialized.schemaMigrations[0].ddl).to.include('CREATE TABLE');
    });
  });

  describe('HLC edge cases', () => {
    it('should round-trip an HLC with counter 0', () => {
      const siteId = generateSiteId();
      const hlc: HLC = { wallTime: BigInt(1000), counter: 0, siteId, opSeq: 0 };
      const result = deserializeHLCFromTransport(serializeHLCForTransport(hlc));
      expect(result.wallTime).to.equal(hlc.wallTime);
      expect(result.counter).to.equal(0);
    });

    it('should round-trip an HLC with max counter (65535)', () => {
      const siteId = generateSiteId();
      const hlc: HLC = { wallTime: BigInt(Date.now()), counter: 65535, siteId, opSeq: 0 };
      const result = deserializeHLCFromTransport(serializeHLCForTransport(hlc));
      expect(result.counter).to.equal(65535);
    });

    it('should round-trip an HLC with wallTime 0', () => {
      const siteId = generateSiteId();
      const hlc: HLC = { wallTime: BigInt(0), counter: 0, siteId, opSeq: 0 };
      const result = deserializeHLCFromTransport(serializeHLCForTransport(hlc));
      expect(result.wallTime).to.equal(BigInt(0));
    });

    it('should round-trip an HLC with large wallTime', () => {
      const siteId = generateSiteId();
      const hlc: HLC = { wallTime: BigInt('9999999999999'), counter: 1, siteId, opSeq: 0 };
      const result = deserializeHLCFromTransport(serializeHLCForTransport(hlc));
      expect(result.wallTime).to.equal(BigInt('9999999999999'));
    });
  });

  describe('ChangeSet edge cases', () => {
    it('should round-trip an empty ChangeSet (no changes, no migrations)', () => {
      const siteId = generateSiteId();
      const hlc: HLC = { wallTime: BigInt(Date.now()), counter: 0, siteId, opSeq: 0 };
      const cs: ChangeSet = {
        siteId,
        transactionId: 'tx-empty',
        hlc,
        changes: [],
        schemaMigrations: [],
      };
      const result = deserializeChangeSet(serializeChangeSet(cs));
      expect(result.changes).to.have.lengthOf(0);
      expect(result.schemaMigrations).to.have.lengthOf(0);
      expect(result.transactionId).to.equal('tx-empty');
    });

    it('should round-trip a ChangeSet with multiple changes', () => {
      const siteId = generateSiteId();
      const hlc: HLC = { wallTime: BigInt(Date.now()), counter: 0, siteId, opSeq: 0 };
      const cs: ChangeSet = {
        siteId,
        transactionId: 'tx-multi',
        hlc,
        changes: [
          { type: 'column', schema: 'main', table: 'users', pk: [1], column: 'name', value: 'Alice', hlc },
          { type: 'column', schema: 'main', table: 'users', pk: [1], column: 'email', value: 'a@b.com', hlc },
          { type: 'delete', schema: 'main', table: 'users', pk: [2], hlc },
        ],
        schemaMigrations: [],
      };
      const result = deserializeChangeSet(serializeChangeSet(cs));
      expect(result.changes).to.have.lengthOf(3);
      expect(result.changes[0].type).to.equal('column');
      expect(result.changes[2].type).to.equal('delete');
    });

    it('should preserve null values in column changes', () => {
      const siteId = generateSiteId();
      const hlc: HLC = { wallTime: BigInt(Date.now()), counter: 0, siteId, opSeq: 0 };
      const cs: ChangeSet = {
        siteId,
        transactionId: 'tx-null',
        hlc,
        changes: [
          { type: 'column', schema: 'main', table: 'users', pk: [1], column: 'name', value: null, hlc },
        ],
        schemaMigrations: [],
      };
      const result = deserializeChangeSet(serializeChangeSet(cs));
      const change = result.changes[0];
      if (change.type === 'column') {
        expect(change.value).to.be.null;
      }
    });

    it('should preserve composite primary keys', () => {
      const siteId = generateSiteId();
      const hlc: HLC = { wallTime: BigInt(Date.now()), counter: 0, siteId, opSeq: 0 };
      const cs: ChangeSet = {
        siteId,
        transactionId: 'tx-cpk',
        hlc,
        changes: [
          { type: 'column', schema: 'main', table: 'order_items', pk: [42, 'item-7'], column: 'qty', value: 3, hlc },
        ],
        schemaMigrations: [],
      };
      const result = deserializeChangeSet(serializeChangeSet(cs));
      expect(result.changes[0].pk).to.deep.equal([42, 'item-7']);
    });
  });

  describe('Before-image (prior) round-trip', () => {
    it('keeps the before-image absent when the source had none', () => {
      const siteId = generateSiteId();
      const hlc: HLC = { wallTime: BigInt(Date.now()), counter: 0, siteId, opSeq: 0 };
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

      const serialized = serializeChangeSet(cs);
      // The serialized objects must not carry phantom before-image keys.
      expect(serialized.changes[0]).to.not.have.property('priorValue');
      expect(serialized.changes[0]).to.not.have.property('priorHlc');
      expect(serialized.changes[1]).to.not.have.property('priorRow');

      const result = deserializeChangeSet(serialized);
      const col = result.changes[0];
      const del = result.changes[1];
      // Absent (the key is missing), not merely undefined — catches a phantom key.
      expect('priorValue' in col).to.equal(false);
      expect('priorHlc' in col).to.equal(false);
      expect('priorRow' in del).to.equal(false);
    });

    it('round-trips a column before-image incl. Uint8Array and bigint', () => {
      const siteId = generateSiteId();
      const hlc: HLC = { wallTime: BigInt(Date.now()), counter: 5, siteId, opSeq: 0 };
      const priorHlc: HLC = { wallTime: BigInt(1234567890), counter: 7, siteId, opSeq: 3 };
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

      const result = deserializeChangeSet(serializeChangeSet(cs));
      const blobChange = result.changes[0];
      const bigChange = result.changes[1];
      if (blobChange.type === 'column') {
        expect(blobChange.priorValue).to.be.instanceOf(Uint8Array);
        expect(Array.from(blobChange.priorValue as Uint8Array)).to.deep.equal([0, 1, 127, 255]);
        expect(blobChange.priorHlc).to.not.be.undefined;
        expect(blobChange.priorHlc!.wallTime).to.equal(BigInt(1234567890));
        expect(blobChange.priorHlc!.counter).to.equal(7);
      }
      if (bigChange.type === 'column') {
        expect(bigChange.priorValue).to.equal(9007199254740993n);
      }
    });

    it('round-trips a delete priorRow incl. Uint8Array, bigint, and null cells', () => {
      const siteId = generateSiteId();
      const hlc: HLC = { wallTime: BigInt(Date.now()), counter: 0, siteId, opSeq: 0 };
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

      const result = deserializeChangeSet(serializeChangeSet(cs));
      const del = result.changes[0];
      if (del.type === 'delete') {
        expect(del.priorRow).to.not.be.undefined;
        expect(del.priorRow![0]).to.equal(42n);
        expect(del.priorRow![1]).to.equal('Alice');
        expect(del.priorRow![2]).to.be.instanceOf(Uint8Array);
        expect(Array.from(del.priorRow![2] as Uint8Array)).to.deep.equal([9, 8, 7]);
        expect(del.priorRow![3]).to.be.null;
      }
    });

    it('preserves the empty-array priorRow boundary (present [] vs absent)', () => {
      const siteId = generateSiteId();
      const hlc: HLC = { wallTime: BigInt(Date.now()), counter: 0, siteId, opSeq: 0 };
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

      const serialized = serializeChangeSet(cs);
      // An empty array is present on the wire; the bare delete stays absent.
      expect(serialized.changes[0]).to.have.property('priorRow');
      expect(serialized.changes[0].priorRow).to.have.lengthOf(0);
      expect(serialized.changes[1]).to.not.have.property('priorRow');

      const result = deserializeChangeSet(serialized);
      const present = result.changes[0];
      const absent = result.changes[1];
      if (present.type === 'delete') {
        expect(present.priorRow).to.not.be.undefined;
        expect(present.priorRow).to.have.lengthOf(0);
      }
      expect('priorRow' in absent).to.equal(false);
    });
  });
});

