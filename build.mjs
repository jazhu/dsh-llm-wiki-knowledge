/**
 * dsh-knowledge-base build.
 *
 * Produces two bundles (mirrors the official dsh-plugin layout):
 *   - dist/index.mjs  host plugin (ESM)     — Node half, mounts /kb-api routes
 *   - dist/client.js  client plugin (CJS)   — browser half, sidebar entry + drawer
 *
 * `react`, `react-dom`, and `react/jsx-runtime` are externalized: the harness
 * provides them at runtime as baseline module-table entries.
 *
 * Usage:  pnpm install && pnpm run build
 */
import { build } from 'esbuild'
import { mkdirSync, cpSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(import.meta.url)

mkdirSync('dist', { recursive: true })

// pdf.js runtime assets. The bundled index.mjs inlines the pdf.js *main*
// module, but it still needs its worker plus the CMap / standard-font tables
// resolved from its own directory at runtime (see src/pdf-extract.ts). Copy
// those sibling assets into dist/ so the plugin is fully self-contained and
// independent of the host's module resolution.
const pdfjsDir = (() => {
  try {
    // require.resolve returns .../pdfjs-dist/package.json; its dir IS the pkg root.
    return dirnameOf(require.resolve('pdfjs-dist/package.json'))
  } catch {
    return null
  }
})()
function dirnameOf(p) {
  return p.replace(/[/\\][^/\\]*$/, '')
}
if (pdfjsDir && existsSync(join(pdfjsDir, 'legacy/build/pdf.worker.mjs'))) {
  cpSync(join(pdfjsDir, 'legacy/build/pdf.worker.mjs'), join('dist', 'pdf.worker.mjs'))
  cpSync(join(pdfjsDir, 'cmaps'), join('dist', 'cmaps'), { recursive: true })
  cpSync(join(pdfjsDir, 'standard_fonts'), join('dist', 'standard_fonts'), { recursive: true })
  console.log('[build] copied pdf.js runtime assets into dist/')
} else {
  console.warn('[build] pdfjs-dist assets not found; PDF parsing will not work')
}

// Type-check gate. esbuild bundles without type-checking, so a typo like the
// historical `id is not defined` (a rename that slipped the bundler) would
// otherwise ship and crash at runtime. Fail the build loudly before bundling.
// A local `typescript` (from devDependencies) provides `tsc`; if it is missing
// we skip the gate with a clear warning instead of breaking CI.
const tscCmd = (() => {
  try {
    require.resolve('typescript')
    return ['node', require.resolve('typescript/bin/tsc'), '--noEmit']
  } catch {
    return null
  }
})()

if (tscCmd) {
  try {
    execFileSync(tscCmd[0], tscCmd.slice(1), { stdio: 'inherit' })
    console.log('[build] tsc type-check: OK')
  } catch (err) {
    const code = err && err.status
    if (code === 2) {
      console.error('[build] tsc type-check FAILED — aborting build')
      process.exit(2)
    }
    console.warn('[build] tsc run failed, skipping type-check gate:', err && err.message)
  }
} else {
  console.warn('[build] typescript not found, skipping type-check gate')
}

const dshExternal = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-*']

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.mjs',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  sourcemap: true,
  external: dshExternal,
  logLevel: 'info',
})

await build({
  entryPoints: ['src/client.tsx'],
  outfile: 'dist/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['es2022'],
  sourcemap: true,
  jsx: 'automatic',
  external: [
    ...dshExternal,
    'react',
    'react-dom',
    'react-dom/client',
    'react/jsx-runtime',
    'react/jsx-dev-runtime',
    'scheduler',
  ],
  banner: {
    js: "window.__ModuleLoader__.load({ id: 'dsh-llm-wiki-knowledge', factory: (require) => { var module = { exports: {} }; var exports = module.exports;",
  },
  footer: { js: 'return module.exports; } });' },
  logLevel: 'info',
})
