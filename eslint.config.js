import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist',
      'node_modules',
      '**/dist/**',
      '**/node_modules/**',
      'packages/fbclient-node/target/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  ...tseslint.configs.stylistic,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
    },
    rules: {
      // A leading underscore is how this codebase already says "this
      // binding is deliberately unused" — `formatRelative(at, _tick)`
      // takes an argument purely to document that its output depends on
      // a ticking clock. Without this the convention the code was
      // written against does not exist, and the only ways to satisfy
      // the rule are a disable comment per site or deleting the marker.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
);
