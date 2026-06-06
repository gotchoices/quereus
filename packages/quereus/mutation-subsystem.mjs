#!/usr/bin/env node

// Run Stryker mutation testing scoped to a single source directory.
// Usage: node mutation-subsystem.mjs <subsystem>
//   e.g. node mutation-subsystem.mjs analysis        → src/planner/analysis/
//        node mutation-subsystem.mjs emit             → src/runtime/emit/
//        node mutation-subsystem.mjs builtins         → src/func/builtins/
//        node mutation-subsystem.mjs memory           → src/vtab/memory/
//        node mutation-subsystem.mjs src/some/path    → literal path

import { execSync } from 'child_process';

const aliases = {
	analysis:  'src/planner/analysis',
	emit:      'src/runtime/emit',
	builtins:  'src/func/builtins',
	memory:    'src/vtab/memory',
};

const arg = process.argv[2];
if (!arg) {
	console.error('Usage: node mutation-subsystem.mjs <subsystem|path>');
	console.error('Aliases:', Object.keys(aliases).join(', '));
	process.exit(1);
}

const dir = aliases[arg] || arg;
const mutateGlob = `${dir}/**/*.ts`;

console.log(`Mutation testing: ${mutateGlob}`);

const extra = process.argv.slice(3).join(' ');
const cmd = `npx stryker run stryker.config.mjs --mutate "${mutateGlob}" ${extra}`.trim();

try {
	execSync(cmd, { stdio: 'inherit', cwd: import.meta.dirname });
} catch {
	process.exit(1);
}
