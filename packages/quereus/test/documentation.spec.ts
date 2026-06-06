/**
 * Documentation validation tests.
 *
 * Verifies that README examples are runnable, doc links resolve,
 * and documented APIs match their actual signatures.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database } from '../src/index.js';
import * as fs from 'fs';
import * as path from 'path';

const PKG_ROOT = path.resolve(import.meta.dirname, '..');

describe('Documentation Validation', () => {

	describe('README Quick Start Example', () => {
		let db: Database;

		beforeEach(() => {
			db = new Database();
		});

		afterEach(async () => {
			await db.close();
		});

		it('should create table and insert data', async () => {
			await db.exec("create table users (id integer primary key, name text, email text)");
			await db.exec("insert into users values (1, 'Alice', 'alice@example.com')");

			const user = await db.get("select * from users where id = ?", [1]);
			expect(user).to.exist;
			expect(user!.name).to.equal('Alice');
			expect(user!.email).to.equal('alice@example.com');
		});

		it('should iterate over multiple rows with eval()', async () => {
			await db.exec("create table users (id integer primary key, name text, email text)");
			await db.exec("insert into users values (1, 'Alice', 'alice@example.com')");
			await db.exec("insert into users values (2, 'Bob', 'bob@example.com')");

			const names: unknown[] = [];
			for await (const row of db.eval("select * from users")) {
				names.push(row.name);
			}
			expect(names).to.have.lengthOf(2);
			expect(names).to.include('Alice');
			expect(names).to.include('Bob');
		});
	});

	describe('README Reactive Patterns Example', () => {
		let db: Database;

		beforeEach(() => {
			db = new Database();
		});

		afterEach(async () => {
			await db.close();
		});

		it('should fire data change events after commit', async () => {
			const events: { type: string; tableName: string }[] = [];

			db.onDataChange((event) => {
				events.push({ type: event.type, tableName: event.tableName });
			});

			await db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");
			await db.exec("INSERT INTO users VALUES (1, 'Alice')");

			expect(events.length).to.be.greaterThan(0);
			const insertEvent = events.find(e => e.type === 'insert' && e.tableName === 'users');
			expect(insertEvent).to.exist;
		});

		it('should fire schema change events', async () => {
			const events: { type: string; objectType: string; objectName: string }[] = [];

			db.onSchemaChange((event) => {
				events.push({
					type: event.type,
					objectType: event.objectType,
					objectName: event.objectName,
				});
			});

			await db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");

			const createEvent = events.find(
				e => e.type === 'create' && e.objectType === 'table' && e.objectName === 'users'
			);
			expect(createEvent).to.exist;
		});
	});

	describe('README Markdown Links', () => {
		let readmeContent: string;

		before(() => {
			readmeContent = fs.readFileSync(path.join(PKG_ROOT, 'README.md'), 'utf-8');
		});

		it('should have all relative doc links resolve to existing files', () => {
			// Match markdown links like [text](../docs/foo.md) or [text](../docs/foo.md#anchor)
			const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
			const brokenLinks: string[] = [];
			let match;

			while ((match = linkRegex.exec(readmeContent)) !== null) {
				const linkTarget = match[2];
				// Skip external links, anchors-only, and image references
				if (linkTarget.startsWith('http') || linkTarget.startsWith('#') || linkTarget.startsWith('data:')) {
					continue;
				}
				// Remove anchor from path
				const filePath = linkTarget.split('#')[0];
				if (!filePath) continue;

				const resolvedPath = path.resolve(PKG_ROOT, filePath);
				if (!fs.existsSync(resolvedPath)) {
					brokenLinks.push(`"${match[1]}" -> ${linkTarget} (resolved: ${resolvedPath})`);
				}
			}

			expect(brokenLinks, `Broken links found:\n${brokenLinks.join('\n')}`).to.have.lengthOf(0);
		});
	});

	describe('Core API surface matches documentation', () => {
		it('should export Database with documented methods', async () => {
			const db = new Database();
			// Methods documented in README and usage.md
			expect(db.exec).to.be.a('function');
			expect(db.get).to.be.a('function');
			expect(db.prepare).to.be.a('function');
			expect(db.eval).to.be.a('function');
			expect(db.close).to.be.a('function');
			expect(db.onDataChange).to.be.a('function');
			expect(db.onSchemaChange).to.be.a('function');
			expect(db.registerModule).to.be.a('function');
			await db.close();
		});
	});
});

