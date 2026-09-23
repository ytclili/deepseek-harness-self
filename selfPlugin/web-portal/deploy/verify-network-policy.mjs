/** Validate the live nft JSON statements, including rule order, matches, and verdicts. */
import { readFile } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { fileURLToPath } from 'node:url'

export const deniedNetworks = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4']
const match = (left, right) => ({ match: { op: '==', left, right } })
const bridge = match({ meta: { key: 'iifname' } }, 'dshp*')
const ipv6 = match({ meta: { key: 'nfproto' } }, 'ipv6')

function expectedRules(port) {
  return [
    ['input', 'ipv6', [bridge, ipv6, { drop: null }]],
    ['input', 'reply', [bridge, match({ ct: { key: 'direction' } }, 'reply'), match({ ct: { key: 'state' } }, { set: ['established', 'related'] }), { accept: null }]],
    ['input', 'gateway', [bridge, match({ payload: { protocol: 'tcp', field: 'dport' } }, port), { accept: null }]],
    ['input', 'deny', [bridge, { drop: null }]],
    ['forward', 'ipv6', [bridge, ipv6, { drop: null }]],
    ['forward', 'private', [bridge, match({ payload: { protocol: 'ip', field: 'daddr' } }, '@private_v4'), { drop: null }]],
    ['forward', 'invalid', [bridge, match({ ct: { key: 'state' } }, 'invalid'), { drop: null }]],
    ['forward', 'public', [bridge, { accept: null }]],
  ]
}

function normalizeNetworks(values) {
  return values.flatMap(value => {
    const network = typeof value === 'string' ? value : `${value.prefix?.addr}/${value.prefix?.len}`
    return network === '224.0.0.0/3' ? ['224.0.0.0/4', '240.0.0.0/4'] : [network]
  }).sort()
}

function normalizeExpressions(expressions) {
  return expressions?.map(expression => {
    if (!expression.match) return expression
    const clause = { ...expression.match, op: expression.match.op === 'in' ? '==' : expression.match.op }
    if (Array.isArray(clause.right)) clause.right = { set: [...clause.right].sort() }
    if (clause.left?.payload?.field === 'daddr' && Array.isArray(clause.right?.set)) clause.right = { set: normalizeNetworks(clause.right.set) }
    return { match: clause }
  })
}

/** @param data Live fw4 table JSON after a reload. @param port Allowed gateway TCP port. */
export function validateFw4Policy(data, port) {
  const fail = () => { throw new Error('Live fw4 portal policy mismatch') }
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !Array.isArray(data.nftables)) fail()
  const expected = expectedRules(port)
  for (const chain of ['input', 'forward']) {
    const base = data.nftables.find(item => item.chain?.family === 'inet' && item.chain.table === 'fw4' && item.chain.name === chain)?.chain
    if (base?.type !== 'filter' || base.hook !== chain) fail()
    const rules = data.nftables.filter(item => item.rule?.chain === chain && item.rule.table === 'fw4' && item.rule.family === 'inet').map(item => item.rule)
    const required = expected.filter(row => row[0] === chain)
    const start = rules.findIndex(rule => rule.comment === `portal:fw4:${chain}:${required[0][1]}`)
    if (start < 0) fail()
    const unconditionalBypass = rules.slice(0, start).some(rule => {
      const expressions = rule.expr ?? []
      const hasMatch = expressions.some(expression => expression.match)
      const hasBypassVerdict = expressions.some(expression => Object.hasOwn(expression, 'accept') || expression.jump || expression.goto)
      return hasBypassVerdict && !hasMatch
    })
    if (unconditionalBypass) fail()
    const baseComment = chain === 'input' ? '!fw4: Handle inbound flows' : '!fw4: Handle forwarded flows'
    const baseIndex = rules.findIndex(rule => rule.comment === baseComment)
    if (baseIndex >= 0 && start + required.length > baseIndex) fail()
    for (let index = 0; index < required.length; index++) {
      const [, suffix, expressions] = required[index]
      const wanted = structuredClone(expressions)
      if (suffix === 'private') wanted[1].match.right = { set: [...deniedNetworks].sort() }
      const rule = rules[start + index]
      if (rule?.comment !== `portal:fw4:${chain}:${suffix}` || !isDeepStrictEqual(normalizeExpressions(rule.expr), wanted)) fail()
    }
  }
}

/** @param data Live `nft -j list table inet dsh_portal_guard` result. @param port Allowed gateway TCP port. */
export function validateNetworkPolicy(data, port) {
  const fail = () => { throw new Error('Live network policy mismatch') }
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !Array.isArray(data.nftables)) fail()
  const items = data.nftables.filter(item => !item.metainfo)
  const table = items.filter(item => item.table)
  if (table.length !== 1 || table[0].table.family !== 'inet' || table[0].table.name !== 'dsh_portal_guard') fail()
  const chains = items.filter(item => item.chain).map(item => item.chain)
  if (chains.length !== 2 || chains.some(chain => !['input', 'forward'].includes(chain.name) || chain.hook !== chain.name || chain.prio !== -20 || chain.type !== 'filter' || chain.policy !== 'accept')) fail()
  const sets = items.filter(item => item.set).map(item => item.set)
  if (sets.length !== 1 || sets[0].name !== 'private_v4' || sets[0].type !== 'ipv4_addr') fail()
  const networks = sets[0].elem && normalizeNetworks(sets[0].elem)
  if (!isDeepStrictEqual(networks, [...deniedNetworks].sort())) fail()
  const expected = expectedRules(port)
  const rules = items.filter(item => item.rule).map(item => item.rule)
  if (rules.length !== expected.length) fail()
  for (let i = 0; i < expected.length; i++) {
    const [chain, comment, expressions] = expected[i]
    const rule = rules[i]
    const normalized = normalizeExpressions(rule.expr)
    if (rule.family !== 'inet' || rule.table !== 'dsh_portal_guard' || rule.chain !== chain || rule.comment !== `portal:${chain}:${comment}` || !isDeepStrictEqual(normalized, expressions)) fail()
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { const validate = process.argv[4] === '--fw4' ? validateFw4Policy : validateNetworkPolicy; validate(JSON.parse(await readFile(process.argv[2], 'utf8')), Number(process.argv[3])); console.log('Live nft policy verified.') }
  catch { console.error('Live nft policy verification failed.'); process.exitCode = 1 }
}
