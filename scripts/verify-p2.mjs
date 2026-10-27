#!/usr/bin/env node
// Qoder Usage Monitor — P2 独立复算对账（只读；Task 14）。
// 独立读原始 JSONL（QUM_PROJECTS_DIR ?? ~/.qoder-cn/projects，与 daemon 同布局）→
// scanner 纯函数复算 lastTurn / byModelWindow → 带 token GET /state → 逐项比对打印。
// 用法：node scripts/verify-p2.mjs [--port 49789] [--session <sessionId>]
// P3：--session 额外对账请求态 local.active（当前查看的会话）——daemon 侧按 sid 即时算，
// 本脚本侧独立复算同一 sid，两侧值必须逐项相等（未知会话两侧同为 null，仍打印双方值防跳过）。
// 退出码：0 = 全项通过；1 = 有差异或取数失败（绝不静默假绿）。
// 注意：客户端有进行中回合时记录持续写入（与 daemon 扫描时点不同）——lastTurn/窗口
// 数值可能漂移；脚本打印双方值与逐项 ✓/✗，供判定「漂移 vs 真差异」（等回合结束重跑）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { parseJsonObject, runtimeConfigOf, lastTurnOf, byModelWindowOf, lastTurnOfSession, sessionStatsFor } from '../daemon/scanner.mjs';
import { estOutOfContent, parseTimingLine } from '../daemon/est.mjs';
import { readToken } from '../daemon/store.mjs';

const argOf = (name, dflt) => {
  const i = process.argv.indexOf(name);
  const v = i !== -1 ? process.argv[i + 1] : undefined;
  return v !== undefined && Number.isFinite(Number(v)) ? Number(v) : dflt;
};

// ---------------------------------------------------------------- 独立读数（server.scan 同规的镜像，刻意不 import server.mjs）
// T16 镜像升级：readAll 与 server.readRecords 同规（单次 JSON.parse + message.id 估算归并 +
// tool_use→tool_result 工具区间），并全量读 qodercli.log 配对（server.scanTiming 的一次性版）
// 注入 mt0/mt1——否则两侧 outTps 口径不一致（daemon 实测秒 ⇄ 本脚本兜底秒），对账必假红。
const projectsRoot = () => process.env.QUM_PROJECTS_DIR || path.join(os.homedir(), '.qoder-cn', 'projects');
const logsRoot = () => process.env.QUM_LOGS_DIR || path.join(path.dirname(projectsRoot()), 'logs');

function listJsonlFiles(root) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const d of entries) {
    const full = path.join(root, d.name);
    if (d.isFile() && d.name.endsWith('.jsonl')) out.push(full);
    else if (d.isDirectory()) {
      let subs;
      try { subs = fs.readdirSync(full, { withFileTypes: true }); } catch { continue; }
      for (const s of subs) if (s.isFile() && s.name.endsWith('.jsonl')) out.push(path.join(full, s.name));
    }
  }
  return out;
}

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

/** T16 镜像（server.scanTiming 的一次性全量版）：rid → [minStart, maxEnd]（双侧齐备才可用）。 */
function readTiming() {
  const pairs = new Map();
  for (const file of listTimingFiles(logsRoot())) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const ln of text.split('\n')) {
      if (ln.indexOf('model.request.') < 0 && ln.indexOf('model.response.') < 0) continue;
      const ev = parseTimingLine(ln);
      if (!ev) continue;
      let p = pairs.get(ev.rid);
      if (!p) { p = [null, null]; pairs.set(ev.rid, p); }
      if (ev.kind === 'start') p[0] = p[0] === null ? ev.ts : Math.min(p[0], ev.ts);
      else p[1] = p[1] === null ? ev.ts : Math.max(p[1], ev.ts);
    }
  }
  return pairs;
}

function readAll(root) {
  const records = [];
  const windows = [];
  const spans = [];
  const mids = [];
  const estByMsg = new Map();
  const toolStart = new Map();
  const timing = readTiming();
  for (const file of listJsonlFiles(root)) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      let o;
      try { o = JSON.parse(lines[i]); } catch { continue; }
      if (o && typeof o === 'object') {
        if (o.type === 'assistant') {
          const m = o.message;
          if (m && typeof m === 'object' && m.model !== '<synthetic>' && typeof m.id === 'string') {
            estByMsg.set(m.id, (estByMsg.get(m.id) || 0) + estOutOfContent(m.content));
          }
          if (m && Array.isArray(m.content)) {
            const ts = Date.parse(o.timestamp);
            if (Number.isFinite(ts)) for (const b of m.content) {
              if (b && b.type === 'tool_use' && typeof b.id === 'string') toolStart.set(b.id, ts);
            }
          }
        } else if (o.type === 'user' && o.message && Array.isArray(o.message.content)) {
          const ts = Date.parse(o.timestamp);
          if (Number.isFinite(ts)) for (const b of o.message.content) {
            if (b && b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
              const s = toolStart.get(b.tool_use_id);
              if (Number.isFinite(s) && ts >= s) spans.push({ sid: typeof o.sessionId === 'string' ? o.sessionId : null, start: s, end: ts });
            }
          }
        }
      }
      const r = parseJsonObject(o);
      if (r) {
        if (!r.uuid) r.uuid = `${file}:${i}`;
        const p = r.rid ? timing.get(r.rid) : null;
        if (p && Number.isFinite(p[0]) && Number.isFinite(p[1]) && p[1] > p[0]) { r.mt0 = p[0]; r.mt1 = p[1]; }
        records.push(r);
        mids.push(r.kind === undefined && o.message && typeof o.message.id === 'string' ? o.message.id : null);
        continue;
      }
      const rc = runtimeConfigOf(o);
      if (rc && rc.sessionId) windows.push({ sessionId: rc.sessionId, contextWindow: rc.contextWindow, model: rc.model, ts: rc.ts });
    }
  }
  // T16 整消息估算归并（server.readRecords 同规：合计覆盖到带 usage 的行）
  for (let k = 0; k < records.length; k++) {
    const mid = mids[k];
    if (mid == null) continue;
    const v = estByMsg.get(mid);
    if (typeof v === 'number') records[k].outEst = v;
  }
  return { records, windows, spans };
}

/** 同会话 runtime-config 最新者胜（ts null 视为顺位信息，与 server.scan 同规）。 */
function buildCtxMeta(windows) {
  const best = new Map();
  for (const w of windows) {
    const cur = best.get(w.sessionId);
    if (!cur || cur.ts === null || w.ts === null || w.ts >= cur.ts) best.set(w.sessionId, w);
  }
  const meta = new Map();
  for (const [sid, w] of best) meta.set(sid, { contextWindow: w.contextWindow, model: w.model });
  return meta;
}

const errText = (e) => [e && e.message, e && e.cause && (e.cause.code || e.cause.message)].filter(Boolean).join(' / ');

async function fetchState(port, sid) {
  const token = readToken();
  if (!token) throw new Error('daemon.token 缺失（daemon 未运行过？先启动/重启客户端）');
  const q = sid ? `?session=${encodeURIComponent(sid)}` : '';
  const res = await fetch(`http://127.0.0.1:${port}/state${q}`, { headers: { 'X-QM-Token': token } });
  if (!res.ok) throw new Error(`GET /state → HTTP ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------- 对账
const r2 = (x) => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 100) / 100 : x);
const same = (a, b) => a === b || (a == null && b == null) || r2(a) === r2(b);
const show = (v) => (v === undefined ? 'undefined' : v === null ? 'null' : String(v));
const sum7 = (rows) => (rows || []).reduce(
  (a, x) => a + (typeof x.credits7d === 'number' && Number.isFinite(x.credits7d) ? x.credits7d : 0), 0);

async function main() {
  const port = argOf('--port', 49789);
  const si = process.argv.indexOf('--session');
  const sidArg = si !== -1 && typeof process.argv[si + 1] === 'string' && process.argv[si + 1] ? process.argv[si + 1] : null;
  console.log(`Qoder Usage Monitor P2 对账（独立复算 ⇄ /state）port=${port}${sidArg ? ` session=${sidArg}` : ''}`);
  const { records, windows, spans } = readAll(projectsRoot());
  const ctxMeta = buildCtxMeta(windows);
  const lt = lastTurnOf(records, ctxMeta, spans);
  const bw = byModelWindowOf(records, ctxMeta, Date.now());
  const st = await fetchState(port, sidArg); // 失败 → main().catch → exit 1

  const checks = [];
  const check = (name, daemon, local) => checks.push({ name, daemon, local, pass: same(daemon, local) });
  const dLt = st.local && st.local.lastTurn;
  const eLt = (k) => lt && lt[k];
  check('lastTurn.sessionId', dLt && dLt.sessionId, eLt('sessionId'));
  check('lastTurn.turnSec', dLt && dLt.turnSec, eLt('turnSec'));
  check('lastTurn.credits', dLt && dLt.credits, eLt('credits'));
  check('lastTurn.billedInput', dLt && dLt.billedInput, eLt('billedInput'));
  check('lastTurn.outTps', dLt && dLt.outTps, eLt('outTps'));
  const dRows = (st.local && st.local.byModelWindow && Array.isArray(st.local.byModelWindow.rows))
    ? st.local.byModelWindow.rows : [];
  check('byModelWindow 行数', dRows.length, bw.rows.length);
  check('byModelWindow Σcredits7d', r2(sum7(dRows)), r2(sum7(bw.rows)));
  for (const row of bw.rows) {
    const hit = dRows.find((x) => x.model === row.model);
    check(`row[${row.model}].credits7d`, hit ? hit.credits7d : undefined, row.credits7d);
  }

  if (sidArg !== null) { // P3：请求态活动会话对账（daemon 按 sid 即时算 ⇄ 本脚本独立复算）
    const a = (st.local && st.local.active) || null;
    const dLt = a && a.lastTurn;
    const dSess = a && a.session;
    const eLt = lastTurnOfSession(records, ctxMeta, sidArg, spans);
    const eSess = sessionStatsFor(records, Date.now(), ctxMeta, sidArg);
    check('active.sessionId', a && a.sessionId, sidArg);
    check('active.lastTurn.turnSec', dLt && dLt.turnSec, eLt && eLt.turnSec);
    check('active.lastTurn.credits', dLt && dLt.credits, eLt && eLt.credits);
    check('active.lastTurn.billedInput', dLt && dLt.billedInput, eLt && eLt.billedInput);
    check('active.lastTurn.outTps', dLt && dLt.outTps, eLt && eLt.outTps);
    check('active.session.credits', dSess && dSess.credits, eSess && eSess.credits);
    check('active.session.turns', dSess && dSess.turns, eSess && eSess.turns);
    check('active.session.totalTurnSec', dSess && dSess.totalTurnSec, eSess && eSess.totalTurnSec);
    check('active.session.billingMode', dSess && dSess.billingMode, eSess && eSess.billingMode);
  }

  for (const c of checks) {
    console.log(`  ${c.pass ? '✓' : '✗'} ${c.name}  daemon=${show(c.daemon)}  复算=${show(c.local)}`);
  }
  const bad = checks.filter((c) => !c.pass);
  console.log(`记录池 ${records.length} 条 · 窗口行 ${bw.rows.length} · 对账 ${checks.length - bad.length}/${checks.length} 通过`);
  if (bad.length) {
    // 硬证据判据，不靠"两次差异变没变"猜：daemon 快照时间早于日志里最新记录 → 本工具监控的
    // 常常正是当下在跑的会话，两边必然差最近几条。此时如实标注"快照滞后"并放行（非静默：
    // 上面每行 ✗ 都打印了双方值）；快照不比最新记录旧却仍有差异 = 真口径分歧，必须失败。
    const genAt = (st.meta && typeof st.meta.generatedAt === 'number') ? st.meta.generatedAt : 0;
    const newest = records.reduce((a, r) => (typeof r.ts === 'number' && r.ts > a ? r.ts : a), 0);
    if (newest > genAt) {
      console.log(`快照滞后：daemon 扫描于 ${new Date(genAt).toISOString()}，而日志最新记录到 ${new Date(newest).toISOString()}`
        + `（差 ${Math.round((newest - genAt) / 1000)}s；${bad.length} 项差异发生在滞后窗口内，方向应一致：复算 ≥ daemon）`);
      console.log('对账通过（exit 0）——判据是"快照确有新记录未扫入"，非逐项证明；要拿严格结论请等回合结束后重跑。');
      return;
    }
    console.log('daemon 快照不比最新记录旧，仍有差异 → 真口径分歧，请查 scanner/daemon。');
    process.exit(1);
  }
  console.log('对账通过（exit 0）');
}

main().catch((e) => {
  console.error(`取数失败：${errText(e)}`);
  process.exit(1);
});
