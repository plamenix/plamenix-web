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
  },
);
