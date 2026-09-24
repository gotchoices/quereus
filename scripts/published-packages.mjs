// Which package directories `yarn pub` publishes.
//
// Shared by `scripts/check-docs.mjs` (every published package's README carries a stability
// banner) and `scripts/published-visibility.mjs` (the post-publish wait asks npm for exactly these
// packages). Reads nothing itself: callers pass the root `package.json` scripts.

/**
 * The package directories `yarn pub` publishes, derived from the root `package.json` rather than
 * restated anywhere. `pub` chains `yarn pub:<step>` calls; each step runs
 * `node scripts/publish-package.js <dir>`, where `<dir>` is relative to `packages/`.
 *
 * Deriving it is the point. The first pass at the package banners hand-listed the packages and
 * silently missed two that publish, which is exactly the drift a hand-kept list invites.
 *
 * @param {Record<string, unknown>} scripts  The root manifest's `scripts`.
 * @returns {string[]}  Repository-relative directories, e.g. `packages/tools/planviz`, in `pub` order.
 */
export function publishedPackages(scripts) {
	const chain = scripts.pub;
	if (typeof chain !== 'string') {
		throw new Error(`package.json: no 'pub' script — cannot derive the list of published packages`);
	}

	const dirs = [];
	for (const [, step] of chain.matchAll(/\byarn\s+(pub:[\w:-]+)/g)) {
		const command = scripts[step];
		if (typeof command !== 'string') throw new Error(`package.json: 'pub' runs '${step}', which is not a script`);

		const arg = /publish-package\.js\s+(\S+)/.exec(command);
		if (!arg) throw new Error(`package.json: '${step}' does not call scripts/publish-package.js — cannot tell which package it publishes`);
		dirs.push(`packages/${arg[1]}`);
	}
	if (!dirs.length) throw new Error(`package.json: the 'pub' script chains no 'yarn pub:*' steps`);
	return dirs;
}
