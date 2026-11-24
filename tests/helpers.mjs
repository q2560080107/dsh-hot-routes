/**
 * 测试夹具：镜像真实 SessionProjectionRegistry 的折叠语义
 * （first-wins apply、cells/registrations 为普通属性、append 同步驱动折叠）。
 * 若环境变量 DSH_PROJECTION_LIB 指向真实 @deepseek-ai/dsh-session-projection 的
 * lib/index.js，集成测试将改用真实注册表验证。
 */
export const POLICY_KEY = 'subagentModelSelectionPolicy'
export const POLICY_EVENT = 'subagent/model-selection-policy'

export const policyDefinition = {
  key: POLICY_KEY,
  stateVersion: 1,
  stateSchema: { parse: value => value },
  init: () => null,
  apply: (policy, event) => {
    if (policy !== null || event.type !== POLICY_EVENT) return policy
    const { allowedModels } = event.data
    if (!Array.isArray(allowedModels) || allowedModels.length === 0) {
      throw new Error('subagent/model-selection-policy requires at least one route')
    }
    for (const route of allowedModels) {
      if (typeof route?.provider !== 'string' || route.provider.length === 0
        || typeof route?.model !== 'string' || route.model.length === 0) {
        throw new Error('invalid route')
      }
    }
    return allowedModels
  },
}

export class FixtureRegistry {
  constructor() {
    this.registrations = new Map()
  }
  register(def) {
    let reg = this.registrations.get(def.key)
    if (reg !== undefined && reg.refs > 0) {
      if (reg.def.stateVersion !== def.stateVersion) throw new Error('stateVersion conflict')
      reg.refs += 1
    } else {
      reg = { def, cells: new Map(), refs: 1 }
      this.registrations.set(def.key, reg)
    }
    const self = this
    return {
      stateOf: session => self.cellFor(reg, session).state,
      dispose: async () => { reg.refs -= 1 },
    }
  }
  stateOf(session, key) {
    const reg = this.registrations.get(key)
    if (reg === undefined || reg.refs === 0) return undefined
    return this.cellFor(reg, session).state
  }
  cellFor(reg, session) {
    let cell = reg.cells.get(session)
    if (cell === undefined) {
      cell = this.buildCell(reg.def, session.header, session.events)
      reg.cells.set(session, cell)
    } else {
      this.advance(reg.def, cell, session)
    }
    return cell
  }
  buildCell(def, header, events) {
    let state = def.init(header, 0)
    for (const event of events) state = def.apply(state, event)
    return { state, observedSeq: events.length === 0 ? -1 : events[events.length - 1].seq, views: [undefined, undefined] }
  }
  advance(def, cell, session) {
    const events = session.events
    for (let i = cell.observedSeq + 1; i < events.length; i++) {
      const event = events[i]
      const next = def.apply(cell.state, event)
      if (!Object.is(next, cell.state)) {
        cell.views[0] = cell.views[1]
        cell.views[1] = undefined
      }
      cell.state = next
      cell.observedSeq = event.seq
    }
  }
  drive(session, event) {
    for (const reg of this.registrations.values()) {
      if (reg.refs === 0) continue
      let cell = reg.cells.get(session)
      if (cell === undefined) {
        cell = this.buildCell(reg.def, session.header, session.events.slice(0, event.seq))
        reg.cells.set(session, cell)
      } else {
        this.advance(reg.def, cell, session)
      }
      const next = reg.def.apply(cell.state, event)
      cell.state = next
      cell.observedSeq = event.seq
    }
  }
}

export class FixtureSession {
  constructor({ id = 'session-1', origin = 'session', registry, events = [] }) {
    this.id = id
    this.header = { origin }
    this.events = [...events]
    this.seq = this.events.length
    this.registry = registry
  }
  append(type, data) {
    const event = { type, seq: this.events.length, time: Date.now(), data }
    this.events.push(event)
    this.seq = this.events.length
    if (this.registry) this.registry.drive(this, event)
    return event
  }
  snapshotEvents(from = 0, to = this.events.length) {
    return this.events.slice(from, to)
  }
  eventAt(seq) {
    return this.events[seq]
  }
}

/** 会话策略门（模拟 list_subagent_models / subagent 工具读取路径）。 */
export function toolPolicy(registry, session) {
  const state = registry.registrations.get(POLICY_KEY)?.cells.get(session)?.state
  return Array.isArray(state) ? state.map(r => ({ provider: r.provider, model: r.model })) : undefined
}

/** 模拟框架 assertAllowedModelSelection（与 dsh-tool-subagent 语义一致）。 */
export function assertAllowedModelSelection(policy, parentOptions, route) {
  const allowed = policy === undefined
    ? route.provider === parentOptions.provider && route.model === parentOptions.model
    : policy.some(r => r.provider === route.provider && r.model === route.model)
  if (!allowed) {
    throw new Error('child LLM route "' + route.provider + '/' + route.model + '" is not allowed for this Session')
  }
  return true
}

/** 构造 mock ctx（events/get/effect/emit/set/logger）。 */
export function makeCtx({ settings, sessions, llm, registry, cache, appReady }) {
  const listeners = new Map()
  const ctx = {
    services: new Map(),
    on(name, cb) {
      const list = listeners.get(name) ?? []
      list.push(cb)
      listeners.set(name, list)
      return () => {
        const index = list.indexOf(cb)
        if (index >= 0) list.splice(index, 1)
      }
    },
    emit(name, ...args) {
      for (const cb of listeners.get(name) ?? []) cb(...args)
    },
    get(name) {
      return ctx.services.get(name)
    },
    set(name, value) {
      ctx.services.set(name, value)
      return ctx
    },
    effect(fn) {
      fn()
      return () => {}
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  }
  ctx.set('settings', settings)
  ctx.set('sessions', sessions)
  ctx.set('sessionProjections', registry)
  ctx.set('llm', llm)
  if (cache !== undefined) ctx.set('sessionProjectionCache', cache)
  if (appReady !== undefined) ctx.set('appReady', appReady)
  return ctx
}

/** 便捷：settings 服务 mock（describe 返回 subagent-model-selection-settings 描述）。 */
export function settingsService({ enabled = true, allowedModels = [] } = {}) {
  return {
    describe() {
      return [{ ns: 'subagent-model-selection-settings', value: { enabled, allowedModels } }]
    },
  }
}

export function llmService({ providers = [], models = {}, delayMs = 0, calls } = {}) {
  const counter = { n: 0 }
  return {
    listProviders() {
      return providers.map(id => ({ id, name: 'p:' + id }))
    },
    async listModels(providerId) {
      counter.n += 1
      if (calls !== undefined) calls.push(providerId)
      if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs))
      const list = models[providerId] ?? []
      return list.map(id => ({ id, name: 'm:' + id }))
    },
    counter,
  }
}
