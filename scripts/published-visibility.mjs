/**
 * The pure half of the post-publish wait: the packages `yarn pub` publishes, what `npm view` and a
 * request for each package's tarball said about it, and when to stop asking. Which directories `pub` publishes comes from
 * `scripts/published-packages.mjs`, the same derivation `scripts/check-docs.mjs` uses.
 *
 * Nothing here runs a command, reads a file or exits. `scripts/await-published.mjs` does that, and is
 * the place to read about why the wait exists. The two are separate files so the tests
 * (`scripts/published-visibility.test.mjs`) can import these functions without running the wait.
 */
import { env, platform } from 'node:process';

/**
 * @typedef {object} PackageSpec  One package a release publishes, at the version it publishes.
 * @property {string} name     e.g. `@quereus/quereus`
 * @property {string} version  e.g. `4.19.4`
 *
 * @typedef {{ listed: true, tarball: string } | { listed: false, reason: string }} ViewAnswer
 *   What `npm view` said: the registry lists the version, with the URL its tarball is served from.
 *
 * @typedef {{ visible: true } | { visible: false, reason: string }} Visibility
 *   Whether a package counts as published: listed, and its tarball downloadable.
 *
 * @typedef {object} Straggler  A package the registry did not yet show at its version.
 * @property {PackageSpec} spec
 * @property {string} reason  Why it counts as not visible, from the most recent answer.
 *
 * @typedef {object} Progress
 * @property {Straggler[]} stragglers
 * @property {number} total      How many packages the wait is for.
 * @property {number} elapsedMs
 */

/** The reason given for a package the registry simply does not list at its version yet. */
export const NOT_YET_VISIBLE = 'not on the registry yet';

/** The reason given for a package the registry lists, but whose tarball it does not serve yet. */
export const TARBALL_NOT_YET_DOWNLOADABLE = 'tarball not downloadable yet';

/** An npm package name, optionally scoped. */
const PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;

/** Semver, restricted to the characters semver allows — none of which cmd.exe interprets. */
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** How long one registry request — npm's, or the tarball check — may take before it counts as failed. */
export const FETCH_TIMEOUT_MS = 30_000;

/** `name@version`, the form npm takes and the form every report prints. */
export function specString({ name, version }) {
	return `${name}@${version}`;
}

// -- Which packages ------------------------------------------------------------------------------

/**
 * Each published directory's package, at the version its own manifest names — the version
 * `yarn npm publish` (in `scripts/publish-package.js`) reads, so after `yarn bump` it is the version
 * the release just published.
 *
 * @param {string[]} dirs  Repository-relative, as `publishedPackages` returns them.
 * @param {(dir: string) => { name?: unknown, version?: unknown }} manifestAt  The parsed `package.json` in `dir`.
 * @returns {PackageSpec[]}
 */
export function expectedPackages(dirs, manifestAt) {
	return dirs.map((dir) => {
		const { name, version } = manifestAt(dir);
		if (typeof name !== 'string' || !PACKAGE_NAME_RE.test(name)) {
			throw new Error(`${dir}/package.json names no publishable package (found ${JSON.stringify(name)})`);
		}
		if (typeof version !== 'string' || !VERSION_RE.test(version)) {
			throw new Error(`${dir}/package.json names no publishable version (found ${JSON.stringify(version)})`);
		}
		return { name, version };
	});
}

// -- Asking npm ----------------------------------------------------------------------------------

/**
 * `cli` with `args`, as an executable plus an argument array.
 *
 * On Windows `npm` is a `.cmd` shim, which Node refuses to spawn directly (since the fix for
 * CVE-2024-27980), and `shell: true` with an argument array is deprecated because it joins the
 * arguments unescaped. Running the shim through `cmd.exe` is the route Node's documentation gives for
 * batch files. That is safe only for arguments carrying no character cmd.exe interprets, which is why
 * `npmViewCommand` validates the name and version before building the command.
 *
 * @param {string} cli
 * @param {string[]} args
 * @param {string} [os]  `process.platform`, injectable for tests.
 * @returns {{ file: string, args: string[] }}
 */
export function cliCommand(cli, args, os = platform) {
	return os === 'win32'
		? { file: env['ComSpec'] ?? 'cmd.exe', args: ['/d', '/s', '/c', cli, ...args] }
		: { file: cli, args };
}

/**
 * The `npm view` call that asks the registry for exactly `spec`, and for the URL of its tarball.
 * `--prefer-online` makes npm
 * revalidate its local metadata cache instead of answering from it: the question is what the
 * registry serves now. The fetch flags make one call one bounded request: the wait already asks
 * again every few seconds, and npm's own defaults (two retries, five minutes each) would let a
 * single stalled call outlast the whole deadline.
 *
 * NOTE: `npm view` reads the registry's full metadata document for a package. Installers usually read
 * the abbreviated one (`application/vnd.npm.install-v1+json`), which the registry caches separately,
 * so the two could briefly disagree. If a downstream upgrade is ever seen to resolve an old version
 * after this wait reported success, ask for the abbreviated document too.
 *
 * @param {PackageSpec} spec
 * @param {string} [os]  `process.platform`, injectable for tests.
 */
export function npmViewCommand(spec, os) {
	if (!PACKAGE_NAME_RE.test(spec.name)) throw new Error(`${JSON.stringify(spec.name)} is not a package name`);
	if (!VERSION_RE.test(spec.version)) throw new Error(`${JSON.stringify(spec.version)} is not a version`);
	return cliCommand('npm', ['view', '--prefer-online', '--fetch-retries=0', `--fetch-timeout=${FETCH_TIMEOUT_MS}`, '--json', specString(spec), 'version', 'dist.tarball'], os);
}

/**
 * Read one finished `npm view --json <name>@<version> version dist.tarball`.
 *
 * - An object naming the version and an http(s) `dist.tarball` means the registry lists it, and says
 *   where its tarball is. Listed is not yet published: the tarball is served separately, and later.
 * - The version with no usable `dist.tarball` — npm prints a lone field's value bare, so a missing
 *   one leaves just the version string — gives nothing to download, so it does not count as listed.
 * - An `E404` error object means it is not listed yet. npm gives the same answer for a version the
 *   registry does not list and for a package it has never heard of, so a package's first release
 *   waits the same way as every later one. Older npm answered a missing version with exit 0 and no
 *   output, which means the same.
 * - Any other error — a network failure, a refused credential — also means not listed, and carries
 *   npm's own summary so the report says why.
 *
 * Anything else throws: npm was not answering the question asked, and a wait that read past it could
 * spend its whole deadline misreading one answer, or finish on one it never understood.
 *
 * @param {{ status: number, stdout: string, stderr: string }} result  Exit code and output.
 * @param {PackageSpec} spec
 * @returns {ViewAnswer}
 */
export function readViewAnswer({ status, stdout, stderr }, spec) {
	const text = stdout.trim();
	if (text === '') return emptyViewAnswer(status, stderr);
	const answer = parseViewJson(text, spec);
	if (status === 0) return readListing(answer, spec, text);
	const code = answer?.error?.code;
	if (typeof code !== 'string') throw notUnderstood(spec, status, text);
	if (code === 'E404') return { listed: false, reason: NOT_YET_VISIBLE };
	const summary = answer.error.summary;
	return { listed: false, reason: `npm view failed with ${code}${typeof summary === 'string' && summary ? `: ${summary}` : ''}` };
}

/**
 * The parsed output of an `npm view` that succeeded: the version asked for, and its tarball's URL.
 *
 * @param {unknown} answer
 * @param {PackageSpec} spec
 * @param {string} text  The raw output, for the error when `answer` is not about `spec`.
 * @returns {ViewAnswer}
 */
function readListing(answer, spec, text) {
	const fields = typeof answer === 'object' && answer !== null && !Array.isArray(answer) ? answer : undefined;
	const version = typeof answer === 'string' ? answer : fields?.version;
	if (version !== spec.version) throw notUnderstood(spec, 0, text);
	const tarball = fields?.['dist.tarball'];
	if (tarball === undefined) return { listed: false, reason: 'npm view listed no dist.tarball' };
	if (!isHttpUrl(tarball)) return { listed: false, reason: `npm view listed dist.tarball ${JSON.stringify(tarball)}, which is not an http(s) URL` };
	return { listed: true, tarball };
}

/**
 * Only http(s) reaches the registry: `fetch` answers a `data:` URL with 200 without asking anyone.
 *
 * @param {unknown} value
 * @returns {value is string}
 */
function isHttpUrl(value) {
	return typeof value === 'string' && URL.canParse(value) && ['http:', 'https:'].includes(new URL(value).protocol);
}

/**
 * @param {PackageSpec} spec
 * @param {number} status
 * @param {string} text
 */
function notUnderstood(spec, status, text) {
	return new Error(`npm view ${specString(spec)} answered something this script does not understand (exit ${status}): ${text}`);
}

/**
 * Read the HTTP status of a `HEAD` request for a listed version's tarball. Only 200 means the
 * download `npm install` makes would succeed now; 404 is the registry not serving it yet.
 *
 * @param {number} status
 * @returns {Visibility}
 */
export function readTarballAnswer(status) {
	if (status === 200) return { visible: true };
	if (status === 404) return { visible: false, reason: TARBALL_NOT_YET_DOWNLOADABLE };
	return { visible: false, reason: `tarball answered HTTP ${status}` };
}

/**
 * @param {number} status
 * @param {string} stderr
 * @returns {ViewAnswer}
 */
function emptyViewAnswer(status, stderr) {
	if (status === 0) return { listed: false, reason: NOT_YET_VISIBLE };
	const said = stderr.trim().split(/\r?\n/)[0];
	return { listed: false, reason: `npm view exited ${status}${said ? `: ${said}` : ' and printed nothing'}` };
}

/**
 * @param {string} text
 * @param {PackageSpec} spec
 * @returns {unknown}
 */
function parseViewJson(text, spec) {
	try {
		return JSON.parse(text);
	} catch (err) {
		throw new Error(`npm view ${specString(spec)} printed output that is not JSON: ${text}`, { cause: err });
	}
}

// -- Waiting -------------------------------------------------------------------------------------

/**
 * Ask about every package, then again every `intervalMs` about the ones not yet seen, until all have
 * been seen or `timeoutMs` has passed. A package seen once is not asked about again. The last round
 * runs at the deadline, so a package that lands just before it still counts.
 *
 * @param {object} options
 * @param {PackageSpec[]} options.expected
 * @param {(spec: PackageSpec) => Promise<Visibility>} options.probe  Whether one package counts as published.
 * @param {number} options.timeoutMs
 * @param {number} options.intervalMs
 * @param {() => number} options.now  A millisecond clock.
 * @param {(ms: number) => Promise<void>} options.sleep
 * @param {(progress: Progress) => void} [options.onProgress]  Called after each round that leaves stragglers, except the last.
 * @returns {Promise<Straggler[]>}  The packages still not visible at the deadline; empty when every one was seen.
 */
export async function waitForVisibility({ expected, probe, timeoutMs, intervalMs, now, sleep, onProgress }) {
	const start = now();
	let pending = expected;
	for (;;) {
		const stragglers = await askRound(pending, probe);
		const elapsedMs = now() - start;
		if (stragglers.length === 0 || elapsedMs >= timeoutMs) return stragglers;
		onProgress?.({ stragglers, total: expected.length, elapsedMs });
		pending = stragglers.map(({ spec }) => spec);
		await sleep(Math.min(intervalMs, timeoutMs - elapsedMs));
	}
}

/**
 * Ask about every package in `pending` at once; the ones not yet visible, with the reason.
 *
 * @param {PackageSpec[]} pending
 * @param {(spec: PackageSpec) => Promise<Visibility>} probe
 * @returns {Promise<Straggler[]>}
 */
async function askRound(pending, probe) {
	const answers = await Promise.all(pending.map(async (spec) => ({ spec, answer: await probe(spec) })));
	return answers.flatMap(({ spec, answer }) => answer.visible ? [] : [{ spec, reason: answer.reason }]);
}

// -- Reporting -----------------------------------------------------------------------------------

/** @param {number} ms */
function seconds(ms) {
	return `${Math.round(ms / 1000)} s`;
}

/**
 * The single line that says the release is published.
 *
 * @param {PackageSpec[]} expected
 */
export function successLine(expected) {
	const versions = [...new Set(expected.map(({ version }) => version))].join(', ');
	return `all ${expected.length} packages published and visible on npm at ${versions}\n`;
}

/**
 * One line of waiting: which packages, and why, when the reason is anything but not-there-yet.
 *
 * @param {Progress} progress
 */
export function progressLine({ stragglers, total, elapsedMs }) {
	const names = stragglers.map(({ spec, reason }) => reason === NOT_YET_VISIBLE ? specString(spec) : `${specString(spec)} (${reason})`);
	return `waiting for ${stragglers.length} of ${total} packages to show on npm (${seconds(elapsedMs)}): ${names.join(', ')}\n`;
}

/**
 * The report when the deadline passed with packages still missing.
 *
 * @param {Straggler[]} stragglers
 * @param {number} total
 * @param {number} timeoutMs
 */
export function timeoutReport(stragglers, total, timeoutMs) {
	return [
		`${stragglers.length} of ${total} packages still not visible on npm after ${seconds(timeoutMs)}:`,
		...stragglers.map(({ spec, reason }) => `  ${specString(spec)} — ${reason}`),
		'The release is not finished: the GitHub release was not created, and downstream upgrades may still resolve older versions',
		'or fail to download them.',
		'If this ran as part of `yarn release`, npm already accepted the publish: do NOT re-run `yarn release` (it would bump',
		'to yet another version). Once the registry catches up, run `yarn await-published` again, then `yarn gh-release`.',
		'If a publish itself failed, publish the missing package first (`yarn pub:<name>`), then do the same.',
		''
	].join('\n');
}
