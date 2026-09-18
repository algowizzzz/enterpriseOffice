import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

/**
 * Lint rules chosen for the mistakes that actually cost something here, rather
 * than for style. Formatting is left alone: it is not what breaks a document.
 *
 * The type-aware rules are the point. A promise nobody awaits is how a save
 * silently fails, and it is exactly the class of bug that already appeared in
 * this codebase.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      'apps/web/vite.config.ts',
      'apps/web/vitest.config.ts',
      'apps/server/vitest.config.ts',
      'eslint.config.js',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['*.js', '*.mjs', 'scripts/*.mjs'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // A promise nobody waits for is how a save quietly does not happen.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      // Off deliberately. Fastify's plugin and handler contracts are async by
      // signature whether or not a particular one awaits anything, so this rule
      // only ever fires on code that is shaped the way the framework requires.
      '@typescript-eslint/require-await': 'off',

      // Dead code is a maintenance cost and often the remains of a half-finished
      // change. An argument prefixed with an underscore is deliberate.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],

      // `any` defeats the point of the shared model, which is that the editor
      // and the server cannot disagree about what a document is.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',

      '@typescript-eslint/no-non-null-assertion': 'error',
      'no-console': 'off',
      eqeqeq: ['error', 'always'],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },

  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  {
    // The build and test scripts are plain Node modules, not part of either
    // TypeScript project.
    files: ['scripts/**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: { globals: globals.node },
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  {
    // Tests reach into internals on purpose and mock with loose shapes.
    files: ['**/test/**/*.{ts,tsx}', 'scripts/**/*.mjs'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      // Spying on a global such as window.confirm detaches the method on
      // purpose, which is exactly what this rule is built to warn about.
      '@typescript-eslint/unbound-method': 'off',
      // A mock replaces a function whose type the mock library widens, so an
      // async implementation reads as a promise handed to a void slot. The rule
      // stays on everywhere that ships.
      '@typescript-eslint/no-misused-promises': 'off',
    },
  },
);
