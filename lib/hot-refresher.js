/**
 * 热刷新核心：事件驱动 → 单飞刷新 → 原子替换活会话策略投影。
 *
 * 机制说明（与框架语义对齐）：
 * - Session 的策略投影 'subagentModelSelectionPolicy' 是 first-wins 折叠：
 *   一旦会话日志里已有 policy 事件，追加新事件不会改变投影状态。
 * - 本插件采用「重置为 init + 追加新策略事件」两步原子替换：
 *   1) 把该会话的投影 cell 状态重置为 init（null）——与框架 init() 输出相同；
 *   2) 调用 session.append('subagent/model-selection-policy', { allowedModels })
 *      —— 追加立即驱动同步折叠 apply(null, event) => 新路由；
 *   3) append 失败则回滚 cell 到旧状态（刷新失败保留旧路由）；
 *   4) 成功后让投影缓存服务把新状态持久化（冷启动 restore 仍读到新路由）。
 * - 禁用模型选择时（enabled=false）：仅重置 cell 为 null，不再追加事件，
 *   活会话立刻回到“仅父路由”策略；日志中旧 policy 事件保留但投影为 null。
 * - 子智能体会话（header.origin === 'subagent'）不受影响；新子智能体会话仍由
 *   框架的 agent/created 逻辑从父会话（已被本插件更新）继承最新路由。
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withTimeout, safeError, deepFreeze } from './util.js'
import { readPreference, sameRoutes, routeSnapshot, routeDiff } from './policy.js'
import { loadState, saveState } from './state.js'

const POLICY_KEY = 'subagentModelSelectionPolicy'
const POLICY_EVENT = 'subagent/model-selection-policy'
const MODEL_NAMESPACES = new Set([
  'subagent-model-selection-settings',
  'llm',
  'settings.models',
])

export const CATALOG_CHANGED_EVENT = 'agent-model-catalog-changed'

export class AgentRouteHotRefresher {
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = {
      providerTimeoutMs: 8000,
      debounceMs: 300,
      stateFile: null,
      ...(config && typeof config === 'object' ? config : {}),
    }
    const moduleDir = dirname(fileURLToPath(import.meta.url))
    const rootDir = dirname(moduleDir)
    this.stateFile = this.config.stateFile ?? join(rootDir, 'state', 'dsh-hot-routes.json')
    this.state = loadState(this.stateFile)
    this.inFlight = null
    this.lock = Promise.resolve()
    this.timer = null
    this.activated = false

    ctx.on('settings/document-updated', (ns) => {
      if (typeof ns !== 'string' || !MODEL_NAMESPACES.has(ns)) return
      this.schedule('settings-save:' + ns)
    })
    ctx.on('app-boot/config-reload', () => {
      this.schedule('config-reload')
    })
    // 会话恢复/新建（seq 任意）：对齐设置——覆盖“会话在插件启动刷新之后才恢复”的时序
    ctx.on('session/created', () => {
      this.schedule('session-created')
    })

    const ready = ctx.get('appReady')
    const boot = () => {
      if (this.activated) return
      this.activated = true
      void this.refresh('plugin-activation').catch(() => {})
    }
    if (ready && typeof ready.onReady === 'function') ready.onReady(boot)
    else boot()

    ctx.effect(() => {
      return () => {
        if (this.timer !== null) {
          clearTimeout(this.timer)
          this.timer = null
        }
      }
    })
    this.log('activated; stateFile=%s catalogVersion=%s', this.stateFile, this.state.catalogVersion)
  }

  log(format, ...args) {
    try { this.ctx.logger.info('agent-route-hot-refresher: ' + format, ...args) } catch { /* 静默 */ }
  }

  warn(format, ...args) {
    try { this.ctx.logger.warn('agent-route-hot-refresher: ' + format, ...args) } catch { /* 静默 */ }
  }

  /** 防抖调度（合并密集的设置保存事件）。 */
  schedule(reason) {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.refresh(reason).catch(() => {})
    }, Number.isFinite(this.config.debounceMs) ? this.config.debounceMs : 300)
  }

  /**
   * 单飞刷新 + 并发锁：
   * - 刷新进行中时，并发触发返回同一个 in-flight Promise（provider 只查询一次）；
   * - 刷新完成后，下一次触发开启新一轮（串行互斥）。
   */
  refresh(reason = 'manual') {
    if (this.inFlight !== null) return this.inFlight
    const run = () => this.runRefresh(reason)
    this.inFlight = this.lock.then(run, run).finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  /** 供外部（测试/工具）读取的脱敏快照。 */
  snapshot() {
    return {
      catalogVersion: this.state.catalogVersion,
      stale: this.state.stale,
      sessionRouteVersions: { ...this.state.sessionRouteVersions },
      routesSnapshot: this.state.routesSnapshot === null ? null : routeSnapshot(this.state.routesSnapshot),
      lastError: this.state.lastError,
      lastSuccessAt: this.state.lastSuccessAt,
      lastFailedAt: this.state.lastFailedAt,
    }
  }

  async runRefresh(reason) {
    const at = Date.now()
    const llm = this.ctx.get('llm')
    const sessionsService = this.ctx.get('sessions')
    const projections = this.ctx.get('sessionProjections')
    const cache = this.ctx.get('sessionProjectionCache')
    const failures = []

    // 1) 读取用户偏好（含校验，失败即 stale，保留旧路由）
    let preference
    try {
      preference = readPreference(this.ctx.get('settings'))
    } catch (error) {
      return this.fail(reason, at, 'preference:' + safeError(error))
    }
    const target = preference !== undefined && preference.enabled
      ? preference.allowedModels
      : undefined

    // 2) 重读 provider 模型目录（超时；失败即 stale，保留旧路由）
    const advertised = {}
    const providerIds = new Set()
    if (target !== undefined) for (const route of target) providerIds.add(route.provider)
    try {
      if (typeof llm.listProviders !== 'function') throw new Error('llm service unavailable')
      const providers = llm.listProviders()
      for (const providerId of providerIds) {
        const registered = providers.some(info => info && info.id === providerId)
        const models = await withTimeout(
          Promise.resolve(llm.listModels(providerId)),
          Number.isFinite(this.config.providerTimeoutMs) ? this.config.providerTimeoutMs : 8000,
          'provider catalog query for ' + providerId,
        )
        advertised[providerId] = {
          registered,
          models: Array.isArray(models) ? models.map(model => (model && typeof model.id === 'string') ? model.id : String(model?.id ?? model)).slice(0, 500) : [],
        }
      }
    } catch (error) {
      return this.fail(reason, at, 'catalog:' + safeError(error))
    }

    // 3) 原子替换所有活着的顶层会话的 allowed child routes
    const refreshed = []
    let sessionList = []
    try {
      sessionList = sessionsService.list()
    } catch (error) {
      return this.fail(reason, at, 'sessions:' + safeError(error))
    }
    for (const session of sessionList) {
      if (!session || typeof session.id !== 'string') continue
      if (session.header && session.header.origin === 'subagent') continue
      const current = this.readPolicy(session, projections)
      if (sameRoutes(current, target)) continue
      const diff = routeDiff(current, target)
      const outcome = this.replacePolicy(session, projections, target)
      if (!outcome.ok) {
        failures.push({ sessionId: session.id, error: outcome.error })
        continue
      }
      /* keep session id for events */
      this.state.sessionRouteVersions[session.id] = (Number(this.state.sessionRouteVersions[session.id]) || 0) + 1
      refreshed.push({
        sessionId: session.id,
        sessionRouteVersion: this.state.sessionRouteVersions[session.id],
        ...diff,
      })
      if (cache && typeof cache.write === 'function') {
        void Promise.resolve(cache.write(session)).catch(() => {})
      }
    }

    // 部分失败：保留未成功会话的旧路由，全局标记 stale，不推进 catalogVersion
    if (failures.length > 0) {
      this.state.stale = true
      this.state.lastError = 'partial: ' + failures.length + ' session(s) failed to replace routes'
      this.state.lastFailedAt = at
      saveState(this.stateFile, this.state)
      const partialPayload = {
        catalogVersion: this.state.catalogVersion,
        stale: true,
        reason: String(reason),
        enabled: preference !== undefined && preference.enabled,
        routes: routeSnapshot(target ?? null),
        advertised,
        refreshedSessions: refreshed,
        failures,
        at,
      }
      this.emit(partialPayload)
      this.warn('refresh(%s) partially failed (stale): %s', reason, this.state.lastError)
      return { ok: false, stale: true, payload: partialPayload }
    }

    // 4) 递增 catalogVersion 并持久化
    this.state.catalogVersion = (Number(this.state.catalogVersion) || 0) + 1
    this.state.stale = false
    this.state.lastError = null
    this.state.lastSuccessAt = at
    this.state.routesSnapshot = routeSnapshot(target ?? null)
    saveState(this.stateFile, this.state)

    const payload = {
      catalogVersion: this.state.catalogVersion,
      stale: false,
      reason: String(reason),
      enabled: preference !== undefined && preference.enabled,
      routes: routeSnapshot(target ?? null),
      advertised,
      refreshedSessions: refreshed,
      failures,
      at,
    }
    this.emit(payload)
    this.log('refresh(%s) ok: catalogVersion=%s sessions=%s', reason, payload.catalogVersion, refreshed.length)
    return { ok: failures.length === 0, payload }
  }

  /** 刷新失败：保留旧路由、标记 stale、事件仍触发（携带 stale 标志）。 */
  fail(reason, at, error) {
    this.state.stale = true
    this.state.lastError = error
    this.state.lastFailedAt = at
    saveState(this.stateFile, this.state)
    const payload = {
      catalogVersion: this.state.catalogVersion,
      stale: true,
      reason: String(reason),
      error,
      at,
    }
    this.emit(payload)
    this.warn('refresh(%s) failed, keeping old routes (stale): %s', reason, error)
    return { ok: false, stale: true, error, payload }
  }

  /** 发出 agent-model-catalog-changed 事件（载荷只含 id 与版本，不含任何秘密）。 */
  emit(payload) {
    try {
      this.ctx.emit(CATALOG_CHANGED_EVENT, payload)
    } catch (error) {
      this.warn('emit ' + CATALOG_CHANGED_EVENT + ' failed: %s', safeError(error))
    }
  }

  /** 读取某会话当前的策略路由（投影 cell；与工具读取路径一致）。 */
  readPolicy(session, projections) {
    const cell = this.policyCell(session, projections)
    if (cell === undefined) return undefined
    const state = cell.state
    if (!Array.isArray(state)) return undefined
    return state.map(route => ({ provider: String(route.provider), model: String(route.model) }))
  }

  /** 定位策略投影的 cell（优先走注册表内部 map；缺失时触发惰性物化）。 */
  policyCell(session, projections) {
    if (!projections) return undefined
    const reg = projections.registrations ? projections.registrations.get(POLICY_KEY) : undefined
    let cell = reg && reg.cells ? reg.cells.get(session) : undefined
    if (cell === undefined && reg !== undefined) {
      // 触发惰性物化（与 stateOf 同路径），再取一次
      try {
        if (typeof projections.stateOf === 'function') projections.stateOf(session, POLICY_KEY)
      } catch { /* 忽略 */ }
      cell = reg.cells ? reg.cells.get(session) : undefined
    }
    return cell
  }

  /**
   * 原子替换一个会话的 allowed child routes。
   * target === undefined → 禁用模型选择（cell 重置为 init/null）。
   * 否则：cell 重置为 init → 追加新策略事件 → 框架同步折叠出目标状态；
   *       追加失败则回滚旧状态。任何时刻调用方读到的都是完整的旧值或完整的新值。
   */
  replacePolicy(session, projections, target) {
    const reg = projections && projections.registrations ? projections.registrations.get(POLICY_KEY) : undefined
    if (reg === undefined || !reg.cells) return { ok: false, error: 'policy projection not registered' }
    let cell = reg.cells.get(session)
    if (cell === undefined) {
      try {
        if (typeof projections.stateOf === 'function') projections.stateOf(session, POLICY_KEY)
      } catch { /* 忽略 */ }
      cell = reg.cells.get(session)
    }
    if (cell === undefined) return { ok: false, error: 'policy cell unavailable for session' }
    const previous = cell.state
    cell.state = null // init 状态（与框架 init() 输出一致）
    if (cell.views && Array.isArray(cell.views)) {
      cell.views[0] = undefined
      cell.views[1] = undefined
    }
    if (target === undefined) {
      return { ok: true }
    }
    try {
      session.append(POLICY_EVENT, { allowedModels: target.map(route => ({ provider: route.provider, model: route.model })) })
    } catch (error) {
      cell.state = previous // 回滚：保留旧路由
      return { ok: false, error: safeError(error) }
    }
    // 防御：若某种驱动路径未同步折叠，直接落目标状态（保证原子可见）
    const after = reg.cells.get(session) && reg.cells.get(session).state
    if (!sameRoutes(Array.isArray(after) ? after : undefined, target)) {
      cell.state = deepFreeze(target.map(route => ({ provider: route.provider, model: route.model })))
    }
    return { ok: true }
  }
}

export default AgentRouteHotRefresher
