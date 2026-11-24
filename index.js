import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
try {
  const __markerDir = join(dirname(fileURLToPath(import.meta.url)), 'state')
  mkdirSync(__markerDir, { recursive: true })
  writeFileSync(join(__markerDir, 'module-eval.json'), JSON.stringify({ at: Date.now(), pid: process.pid }))
} catch { /* 静默 */ }

/**
 * 「Agent 路由热刷新器」(agent-route-hot-refresher)
 *
 * 目标：用户在插件设置（设置 → 子智能体，命名空间 subagent-model-selection-settings）
 * 中新增/勾选/取消勾选子智能体模型并保存后：
 *   1. 触发 agent-model-catalog-changed 事件；
 *   2. 重新读取 provider 模型目录（llm.listProviders/listModels，带超时）；
 *   3. 递增 catalogVersion；
 *   4. 原子替换当前 Session 的 allowed child routes（会话投影 cell 重置为 init 后追加新策略事件）；
 *   5-9. list_subagent_models / subagent / subagent_fork 每次调用都实时读取该投影，立即生效；
 *   10. 刷新失败保留旧路由并标记 stale；
 *   11. provider 查询带超时、单飞刷新、并发锁；
 *   12. 未授权模型无法通过伪造字符串绕过（策略校验 + 框架 preflight 双重把关）。
 *
 * 安全：不记录任何 API Key/Authorization/Cookie/提示词；不改 AGENTS.md；不改 app.asar；
 * 不绕过服务端 Session 授权 —— 仅把用户在设置里保存的授权实时应用到活会话投影。
 */
import { AgentRouteHotRefresher } from './lib/hot-refresher.js'

export const name = 'agent-route-hot-refresher'

export function apply(ctx, config) {
  const report = (payload) => {
    try {
      const markerDir = join(dirname(fileURLToPath(import.meta.url)), 'state')
      mkdirSync(markerDir, { recursive: true })
      writeFileSync(join(markerDir, 'apply.json'), JSON.stringify(payload))
    } catch { /* 静默 */ }
  }
  try {
    const instance = new AgentRouteHotRefresher(ctx, config)
    let release = () => {}
    try {
      const provided = ctx.provide('agentRouteHotRefresh', instance)
      if (typeof provided === 'function') release = provided
    } catch (error) {
      try { ctx.logger.warn('agent-route-hot-refresher: provide failed: ' + (error && error.message ? error.message : String(error))) } catch { /* 静默 */ }
    }
    ctx.effect(() => release)
    report({ ok: true, at: Date.now(), pid: process.pid })
    return instance
  } catch (error) {
    report({ ok: false, error: error && error.message ? error.message : String(error), stack: error && error.stack ? String(error.stack).split('\n').slice(0, 4).join(' | ') : null, at: Date.now(), pid: process.pid })
    throw error
  }
}

export default { name, apply }
