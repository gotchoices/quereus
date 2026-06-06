import { Database } from '../../dist/src/index.js';

let db;

export const benchmarks = [
	{
		name: 'bulk-insert-10k',
		iterations: 5,
		warmup: 1,
		async fn() {
			const d = new Database();
			await d.exec('create table bulk_t (id integer primary key, val integer, label text)');
			for (let batch = 0; batch < 20; batch++) {
				const values = Array.from({ length: 500 }, (_, j) => {
					const id = batch * 500 + j + 1;
					return `(${id}, ${id * 3}, 'label_${id % 50}')`;
				}).join(', ');
				await d.exec(`insert into bulk_t values ${values}`);
			}
			await d.close();
		},
	},
	{
		name: 'single-row-insert-1k',
		iterations: 5,
		warmup: 1,
		async fn() {
			const d = new Database();
			await d.exec('create table single_t (id integer primary key, val integer)');
			for (let i = 1; i <= 1000; i++) {
				await d.exec(`insert into single_t values (${i}, ${i * 2})`);
			}
			await d.close();
		},
	},
	{
		name: 'update-where-1k',
		iterations: 5,
		warmup: 1,
		async setup() {
			db = new Database();
			await db.exec('create table upd_t (id integer primary key, val integer, label text)');
			for (let batch = 0; batch < 20; batch++) {
				const values = Array.from({ length: 500 }, (_, j) => {
					const id = batch * 500 + j + 1;
					return `(${id}, ${id % 100}, 'label_${id % 50}')`;
				}).join(', ');
				await db.exec(`insert into upd_t values ${values}`);
			}
		},
		async teardown() { await db.close(); db = null; },
		async fn() {
			await db.exec("update upd_t set label = 'updated' where val < 10");
			await db.exec("update upd_t set label = 'reset' where val < 10");
		},
	},
	{
		name: 'delete-where-100',
		iterations: 5,
		warmup: 1,
		async fn() {
			const d = new Database();
			await d.exec('create table del_t (id integer primary key, val integer)');
			for (let batch = 0; batch < 20; batch++) {
				const values = Array.from({ length: 500 }, (_, j) => {
					const id = batch * 500 + j + 1;
					return `(${id}, ${id % 100})`;
				}).join(', ');
				await d.exec(`insert into del_t values ${values}`);
			}
			await d.exec('delete from del_t where val = 42');
			await d.close();
		},
	},
];
