#!/bin/bash
# Qoder Usage Monitor — 部署链编排脚本
#
# 为什么存在：落盘 4 行 sudo + 刷新 daemon + 对账 + doctor 这套动作每个版本都要重复一遍，
# 容易漏步（漏 --finish 会让 patch-state 与实际盘上不符；忘 pkill 旧 daemon 会让界面还是旧代码）。
#
# 安全边界（与仓库红线一致，逐字）：
#   · 提权只有一条路：默认模式（需要真人在终端输入 sudo 密码）。非 tty 一律拒绝，
#     所以 agent/CI 无法用本脚本代跑提权——agent 只能用 --build / --finish / --verify 三个无提权模式。
#   · 绝不自动重启客户端（会杀掉用户会话），只在最后提示由用户择机执行。
#   · daemon 清理只允许 49789 这一个精确 pattern，绝不做泛化 pkill。
#
# 用法：
#   bash scripts/deploy.sh              # 你本人：全流程（会问一次 sudo 密码）
#   bash scripts/deploy.sh --build      # agent 可跑：基线检测 + 构建产物，打印指纹，不落盘
#   bash scripts/deploy.sh --finish     # agent 可跑：清旧 daemon + --finish 补状态并拉起新 daemon
#   bash scripts/deploy.sh --verify     # agent 可跑：生产对账（全局 + 按当前会话）+ doctor
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=49789
MODE="${1:-all}"

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

# 2026-10-23 真机事故：客户端运行中替换 app.asar → 运行实例读到错乱归档
# （Invalid package config …/app.asar/package.json）→ 关闭流程卡死 → 窗口消失但
# 单实例锁仍被占 → 再点图标只被转发 → 表现为"打不开"。
# 因此落盘类模式必须先确认客户端已完全退出；判据与 Electron 一致：SingletonLock。
LOCK="$HOME/.config/com.qodercn.app.stable/SingletonLock"
client_pid() {
  local t pid
  t=$(readlink "$LOCK" 2>/dev/null) || return 1
  pid="${t##*-}"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1   # 陈旧锁（SIGKILL 残留）视为未运行
  printf '%s' "$pid"
}
require_client_closed() {
  local pid
  if pid=$(client_pid); then
    echo "  拒绝落盘：Qoder 正在运行（pid $pid）。" >&2
    echo "  运行中替换 app.asar 会让它读到错乱归档、关闭卡死，之后表现为「打不开」。" >&2
    echo "  请先完全退出 Qoder 再重试。复核：readlink \"$LOCK\" 应失败。" >&2
    exit 9
  fi
  echo "  客户端未运行，可以安全落盘。"
}

check_update() {
  say "1/5 客户端基线检测"
  local out status
  # check-update 对 overwritten/unpatched 返回 10/20 —— 退出码由下面的 case 按 status 分流，
  # 不能让 set -e 在拿到 JSON 之前就把脚本杀掉。
  out=$(node scripts/check-update.mjs --json || true)
  [ -n "$out" ] || { echo "  check-update 无输出（node 异常？），拒绝继续。" >&2; exit 3; }
  status=$(printf '%s' "$out" | python3 -c 'import json,sys;print(json.load(sys.stdin)["status"])')
  printf '%s\n' "$out" | python3 -c 'import json,sys;d=json.load(sys.stdin);print("  status=%s asar=%s daemon=%s"%(d["status"],d["asarSha256"][:8],d["daemon"]["running"]))'
  # 客户端 auto-update 覆盖 asar 是常态（2026-10-15 0.4.4→0.4.7 真机踩过：旧守卫在
  # overwritten-by-update 直接 exit 3，把唯一恢复入口堵死）。三种"需要重打"的基线
  # 状态一律放行——install.mjs 会以当前线上 stock 为新基线重建并刷新 .orig 备份；
  # 只有检测本身失败（status=error，如 asar 缺失）才拒绝。
  case "$status" in
    patched|already) ;;
    overwritten-by-update) echo "  客户端自动更新已覆盖补丁：以当前线上 stock 为新基线重打。" ;;
    unpatched)            echo "  未打补丁的原版 stock：按新基线安装。" ;;
    *) echo "  基线检测异常（status=$status）：拒绝继续。" >&2; exit 3 ;;
  esac
}

build() {
  say "2/5 构建产物（不落盘）"
  # QUM_SUDO=/bin/false 让安装器在提权那一步必然失败 → 只构建 + 写 pending-install.json + 退出码 2。
  # QUM_ALLOW_RUNNING=1：本模式只构建不落盘，放行"客户端在跑"的落盘闸门（闸门在落盘前）。
  local rc=0
  QUM_ALLOW_RUNNING=1 QUM_SUDO=/bin/false node scripts/install.mjs --force || rc=$?
  if [ "$rc" != "2" ]; then
    echo "  构建未按预期停在提权步骤（exit=$rc），请查看上面输出。" >&2
    exit "$rc"
  fi
  local new pend
  new=$(sha256sum "$HOME/.qoder-monitor/build/app.asar.new" | cut -c1-64)
  pend=$(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.qoder-monitor/pending-install.json")))["sha256New"])')
  [ "$new" = "$pend" ] || { echo "  产物指纹与 pending-install.json 不符，中止。" >&2; exit 4; }
  echo "  产物就绪 sha256=${new:0:16}…  ($(stat -c%s "$HOME/.qoder-monitor/build/app.asar.new") B)"
}

elevate_install() {
  say "3/5 提权落盘（需要你在终端输入 sudo 密码）"
  if [ ! -t 0 ]; then
    echo "  拒绝：本模式必须有真人在 tty 前确认（agent 不能代跑提权）。" >&2
    exit 5
  fi
  require_client_closed
  echo "  目标：/opt/Qoder-CN/resources/app.asar（0.4.9 起的新目录；旧 /opt/Qoder CN 由 asarPaths 自动回退；原始备份在 ~/.qoder-monitor/backup/app.asar.orig，不覆盖）"
  read -r -p "  确认落盘？[y/N] " ans
  [ "$ans" = "y" ] || [ "$ans" = "Y" ] || { echo "  已取消。"; exit 6; }
  # 安装器自带的 elevate：QUM_SUDO=sudo → 走 sudo 缓存，通常只问一次密码。
  QUM_SUDO=sudo node scripts/install.mjs --force
}

finish_daemon() {
  say "4/5 刷新 daemon（旧进程持旧代码，必须先精确清理再拉起）"
  pkill -f "server\.mjs.*--port $PORT" || true
  sleep 1
  # 两条合法路径：① 提权失败过 → 有 pending-install.json，用 --finish 补写状态（它内部会 ensure 起 daemon）；
  # ② 提权安装当场成功 → 安装器已自己写完 patch-state 并清掉 pending，此时 --finish 会报
  #    "没有待完成的安装"（真机踩过），只需 --ensure 把新代码的 daemon 起来。
  if [ -f "$HOME/.qoder-monitor/pending-install.json" ]; then
    node scripts/install.mjs --finish
  else
    node daemon/server.mjs --ensure --port "$PORT"
  fi
  echo "  等新 daemon 完成首轮全量扫描…"
  sleep 12
}

verify() {
  say "5/5 生产对账 + 自检"
  local sid attempt=1 rc=1 prev="" cur=""
  sid=$(curl -s -H "X-QM-Token: $(cat "$HOME/.qoder-monitor/daemon.token")" "http://127.0.0.1:$PORT/state" \
    | python3 -c 'import json,sys;print(json.load(sys.stdin)["local"]["session"]["id"])')
  # 本工具监控的常常就是"当前正在跑的会话"：daemon 快照最多滞后一个扫描周期（30s），
  # 而脚本读的是实时日志 → 进行中回合会让两边差一点。重试最多 3 次；
  # 差异在变 = 漂移（等回合结束再跑），差异恒定 = 真不一致（必须查）。绝不静默判绿。
  while [ "$attempt" -le 3 ]; do
    rc=0
    node scripts/verify-p2.mjs > /tmp/qum-verify-a.txt 2>&1 || rc=$?
    [ "$rc" = 0 ] && node scripts/verify-p2.mjs --session "$sid" > /tmp/qum-verify-b.txt 2>&1 || rc=$?
    if [ "$rc" = 0 ]; then
      grep -E "对账 [0-9]+/[0-9]+ 通过|对账通过" /tmp/qum-verify-a.txt | tail -1
      grep -E "对账 [0-9]+/[0-9]+ 通过|对账通过" /tmp/qum-verify-b.txt | tail -1
      break
    fi
    cur=$(grep '✗' /tmp/qum-verify-a.txt /tmp/qum-verify-b.txt || true)
    echo "  第 $attempt 次对账有差异："
    printf '%s\n' "$cur" | sed 's/^/    /'
    prev="$cur"
    attempt=$((attempt+1))
    [ "$attempt" -le 3 ] && { echo "  差异值在变（疑似进行中回合造成），20s 后重试…"; sleep 20; }
  done
  if [ "$rc" != 0 ]; then
    echo "  三次重试仍有差异：若客户端当时确有进行中回合，等回合结束再跑 --verify；否则按真不一致处理。" >&2
    exit 7
  fi
  node scripts/doctor.mjs || {
    echo "  doctor 非 0：若只有 account 一项 warn，是 daemon 刚重启、等 widget 下一次 bridge POST（≤60s）即回填，稍后重跑本模式即可。" >&2
    exit 8
  }
}

case "$MODE" in
  --build)  check_update; build; echo; echo "下一步（你本人执行）：先退出 Qoder，再 bash scripts/deploy.sh --install" ;;
  --install) require_client_closed; elevate_install; finish_daemon; verify; echo; echo "最后一步由你择机：重新打开 Qoder 客户端（落盘时它已关闭，不会再出现「打不开」）。" ;;
  --finish) finish_daemon ;;
  --verify) verify ;;
  all) require_client_closed; check_update; build; elevate_install; finish_daemon; verify
       echo; echo "补丁已落盘（落盘期间客户端是关闭状态）。现在重新打开 Qoder 即可生效。" ;;
  *) echo "用法: bash scripts/deploy.sh [--build|--install|--finish|--verify]" >&2; exit 2 ;;
esac
