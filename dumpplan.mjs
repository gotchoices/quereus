import { Database } from './packages/quereus/src/core/database.js';
const db = new Database();
await db.exec("CREATE TABLE o (id INTEGER PRIMARY KEY, k INTEGER NULL, grp TEXT) USING memory");
await db.exec("CREATE TABLE c (id INTEGER PRIMARY KEY, fk INTEGER NULL, amount INTEGER NULL) USING memory");
const q = "SELECT o.id FROM o ORDER BY (SELECT count(*) FROM c WHERE c.fk = o.k), o.id";
for await (const r of db.eval("SELECT id, parent_id, node_type, op, detail FROM query_plan(?)", [q])) {
  console.log(`${r.id}\t<-${r.parent_id}\t${r.node_type}\t${r.op}\t${String(r.detail).slice(0,90)}`);
}
await db.close();
