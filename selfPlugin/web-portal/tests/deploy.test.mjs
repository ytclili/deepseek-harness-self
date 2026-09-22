import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, lstat, rm, symlink, readlink, chmod, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { createBuildContext } from '../deploy/create-build-context.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'portal-deploy-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source')
  const files = {
    'package.json': '{}', 'apps/cli/package.json': '{"version":"0.1.7-alpha.1"}', 'apps/cli/lib/bin.js': '', 'apps/web/dist/index.html': '',
    'node_modules/tsx/package.json': '{}', 'node_modules/pkg/lib/index.js': 'linux-build', 'packages/core/runtime/lib/index.js': 'runtime-code',
    'selfPlugin/web-portal/dist/index.js': '', 'selfPlugin/web-portal/client/dist/index.html': '', 'selfPlugin/enterprise-auth/dist/http.js': '', 'selfPlugin/enterprise-tools/dist/index.js': '',
    'selfPlugin/web-portal/deploy/user.Dockerfile': 'COPY payload/ /app/', 'selfPlugin/web-portal/deploy/user.Dockerfile.dockerignore': '*\n!payload/**\n',
    '.env': 'canary', '.git/config': 'canary', 'apps/web/.env.production': 'canary', 'selfPlugin/web-portal/runtime/key': 'canary',
    'selfPlugin/web-portal/backups/key': 'canary', 'selfPlugin/other/dist/index.js': 'canary', 'selfPlugin/web-portal/.credentials.yaml': 'canary',
  }
  for (const [path, content] of Object.entries(files)) { await mkdir(join(source, path, '..'), { recursive: true }); await writeFile(join(source, path), content) }
  return { root, source, files }
}

test('build context admits Linux runtime artifacts and three plugins, excludes private state and source tests', async t => {
  const { root, source, files } = await fixture(t)
  const target = join(root, 'context')
  await createBuildContext(source, target)
  for (const path of Object.keys(files).slice(0, 13)) assert((await lstat(join(target, 'payload', path))).isFile(), path)
  for (const path of Object.keys(files).slice(13)) await assert.rejects(lstat(join(target, 'payload', path)), { code: 'ENOENT' })
  assert.equal(await readFile(join(target, 'payload/node_modules/pkg/lib/index.js'), 'utf8'), 'linux-build')
  await assert.rejects(createBuildContext(source, target), /EEXIST|exists/)
})

test('context rejects unrelated external symlinks and unsupported Harness versions', async t => {
  const { root, source } = await fixture(t)
  await symlink('/etc/passwd', join(source, 'node_modules/unsafe'))
  await assert.rejects(createBuildContext(source, join(root, 'bad-link')), /symlink/)
  await rm(join(source, 'node_modules/unsafe'))
  await writeFile(join(source, 'apps/cli/package.json'), '{"version":"0.1.6-alpha.1"}')
  await assert.rejects(createBuildContext(source, join(root, 'bad-version')), /0\.1\.7/)
})

test('missing compiled CLI is rejected before an image context is created', async t => {
  const { root, source } = await fixture(t)
  await rm(join(source, 'apps/cli/lib/bin.js'))
  const target = join(root, 'missing-cli')
  await assert.rejects(createBuildContext(source, target), { code: 'ENOENT' })
  await assert.rejects(lstat(target), { code: 'ENOENT' })
})

test('deployment shell scripts parse as POSIX sh and separate gateway data/socket from user image', async () => {
  for (const script of ['prepare-runtime.sh', 'build-images.sh', 'install-network-policy.sh', 'verify-network-policy.sh', 'portal-service.sh', 'istoreos.init']) execFileSync('sh', ['-n', new URL(`../deploy/${script}`, import.meta.url).pathname])
  const dockerfile = await readFile(new URL('../deploy/user.Dockerfile', import.meta.url), 'utf8')
  assert.match(dockerfile, /COPY payload\/ \/app\//)
  assert.doesNotMatch(dockerfile, /COPY \. /)
  const config = JSON.parse(await readFile(new URL('../examples/gateway.json', import.meta.url), 'utf8'))
  assert.equal(config.docker.hostDataRoot, '/mnt/sata4-2/www/code/deepseek-harness-runtime/portal')
  assert.equal(config.networkPolicyFile, '/run/dsh-portal/network-policy.json')
  assert.equal(new URL(config.model.runtimeBaseUrl).port, '23080')
})

test('workspace links are relocated to /app, desktop links retained, build-only pnpm roots omitted', async t => {
  const { root, source } = await fixture(t)
  await mkdir(join(source, 'apps/desktop'), { recursive: true })
  await writeFile(join(source, 'apps/desktop/package.json'), '{}')
  await symlink(join(source, 'apps/desktop'), join(source, 'node_modules/desktop'))
  await symlink('/mnt/harness/packages/core/runtime', join(source, 'node_modules/alias'))
  await symlink(join(source, 'packages/preset/removed-package'), join(source, 'node_modules/removed-package'))
  for (const name of ['benchmarks', 'website']) {
    await mkdir(join(source, name))
    await writeFile(join(source, name, 'package.json'), '{}')
    await symlink(join(source, name), join(source, 'node_modules', name))
  }
  const target = join(root, 'links')
  await createBuildContext(source, target, { hostSource: '/mnt/harness' })
  assert.equal(await readlink(join(target, 'payload/node_modules/desktop')), '/app/apps/desktop')
  assert.equal(await readlink(join(target, 'payload/node_modules/alias')), '/app/packages/core/runtime')
  for (const name of ['benchmarks', 'website']) await assert.rejects(lstat(join(target, 'payload/node_modules', name)), { code: 'ENOENT' })
  await assert.rejects(lstat(join(target, 'payload/node_modules/removed-package')), { code: 'ENOENT' })
})

test('preparation context preserves test/build sources and works before portal artifacts exist', async t => {
  const { root, source } = await fixture(t)
  await rm(join(source, 'selfPlugin/web-portal/dist'), { recursive: true })
  await mkdir(join(source, 'scripts'), { recursive: true })
  await writeFile(join(source, 'scripts/build.ts'), 'build source')
  await mkdir(join(source, 'selfPlugin/web-portal/tests'), { recursive: true })
  await writeFile(join(source, 'selfPlugin/web-portal/tests/sample.test.mjs'), 'test source')
  const target = join(root, 'prepare')
  await createBuildContext(source, target, { prepare: true })
  assert.equal(await readFile(join(target, 'payload/scripts/build.ts'), 'utf8'), 'build source')
  assert.equal(await readFile(join(target, 'payload/selfPlugin/web-portal/tests/sample.test.mjs'), 'utf8'), 'test source')
})

test('initialization backs up private configuration without overwriting it or starting Docker', async t => {
  const root = await mkdtemp(join(tmpdir(), 'portal-install-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bin = join(root, 'bin')
  const runtime = join(root, 'portal')
  await mkdir(bin)
  await mkdir(join(runtime, 'gateway'), { recursive: true })
  for (const [name, content] of Object.entries({ uname: 'echo Linux', id: 'echo 0', docker: 'echo "Docker must not run during init" >&2; exit 98' })) {
    await writeFile(join(bin, name), `#!/bin/sh\n${content}\n`)
    await chmod(join(bin, name), 0o700)
  }
  await writeFile(join(runtime, 'gateway/config.json'), '{"private":"preserve"}')
  await writeFile(join(runtime, 'gateway/model.key'), 'fake-model-secret')
  const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, PORTAL_RUNTIME_ROOT: runtime }
  const script = new URL('../deploy/portal-service.sh', import.meta.url).pathname
  for (let i = 0; i < 2; i++) {
    const output = execFileSync('sh', [script, 'init'], { env, encoding: 'utf8' })
    assert(!output.includes('fake-model-secret'))
  }
  assert.equal(await readFile(join(runtime, 'gateway/config.json'), 'utf8'), '{"private":"preserve"}')
  assert.equal(await readFile(join(runtime, 'gateway/model.key'), 'utf8'), 'fake-model-secret')
  const backups = await readdir(join(runtime, 'backups'))
  assert.equal(backups.length, 2)
  for (const backup of backups) assert.equal(await readFile(join(runtime, 'backups', backup, 'model.key'), 'utf8'), 'fake-model-secret')
})
