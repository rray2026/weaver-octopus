// @ts-check
const { default: tseslint } = require('typescript-eslint');
const prettier = require('eslint-config-prettier');

/** @type {import("eslint").Linter.Config[]} */
const config = [
  ...tseslint.configs.recommended,
  prettier,
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
];

module.exports = config;
