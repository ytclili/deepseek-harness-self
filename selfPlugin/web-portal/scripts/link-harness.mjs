/** Link the host's built workspace dependencies without downloading alternate Cordis copies. */
import { mkdir, lstat, realpath, symlink, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const harness = resolve(process.argv[2] ?? join(root, '../..'));
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const packages = {
  'dsh-enterprise-auth': 'selfPlugin/enterprise-auth',
  '@deepseek-ai/dsh-tools': 'packages/core/tools',
  '@deepseek-ai/cordis': 'vendor/cordis',
  '@deepseek-ai/schemastery': 'vendor/schemastery',
  '@deepseek-ai/dsh-host-webserver': 'packages/host/webserver',
  '@deepseek-ai/dsh-client-connection': 'packages/client/connection',
  '@deepseek-ai/dsh-web-frontend': 'apps/web',
  '@types/node': 'node_modules/@types/node',
  typescript: 'node_modules/typescript',
};
// Validate the complete dependency set before changing an existing installation.
for (const [name, version] of Object.entries(manifest.peerDependencies)) {
  if (!packages[name]) throw new Error(`No local link configured for ${name}`);
  const actual = JSON.parse(await readFile(join(harness, packages[name], 'package.json'), 'utf8'));
  if (actual.name !== name || actual.version !== version) throw new Error(`${name}: Harness ${actual.version} does not match declared ${version}; review compatibility first.`);
}
for (const [name, relative] of Object.entries(packages)) {
  const source = await realpath(join(harness, relative));
  const target = join(root, 'node_modules', name);
  await mkdir(dirname(target), { recursive: true });
  let stat;
  try { stat = await lstat(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (stat) {
    if (!stat.isSymbolicLink() || await realpath(target) !== source) throw new Error(`Dependency mismatch: ${name}`);
  } else await symlink(source, target, 'dir');
}
console.log('Web portal host dependencies linked. Install client dependencies separately with npm --prefix client ci.');
