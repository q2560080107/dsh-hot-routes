/**
 * Forge 动态 Host 半区 smoke 测试：
 * 1) 代码必须能作为 async 函数体求值（沙箱语义）；
 * 2) 求值返回合法 cordis 插件（name + apply）；
 * 3) 逻辑与 lib 变体一致：模拟沙箱 ctx（无 setTimeout/fs，用 ctx.timeout shim），
 *    验证刷新、原子替换、单飞、超时 stale、伪造路由拒绝。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  FixtureRegistry, FixtureSession, policyDefinition,
  toolPolicy, assertAllowedModelSelection, makeCtx, settingsService,
} from './helpers.mjs'

const forgeFile = join(dirname(fileURLToPath(import.meta.url)), '..', 'forge', 'forge-host-code.js')
const code = readFileSync(forgeFile, 'utf8')

export async function F1() {
  // 作为 async 函数体求值（模拟 evaluateHostCode 包装）
  const factory = new Function('ctxStub', 'return (async () => {' + code + '\n})()')
  const evaluated = await factory.call(null, null)
  assert.equal(typeof evaluated, 'object')
  assert.equal(evaluated.name, 'agent-route-hot-refresher')
  assert.equal(typeof evaluated.apply, 'function')
}

export async function F2() {
  // 完整刷新链路（沙箱 ctx：ctx.timeout 提供定时器；无 fs/process）
  const registry = new FixtureRegistry()
  registry.register(policyDefinition)
  const session = new FixtureSession({ id: 'session-1', registry })
  const llm = { listProviders: () => [{ id: 'bd', name: 'bd' }], listModels: async () => [{ id: 'model-A' }, { id: 'model-B' }] }
  const timers = new Set()
  const ctx = makeCtx({
    settings: settingsService({ enabled: true, allowedModels: [{ provider: 'bd', model: 'model-A' }] }),
    sessions: { list: () => [session] },
    llm,
    registry,
  })
  ctx.timeout = (cb, ms) => { const h = setTimeout(cb, ms); timers.add(h); return () => { clearTimeout(h); timers.delete(h) } }
  ctx.effect = (fn) => { fn(); return () => {} }
  let provided = null
  ctx.provide = (name, value) => { provided = { name, value }; ctx.set(name, value); return () => {} }

  const factory = new Function('return (async () => {' + code + '\n})()')
  const plugin = await factory.call(null)
  plugin.apply(ctx, { providerTimeoutMs: 1000, debounceMs: 0 })

  // 启动期刷新完成后：策略 = [A]
  await new Promise(r => setTimeout(r, 50))
  assert.deepEqual(toolPolicy(registry, session), [{ provider: 'bd', model: 'model-A' }])

  // 用户勾选 B → settings/document-updated → 刷新
  ctx.get('settings').describe = () => [{ ns: 'subagent-model-selection-settings', value: { enabled: true, allowedModels: [{ provider: 'bd', model: 'model-A' }, { provider: 'bd', model: 'model-B' }] } }]
  ctx.emit('settings/document-updated', 'subagent-model-selection-settings', 2)
  await new Promise(r => setTimeout(r, 80))
  const policy = toolPolicy(registry, session)
  assert.deepEqual(policy, [{ provider: 'bd', model: 'model-A' }, { provider: 'bd', model: 'model-B' }])
  assert.equal(assertAllowedModelSelection(policy, { provider: 'bd', model: 'model-A' }, { provider: 'bd', model: 'model-B' }), true)

  // 服务注入 + 快照（catalogVersion ≥ 2）
  assert.equal(provided.name, 'agentRouteHotRefresh')
  const snap = provided.value.snapshot()
  assert.ok(snap.catalogVersion >= 2)

  // 超时 → stale，保留旧路由
  ctx.get('llm').listModels = () => new Promise(() => {})
  ctx.get('settings').describe = () => [{ ns: 'subagent-model-selection-settings', value: { enabled: true, allowedModels: [{ provider: 'bd', model: 'model-A' }] } }]
  ctx.emit('settings/document-updated', 'subagent-model-selection-settings', 3)
  // 等待超过 providerTimeoutMs(1000ms)，超时路径完成后断言
  await new Promise(r => setTimeout(r, 1300))
  assert.deepEqual(toolPolicy(registry, session), [{ provider: 'bd', model: 'model-A' }, { provider: 'bd', model: 'model-B' }], '超时保留旧路由')
  assert.equal(provided.value.snapshot().stale, true)

  // 伪造路由拒绝
  const forged = [{ provider: 'bd', model: 'evil-model' }]
  assert.throws(() => assertAllowedModelSelection(policy, { provider: 'bd', model: 'model-A' }, forged[0]), /not allowed/)

  for (const h of timers) clearTimeout(h)
}

export async function F3() {
  // 单飞：并发刷新只查一次 provider
  const registry = new FixtureRegistry()
  registry.register(policyDefinition)
  const session = new FixtureSession({ id: 'session-1', registry })
  let calls = 0
  const llm = { listProviders: () => [{ id: 'bd', name: 'bd' }], listModels: async () => { calls += 1; await new Promise(r => setTimeout(r, 120)); return [{ id: 'model-A' }] } }
  const ctx = makeCtx({
    settings: settingsService({ enabled: true, allowedModels: [{ provider: 'bd', model: 'model-A' }] }),
    sessions: { list: () => [session] },
    llm,
    registry,
  })
  ctx.timeout = (cb, ms) => { const h = setTimeout(cb, ms); return () => clearTimeout(h) }
  ctx.effect = (fn) => { fn(); return () => {} }
  ctx.provide = (name, value) => { ctx.set(name, value); return () => {} }
  const factory = new Function('return (async () => {' + code + '\n})()')
  const plugin = await factory.call(null)
  plugin.apply(ctx, { providerTimeoutMs: 5000, debounceMs: 0 })
  await new Promise(r => setTimeout(r, 30))
  const svc = ctx.services.get('agentRouteHotRefresh')
  await Promise.all([svc.refresh('x'), svc.refresh('y'), svc.refresh('z')])
  assert.equal(calls, 1, '并发刷新只查询一次')
}
