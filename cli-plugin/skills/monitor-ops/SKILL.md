---
name: monitor-ops
description: Qoder 用量监控运维技能。当用户提到"用量监控 安装""用量监控 重装""卸载用量监控""更新检查""用量监控 自检""余额排查""用量栏不见了""资源包不显示"等运维请求时使用；所有命令先读 ~/.qoder-monitor/repo-path 定位仓库绝对路径再执行。
user-invocable: true
argument-hint: [安装|重装|卸载|更新检查|自检|余额排查]
---

# Qoder 用量监控运维（monitor-ops，P1 最小版）

本技能编排 `qoder-usage-monitor` 仓库内的安装/卸载/检测脚本。**第一步永远是先定位仓库**：

```bash
R=$(cat ~/.qoder-monitor/repo-path 2>/dev/null) && echo "$R"
```

`repo-path` 由 `install.mjs`（含 `--finish`）写入，内容是一行仓库绝对路径。下文所有命令均以 `$R` 代指该绝对路径；若文件不存在，说明尚未安装过，直接执行安装流程。

## 三条红线（任何步骤不得越过）

1. **只走本机回环**：daemon 只绑定 127.0.0.1，所有 HTTP 请求只允许指向 `127.0.0.1:<port>`；不做端口转发、不对外暴露。
2. **不读解密 cookie/凭证**：永不读取、解密客户端的 Cookie 或凭证文件；账户额度全部经补丁页内 `window.qoderDesktop` 已鉴权 IPC 由 widget 上报（token/bootstrap 材料也不得出现在任何输出里）。
3. **卸载保留 ~/.qoder-monitor**：`uninstall.mjs` 只恢复 asar 与杀 daemon，历史数据目录永不删除；技能不得以"清理"名义删它。

## 安装 / 重装

```bash
cd "$R" && node scripts/install.mjs
```

- 目标可写时直接落盘；不可写时脚本**自身绝不弹密码框、不重试提权**（sudo 红线）：失败一次即打印 4 条可复制的 `sudo cp/chmod/mkdir` 命令并退出码 2，同时记 `pending-install.json`。
- 此时把命令块原样交给用户在终端执行；用户完成后执行续跑（只补写状态，绝不重建补丁）：
  ```bash
  cd "$R" && node scripts/install.mjs --finish
  ```
- 装完提示"**重启由用户执行**"：补丁需重启 Qoder 客户端才生效，而重启会杀死当前会话——必须明示用户，由用户选择时机，技能/Qoder 绝不代为重启。
- 重装（客户端更新覆盖后）= 幂等再跑同一命令；已安装时短路返回，需要重打加 `--force`。
- 装完跑一次 `node scripts/doctor.mjs` 确认状态。

## 卸载

```bash
cd "$R" && node scripts/uninstall.mjs
```

恢复 `.orig` 原版 asar（不可写时同样打印手动 sudo 块，退出码 2）、杀 `qum-daemon` 进程；同时删除 `~/.qoder-monitor/repo-path` 以停用 SessionStart 保活钩子（否则每个新 CLI 会话都会把 daemon 复活）。`~/.qoder-monitor` 历史保留（红线 3），脚本只报告其位置。

卸载后**还需手动移除 CLI 插件**以彻底停用 SessionStart hook：在 Qoder 中删除或禁用 `cli-plugin` 目录 / 已安装的 `qoder-usage-monitor-ops` 插件（脚本不自动代删，技能应向用户说明此步骤）。

## 更新检查

```bash
cd "$R" && node scripts/check-update.mjs    # 退出码 0=patched / 10=被更新覆盖 / 20=未安装
```

报 `overwritten-by-update`（10）时提示用户重跑 `install.mjs` 重打（P3 前不自动重打）。

## 自检（doctor）

```bash
cd "$R" && node scripts/doctor.mjs          # 人类可读；--json 机器可读
```

8 项检查，每项 `{name,status:'ok'|'warn'|'fail',detail}`；全绿退出 0，有 warn 退出 10，有 fail 退出 20：
`patch-state`（asar hash 三态）、`asar-marker`（asar 内 index.html qum 标记）、`daemon-health`（/health）、`scan-errors`（scanner 错误数）、`account`（source/fetchedAt，>10min 判不新鲜）、`history`（行数与最近日期）、`permissions`（敏感文件 0600 收口）、`harness`（/harness/index.html 可达）。

`node scripts/doctor.mjs --show-quota-raw` 除打印 `account.raw` 脱敏 head 外，还会追加一行 `[quota-parse]` 摘要，直接预览 用量热力（heatmap）与 累计指标（metrics）两个 bridge 源的解析状态（pickHeatmap 命中的候选名 / 天数 / 有值数 / 最新日 + metrics 六字段），首帧形状校准一眼可对。

## 余额排查（P1 = 前五项，按序执行并输出"哪层断了"）

1. **补丁层**：`doctor.mjs` 看 `patch-state`/`asar-marker`。fail → 未装或被客户端更新覆盖：重跑 `install.mjs`（sudo 红线流程），并请**用户重启客户端**。
2. **daemon 层**：`daemon-health` fail → 保活拉起：
   ```bash
   node "$R/daemon/server.mjs" --ensure --qm-role=qum-daemon
   ```
   再跑 doctor。仍 fail → 查端口占用（`ss -ltnp | grep <port>`，port 见 `~/.qoder-monitor/patch-state.json`）。
3. **扫描层**：`scan-errors` warn → 客户端 JSONL 结构可能变化，统计不完整；告知需升级 scanner 解析器（不阻塞账户排查）。
4. **桥接层**：`account` warn 且"尚无账户数据" → widget 从未成功 ingest：多半是补丁未生效（回步骤 1）或客户端未重启；重启后在 Qoder 窗口内确认底栏出现。
5. **字段层**：`account` warn（>10min 不新鲜）或解析字段为 null 时，看原始回包校准：
   ```bash
   cd "$R" && node scripts/doctor.mjs --show-quota-raw
   ```
   输出为 `account.raw` 前 800 字符预览（键名命中 `/user|email|id\b/i` 的字符串值已替换为 `[REDACTED]`，先脱敏后截断；红线 2 的延伸——token/bootstrap 永不打印）。raw 有数但 doctor 报字段缺失 → `daemon/quotaPick.mjs` 候选键名需按实际回包校准。

每条命令跑完把"哪层断了 + 下一步用户要执行的具体命令"原样转述给用户，涉及 sudo/重启的一律由用户执行。
