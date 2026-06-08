import { Database } from './packages/quereus/dist/src/index.js';

const db = new Database();

// Mirror issue #22 reproduction exactly.
await (async () => {
  console.log('== Control: SELECT context ==');
  await db.exec(`
    declare schema main { table Block ( Code text primary key ); }
    apply schema main;
    insert into Block (Code) values ('r');
    insert into Block (Code) values ('y');
  `);

  for await (const r of db.eval(`select ('g' not in (select Code from Block)) as v`)) {
    console.log(`  'g' not in (Block) =>`, r.v, '(expected true)');
  }
  for await (const r of db.eval(`select ('r' not in (select Code from Block)) as v`)) {
    console.log(`  'r' not in (Block) =>`, r.v, '(expected false)');
  }
  for await (const r of db.eval(`select (not 'g' in (select Code from Block)) as v`)) {
    console.log(`  not 'g' in (Block) =>`, r.v, '(expected true)');
  }
  for await (const r of db.eval(`select ('g' in (select Code from Block)) as v`)) {
    console.log(`  'g' in (Block)     =>`, r.v, '(expected false)');
  }
})();

const db2 = new Database();
console.log('\n== Bug: CHECK context ==');
try {
  await db2.exec(`
    declare schema main
    {
      table Block ( Code text primary key );
      table T (
        Id int,
        Color text,
        primary key (),
        constraint NB check (Color not in (select Code from Block))
      );
    }
    apply schema main;
    insert into Block (Code) values ('r');
    insert into Block (Code) values ('y');
    insert into T (Id, Color) values (1, 'g');
  `);
  console.log('  insert succeeded (correct)');
} catch (e) {
  console.log('  ERROR:', e.message);
}

// Variant: positive form
const db3 = new Database();
console.log('\n== Variant: positive IN form ==');
try {
  await db3.exec(`
    declare schema main
    {
      table Block ( Code text primary key );
      table T (
        Id int,
        Color text,
        primary key (),
        constraint NB check (Color in (select Code from Block))
      );
    }
    apply schema main;
    insert into Block (Code) values ('g');
    insert into T (Id, Color) values (1, 'g');
  `);
  console.log('  positive form insert succeeded (correct)');
} catch (e) {
  console.log('  ERROR:', e.message);
}

// Variant: direct CREATE TABLE rather than declare schema
const db4 = new Database();
console.log('\n== Variant: CREATE TABLE (no declare) ==');
try {
  await db4.exec(`
    create table Block (Code text primary key) using memory;
    create table T (Id int, Color text, primary key (), constraint NB check (Color not in (select Code from Block))) using memory;
    insert into Block (Code) values ('r');
    insert into Block (Code) values ('y');
    insert into T (Id, Color) values (1, 'g');
  `);
  console.log('  CREATE TABLE insert succeeded (correct)');
} catch (e) {
  console.log('  ERROR:', e.message);
}

await db.close();
await db2.close();
await db3.close();
await db4.close();
