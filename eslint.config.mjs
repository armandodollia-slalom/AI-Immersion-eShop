// @ts-check
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/bin/**',
      '**/obj/**',
      'artifacts/**',
      'graphify-out/**',
      'playwright-report/**',
      'test-results/**',
      // Browser assets served by the .NET apps (includes vendored libraries).
      'src/**/wwwroot/**',
      'src/ClientApp/**',
      'src/HybridApp/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
    },
  },
  {
    // Playwright idioms: fixtures without dependencies use `async ({}, use)` and specs poke at untyped JSON.
    files: ['e2e/**/*.ts'],
    rules: {
      'no-empty-pattern': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
