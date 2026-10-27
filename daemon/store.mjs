// daemon/store.mjs
// Qoder Usage Monitor — 持久层：daemon 目录、原子写、history 合并、scan 缓存、token/bootstrap。
// Task 4 的 daemon 进程只通过本模块读写 ~/.qoder-monitor（或 QUM_HOME 覆盖）。

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HISTORY_FILE = 'history.jsonl';
const SCAN_CACHE_FILE = 'scan-cache.json';
const TOKEN_FILE = 'daemon.token';
const BOOTSTRAP_FILE = 'bootstrap.json';

/** daemon 根目录：QUM_HOME ?? ~/.qoder-monitor。lazy（每次调用读取 env），首次调用递归 mkdir 全链。 */
export function home() {
  const dir = process.env.QUM_HOME || path.join(os.homedir(), '.qoder-monitor');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function inHome(name) {
  return path.join(home(), name);
}

/**
 * 原子写：同目录 tmp 文件 + rename，落盘模式恒为 0600（chmod 消除 umask/既有模式影响）。
 * rename 原子性保证读方永远看到完整文件；失败时清理 tmp，不污染正式路径。
 */
export function atomicWrite(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600); // writeFileSync 的 mode 受 umask 影响且对已存在文件无效，显式 chmod
    fs.renameSync(tmp, filePath);
    fs.chmodSync(filePath, 0o600); // 覆盖已存在文件时 rename 沿用其旧模式，再校正一次
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 清理失败不掩盖原始错误 */
    }
    throw e;
  }
}

/**
 * 同日合并：derived（来自全量日志重扫，永远更新鲜）整行覆盖 stored（含 main/sub，非 deep merge）；
 * 日志已被清理的旧日子保留 stored 行。返回按 date 升序全量。
 */
export function mergeDaily(derivedRows, storedRows) {
  const byDate = new Map();
  for (const r of storedRows) byDate.set(r.date, r);
  for (const r of derivedRows) byDate.set(r.date, r);
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** 读 history.jsonl：每行一天；非法 JSON / 非对象 / 无字符串 date 的坏行静默跳过。文件缺失 → []。 */
export function loadHistory() {
  let raw;
  try {
    raw = fs.readFileSync(inHome(HISTORY_FILE), 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let o;
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    if (o && typeof o === 'object' && !Array.isArray(o) && typeof o.date === 'string') rows.push(o);
  }
  return rows;
}

export function saveHistory(rows) {
  const content = rows.map((r) => JSON.stringify(r)).join('\n');
  atomicWrite(inHome(HISTORY_FILE), rows.length ? content + '\n' : content);
}

/**
 * scan-cache.json：{files: {path: {size, mtimeMs, records, windows, toolSpans, toolEvents}}}。
 * 缺失/损坏回退空结构。
 * 版本门：v5（P0 准确性）= 记录增补 billable（实扣/免费拆分；旧记录缺字段会把免费用量
 * 当已扣消耗）——v4 及更早缓存必须作废强制全量重扫。
 * v4（原生样式）= 条目增补 toolEvents；v3（T16）= 记录增补 outEst/rid、条目增补 toolSpans；
 * v2（P2）及更早同样缺字段。
 */
export function loadScanCache() {
  const empty = { files: {}, records: [] };
  let o;
  try {
    o = JSON.parse(fs.readFileSync(inHome(SCAN_CACHE_FILE), 'utf8'));
  } catch {
    return empty;
  }
  if (!o || typeof o !== 'object' || o.v !== 5) return empty;
  return {
    files: o.files && typeof o.files === 'object' ? o.files : {},
    records: Array.isArray(o.records) ? o.records : [],
  };
}

export function saveScanCache(cache) {
  atomicWrite(inHome(SCAN_CACHE_FILE), JSON.stringify({ ...cache, v: 5 }));
}

// ---- T16：qodercli.log 计时配对增量缓存 ----
// timing-cache.json：{files: {logPath: {pos}}, pairs: {request_id: [startMs|null, endMs|null]}}。
// pos = 已消费字节偏移（追加式日志只读新增段；size<pos 视为整文件重写 → 归零重读）。
// pairs 需 start/end 双侧齐备才可注入记录（缺一侧 → null，消费侧按未配对处理）。
const TIMING_CACHE_FILE = 'timing-cache.json';

export function loadTimingCache() {
  const empty = { files: {}, pairs: {} };
  let o;
  try {
    o = JSON.parse(fs.readFileSync(inHome(TIMING_CACHE_FILE), 'utf8'));
  } catch {
    return empty;
  }
  if (!o || typeof o !== 'object' || o.v !== 1) return empty;
  return {
    files: o.files && typeof o.files === 'object' ? o.files : {},
    pairs: o.pairs && typeof o.pairs === 'object' ? o.pairs : {},
  };
}

export function saveTimingCache(cache) {
  atomicWrite(inHome(TIMING_CACHE_FILE), JSON.stringify({ ...cache, v: 1 }));
}

/** daemon.token：随机 32B hex（64 字符），0600（atomicWrite 保证）。缺失 → null。 */
export function writeToken() {
  const token = crypto.randomBytes(32).toString('hex');
  atomicWrite(inHome(TOKEN_FILE), token);
  return token;
}

export function readToken() {
  try {
    const t = fs.readFileSync(inHome(TOKEN_FILE), 'utf8').trim();
    return t || null;
  } catch {
    return null;
  }
}

/** bootstrap.json：{"code":"…"}（安装器也写此文件）。缺失/格式不符 → null。 */
export function saveBootstrap(code) {
  atomicWrite(inHome(BOOTSTRAP_FILE), JSON.stringify({ code }));
}

export function loadBootstrap() {
  try {
    const o = JSON.parse(fs.readFileSync(inHome(BOOTSTRAP_FILE), 'utf8'));
    return o && typeof o === 'object' && typeof o.code === 'string' ? o : null;
  } catch {
    return null;
  }
}

/** 删除本机凭据（bootstrap + daemon token）；历史/配额等数据文件保留。 */
export function clearCredentials() {
  fs.rmSync(inHome(TOKEN_FILE), { force: true });
  fs.rmSync(inHome(BOOTSTRAP_FILE), { force: true });
}

/** 只删 token：下次 daemon 启动 initAuth 会生成新 token（安装时轮换用）。 */
export function clearToken() {
  fs.rmSync(inHome(TOKEN_FILE), { force: true });
}
