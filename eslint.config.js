// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/test-results/**',
      '**/playwright-report/**',
      'packs/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        project: [
          './packages/*/tsconfig.json',
          './apps/web/tsconfig.json',
          './apps/web/tsconfig.node.json',
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // noUncheckedIndexedAccess makes every indexed read possibly undefined;
      // loops over typed arrays and bounded indices assert with `!` instead.
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      // The map view is the only module allowed to depend on the map library.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'leaflet', message: 'Use the MapView interface from @atlas/core/mapview.' },
            { name: 'pmtiles', message: 'Use the MapView interface from @atlas/core/mapview.' },
          ],
          patterns: [
            {
              group: ['leaflet/*'],
              message: 'Use the MapView interface from @atlas/core/mapview.',
            },
          ],
        },
      ],
    },
  },
  {
    // The map view module wraps Leaflet; the pipeline writes PMTiles archives.
    files: ['packages/core/src/mapview/**', 'packages/pipeline/src/**'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    files: ['apps/web/src/**/*.tsx'],
    extends: [reactHooks.configs.flat['recommended-latest'], reactRefresh.configs.vite],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['**/*.js'],
    languageOptions: { globals: globals.node },
  },
  prettier,
);
