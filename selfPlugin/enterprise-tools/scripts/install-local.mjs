import { readFile, writeFile, mkdir, rename, access, lstat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { DEFAULT_SCHEMA, Type, load, dump } from 'js-yaml'

const root = fileURLToPath(new URL('..', import.meta.url))
const dshHome = resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh'))
const profile = process.argv[2] ?? 'web'
if (!/^[a-zA-Z0-9_-]+$/.test(profile)) throw new Error('无效 profile 名称。')
const profileDir = join(dshHome, 'profiles', profile)
const patchFile = join(profileDir, 'cordis.patch.yml')
const entry = join(root, 'dist/index.js')
const tokenFile = resolve(process.env.ENTERPRISE_TOKEN_FILE ?? join(dshHome, 'secrets', 'enterprise-tools.token'))
await access(entry)
await access(tokenFile)
await access(join(profileDir, 'package.json'))
if (!(await lstat(patchFile)).isFile()) throw new Error('profile patch 必须是普通文件。')
const original = await readFile(patchFile, 'utf8')
class Expression {
  constructor(value) { this.value = value }
}
const schema = DEFAULT_SCHEMA.extend([new Type('tag:yaml.org,2002:js', {
  kind: 'scalar', construct: value => new Expression(value), instanceOf: Expression, represent: expression => expression.value,
})])
function parse(text) {
  try {
    const rows = load(text, { schema })
    if (!Array.isArray(rows)) throw new Error('expected array')
    return rows
  } catch {
    throw new Error('profile patch 不是有效 YAML 数组，未修改。')
  }
}
const document = parse(original)
const startMarker = '# BEGIN enterprise-tools managed block'
const endMarker = '# END enterprise-tools managed block'
const start = original.indexOf(startMarker)
const end = original.indexOf(endMarker)
let base = original
if (start !== -1 || end !== -1) {
  if (start === -1 || end < start || original.indexOf(startMarker, start + 1) !== -1 || original.indexOf(endMarker, end + 1) !== -1) throw new Error('企业工具配置标记异常，未修改。')
} else if (document.some(row => row?.id === 'enterprise-tools' || row?.insert?.some(item => item?.id === 'enterprise-tools'))) {
  throw new Error('已存在非本脚本管理的 enterprise-tools，请先人工检查配置。')
}
if (document.length === 0) {
  base = base.replace(/^[ \t]*\[\][ \t]*(#.*)?$/m, '$1')
} else if (start === -1) {
  const flowStart = base.search(/^[ \t]*\[/m)
  if (flowStart !== -1) base = base.slice(0, flowStart) + dump(document, { schema, noRefs: true, lineWidth: -1 })
}
const block = [startMarker, '- insert:', '    - id: enterprise-tools', `      name: ${JSON.stringify(entry)}`, '      config:', '        baseUrl: http://127.0.0.1:5002', `        tokenFile: ${JSON.stringify(tokenFile)}`, '        timeoutMs: 10000', '        maxResponseBytes: 1048576', '        maxItems: 100', endMarker, ''].join('\n')
const next = start === -1
  ? `${base.trimEnd()}\n${block}`
  : original.slice(0, start) + block.trimEnd() + original.slice(end + endMarker.length)
parse(next)
if (next === original) {
  console.log('企业工具配置已存在，无需修改。')
} else {
  const backupDirectory = join(dshHome, 'backups', 'enterprise-tools')
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 })
  const backup = join(backupDirectory, `${Date.now()}-${randomUUID()}.yml`)
  await writeFile(backup, original, { flag: 'wx', mode: 0o600 })
  const temporary = `${patchFile}.${randomUUID()}.tmp`
  await writeFile(temporary, next, { flag: 'wx', mode: 0o600 })
  await rename(temporary, patchFile)
  console.log(`企业工具已接入 ${profile} profile；原配置已备份。`)
}
