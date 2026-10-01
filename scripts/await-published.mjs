#!/usr/bin/env node
/**
 * Post-publish wait — the step of `yarn release` between `yarn pub` and `yarn gh-release`, and
 * runnable on its own as `yarn await-published`.
 *
 * `yarn pub` returns once the registry has accepted each publish, but npm starts serving a new
 * version at its own moment. A downstream upgrade run inside that gap resolves the old version (for
 * optimystic 1.3.0, some packages appeared 30–90 s after the rest, and a dependent repo's upgrade
 * picked up a mix). So the release waits here until npm serves every package `pub` published, and
 * the GitHub release — the signal that a release is out — is created only after that.
 *
 * Listing a version is not the same as serving it. `npm view` reads the package's metadata, while
 * `npm install` downloads the tarball, which the registry makes available separately and later: for
 * sereus 1.8.0 every version was listed while three tarballs still answered 404 minutes afterwards.
 *
 * This script reads which packages `yarn pub` publishes from the root `package.json` (its `pub:*`
 * chain, through `scripts/published-packages.mjs`) and, for each one at its manifest's version, asks
 * npm whether it is listed and then whether its tarball can be downloaded. It asks again until every
 * package passes both or the deadline passes, and ends with one line saying which. Re-run it
 * after an interrupted release: it reports on the versions currently in the manifests.
 *
 * This file is only the shell-out and the printing; the logic is in
 * `scripts/published-visibility.mjs`. Ported from optimystic's `scripts/await-published.mjs`. No build
 * step, no dependencies.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { argv, env, exit, stderr, stdout } from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
	FETCH_TIMEOUT_MS,
	expectedPackages,
	npmViewCommand,
	progressLine,
	readTarballAnswer,
	readViewAnswer,
	specString,
	successLine,
	timeoutReport,
	waitForVisibility
} from './published-visibility.mjs';
import { publishedPackages } from './published-packages.mjs';

/** The repository root: manifests are read relative to it, wherever the script is run from. */
const ROOT = fileURLToPath(new URL('..', import.meta.url));

const TIMEOUT_ENV = 'QUEREUS_PUBLISH_WAIT_SECONDS';
const DEFAULT_TIMEOUT_S = 600;
const INTERVAL_MS = 5_000;
/**
 * Backstop for an `npm view` that neither answers nor fails; npm's own fetch timeout
 * (`FETCH_TIMEOUT_MS`) is the bound that normally applies.
 *
 * NOTE: on Windows this kills cmd.exe but not the npm process under it, which keeps the output pipe
 * open, so the call only returns when npm itself gives up. That is why the fetch timeout is set on
 * npm rather than relied on here; if a Windows wait is ever seen to overrun its deadline, kill the
 * process tree (`taskkill /t`) instead.
 */
const PROBE_TIMEOUT_MS = 60_000;
/** An unchanged waiting line is repeated this often, so a long wait does not look hung. */
const HEARTBEAT_MS = 30_000;
/**
 * Asks every cache between here and the registry to revalidate the tarball rather than answer from
 * what it holds: an edge that cached the 404 from before the tarball existed would otherwise keep
 * the wait going after the registry serves it.
 *
 * NOTE: a CDN edge is not bound to honour this, and an installer elsewhere reaches its own edge. If a
 * wait is ever seen to finish while an install elsewhere still 404s the tarball, that edge was stale;
 * retry from the installer's side, or add a short settle delay after the wait.
 */
const REVALIDATE = { 'cache-control': 'no-cache' };

const execFileAsync = promisify(execFile);

/**
 * Exit code and output of a finished command, whatever the exit code. Throws only when the command
 * could not be started at all; resolves `timedOut` when it had to be killed.
 *
 * @param {{ file: string, args: string[] }} command
 * @param {number} timeout
 */
async function run({ file, args }, timeout) {
	try {
		const { stdout: out, stderr: err } = await execFileAsync(file, args, { cwd: ROOT, encoding: 'utf8', timeout, windowsHide: true });
		return { status: 0, stdout: out, stderr: err, timedOut: false };
	} catch (err) {
		if (err.killed) return { status: null, stdout: '', stderr: '', timedOut: true };
		if (typeof err.code !== 'number') throw err;
		return { status: err.code, stdout: err.stdout ?? '', stderr: err.stderr ?? '', timedOut: false };
	}
}

/** @param {string} path  Relative to the repository root. */
function readManifest(path) {
	return JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
}

function expectedFromManifests() {
	const dirs = publishedPackages(readManifest('package.json').scripts ?? {});
	return expectedPackages(dirs, (dir) => readManifest(join(dir, 'package.json')));
}

/**
 * Whether `spec` counts as published: npm lists it, and then its tarball can be downloaded.
 *
 * @param {import('./published-visibility.mjs').PackageSpec} spec
 * @returns {Promise<import('./published-visibility.mjs').Visibility>}
 */
async function probe(spec) {
	const result = await run(npmViewCommand(spec), PROBE_TIMEOUT_MS);
	if (result.timedOut) return { visible: false, reason: `npm view did not answer within ${PROBE_TIMEOUT_MS / 1000} s` };
	const view = readViewAnswer(result, spec);
	return view.listed ? probeTarball(view.tarball) : { visible: false, reason: view.reason };
}

/**
 * A `HEAD` of the tarball URL npm gave. Not npm itself: npm has no cheap "does this download exist"
 * question — `npm pack` and `npm cache add` fetch the whole file into npm's cache, where a later run
 * could then find it without asking the registry. The URL is npm's own answer, so the registry is
 * still the one npm publishes to. A failed request is a reason, not an error: the wait asks again.
 *
 * NOTE: a plain fetch carries none of npm's credentials, which is fine while every package is
 * published `--access public` (`scripts/publish-package.js`). If one is ever published to a registry
 * that requires auth for downloads, this answers 401 and the wait times out naming it; then pass the
 * registry token, or ask npm instead.
 *
 * NOTE: nothing checks that the `latest` dist-tag points at the new version, though a downstream
 * `yarn up` resolves `latest`. `yarn pub` publishes with no `--tag`, so it does; if an upgrade is ever
 * seen to pick the previous version after this wait succeeded, ask for `dist-tags.latest` in the same
 * `npm view` call (for non-prerelease versions).
 *
 * @param {string} url
 * @returns {Promise<import('./published-visibility.mjs').Visibility>}
 */
async function probeTarball(url) {
	try {
		const response = await fetch(url, { method: 'HEAD', headers: REVALIDATE, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
		return readTarballAnswer(response.status);
	} catch (err) {
		return { visible: false, reason: `could not reach ${url}: ${[err.message, err.cause?.message].filter(Boolean).join(': ')}` };
	}
}

function timeoutMs() {
	const raw = env[TIMEOUT_ENV];
	if (raw === undefined || raw === '') return DEFAULT_TIMEOUT_S * 1000;
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) throw new Error(`${TIMEOUT_ENV} must be a positive number of seconds, not ${JSON.stringify(raw)}`);
	return value * 1000;
}

/** Prints a waiting line when the stragglers or their reasons change, and at least every `HEARTBEAT_MS`. */
function progressPrinter() {
	let lastKey;
	let lastAt = -Infinity;
	/** @param {import('./published-visibility.mjs').Progress} progress */
	return (progress) => {
		const key = progress.stragglers.map(({ spec, reason }) => `${specString(spec)} ${reason}`).join('\n');
		if (key === lastKey && progress.elapsedMs - lastAt < HEARTBEAT_MS) return;
		lastKey = key;
		lastAt = progress.elapsedMs;
		stdout.write(progressLine(progress));
	};
}

async function main() {
	const deadline = timeoutMs();
	const expected = expectedFromManifests();
	stdout.write(`await-published: waiting up to ${deadline / 1000} s for ${expected.length} packages: ${expected.map(specString).join(', ')}\n`);
	const stragglers = await waitForVisibility({
		expected,
		probe,
		timeoutMs: deadline,
		intervalMs: INTERVAL_MS,
		now: () => Date.now(),
		sleep,
		onProgress: progressPrinter()
	});
	if (stragglers.length > 0) {
		stderr.write(timeoutReport(stragglers, expected.length, deadline));
		exit(1);
	}
	stdout.write(successLine(expected));
}

function printUsage() {
	stdout.write('Usage: node scripts/await-published.mjs\n\n');
	stdout.write('Waits until npm lists every package `yarn pub` publishes at the version in its package.json\n');
	stdout.write('and serves the tarball for that version, then prints one line saying so. Exits non-zero,\n');
	stdout.write('naming the packages still missing, when the deadline passes first\n');
	stdout.write(`(default ${DEFAULT_TIMEOUT_S} s; set ${TIMEOUT_ENV} to change it).\n`);
	stdout.write('See docs/releasing.md.\n');
}

if (argv.includes('--help') || argv.includes('-h')) {
	printUsage();
	exit(0);
}

try {
	await main();
} catch (err) {
	stderr.write(`await-published: ${err instanceof Error ? err.message : String(err)}\n`);
	exit(1);
}
