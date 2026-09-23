import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { deniedNetworks, validateNetworkPolicy, validateFw4Policy } from '../deploy/verify-network-policy.mjs'

const match = (left, right) => ({ match: { op: '==', left, right } })
const bridge = match({ meta: { key: 'iifname' } }, 'dshp*')
const v6 = match({ meta: { key: 'nfproto' } }, 'ipv6')
function fixture() {
  return { nftables: [
    { metainfo: { version: '1.0.8' } }, { table: { family: 'inet', name: 'dsh_portal_guard' } },
    { set: { family: 'inet', table: 'dsh_portal_guard', name: 'private_v4', type: 'ipv4_addr', flags: ['interval'], elem: deniedNetworks.map(value => { const [addr, len] = value.split('/'); return { prefix: { addr, len: Number(len) } } }) } },
    ...['input', 'forward'].map(name => ({ chain: { family: 'inet', table: 'dsh_portal_guard', name, type: 'filter', hook: name, prio: -20, policy: 'accept' } })),
    ...[
      ['input', 'ipv6', [bridge, v6, { drop: null }]],
      ['input', 'reply', [bridge, match({ ct: { key: 'direction' } }, 'reply'), match({ ct: { key: 'state' } }, { set: ['established', 'related'] }), { accept: null }]],
      ['input', 'gateway', [bridge, match({ payload: { protocol: 'tcp', field: 'dport' } }, 23080), { accept: null }]],
      ['input', 'deny', [bridge, { drop: null }]],
      ['forward', 'ipv6', [bridge, v6, { drop: null }]],
      ['forward', 'private', [bridge, match({ payload: { protocol: 'ip', field: 'daddr' } }, '@private_v4'), { drop: null }]],
      ['forward', 'invalid', [bridge, match({ ct: { key: 'state' } }, 'invalid'), { drop: null }]],
      ['forward', 'public', [bridge, { accept: null }]],
    ].map(([chain, suffix, expr]) => ({ rule: { family: 'inet', table: 'dsh_portal_guard', chain, comment: `portal:${chain}:${suffix}`, expr } })),
  ] }
}

function fw4Fixture() {
  const data = fixture()
  for (const item of data.nftables) {
    if (item.chain) item.chain.table = 'fw4'
    if (item.rule) {
      item.rule.table = 'fw4'
      item.rule.comment = item.rule.comment.replace('portal:', 'portal:fw4:')
      if (item.rule.comment.endsWith(':private')) item.rule.expr[1].match.right = { set: deniedNetworks.map(value => { const [addr, len] = value.split('/'); return { prefix: { addr, len: Number(len) } } }) }
    }
  }
  return data
}

function useNft116MatchSyntax(data) {
  for (const item of data.nftables) {
    for (const expression of item.rule?.expr ?? []) {
      if (expression.match?.left?.ct?.key !== 'state') continue
      expression.match.op = 'in'
      if (expression.match.right?.set) expression.match.right = expression.match.right.set
    }
  }
}

test('policy renderer affects only dshp bridges and permits the gateway rather than administrator port', () => {
  const script = new URL('../deploy/install-network-policy.sh', import.meta.url).pathname
  const rules = execFileSync('sh', [script, '--render', '23080'], { encoding: 'utf8' })
  assert.match(rules, /iifname "dshp\*" tcp dport 23080 accept/)
  assert.match(rules, /ct direction reply ct state established,related accept/)
  assert.doesNotMatch(rules, /\b3080\b|flush ruleset|flush table inet fw4/)
  assert.equal((rules.match(/iifname "dshp\*"/g) ?? []).length, 8)
  for (const network of deniedNetworks) assert(rules.includes(network))
  for (const port of ['0', '03080', '65536', '23080;touch /tmp/canary']) assert.throws(() => execFileSync('sh', [script, '--render', port], { stdio: 'pipe' }))
})

test('live policy validator checks verdicts and order, not comments or a stale marker', () => {
  validateNetworkPolicy(fixture(), 23080)
  for (const mutate of [
    data => { data.nftables.find(item => item.rule?.comment === 'portal:forward:private').rule.expr.at(-1).accept = null },
    data => { data.nftables.find(item => item.rule?.comment === 'portal:input:gateway').rule.expr[1].match.right = 3080 },
    data => { data.nftables.find(item => item.rule?.comment === 'portal:input:deny').rule.expr.shift() },
    data => { data.nftables.find(item => item.set).set.elem.pop() },
    data => { data.nftables.push({ rule: { chain: 'input', expr: [{ accept: null }] } }) },
    data => { const rules = data.nftables.filter(item => item.rule); [rules[0].rule, rules[1].rule] = [rules[1].rule, rules[0].rule] },
  ]) {
    const data = fixture(); mutate(data)
    assert.throws(() => validateNetworkPolicy(data, 23080), /mismatch/)
  }
})

test('live validators accept nft 1.1.6 match arrays, interval merging, and conditional pre-rules', () => {
  const guard = fixture()
  useNft116MatchSyntax(guard)
  validateNetworkPolicy(guard, 23080)

  const fw4 = fw4Fixture()
  useNft116MatchSyntax(fw4)
  const privateSet = fw4.nftables.find(item => item.rule?.comment === 'portal:fw4:forward:private').rule.expr[1].match.right.set
  privateSet.splice(-2, 2, { prefix: { addr: '224.0.0.0', len: 3 } })
  for (const chain of ['input', 'forward']) {
    const first = fw4.nftables.findIndex(item => item.rule?.chain === chain)
    fw4.nftables.splice(first, 0, { rule: { family: 'inet', table: 'fw4', chain, comment: 'third-party conditional rule', expr: [match({ meta: { key: 'iifname' } }, 'utun'), { accept: null }] } })
  }
  validateFw4Policy(fw4, 23080)
})

test('fw4 includes retain deny rules before scoped accepts and the live reload must preserve this order', () => {
  const script = new URL('../deploy/install-network-policy.sh', import.meta.url).pathname
  const input = execFileSync('sh', [script, '--render-fw4-input', '23080'], { encoding: 'utf8' })
  const forward = execFileSync('sh', [script, '--render-fw4-forward', '23080'], { encoding: 'utf8' })
  assert.match(input, /iifname "dshp\*" tcp dport 23080 accept/)
  assert(forward.indexOf('portal:fw4:forward:private') < forward.indexOf('portal:fw4:forward:public'))
  for (const network of deniedNetworks) assert(forward.includes(network))
  const data = fw4Fixture()
  validateFw4Policy(data, 23080)
  data.nftables.unshift({ rule: { family: 'inet', table: 'fw4', chain: 'forward', expr: [{ accept: null }] } })
  assert.throws(() => validateFw4Policy(data, 23080), /mismatch/)
})
