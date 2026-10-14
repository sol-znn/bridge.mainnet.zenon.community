import ts from 'typescript-eslint'
import vue from 'eslint-plugin-vue'

export default [
  { ignores: ['audit/**', '.pipeline/**', 'dist/**', 'coverage/**', 'node_modules/**', 'e2e/lab/.build/**', 'e2e/lab/assets/**', 'e2e/.state/**', 'e2e/.cache/**'] },
  ...ts.configs.recommended,
  ...vue.configs['flat/essential'],
  { files: ['**/*.vue'], languageOptions: { parserOptions: { parser: ts.parser } } },
  { rules: {
    'vue/multi-word-component-names': ['error', { ignores: ['Address', 'Amount', 'Banner', 'Modal', 'Terms', 'Starfield'] }],
    'eqeqeq': ['error', 'always'], 'no-eval': 'error', 'no-implied-eval': 'error', 'no-debugger': 'error',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
  } },
  { files: ['tests/**', 'e2e/**'], rules: { '@typescript-eslint/no-explicit-any': 'off' } },
]
