// @ts-check

import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import * as importPlugin from 'eslint-plugin-import';

export default tseslint.config(
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      import: importPlugin,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
			'@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
			'import/extensions': ['error', 'always', { ignorePackages: true }],
			'@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true }]
    },
  },
  {
    // Chai assertions like `expect(x).to.be.true` read as unused expressions.
    files: ['test/**/*.ts', 'test/**/*.tsx'],
    rules: {
      '@typescript-eslint/no-unused-expressions': 'off',
    },
  },
);
