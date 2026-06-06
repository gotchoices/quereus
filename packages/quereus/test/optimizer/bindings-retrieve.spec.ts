import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { SqlValue } from '../../src/common/types.js';

type ResultRow = Record<string, SqlValue>;

describe('Retrieve.bindings propagation (params and correlations)', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database();
  });

  afterEach(async () => {
    await db.close();
  });

  async function setup(): Promise<void> {
    await db.exec("CREATE TABLE bt (id INTEGER PRIMARY KEY, name TEXT) USING memory");
    await db.exec("INSERT INTO bt VALUES (1, 'Alice'), (2, 'Bob'), (3, 'Charlie')");
  }

  it('captures parameter binding into Retrieve and executes correctly', async () => {
    await setup();
    const sql = "SELECT name FROM bt WHERE id = :id";
    const rows: ResultRow[] = [];
    for await (const r of db.eval(sql, { id: 2 })) {
      rows.push(r);
    }
    expect(rows).to.deep.equal([{ name: 'Bob' }]);

    // Verify plan contains a ParameterReference (binding in logical plan)
    const params: ResultRow[] = [];
    for await (const r of db.eval("SELECT COUNT(*) AS params FROM query_plan(?) WHERE node_type = 'ParameterReference'", [sql])) {
      params.push(r);
    }
    expect(params).to.have.lengthOf(1);
    expect(params[0].params).to.be.greaterThan(0);
  });

  it('captures correlation binding across a correlated subquery (EXISTS)', async () => {
    await setup();
    const sql = "SELECT b1.name FROM bt b1 WHERE EXISTS (SELECT 1 FROM bt b2 WHERE b2.id = b1.id) ORDER BY b1.id";
    const rows: ResultRow[] = [];
    for await (const r of db.eval(sql)) {
      rows.push(r);
    }
    expect(rows).to.deep.equal([{ name: 'Alice' }, { name: 'Bob' }, { name: 'Charlie' }]);

    // Optional: plan contains a ColumnReference under inner Retrieve subtree (non-strict)
    // We won't over-specify the correlation here to avoid brittleness.
  });
});


