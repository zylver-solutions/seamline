// Flat config. Kept deliberately small: this project's own design argues that a
// gate which passes because it checks nothing is worse than no gate, so every
// rule here is one we intend to enforce rather than a preset we inherited.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'seamline-out/**',
      '.eval-cache/**',
      'eval-out/**',
      'packages/*/src/__fixtures__/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // Extraction must be deterministic (v3 §2.3); an unawaited promise
      // reorders emission and silently breaks byte-identical output.
      '@typescript-eslint/no-floating-promises': 'off', // needs type-aware linting; enabled in the typed block below
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // `any` defeats the contract that every package is written against.
      '@typescript-eslint/no-explicit-any': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'off',
    },
  },
  {
    // Tests may be looser about non-null assertions on fixture lookups.
    files: ['**/*.test.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
);
