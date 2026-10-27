#!/usr/bin/env node
// scripts/uninstall.mjs
// Task 7 — 卸载：当前 hash==patched → 恢复 .orig（可写直改；不可写走 elevate 红线，
// 失败一次打印手动 sudo 块退出 2）；hash==orig → "已被更新覆盖，无需恢复"；
// 都对不上 → 报错不猜。daemon 一律 pkill -f qum-daemon（+ 端口定向兜底）。
// 安全红线：历史目录 ~/.qoder-monitor 永不删除，只报告位置。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  makeElevate, writableTarget, loadPatchState, patchStatePath,
  clearPending, printManualCommands, defaultDaemonProbe, uncacheAsar, DEFAULT_PORT,
  repoPathFile,
} from './install.mjs';
import { targetPaths, appAsarPath, sha256File } from './lib/asarPaths.mjs';
import { home, clearCredentials } from '../daemon/store.mjs';
import { verifyPatched } from './asarPipeline.mjs';

/**
 * 杀 daemon：主模式 qum-daemon（安装器 spawn 的 argv 标记，brief 写死常量）；
 * 兜底模式 `server.mjs --port <port>` ——daemon/server.mjs 的 --ensure 内部重启
 * 不带 role 标记，仅按端口+脚本名精确定位（只杀绑到该端口的本工具 daemon）。
 */
export function defaultKillDaemon({ port } = {}) {
  const patterns = ['qum-daemon'];
  if (port) patterns.push(`server.mjs --port ${port}`);
  for (const p of patterns) {
    try { execFileSync('pkill', ['-f', p], { stdio: 'ignore' }); } catch { /* 无匹配即成功 */ }
  }
}

/** Final-review Fix#1（Spec §7.2）：卸载必须停用 SessionStart 保活——删 repo-path
 * （install.mjs saveRepoPath 写；cli-plugin hooks.json 每次新会话读它跑 --ensure，
 * 不删则杀掉的 daemon 会在下一个 CLI 会话复活）。插件本身禁用需用户手动，打印提示。 */
function disarmKeepAlive(log) {
  fs.rmSync(repoPathFile(), { force: true });
  log('提示：还需手动移除 CLI 插件以停用 SessionStart hook（删除或禁用 cli-plugin 目录 / 已安装的 qoder-usage-monitor-ops 插件）。');
}

export async function runUninstall(opts = {}) {
  const log = opts.log || ((m) => console.log(m));
  const elevate = opts.elevate || makeElevate();
  const killDaemon = opts.killDaemon || defaultKillDaemon;
  const probe = opts.daemonProbe || defaultDaemonProbe;
  const paths = targetPaths(opts.asarPath || appAsarPath());
  const state = loadPatchState();
  const port = Number(opts.port || (state && state.port) || DEFAULT_PORT);

  if (!fs.existsSync(paths.asar)) {
    log(`卸载失败：未找到 ${paths.asar}——无法确定目标客户端安装位置，不做任何操作。`);
    return { code: 1 };
  }
  const cur = sha256File(paths.asar);
  const origExists = fs.existsSync(paths.orig);

  // 2) 已被更新覆盖：当前 hash 就是原版（.orig 存在且与当前一致）
  if (origExists && cur === sha256File(paths.orig)) {
    log('当前 app.asar 已是原版指纹：已被更新覆盖，无需恢复。');
    fs.rmSync(patchStatePath(), { force: true });
    clearPending();
    disarmKeepAlive(log); // Spec §7.2：卸载必须拆掉 SessionStart 保活（repo-path）
    await killDaemon({ port });
    clearCredentials(); // daemon 已停：bootstrap/token 不再有用途，删除防残留
    log(`历史数据保留于 ${home()}（uninstall 不删除）`);
    return { code: 0, restored: false };
  }

  // 1) 补丁在位：state hash 命中，或（state 缺失时）index.html 的 patch 标记
  let isPatchedNow = !!(state && state.asarSha256Patched && cur === state.asarSha256Patched);
  if (!isPatchedNow) {
    try { isPatchedNow = verifyPatched(paths.asar); } catch { isPatchedNow = false; }
  }
  if (!isPatchedNow || !origExists) {
    log(isPatchedNow
      ? '卸载失败：app.asar 已打补丁但 .orig 备份不存在——没有可恢复的原件，不做任何猜测性操作。'
      : '卸载失败：当前 app.asar 既不匹配已记录的补丁 hash，也不是 .orig 原版指纹——状态不明，不做任何猜测性操作。');
    return { code: 1 };
  }

  // 恢复 .orig（幂等两步：换回原件 / 删备份）
  if (writableTarget(paths)) {
    fs.copyFileSync(paths.orig, paths.asar);
    fs.chmodSync(paths.asar, 0o644);
    fs.rmSync(paths.orig, { force: true });
    uncacheAsar(paths.asar);
    log('已恢复原版 app.asar（.orig 已删除）');
  } else {
    const cmds = [
      ['cp', '-a', paths.orig, paths.asar],
      ['rm', '-f', paths.orig],
    ];
    try {
      await elevate(cmds);
      uncacheAsar(paths.asar);
      log('已恢复原版 app.asar（提权）');
    } catch (e) {
      printManualCommands(
        log,
        `目标不可写且提权失败（${(e && e.message) || e}）。本工具不会自动执行 sudo。请手动执行：`,
        cmds,
        '完成后重新运行：node scripts/uninstall.mjs',
      );
      return { code: 2, manualCommands: cmds };
    }
  }

  fs.rmSync(patchStatePath(), { force: true });
  clearPending();
  disarmKeepAlive(log); // Spec §7.2：同上——恢复成功路径也必须拆保活
  await killDaemon({ port });
  const daemonAlive = await probe(port);
  if (daemonAlive) log(`警告：端口 ${port} 上仍有存活 daemon，可能需手动结束（pkill -f qum-daemon）`);
  clearCredentials(); // 卸载后无 daemon 使用凭据；历史/配额数据仍保留
  log(`历史数据保留于 ${home()}（uninstall 不删除）`);
  log('重启客户端生效（不自动重启）');
  return { code: 0, restored: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = await runUninstall({});
  process.exit(r.code);
}
