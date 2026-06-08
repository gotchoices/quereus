import { Parser } from './packages/quereus/dist/src/parser/parser.js';
import { expressionToString } from './packages/quereus/dist/src/emit/ast-stringify.js';

// Walk through expressions where the stringifier may drop parens that
// the parser will then re-bind differently due to operator precedence.

const p = new Parser();

function ast(sql) {
  const stmt = p.parse(`select ${sql}`);
  return stmt.columns[0].expr;
}

function stringDeep(sql) {
  return expressionToString(ast(sql));
}

function evalRoundtrip(sql) {
  const a = ast(sql);
  const s = expressionToString(a);
  let b;
  try {
    b = ast(s);
  } catch (e) {
    return { sql, stringified: s, reparse: `PARSE-ERROR: ${e.message}` };
  }
  // Compare via re-stringification of both (cheap proxy for AST equiv).
  return { sql, stringified: s, reparse: expressionToString(b) };
}

const cases = [
  // NOT IN (subquery) — the issue
  `Color not in (select Code from Block)`,
  `Color in (select Code from Block)`,
  `not (Color in (select Code from Block))`,

  // NOT IN (literal list)
  `x not in (1,2,3)`,
  `not (x in (1,2,3))`,

  // NOT BETWEEN
  `x not between 1 and 3`,
  `not (x between 1 and 3)`,

  // NOT LIKE / GLOB
  `x not like 'a%'`,
  `not (x like 'a%')`,

  // IS NOT / IS DISTINCT FROM
  `x is null`,
  `x is not null`,
  `not (x is null)`,

  // EXISTS / NOT EXISTS
  `not exists (select 1 from t)`,
  `exists (select 1 from t)`,

  // AND/OR precedence
  `a or b and c`,
  `not a and b`,
  `not (a and b)`,

  // arithmetic vs comparison
  `not a + b > c`,
  `not (a + b > c)`,

  // Mixed
  `x = 1 and y not in (select z from t)`,
  `(x = 1) and (y not in (select z from t))`,
];

console.log('sql -> stringified -> re-stringified');
for (const sql of cases) {
  const r = evalRoundtrip(sql);
  const ok = r.stringified === r.reparse ? '  OK ' : ' DRIFT';
  console.log(`${ok}  ${sql}`);
  console.log(`         out: ${r.stringified}`);
  if (r.stringified !== r.reparse) {
    console.log(`         re : ${r.reparse}`);
  }
}
