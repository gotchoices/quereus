import { Parser } from '../../dist/src/parser/parser.js';

const parser = new Parser();

const simpleSelect = 'select id, name, email from users where active = 1 order by name';
const complexSelect = `
	select u.id, u.name, o.total,
		(select count(*) from reviews r where r.user_id = u.id) as review_count
	from users u
	join orders o on o.user_id = u.id
	left join addresses a on a.user_id = u.id
	where u.active = 1 and o.total > 50
	group by u.id, u.name, o.total
	having count(*) > 1
	order by o.total desc
	limit 100
`;
const wideCols = Array.from({ length: 50 }, (_, i) => `col_${i}`).join(', ');
const wideSelect = `select ${wideCols} from big_table where col_0 > 10`;
const insertValues = `insert into t (a, b, c, d) values (1, 'hello', 3.14, null), (2, 'world', 2.72, null), (3, 'foo', 1.41, null)`;

export const benchmarks = [
	{
		name: 'simple-select',
		iterations: 50,
		warmup: 5,
		fn() {
			parser.parseAll(simpleSelect);
		},
	},
	{
		name: 'complex-select',
		iterations: 50,
		warmup: 5,
		fn() {
			parser.parseAll(complexSelect);
		},
	},
	{
		name: 'wide-select-50cols',
		iterations: 50,
		warmup: 5,
		fn() {
			parser.parseAll(wideSelect);
		},
	},
	{
		name: 'insert-values',
		iterations: 50,
		warmup: 5,
		fn() {
			parser.parseAll(insertValues);
		},
	},
];
