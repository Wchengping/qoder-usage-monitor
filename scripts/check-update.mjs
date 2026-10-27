#!/usr/bin/env node
// scripts/check-update.mjs
// Task 7 — 三态自检：patched(0) / overwritten-by-update(10) / unpatched(20)，
// 附 daemon /health 状态。判定次序（保守、不猜）：
//   1. patch-state.json 存在且当前 asar sha256 == asarSha256Patched → patched
//   2. .orig 存在且当前 asar sha256 == .orig sha256 → overwritten-by-update（更新覆盖回原版）
//   3. 指纹都不可用/不命中时看 index.html 的 patch 标记（verifyPatched）：
//      有标记 → patched（state 缺失的边缘）；无标记且有 .orig → overwritten-by-update；
//      无标记且无 .orig → unpatched。
// app.asar 不存在属硬错误：退出码 2（brief 只定义 0/10/20 三态，异常态单独码，不猜）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPatchState, loadPending, defaultDaemonProbe, DEFAULT_PORT } from './install.mjs';
import { targetPaths, appAsarPath, sha256File } from './lib/asarPaths.mjs';
import { verifyPatched } from './asarPipeline.mjs';

const CODE = { patched: 0, 'overwritten-by-update': 10, unpatched: 20 };

export async function runCheckUpdate(opts = {}) {
  const log = opts.log || ((m) => console.log(m));
  const probe = opts.probeHealth || defaultDaemonProbe;
  const paths = targetPaths(opts.asarPath || appAsarPath());
  const state = loadPatchState();
  const pending = loadPending();

  if (!fs.existsSync(paths.asar)) {
    log(`错误：未找到 ${paths.asar}（客户端未安装或路径被移动），无法判定状态。`);
    return { code: 2, json: { status: 'error', error: 'app.asar missing', asar: paths.asar } };
  }

  const cur = sha256File(paths.asar);
  const origExists = fs.existsSync(paths.orig);
  const origMatch = origExists && cur === sha256File(paths.orig);
  const stateMatch = !!(state && state.asarSha256Patched && cur === state.asarSha256Patched);
  let marker = false;
  if (!stateMatch && !origMatch) {
    try { marker = verifyPatched(paths.asar); } catch { marker = false; }
  }

  let status;
  if (stateMatch || marker) status = 'patched';
  else if (origExists) status = 'overwritten-by-update';
  else status = 'unpatched';

  const port = Number(opts.port || (state && state.port) || DEFAULT_PORT);
  const health = await probe(port);
  const json = {
    status,
    asar: paths.asar,
    asarSha256: cur,
    patchedAt: state ? state.patchedAt : null,
    pendingResume: !!pending,
    daemon: { port, running: !!health, version: health ? health.version || null : null },
  };

  log(`状态: ${status}`);
  log(`daemon: ${json.daemon.running ? `运行中 (v${json.daemon.version})` : '未运行'} @127.0.0.1:${port}`);
  if (pending) log('存在待 --finish 续跑的 pending-install.json');
  return { code: CODE[status], json };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const asJson = process.argv.slice(2).includes('--json');
  const r = await runCheckUpdate({
    log: asJson ? () => {} : (m) => console.log(m),
  });
  if (asJson) console.log(JSON.stringify(r.json, null, 2));
  process.exit(r.code);
}
