# Agent 路由热刷新器（agent-route-hot-refresher）

> 开源许可：MIT ｜ 支持平台：Windows / macOS / Linux ｜ 中文安装指南：[INSTALL.md](./INSTALL.md)

## TL;DR (English)

A DeepSeek Harness bundle plugin: after you save the subagent model selection
in **Settings → Subagent**, every **already-running** Session picks up the new
allowed child routes **immediately** — no Harness restart, no new Session.
Emit `agent-model-catalog-changed` on every refresh; re-reads the provider
catalog with timeout/single-flight/locking; maintains global
`catalogVersion` and per-session `sessionRouteVersion`; atomically replaces
each Session's `subagent/model-selection-policy` projection; keeps old routes
and marks `stale` when a refresh fails; forged provider/model strings are
rejected by the same validation strength as the framework.

Install: plugin manager → Add plugin → `https://github.com/q2560080107/agent-route-hot-refresher` (or a local path), then restart the Host once as guided.
After that, model-setting changes hot-apply forever.

> 面向最终用户的安装与验证说明见 [INSTALL.md](./INSTALL.md)；本文面向开发者/维护者。

专属插件：用户在 **设置 → 子智能体** 中新增 / 勾选 / 取消勾选子智能体模型并保存后，
**不关闭 Harness、不新建会话**，当前 Session 立即能（或不能）用该模型委派子智能体。

## 目录

- [机制](#机制)
- [文件清单](#文件清单)
- [新增事件与 API](#新增事件与-api)
- [catalogVersion 与 sessionRouteVersion 设计](#catalogversion-与-sessionrouteversion-设计)
- [部署方式](#部署方式)
  - [A. Forge 动态 Host 半区（推荐：运行中热加载）](#a-forge-动态-host-半区推荐运行中热加载)
  - [B. profile 条目安装（持久化，需 host 重启生效）](#b-profile-条目安装持久化需-host-重启生效)
- [测试](#测试)
- [UI 手动验证步骤](#ui-手动验证步骤)
- [回滚步骤](#回滚步骤)
- [安全说明](#安全说明)
- [已知限制](#已知限制)

## 机制

框架事实（来自 DSH 0.2.2-rc.5 源码，只读调研）：

- 会话的「子智能体模型选择策略」是会话事件投影 `subagentModelSelectionPolicy`
  （dsh-tool-subagent/src/model-selection-state.ts），由
  `subagent/model-selection-policy` 事件驱动，**first-wins 折叠**：
  会话日志里已有 policy 事件后，追加新事件不会改变投影状态。
- `list_subagent_models`、`subagent`、`subagent_fork` 每次调用都通过该投影
  实时读取策略（dsh-tool-subagent/src/list-models.ts / index.ts）。
- 设置保存链路：设置 UI（dsh-client-ui-settings-subagent，命名空间
  `subagent-model-selection-settings`）→ settings 服务 mutate → 落盘并触发
  `settings/document-updated(ns, revision)` 事件。

本插件因此实现「重置为 init + 追加新事件」的原子替换：

1. 把目标会话的投影 cell 重置为 init（`null`，与框架 `init()` 输出一致）；
2. 调用 `session.append('subagent/model-selection-policy', { allowedModels })`——
   追加立即驱动框架同步折叠 `apply(null, event) => 新路由`；
3. append 失败则回滚 cell 到旧状态（刷新失败保留旧路由）；
4. 成功后让投影缓存服务（`sessionProjectionCache.write`）持久化新状态，
   冷启动 restore 仍读到新路由；
5. 禁用模型选择（`enabled=false`）时仅重置 cell 为 `null`：活会话立刻退回
   “仅父路由”策略；
6. 子智能体会话（`header.origin === 'subagent'`）不受影响；新子智能体会话仍由
   框架的 `agent/created` 逻辑从父会话（已被本插件更新）继承最新路由。

刷新编排：防抖 300ms → **并发锁 + 单飞**（进行中复用同一 Promise）→ 读取偏好
（等价于框架 `assertAllowedModelRoutes` 的校验，伪造字符串/空值/重复一律拒绝）→
**超时**（默认 8000ms，可配）重读 provider 模型目录（`llm.listProviders/listModels`）
→ 逐会话原子替换 → 全部成功才 `catalogVersion++`；任一失败保留旧路由、标记
`stale` 并发出携带 `stale:true` 的事件。

## 文件清单

（均位于 `C:\Users\XQW\.dsh\profiles\desktop\plugins\agent-route-hot-refresher\`）

| 文件 | 作用 |
| --- | --- |
| `index.js` | profile 安装形态入口（named + default 导出，ctx.provide 注册服务） |
| `lib/hot-refresher.js` | 核心：HotRefresher 类（事件、锁、单飞、超时、原子替换、版本、stale） |
| `lib/policy.js` | 设置读取与策略校验（纯函数） |
| `lib/state.js` | catalogVersion/sessionRouteVersion/stale 持久化（JSON 原子写） |
| `lib/util.js` | withTimeout / safeError / deepFreeze |
| `forge/forge-host-code.js` | Forge 动态 Host 半区单文件（沙箱兼容：无 fs/setTimeout，用 ctx.timeout；状态驻内存） |
| `tests/hot-refresher.test.mjs` | 10 项场景测试（T1–T10） |
| `tests/forge-smoke.test.mjs` | Forge 变体 smoke（F1–F3） |
| `tests/helpers.mjs` | 夹具：镜像真实投影注册表语义的 FixtureRegistry/FixtureSession/mock ctx |
| `tests/run-tests.mjs` | 进程内运行器 |

未修改任何 asar 文件、业务工作区代码、AGENTS.md；profile 的
`cordis.patch.yml` 在当前部署方案 B 中仅在安装时追加一个条目（可回滚）。

## 新增事件与 API

1. **事件 `agent-model-catalog-changed`**（新增，本插件发出）：
   每次刷新尝试（成功或失败）都发出一次。载荷：
   `{ catalogVersion, stale, reason, enabled, routes, advertised, refreshedSessions, failures, at, error? }`
   ——只含模型/提供商 id 与版本号，不含任何密钥。
2. **服务 `ctx.get('agentRouteHotRefresh')`**（新增，ctx.provide 注入）：
   `refresh(reason)`（手动/程序化触发）、`snapshot()`（脱敏快照：
   catalogVersion、stale、sessionRouteVersions、routesSnapshot、lastError）。
3. 监听既有事件：`settings/document-updated`（命名空间
   `subagent-model-selection-settings` / `llm` / `settings.models`）、
   `app-boot/config-reload`。
4. 复用既有框架 API：`session.append`、`sessionProjections` 注册表 cell、
   `sessionProjectionCache.write`、`llm.listProviders/listModels`。

## catalogVersion 与 sessionRouteVersion 设计

- **catalogVersion**：全局单调递增整数（持久化于 state JSON；Forge 变体驻内存）。
  每次“设置保存触发的刷新”整体成功后 +1；失败（含部分失败）不推进，
  防止外部观察到“版本变了但路由没变”。
- **sessionRouteVersion**：按 sessionId 的每会话路由代数计数器。
  每次该会话的策略被原子替换成功后 +1；新会话从 0 开始（其策略由框架在
  创建时按最新设置写入）。事件载荷的 `refreshedSessions` 同时携带两者，
  可精确表达“哪个会话在第几代路由上”。
- 两者解耦：catalogVersion 描述“模型目录/设置的全局代际”，
  sessionRouteVersion 描述“单个活会话已应用到的路由代际”；测试 T1/T2/T3
  验证递增与事件一致性，T6/T9 验证失败不推进版本。

## 部署方式

### A. Forge 动态 Host 半区（推荐：运行中热加载）

1. GUI → 创造模式 → Cordis/插件运行面板 → 新建插件（Host 半区）；
2. 粘贴 `forge/forge-host-code.js` 的全部内容；
3. 定义并运行（host-only 包无需审批，立即在 host 组合上激活，
   完整访问 settings/sessions/sessionProjections/llm）；
4. 激活后按「UI 手动验证步骤」验证。

该方式**不改 profile、不触发 host 重启**；状态驻内存（host 重启后
catalogVersion 从 0 重新计数——语义正确，只是不跨重启持久化）。

### B. profile 条目安装（持久化，需 host 重启生效）

1. 把 `cordis.patch.yml.arhr-backup` 之前的内容追加一条：
   ```yaml
   - id: agent-route-hot-refresher
     name: agent-route-hot-refresher
     config:
       providerTimeoutMs: 8000
       debounceMs: 300
   ```
   并在 `profiles/desktop/node_modules/` 下建 junction
   `agent-route-hot-refresher` → `../plugins/agent-route-hot-refresher`；
2. 当前桌面构建对 profile 变更会触发 **host 子进程重启**（有活跃会话时被推迟），
   重启后条目生效；状态持久化于
   `plugins/agent-route-hot-refresher/state/agent-route-hot-refresher.json`。
   **注意：在当前桌面构建上，该方式不能做到“不重启”**，热刷新能力的
   在线验收请使用方式 A。

## 测试

\`\`\`text
> node tests/run-tests.mjs
PASS T1 .. PASS T10
PASS F1 .. PASS F3
=== 结果: 13 passed, 0 failed ===
\`\`\`

| 编号 | 场景（对应用户要求） |
| --- | --- |
| T1 | 新增模型后当前 Session 立即可见（含 catalogVersion 与事件） |
| T2 | 当前 Session 不重启即可成功委派（委派前读取最新路由） |
| T3 | 取消模型后新委派被拒绝 |
| T4 | 并发刷新只请求 provider 一次（单飞） |
| T5 | 刷新期间不会出现半更新路由（原子性） |
| T6 | provider 超时返回 stale 缓存（保留旧路由） |
| T7 | 未授权模型无法使用（伪造字符串被拒） |
| T8 | 新 Session 可读取最新目录 |
| T9 | 旧 Session 刷新失败时保留原路由 |
| T10 | 设置保存事件触发刷新（事件接线） |
| F1–F3 | Forge 变体：沙箱求值、完整链路、并发单飞 |

## UI 手动验证步骤

1. 打开 设置 → 子智能体：确认「允许的子智能体模型」卡片列出当前模型目录；
2. 取消勾选某模型 → 保存 → 回到会话输入
   `list_subagent_models(provider=...)`：该模型消失；
   再尝试 `subagent(provider=..., model=被取消模型)`：被拒绝；
3. 重新勾选该模型 → 保存 → 同一会话内再次
   `list_subagent_models`：立即出现；直接
   `subagent(provider=..., model=该模型, ...)` 委派一个小任务：成功启动子智能体；
4. 已运行的子智能体继续工作，不受影响；
5. 全程不重启 Harness、不新建会话。

## 回滚步骤

- 方式 A：面板中停止/删除该动态插件即可（立即生效）。
- 方式 B：删除 `cordis.patch.yml` 中的 `agent-route-hot-refresher` 条目与
  `node_modules\agent-route-hot-refresher` junction（可用
  `cordis.patch.yml.arhr-backup` 一键还原）；随后 host 重启即回到原状。
- 测试产生的临时状态文件：删除
  `plugins/agent-route-hot-refresher/state/` 整个目录即可。

## 部署关键教训（务必遵守）

bundle/用户补丁中的**新条目必须用 `- insert:` 包裹**，裸行列表会被当作对
既有条目的覆盖：找不到同名 id 的条目会被静默丢弃（dump-config 首行会打印
`patch: entry "<id>" not found`）。本插件 bundle 层写法：

```yaml
- insert:
    - id: agent-route-hot-refresher
      name: agent-route-hot-refresher
      config:
        providerTimeoutMs: 8000
        debounceMs: 300
```

## 活体验收记录（2026-11-25）

- 安装：插件管理器「添加插件」本地路径安装 → 自动启用 bundle → 菜单「重启应用与 Host」一次；
- 激活：module-eval/apply 标记出现，catalogVersion=3，本会话 sessionRouteVersion=1；
- 新勾选模型 deepseek-account/deepseek-flash 在当前会话 list_subagent_models 立即可见；
- subagent(provider=deepseek-account, model=deepseek-flash) 实际委派成功，子智能体回复完成；
- 证据文件：evidence-live-verification.md、evidence-experiment-A.md。

## 卸载行为

- 插件界面停用/移除本插件（或删除 bundle 条目与依赖）并重启一次 host 后：
  - 已运行会话保持其当前策略（会话日志不可变，卸载不破坏会话数据）；
  - 之后取消勾选/勾选模型不再对已运行会话即时生效，回到框架默认
    （仅新会话在创建时按当时设置写入策略）；
  - 插件全部状态位于插件目录 state/ 下，随目录删除，无残留副作用。

## 分享给他人

1. 打包：\`tar -czf agent-route-hot-refresher-1.0.0.tgz agent-route-hot-refresher\`（不含 state/ 与临时文件）；
2. 对方：插件界面 →「添加插件」→ 输入 tarball 的绝对路径或 URL → 安装；
   （插件管理器支持本地路径/文件链接/git/tarball 多种来源）
3. 安装完成后按其引导重启一次 host，之后模型设置改动即时热生效；
4. 显示名与介绍由包内 locale/zh.json、locale/en.json 与 icon.svg 提供，
   对方界面会显示「Agent 路由热刷新器」与中文介绍。

## 安全说明

- 不读取、不记录任何 API Key / Authorization / Cookie / 提示词；
  事件与日志只含模型/提供商 id 与版本号；
- 未修改 AGENTS.md、未绕过服务端 Session 授权——插件只把用户在设置里
  **已保存**的授权实时应用到活会话投影，`subagent`/`subagent_fork` 的
  框架级 preflight 校验保持权威；
- 未修改 app.asar（检查出为只读虚拟视图，全部修改都在用户 profile 目录）。

## 已知限制

- 会话日志不可变：旧 policy 事件仍留在日志中；投影以 cell 当前值（新路由）
  与持久化检查点为准。极端情况下（检查点行被丢弃且整日志重放）会回到
  first-wins 的旧值——重启后首次冷读走检查点行，不受影响。
- Forge 变体无磁盘状态：catalogVersion/sessionRouteVersion 不跨 host 重启持久化。
- 当前桌面构建对 profile 条目变更走 host 重启策略，在线热加载请用方式 A。
