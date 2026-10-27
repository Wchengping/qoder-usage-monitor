# Qoder Usage Monitor

本机 Qoder 桌面客户端的用量监控小工具。它在 Qoder 窗口中注入一条底栏和一个可展开面板，显示本地 token / credits 消耗、账户资源包余额、会话与工具统计、用量热力和累计指标。

所有数据都在本机处理：daemon 只监听 `127.0.0.1`，不上传任何内容。

## 功能

- **底栏**：吞吐、资源包剩余比例、会话累计、工具调用、credits、最近回合耗时，以及上次分析时刻。
- **面板**：用量节奏、token 消耗、缓存命中、吞吐/时长、工具与失败、会话明细、模型分布、资源包、用量热力、累计指标。
- **两种计费口径**：内置模型按 credits，BYOK（`qoder-custom-*`）按 token；主数字优先显示实际扣减的 credits，名义值和未扣减量只放进 tooltip。
- **账户数据**：通过 Qoder 渲染进程已鉴权的 `window.qoderDesktop` IPC 读取，并解析 `userQuota` / `addOnQuota` / 热力 / 累计指标。
- **本地统计**：递归扫描 Qoder 会话与子代理 JSONL，按 5 小时滚动窗口、本地自然日/周聚合；uuid 去重，跳过 `<synthetic>` 记录。输出 token 有真实 `usage.output_tokens` 时用真值，缺失才按正文估算，界面以 `~` 标注估算值。

## 隐私与安全

- 不读取、不解密 Cookie、keychain、SQLite 或 LevelDB；账户额度只走客户端官方 IPC。
- daemon 仅绑定 `127.0.0.1`；请求需要 64 位十六进制 token，首次通过一次性 bootstrap 换取。
- 运行时文件位于 `~/.qoder-monitor/`，凭据与状态文件以 `0600` 写入；安装产物同样收口为 `0600`。
- 开发态静态路由（`/dev/*`、`/harness/*`、`/app/*`）默认关闭，只有显式设置 `QUM_DEV=1` 才开放。
- 账户样例数据（额度、热力、累计指标）均为合成值，不包含真实账户、路径或会话标识。

## 环境要求

- Linux x64。
- Node.js >= 20.11（使用了 `import.meta.dirname`）。
- 已安装 Qoder 桌面版；默认查找 `/opt/Qoder-CN/resources/app.asar`，并兼容旧目录 `/opt/Qoder CN/resources`。自定义安装路径可通过 `QUM_APP_ASAR` 指定。

> 目前只适配 Linux。客户端自动更新会覆盖 `app.asar`，更新后需要重新运行安装脚本。

## 安装

先完全退出 Qoder（安装器会拒绝在客户端运行时替换 `app.asar`）：

```bash
git clone https://github.com/Wchengping/qoder-usage-monitor.git
cd qoder-usage-monitor
npm install
node scripts/install.mjs
```

- 目标目录可写时直接安装。
- 需要提权时，安装器不会自行弹密码框，而是打印一组可复制的 `sudo` 命令并以退出码 `2` 结束。手动执行这些命令后继续：

```bash
node scripts/install.mjs --finish
```

- 安装完成后重启 Qoder，底栏才会出现。
- 客户端更新覆盖补丁后，使用 `node scripts/install.mjs --force` 重新打补丁。

常用参数：`--port <port>` 指定 daemon 端口（默认 `49789`），`--skip-preflight` 跳过预检，`--force` 强制重打。

## 自检与卸载

```bash
node scripts/doctor.mjs          # 8 项检查；全绿 0 / warn 10 / fail 20
node scripts/doctor.mjs --json   # 机器可读
node scripts/doctor.mjs --show-quota-raw  # 脱敏后的账户原始回包 + 解析摘要

node scripts/check-update.mjs    # patched 0 / 被更新覆盖 10 / 未安装 20

node scripts/uninstall.mjs       # 恢复原版 asar、停止 daemon
```

卸载只恢复客户端文件并停止进程，**不会删除** `~/.qoder-monitor/` 下的历史数据。

## 开发与测试

```bash
npm test
```

测试使用 Node 内置 test runner，覆盖 scanner、quota 解析、HTTP daemon、安装/卸载、doctor、widget DOM 与模块渲染。

本地开发态预览：

```bash
QUM_DEV=1 node daemon/server.mjs --port 49789
# 打开 http://127.0.0.1:49789/harness/
```

`QUM_HOME` 可把运行时目录重定向到临时路径；`QUM_APP_ASAR` 可把安装目标指向测试用 asar。

## 目录结构

```text
app/         注入页的 loader、widget、渲染模块与格式化
daemon/      本地 HTTP daemon、会话扫描、quota 解析、持久化
scripts/     安装、卸载、doctor、更新检查、asar 补丁流水线
cli-plugin/  可选的 Qoder CLI 插件（运维技能 + SessionStart 保活）
tests/       Node test runner 测试与合成样例
```
