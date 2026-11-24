/**
 * 「Agent 路由热刷新器」测试套件。
 * - node --test tests/   （node:test 运行）
 * - node tests/run-tests.mjs （进程内运行器，本环境验证用）
 * 覆盖 9 个必需场景 + 1 个事件接线场景。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'

import { AgentRouteHotRefresher, CATALOG_CHANGED_EVENT } from '../lib/hot-refresher.js'
import {
  FixtureRegistry, FixtureSession, policyDefinition,
  toolPolicy, assertAllowedModelSelection, makeCtx, settingsService, llmService,
} from './helpers.mjs'

const A = { provider: 'bd', model: 'model-A' }
const B = { provider: 'bd', model: 'model-B' }
const C = { provider: 'bd', model: 'model-C' }

function setup({ enabled = true, allowedModels = [A, B], models = { bd: ['model-A', 'model-B', 'model-C'] }, providerTimeoutMs = 2000, debounceMs = 0, llmOverrides = {}, withCache = true, sessionOptions = {} } = {}) {
  const registry = new FixtureRegistry()
  registry.register(policyDefinition)
  const session = new FixtureSession({ id: 'session-1', registry, ...sessionOptions })
  const events = []
  const llm = llmService({ providers: ['bd'], models, ...llmOverrides })
  const cache = { write: async () => { events.push('cache-write') } }
  const ctx = makeCtx({
    settings: settingsService({ enabled, allowedModels }),
    sessions: { list: () => [session] },
    llm,
    registry,
    cache: withCache ? cache : undefined,
  })
  ctx.on(CATALOG_CHANGED_EVENT, payload => events.push(payload))
  const stateFile = join(tmpdir(), 'arhr-test-' + Math.random().toString(36).slice(2) + '.json')
  const instance = new AgentRouteHotRefresher(ctx, { providerTimeoutMs, debounceMs, stateFile })
  return { ctx, registry, session, llm, events, instance, stateFile, cache }
}

function cleanup(t) {
  rmSync(t.stateFile, { force: true })
  rmSync(t.stateFile + '.tmp', { force: true })
}

export async function T1() {
  const t = setup()
  try {
    assert.equal(t.instance.state.catalogVersion, 0)
    const r1 = await t.instance.refresh('settings-save')
    assert.equal(r1.ok, true)
    assert.deepEqual(toolPolicy(t.registry, t.session), [A, B])
    t.ctx.get('settings').describe = () => [{ ns: 'subagent-model-selection-settings', value: { enabled: true, allowedModels: [A, B, C] } }]
    const r2 = await t.instance.refresh('settings-save')
    assert.equal(r2.ok, true)
    const policy = toolPolicy(t.registry, t.session)
    assert.deepEqual(policy, [A, B, C])
    assert.ok(t.instance.state.catalogVersion >= 2)
    const last = t.events[t.events.length - 1]
    assert.equal(last.stale, false)
    assert.equal(last.catalogVersion, t.instance.state.catalogVersion)
    assert.deepEqual(last.routes, [A, B, C])
  } finally { cleanup(t) }
}

export async function T2() {
  const t = setup({ allowedModels: [A] })
  try {
    await t.instance.refresh('settings-save')
    t.ctx.get('settings').describe = () => [{ ns: 'subagent-model-selection-settings', value: { enabled: true, allowedModels: [A, B] } }]
    await t.instance.refresh('settings-save')
    const policy = toolPolicy(t.registry, t.session)
    assert.ok(policy !== undefined)
    assert.equal(assertAllowedModelSelection(policy, { provider: 'bd', model: 'model-A' }, B), true)
    const policyEvents = t.session.events.filter(e => e.type === 'subagent/model-selection-policy')
    assert.equal(policyEvents.length, 2)
    assert.deepEqual(policyEvents[1].data.allowedModels, [A, B])
  } finally { cleanup(t) }
}

export async function T3() {
  const t = setup({ allowedModels: [A, B] })
  try {
    await t.instance.refresh('settings-save')
    t.ctx.get('settings').describe = () => [{ ns: 'subagent-model-selection-settings', value: { enabled: true, allowedModels: [A] } }]
    const r = await t.instance.refresh('settings-save')
    assert.equal(r.ok, true)
    const policy = toolPolicy(t.registry, t.session)
    assert.deepEqual(policy, [A])
    assert.throws(() => assertAllowedModelSelection(policy, { provider: 'bd', model: 'model-A' }, B), /not allowed/)
    assert.ok(t.registry.registrations.get('subagentModelSelectionPolicy').cells.has(t.session))
  } finally { cleanup(t) }
}

export async function T4() {
  const calls = []
  const t = setup({ llmOverrides: { delayMs: 120, calls } })
  try {
    const r = [1, 2, 3, 4, 5].map(() => t.instance.refresh('concurrent'))
    const results = await Promise.all(r)
    for (const res of results) assert.equal(res.ok, true)
    assert.equal(calls.length, 1, 'provider listModels 只应被调用一次')
  } finally { cleanup(t) }
}

export async function T5() {
  const t = setup({ allowedModels: [A], llmOverrides: { delayMs: 250 } })
  try {
    await t.instance.refresh('settings-save')
    t.ctx.get('settings').describe = () => [{ ns: 'subagent-model-selection-settings', value: { enabled: true, allowedModels: [A, B] } }]
    const inflight = t.instance.refresh('settings-save')
    assert.deepEqual(toolPolicy(t.registry, t.session), [A])
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.deepEqual(toolPolicy(t.registry, t.session), [A])
    assert.equal(t.session.events.filter(e => e.type === 'subagent/model-selection-policy').length, 1)
    await inflight
    assert.deepEqual(toolPolicy(t.registry, t.session), [A, B])
  } finally { cleanup(t) }
}

export async function T6() {
  const t = setup({ allowedModels: [A, B], providerTimeoutMs: 60 })
  try {
    await t.instance.refresh('settings-save')
    assert.deepEqual(toolPolicy(t.registry, t.session), [A, B])
    const before = t.instance.state.catalogVersion
    // provider 查询挂起，超过超时窗口
    t.llm.listModels = () => new Promise(() => {})
    const r = await t.instance.refresh('settings-save')
    assert.equal(r.ok, false)
    assert.equal(r.stale, true)
    assert.deepEqual(toolPolicy(t.registry, t.session), [A, B])
    assert.equal(t.instance.state.catalogVersion, before)
    assert.equal(t.instance.state.stale, true)
    const last = t.events[t.events.length - 1]
    assert.equal(last.stale, true)
  } finally { cleanup(t) }
}

export async function T7() {
  const t = setup({ allowedModels: [A] })
  try {
    await t.instance.refresh('settings-save')
    const policy = toolPolicy(t.registry, t.session)
    assert.deepEqual(policy, [A])
    for (const forged of [
      { provider: 'bd', model: 'model-B' },
      { provider: 'evil', model: 'model-A' },
      { provider: 'bd/../../x', model: 'model-A' },
      { provider: 'bd', model: '' },
    ]) {
      assert.throws(() => assertAllowedModelSelection(policy, { provider: 'bd', model: 'model-A' }, forged), /not allowed/)
    }
    const bad = settingsService({ enabled: true, allowedModels: [{ provider: 'bd', model: '' }] })
    const ctx2 = makeCtx({ settings: bad, sessions: { list: () => [t.session] }, llm: t.llm, registry: t.registry })
    const i2 = new AgentRouteHotRefresher(ctx2, { providerTimeoutMs: 100, debounceMs: 0, stateFile: t.stateFile + '.x' })
    const r = await i2.refresh('settings-save')
    assert.equal(r.ok, false)
    assert.deepEqual(toolPolicy(t.registry, t.session), [A], '非法设置不得改变现有路由')
    rmSync(t.stateFile + '.x', { force: true })
    rmSync(t.stateFile + '.x.tmp', { force: true })
  } finally { cleanup(t) }
}

export async function T8() {
  const t = setup({ allowedModels: [A, B] })
  try {
    await t.instance.refresh('settings-save')
    t.ctx.get('settings').describe = () => [{ ns: 'subagent-model-selection-settings', value: { enabled: true, allowedModels: [A, B, C] } }]
    await t.instance.refresh('settings-save')
    const fresh = new FixtureSession({ id: 'session-2', registry: t.registry })
    fresh.append('subagent/model-selection-policy', { allowedModels: [A, B, C] })
    assert.deepEqual(toolPolicy(t.registry, fresh), [A, B, C])
    const child = new FixtureSession({ id: 'session-3', origin: 'subagent', registry: t.registry })
    child.append('subagent/model-selection-policy', { allowedModels: [A] })
    assert.deepEqual(toolPolicy(t.registry, child), [A])
  } finally { cleanup(t) }
}

export async function T9() {
  const t = setup({ allowedModels: [A, B] })
  try {
    await t.instance.refresh('settings-save')
    assert.deepEqual(toolPolicy(t.registry, t.session), [A, B])
    t.llm.listModels = async () => { throw new Error('network down') }
    const r = await t.instance.refresh('settings-save')
    assert.equal(r.ok, false)
    assert.deepEqual(toolPolicy(t.registry, t.session), [A, B], '失败后必须保留原路由')
    assert.equal(t.instance.state.stale, true)
    assert.equal(t.session.events.filter(e => e.type === 'subagent/model-selection-policy').length, 1)
  } finally { cleanup(t) }
}

export async function T10() {
  const t = setup({ allowedModels: [A], debounceMs: 0 })
  try {
    await new Promise(resolve => setTimeout(resolve, 20))
    t.ctx.get('settings').describe = () => [{ ns: 'subagent-model-selection-settings', value: { enabled: true, allowedModels: [A, B] } }]
    t.ctx.emit('settings/document-updated', 'subagent-model-selection-settings', 3)
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.deepEqual(toolPolicy(t.registry, t.session), [A, B])
  } finally { cleanup(t) }
}

const scenarios = { T1, T2, T3, T4, T5, T6, T7, T8, T9, T10 }
for (const [name, fn] of Object.entries(scenarios)) {
  test('运行场景 ' + name, fn)
}
