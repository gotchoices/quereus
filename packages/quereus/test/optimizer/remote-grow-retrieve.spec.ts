import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { SqlValue } from '../../src/common/types.js';
import { TestQueryModule } from '../vtab/test-query-module.js';

type ResultRow = Record<string, SqlValue>;

describe('Retrieve growth with supports() (remote query)', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database();
    // Register query-based module with an alias for tests
    db.registerModule('query_test', new TestQueryModule());
  });

  afterEach(async () => {
    await db.close();
  });

  async function createTable(): Promise<void> {
    await db.exec("CREATE TABLE qt (id INTEGER PRIMARY KEY, name TEXT) USING query_test");
  }

  it('slides Filter into Retrieve and selects RemoteQuery', async () => {
    await createTable();
    const rows: ResultRow[] = [];
    for await (const r of db.eval("SELECT json_group_array(op) AS ops FROM query_plan('SELECT id FROM qt WHERE id = 1')")) {
      rows.push(r);
    }
    expect(rows).to.have.lengthOf(1);
    const ops = rows[0].ops as string;
    expect(ops).to.contain('REMOTEQUERY');
  });

  it('slides Sort/Limit into Retrieve boundary when supports() accepts', async () => {
    await createTable();
    const rows: ResultRow[] = [];
    for await (const r of db.eval("SELECT json_group_array(op) AS ops FROM query_plan('SELECT id FROM qt WHERE id = 1 ORDER BY id LIMIT 1')")) {
      rows.push(r);
    }
    expect(rows).to.have.lengthOf(1);
    const ops = rows[0].ops as string;
    expect(ops).to.contain('REMOTEQUERY');
  });
});


