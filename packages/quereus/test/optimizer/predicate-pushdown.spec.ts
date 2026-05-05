import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { SqlValue } from '../../src/common/types.js';

type ResultRow = Record<string, SqlValue>;

describe('Predicate push-down (supported-only fragments)', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database();
  });

  afterEach(async () => {
    await db.close();
  });

  async function setup(): Promise<void> {
    await db.exec("CREATE TABLE ptab (id INTEGER PRIMARY KEY, name TEXT) USING memory");
    await db.exec("INSERT INTO ptab VALUES (1, 'Alice'), (2, 'Bob'), (3, 'Charlie')");
  }

  it('keeps residual FILTER above Retrieve when only part of predicate is supported', async () => {
    await setup();
    // id = 1 is supported (equality on PK) but LIKE is not handled by memory index planning
    const q = "SELECT name FROM ptab WHERE id = 1 AND name LIKE '%li%'";
    const rows: ResultRow[] = [];
    for await (const r of db.eval("SELECT COUNT(*) AS filters FROM query_plan(?) WHERE op = 'FILTER'", [q])) {
      rows.push(r);
    }
    expect(rows).to.have.lengthOf(1);
    expect(rows[0].filters).to.equal(1);

    const access: ResultRow[] = [];
    for await (const r of db.eval("SELECT COUNT(*) AS accesses FROM query_plan(?) WHERE op IN ('SEQSCAN','INDEXSCAN','INDEXSEEK')", [q])) {
      access.push(r);
    }
    expect(access).to.have.lengthOf(1);
    expect(access[0].accesses).to.equal(1);
  });

  it('pushes predicate through AliasNode (view boundary)', async () => {
    await setup();
    await db.exec("CREATE VIEW v AS SELECT id, name FROM ptab");
    // id = 2 should push through Alias → Project → into Retrieve pipeline
    const q = "SELECT * FROM v WHERE id = 2";
    const rows: ResultRow[] = [];
    for await (const r of db.eval(q)) {
      rows.push(r);
    }
    expect(rows).to.have.lengthOf(1);
    expect(rows[0].name).to.equal('Bob');

    // Verify the predicate was pushed down (no residual FILTER above Alias)
    const filters: ResultRow[] = [];
    for await (const r of db.eval("SELECT COUNT(*) AS filters FROM query_plan(?) WHERE op = 'FILTER'", [q])) {
      filters.push(r);
    }
    expect(filters[0].filters).to.equal(0);
    await db.exec("DROP VIEW v");
  });

  it('pushes predicate through AliasNode with qualified column references', async () => {
    await setup();
    await db.exec("CREATE VIEW v AS SELECT id, name FROM ptab");
    const q = "SELECT v.name FROM v WHERE v.id = 1";
    const rows: ResultRow[] = [];
    for await (const r of db.eval(q)) {
      rows.push(r);
    }
    expect(rows).to.have.lengthOf(1);
    expect(rows[0].name).to.equal('Alice');
    await db.exec("DROP VIEW v");
  });

  it('handles key-equality with residual arithmetic, keeping residual filter above index seek', async () => {
    await setup();
    const q = "SELECT name FROM ptab WHERE id = 2 AND (id + 0) > 0";
    const rows: ResultRow[] = [];
    for await (const r of db.eval("SELECT COUNT(*) AS filters FROM query_plan(?) WHERE op = 'FILTER'", [q])) {
      rows.push(r);
    }
    expect(rows).to.have.lengthOf(1);
    // IndexSeek handles id = 2 internally; residual (id + 0) > 0 stays as FILTER
    expect(rows[0].filters).to.equal(1);
  });
});


