/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
	packageManager: 'yarn',
	reporters: ['html', 'clear-text', 'progress'],
	testRunner: 'mocha',
	checkers: ['typescript'],
	tsconfigFile: 'tsconfig.test.json',
	coverageAnalysis: 'perTest',
	timeoutMS: 30000,
	concurrency: 2,

	// Mutate only the subsystem directory passed via --mutate on the CLI.
	// Default: nothing (must be specified per run).
	mutate: [],

	mochaOptions: {
		config: '.mocharc.stryker.cjs',
		ignore: [
			'test/cross-platform/**',
			'test/documentation.spec.ts',
			'test/property.spec.ts',
			'test/property-planner.spec.ts',
			'test/fuzz.spec.ts',
			'test/stress.spec.ts',
			'test/performance-sentinels.spec.ts',
			'test/plugins.spec.ts',
		],
	},

	tempDirName: '.stryker-tmp',
	htmlReporter: {
		fileName: 'reports/mutation/mutation.html',
	},

	// Exclude vendored / generated / non-logic files from mutation
	ignorers: [],
	mutator: {
		excludedMutations: [
			'StringLiteral', // SQL keyword strings mutate into garbage — always killed by parse errors, not logic tests
		],
	},
};
