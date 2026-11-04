/**
 * End-to-end sync round-trip through the live coordinator.
 *
 * Boots the real coordinator WebSocket server, connects two real-engine
 * `SyncClient`s over the wire, and asserts that a write on one client's engine
 * lands on the other — the check that catches client/coordinator protocol skew
 * (the wire codecs have drifted once before; see the sync-protocol work in
 * `tickets/complete/`).
 *
 * `service.spec.ts` pokes `CoordinatorService` in-process (no socket, no
 * client) and `sync-client.spec.ts` drives the client against a mock socket.
 * Neither exercises the two across a real WebSocket; this spec does.
 */

import { expect } from 'chai';
import { SyncClient, type SyncClientOptions } from '@quereus/sync-client';
import { siteIdEquals, type ChangeSet, type SyncConfig, type SyncManager } from '@quereus/sync';
import {
  bootCoordinator,
  makeClientPeer,
  collect,
  waitFor,
  waitForSynced,
  type BootedCoordinator,
  type ClientPeer,
} from './_e2e-harness.js';

// Valid per the coordinator's default database-id validator (`org:type_id`).
const DB_ID = 'default:s_roundtrip';
// Both peers start from the SAME base-table DDL so neither bootstrap fights the
// first replicated change (three columns, so row fidelity is more than the key).
const DDL = 'create table orders (id integer primary key, note text, qty integer) using store';

describe('sync-coordinator WebSocket round-trip (e2e)', () => {
  let coordinator: BootedCoordinator;
  let peerA: ClientPeer;
  let peerB: ClientPeer;
  let clientA: SyncClient;
  let clientB: SyncClient;

  beforeEach(async () => {
    coordinator = await bootCoordinator();

    peerA = await makeClientPeer(DDL);
    peerB = await makeClientPeer(DDL);

    // autoReconnect: false so no backoff timer fires after teardown; tiny debounce
    // so a local write flushes to the server promptly.
    clientA = new SyncClient({
      syncManager: peerA.syncManager,
      syncEvents: peerA.syncEvents,
      autoReconnect: false,
      localChangeDebounceMs: 10,
    });
    clientB = new SyncClient({
      syncManager: peerB.syncManager,
      syncEvents: peerB.syncEvents,
      autoReconnect: false,
      localChangeDebounceMs: 10,
    });

    await clientA.connect(coordinator.url, DB_ID);
    await clientB.connect(coordinator.url, DB_ID);

    // connect() resolves on handshake_ack, BEFORE the post-ack continuation runs
    // the empty-replica snapshot bootstrap. A write landing during that bootstrap
    // breaks the client's do-not-write contract and is silently lost, so hold
    // every test's first write until both clients have finished it.
    await waitForSynced(clientA, clientB);
  });

  afterEach(async () => {
    // Deterministic teardown even on failure: disconnect clients (stops their
    // reconnect/debounce timers), close both engines, then stop the server +
    // service and remove the tmpdir store.
    for (const c of [clientA, clientB]) {
      try { await c?.disconnect(); } catch { /* ignore teardown races */ }
    }
    for (const p of [peerA, peerB]) {
      try { await p?.close(); } catch { /* ignore teardown races */ }
    }
    await coordinator?.stop();
  });

  it('relays a write on A to B through the live coordinator (A→B)', async () => {
    await peerA.db.exec(`insert into orders (id, note, qty) values (1, 'from-A', 42)`);

    await waitFor(
      async () => (await collect(peerB.db, 'select id from orders where id = 1')).length === 1,
      { label: 'row 1 to arrive on B' },
    );

    const rows = await collect(peerB.db, 'select id, note, qty from orders where id = 1');
    expect(rows).to.have.length(1);
    expect(rows[0].note).to.equal('from-A');
    expect(Number(rows[0].qty)).to.equal(42);
  });

  it('relays a write on B to A through the live coordinator (B→A)', async () => {
    // The reverse direction — a one-directional codec bug can't pass both.
    await peerB.db.exec(`insert into orders (id, note, qty) values (2, 'from-B', 7)`);

    await waitFor(
      async () => (await collect(peerA.db, 'select id from orders where id = 2')).length === 1,
      { label: 'row 2 to arrive on A' },
    );

    const rows = await collect(peerA.db, 'select id, note, qty from orders where id = 2');
    expect(rows).to.have.length(1);
    expect(rows[0].note).to.equal('from-B');
    expect(Number(rows[0].qty)).to.equal(7);
  });

  it('cross-replicates concurrent writes on the same pair of connections', async () => {
    await peerA.db.exec(`insert into orders (id, note, qty) values (10, 'a-ten', 100)`);
    await peerB.db.exec(`insert into orders (id, note, qty) values (20, 'b-twenty', 200)`);

    await waitFor(
      async () => {
        const onB = await collect(peerB.db, 'select id from orders where id = 10');
        const onA = await collect(peerA.db, 'select id from orders where id = 20');
        return onB.length === 1 && onA.length === 1;
      },
      { label: 'both rows to cross-replicate' },
    );

    const [bRow] = await collect(peerB.db, 'select note, qty from orders where id = 10');
    const [aRow] = await collect(peerA.db, 'select note, qty from orders where id = 20');
    expect(bRow.note).to.equal('a-ten');
    expect(Number(bRow.qty)).to.equal(100);
    expect(aRow.note).to.equal('b-twenty');
    expect(Number(aRow.qty)).to.equal(200);
  });

  it('relays update and delete changes A→B (distinct non-insert wire codecs)', async () => {
    // Insert exercises only the upsert-of-a-fresh-row codec. Update (column
    // change on an existing row) and delete (tombstone) are separate wire ops;
    // a codec skew that only bites those would slip past the insert-only tests.
    await peerA.db.exec(`insert into orders (id, note, qty) values (30, 'v1', 1)`);
    await waitFor(
      async () => (await collect(peerB.db, 'select id from orders where id = 30')).length === 1,
      { label: 'row 30 to arrive on B' },
    );

    await peerA.db.exec(`update orders set note = 'v2', qty = 9 where id = 30`);
    await waitFor(
      async () => {
        const [r] = await collect(peerB.db, 'select note, qty from orders where id = 30');
        return r?.note === 'v2' && Number(r?.qty) === 9;
      },
      { label: 'update on A to propagate to B' },
    );

    await peerA.db.exec(`delete from orders where id = 30`);
    await waitFor(
      async () => (await collect(peerB.db, 'select id from orders where id = 30')).length === 0,
      { label: 'delete on A to propagate to B' },
    );
  });

  it('a device returning past a pruned delete pushes only its own writes, and the delete holds everywhere', async () => {
    const service = coordinator.server.service;
    const pushedByB: ChangeSet[] = [];
    const applyChanges = service.applyChanges.bind(service);
    service.applyChanges = (databaseId, client, changes) => {
      if (siteIdEquals(client.siteId, peerB.syncManager.getSiteId())) pushedByB.push(...changes);
      return applyChanges(databaseId, client, changes);
    };
    const serverEntry = await service.storeManager.acquire(DB_ID);

    await peerA.db.exec(`insert into orders (id, note, qty) values (1, 'one', 1), (2, 'two', 2)`);
    await waitFor(
      async () => (await notesOn(peerB)).length === 2,
      { label: 'A\'s rows to reach B by broadcast' },
    );

    await clientB.disconnect();
    await peerB.db.exec(`insert into orders (id, note, qty) values (3, 'offline', 3)`);
    await peerB.db.exec(`update orders set note = 'edited offline' where id = 2`);

    await peerA.db.exec('delete from orders where id = 1');
    await waitFor(
      async () => !(await notesOnServer(serverEntry.syncManager)).some(([id]) => id === 1),
      { label: 'A\'s delete to reach the server' },
    );
    await pruneEveryTombstone(serverEntry.syncManager);

    await clientB.connect(coordinator.url, DB_ID);

    const expected = [[2, 'edited offline'], [3, 'offline']];
    const onEveryReplica = async () => ({
      a: await notesOn(peerA),
      b: await notesOn(peerB),
      server: await notesOnServer(serverEntry.syncManager),
    });
    await waitFor(
      async () => JSON.stringify(await onEveryReplica()) === JSON.stringify({ a: expected, b: expected, server: expected }),
      { label: 'A, B and the server to hold rows 2 and 3 only, including B\'s offline edit' },
    );
    service.storeManager.release(DB_ID);

    expect(pushedByB, 'B pushes its offline work').to.not.be.empty;
    expect(
      pushedByB.every(changeSet => siteIdEquals(changeSet.siteId, peerB.syncManager.getSiteId())),
      'B pushes nothing another device wrote',
    ).to.equal(true);
  });

  it('an offline edit of a row deleted and pruned elsewhere is refused, so every replica and a new device agree', async () => {
    const service = coordinator.server.service;
    const serverEntry = await service.storeManager.acquire(DB_ID);

    await peerA.db.exec(`insert into orders (id, note, qty) values (1, 'one', 1), (2, 'two', 2)`);
    await waitFor(
      async () => (await notesOn(peerB)).length === 2,
      { label: 'A\'s rows to reach B by broadcast' },
    );

    await clientB.disconnect();
    await peerB.db.exec(`update orders set note = 'edited offline' where id = 1`);

    await peerA.db.exec('delete from orders where id = 1');
    await waitFor(
      async () => !(await notesOnServer(serverEntry.syncManager)).some(([id]) => id === 1),
      { label: 'A\'s delete to reach the server' },
    );
    await pruneEveryTombstone(serverEntry.syncManager);

    await clientB.connect(coordinator.url, DB_ID);

    const expected = JSON.stringify([[2, 'two']]);
    await waitFor(
      async () => [await notesOn(peerA), await notesOn(peerB), await notesOnServer(serverEntry.syncManager)]
        .every(notes => JSON.stringify(notes) === expected),
      { label: 'A, B and the server to hold row 2 only' },
    );
    service.storeManager.release(DB_ID);

    const peerC = await makeClientPeer(DDL);
    const clientC = new SyncClient({ syncManager: peerC.syncManager, syncEvents: peerC.syncEvents, autoReconnect: false });
    try {
      await clientC.connect(coordinator.url, DB_ID);
      await waitForSynced(clientC);
      expect(JSON.stringify(await notesOn(peerC)), 'a new device').to.equal(expected);
    } finally {
      await clientC.disconnect();
      await peerC.close();
    }
  });

  // The server is a relay: it holds sync records but no table, so it must re-file its
  // records under the new key from the records themselves. In the second case A's delete
  // of row 9, pruned on the server, puts the server's delta floor above B's watermark, so
  // B is refused a delta and takes a snapshot after pushing.
  for (const [serverState, pruneBeforeReconnect] of [
    ['has not pruned, so the device catches up by delta', false],
    ['has pruned, so the device takes a snapshot', true],
  ] as const) {
    it(`a key change made offline converges on every replica and a new device when the server ${serverState}`, async () => {
      const service = coordinator.server.service;
      const serverEntry = await service.storeManager.acquire(DB_ID);

      await peerA.db.exec(`insert into orders (id, note, qty) values (1, 'one', 1), (2, 'two', 2), (9, 'nine', 9)`);
      await waitFor(
        async () => (await notesOn(peerB)).length === 3,
        { label: 'A\'s rows to reach B by broadcast' },
      );

      await clientB.disconnect();
      await peerB.db.exec('alter table orders alter primary key (id, qty)');
      await peerB.db.exec(`update orders set note = 'edited after key change' where id = 1`);

      await peerA.db.exec('delete from orders where id = 9');
      await waitFor(
        async () => !(await notesOnServer(serverEntry.syncManager)).some(([id]) => id === 9),
        { label: 'A\'s delete to reach the server' },
      );
      if (pruneBeforeReconnect) await pruneEveryTombstone(serverEntry.syncManager);

      await clientB.connect(coordinator.url, DB_ID);

      const expected = JSON.stringify([[1, 'edited after key change'], [2, 'two']]);
      await waitFor(
        async () => [await notesOn(peerA), await notesOn(peerB), await notesOnServer(serverEntry.syncManager)]
          .every(notes => JSON.stringify(notes) === expected),
        { label: 'A, B and the server to hold rows 1 and 2, with row 1 edited' },
      );
      service.storeManager.release(DB_ID);

      await withNewDevice(async peerC => {
        expect(JSON.stringify(await notesOn(peerC)), 'a new device').to.equal(expected);
      });
    });
  }

  it('a delete made while a device was offline still removes the row there after another device changed the key', async () => {
    const service = coordinator.server.service;
    const serverEntry = await service.storeManager.acquire(DB_ID);
    const peerC = await makeClientPeer(DDL);
    const clientC = new SyncClient({ syncManager: peerC.syncManager, syncEvents: peerC.syncEvents, autoReconnect: false });
    try {
      await clientC.connect(coordinator.url, DB_ID);
      await waitForSynced(clientC);

      await peerA.db.exec(`insert into orders (id, note, qty) values (1, 'one', 1), (2, 'two', 2), (3, 'three', 3)`);
      await waitFor(
        async () => (await notesOn(peerB)).length === 3 && (await notesOn(peerC)).length === 3,
        { label: 'A\'s rows to reach B and C by broadcast' },
      );

      await clientC.disconnect();
      await peerA.db.exec('delete from orders where id = 3');
      // B must hold the delete before it changes the key: a delete arriving under the old
      // key after the change is the documented concurrent-write race, not this case.
      await waitFor(
        async () => !(await notesOnServer(serverEntry.syncManager)).some(([id]) => id === 3)
          && !(await notesOn(peerB)).some(([id]) => id === 3),
        { label: 'A\'s delete to reach the server and B' },
      );
      await peerB.db.exec('alter table orders alter primary key (id, qty)');
      await waitFor(
        async () => JSON.stringify(await keyColumnsOn(peerA)) === JSON.stringify(['id', 'qty']),
        { label: 'B\'s key change to reach A' },
      );

      await clientC.connect(coordinator.url, DB_ID);

      const expected = JSON.stringify([[1, 'one'], [2, 'two']]);
      await waitFor(
        async () => [await notesOn(peerA), await notesOn(peerB), await notesOn(peerC), await notesOnServer(serverEntry.syncManager)]
          .every(notes => JSON.stringify(notes) === expected),
        { label: 'A, B, C and the server to hold rows 1 and 2 only' },
      );
    } finally {
      service.storeManager.release(DB_ID);
      await clientC.disconnect();
      await peerC.close();
    }
  });

  /** Connect a brand-new device, let it bootstrap, and hand it to `check`. */
  async function withNewDevice(check: (peer: ClientPeer) => Promise<void>): Promise<void> {
    const peer = await makeClientPeer(DDL);
    const client = new SyncClient({ syncManager: peer.syncManager, syncEvents: peer.syncEvents, autoReconnect: false });
    try {
      await client.connect(coordinator.url, DB_ID);
      await waitForSynced(client);
      await check(peer);
    } finally {
      await client.disconnect();
      await peer.close();
    }
  }
});

/** The `orders` table's primary-key column names, in key order, lower-cased. */
async function keyColumnsOn(peer: ClientPeer): Promise<string[]> {
  const table = peer.db.schemaManager.getTable('main', 'orders')!;
  return table.primaryKeyDefinition.map(def => table.columns[def.index].name.toLowerCase());
}

/** Each row's id and note, by id. */
async function notesOn(peer: ClientPeer): Promise<Array<[number, unknown]>> {
  const rows = await collect(peer.db, 'select id, note from orders order by id');
  return rows.map(row => [Number(row.id), row.note]);
}

/** The server has no engine to query, so this reads its rows out of a snapshot: each row's id and note, by id. */
async function notesOnServer(syncManager: SyncManager): Promise<Array<[number, unknown]>> {
  const { tables } = await syncManager.getSnapshot();
  const cells = tables.flatMap(table => table.columnVersions).filter(cell => cell.column === 'note');
  return cells
    .map((cell): [number, unknown] => [Number(cell.pk[0]), cell.value])
    .sort(([a], [b]) => a - b);
}

/** Prune every tombstone now, as the retention horizon eventually would. The horizon is otherwise fixed at startup. */
async function pruneEveryTombstone(syncManager: SyncManager): Promise<void> {
  (syncManager as unknown as { config: SyncConfig }).config.retentionHorizonMs = -1;
  await syncManager.pruneTombstones();
}

describe('adopting rows written before sync attached (e2e)', () => {
  // More than one of adoption's internal batches.
  const ROWS = 150;

  let coordinator: BootedCoordinator;
  let holder: ClientPeer;
  let newcomer: ClientPeer;
  let clients: SyncClient[] = [];

  const connected = async (peer: ClientPeer, options: Partial<SyncClientOptions> = {}): Promise<SyncClient> => {
    const client = new SyncClient({
      syncManager: peer.syncManager,
      syncEvents: peer.syncEvents,
      autoReconnect: false,
      localChangeDebounceMs: 10,
      ...options,
    });
    clients.push(client);
    await client.connect(coordinator.url, DB_ID);
    return client;
  };

  const countRows = async (peer: ClientPeer): Promise<number> =>
    Number((await collect(peer.db, 'select count(*) as n from orders'))[0].n);

  beforeEach(async () => {
    coordinator = await bootCoordinator();
    const values = Array.from({ length: ROWS }, (_, i) => `(${i + 1}, 'note-${i + 1}', ${i})`).join(', ');
    holder = await makeClientPeer(
      `${DDL}; create index orders_note on orders (note); insert into orders (id, note, qty) values ${values}`,
    );
    newcomer = await makeClientPeer('');
  });

  afterEach(async () => {
    for (const client of clients) {
      try { await client.disconnect(); } catch { /* ignore teardown races */ }
    }
    clients = [];
    for (const p of [holder, newcomer]) {
      try { await p?.close(); } catch { /* ignore teardown races */ }
    }
    await coordinator?.stop();
  });

  it('a brand-new device with no schema bootstraps the table, its index and its rows', async () => {
    let acknowledged = false;
    const holderClient = await connected(holder, {
      unrecordedRows: 'adopt',
      onSyncEvent: event => { acknowledged ||= event.message.startsWith('Server applied'); },
    });
    await waitFor(async () => acknowledged, { label: 'the adopted rows to reach the server' });
    expect(holderClient.status.status).to.not.equal('error');
    expect(await countRows(holder), 'the holder keeps its rows').to.equal(ROWS);

    const newcomerClient = await connected(newcomer);
    await waitForSynced(newcomerClient);

    expect(await countRows(newcomer)).to.equal(ROWS);
    const [row] = await collect(newcomer.db, 'select note, qty from orders where id = 150');
    expect(row.note).to.equal('note-150');
    expect(Number(row.qty)).to.equal(149);
    expect(newcomer.db.schemaManager.getTable('main', 'orders')?.indexes?.map(index => index.name)).to.deep.equal(['orders_note']);
  });
});
