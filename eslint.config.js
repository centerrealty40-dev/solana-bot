import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

/** Minimal flat config for ESLint 9 + TypeScript (solana-alpha `src/` only). */
export default [
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'tests/**',
      'scripts-tmp/**',
      'drizzle.config.ts',
      'vitest.config.ts',
      'eslint.config.js',
    ],
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
];
