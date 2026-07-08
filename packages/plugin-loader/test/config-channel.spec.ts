/**
 * Tests for the plugin config channel (config-loader `toPluginSqlConfig` +
 * `loadPluginsFromConfig`).
 *
 * Regression guard for the bug where a structured config value (e.g. IndexedDB's
 * `cache`) was flattened to a JSON *string* on the way to the plugin, which then
 * cast it straight to an object — silently dropping the user's setting. The
 * channel must deliver config objects to the plugin as objects.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Database } from '@quereus/quereus';
import { toPluginSqlConfig, loadPluginsFromConfig } from '../src/index.js';

const CAPTURE_KEY = '__quereusPluginConfigReceived';

/** A minimal ESM plugin whose default export records the config it was given. */
const CAPTURE_PLUGIN_SRC = `
export default function register(_db, config) {
	globalThis['${CAPTURE_KEY}'] = config;
	return {};
}
`;

function readCapturedConfig(): Record<string, unknown> | undefined {
	return (globalThis as Record<string, unknown>)[CAPTURE_KEY] as Record<string, unknown> | undefined;
}

describe('plugin config channel', () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		delete (globalThis as Record<string, unknown>)[CAPTURE_KEY];
		await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
	});

	describe('toPluginSqlConfig', () => {
		it('passes nested objects through unflattened (not JSON strings)', () => {
			const cache = { enabled: false, maxEntries: 42 };
			const sqlConfig = toPluginSqlConfig({ cache, databaseName: 'mydb', isolation: true });

			expect(sqlConfig.cache).toEqual(cache);
			expect(typeof sqlConfig.cache).toBe('object');
			// The scalars round-trip untouched.
			expect(sqlConfig.databaseName).toBe('mydb');
			expect(sqlConfig.isolation).toBe(true);
		});

		it('preserves arrays and normalizes undefined to null', () => {
			const sqlConfig = toPluginSqlConfig({ list: [1, 2, 3], missing: undefined });
			expect(sqlConfig.list).toEqual([1, 2, 3]);
			expect(sqlConfig.missing).toBeNull();
		});
	});

	describe('loadPluginsFromConfig round-trip', () => {
		it('delivers a structured cache config to the plugin as an object', async () => {
			const dir = await mkdtemp(join(tmpdir(), 'ql-plugin-channel-'));
			tempDirs.push(dir);
			const pluginPath = join(dir, 'capture-plugin.mjs');
			await writeFile(pluginPath, CAPTURE_PLUGIN_SRC, 'utf8');
			const source = pathToFileURL(pluginPath).href;

			const cache = { enabled: false, maxEntries: 7, maxBytes: 4096 };

			// db is only forwarded to the plugin's register(); our capture plugin ignores it.
			await loadPluginsFromConfig({} as unknown as Database, {
				plugins: [{ source, config: { cache, databaseName: 'user-db' } }],
			});

			const received = readCapturedConfig();
			expect(received, 'plugin register() should have been invoked').toBeDefined();
			expect(typeof received!.cache).toBe('object');
			expect(received!.cache).toEqual(cache);
			expect(received!.databaseName).toBe('user-db');
		});
	});
});
