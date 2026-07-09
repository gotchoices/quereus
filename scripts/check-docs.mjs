#!/usr/bin/env node

// Documentation integrity gate. Cheapest link in `yarn check`, so it runs first.
//
// Three independent checks, all reporting to one failure list:
//
//   A. Link integrity   — every markdown link and every `docs/*.md` reference in
//                         the source tree names a file that exists, and every
//                         `#anchor` names a heading that exists in that file.
//   B. Invariant format — `docs/invariants.md` (when present) parses as a register
//                         of invariant blocks whose `code:`/`guard:`/`doc:` pointers
//                         still resolve. Pointers only; semantics are what tests are for.
//   C. Size ratchet     — a doc listed in `docs/.doc-budget.json` may shrink but never
//                         grow past its recorded size; an unlisted doc must come in
//                         under the global `maxWords`.
//
// Usage:
//   node scripts/check-docs.mjs                    run every check; exit 1 on any failure
//   node scripts/check-docs.mjs --update-ratchet   lower ratchet entries to current sizes
//   node scripts/check-docs.mjs --update-ratchet --force
//                                                  ...also allow raising / adding entries
//
// See docs/doc-conventions.md for what belongs in a doc and how to lower a ratchet entry.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUDGET_PATH = join(ROOT, 'docs', '.doc-budget.json');
const INVARIANTS_PATH = join(ROOT, 'docs', 'invariants.md');

// Frozen review artifacts: they describe a past state on purpose and must not be "corrected".
const EXEMPT = new Set(['docs/review.md', 'docs/review.html']);

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'out', 'coverage']);

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

/** Repo-relative, forward-slashed. The repo is developed on win32; `\` never leaves this module. */
const toPosix = (p) => p.split(sep).join('/');
const repoPath = (abs) => toPosix(relative(ROOT, abs));

/**
 * Read with line endings normalized to `\n`.
 *
 * NOTE: this is load-bearing on win32, where the working tree is CRLF. JavaScript's `.`
 * does not match `\r` (it is a line terminator), so a `(.*)$` pattern silently fails to
 * match any line of a CRLF file — fences never open and headings never parse. Every
 * regex in this module assumes LF; read through here, never `readFileSync` directly.
 */
const readText = (path) => readFileSync(path, 'utf8').replace(/\r\n?/g, '\n');

// NOTE: the tree is re-walked and every file re-read on each run (~1s for this repo). If the
// checker ever shows up as slow in `yarn check`, cache results by mtime rather than trimming
// the corpus — a check that skips files is a check that misses breakage.
function walk(dir, predicate, found = []) {
	if (!existsSync(dir)) return found;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), predicate, found);
		} else if (predicate(join(dir, entry.name))) {
			found.push(join(dir, entry.name));
		}
	}
	return found;
}

function packageDirs() {
	const pkgRoot = join(ROOT, 'packages');
	if (!existsSync(pkgRoot)) return [];
	return readdirSync(pkgRoot, { withFileTypes: true })
		.filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name))
		.map((e) => join(pkgRoot, e.name));
}

/** `docs/**\/*.md`, minus the frozen review artifacts. */
function docFiles() {
	return walk(join(ROOT, 'docs'), (f) => f.endsWith('.md')).filter((f) => !EXEMPT.has(repoPath(f)));
}

/**
 * The repo README plus every package README, top-level and nested under `src/` or `test/`.
 * These are source-tree docs. The repo README carries the documentation index, so it is the
 * most link-dense file in the tree and the one whose rot is most visible to a newcomer.
 */
function readmeFiles() {
	const files = [];
	const rootReadme = join(ROOT, 'README.md');
	if (existsSync(rootReadme)) files.push(rootReadme);
	for (const pkg of packageDirs()) {
		const top = join(pkg, 'README.md');
		if (existsSync(top)) files.push(top);
		const nested = (f) => f.endsWith(`${sep}README.md`);
		files.push(...walk(join(pkg, 'src'), nested));
		files.push(...walk(join(pkg, 'test'), nested));
	}
	return files;
}

/** `packages/*\/src/**\/*.ts` and `packages/*\/test/**\/*.ts`. */
function sourceFiles() {
	const files = [];
	const isTs = (f) => f.endsWith('.ts') && !f.endsWith('.d.ts');
	for (const pkg of packageDirs()) {
		files.push(...walk(join(pkg, 'src'), isTs));
		files.push(...walk(join(pkg, 'test'), isTs));
	}
	return files;
}

// ---------------------------------------------------------------------------
// markdown
// ---------------------------------------------------------------------------

/**
 * Blank out fenced code blocks, preserving line count so reported line numbers stay true.
 * Several docs show example markdown; without this the checker reports phantom links.
 *
 * NOTE: inline code spans are *not* blanked, so a link written entirely inside backticks
 * (`` `[text](target.md)` ``) is still extracted and resolved. No doc does that today; if
 * one starts to, blank spans on non-fence lines rather than loosening the link regex —
 * link *text* is often inline code (`[`alter table …`](#anchor)`) and must keep resolving.
 */
function stripFences(content) {
	const lines = content.split('\n');
	let fenceChar = null;
	let fenceLen = 0;

	return lines
		.map((line) => {
			const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
			if (fenceChar === null) {
				if (match) {
					fenceChar = match[1][0];
					fenceLen = match[1].length;
					return '';
				}
				return line;
			}
			const closes = match && match[1][0] === fenceChar && match[1].length >= fenceLen && match[2].trim() === '';
			if (closes) fenceChar = null;
			return '';
		})
		.join('\n');
}

/**
 * GitHub's heading-anchor algorithm, as implemented by `github-slugger`:
 * lowercase, drop punctuation and symbols, spaces to hyphens, `-1`/`-2` for repeats.
 *
 * What survives is letters, numbers, `_` and `-` — note that "letters" is Unicode-wide,
 * so `### Selection (σ)` anchors as `selection-σ`. What goes is punctuation and symbols:
 * the U+2011 non-breaking hyphen, and `≡ → ∅ & ( )`. That is why
 * `### Rename propagation ("MV ≡ faster view")` resolves with a *double* hyphen — the
 * dropped `≡` leaves its two surrounding spaces behind. Live links depend on these exact
 * forms; `selfTest()` pins them.
 */
function slugify(headingText) {
	return headingText
		.toLowerCase()
		.replace(/[^\p{L}\p{N} _-]/gu, '')
		.replace(/ /g, '-');
}

/** Render heading source to the text GitHub slugs: link syntax collapses to its label. */
function headingText(raw) {
	return raw
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.trim();
}

/**
 * Every anchor `content` exposes, computed with a per-file repeat counter.
 *
 * NOTE: `-1`/`-2` suffixes are assigned in document order, so reordering two headings that
 * share a base slug silently retargets any link to the suffixed one. Both mega-docs repeat
 * `### Overview` / `### Registration`. If a split ticket ever moves such a pair, re-check
 * its links by hand — the checker cannot see that kind of breakage.
 */
function headingSlugs(content) {
	const seen = new Map();
	const slugs = new Set();

	for (const line of stripFences(content).split('\n')) {
		const match = /^(#{1,6})\s+(.*)$/.exec(line);
		if (!match) continue;

		const base = slugify(headingText(match[2]));
		const count = seen.get(base) ?? 0;
		seen.set(base, count + 1);
		slugs.add(count === 0 ? base : `${base}-${count}`);
	}
	return slugs;
}

const anchorCache = new Map();

function anchorsOf(absPath) {
	if (!anchorCache.has(absPath)) {
		anchorCache.set(absPath, headingSlugs(readText(absPath)));
	}
	return anchorCache.get(absPath);
}

// ---------------------------------------------------------------------------
// reference extraction
// ---------------------------------------------------------------------------

const EXTERNAL = /^(https?:|mailto:|data:|tel:|#!)/;

/** Markdown links `](target)` outside fenced code, with 1-based line numbers. */
function markdownLinks(content) {
	const refs = [];
	stripFences(content)
		.split('\n')
		.forEach((line, index) => {
			for (const match of line.matchAll(/\]\(([^)]+)\)/g)) {
				// `](path "title")` — the target is the first whitespace-delimited token.
				const target = match[1].trim().split(/\s+/)[0].replace(/^<|>$/g, '');
				if (!target || EXTERNAL.test(target)) continue;
				refs.push({ target, line: index + 1 });
			}
		});
	return refs;
}

/**
 * Bare `docs/<name>.md` / `docs/<name>.md#anchor` references in the source tree.
 *
 * The lookbehind rejects anything preceded by a path segment, which is what makes
 * `// ...like [text](../docs/foo.md)` in documentation.spec.ts a non-reference: it is
 * an illustration of link syntax, not a pointer at a real file. A *bare* ref is
 * repo-root-relative by definition.
 *
 * A trailing prose section marker (`See docs/optimizer.md § Audit discipline`) is not an
 * anchor and is ignored — the regex simply stops at `.md`.
 */
function bareDocRefs(content) {
	const refs = [];
	content.split('\n').forEach((line, index) => {
		for (const match of line.matchAll(/(?<![\w./\\-])(docs\/[A-Za-z0-9._-]+\.md)(#[A-Za-z0-9_-]+)?/g)) {
			refs.push({ target: match[1] + (match[2] ?? ''), line: index + 1, rootRelative: true });
		}
	});
	return refs;
}

// ---------------------------------------------------------------------------
// Check A — link integrity
// ---------------------------------------------------------------------------

function checkReference(ref, referrerAbs, fail) {
	const [targetPath, anchor] = ref.target.split('#');
	const where = `${repoPath(referrerAbs)}:${ref.line}`;

	// `](#anchor)` — same-page, validated against the containing file.
	if (targetPath === '') {
		if (anchor && !anchorsOf(referrerAbs).has(anchor)) {
			fail(`${where}: dead same-page anchor '#${anchor}'`);
		}
		return;
	}

	const base = ref.rootRelative ? ROOT : dirname(referrerAbs);
	const absTarget = resolve(base, targetPath);

	if (!existsSync(absTarget)) {
		fail(`${where}: link target does not exist: '${targetPath}'`);
		return;
	}
	// `](../quereus-store/)` — a directory link; GitHub renders its README. Nothing to anchor into.
	if (statSync(absTarget).isDirectory()) {
		if (anchor) fail(`${where}: anchor '#${anchor}' on a directory target '${targetPath}'`);
		return;
	}
	if (!anchor) return;

	if (!absTarget.endsWith('.md')) {
		fail(`${where}: anchor '#${anchor}' on a non-markdown target '${targetPath}'`);
		return;
	}
	if (EXEMPT.has(repoPath(absTarget))) return;

	if (!anchorsOf(absTarget).has(anchor)) {
		fail(`${where}: dead anchor '#${anchor}' in '${targetPath}'`);
	}
}

function checkLinks(fail) {
	for (const file of [...docFiles(), ...readmeFiles()]) {
		const content = readText(file);
		for (const ref of markdownLinks(content)) checkReference(ref, file, fail);
	}
	// Bare `docs/*.md` refs live in the source tree, never in `docs/` prose — a design doc
	// legitimately names a sibling doc (or a planned one) in running text. A README's fenced
	// blocks are stripped for the same reason they are stripped above: a doc path inside a
	// shell example is an illustration, not a pointer. TypeScript has no fences to strip.
	for (const file of [...readmeFiles(), ...sourceFiles()]) {
		const content = readText(file);
		const scanned = file.endsWith('.md') ? stripFences(content) : content;
		for (const ref of bareDocRefs(scanned)) checkReference(ref, file, fail);
	}
}

// ---------------------------------------------------------------------------
// Check B — invariant-block format
// ---------------------------------------------------------------------------

const INVARIANT_HEADING = /^### ((?:OPT|MV|RT|SCH|SYNC|LENS))-(\d{3}) — .+$/;
const META_LINE = /^-\s+(code|guard|doc):\s*(.*)$/;
const MAX_INVARIANT_BODY_WORDS = 120;

/**
 * Split `docs/invariants.md` into `### ID — title` blocks, keeping line numbers.
 *
 * A block ends at the next heading of ANY level, so an area's `## <Area>` heading and the
 * preamble prose under it are charged to nobody — not to the preceding invariant's 120-word
 * budget. (Before this, an area preamble silently ate the last block's headroom.)
 */
function parseInvariantBlocks(content) {
	const blocks = [];
	let open = null;
	stripFences(content)
		.split('\n')
		.forEach((line, index) => {
			if (/^### /.test(line)) {
				open = { heading: line, line: index + 1, body: [] };
				blocks.push(open);
			} else if (/^#{1,6} /.test(line)) {
				open = null; // a heading of any other level closes the current block
			} else if (open) {
				open.body.push({ text: line, line: index + 1 });
			}
		});
	return blocks;
}

/** `- code: \`path\` — \`symbol\` (aside)` → `{ kind, path, symbol }`. */
function parseMetaLine(kind, rest) {
	if (kind === 'doc') {
		const link = /\]\(([^)\s]+)\)/.exec(rest);
		return link ? { kind, target: link[1] } : null;
	}
	if (kind === 'guard' && /^none\b/.test(rest)) {
		// `guard: none — <reason>` is legal and explicit. A bare `guard: none` is not.
		return { kind, none: true, reason: rest.slice('none'.length).replace(/^\s*—\s*/, '').trim() };
	}
	const ticked = [...rest.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
	if (!ticked.length) return null;
	return { kind, path: ticked[0], symbol: ticked[1] };
}

function checkInvariantPointer(meta, at, fail) {
	if (meta.kind === 'doc') {
		checkReference({ target: meta.target, line: at.line }, INVARIANTS_PATH, fail);
		return;
	}
	const abs = resolve(ROOT, meta.path);
	if (!existsSync(abs) || !statSync(abs).isFile()) {
		fail(`${at.where}: ${meta.kind}: names a file that does not exist: '${meta.path}'`);
		return;
	}
	// NOTE: a plain substring match, so a symbol surviving only in a comment still passes. That is
	// the intended strength — this validates pointers, not semantics. If it ever needs to be
	// stricter, match against the file with comments stripped rather than parsing TypeScript here.
	// Consequence for `guard:`: a common token (`isSet`) matches anywhere in the spec file and a
	// heading-style comment matches too, so a guard can name something that is not a test and still
	// pass. Write the exact `describe`/`it` title, or the name of the function driving the law.
	if (meta.symbol && !readText(abs).includes(meta.symbol)) {
		fail(`${at.where}: ${meta.kind}: symbol '${meta.symbol}' no longer appears in '${meta.path}'`);
	}
}

function checkInvariantBlock(block, ids, lastPerArea, fail) {
	const where = `docs/invariants.md:${block.line}`;
	const match = INVARIANT_HEADING.exec(block.heading);
	if (!match) {
		fail(`${where}: invariant heading must match '### <AREA>-<NNN> — <title>': ${block.heading.trim()}`);
		return;
	}

	const [, area, digits] = match;
	const id = `${area}-${digits}`;
	if (ids.has(id)) fail(`${where}: duplicate invariant id '${id}' (first seen at line ${ids.get(id)})`);
	else ids.set(id, block.line);

	// Ascending within an area; gaps are fine — a retired invariant's number is never reused.
	const previous = lastPerArea.get(area);
	if (previous !== undefined && Number(digits) <= previous) {
		fail(`${where}: invariant '${id}' is out of order — ${area} ids must ascend (previous was ${area}-${String(previous).padStart(3, '0')})`);
	}
	lastPerArea.set(area, Number(digits));

	const metas = [];
	const prose = [];
	for (const { text, line } of block.body) {
		const metaMatch = META_LINE.exec(text.trim());
		if (!metaMatch) {
			prose.push(text);
			continue;
		}
		const parsed = parseMetaLine(metaMatch[1], metaMatch[2].trim());
		if (!parsed) {
			fail(`docs/invariants.md:${line}: malformed '${metaMatch[1]}:' line — expected a \`path\` (or a markdown link for doc:)`);
			continue;
		}
		metas.push({ ...parsed, line });
	}

	if (!metas.some((m) => m.kind === 'code')) fail(`${where}: invariant '${id}' has no 'code:' line`);

	const guards = metas.filter((m) => m.kind === 'guard');
	if (guards.length !== 1) fail(`${where}: invariant '${id}' has ${guards.length} 'guard:' lines — expected exactly one`);
	for (const guard of guards) {
		if (guard.none && !guard.reason) {
			fail(`docs/invariants.md:${guard.line}: bare 'guard: none' — state the reason: 'guard: none — <reason>'`);
		}
	}

	for (const meta of metas) {
		if (meta.none) continue;
		checkInvariantPointer(meta, { where: `docs/invariants.md:${meta.line}`, line: meta.line }, fail);
	}

	const words = countWords(prose.join('\n'));
	if (words > MAX_INVARIANT_BODY_WORDS) {
		fail(`${where}: invariant '${id}' body is ${words} words (max ${MAX_INVARIANT_BODY_WORDS}) — it is two invariants, or it is rationale wearing an invariant's clothes`);
	}
}

function checkInvariants(fail) {
	// A zero-invariant register is the starting state, not a failure.
	if (!existsSync(INVARIANTS_PATH)) return;

	const blocks = parseInvariantBlocks(readText(INVARIANTS_PATH));
	const ids = new Map();
	const lastPerArea = new Map();
	for (const block of blocks) checkInvariantBlock(block, ids, lastPerArea, fail);
}

// ---------------------------------------------------------------------------
// Check C — size ratchet
// ---------------------------------------------------------------------------

/**
 * Whitespace-separated tokens over the whole file, fenced code included. Counting prose-only
 * is more principled and less predictable; a doc whose bulk is code samples is just as
 * unreviewable. The number only has to be comparable to itself over time.
 */
function countWords(content) {
	return content.split(/\s+/).filter(Boolean).length;
}

function readBudget() {
	if (!existsSync(BUDGET_PATH)) {
		throw new Error(`missing ${repoPath(BUDGET_PATH)} — the size ratchet has no data`);
	}
	return JSON.parse(readFileSync(BUDGET_PATH, 'utf8'));
}

function measureDocs() {
	const sizes = new Map();
	for (const file of docFiles()) sizes.set(repoPath(file), countWords(readText(file)));
	return sizes;
}

// NOTE: a ratchet entry naming a doc that no longer exists is not reported — it is inert, and
// `--update-ratchet` removes it. If a stale entry ever masks a re-added doc's real size, make
// this fail on the orphan instead.
function checkRatchet(fail) {
	const budget = readBudget();
	for (const [doc, words] of measureDocs()) {
		const recorded = budget.ratchet[doc];
		if (recorded === undefined) {
			if (words > budget.maxWords) {
				fail(`${doc}: ${words} words exceeds the ${budget.maxWords}-word cap for an unratcheted doc — split it, or record it with --update-ratchet --force and say why in the commit message`);
			}
		} else if (words > recorded) {
			fail(`${doc}: ${words} words exceeds its ratchet of ${recorded} (+${words - recorded}) — a doc may shrink, never grow`);
		}
	}
}

function updateRatchet(force) {
	const budget = readBudget();
	const sizes = measureDocs();
	const changes = [];
	const refusals = [];

	for (const [doc, recorded] of Object.entries(budget.ratchet)) {
		const words = sizes.get(doc);
		if (words === undefined) {
			changes.push(`  removed ${doc} (no longer present)`);
			delete budget.ratchet[doc];
		} else if (words < recorded) {
			changes.push(`  lowered ${doc}: ${recorded} -> ${words} (-${recorded - words})`);
			budget.ratchet[doc] = words;
		} else if (words > recorded) {
			if (!force) refusals.push(`  ${doc}: grew to ${words} from a ratchet of ${recorded} (+${words - recorded})`);
			else {
				changes.push(`  RAISED ${doc}: ${recorded} -> ${words} (+${words - recorded})`);
				budget.ratchet[doc] = words;
			}
		}
	}

	for (const [doc, words] of sizes) {
		if (budget.ratchet[doc] !== undefined || words <= budget.maxWords) continue;
		if (!force) refusals.push(`  ${doc}: ${words} words, over the ${budget.maxWords}-word cap and not in the ratchet`);
		else {
			changes.push(`  ADDED ${doc}: ${words}`);
			budget.ratchet[doc] = words;
		}
	}

	if (refusals.length) {
		console.error('Refusing to raise the ratchet (a ratchet you can silently raise is not a ratchet):');
		for (const refusal of refusals) console.error(refusal);
		console.error('\nShrink the doc, or re-run with --force and justify the raise in the commit message.');
		return 1;
	}

	if (!changes.length) {
		console.log('Ratchet already matches current doc sizes; nothing to do.');
		return 0;
	}

	budget.ratchet = Object.fromEntries(Object.entries(budget.ratchet).sort(([a], [b]) => a.localeCompare(b)));
	writeFileSync(BUDGET_PATH, `${JSON.stringify(budget, null, '\t')}\n`);
	console.log('Updated the ratchet:');
	for (const change of changes) console.log(change);
	return 0;
}

// ---------------------------------------------------------------------------
// self-test — pins the slugifier against forms that live links already depend on
// ---------------------------------------------------------------------------

function selfTest(fail) {
	const cases = [
		['Rename propagation ("MV ≡ faster view")', 'rename-propagation-mv--faster-view'],
		['Strategy selection (hash → merge)', 'strategy-selection-hash--merge'],
		['Row‑specific vs Global Classification for Assertions', 'rowspecific-vs-global-classification-for-assertions'],
		['Conflict Resolution (OR clause)', 'conflict-resolution-or-clause'],
		['2.1.1 Schema Search Path (WITH SCHEMA)', '211-schema-search-path-with-schema'],
		['`function_info()` columns', 'function_info-columns'],
		['Audit discipline: `sideEffectMode`', 'audit-discipline-sideeffectmode'],
		// Unicode letters survive; symbols and dashes do not.
		['Selection (σ)', 'selection-σ'],
		['4. Contract — retire the old table', '4-contract--retire-the-old-table'],
		['Store Isolation (Store Phase 8 - Future)', 'store-isolation-store-phase-8---future'],
		// Invariant headings: the em dash leaves a double hyphen, so a back-link written as
		// the short `#opt-014` does NOT resolve. Every back-link in the tree uses the full
		// slug; this case pins the form Check A resolves them against.
		['OPT-014 — An attribute ID is originated exactly once', 'opt-014--an-attribute-id-is-originated-exactly-once'],
		['OPT-030 — Uniqueness is read through one surface', 'opt-030--uniqueness-is-read-through-one-surface'],
	];
	for (const [heading, expected] of cases) {
		const actual = slugify(headingText(heading));
		if (actual !== expected) fail(`scripts/check-docs.mjs: slugifier regression: '${heading}' -> '${actual}', expected '${expected}'`);
	}

	const repeated = headingSlugs('## Overview\n\n## Overview\n\n## Overview\n');
	for (const expected of ['overview', 'overview-1', 'overview-2']) {
		if (!repeated.has(expected)) fail(`scripts/check-docs.mjs: duplicate-heading disambiguation lost '${expected}'`);
	}
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
	const args = process.argv.slice(2);
	if (args.includes('--update-ratchet')) {
		process.exit(updateRatchet(args.includes('--force')));
	}

	// One breakage can reach `fail` twice: a `[x](docs/foo.md)` link in a README matches both the
	// markdown-link and the bare-`docs/*.md` extractor, and a `doc:` line in the invariant register
	// is a markdown link that Check A already resolved. The message carries its own `path:line`, so
	// identical strings are the same defect. Report each once, in discovery order.
	const failures = [];
	const seen = new Set();
	const fail = (message) => {
		if (seen.has(message)) return;
		seen.add(message);
		failures.push(message);
	};

	selfTest(fail);
	checkLinks(fail);
	checkInvariants(fail);
	checkRatchet(fail);

	if (failures.length) {
		for (const failure of failures) console.error(failure);
		console.error(`\n${failures.length} documentation failure(s). See docs/doc-conventions.md.`);
		process.exit(1);
	}
	console.log('Docs OK: links resolve, invariants well-formed, sizes within ratchet.');
}

main();
