// Mocha config used by Stryker mutation testing.
// Stryker runs from packages/quereus/ so paths are relative to that.
module.exports = {
	require: ['./register-cjs-compat.mjs'],
	spec: ['test/**/*.spec.ts'],
	timeout: 15000,
	bail: true,
	colors: true,
};
