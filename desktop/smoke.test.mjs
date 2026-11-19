import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

const source = new URL('./plugin.js', import.meta.url)
const task = (id, status = 'pending', content = id, parent) => ({ id, status, content, parent })
const stages = n => ['a', 'b', 'c', 'd', 'e'].map((id, i) => task(id, i < n ? 'completed' : i === n ? 'in_progress' : 'pending'))
const createAtom = value => ({ get: () => value, set: next => { value = next } })
const component = (type, props) => typeof type === 'function' ? type(props) : { type, props }
const walk = node => Array.isArray(node) ? node.flatMap(walk) : node?.props ? [node, ...walk(node.props.children)] : []
const text = node => typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join('') : node?.props ? text(node.props.children) : ''

async function boot(lang = 'en') {
  assert.ok(existsSync(source), 'the Session Progress plugin must be installed')
  const entries = [], events = new Map(), ticks = [], notices = []
  let now = 0, labels
  const ctx = vm.createContext({ Date: { now: () => now } })
  const state = Object.fromEntries(Object.entries({ focusedSessionId: 'run-a', focusedSessionOwner: { connectionId: 'local', profile: 'default' }, connectionId: 'local', profile: 'default', gateway: 'open' }).map(([key, value]) => [key, createAtom(value)]))
  const translate = (key, ...args) => typeof labels[key] === 'function' ? labels[key](...args) : labels[key]
  const sdk = { atom: createAtom, host: { state, notify: notice => notices.push(notice) }, usePluginI18n: () => translate, useValue: value => value.get(), STATUSBAR_AREAS: { right: 'statusBar.right' }, PALETTE_AREA: 'palette' }
  const dependencies = { '@hermes/plugin-sdk': sdk, 'react/jsx-runtime': { jsx: component, jsxs: component } }
  const entry = new vm.SourceTextModule(readFileSync(source, 'utf8'), { context: ctx })
  entry.linkRequests(entry.moduleRequests.map(({ specifier }) => {
    const exports = dependencies[specifier]
    return new vm.SyntheticModule(Object.keys(exports), function () { for (const k of Object.keys(exports)) this.setExport(k, exports[k]) }, { context: ctx })
  }))
  entry.instantiate()
  await entry.evaluate()
  entry.namespace.default.register({ register: row => entries.push(row), onEvent: (type, fn) => events.set(type, fn), setInterval: fn => ticks.push(fn), i18n: { register: all => { labels = all[lang] }, t: translate } })
  const render = () => entries.find(row => row.area === 'statusBar.right').render()
  const emit = (type, payload, extra) => (events.get(type) ?? events.get('*'))?.({ session_id: 'run-a', type, payload, ...extra })
  return { state, emit, render, show: () => text(render()), bar: () => walk(render()).find(x => x.type === 'progress'),
    advance: ms => { now += ms; ticks.forEach(tick => tick()) },
    todos: (todos, extra) => emit('todo.updated', { todos }, extra),
    report: () => { entries.find(row => row.area === 'palette').data.run(); return notices.at(-1)?.message } }
}

test('horizontal bar counts completed checklist stages, computes observed rate and ETA', async () => {
  const p = await boot('ru')
  assert.equal(p.render(), null)
  p.todos(stages(0))
  assert.equal(p.bar().props.max, 5)
  assert.equal(p.bar().props.value, 0)
  assert.match(p.show(), /Собираю данные/)
  p.advance(30000)
  p.todos(stages(2))
  assert.equal(p.bar().props.value, 2)
  assert.match(p.show(), /2\/5 этапов/)
  assert.match(p.show(), /4 этапов\/мин/)
  assert.match(p.show(), /ETA ≈ 45 с/)
  assert.match(p.report(), /ETA ≈ 45 с/)
})

test('an explicit numeric counter overrides stages; changing the total resets ETA', async () => {
  const p = await boot('ru')
  const update = (n, total) => p.todos([...stages(0), task('progress:files', 'in_progress', `${n}/${total} файлов`)])
  update(120, 500)
  p.advance(30000)
  update(180, 500)
  assert.equal(p.bar().props.value, 180)
  assert.match(p.show(), /180\/500 файлов · 120 файлов\/мин · ETA ≈ 3 мин/)
  update(180, 600)
  assert.match(p.show(), /180\/600 файлов · Собираю данные/)
  p.todos([task('progress:files', 'in_progress', '900/600 файлов')])
  assert.equal(p.render(), null)
})

test('large counts preserve exact unfinished totals', async () => {
  const p = await boot()
  p.todos([task('progress:files', 'pending', '4999/5000 files')])
  assert.equal(p.bar().props.value, 4999)
  assert.match(p.show(), /4,999\/5,000 files/)
  assert.doesNotMatch(p.show(), /Complete/)
})

test('an older checklist revision cannot roll back a newer snapshot', async () => {
  const p = await boot()
  p.emit('todo.updated', { todos: stages(2), revision: 2 })
  p.emit('todo.updated', { todos: stages(1), revision: 1 })
  assert.equal(p.bar().props.value, 2)
  p.emit('todo.updated', { todos: [], revision: 3 })
  p.emit('tool.complete', { name: 'todo_list', todos: stages(2), revision: 2 })
  assert.equal(p.render(), null)
})

test('native numeric tool progress stays separate from the session checklist', async () => {
  const p = await boot()
  p.todos(stages(1))
  p.emit('tool.progress', { tool_id: 'one', progress: 10, total: 100 })
  p.advance(20000)
  p.emit('tool.progress', { tool_id: 'other', progress: 90, total: 100 })
  p.emit('tool.progress', { tool_id: 'one', progress: 30, total: 100 })
  assert.equal(p.bar().props.value, 30)
  assert.match(p.show(), /Tool: 30\/100 units · 60 units\/min/)
  p.emit('tool.complete', { tool_id: 'other' })
  assert.equal(p.bar().props.value, 30)
  p.emit('tool.complete', { tool_id: 'one' })
  p.emit('tool.progress', { tool_id: 'no-total', progress: 12 })
  assert.equal(p.bar().props.value, 1)
})

test('progress is isolated by connection, profile and runtime id; replay adds no sample', async () => {
  const p = await boot()
  p.todos(stages(1), { connectionId: 'local', profile: 'default' })
  p.todos(stages(2), { connectionId: 'other', profile: 'default' })
  p.todos(stages(3), { connectionId: 'local', profile: 'other' })
  p.todos(stages(4), { session_id: 'run-b', connectionId: 'local', profile: 'default' })
  p.todos(stages(5), { replayed: true })
  assert.equal(p.bar().props.value, 1)
  p.state.focusedSessionOwner.set({ connectionId: 'other', profile: 'default' })
  assert.equal(p.bar().props.value, 2)
  p.state.focusedSessionOwner.set(null)
  assert.equal(p.render(), null)
  p.state.focusedSessionOwner.set({ connectionId: 'local', profile: 'default' })
  p.state.focusedSessionId.set('run-b')
  assert.equal(p.bar().props.value, 4)
})

test('a nested plan counts leaf stages once and excludes cancellations', async () => {
  const p = await boot()
  const plan = [task('parent'), task('child', 'pending', 'Work', 'parent'), task('skip', 'cancelled')]
  p.todos(plan)
  assert.equal(p.bar().props.max, 1)
  p.advance(20000)
  p.todos(plan)
  assert.match(p.show(), /Measuring pace/)
  p.todos([])
  p.todos([])
  assert.equal(p.render(), null)
})

test('overdue, disconnected and finished turns do not promise an ETA', async () => {
  const p = await boot()
  p.todos(stages(0))
  p.advance(20000)
  p.todos(stages(4))
  assert.match(p.show(), /ETA ≈ 5 s/)
  p.state.gateway.set('connecting')
  assert.match(p.show(), /Not running/)
  p.state.gateway.set('open')
  p.advance(10000)
  assert.match(p.show(), /ETA unavailable/)
  p.emit('message.complete')
  assert.match(p.show(), /Not running/)
  p.emit('message.start')
  assert.equal(p.render(), null)
})
