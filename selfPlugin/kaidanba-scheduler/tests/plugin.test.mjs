import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import React from 'react'
import { renderToString } from 'react-dom/server'

const require = createRequire(import.meta.url)
const root = new URL('../', import.meta.url)

test('package exposes a loadable host and a matching Harness client module', async () => {
  const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
  const host = await import(new URL(manifest.exports['.'], root))
  assert.equal(host.name, manifest.name)
  assert.equal(typeof host.apply, 'function')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings'))
  const patch = await readFile(new URL(manifest.dsh.bundle.patch, root), 'utf8')
  assert.match(patch, /name: kaidanba-scheduler/)
  let loaded
  const styles = []
  const sandbox = {
    window: { __ModuleLoader__: { load: entry => { loaded = entry } } },
    console, setTimeout, clearTimeout,
  }
  runInNewContext(await readFile(new URL(manifest.exports['./client'], root), 'utf8'), sandbox)
  assert.equal(loaded.id, manifest.name)
  const requested = []
  const plugin = loaded.factory(name => {
    requested.push(name)
    assert.ok(['react', 'react-dom'].includes(name), `unregistered shared module: ${name}`)
    return require(name)
  })
  sandbox.document = {
    createElement: () => ({ dataset: {}, remove() { styles.splice(styles.indexOf(this), 1) } }),
    head: { append: style => styles.push(style) },
  }
  const cleanup = []
  let section
  let component
  plugin.apply({
    effect: callback => cleanup.push(callback()),
    slots: {
      inject: (name, callback) => { assert.equal(name, 'settings.section'); callback() },
      register: (options, render) => { section = options; component = render },
    },
  })
  assert.ok(requested.includes('react'))
  assert.equal(section.id, manifest.name)
  assert.equal(section.order, 22)
  assert.equal(section.label(), '定时商品推送')
  assert.equal(styles.length, 1)
  assert.match(styles[0].textContent, /scheduler-embedded/)
  const html = renderToString(React.createElement(component, section.inject()))
  assert.match(html, /scheduler-embedded/)
  assert.match(html, /新建推送任务/)
  assert.doesNotMatch(html, /模拟执行|保存草稿/)
  assert.doesNotMatch(html, /brand-bar|breadcrumb|<iframe/)
  for (const dispose of cleanup) dispose?.()
  assert.equal(styles.length, 0)
})
