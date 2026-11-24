# Changelog / 更新日志

## 1.0.4

- 新增浏览器半区（`dsh.client`）：插件启动后，GUI 右下角弹一次提示「已启用」（按版本去重，可点击关闭）。
- 用于解决「装完不知道是否生效」的问题。


## 1.0.3

- 安装引导强化：插件描述、README、INSTALL 顶部均醒目提示「安装后需重启一次 Harness」。
- 状态与事件携带 `pluginVersion`（1.0.2 引入），便于确认更新是否生效。


## 1.0.1

- 版本号演练：验证 GitHub tag 分发下的更新流程。
- 发布说明：安装时使用 `#v1.0.1` 固定版本即可升级到本版本。

## 1.0.0

- 首个公开版本：保存子智能体模型设置后，正在运行的会话立即热刷新可委派路由。
- 事件 `agent-model-catalog-changed`、catalogVersion / sessionRouteVersion、超时/单飞/并发锁、原子替换、失败 stale 回退。
- 测试 13/13 通过；支持 Windows / macOS / Linux。
