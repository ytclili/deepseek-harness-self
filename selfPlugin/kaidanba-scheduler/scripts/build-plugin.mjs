import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
await mkdir(new URL('../lib/', import.meta.url), { recursive: true })
await build({
  absWorkingDir: root,
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
})
const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/client.tsx'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['chrome100'],
  external: ['react', 'react-dom'],
  tsconfigRaw: { compilerOptions: { jsx: 'react', esModuleInterop: true } },
  loader: { '.css': 'text' },
  define: { 'process.env.NODE_ENV': '"production"' },
  minify: true,
  legalComments: 'none',
  write: false,
})
const bundled = result.outputFiles[0]?.text
if (!bundled) throw new Error('No client bundle was produced')
await writeFile(new URL('../lib/client.js', import.meta.url), `window.__ModuleLoader__.load({
  id: ${JSON.stringify(manifest.name)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    ${bundled}
    return module.exports;
  }
});\n`)
console.log('Built Harness host entry and settings client bundle.')
