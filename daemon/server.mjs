#!/usr/bin/env node
// daemon/server.mjs
// Qoder Usage Monitor — 本地 HTTP daemon：扫描 session 日志 → 聚合 → state.json → 供 widget 消费。
// 仅绑定 127.0.0.1；token/bootstrap 双轨鉴权；CORS 全开（本机回环上的 webview 需要）。
//
// CLI：node daemon/server.mjs [--port 49789] [--ensure] [--qm-role=qum-daemon]
//   --ensure  ：单例拉起——/health 活着(2s) → "already-running"；否则 detached spawn 自身并等就绪。
//   --qm-role ：运维 keepalive 标记（ops 工具 grep 进程用），本程序接受并忽略。

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseJsonObject, runtimeConfigOf, aggregate, dailyRows, sessionStats, sessionsSummary, lastTurnOf, byModelWindowOf, lastTurnOfSession, sessionStatsFor, pulseOf, turnSpeedsOf, FALLBACK_CONTEXT_WINDOW } from './scanner.mjs';
import { estBreakdownOfContent, parseTimingLine } from './est.mjs';
import { pickQuotaFields, pickHeatmap, pickMetrics, resolveModelName, trimModelCatalog } from './quotaPick.mjs';
import {
  home, atomicWrite, loadHistory, saveHistory, mergeDaily,
  loadScanCache, saveScanCache, loadTimingCache, saveTimingCache, readToken, writeToken, loadBootstrap, saveBootstrap,
} from './store.mjs';

const VERSION = '0.1.0';
const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF), '..');
const SCAN_INTERVAL_MS = 30_000;
const QUOTA_SNAPSHOT_GAP_MS = 3600e3; // quota-history.jsonl 小时级节流
const HISTORY_ROWS_KEPT = 90; // state.local.history 仅暴露最近 90 行
const MAX_BODY_BYTES = 1 << 20; // ingest body 上限 1MB，防意外大包
// dev-live（仓库 app/ 热更 + harness 验收页 + /dev/manifest）只在显式 QUM_DEV=1 时开放。
// 生产安装的 daemon 不带此变量 → 三条路由一律 404，不向本机任意进程暴露仓库路径与源码。
const DEV_MODE = process.env.QUM_DEV === '1';

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const out = { port: 49789, ensure: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a.startsWith('--port=')) out.port = Number(a.slice('--port='.length));
    else if (a === '--ensure') out.ensure = true;
    // 其余（含 --qm-role=...）静默忽略
  }
  if (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535) {
    console.error(`qum-daemon: invalid --port ${String(out.port)}`);
    process.exit(2);
  }
  return out;
}

async function probeHealth(port, timeoutMs) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    const j = await res.json().catch(() => null);
    return !!(j && j.ok === true);
  } catch {
    return false;
  }
}

/**
 * runEnsure 拉起子进程的命令行：[自身, --port, 端口, ...透传标志]。
 * T7 carry-in：旧实现只回传 --port，丢掉 --qm-role=qum-daemon keepalive 标记，
 * 重生的 daemon 对 `pkill -f qum-daemon` 隐身。规则：剔除 --ensure（防递归 ensure 流程）
 * 与 --port 及其值（已由参数重给），其余标志（含未知标志如 --qm-role=…）原样透传。
 * 导出供测试直接断言 argv（不真 spawn）。
 */
export function respawnArgs(port, ownArgv) {
  const out = [SELF, '--port', String(port)];
  const argv = Array.isArray(ownArgv) ? ownArgv : [];
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (a === '--ensure') continue;
    if (a === '--port') { i++; continue; } // 跳过其值
    if (a.startsWith('--port=')) continue;
    out.push(a);
  }
  return out;
}

/** --ensure：活着→already-running；死了→detached 拉起自身，轮询 /health ≤10s。 */
async function runEnsure(port) {
  if (await probeHealth(port, 2000)) {
    console.log('already-running');
    process.exit(0);
  }
  const child = spawn(process.execPath, respawnArgs(port, process.argv.slice(2)), {
    detached: true, stdio: 'ignore', env: process.env, cwd: REPO_ROOT,
  });
  child.unref();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    if (await probeHealth(port, 1000)) {
      console.log(`started pid=${child.pid} port=${port}`);
      process.exit(0);
    }
  }
  console.error(`qum-daemon: failed to become healthy on port ${port} within 10s`);
  process.exit(1);
}

// ---------------------------------------------------------------- auth

function initAuth() {
  let boot = loadBootstrap();
  if (!boot) {
    const code = crypto.randomBytes(8).toString('hex'); // 16 hex chars
    saveBootstrap(code);
    boot = { code };
  }
  const token = readToken() || writeToken();
  return { bootCode: boot.code, token };
}

/** 常数时间字符串比较（长度不同直接 false——长度非秘密）。 */
function safeEq(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// ---------------------------------------------------------------- scan loop

function projectsRoot() {
  return process.env.QUM_PROJECTS_DIR || path.join(os.homedir(), '.qoder-cn', 'projects');
}

/**
 * qodercli.log 根目录（T16 实测纯模型秒的数据源）：QUM_LOGS_DIR ?? projects 根的同级 logs/。
 * 真机布局 projectsRoot=~/.qoder-cn/projects → ~/.qoder-cn/logs/{runs/<run>/qodercli.log, latest/…}；
 * 测试把 QUM_PROJECTS_DIR 指进 fixture 时同级无 logs → 静默空集（hermetic，不读真机日志）。
 */
function logsRoot() {
  return process.env.QUM_LOGS_DIR || path.join(path.dirname(projectsRoot()), 'logs');
}

/** 计时日志清单：root/runs/<run>/qodercli.log + root/latest/qodercli.log（缺失文件由调用方 stat 跳过）。 */
function listTimingFiles(root) {
  const out = [];
  try {
    for (const d of fs.readdirSync(path.join(root, 'runs'), { withFileTypes: true })) {
      if (d.isDirectory()) out.push(path.join(root, 'runs', d.name, 'qodercli.log'));
    }
  } catch { /* 无 runs 目录 → 只试 latest */ }
  out.push(path.join(root, 'latest', 'qodercli.log'));
  return out;
}

/**
 * 收集待扫文件：递归遍历 root 下全部 *.jsonl。
 * 真实布局是 projects/[ws]/[session].jsonl，另有 projects/[ws]/[session]/subagents/*.jsonl
 * （子代理转录，usage 独立于父会话、uuid 无重叠）——只扫一/两层会漏掉这部分真实用量。
 * 顶层文件也纳入以兼容扁平布局与测试 fixture；根目录缺失 → []。
 */
function listJsonlFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of entries) {
      const full = path.join(dir, d.name);
      if (d.isFile()) {
        if (d.name.endsWith('.jsonl')) out.push(full);
      } else if (d.isDirectory()) {
        walk(full);
      }
    }
  };
  walk(root);
  return out;
}

/**
 * 全读一个文件 → {records, windows, toolSpans, toolEvents}（单次 JSON.parse 四用途，scan-cache v4 条目形状）：
 *  - records：assistant 记录（缺 uuid 用 file:lineIndex 补，scanner 约定）；
 *  - windows：runtime-config 真值 [{sessionId, contextWindow, model, ts}]（同文件顺位追加，
 *    扫描层按 ts 裁决"同会话最新者胜"）；
 *  - toolSpans：T16 轮级兜底工具区间 [{sid, start, end}]——assistant 行的 tool_use 块 ts（= 该行
 *    timestamp，工具起点）配对同文件 user 行 tool_result 块 ts（工具终点），仅存合法区间。
 *  - toolEvents（v4，原生样式数据面）：[{sid, ts, name, err, add, del, file}]——tool_use 块按
 *    block id 去重（同块重复写入只计一次），tool_result.is_error → err；Edit/Write/MultiEdit
 *    另记 add/del 行数（lineCount(new) / lineCount(old)；Bash 改文件不可重建 → 不计）与 file。
 * T16 整消息估算归并：同一 message.id 多行写入各带不同块（真机 2/3 行为主），第一遍把全部行的
 * estBreakdownOfContent 按 message.id 累加，第二遍把合计覆盖到**带 usage 的那一行**的
 * outEst/outEstThk/outEstTxt/outEstCall——逐块累加安全且不重复计账；无 usage 行的消息不产记录
 * （其 est 不计，占真机 ≈4%：中断/嵌套回放条目）。
 * scan-cache 升级前旧条目无本形状（v4 版本门已作废），消费侧按字段缺席容忍。
 */
function lineCount(s) {
  if (typeof s !== 'string' || !s) return 0;
  return s.split('\n').length;
}

/** 编辑类工具入参 → 行数增减 + 文件（非编辑工具 → 全 0/null；绝不抛）。 */
function editDeltaOf(name, input) {
  const none = { add: 0, del: 0, file: null };
  if (!input || typeof input !== 'object') return none;
  const file = typeof input.file_path === 'string' && input.file_path ? input.file_path : null;
  if (name === 'Edit') return { add: lineCount(input.new_string), del: lineCount(input.old_string), file };
  if (name === 'Write') return { add: lineCount(input.content), del: 0, file };
  if (name === 'MultiEdit') {
    let add = 0;
    let del = 0;
    if (Array.isArray(input.edits)) {
      for (const e of input.edits) {
        if (!e || typeof e !== 'object') continue;
        add += lineCount(e.new_string);
        del += lineCount(e.old_string);
      }
    }
    return { add, del, file };
  }
  return none;
}

function readRecords(file) {
  const text = fs.readFileSync(file, 'utf8');
  const records = [];
  const windows = [];
  const spans = [];
  const mids = [];             // 与 records 对齐的 message.id（null = 不参与归并）
  const estByMsg = new Map();  // message.id → {thk, txt, call}（全部行合计）
  const toolStart = new Map(); // tool_use 块 id → assistant 行 ts（工具区间起点）
  const toolsById = new Map(); // tool_use 块 id → toolEvent（按 id 去重）
  const toolOrder = [];        // 首次出现顺序（输出稳定）
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    let o;
    try {
      o = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (o && typeof o === 'object') {
      if (o.type === 'assistant') {
        const m = o.message;
        if (m && typeof m === 'object' && m.model !== '<synthetic>' && typeof m.id === 'string') {
          // <synthetic> 伪条目不参与估算（scanner 同规跳过）
          const e = estBreakdownOfContent(m.content);
          const cur = estByMsg.get(m.id) || { thk: 0, txt: 0, call: 0 };
          cur.thk += e.thk;
          cur.txt += e.txt;
          cur.call += e.call;
          estByMsg.set(m.id, cur);
        }
        if (m && Array.isArray(m.content)) {
          const ts = Date.parse(o.timestamp);
          if (Number.isFinite(ts)) {
            const sid = typeof o.sessionId === 'string' ? o.sessionId : null;
            for (let j = 0; j < m.content.length; j++) {
              const b = m.content[j];
              if (b && b.type === 'tool_use' && typeof b.id === 'string') {
                toolStart.set(b.id, ts);
                if (!toolsById.has(b.id)) {
                  const name = typeof b.name === 'string' && b.name ? b.name : null;
                  const d = editDeltaOf(name, b.input);
                  toolsById.set(b.id, { sid, ts, name, err: false, add: d.add, del: d.del, file: d.file, endTs: null });
                  toolOrder.push(b.id);
                }
              }
            }
          }
        }
      } else if (o.type === 'user' && o.message && Array.isArray(o.message.content)) {
        const ts = Date.parse(o.timestamp);
        if (Number.isFinite(ts)) {
          for (const b of o.message.content) {
            if (b && b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
              const s = toolStart.get(b.tool_use_id);
              if (Number.isFinite(s) && ts >= s) {
                spans.push({ sid: typeof o.sessionId === 'string' ? o.sessionId : null, start: s, end: ts });
              }
              const t = toolsById.get(b.tool_use_id);
              if (t) {
                t.endTs = ts;
                if (b.is_error === true) t.err = true;
              }
            }
          }
        }
      }
    }
    const r = parseJsonObject(o);
    if (r) {
      if (!r.uuid) r.uuid = `${file}:${i}`;
      records.push(r);
      mids.push(r.kind === undefined && o.message && typeof o.message.id === 'string' ? o.message.id : null);
      continue;
    }
    const rc = runtimeConfigOf(o);
    if (rc && rc.sessionId) {
      windows.push({ sessionId: rc.sessionId, contextWindow: rc.contextWindow, model: rc.model, ts: rc.ts });
    }
  }
  // T16 整消息估算归并（文件读完后 estByMsg 才完整；三段与合计同步落记录）
  for (let k = 0; k < records.length; k++) {
    const mid = mids[k];
    if (mid == null) continue;
    const v = estByMsg.get(mid);
    if (v) {
      records[k].outEst = v.thk + v.txt + v.call;
      records[k].outEstThk = v.thk;
      records[k].outEstTxt = v.txt;
      records[k].outEstCall = v.call;
    }
  }
  const toolEvents = toolOrder.map((id) => toolsById.get(id));
  return { records, windows, toolSpans: spans, toolEvents };
}

/** 清扫 daemon 目录顶层残留的原子写临时文件（.xxx.tmp；上次崩溃遗留）。 */
function sweepTmpFiles() {
  const dir = home();
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) {
    if (/^\..*\.tmp$/.test(n)) {
      try { fs.rmSync(path.join(dir, n), { force: true }); } catch { /* 尽力而为 */ }
    }
  }
}

class Daemon {
  constructor(auth) {
    this.auth = auth;
    this.cache = loadScanCache();
    this.account = null; // 上次 ingest 的账户快照（跨扫描周期保留）
    this.state = emptyState();
    // T14：模型目录（widget 第 5 桥 listChatComposerModels 经 ingest 送入）。{fetchedAt, entries:trimmed}；
    // 缺席/未 ingest → {fetchedAt:null, entries:[]}。publish 时并入 state 并用于解析 session/sessions 模型名。
    this.modelCatalog = { fetchedAt: null, entries: [] };
    // P3：请求态按会话聚合的数据源——scan 留下的内存池 + 代际（memo 失效依据）。绝不落盘。
    this.pool = null;
    this.activeMemo = null;
    // T16：qodercli.log 计时配对（rid → [start|null, end|null]）与转录工具区间（轮级兜底分母）。
    this.timing = {};
    this.spans = [];
  }

  /**
   * T16：qodercli.log 计时增量扫描（offset 缓存，追加式只读新增段）——model.request.started →
   * model.response.completed 按 request_id 归并为 [start, end] 区间（双侧齐备才可注入记录；
   * 同 rid 多行取 min start / max end，latest 与 runs 重复副本自然幂等）。size < pos 视为整文件
   * 重写 → 归零重读；半行（无换行结尾）留待下次；pairs 超 60000 按最新 50000 修剪。
   * 结果 this.timing 落盘 timing-cache.json；logsRoot 不存在 → 静默空集（测试 hermetic）。
   */
  scanTiming() {
    const cache = loadTimingCache();
    let changed = false;
    for (const file of listTimingFiles(logsRoot())) {
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      const prev = cache.files[file] && Number.isFinite(cache.files[file].pos) ? cache.files[file].pos : 0;
      const pos = st.size < prev ? 0 : prev;
      if (st.size <= pos) continue;
      const len = st.size - pos;
      const buf = Buffer.allocUnsafe(len);
      let read = 0;
      let fd;
      try {
        fd = fs.openSync(file, 'r');
        read = fs.readSync(fd, buf, 0, len, pos);
      } catch {
        continue;
      } finally {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* 尽力关闭 */ } }
      }
      const text = buf.subarray(0, read).toString('utf8');
      const lastNl = text.lastIndexOf('\n');
      if (lastNl < 0) continue; // 尚无完整行（末尾半行下次续读，pos 停在行边界）
      const usable = text.slice(0, lastNl + 1);
      for (const ln of usable.split('\n')) {
        if (ln.indexOf('model.request.') < 0 && ln.indexOf('model.response.') < 0) continue;
        const ev = parseTimingLine(ln);
        if (!ev) continue;
        let p = cache.pairs[ev.rid];
        if (!p) { p = [null, null]; cache.pairs[ev.rid] = p; }
        if (ev.kind === 'start') p[0] = p[0] === null ? ev.ts : Math.min(p[0], ev.ts);
        else p[1] = p[1] === null ? ev.ts : Math.max(p[1], ev.ts);
        changed = true;
      }
      cache.files[file] = { pos: pos + Buffer.byteLength(usable, 'utf8') };
      changed = true;
    }
    const ids = Object.keys(cache.pairs);
    if (ids.length > 60000) {
      const ts = (id) => cache.pairs[id][1] ?? cache.pairs[id][0] ?? 0;
      ids.sort((a, b) => ts(b) - ts(a));
      for (const id of ids.slice(50000)) { delete cache.pairs[id]; changed = true; }
    }
    if (changed) saveTimingCache(cache);
    this.timing = cache.pairs;
  }

  /** 单轮扫描：mtime+size 命中缓存则复用记录，否则全读重解析；产出并落盘 state。T16：先扫日志计时。 */
  scan() {
    this.scanTiming(); // T16：最新 qodercli.log 配对先进表，随后注入本轮记录
    const scanErrors = [];
    const files = listJsonlFiles(projectsRoot());
    const seen = new Set();
    for (const file of files) {
      seen.add(file);
      let st;
      try { st = fs.statSync(file); } catch (e) {
        scanErrors.push({ file, error: String((e && e.message) || e) });
        continue;
      }
      const entry = this.cache.files[file];
      const fresh = entry && entry.size === st.size && entry.mtimeMs === st.mtimeMs && Array.isArray(entry.records);
      if (!fresh) {
        try {
          const parsed = readRecords(file);
          this.cache.files[file] = { size: st.size, mtimeMs: st.mtimeMs, records: parsed.records, windows: parsed.windows, toolSpans: parsed.toolSpans, toolEvents: parsed.toolEvents };
        } catch (e) {
          scanErrors.push({ file, error: String((e && e.message) || e) });
        }
      }
    }
    for (const p of Object.keys(this.cache.files)) if (!seen.has(p)) delete this.cache.files[p];

    const all = [];
    const spans = [];
    const toolEvents = [];
    for (const e of Object.values(this.cache.files)) {
      if (Array.isArray(e.records)) all.push(...e.records);
      if (Array.isArray(e.toolSpans)) spans.push(...e.toolSpans); // T16：轮级兜底工具区间
      if (Array.isArray(e.toolEvents)) toolEvents.push(...e.toolEvents); // v4：工具/编辑统计（无 usage 行也入池）
    }
    // T16 计时注入：request_id → 日志区间落到记录 mt0/mt1（已注入跳过；双侧缺失留空 →
    // 轮级走兜底、窗口/模型组按"仅配对记录"口径排除；记录随 scan-cache 持久，配对后到也补得上）。
    if (this.timing) {
      for (const r of all) {
        if (r.mt0 != null || !r.rid) continue;
        const p = this.timing[r.rid];
        if (p && Number.isFinite(p[0]) && Number.isFinite(p[1]) && p[1] > p[0]) {
          r.mt0 = p[0];
          r.mt1 = p[1];
        }
      }
    }
    this.spans = spans;

    // contextWindow + model 真值表（计费输入 tokens 的乘数底 + 本会话模型名）：runtime-config
    // 条目"同会话最新者胜"（ts 大者胜；null ts 视为 positional 信息，后读覆盖）。旧缓存条目缺
    // windows 字段/条目无 model → 跳过（迁移容忍：表缺项 → scanner 侧 200k 兜底 + model null）。
    const bestWin = new Map(); // sessionId → {ts, contextWindow, model}
    for (const e of Object.values(this.cache.files)) {
      if (!Array.isArray(e.windows)) continue;
      for (const w of e.windows) {
        const cur = bestWin.get(w.sessionId);
        if (!cur || cur.ts === null || w.ts === null || w.ts >= cur.ts) bestWin.set(w.sessionId, w);
      }
    }
    // ctxMeta：Map<sessionId, {contextWindow, model}>（scanner 两形态兼容：对象新形态由
    // aggregate/sessionStats/sessionsSummary 经 ctxEntry 读取；model 缺失即 null）。
    const ctxMeta = new Map();
    for (const [sid, w] of bestWin) ctxMeta.set(sid, { contextWindow: w.contextWindow, model: w.model });

    // P3：留存本轮记录池与 ctxMeta 供 activeFor 即时按会话聚合；代际 +1 使旧 memo 失效。
    // v4：toolEvents 同池（请求态 active.session 的工具/编辑统计数据源）。
    this.pool = { records: all, ctxMeta, spans, toolEvents, generation: (this.pool ? this.pool.generation : 0) + 1 };
    this.activeMemo = null;

    const now = Date.now();
    const agg = aggregate(all, now, ctxMeta); // 窗口新鲜：每次以 now 重算
    const derived = dailyRows(all);
    const history = mergeDaily(derived, loadHistory()); // 裁定 3：history 写入必过 mergeDaily
    saveHistory(history);
    saveScanCache(this.cache);
    const session = sessionStats(all, now, ctxMeta, toolEvents);
    const sessions = sessionsSummary(all, now, ctxMeta); // 会话明细（panel，用户裁定）
    const lastTurn = lastTurnOf(all, ctxMeta, spans); // P2：最新一轮（底栏五槽数据源；T16 轮级兜底分母）
    const byModelWindow = byModelWindowOf(all, ctxMeta, now); // P2：近 7 日/今日按模型窗口
    // local.contextWindow {value, source}（UI ≈ 判定数据源）：当前会话命中 runtime-config 真值
    // → 该值；表缺项/值为 null（本机 qfmodel 实况）→ 200k 兜底并标 'fallback200k'。
    const cur = session.id !== null ? ctxMeta.get(session.id) : null;
    const cw = cur ? cur.contextWindow : undefined;
    const contextWindow = typeof cw === 'number' && Number.isFinite(cw) && cw > 0
      ? { value: cw, source: 'runtime-config' }
      : { value: FALLBACK_CONTEXT_WINDOW, source: 'fallback200k' };
    // state.local 形状（widget/测试对账口径）：{window5h, week, today, history, session,
    // contextWindow, sessions}——session = sessionStats（本会 credits + 近30分钟速率 + billedInput +
    // avgTurnSec + model + tps30/outTps30）；sessions = sessionsSummary（≤10 会话明细）；windows 的
    // billedInput/billedInputSource 由 aggregate 原样透传（无字段白名单）。
    this.publish({
      meta: { generatedAt: now, daemonVersion: VERSION, scanErrors },
      local: {
        window5h: agg.window5h, week: agg.week, today: agg.today,
        history: history.slice(-HISTORY_ROWS_KEPT), session, contextWindow, sessions,
        lastTurn, byModelWindow,
      },
      account: this.account,
      external: null,
    });
  }

  /**
   * 更新内存 state 并落盘快照（GET /state 只回内存，不读盘）。
   * T14：发布前统一注入模型目录信息——state.modelCatalog（顶层 {fetchedAt,entries}，供 doctor/debug
   * 与前端 byok 标注）、state.local.modelCatalogMeta {count,fetchedAt}，并按目录把会话的原始 model
   * id 解析为 local.session.modelName / local.sessions[].modelName（未解析 → null，呈现层回落）。
   * 该增强每次 publish 重算，故 ingest 送入新目录后立即生效，无需等下一轮 scan。
   */
  publish(state) {
    this.state = this.decorate(state);
    atomicWrite(path.join(home(), 'state.json'), JSON.stringify(this.state));
  }

  /** 见 publish 注：把 this.modelCatalog 解析结果并入 state（纯函数，返回新对象，绝不抛）。 */
  decorate(state) {
    const catalog = this.modelCatalog;
    const entries = catalog && Array.isArray(catalog.entries) ? catalog.entries : [];
    const local = state && state.local && typeof state.local === 'object' ? state.local : {};
    const next = {
      ...local,
      modelCatalogMeta: { count: entries.length, fetchedAt: catalog ? catalog.fetchedAt : null },
    };
    if (next.session && typeof next.session === 'object') {
      next.session = { ...next.session, modelName: resolveModelName(next.session.model, entries) };
    }
    if (Array.isArray(next.sessions)) {
      next.sessions = next.sessions.map((s) => (s && typeof s === 'object'
        ? { ...s, modelName: resolveModelName(s.model, entries) } : s));
    }
    // P2：byModel 族四新字段的 modelName 贯通（scanner 层恒 null，此处按目录解析；
    // 纯函数式——next.session/next.sessions 已是新对象，操作 next 而非入参 local）。
    const resolveByModelRows = (rows) => (rows || []).map((m) => ({ ...m, modelName: resolveModelName(m.model, entries) }));
    if (next.lastTurn && typeof next.lastTurn === 'object') {
      next.lastTurn = { ...next.lastTurn, modelName: resolveModelName(next.lastTurn.model, entries) };
    }
    if (next.session && Array.isArray(next.session.byModel)) {
      next.session = { ...next.session, byModel: resolveByModelRows(next.session.byModel) };
    }
    if (Array.isArray(next.sessions)) {
      next.sessions = next.sessions.map((s) => (s && typeof s === 'object' && Array.isArray(s.byModel))
        ? { ...s, byModel: resolveByModelRows(s.byModel) } : s);
    }
    if (next.byModelWindow && Array.isArray(next.byModelWindow.rows)) {
      next.byModelWindow = { ...next.byModelWindow, rows: resolveByModelRows(next.byModelWindow.rows) };
    }
    // P3：请求态 active 的 modelName 解析（buildActive 已解析一次；decorate 再跑一遍是幂等的，
    // 因为解析依据始终是原始 model 字段，modelName 独立存放）。
    if (next.active && typeof next.active === 'object') {
      const a = { ...next.active };
      if (a.lastTurn && typeof a.lastTurn === 'object') {
        a.lastTurn = { ...a.lastTurn, modelName: resolveModelName(a.lastTurn.model, entries) };
      }
      if (a.session && typeof a.session === 'object') {
        a.session = { ...a.session, modelName: resolveModelName(a.session.model, entries) };
        if (Array.isArray(a.session.byModel)) a.session = { ...a.session, byModel: resolveByModelRows(a.session.byModel) };
      }
      if (a.turnSpeeds && typeof a.turnSpeeds === 'object' && Array.isArray(a.turnSpeeds.rows)) {
        a.turnSpeeds = { ...a.turnSpeeds, rows: resolveByModelRows(a.turnSpeeds.rows) };
      }
      next.active = a;
    }
    // 计费口径（用户裁定"只跟随当前会话口径"）：当前会话记录的 billingMode 即全局呈现口径；
    // 无会话/旧缓存推不出（null）→ 回落 'credits'（= 历史行为，内置模型主路径不受影响）。
    next.billingMode = next.session && next.session.billingMode === 'tokens' ? 'tokens' : 'credits';
    return { ...state, modelCatalog: catalog, local: next };
  }

  /**
   * P3：按会话取请求态 active（spec §5.2）。单槽 memo：同一扫描代 + 同一 sid 只算一次
   * （widget 每次轮询都带同一 sid，避免每 10s/30s 重算）。跨扫描代自动失效。
   * 池未就绪（首轮 scan 前）→ null，调用方按「未提供身份」处理。
   */
  activeFor(sid) {
    if (typeof sid !== 'string' || !sid) return null;
    if (!this.pool) return null;
    const key = `${this.pool.generation}|${sid}`;
    if (this.activeMemo && this.activeMemo.key === key) return this.activeMemo.value;
    const active = buildActive(this.pool, sid, Date.now(), this.modelCatalog && this.modelCatalog.entries);
    this.activeMemo = { key, value: active };
    return active;
  }

  /** P3：带请求态 active 的响应态（decorate 复用以解析 active 的 modelName；不写盘、不改 this.state）。 */
  stateWithActive(sid) {
    const active = this.activeFor(sid);
    if (active === null) return this.state; // 池未就绪 → 与不带参数同形（widget 走硬暴露）
    return this.decorate({ ...this.state, local: { ...this.state.local, active } });
  }

  /**
   * POST /ingest/quota：raw 原样入内存+state.json，pickQuotaFields 解析字段并列其上
   * （packs/planRem/packRem/nextRefresh，解析失败仅存 raw 语义由 quotaPick 的 null 承担）；
   * T13：bridge 四源后 body = {usage,plan,heatmap,metrics}——heatmap/metrics 各自经
   * pickHeatmap/pickMetrics 归一为 account.heatmap / account.metrics（壳缺席或形状不合 →
   * null，旧 {usage,plan} 扁平体完全兼容）。两壳同样原样保留在 raw 内（校准用）。
   * T14：body 额外携带 `models`（widget 第 5 桥 listChatComposerModels 的模型目录数组）——
   * trimModelCatalog 瘦身（四字段、封顶 300）后存 this.modelCatalog（publish 时并入 state），
   * 并**从 raw 剥离**（quota-history/state.json 尺寸保护：目录不进 raw 快照）；非数组 → 忽略
   * （保留上一份 last-good 目录，绝不清空）。
   * 小时节流追加 quota-history.jsonl。fs 写盘（EACCES/ENOSPC/EISDIR…）异常一律向上抛，
   * 由 handler 捕获回 500——绝不 let 它变成 unhandled rejection 打死 daemon（T4 carry-in）。
   * 先追加 history 再 publish：失败时二者都未落盘，不留半成品状态。
   */
  ingestQuota(body) {
    const fetchedAt = Date.now();
    const obj = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
    // 目录剥离：raw 不含 models（尺寸）；目录单独 trim 存 this.modelCatalog。
    let raw = obj;
    if (obj && 'models' in obj) {
      const { models: modelsRaw, ...rest } = obj;
      raw = rest;
      if (Array.isArray(modelsRaw)) this.modelCatalog = { fetchedAt, entries: trimModelCatalog(modelsRaw) };
    }
    // P3 排障通道：widget 回报的活动会话诊断（sid/命中级别/pane 计数）从 raw 剥离，单独落
    // debug.json（0600，atomicWrite 保证）——不进 state.json 也不进 quota-history.jsonl。
    if (obj && 'debug' in obj) {
      const { debug, ...rest } = raw === obj ? obj : raw;
      raw = rest;
      if (debug && typeof debug === 'object' && !Array.isArray(debug)) {
        atomicWrite(path.join(home(), 'debug.json'), JSON.stringify({ ts: fetchedAt, ...debug }));
      }
    }
    const parsed = pickQuotaFields(raw);
    const heatmap = pickHeatmap(obj ? obj.heatmap : null);
    const metrics = pickMetrics(obj ? obj.metrics : null);
    const qp = path.join(home(), 'quota-history.jsonl');
    const lastTs = lastSnapshotTs(qp);
    if (lastTs === null || fetchedAt - lastTs > QUOTA_SNAPSHOT_GAP_MS) {
      appendPrivateLine(qp, JSON.stringify({ ts: fetchedAt, raw }) + '\n');
    }
    this.account = { source: 'widget', fetchedAt, raw, ...parsed, heatmap, metrics };
    this.publish({ ...this.state, account: this.account });
  }
}

/**
 * P3：请求态「当前活动会话」聚合（spec §5.2）。纯函数、绝不抛、绝不写盘。
 * 返回 null = 「未提供会话身份」→ 调用方**不加** local.active 字段（P2 行为逐字节不变）；
 * 返回 {sessionId, lastTurn:null, session:null} = 「该会话无记录」→ 呈现层出空态。
 * modelName 在此就地解析（与 publish/decorate 同规：resolveModelName(原始 model, 目录)），
 * 请求态不走 publish，故不能依赖 decorate 的批处理。
 */
export function buildActive(pool, sessionId, now, entries) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  const records = pool && Array.isArray(pool.records) ? pool.records : [];
  const ctxMeta = pool && pool.ctxMeta instanceof Map ? pool.ctxMeta : new Map();
  const spans = pool && Array.isArray(pool.spans) ? pool.spans : undefined; // T16：轮级兜底工具区间
  const toolEvents = pool && Array.isArray(pool.toolEvents) ? pool.toolEvents : undefined; // v4：工具/编辑统计
  const cat = Array.isArray(entries) ? entries : [];
  const name = (m) => resolveModelName(m, cat);
  const lastTurn = lastTurnOfSession(records, ctxMeta, sessionId, spans);
  const stats = sessionStatsFor(records, now, ctxMeta, sessionId, toolEvents);
  const withNames = (o) => {
    if (!o || typeof o !== 'object') return null;
    const next = { ...o, modelName: name(o.model) };
    if (Array.isArray(o.byModel)) next.byModel = o.byModel.map((r) => ({ ...r, modelName: name(r.model) }));
    return next;
  };
  // 2026-10-30：面板波形 + 逐轮生成速度（请求时算，绝不落盘）。
  // 会话无记录（stats null）时两者同为空态——无会话就没有"本会话"的波形/轮速可谈。
  const pulse = stats === null ? null : pulseOf(records, sessionId, now);
  const speeds = stats === null ? null : turnSpeedsOf(records, sessionId);
  const turnSpeeds = speeds === null ? null : { ...speeds, rows: speeds.rows.map((r) => ({ ...r, modelName: name(r.model) })) };
  return { sessionId, lastTurn: withNames(lastTurn), session: withNames(stats), pulse, turnSpeeds };
}

export function emptyState() {
  return {
    meta: { generatedAt: 0, daemonVersion: VERSION, scanErrors: [] },
    // local.session：首轮 scan() 前无会话统计（widget 侧对 null 防御出 '--'/暂无数据）；
    // local.sessions：会话明细空表（widget 侧 .qum-line 行集为空 → 出「暂无数据」）。
    // local.modelCatalogMeta：模型目录摘要（count/fetchedAt；T14，publish 会按 this.modelCatalog 重算）。
    // P2：lastTurn 首轮 scan 前无轮数据（widget 出「暂无回合数据」）；byModelWindow 空窗口形状。
    local: { window5h: null, week: null, today: null, history: [], session: null, contextWindow: null, sessions: [], modelCatalogMeta: { count: 0, fetchedAt: null }, billingMode: 'credits', lastTurn: null, byModelWindow: { windowStart: null, todayStart: null, rows: [] } },
    account: null,
    external: null,
    // T14：模型目录顶层（{fetchedAt,entries}；publish 时以 this.modelCatalog 覆盖）
    modelCatalog: { fetchedAt: null, entries: [] },
  };
}

/**
 * 敏感追加写（quota-history.jsonl 承载账户 raw，项目红线：QUM_HOME 内含 raw 的文件恒 0600）。
 * appendFileSync 的 mode 只作用于新建且受 umask 影响，对已存在的宽松权限文件无效——故镜像
 * store.atomicWrite 的权限纪律：openSync('a',0600) 缺则建（umask 只会清位，不越 0600），
 * fchmodSync 对已存在文件强制收口（fd 级 chmod，无路径竞态），再写入。fs 异常（EISDIR/EACCES/
 * ENOSPC/EPERM…）向上抛，保持 T10 的 500 语义与 append-before-publish 顺序不变。
 */
function appendPrivateLine(filePath, line) {
  const fd = fs.openSync(filePath, 'a', 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, line);
  } finally {
    fs.closeSync(fd);
  }
}

function lastSnapshotTs(quotaPath) {
  let raw;
  try { raw = fs.readFileSync(quotaPath, 'utf8'); } catch { return null; }
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const o = JSON.parse(lines[i]);
      if (o && typeof o.ts === 'number') return o.ts;
    } catch { /* 跳过坏行 */ }
  }
  return null;
}

// ---------------------------------------------------------------- http

const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
};

function json(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(body);
}

function staticRoot(envVar, fallback) {
  return process.env[envVar] || path.join(REPO_ROOT, fallback);
}

/**
 * dev-live 指纹（2026-10-15「保存即生效」）：对 app/ 下参与热换的四个文件做
 * stat 级指纹（大小 + mtime），任一变化即产生新 rev。只 stat 不读内容——loader
 * 每 2s 探测一次，开销必须停在微秒级。widget.js 缺席 → {enabled:false}，loader
 * 回落 asar 内的正式产物。
 */
export function devManifest(dir) {
  const h = crypto.createHash('sha1');
  let enabled = true;
  for (const name of ['widget.js', 'modules.js', 'format.js', 'widget.css']) {
    let st = null;
    try { st = fs.statSync(path.join(dir, name)); } catch { /* 缺文件按 missing 计入指纹 */ }
    if (!st && name === 'widget.js') enabled = false;
    h.update(st ? `${name}|${st.size}|${st.mtimeMs};` : `${name}|missing;`);
  }
  if (!enabled) return { enabled: false };
  return { enabled: true, dir, rev: h.digest('hex').slice(0, 12) };
}

/**
 * 伺服 <base>/<rest>：穿越段(../)→403；resolve 越界→403；allowlist 扩展名外→404；缺文件→404。
 * 目录路径补 index.html。仅本机（Host 守卫在最外层）。
 */
function serveStatic(res, urlPath, prefix, base, allowedExts) {
  let rel;
  try { rel = decodeURIComponent(urlPath.slice(prefix.length - 1)); } // 保留前导 '/'
  catch { return json(res, 400, { error: 'bad-request' }); }
  if (rel.split('/').some((seg) => seg === '..' || seg === '.')) {
    return json(res, 403, { error: 'forbidden-path' });
  }
  if (rel.endsWith('/')) rel += 'index.html';
  const full = path.resolve(base, '.' + rel);
  if (full !== path.resolve(base) && !full.startsWith(path.resolve(base) + path.sep)) {
    return json(res, 403, { error: 'forbidden-path' });
  }
  if (allowedExts && !allowedExts.includes(path.extname(full))) return json(res, 404, { error: 'not-found' });
  let data;
  try { data = fs.readFileSync(full); } catch { return json(res, 404, { error: 'not-found' }); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function createHandler(daemon, port) {
  return async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*'); // 仅回环监听 + 无凭据 CORS
    // Task 8：widget 从补丁页（origin null）经 bootstrap 读 X-QM-Token 响应头，
    // 跨源默认不可读——必须显式 expose（bootstrap 换 token 流程的前置条件）。
    res.setHeader('Access-Control-Expose-Headers', 'X-QM-Token');
    const host = String(req.headers.host || '');
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      return json(res, 403, { error: 'forbidden-host' }); // DNS-rebinding 防护
    }
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'X-QM-Token, Content-Type');
      res.writeHead(204);
      return res.end();
    }
    const urlPath = (req.url || '/').split('?')[0];
    const query = new URL(req.url, 'http://127.0.0.1').searchParams;

    if (req.method === 'GET' && urlPath === '/health') {
      return json(res, 200, { ok: true, version: VERSION, uptimeSec: Math.round(process.uptime() * 10) / 10 });
    }

    if (req.method === 'GET' && urlPath === '/state') {
      const sid = query.get('session'); // P3：请求态「当前活动会话」；缺席 → 与 P2 完全同形
      const bodyOf = () => (sid ? daemon.stateWithActive(sid) : daemon.state);
      const headerToken = req.headers['x-qm-token'];
      if (headerToken && safeEq(headerToken, daemon.auth.token)) {
        return json(res, 200, bodyOf());
      }
      const boot = query.get('bootstrap');
      if (boot && safeEq(boot, daemon.auth.bootCode)) {
        return json(res, 200, bodyOf(), { 'X-QM-Token': daemon.auth.token }); // 一次性换 token
      }
      return json(res, 401, { error: 'unauthorized' });
    }

    if (urlPath === '/ingest/quota') {
      if (req.method !== 'POST') return json(res, 404, { error: 'not-found' });
      const headerToken = req.headers['x-qm-token'];
      if (!headerToken || !safeEq(headerToken, daemon.auth.token)) {
        return json(res, 401, { error: 'unauthorized' });
      }
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad-json' }); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'bad-body' });
      try {
        daemon.ingestQuota(body);
      } catch (e) {
        // 落盘失败（EACCES/ENOSPC 等）→ 500 JSON；daemon 存活继续服务（T4 carry-in）。
        console.error('qum-daemon: quota ingest failed:', e && e.message);
        return json(res, 500, { error: 'quota-store-failed' });
      }
      return json(res, 202, { ok: true });
    }

    // dev-live：loader 从 file:// 页面跨源探测仓库 app/ 指纹，故免 token（只暴露
    // 目录路径与 stat 指纹；Host 守卫与全局限定 127.0.0.1）。QUM_DEV=1 才挂载。
    if (DEV_MODE && req.method === 'GET' && urlPath === '/dev/manifest') {
      return json(res, 200, devManifest(staticRoot('QUM_APP_DIR', 'app')));
    }
    if (DEV_MODE && req.method === 'GET' && urlPath.startsWith('/harness/')) {
      return serveStatic(res, urlPath, '/harness/', staticRoot('QUM_HARNESS_DIR', 'tests/harness'), null);
    }
    if (DEV_MODE && req.method === 'GET' && urlPath.startsWith('/app/')) {
      return serveStatic(res, urlPath, '/app/', staticRoot('QUM_APP_DIR', 'app'), ['.js', '.css']);
    }
    return json(res, 404, { error: 'not-found' });
  };
}

// ---------------------------------------------------------------- main

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.ensure) return runEnsure(args.port);

  const daemon = new Daemon(initAuth());
  sweepTmpFiles();
  daemon.scan(); // 启动立即全量扫描：/health 就绪时 state 已可用
  const server = http.createServer(createHandler(daemon, args.port));
  server.on('error', (e) => { console.error(`qum-daemon: listen failed: ${e.message}`); process.exit(1); });
  server.listen(args.port, '127.0.0.1');
  const scanTimer = setInterval(() => {
    try { daemon.scan(); } catch (e) { console.error('qum-daemon: scan failed:', e && e.message); }
  }, SCAN_INTERVAL_MS);
  const shutdown = () => {
    clearInterval(scanTimer);
    server.closeAllConnections?.(); // keep-alive 连接不应阻塞退出
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// 仅作为脚本直接运行时启动（node daemon/server.mjs …）；被 import（tests 断言
// respawnArgs 等导出）时不副作用拉起 daemon。
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === SELF;
if (invokedDirectly) main().catch((e) => { console.error('qum-daemon: fatal:', e); process.exit(1); });
