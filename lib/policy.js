/**
 * 设置读取与策略校验（纯函数，可独立测试）。
 * 校验规则与框架 dsh-tool-subagent 的 assertAllowedModelRoutes 保持等价，
 * 绝不放宽：伪造字符串、空值、重复路由一律拒绝。
 */
export const SETTINGS_NS = 'subagent-model-selection-settings'

/** 从 settings 服务读取“子智能体模型选择”偏好（已脱敏描述）。 */
export function readPreference(settings) {
  if (!settings || typeof settings.describe !== 'function') return undefined
  const descriptors = settings.describe({ redactSecrets: true })
  if (!Array.isArray(descriptors)) return undefined
  const descriptor = descriptors.find(row => row && row.ns === SETTINGS_NS)
  const value = descriptor && descriptor.value
  if (value === undefined || value === null || typeof value !== 'object') return undefined
  const enabled = value.enabled === true
  const raw = Array.isArray(value.allowedModels) ? value.allowedModels : []
  const seen = new Set()
  const allowedModels = []
  for (const candidate of raw) {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      throw new Error('subagent model selection requires an array of { provider, model } routes')
    }
    const provider = candidate.provider
    const model = candidate.model
    if (typeof provider !== 'string' || provider.length === 0
      || typeof model !== 'string' || model.length === 0) {
      throw new Error('subagent model selection requires non-empty provider and model ids')
    }
    const key = provider + '\u0000' + model
    if (seen.has(key)) {
      throw new Error('subagent model selection repeats route "' + provider + '/' + model + '"')
    }
    seen.add(key)
    allowedModels.push({ provider, model })
  }
  if (enabled && allowedModels.length === 0) {
    throw new Error('enabled subagent model selection requires at least one allowed model')
  }
  return { enabled, allowedModels }
}

/** 两条路由列表是否语义相等（无序、按 provider+model 精确比较）。 */
export function sameRoutes(left, right) {
  const a = left === undefined || left === null ? null : left
  const b = right === undefined || right === null ? null : right
  if (a === null || b === null) return a === b
  if (!Array.isArray(a) || !Array.isArray(b)) return false
  if (a.length !== b.length) return false
  const keys = new Set(b.map(route => route.provider + '\u0000' + route.model))
  return a.every(route => keys.has(route.provider + '\u0000' + route.model))
}

export function routeSnapshot(routes) {
  if (routes === undefined || routes === null) return null
  return routes.map(route => ({ provider: String(route.provider), model: String(route.model) }))
}

/** 计算一次替换新增/移除的路由（仅用于事件载荷与报告，不参与决策）。 */
export function routeDiff(before, after) {
  const b = before ?? []
  const a = after ?? []
  const bKeys = new Set(b.map(route => route.provider + '\u0000' + route.model))
  const aKeys = new Set(a.map(route => route.provider + '\u0000' + route.model))
  return {
    addedRoutes: a.filter(route => !bKeys.has(route.provider + '\u0000' + route.model)),
    removedRoutes: b.filter(route => !aKeys.has(route.provider + '\u0000' + route.model)),
  }
}
