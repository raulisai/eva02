module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2021,
    sourceType: 'module',
    project: './tsconfig.json',
    tsconfigRootDir: __dirname,
  },
  env: {
    es2021: true,
    jest: true,
    node: true,
  },
  ignorePatterns: ['dist/', 'node_modules/'],
  rules: {
    'no-undef': 'off',
    'no-unused-vars': 'off',
  },
};
