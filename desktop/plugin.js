import { atom, host, PALETTE_AREA, STATUSBAR_AREAS, usePluginI18n, useValue } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'session-progress'
const MIN_SAMPLE_MS = 10_000
const MAX_SESSIONS = 96
const LOCALES = {
  en: {
    title: 'Session progress', show: 'Show session progress', empty: 'No measured progress in this session yet.',
    stages: 'stages', units: 'units', tool: count => `Tool: ${count}`, collecting: 'Measuring pace…', stale: 'ETA unavailable · no recent progress',
    idle: 'Not running', done: 'Complete', eta: time => `ETA ≈ ${time}`, rate: (value, unit) => `${value} ${unit}/min`,
    seconds: n => `${n} s`, minutes: n => `${n} min`, hours: n => `${n} h`, days: n => `${n} d`,
    number: (n, isRate = false) => new Intl.NumberFormat('en', isRate ? { maximumSignificantDigits: 3 } : { maximumFractionDigits: 3 }).format(n)
  },
  ru: {
    title: 'Прогресс сессии', show: 'Показать прогресс сессии', empty: 'В этой сессии пока нет данных о прогрессе.',
    stages: 'этапов', units: 'ед.', tool: count => `Инструмент: ${count}`, collecting: 'Собираю данные…', stale: 'ETA — нет свежих данных',
    idle: 'Не выполняется', done: 'Готово', eta: time => `ETA ≈ ${time}`, rate: (value, unit) => `${value} ${unit}/мин`,
    seconds: n => `${n} с`, minutes: n => `${n} мин`, hours: n => `${n} ч`, days: n => `${n} д`,
    number: (n, isRate = false) => new Intl.NumberFormat('ru', isRate ? { maximumSignificantDigits: 3 } : { maximumFractionDigits: 3 }).format(n)
  }
}

const STYLE = `
  .session-progress { display:flex; align-items:center; gap:6px; padding-inline:4px; min-inline-size:0; overflow:hidden; white-space:nowrap; font-variant-numeric:tabular-nums; color:var(--ui-text-secondary); }
  .session-progress > span { overflow:hidden; text-overflow:ellipsis; }
  .session-progress-bar { appearance:none; flex:none; inline-size:clamp(32px,5vw,88px); block-size:5px; border:0; border-radius:999px; overflow:hidden; background:var(--ui-bg-quaternary); accent-color:var(--rolter-accent-ink,var(--ui-accent)); }
  .session-progress-bar::-webkit-progress-bar { background:var(--ui-bg-quaternary); }
  .session-progress-bar::-webkit-progress-value { background:var(--rolter-accent-ink,var(--ui-accent)); border-radius:999px; }
  @media (forced-colors:active) { .session-progress-bar { appearance:auto; } }
`

const profile = value => typeof value === 'string' && value.trim() || 'default'
const keyOf = (id, owner) => id && owner?.connectionId ? JSON.stringify([owner.connectionId, profile(owner.profile), id]) : null
const focusedKey = () => keyOf(host.state.focusedSessionId.get(), host.state.focusedSessionOwner.get())
const eventKey = event => keyOf(event.session_id, {
  connectionId: event.connectionId || host.state.connectionId.get() || 'local',
  profile: event.profile ?? host.state.profile.get()
})

const COUNTER_ID = /^progress:[a-z0-9][a-z0-9-]{0,31}$/
const COUNTER_VALUE = /^(\d{1,12}(?:\.\d{1,3})?)\/(\d{1,12}(?:\.\d{1,3})?) ([\p{L}\p{M}][\p{L}\p{M}\d. -]{0,23})$/u
const validCount = (count, total) => Number.isFinite(count) && Number.isFinite(total) && count >= 0 && total > 0 && count <= total && total <= 1e12

function checklist(rows) {
  const active = new Map()
  for (const row of rows) {
    if (typeof row?.id !== 'string' || !['pending', 'in_progress', 'completed'].includes(row.status)) continue
    active.set(row.id, row)
  }
  const counters = [...active.values()].filter(row => COUNTER_ID.test(row.id))
  if (counters.length === 1) {
    const row = counters[0]
    const metric = typeof row.content === 'string' && COUNTER_VALUE.exec(row.content.trim())
    if (metric && validCount(Number(metric[1]), Number(metric[2]))) {
      return { source: 'counter', plan: row.id, unit: metric[3], count: Number(metric[1]), total: Number(metric[2]) }
    }
  }
  for (const { id } of counters) active.delete(id)
  const parents = new Set([...active.values()].filter(row => row.parent !== row.id).map(row => row.parent))
  const leaves = [...active.values()].filter(row => !parents.has(row.id))
  return leaves.length ? {
    source: 'stages', plan: JSON.stringify(leaves.map(row => row.id).sort()),
    count: leaves.filter(row => row.status === 'completed').length, total: leaves.length
  } : null
}

function updateSample(previous, next, now) {
  const reset = !previous || !previous.running || previous.plan !== next.plan || previous.source !== next.source || previous.total !== next.total || previous.unit !== next.unit || next.count < previous.count
  if (reset) return { ...next, running: true, from: next.count, startedAt: now, lastAt: now }
  if (next.count === previous.count) return previous
  return { ...previous, ...next, lastAt: now }
}

function duration(ms, t) {
  const s = Math.ceil(ms / 1000)
  if (s < 60) return t('seconds', s)
  const m = Math.ceil(s / 60)
  if (m < 60) return t('minutes', m)
  const h = Math.ceil(m / 60)
  return h < 24 ? t('hours', h) : t('days', Math.ceil(h / 24))
}

function describe(record, now, t, connected) {
  const unit = record.unit ?? t(record.source === 'tool' ? 'units' : 'stages')
  const count = `${t('number', record.count)}/${t('number', record.total)} ${unit}`
  const label = record.source === 'tool' ? t('tool', count) : count
  const elapsed = record.lastAt - record.startedAt
  const advanced = record.count - record.from
  const measured = advanced > 0 && elapsed >= MIN_SAMPLE_MS
  const rate = measured ? t('rate', t('number', advanced * 60_000 / elapsed, true), unit) : null
  if (record.count >= record.total) return { label, rate, status: t('done') }
  if (!record.running || !connected) return { label, rate: null, status: t('idle') }
  if (!measured) return { label, rate: null, status: t('collecting') }
  const perUnit = elapsed / advanced
  const lastAge = now - record.lastAt
  if (lastAge >= Math.min(600_000, Math.max(60_000, 3 * perUnit))) return { label, rate: null, status: t('stale') }
  const remaining = (record.total - record.count) * perUnit - lastAge
  return { label, rate, status: remaining > 0 ? t('eta', duration(remaining, t)) : t('stale') }
}

function message({ label, rate, status }) {
  return [label, rate, status].filter(Boolean).join(' · ')
}

const visible = session => session?.tasks?.source === 'counter' ? session.tasks : session?.tool ?? session?.tasks

function Progress({ records, clock }) {
  const t = usePluginI18n(ID)
  const key = keyOf(useValue(host.state.focusedSessionId), useValue(host.state.focusedSessionOwner))
  const record = visible(useValue(records).get(key))
  useValue(clock) // Repaint time-dependent text, including after switching sessions.
  const connected = useValue(host.state.gateway) === 'open'
  if (!record) return null
  const summary = describe(record, Date.now(), t, connected)
  const title = message(summary)
  return jsxs('div', { className: 'session-progress', title, children: [
    jsx('style', { children: STYLE }),
    jsx('progress', { className: 'session-progress-bar', 'aria-label': t('title'), 'aria-valuetext': title, value: record.count, max: record.total }),
    jsx('span', { 'aria-hidden': true, children: title })
  ] })
}

export default {
  id: ID,
  name: 'Session Progress',
  description: 'A horizontal session progress bar with measured pace and ETA.',
  register(ctx) {
    const records = atom(new Map())
    const clock = atom(Date.now())
    function save(key, value) {
      const next = new Map(records.get())
      next.delete(key)
      if (value) next.set(key, value)
      while (next.size > MAX_SESSIONS) next.delete(next.keys().next().value)
      records.set(next)
    }
    function receive(event) {
      if (event.replayed) return
      const key = eventKey(event)
      if (!key) return
      const current = records.get().get(key)
      const now = Date.now()
      const payload = event.payload
      let tasks = current?.tasks ?? null
      let tool = current?.tool ?? null
      let revision = current?.revision ?? -1
      if (event.type === 'message.start') {
        tasks = tool = null
        revision = -1
      } else if (event.type === 'message.complete' || event.type === 'error') {
        if (tasks?.running) tasks = { ...tasks, running: false }
        tool = null
      } else if (event.type === 'tool.progress') {
        const { tool_id: plan, progress: count, total } = payload ?? {}
        if (typeof plan !== 'string' || !plan || (tool && tool.plan !== plan) || !validCount(count, total)) return
        tool = updateSample(tool, { source: 'tool', plan, count, total }, now)
      } else {
        if (event.type === 'tool.complete' && tool?.plan === payload?.tool_id) tool = null
        if ((event.type === 'todo.updated' || ['todo', 'todo_list'].includes(payload?.name)) && Array.isArray(payload?.todos)) {
          const incoming = payload.revision
          if (!Number.isSafeInteger(incoming) || incoming > revision) {
            if (Number.isSafeInteger(incoming)) revision = incoming
            const snapshot = checklist(payload.todos)
            tasks = snapshot ? updateSample(tasks, snapshot, now) : null
          }
        }
      }
      if ((current?.tasks ?? null) === tasks && (current?.tool ?? null) === tool && (current?.revision ?? -1) === revision) return
      save(key, tasks || tool || revision >= 0 ? { tasks, tool, revision } : null)
      clock.set(now)
    }
    ctx.i18n.register(LOCALES)
    for (const type of ['todo.updated', 'tool.progress', 'tool.complete', 'message.start', 'message.complete', 'error']) ctx.onEvent(type, receive)
    ctx.setInterval(() => {
      const record = visible(records.get().get(focusedKey()))
      if (record?.running && record.count < record.total && record.count > record.from) clock.set(Date.now())
    }, 5000)
    ctx.register({ id: 'bar', area: STATUSBAR_AREAS.right, order: 100, render: () => jsx(Progress, { records, clock }) })
    ctx.register({ id: 'show', area: PALETTE_AREA, data: {
      id: `${ID}.show`, label: ctx.i18n.t('show'), keywords: ['progress', 'rate', 'eta', 'прогресс', 'темп'],
      run: () => {
        const t = ctx.i18n.t
        const record = visible(records.get().get(focusedKey()))
        host.notify({ kind: 'info', message: record ? message(describe(record, Date.now(), t, host.state.gateway.get() === 'open')) : t('empty') })
      }
    } })
  }
}
