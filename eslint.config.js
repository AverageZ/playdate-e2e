import js from '@eslint/js';
import prettierConfig from 'eslint-config-prettier';
import checkFilePlugin from 'eslint-plugin-check-file';
import perfectionistPlugin from 'eslint-plugin-perfectionist';
import prettierPlugin from 'eslint-plugin-prettier';
import { readFileSync } from 'fs';
import globals from 'globals';
import { resolve } from 'path';
import tseslint from 'typescript-eslint';

const prettierOptions = JSON.parse(
  readFileSync(resolve('.prettierrc'), 'utf8'),
);

export default [
  js.configs.recommended,

  ...tseslint.configs.recommended,

  prettierConfig,

  {
    files: ['**/*.{js,mjs,cjs,ts}'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.es2021,
      },
      parser: tseslint.parser,
      parserOptions: {
        sourceType: 'module',
      },
    },
    plugins: {
      'check-file': checkFilePlugin,
      perfectionist: perfectionistPlugin,
      prettier: prettierPlugin,
    },
    rules: {
      // TypeScript
      '@typescript-eslint/consistent-type-definitions': ['error', 'type'],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-shadow': 'error',
      '@typescript-eslint/no-unused-vars': 0,

      // Core
      'arrow-body-style': [2, 'as-needed'],
      'no-console': 1,
      'no-constant-binary-expression': 1,
      'no-shadow': 'off',
      'no-unused-vars': 0,
      'padding-line-between-statements': [
        'error',
        { blankLine: 'always', next: 'return', prev: '*' },
      ],
      'prefer-template': 2,

      // Import sorting
      'perfectionist/sort-imports': [
        'error',
        {
          groups: [
            ['type-builtin', 'type-external'],
            ['builtin', 'external'],
            'type-internal',
            'internal',
            ['type-parent', 'type-sibling', 'type-index'],
            ['parent', 'sibling', 'index'],
            'unknown',
          ],
          newlinesBetween: 1,
          order: 'asc',
          type: 'alphabetical',
        },
      ],

      // Object sorting
      'perfectionist/sort-objects': [
        'error',
        {
          order: 'asc',
          partitionByComment: true,
          type: 'alphabetical',
        },
      ],

      // File naming
      'check-file/filename-naming-convention': [
        'error',
        { '**/*.{js,ts}': '+([a-zA-Z0-9])' },
        { ignoreMiddleExtensions: true },
      ],
      'check-file/folder-naming-convention': [
        'error',
        { 'src/**': 'KEBAB_CASE' },
      ],

      // Prettier
      'prettier/prettier': ['error', prettierOptions],
    },
  },

  // Test files — relax some rules
  {
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': 'off',
    },
  },

  {
    ignores: ['dist/**', 'node_modules/**', 'build/**'],
  },
];
