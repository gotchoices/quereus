/**
 * Tests for the post-publish wait's pure half (`scripts/published-visibility.mjs`), run by node's
 * built-in test runner (`yarn test:scripts`, part of `yarn test`). The wait itself —
 * `scripts/await-published.mjs`, which runs npm and sets the exit code — is not imported here.
 *
 * No test touches the network: the `npm view` outputs below are copied from real runs against the
 * public registry, and the registry question the wait asks is injected. The one test that reads the
 * repository's own manifests reads only local files. `publishedPackages` itself is pinned by
 * `scripts/check-docs.mjs`'s self-test.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { publishedPackages } from './published-packages.mjs';
import {
	NOT_YET_VISIBLE,
	expectedPackages,
	npmViewCommand,
	readViewAnswer,
	waitForVisibility
} from './published-visibility.mjs';

/** @param {string} path  Relative to the repository root. */
function readJson(path) {
	return JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
}

const ENGINE = { name: '@quereus/quereus', version: '4.19.4' };
const STORE = { name: '@quereus/store', version: '4.19.4' };
const SYNC = { name: '@quereus/sync', version: '4.19.4' };

describe('expectedPackages', () => {
	it('pairs each directory with the name and version in its own manifest', () => {
		const manifests = { 'packages/quereus': { name: ENGINE.name, version: ENGINE.version } };

		assert.deepEqual(expectedPackages(['packages/quereus'], (dir) => manifests[dir]), [ENGINE]);
	});

	it('refuses a manifest with no version to wait for', () => {
		assert.throws(() => expectedPackages(['packages/quereus'], () => ({ name: ENGINE.name })), /names no publishable version/);
	});

	it('finds a publishable name and version for every package this repository\'s `pub` publishes', () => {
		const { scripts } = readJson('package.json');
		const dirs = publishedPackages(scripts);

		const expected = expectedPackages(dirs, (dir) => readJson(`${dir}/package.json`));

		assert.equal(expected.length, dirs.length);
		assert.equal(new Set(expected.map(({ name }) => name)).size, dirs.length, 'two pub steps publish the same package');
	});
});

describe('npmViewCommand', () => {
	it('refuses a version carrying a character cmd.exe would interpret', () => {
		assert.throws(() => npmViewCommand({ name: ENGINE.name, version: '4.19.4&calc' }, 'win32'), /is not a version/);
	});
});

describe('readViewAnswer', () => {
	const E404 = JSON.stringify({ error: { code: 'E404', summary: 'No match found for version 4.19.4' } }, null, 2);

	it('counts the version echoed back as visible', () => {
		assert.deepEqual(readViewAnswer({ status: 0, stdout: '"4.19.4"\n', stderr: '' }, ENGINE), { visible: true });
	});

	it('counts both ways npm says a version is not there as not yet visible', () => {
		// Current npm: exit 1 with an E404 object. Older npm: exit 0 and no output.
		assert.deepEqual(readViewAnswer({ status: 1, stdout: E404, stderr: 'npm error code E404' }, ENGINE), { visible: false, reason: NOT_YET_VISIBLE });
		assert.deepEqual(readViewAnswer({ status: 0, stdout: '', stderr: '' }, ENGINE), { visible: false, reason: NOT_YET_VISIBLE });
	});

	it('keeps npm\'s own summary for any other failure', () => {
		const refused = JSON.stringify({ error: { code: 'ECONNREFUSED', summary: 'FetchError: request to http://127.0.0.1:9/@quereus%2fquereus failed' } });

		const answer = readViewAnswer({ status: 1, stdout: refused, stderr: '' }, ENGINE);

		assert.equal(answer.visible, false);
		assert.match(answer.reason, /^npm view failed with ECONNREFUSED: FetchError/);
	});

	it('throws on an answer to some other question rather than reading past it', () => {
		assert.throws(() => readViewAnswer({ status: 0, stdout: '"4.19.3"', stderr: '' }, ENGINE), /does not understand/);
		assert.throws(() => readViewAnswer({ status: 0, stdout: 'npm notice New major version', stderr: '' }, ENGINE), /not JSON/);
	});
});

/**
 * A wait over a fake clock: `sleep` advances it, and `probe` answers from `script` — for each package,
 * one answer per round in which it is asked, repeating the last.
 *
 * @param {Record<string, import('./published-visibility.mjs').ViewAnswer[]>} script
 * @param {{ timeoutMs?: number, intervalMs?: number }} [options]
 */
async function scriptedWait(script, { timeoutMs = 60_000, intervalMs = 5_000 } = {}) {
	let clock = 0;
	/** @type {{ name: string, at: number }[]} */
	const asked = [];
	const stragglers = await waitForVisibility({
		expected: Object.keys(script).map((name) => ({ name, version: ENGINE.version })),
		probe: async (spec) => {
			const answers = script[spec.name];
			const askedBefore = asked.filter((entry) => entry.name === spec.name).length;
			asked.push({ name: spec.name, at: clock });
			return answers[Math.min(askedBefore, answers.length - 1)];
		},
		timeoutMs,
		intervalMs,
		now: () => clock,
		sleep: async (ms) => { clock += ms; }
	});
	return { stragglers, asked, clock };
}

const SEEN = { visible: true };
const NOT_YET = { visible: false, reason: NOT_YET_VISIBLE };

describe('waitForVisibility', () => {
	it('finishes once every package has been seen, asking again only about the ones not yet seen', async () => {
		const { stragglers, asked, clock } = await scriptedWait({
			[ENGINE.name]: [NOT_YET, NOT_YET, SEEN],
			[STORE.name]: [NOT_YET, SEEN],
			[SYNC.name]: [SEEN]
		});

		assert.deepEqual(stragglers, []);
		assert.equal(clock, 10_000);
		assert.deepEqual(asked.map(({ name }) => name).sort(), [ENGINE.name, ENGINE.name, ENGINE.name, STORE.name, STORE.name, SYNC.name].sort());
	});

	it('gives up at the deadline, after one last round, naming each straggler with its latest reason', async () => {
		const refused = { visible: false, reason: 'npm view failed with ECONNREFUSED' };

		const { stragglers, asked } = await scriptedWait({
			[ENGINE.name]: [SEEN],
			[STORE.name]: [NOT_YET, refused]
		}, { timeoutMs: 12_000 });

		assert.deepEqual(stragglers, [{ spec: STORE, reason: refused.reason }]);
		assert.deepEqual(asked.filter(({ name }) => name === STORE.name).map(({ at }) => at), [0, 5_000, 10_000, 12_000]);
	});
});
