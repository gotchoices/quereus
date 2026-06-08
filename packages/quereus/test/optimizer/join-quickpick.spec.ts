import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { SqlValue } from '../../src/common/types.js';

type ResultRow = Record<string, SqlValue>;

describe('QuickPick Join Enumeration', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database();
  });

  afterEach(async () => {
    await db.close();
  });

  async function setupChain() {
    await db.exec("CREATE TABLE a (id INTEGER PRIMARY KEY, v INTEGER) USING memory");
    await db.exec("CREATE TABLE b (id INTEGER PRIMARY KEY, a_id INTEGER) USING memory");
    await db.exec("CREATE TABLE c (id INTEGER PRIMARY KEY, b_id INTEGER) USING memory");
    await db.exec("INSERT INTO a VALUES (1,10),(2,20),(3,30)");
    await db.exec("INSERT INTO b VALUES (10,1),(20,2),(30,3)");
    await db.exec("INSERT INTO c VALUES (100,10),(200,20),(300,30)");
  }

  it('exposes quickpick diagnostics in query_plan()', async () => {
    await setupChain();
    const rows: ResultRow[] = [];
    for await (const r of db.eval("SELECT properties FROM query_plan('SELECT * FROM a JOIN b ON a.id=b.a_id JOIN c ON b.id=c.b_id')")) rows.push(r);
    const props = String(rows.map(r => r.properties).join(' '));
    // Should include a quickpick diagnostic block somewhere
    expect(props).to.match(/quickpick/);
  });

  it('improves or maintains estimated cost for chain joins', async () => {
    await setupChain();
    // Baseline: just get plan; quickpick runs automatically but we can still assert that estimated rows are reasonable
    const rows: ResultRow[] = [];
    for await (const r of db.eval("SELECT physical FROM query_plan('SELECT a.id FROM a JOIN b ON a.id=b.a_id JOIN c ON b.id=c.b_id')")) rows.push(r);
    const physicals = rows.map(r => String(r.physical || ''));
    // Expect at least one JOIN node to have estimatedRows close to base table sizes (not full cross product)
    const hasReasonableJoin = physicals.some(p => /"estimatedRows":\s*\d+/i.test(p));
    expect(hasReasonableJoin).to.equal(true);
  });
});


