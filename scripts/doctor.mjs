#!/usr/bin/env node
// scripts/doctor.mjs
// Task 11 — 自检报告：8 项检查，每项 {name,status:'ok'|'warn'|'fail',detail}。
// 退出码：0 全绿 / 10 有 warn / 20 有 fail。
// 红线：全程只读——不写补丁、不重启客户端、绝不 sudo；对 /opt 只 asar.extractFile 读取。
// --show-quota-raw：输出 state.json account.raw 的前 800 字符预览，先脱敏后截断
//   （规则：对 JSON.stringify(raw) 文本，键名命中 /user|email|id\b/i 的字符串值替换为
//   "[REDACTED]"；数字/布尔值与不命中键原样保留；绝不打印 token/bootstrap 材料）。
//   T13：其后追加一行 [quota-parse] —— heatmap/metrics 解析摘要（pickHeatmap 命中候选名、
//   天数/有值数/峰值/最新日 + metrics 六字段），首帧形状校准一眼可对。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import asar from '@electron/asar';
import { runCheckUpdate } from './check-update.mjs';
import { defaultDaemonProbe, DEFAULT_PORT, loadPatchState } from './install.mjs';
import { targetPaths, appAsarPath } from './lib/asarPaths.mjs';
import { isPatched } from './patchTransforms.mjs';
import { home, loadHistory } from '../daemon/store.mjs';

export const CHECK_NAMES = [
  'patch-state', 'asar-marker', 'daemon-health', 'scan-errors',
  'account', 'history', 'permissions', 'harness',
];

const ACCOUNT_FRESH_MS = 10 * 60 * 1000; // 新鲜度规则：fetchedAt >10min → warn
const RAW_PREVIEW_LIMIT = 800;
// check 7 运行时收口清单（T10 minor carry-in：fresh-create 路径缺断言 → doctor 兜底）。
const PRIVATE_FILES = [
  'daemon.token', 'bootstrap.json', 'quota-history.jsonl',
  'history.jsonl', 'state.json', 'patch-state.json',
];

/** harness 可达性：先探 /dev/manifest 判断 daemon 是否处于 dev 模式。
 *  - 404 → 'disabled'：生产安装按设计不开放 dev 静态根（不是故障）；
 *  - 200 → 严格 GET /harness/index.html 必须 200；
 *  - 网络异常 → false（daemon 未运行）。
 *  返回 true / false / 'disabled'；测试可注入布尔探针。 */
export async function defaultHarnessProbe(port, timeoutMs = 1500) {
  try {
    const manifest = await fetch(`http://127.0.0.1:${port}/dev/manifest`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (manifest.status === 404) return 'disabled';
    const res = await fetch(`http://127.0.0.1:${port}/harness/index.html`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

/** 脱敏（先于任何打印/截断）：字符串键值对里键名命中 /user|email|id\b/i 的字符串值 → "[REDACTED]"。 */
export function redactRawText(text) {
  return String(text).replace(
    /("(?:[^"\\]|\\.)*")(\s*:\s*)("(?:[^"\\]|\\.)*")/g,
    (m, key, sep, val) => {
      let k;
      try { k = JSON.parse(key); } catch { return m; }
      return /user|email|id\b/i.test(k) ? `${key}${sep}"[REDACTED]"` : m;
    },
  );
}

/** account.raw → 已脱敏的前 800 字符 head（严格 ≤800，超出部分不打印）。account 缺失 → 固定话术。 */
export function quotaRawPreview(account) {
  if (!account || account.raw == null || account.raw === undefined) {
    return '尚无账户数据（补丁未生效或桥接未返回）';
  }
  return redactRawText(JSON.stringify(account.raw, null, 2)).slice(0, RAW_PREVIEW_LIMIT);
}

/**
 * T13：heatmap/metrics 解析状态的一行紧凑摘要（--show-quota-raw 的第二段）。
 * 首帧 heatmap 形状未知 → 这里必须一眼能看出 pickHeatmap 命中了哪个候选、有没有数，
 * 校准只需「raw head ↔ 候选=」两行对照。缺席/未命中 → 明确话术，绝不谎称有数。
 */
export function quotaParsePreview(account) {
  const a = account && typeof account === 'object' ? account : null;
  const m = a && a.metrics && typeof a.metrics === 'object' && !Array.isArray(a.metrics) ? a.metrics : null;
  const h = a && a.heatmap && typeof a.heatmap === 'object' && !Array.isArray(a.heatmap) ? a.heatmap : null;
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? String(Math.round(v * 100) / 100) : '--');
  const ms = m
    ? `metrics 总计${n(m.totalCredits)} 峰值${n(m.peakCredits)} `
      + `连续${n(m.currentStreakDays)}/最长${n(m.longestStreakDays)} 活跃${n(m.totalActiveDays)} `
      + `失败源${Array.isArray(m.failedSources) ? m.failedSources.length : '--'}`
    : 'metrics 无（bridge 未返回/旧客户端）';
  const days = h && Array.isArray(h.days) ? h.days : null;
  const hs = days
    ? `heatmap 候选=${h.source || '?'} 天数=${days.length} `
      + `有值=${days.filter((d) => d && typeof d.credits === 'number').length} `
      + `峰值${n(Math.max(...days.map((d) => (d && typeof d.credits === 'number' ? d.credits : -Infinity))))} `
      + `最新${days.filter((d) => d && typeof d.date === 'string').map((d) => d.date).pop() || '--'}`
    : 'heatmap 无（bridge 未返回/旧客户端）';
  return `${ms} | ${hs}`;
}

export async function runDoctor(opts = {}) {
  const log = opts.log || ((m) => console.log(m));
  const now = opts.now || Date.now;
  const probeHealth = opts.probeHealth || defaultDaemonProbe;
  const probeHarness = opts.probeHarness || defaultHarnessProbe;
  const paths = targetPaths(opts.asarPath || appAsarPath());
  const patchRec = loadPatchState();
  const port = Number(opts.port || (patchRec && patchRec.port) || DEFAULT_PORT);

  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail: String(detail) });

  // daemon /health 只探测一次，结果同时喂给 check 1（check-update 三态）与 check 3。
  const health = await probeHealth(port);
  const cachedProbe = async () => health;

  // 1. patch-state.json 存在 + 当前 asar hash 三态（复用 check-update 判定）
  const cu = await runCheckUpdate({ log: () => {}, probeHealth: cachedProbe, asarPath: paths.asar, port });
  if (cu.json.status === 'error') {
    add('patch-state', 'fail', `未找到 ${paths.asar}（客户端未安装或路径被移动），无法判定补丁状态`);
  } else if (cu.json.status === 'patched') {
    add('patch-state', 'ok', `三态=patched${patchRec ? '（patch-state.json 在位）' : '（patch-state.json 缺失，按 index.html 标记判定）'}${cu.json.pendingResume ? '；存在待 --finish 的 pending-install.json' : ''}`);
  } else if (cu.json.status === 'overwritten-by-update') {
    add('patch-state', 'warn', '三态=overwritten-by-update（客户端更新已覆盖补丁），重跑 node scripts/install.mjs 重打');
  } else {
    add('patch-state', 'fail', `三态=${cu.json.status}（未安装或指纹不匹配），请运行 node scripts/install.mjs`);
  }

  // 2. asar 内 out/renderer/index.html 的 qum 标记（只读 extractFile）
  try {
    const html = asar.extractFile(paths.asar, 'out/renderer/index.html').toString('utf8');
    add('asar-marker', isPatched(html) ? 'ok' : 'fail',
      isPatched(html) ? 'CSP/loader qum 标记在位' : 'asar 内 index.html 无 qum 标记（补丁未生效，重跑 install 并重启客户端）');
  } catch (e) {
    add('asar-marker', 'fail', `无法只读提取 out/renderer/index.html：${(e && e.message) || e}`);
  }

  // 3. daemon /health（仅本机回环；复用上方单次探测结果）
  add('daemon-health', health ? 'ok' : 'fail', health
    ? `v${health.version || '?'} @127.0.0.1:${port}`
    : `127.0.0.1:${port} /health 无响应。保活：node <repo>/daemon/server.mjs --ensure --qm-role=qum-daemon`);

  // 磁盘 state.json 快照（check 4/5 与 --show-quota-raw 的共同数据源）
  let snap = null;
  try { snap = JSON.parse(fs.readFileSync(path.join(home(), 'state.json'), 'utf8')); } catch { /* 尚无快照 */ }

  // 4. scanner 错误
  if (!snap) {
    add('scan-errors', 'warn', `${home()}/state.json 尚不存在（daemon 未扫描过）`);
  } else {
    const errs = snap.meta && Array.isArray(snap.meta.scanErrors) ? snap.meta.scanErrors : [];
    add('scan-errors', errs.length ? 'warn' : 'ok', errs.length
      ? `${errs.length} 个文件扫描失败（JSONL 结构可能变化）：首个 ${errs[0].file}`
      : '无扫描错误');
  }

  // 5. 账户快照（source/fetchedAt 新鲜度 >10min → warn）
  if (!snap || !snap.account) {
    add('account', 'warn', '尚无账户数据（补丁未生效或桥接未返回）');
  } else {
    const age = now() - Number(snap.account.fetchedAt || 0);
    add('account', age > ACCOUNT_FRESH_MS ? 'warn' : 'ok', age > ACCOUNT_FRESH_MS
      ? `source=${snap.account.source}，${Math.round(age / 1000)}s 前（>10min 不新鲜，widget 可能未轮询/桥接断）`
      : `source=${snap.account.source}，${Math.round(age / 1000)}s 前`);
  }

  // 6. history 行数与最近日期
  const rows = loadHistory();
  add('history', rows.length ? 'ok' : 'warn', rows.length
    ? `${rows.length} 行，最近 ${rows[rows.length - 1].date}`
    : 'history.jsonl 暂无数据');

  // 7. 敏感文件权限收口：组/其他位非 0 → fail（缺失文件跳过——未必都已产生）
  const loose = [];
  let present = 0;
  for (const n of PRIVATE_FILES) {
    let st;
    try { st = fs.statSync(path.join(home(), n)); } catch { continue; }
    present++;
    if ((st.mode & 0o077) !== 0) loose.push(`${n}(0${(st.mode & 0o777).toString(8)})`);
  }
  add('permissions', loose.length ? 'fail' : 'ok', loose.length
    ? `组/其他权限位未收口：${loose.join(' ')}`
    : `已存在的 ${present} 个敏感文件均为 0600（token/bootstrap/quota-history/history/state/patch-state）`);

  // 8. dev 静态根（/harness/index.html）：仅 QUM_DEV=1 开放；生产态 404 属预期
  const harness = await probeHarness(port);
  const harnessOk = harness === true || harness === 'disabled';
  add('harness', harnessOk ? 'ok' : 'warn', harnessOk
    ? (harness === 'disabled'
      ? `生产态：dev 静态根未开放 @127.0.0.1:${port}（QUM_DEV≠1，符合预期）`
      : `GET /harness/index.html 200 @127.0.0.1:${port}`)
    : `GET /harness/index.html 不可达 @127.0.0.1:${port}（daemon 未运行或测试页缺失）`);

  const exitCode = checks.some((c) => c.status === 'fail') ? 20
    : checks.some((c) => c.status === 'warn') ? 10 : 0;

  if (opts.showQuotaRaw) {
    log('[quota-raw] account.raw 脱敏预览（规则：键名命中 /user|email|id\\b/i 的字符串值 → [REDACTED]，先脱敏后截断，前 800 字符）：');
    log(quotaRawPreview(snap && snap.account));
    // T13：同一次输出里附带 heatmap/metrics 解析摘要——首帧形状校准时"raw head ↔ 命中候选"对照即可。
    log('[quota-parse] ' + quotaParsePreview(snap && snap.account));
  }
  if (!opts.quiet) {
    for (const c of checks) log(`  [${c.status.toUpperCase()}] ${c.name} — ${c.detail}`);
    log(`doctor: ${checks.length} 项 → 退出码 ${exitCode}`);
  }
  return { exitCode, checks };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const r = await runDoctor({
    showQuotaRaw: argv.includes('--show-quota-raw'),
    log: asJson ? () => {} : (m) => console.log(m),
    quiet: asJson, // --json 模式只输出 JSON 报告本体
  });
  if (asJson) console.log(JSON.stringify({ exitCode: r.exitCode, checks: r.checks }, null, 2));
  process.exit(r.exitCode);
}
