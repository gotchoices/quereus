/**
 * Tests for SyncManagerImpl.recordLensDeployment — the basis-table lifecycle
 * recorder (docs/migration.md § 2 Converge).
 *
 * Most cases drive the recorder with hand-built `LensDeploymentSnapshot`s + a
 * minimal fake `Database` (the recorder reads only `db.schemaManager.getSchema`
 * → `getAllTables` and each table's `schemaName` / `name` / `derivation`), so
 * the classification, the per-schema `mappedBy` OR, the transition timestamps,
 * and the event emission are exercised in isolation. A final case drives a REAL
 * `Database` deploy end-to-end to prove the snapshot + basis enumeration the
 * recorder consumes are produced for an ordinary name-match lens.
 */

import { expect } from 'chai';
import { Database, type LensDeploymentSnapshot, type LensTableSnapshot, type LensRelationBacking, type Database as DatabaseType } from '@quereus/quereus';
import { InMemoryKVStore } from '@quereus/store';
import { SyncManagerImpl } from '../../src/sync/sync-manager-impl.js';
import { SyncEventEmitterImpl, type BasisTableLifecycleEvent } from '../../src/sync/events.js';
import { DEFAULT_SYNC_CONFIG, type SyncConfig } from '../../src/sync/protocol.js';
import type { BasisTableLifecycleRecord } from '../../src/metadata/basis-lifecycle.js';
import { splitRelKey } from '../../src/metadata/basis-lifecycle.js';

// --- Fake snapshot / db builders ------------------------------------------------

function relationBacking(key: string): LensRelationBacking {
  const { schema, table } = splitRelKey(key);
  return { relationId: key, basisRelation: { schema, table }, columns: [], requiredBasisColumns: [] };
}

interface TableSpec { logicalTable: string; relations: string[]; surrogates?: string[]; }

function makeSnapshot(basisSchemaName: string, basisHash: string, tables: TableSpec[]): LensDeploymentSnapshot {
  const t = new Map<string, LensTableSnapshot>();
  for (const tab of tables) {
    const rb = new Map<string, LensRelationBacking>();
    for (const key of tab.relations) rb.set(key, relationBacking(key));
    t.set(tab.logicalTable.toLowerCase(), {
      logicalTable: tab.logicalTable,
      getBody: {} as never,
      logicalColumns: [],
      relationBacking: rb,
      surrogateMemberKeys: tab.surrogates ? new Set(tab.surrogates) : undefined,
    });
  }
  return { basisSchemaName, basisHash, tables: t };
}

interface BasisTableSpec { schema: string; name: string; sourceTables?: string[]; }

function makeDb(basisName: string, tables: BasisTableSpec[]): DatabaseType {
  const schemaTables = tables.map(t => ({
    schemaName: t.schema,
    name: t.name,
    derivation: t.sourceTables ? { sourceTables: t.sourceTables } : undefined,
  }));
  const schema = { getAllTables: () => schemaTables };
  return {
    schemaManager: {
      getSchema: (n: string) => (n.toLowerCase() === basisName.toLowerCase() ? schema : undefined),
    },
  } as unknown as DatabaseType;
}

// --- Suite ---------------------------------------------------------------------

describe('recordLensDeployment — basis lifecycle classification', () => {
  let kv: InMemoryKVStore;
  let syncEvents: SyncEventEmitterImpl;
  let config: SyncConfig;
  let mgr: SyncManagerImpl;
  let events: BasisTableLifecycleEvent[];

  beforeEach(async () => {
    kv = new InMemoryKVStore();
    syncEvents = new SyncEventEmitterImpl();
    config = { ...DEFAULT_SYNC_CONFIG };
    mgr = await SyncManagerImpl.create(kv, undefined, config, syncEvents);
    events = [];
    syncEvents.onBasisTableLifecycle(e => events.push(e));
  });

  async function getRec(schema: string, table: string): Promise<BasisTableLifecycleRecord | undefined> {
    const all = await mgr.getBasisTableLifecycle();
    const key = `${schema}.${table}`.toLowerCase();
    return all.find(r => `${r.schema}.${r.table}`.toLowerCase() === key);
  }

  it('first deploy → directly-mapped, mappedSince set, no transition event', async () => {
    const db = makeDb('store', [{ schema: 'store', name: 'Contact_v1' }]);
    const snap = makeSnapshot('store', 'h1', [{ logicalTable: 'Contact', relations: ['store.contact_v1'] }]);

    await mgr.recordLensDeployment(db, 'app', snap);

    const r = await getRec('store', 'contact_v1');
    expect(r?.state).to.equal('directly-mapped');
    expect(r?.mappedBy).to.deep.equal(['app']);
    expect(r?.inBasis).to.equal(true);
    expect(r?.mappedSince).to.be.a('number');
    expect(r?.unmappedSince).to.be.undefined;
    // Reserved eviction fields stay absent until basis-eviction-policy populates them.
    expect(r).to.not.have.property('lastDirectlyMappedWriteAt');
    expect(r).to.not.have.property('evictPolicy');
    // A first appearance is not a transition — no event.
    expect(events).to.have.lengthOf(0);
  });

  it('directly-mapped wins over derivation-source (precedence)', async () => {
    const db = makeDb('store', [
      { schema: 'store', name: 'Contact_v1' },
      { schema: 'store', name: 'Contact_v2', sourceTables: ['store.contact_v1'] },
    ]);
    // Lens maps BOTH basis tables.
    const snap = makeSnapshot('store', 'h', [
      { logicalTable: 'C1', relations: ['store.contact_v1'] },
      { logicalTable: 'C2', relations: ['store.contact_v2'] },
    ]);

    await mgr.recordLensDeployment(db, 'app', snap);

    const v1 = await getRec('store', 'contact_v1');
    expect(v1?.state).to.equal('directly-mapped');
    expect(v1?.derivationSource).to.equal(true); // also a source — but directly-mapped wins
    expect((await getRec('store', 'contact_v2'))?.state).to.equal('directly-mapped');
  });

  it('flip then detach: directly-mapped → derivation-source-only → detached, with events', async () => {
    const db = makeDb('store', [
      { schema: 'store', name: 'Contact_v1' },
      { schema: 'store', name: 'Contact_v2', sourceTables: ['store.contact_v1'] },
    ]);

    // Map Contact_v1.
    await mgr.recordLensDeployment(db, 'app', makeSnapshot('store', 'h', [{ logicalTable: 'C', relations: ['store.contact_v1'] }]));
    expect((await getRec('store', 'contact_v1'))?.state).to.equal('directly-mapped');
    const mappedSince = (await getRec('store', 'contact_v1'))?.mappedSince;

    // Flip the lens to Contact_v2 — Contact_v1 becomes legacy (derivation-source-only).
    events = [];
    await mgr.recordLensDeployment(db, 'app', makeSnapshot('store', 'h', [{ logicalTable: 'C', relations: ['store.contact_v2'] }]));

    const legacy = await getRec('store', 'contact_v1');
    expect(legacy?.state).to.equal('derivation-source-only');
    expect(legacy?.mappedBy).to.deep.equal([]);
    expect(legacy?.unmappedSince).to.be.a('number');
    expect(legacy?.mappedSince).to.equal(mappedSince); // preserved across the exit
    const flipEv = events.find(e => e.table.toLowerCase() === 'contact_v1');
    expect(flipEv?.previousState).to.equal('directly-mapped');
    expect(flipEv?.newState).to.equal('derivation-source-only');

    // Drop Contact_v1 from the basis and remove the derivation → detached.
    events = [];
    const db2 = makeDb('store', [{ schema: 'store', name: 'Contact_v2' }]);
    await mgr.recordLensDeployment(db2, 'app', makeSnapshot('store', 'h2', [{ logicalTable: 'C', relations: ['store.contact_v2'] }]));

    const detached = await getRec('store', 'contact_v1');
    expect(detached?.state).to.equal('detached');
    expect(detached?.inBasis).to.equal(false);
    expect(detached?.derivationSource).to.equal(false);
    const detachEv = events.find(e => e.table.toLowerCase() === 'contact_v1');
    expect(detachEv?.previousState).to.equal('derivation-source-only');
    expect(detachEv?.newState).to.equal('detached');
  });

  it('two logical schemas: stays directly-mapped until the last mapper drops it', async () => {
    const db = makeDb('store', [
      { schema: 'store', name: 'Contact_v1' },
      { schema: 'store', name: 'Contact_v2', sourceTables: ['store.contact_v1'] },
    ]);
    const mapV1 = () => makeSnapshot('store', 'h', [{ logicalTable: 'C', relations: ['store.contact_v1'] }]);
    const mapV2 = () => makeSnapshot('store', 'h', [{ logicalTable: 'C', relations: ['store.contact_v2'] }]);

    await mgr.recordLensDeployment(db, 'appA', mapV1());
    await mgr.recordLensDeployment(db, 'appB', mapV1());
    let v1 = await getRec('store', 'contact_v1');
    expect(v1?.mappedBy).to.deep.equal(['appa', 'appb']);
    expect(v1?.state).to.equal('directly-mapped');

    // appA flips — appB still maps Contact_v1, so it stays directly-mapped (no event).
    events = [];
    await mgr.recordLensDeployment(db, 'appA', mapV2());
    v1 = await getRec('store', 'contact_v1');
    expect(v1?.state).to.equal('directly-mapped');
    expect(v1?.mappedBy).to.deep.equal(['appb']);
    expect(v1?.unmappedSince).to.be.undefined;
    expect(events.filter(e => e.table.toLowerCase() === 'contact_v1')).to.have.lengthOf(0);

    // appB flips — the last mapper drops it, now derivation-source-only.
    await mgr.recordLensDeployment(db, 'appB', mapV2());
    v1 = await getRec('store', 'contact_v1');
    expect(v1?.state).to.equal('derivation-source-only');
    expect(v1?.mappedBy).to.deep.equal([]);
    expect(v1?.unmappedSince).to.be.a('number');
  });

  it('empty (detach-all) deploy clears this schema from mappedBy', async () => {
    const db = makeDb('store', [{ schema: 'store', name: 'Contact_v1' }]);
    await mgr.recordLensDeployment(db, 'app', makeSnapshot('store', 'h', [{ logicalTable: 'C', relations: ['store.contact_v1'] }]));
    expect((await getRec('store', 'contact_v1'))?.state).to.equal('directly-mapped');

    // Empty deploy — basisSchemaName still resolves (engine carries the prior basis).
    events = [];
    await mgr.recordLensDeployment(db, 'app', makeSnapshot('store', 'h', []));

    const r = await getRec('store', 'contact_v1');
    expect(r?.mappedBy).to.deep.equal([]);
    expect(r?.state).to.equal('unreferenced');
    expect(r?.unmappedSince).to.be.a('number');
    expect(events.find(e => e.table.toLowerCase() === 'contact_v1')?.newState).to.equal('unreferenced');
  });

  it('idempotent re-apply emits no event and preserves timestamps', async () => {
    const db = makeDb('store', [{ schema: 'store', name: 'Contact_v1' }]);
    const snap = makeSnapshot('store', 'h', [{ logicalTable: 'C', relations: ['store.contact_v1'] }]);
    await mgr.recordLensDeployment(db, 'app', snap);
    const first = await getRec('store', 'contact_v1');

    events = [];
    await mgr.recordLensDeployment(db, 'app', makeSnapshot('store', 'h', [{ logicalTable: 'C', relations: ['store.contact_v1'] }]));
    const second = await getRec('store', 'contact_v1');

    expect(events).to.have.lengthOf(0);
    expect(second?.state).to.equal('directly-mapped');
    expect(second?.mappedSince).to.equal(first?.mappedSince);
    expect(second?.unmappedSince).to.equal(first?.unmappedSince);
  });

  it('surrogate-split members are treated as referenced (never unreferenced)', async () => {
    const db = makeDb('store', [
      { schema: 'store', name: 'Anchor' },
      { schema: 'store', name: 'Surrogate' },
    ]);
    // Surrogate appears ONLY as a deferred surrogate member, not in relationBacking.
    const snap = makeSnapshot('store', 'h', [
      { logicalTable: 'C', relations: ['store.anchor'], surrogates: ['store.surrogate'] },
    ]);

    await mgr.recordLensDeployment(db, 'app', snap);

    expect((await getRec('store', 'anchor'))?.state).to.equal('directly-mapped');
    // Without surrogate folding this would be 'unreferenced'.
    expect((await getRec('store', 'surrogate'))?.state).to.equal('directly-mapped');
  });

  it('records survive a restart (new manager over the same KV store)', async () => {
    const db = makeDb('store', [{ schema: 'store', name: 'Contact_v1' }]);
    await mgr.recordLensDeployment(db, 'app', makeSnapshot('store', 'h', [{ logicalTable: 'C', relations: ['store.contact_v1'] }]));
    const before = await mgr.getBasisTableLifecycle();

    const mgr2 = await SyncManagerImpl.create(kv, undefined, config, new SyncEventEmitterImpl());
    const after = await mgr2.getBasisTableLifecycle();

    expect(after).to.deep.equal(before);
    expect(after[0].mappedSince).to.be.a('number');
  });

  it('a missing basis schema does not throw (warns, treats membership empty)', async () => {
    const db = makeDb('store', [{ schema: 'store', name: 'Contact_v1' }]);
    // basisSchemaName the db does not know — getSchema returns undefined.
    const snap = makeSnapshot('unknown', 'h', [{ logicalTable: 'C', relations: ['unknown.contact_v1'] }]);
    await mgr.recordLensDeployment(db, 'app', snap);
    const r = await getRec('unknown', 'contact_v1');
    // Still mapped (mappedBy wins) but flagged out-of-basis.
    expect(r?.state).to.equal('directly-mapped');
    expect(r?.inBasis).to.equal(false);
  });

  it('classifies a real name-match deploy end-to-end as directly-mapped', async () => {
    const db = new Database();
    await db.exec('declare schema store { table Contact_v1 { id integer primary key, name text } }');
    await db.exec('apply schema store');
    await db.exec('declare logical schema app { table Contact_v1 { id integer primary key, name text } }');
    await db.exec('apply schema app');

    const snapshot = db.declaredSchemaManager.getDeployedLensSnapshots('app')?.current;
    expect(snapshot, 'a successful deploy rotates a current snapshot').to.exist;

    await mgr.recordLensDeployment(db, 'app', snapshot!);

    const r = await getRec('store', 'contact_v1');
    expect(r?.state).to.equal('directly-mapped');
    expect(r?.mappedBy).to.deep.equal(['app']);
    expect(r?.mappedSince).to.be.a('number');

    await db.close();
  });
});
