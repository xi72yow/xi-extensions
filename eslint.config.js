import js from '@eslint/js'
import globals from 'globals'

// gjs exposes the shell itself through globals rather than imports, and the
// shell provides a subset of the web timer api
const gjsGlobals = {
  global: 'readonly',
  log: 'readonly',
  logError: 'readonly',
  console: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  TextDecoder: 'readonly',
  TextEncoder: 'readonly',
}

export default [
  {
    // webtweaks carries its own style and is pending a rework, see README
    ignores: ['node_modules/**', 'chrome/webtweaks/**'],
  },
  js.configs.recommended,
  {
    files: ['gnome/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: gjsGlobals,
    },
  },
  {
    files: ['chrome/xiws/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...globals.serviceworker, chrome: 'readonly' },
    },
  },
  {
    files: ['scripts/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node,
    },
  },
]
