/**
 * Unknown-table disposition + telemetry.
 *
 * A retired-table straggler delta — inbound changes for a table outside the
 * local basis — is diverted during Phase 1 resolution and either quarantined
 * (default) or ignored per `SyncConfig.unknownTableDisposition`, with always-on
 * telemetry (`onUnknownTable` + `getUnknownTableStats`). See
 * `docs/migration.md` § 4 Contract and the `sync-unknown-table-disposition`
 * ticket § Edge cases & interactions — this spec covers each case there.
 */

import { expect } from 'chai';
import type { TableSchema } from '@quereus/quereus';
import { SyncManagerImpl } from '../../src/sync/sync-manager-impl.js';
import { SyncEventEmitterImpl, type UnknownTableEvent } from '../../src/sync/events.js';
import {
  DEFAULT_SYNC_CONFIG,
  type SyncConfig,
  type ChangeSet,
  type Change,
  type ColumnChange,
  type RowDeletion,
  type DataChangeToApply,
  type SchemaChangeToApply,
  type SchemaMigration,
  type UnknownTableDisposition,
} from '../../src/sync/protocol.js';
import { InMemoryKVStore } from '@quereus/store';
import { generateSiteId, siteIdEquals, type SiteId } from '../../src/clock/site.js';
import { compareHLC, createHLC } from '../../src/clock/hlc.js';
import { FakeTransactionSource } from '../helpers/fake-transaction-source.js';

interface ApplyCall {
  data: DataChangeToApply[];
  schema: SchemaChangeToApply[];
}

interface Harness {
  manager: SyncManagerImpl;
  syncEvents: SyncEventEmitterImpl;
  applyCalls: ApplyCall[];
  events: UnknownTableEvent[];
  remoteSite: SiteId;
}

async function makeHarness(opts: {
  disposition?: UnknownTableDisposition;
  known?: string[];                 // 'schema.table' in the local basis
  retentionHorizonMs?: number;
  withOracle?: boolean;             // default true
} = {}): Promise<Harness> {
  const kv = new InMemoryKVStore();
  const source = new FakeTransactionSource();
  const syncEvents = new SyncEventEmitterImpl();
  const config: SyncConfig = {
    ...DEFAULT_SYNC_CONFIG,
    unknownTableDisposition: opts.disposition ?? DEFAULT_SYNC_CONFIG.unknownTableDisposition,
    ...(opts.retentionHorizonMs !== undefined ? { retentionHorizonMs: opts.retentionHorizonMs } : {}),
  };

  const applyCalls: ApplyCall[] = [];
  const applyToStore = async (data: DataChangeToApply[], schema: SchemaChangeToApply[]) => {
    applyCalls.push({ data, schema });
    return { dataChangesApplied: data.length, schemaChangesApplied: schema.length, errors: [] };
  };

  const known = new Set(opts.known ?? ['main.users']);
  const withOracle = opts.withOracle ?? true;
  // The oracle only needs identity (undefined ⇒ out of basis); a non-undefined
  // stub stands in for the basis table's schema.
  const getTableSchema = withOracle
    ? (schema: string, table: string): TableSchema | undefined =>
        known.has(`${schema}.${table}`) ? ({} as TableSchema) : undefined
    : undefined;

  const manager = await SyncManagerImpl.create(kv, source, config, syncEvents, applyToStore, getTableSchema);

  const events: UnknownTableEvent[] = [];
  syncEvents.onUnknownTable(e => events.push(e));

  return { manager, syncEvents, applyCalls, events, remoteSite: generateSiteId() };
}

function col(site: SiteId, wall: number, table: string, pk: number, column: string, value: string, opSeq = 0): ColumnChange {
  return { type: 'column', schema: 'main', table, pk: [pk], column, value, hlc: createHLC(BigInt(wall), 1, site, opSeq) };
}

function del(site: SiteId, wall: number, table: string, pk: number, opSeq = 0): RowDeletion {
  return { type: 'delete', schema: 'main', table, pk: [pk], hlc: createHLC(BigInt(wall), 1, site, opSeq) };
}

function changeSet(site: SiteId, txId: string, changes: Change[], migrations: SchemaMigration[] = []): ChangeSet {
  const hlcs = [...changes.map(c => c.hlc), ...migrations.map(m => m.hlc)];
  const hlc = hlcs.reduce((m, h) => (compareHLC(h, m) > 0 ? h : m), hlcs[0]);
  return { siteId: site, transactionId: txId, hlc, changes, schemaMigrations: migrations };
}

const RETIRED = 'orders'; // out of basis (basis is { main.users })

describe('unknown-table disposition', () => {
  describe('quarantine (default)', () => {
    it('diverts an out-of-basis change to quarantine, applies nothing, telemeters', async () => {
      const h = await makeHarness();
      const change = col(h.remoteSite, 1000, RETIRED, 1, 'note', 'hi');

      const result = await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-1', [change])]);

      // Not applied, diverted.
      expect(result.applied).to.equal(0);
      expect(result.unknownTable).to.equal(1);
      // applyToStore never saw it (no data/schema to apply).
      expect(h.applyCalls).to.have.lengthOf(0);

      // Durably quarantined, verbatim.
      const held = await h.manager.quarantine.list('main', RETIRED);
      expect(held).to.have.lengthOf(1);
      expect(held[0].change).to.deep.equal(change);

      // Telemetry: event + counters.
      expect(h.events).to.have.lengthOf(1);
      expect(h.events[0].disposition).to.equal('quarantine');
      expect(h.events[0].table).to.equal(RETIRED);
      expect(h.events[0].changeCount).to.equal(1);
      expect(siteIdEquals(h.events[0].siteId, h.remoteSite)).to.be.true;
      expect(compareHLC(h.events[0].latestHLC, change.hlc)).to.equal(0);

      const stats = h.manager.getUnknownTableStats();
      expect(stats.quarantined).to.equal(1);
      expect(stats.ignored).to.equal(0);
      expect(stats.byTable.get(`main.${RETIRED}`)).to.equal(1);
    });

    it('writes no CRDT metadata for the unknown table (change log / versions stay clean)', async () => {
      const h = await makeHarness();
      await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-1', [
        col(h.remoteSite, 1000, RETIRED, 1, 'note', 'hi'),
        del(h.remoteSite, 1001, RETIRED, 2),
      ])]);

      // No column version, no tombstone for the retired table.
      expect(await h.manager.columnVersions.getColumnVersion('main', RETIRED, [1], 'note')).to.be.undefined;
      expect(await h.manager.tombstones.getTombstone('main', RETIRED, [2])).to.be.undefined;

      // getChangesSince surfaces nothing for the retired table.
      const sets = await h.manager.getChangesSince(generateSiteId());
      const retiredChanges = sets.flatMap(s => s.changes).filter(c => c.table === RETIRED);
      expect(retiredChanges).to.have.lengthOf(0);
    });

    it('quarantines both deletes and column changes verbatim', async () => {
      const h = await makeHarness();
      const c = col(h.remoteSite, 1000, RETIRED, 1, 'note', 'x');
      const d = del(h.remoteSite, 1001, RETIRED, 2);
      await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-1', [c, d])]);

      const held = await h.manager.quarantine.list('main', RETIRED);
      expect(held.map(e => e.change)).to.have.deep.members([c, d]);
    });

    it('is idempotent: re-applying the same batch yields one entry per HLC', async () => {
      const h = await makeHarness();
      const batch = [changeSet(h.remoteSite, 'tx-1', [
        col(h.remoteSite, 1000, RETIRED, 1, 'note', 'x'),
        col(h.remoteSite, 1001, RETIRED, 1, 'note2', 'y'),
      ])];

      await h.manager.applyChanges(batch);
      await h.manager.applyChanges(batch); // re-delivery (simulated crash before watermark)

      const held = await h.manager.quarantine.list('main', RETIRED);
      expect(held, 'one entry per change, not duplicated').to.have.lengthOf(2);
    });
  });

  describe('ignore', () => {
    it('drops the changes but still telemeters (event + ignored counter, no qt: entry)', async () => {
      const h = await makeHarness({ disposition: 'ignore' });
      const result = await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-1', [
        col(h.remoteSite, 1000, RETIRED, 1, 'note', 'hi'),
      ])]);

      expect(result.applied).to.equal(0);
      expect(result.unknownTable).to.equal(1);
      expect(h.applyCalls).to.have.lengthOf(0);

      // Nothing held.
      expect(await h.manager.quarantine.list('main', RETIRED)).to.have.lengthOf(0);

      // But the operator still sees it.
      expect(h.events).to.have.lengthOf(1);
      expect(h.events[0].disposition).to.equal('ignore');
      const stats = h.manager.getUnknownTableStats();
      expect(stats.ignored).to.equal(1);
      expect(stats.quarantined).to.equal(0);
    });
  });

  describe('detection edges', () => {
    it('applies a batch that creates a table and writes to it (in-batch DDL), quarantining nothing', async () => {
      const h = await makeHarness();
      const ddlHlc = createHLC(BigInt(900), 1, h.remoteSite, 0);
      const migration: SchemaMigration = {
        type: 'create_table', schema: 'main', table: 'foo',
        ddl: 'create table foo (id integer primary key, note text)', hlc: ddlHlc, schemaVersion: 1,
      };
      const change = col(h.remoteSite, 1000, 'foo', 1, 'note', 'hi', 1);

      const result = await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-1', [change], [migration])]);

      // create_table makes 'foo' known despite the oracle not knowing it yet.
      expect(result.unknownTable).to.be.undefined;
      expect(await h.manager.quarantine.list('main', 'foo')).to.have.lengthOf(0);
      // The data change reached applyToStore and was recorded.
      expect(result.applied).to.equal(2); // migration + column
      const dataApplied = h.applyCalls.flatMap(c => c.data).filter(d => d.table === 'foo');
      expect(dataApplied).to.have.lengthOf(1);
    });

    it('diverts changes to a table the batch drops', async () => {
      const h = await makeHarness({ known: ['main.users', 'main.legacy'] });
      const dropHlc = createHLC(BigInt(900), 1, h.remoteSite, 0);
      const migration: SchemaMigration = {
        type: 'drop_table', schema: 'main', table: 'legacy', ddl: 'drop table legacy', hlc: dropHlc, schemaVersion: 2,
      };
      const change = col(h.remoteSite, 1000, 'legacy', 1, 'note', 'hi', 1);

      const result = await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-1', [change], [migration])]);

      // drop_table removes 'legacy' from the effective basis for this batch.
      expect(result.unknownTable).to.equal(1);
      expect(await h.manager.quarantine.list('main', 'legacy')).to.have.lengthOf(1);
    });

    it('never quarantines a self-origin change to a retired table (echo skip first)', async () => {
      const h = await makeHarness();
      const self = h.manager.getSiteId();
      const result = await h.manager.applyChanges([changeSet(self, 'tx-self', [
        col(self, 1000, RETIRED, 1, 'note', 'hi'),
      ])]);

      expect(result.unknownTable).to.be.undefined;
      expect(result.skipped).to.equal(1);
      expect(await h.manager.quarantine.list('main', RETIRED)).to.have.lengthOf(0);
      expect(h.events).to.have.lengthOf(0);
    });

    it('mixed batch: applies known-table changes and diverts only the unknown ones', async () => {
      const h = await makeHarness();
      const known = col(h.remoteSite, 1000, 'users', 1, 'name', 'Alice');
      const unknown = col(h.remoteSite, 1001, RETIRED, 1, 'note', 'hi');

      const result = await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-1', [known, unknown])]);

      expect(result.applied).to.equal(1);
      expect(result.unknownTable).to.equal(1);

      // applyToStore saw only the known-table change.
      const allData = h.applyCalls.flatMap(c => c.data);
      expect(allData).to.have.lengthOf(1);
      expect(allData[0].table).to.equal('users');

      // The known write is recorded; the unknown one is quarantined.
      expect(await h.manager.columnVersions.getColumnVersion('main', 'users', [1], 'name')).to.not.be.undefined;
      expect(await h.manager.quarantine.list('main', RETIRED)).to.have.lengthOf(1);
    });

    it('is inert with no basis oracle: the change is treated as known', async () => {
      const h = await makeHarness({ withOracle: false });
      const result = await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-1', [
        col(h.remoteSite, 1000, RETIRED, 1, 'note', 'hi'),
      ])]);

      // Detection inert ⇒ not diverted; applied normally (the store adapter's
      // defensive throw is the real-deployment fallback, not exercised here).
      expect(result.unknownTable).to.be.undefined;
      expect(result.applied).to.equal(1);
      expect(await h.manager.quarantine.list('main', RETIRED)).to.have.lengthOf(0);
      expect(h.events).to.have.lengthOf(0);
    });
  });

  describe('GC at retention horizon', () => {
    it('prunes quarantine entries older than the horizon; fresh ones survive', async () => {
      const h = await makeHarness({ retentionHorizonMs: 1 });
      await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-1', [
        col(h.remoteSite, 1000, RETIRED, 1, 'note', 'hi'),
      ])]);
      expect(await h.manager.quarantine.list('main', RETIRED)).to.have.lengthOf(1);

      await new Promise(r => setTimeout(r, 10)); // exceed the 1ms horizon
      const pruned = await h.manager.pruneQuarantine();
      expect(pruned).to.equal(1);
      expect(await h.manager.quarantine.list('main', RETIRED)).to.have.lengthOf(0);

      // Second prune finds nothing.
      expect(await h.manager.pruneQuarantine()).to.equal(0);
    });

    it('does not prune within the horizon', async () => {
      const h = await makeHarness({ retentionHorizonMs: 60_000 });
      await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-1', [
        col(h.remoteSite, 1000, RETIRED, 1, 'note', 'hi'),
      ])]);

      expect(await h.manager.pruneQuarantine()).to.equal(0);
      expect(await h.manager.quarantine.list('main', RETIRED)).to.have.lengthOf(1);
    });
  });

  describe('telemetry detail', () => {
    it('latestHLC is the max HLC among diverted changes for the table', async () => {
      const h = await makeHarness();
      const c1 = col(h.remoteSite, 1000, RETIRED, 1, 'a', 'x');
      const c2 = col(h.remoteSite, 3000, RETIRED, 2, 'b', 'y');
      const c3 = col(h.remoteSite, 2000, RETIRED, 3, 'c', 'z');
      await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-1', [c1, c2, c3])]);

      expect(h.events).to.have.lengthOf(1);
      expect(h.events[0].changeCount).to.equal(3);
      expect(compareHLC(h.events[0].latestHLC, c2.hlc)).to.equal(0);
    });

    it('fires one event per distinct unknown table', async () => {
      const h = await makeHarness();
      await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-1', [
        col(h.remoteSite, 1000, 'orders', 1, 'note', 'a'),
        col(h.remoteSite, 1001, 'invoices', 1, 'note', 'b'),
      ])]);

      expect(h.events.map(e => e.table).sort()).to.deep.equal(['invoices', 'orders']);
      const stats = h.manager.getUnknownTableStats();
      expect(stats.byTable.get('main.orders')).to.equal(1);
      expect(stats.byTable.get('main.invoices')).to.equal(1);
    });
  });
});
