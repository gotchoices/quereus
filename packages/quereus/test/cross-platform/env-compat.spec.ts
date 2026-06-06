/**
 * Environment compatibility audit — static analysis to verify the core engine
 * doesn't import Node.js-only modules or use unguarded Node.js globals.
 *
 * This catches regressions where someone accidentally adds a Node.js dependency
 * to the core engine, which would break browser/RN/edge worker environments.
 */

import { describe, it } from 'mocha';
import { expect } from 'chai';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const thisFile = fileURLToPath(import.meta.url);
const srcDir = join(thisFile, '..', '..', '..', 'src');

/** Node.js built-in modules (node: prefix form) that must not appear in src/ */
const FORBIDDEN_NODE_PREFIXED = [
	'node:fs', 'node:path', 'node:child_process', 'node:os', 'node:crypto',
	'node:net', 'node:http', 'node:https', 'node:stream', 'node:url',
	'node:util', 'node:buffer', 'node:events', 'node:assert',
	'node:worker_threads', 'node:cluster', 'node:dgram', 'node:dns',
	'node:readline', 'node:tls', 'node:vm', 'node:zlib',
	'node:perf_hooks', 'node:string_decoder', 'node:querystring',
];

/** Bare Node.js built-in module names (without node: prefix) */
const BARE_NODE_MODULES = [
	'fs', 'path', 'child_process', 'os', 'crypto',
	'net', 'http', 'https', 'stream', 'url',
	'util', 'buffer', 'events', 'assert',
	'worker_threads', 'cluster', 'dgram', 'dns',
	'readline', 'tls', 'vm', 'zlib',
	'perf_hooks', 'string_decoder', 'querystring',
];

/**
 * Files with known, documented process.* usage that is either properly guarded
 * or only executes in optional code paths (e.g. metrics).
 * Key: path relative to src/ (forward slashes).  Value: rationale.
 */
const PROCESS_EXCEPTIONS: Record<string, string> = {
};

interface Violation {
	file: string;
	line: number;
	text: string;
}

function formatViolations(violations: Violation[]): string {
	return violations.map(v => `  ${v.file}:${v.line}: ${v.text}`).join('\n');
}

/** Recursively collect all .ts source files (excluding tests). */
function collectSourceFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const fullPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...collectSourceFiles(fullPath));
		} else if (
			entry.name.endsWith('.ts') &&
			!entry.name.endsWith('.spec.ts') &&
			!entry.name.endsWith('.test.ts')
		) {
			files.push(fullPath);
		}
	}
	return files;
}

describe('Environment Compatibility Audit', () => {
	let sourceFiles: string[];

	before(() => {
		sourceFiles = collectSourceFiles(srcDir);
	});

	it('should find source files to scan', () => {
		void expect(sourceFiles.length).to.be.greaterThan(0);
	});

	it('should not contain node: prefix imports', () => {
		const violations: Violation[] = [];

		for (const file of sourceFiles) {
			const lines = readFileSync(file, 'utf-8').split('\n');
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				for (const forbidden of FORBIDDEN_NODE_PREFIXED) {
					if (line.includes(`'${forbidden}'`) || line.includes(`"${forbidden}"`)) {
						violations.push({
							file: relative(srcDir, file).replace(/\\/g, '/'),
							line: i + 1,
							text: line.trim(),
						});
					}
				}
			}
		}

		void expect(
			violations,
			`Found node: prefix imports:\n${formatViolations(violations)}`,
		).to.have.length(0);
	});

	it('should not import bare Node.js built-in modules', () => {
		const violations: Violation[] = [];
		// Match: import ... from 'fs' — but not from './fs' or '../path'
		const importFrom = /^\s*import\s.*from\s+['"]([^./][^'"]*)['"]/;

		for (const file of sourceFiles) {
			const lines = readFileSync(file, 'utf-8').split('\n');
			for (let i = 0; i < lines.length; i++) {
				const match = lines[i].match(importFrom);
				if (match && BARE_NODE_MODULES.includes(match[1])) {
					violations.push({
						file: relative(srcDir, file).replace(/\\/g, '/'),
						line: i + 1,
						text: lines[i].trim(),
					});
				}
			}
		}

		void expect(
			violations,
			`Found bare Node.js module imports:\n${formatViolations(violations)}`,
		).to.have.length(0);
	});

	it('should not contain bare require() calls', () => {
		const violations: Violation[] = [];
		const requireCall = /\brequire\s*\(/;

		for (const file of sourceFiles) {
			const lines = readFileSync(file, 'utf-8').split('\n');
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				if (
					requireCall.test(line) &&
					!line.trim().startsWith('//') &&
					!line.trim().startsWith('*')
				) {
					violations.push({
						file: relative(srcDir, file).replace(/\\/g, '/'),
						line: i + 1,
						text: line.trim(),
					});
				}
			}
		}

		void expect(
			violations,
			`Found require() calls:\n${formatViolations(violations)}`,
		).to.have.length(0);
	});

	it('should guard process access with typeof checks', () => {
		const violations: Violation[] = [];
		const processUsage = /\bprocess\./;
		const guardPattern = /typeof\s+process/;

		for (const file of sourceFiles) {
			const relPath = relative(srcDir, file).replace(/\\/g, '/');
			if (PROCESS_EXCEPTIONS[relPath]) continue;

			const lines = readFileSync(file, 'utf-8').split('\n');
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				if (
					processUsage.test(line) &&
					!line.trim().startsWith('//') &&
					!line.trim().startsWith('*')
				) {
					// Check surrounding lines (5 above) for a typeof guard
					const contextStart = Math.max(0, i - 5);
					const context = lines.slice(contextStart, i + 1).join('\n');
					if (!guardPattern.test(context)) {
						violations.push({
							file: relPath,
							line: i + 1,
							text: line.trim(),
						});
					}
				}
			}
		}

		void expect(
			violations,
			`Found unguarded process access (add typeof guard or document exception):\n${formatViolations(violations)}`,
		).to.have.length(0);
	});

	it('should not use Buffer (use Uint8Array instead)', () => {
		const violations: Violation[] = [];
		// Match Buffer usage as a type or value, but not in comments or string literals
		const bufferUsage = /\bBuffer\b/;
		const inComment = /^\s*(\/\/|\/?\*)/;

		for (const file of sourceFiles) {
			const lines = readFileSync(file, 'utf-8').split('\n');
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				if (bufferUsage.test(line) && !inComment.test(line)) {
					violations.push({
						file: relative(srcDir, file).replace(/\\/g, '/'),
						line: i + 1,
						text: line.trim(),
					});
				}
			}
		}

		void expect(
			violations,
			`Found Buffer usage (use Uint8Array for cross-platform compatibility):\n${formatViolations(violations)}`,
		).to.have.length(0);
	});
});
