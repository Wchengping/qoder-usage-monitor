#!/usr/bin/env node
// scripts/install.mjs
// Task 7 — 安装编排：preflight → buildPatchedAsar → 落盘（可写直改 / 不可写走 elevate 红线）
// → patch-state.json → detached daemon --ensure → 提示重启客户端。
//
// sudo 红线：本程序自身永远不弹密码框、不重试提权。提权执行被封成 `elevate(cmds)`
// 依赖注入；生产默认 pkexec（非交互，无 tty 即失败）或 QUM_SUDO 指定的命令（如 sudo -n）。
// 失败一次 → 打印手动 sudo 命令块 → 记 pending-install.json → 退出码 2，
// 用户手动完成后用 `--finish` 续跑（只补写状态，绝不重建）。
//
// 落盘铁律（2026-10-23 真机事故后加）：客户端在跑就拒绝落盘（退出码 3）；落盘用
// 同目录暂存 + rename 原子替换，绝不 `cp` 覆盖同一 inode。详见 runningClientPid。
//
// 测试全部通过 QUM_APP_ASAR + QUM_HOME env 覆盖走假目录；QUM_ELEVATE_TEST=fail|ok 与
// QUM_SPAWN_DAEMON_TEST=skip 只影响 CLI 顶层的 elevate/spawnDaemon 工厂，
// 前者永不真执行提权命令，后者永不拉起真实 detached daemon。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import asar from '@electron/asar';
import { buildPatchedAsar, verifyPatched } from './asarPipeline.mjs';
import { home, atomicWrite, saveBootstrap, clearToken } from '../daemon/store.mjs';
import { targetPaths, appAsarPath, sha256File, readAppVersion } from './lib/asarPaths.mjs';

const SELF = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(SELF), '..');
const DAEMON_SCRIPT = path.join(REPO, 'daemon', 'server.mjs');
const MONITOR_VERSION = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
export const DEFAULT_PORT = 49789;
const MIN_FREE_BYTES = 1.5e9; // “≥1.5GB”按十亿字节取保守下限
const STATE_FILE = 'patch-state.json';
const PENDING_FILE = 'pending-install.json';

// ---------------------------------------------------------------- state files

export function patchStatePath() {
  return path.join(home(), STATE_FILE);
}
export function pendingPath() {
  return path.join(home(), PENDING_FILE);
}
export function loadPatchState() {
  try {
    const o = JSON.parse(fs.readFileSync(patchStatePath(), 'utf8'));
    return o && typeof o === 'object' ? o : null;
  } catch {
    return null;
  }
}
export function savePatchState(state) {
  atomicWrite(patchStatePath(), JSON.stringify(state, null, 2) + '\n');
}
export function loadPending() {
  try {
    const o = JSON.parse(fs.readFileSync(pendingPath(), 'utf8'));
    return o && typeof o === 'object' ? o : null;
  } catch {
    return null;
  }
}
export function clearPending() {
  fs.rmSync(pendingPath(), { force: true });
}

/** Task 11：repo-path（一行仓库绝对路径）——SessionStart hook 靠它定位 daemon/server.mjs。
 *  atomicWrite 保证 0600（内容非敏感，收口仅为统一纪律）。--finish 校验后回退旧值。 */
export function repoPathFile() {
  return path.join(home(), 'repo-path');
}
export function saveRepoPath(repoDir = REPO) {
  atomicWrite(repoPathFile(), `${repoDir}\n`);
}

// ---------------------------------------------------------------- preflight utils

/** daemon /health 探测：活着返回 JSON，否则返回 null（uninstall/killDaemon 亦复用）。 */
export async function defaultDaemonProbe(port, timeoutMs = 1500) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const j = await res.json().catch(() => null);
    return j && j.ok === true ? j : null;
  } catch {
    return null;
  }
}

/** 端口可用性：若被占但占主是本工具 daemon（/health ok:true）则放行；其余占用报错。 */
async function checkPortUsable(port, probe) {
  if (await probe(port)) return { ok: true, ours: true };
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', (e) => resolve({ ok: false, code: e.code || String(e) }));
    srv.once('listening', () => srv.close(() => resolve({ ok: true })));
    srv.listen(port, '127.0.0.1');
  });
}

/** outDir 所在文件系统空闲字节；探测不了返回 null（preflight 降级为警告）。 */
export function defaultDiskFreeBytes(dir) {
  let p = path.resolve(dir);
  while (!fs.existsSync(p)) {
    const up = path.dirname(p);
    if (up === p) return null;
    p = up;
  }
  try {
    const s = fs.statfsSync(p);
    if (typeof s.bsize === 'number' && typeof s.bavail === 'number') return s.bsize * s.bavail;
  } catch { /* fall through to df */ }
  try {
    const out = execFileSync('df', ['-B1', '--output=avail', p], { encoding: 'utf8' });
    const n = Number(out.split('\n')[1].trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** 目标可写性：resources 目录 + 将被覆盖的 asar/orig + 既有 unpacked 目录都要 W_OK。 */
export function writableTarget(paths) {
  const W = fs.constants.W_OK;
  const ok = (p) => {
    try { fs.accessSync(p, W); return true; } catch { return false; }
  };
  if (!ok(paths.resourcesDir)) return false;
  if (!ok(paths.asar)) return false;
  if (fs.existsSync(paths.orig) && !ok(paths.orig)) return false;
  if (fs.existsSync(paths.unpacked) && !ok(paths.unpacked)) return false;
  return true;
}

// ---------------------------------------------------------------- 客户端是否在跑

/**
 * 2026-10-23 真机事故（0.4.9）：客户端运行中用 `cp -a` 覆盖 app.asar，写入的是同一个
 * inode——运行中的实例早已把 asar 头部/偏移缓存在内存里，之后按旧偏移读新内容必然错位，
 * 于是刷 `Invalid package config …/app.asar/package.json`，ChatSession worker 全挂，
 * 关闭流程卡在 "close confirmation pending"：窗口没了、进程还在、单实例锁仍被占。
 * 用户再点图标只会被转发给那个卡死实例 → 现象就是"打不开"。
 * 所以：落盘前必须确认客户端已完全退出（判据与 Electron 自己一致：SingletonLock）。
 */

/** 客户端 userData 目录：product.json 的 dataDirectoryName → ~/.config/<name>；取不到返回 null。 */
export function appUserDataDir(paths) {
  try {
    const p = JSON.parse(fs.readFileSync(paths.productJson, 'utf8'));
    const name = p && p.dataDirectoryName;
    if (typeof name === 'string' && name) return path.join(os.homedir(), '.config', name);
  } catch { /* product.json 缺失/损坏 → 无法判定，交给调用方决定 */ }
  return null;
}

/**
 * 返回正在运行的客户端 pid；没在跑（含陈旧锁）返回 null。
 * SingletonLock 是 "hostname-pid" 形式的符号链接，Electron 启动时创建、退出时删除；
 * 进程被 SIGKILL 时会留下陈旧锁，因此用 kill(pid, 0) 复核存活。
 */
export function runningClientPid(paths) {
  const dir = appUserDataDir(paths);
  if (!dir) return null;
  let target;
  try {
    target = fs.readlinkSync(path.join(dir, 'SingletonLock'));
  } catch {
    return null;
  }
  const m = /-(\d+)$/.exec(target);
  if (!m) return null;
  const pid = Number(m[1]);
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null; // ESRCH：陈旧锁，安全
  }
}

// ---------------------------------------------------------------- elevation

/**
 * elevate(cmds) 工厂：cmds = 参数数组的列表（如 [['cp','-a',a,b], …]）。
 * QUM_ELEVATE_TEST=fail|ok 是 CLI 顶层测试钩子（fail 抛错 / ok 静默成功），
 * 生产路径用 QUM_SUDO（如 'sudo -n'）或 pkexec——非交互失败一次即抛。
 */
export function makeElevate() {
  const t = process.env.QUM_ELEVATE_TEST;
  if (t === 'fail') return () => { throw new Error('QUM_ELEVATE_TEST=fail（提权失败分支模拟）'); };
  if (t === 'ok') return () => {};
  const sudo = (process.env.QUM_SUDO || 'pkexec').trim().split(/\s+/);
  return (cmds) => {
    for (const c of cmds) execFileSync(sudo[0], [...sudo.slice(1), ...c], { stdio: 'inherit' });
  };
}

/** 落盘暂存名（与目标同目录，保证 mv 是同文件系统 rename，原子生效）。 */
export function stagedAsarPath(paths) {
  return paths.asar + '.qum-new';
}

/** 落盘 4 步（备份 / 换 asar / 换 unpacked / chmod）的提权命令列表。
 * 新构建若无 unpacked 产物（源 asar 无 unpacked 条目），则跳过换 unpacked 两步。 */
export function persistCommands({ paths, outDir, needBackup, hasNewUnpacked = true }) {
  const cmds = [];
  if (needBackup) cmds.push(['cp', '-a', paths.asar, paths.orig]);
  // 原子替换：先落到同目录暂存名，chmod 到位后再 mv（rename）换 inode。
  // 绝不直接 cp 覆盖目标——那是同一个 inode，任何仍在读它的进程都会读到"半新半旧"。
  const staged = stagedAsarPath(paths);
  cmds.push(['cp', '-a', path.join(outDir, 'app.asar.new'), staged]);
  cmds.push(['chmod', '600', staged]); // asar 内嵌 bootstrap：仅属主可读
  cmds.push(['mv', '-f', staged, paths.asar]);
  if (hasNewUnpacked) {
    cmds.push(['mkdir', '-p', paths.unpacked]);
    cmds.push(['cp', '-a', path.join(outDir, 'app.asar.new.unpacked') + '/.', paths.unpacked]);
  }
  return cmds;
}

function shq(arg) {
  return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

export function printManualCommands(log, header, cmds, tail) {
  log(header);
  for (const c of cmds) log(`  sudo ${c.map(shq).join(' ')}`);
  if (tail) log(tail);
}

/** 直改落盘（与 persistCommands 等价的非提权序列，同样是原子替换）。 */
function persistWritable({ paths, outDir, needBackup, hasNewUnpacked = true }) {
  if (needBackup) fs.copyFileSync(paths.asar, paths.orig);
  const staged = stagedAsarPath(paths);
  fs.copyFileSync(path.join(outDir, 'app.asar.new'), staged);
  fs.chmodSync(staged, 0o600); // asar 内嵌 bootstrap：仅属主可读
  fs.renameSync(staged, paths.asar); // 换 inode：运行中的实例仍读完整旧归档
  if (hasNewUnpacked) {
    fs.cpSync(path.join(outDir, 'app.asar.new.unpacked'), paths.unpacked, { recursive: true, force: true });
  }
}

/** 落盘后重启 daemon：轮换凭据时旧进程内存里是旧 bootstrap，必须换新进程。
 *  - 只按「目标端口」精确定位本工具 daemon（`server.mjs --port N`，含 --ensure 包装），
 *    不广域 pkill qum-daemon，避免误杀其它端口/其它工作区实例；
 *  - QUM_SPAWN_DAEMON_TEST=skip 时不真杀（测试纪律：绝不碰真实 daemon）。 */
export function defaultKillDaemon({ port } = {}) {
  if (process.env.QUM_SPAWN_DAEMON_TEST === 'skip' || !port) return;
  try { execFileSync('pkill', ['-f', `server\\.mjs.*--port ${port}(\\s|$)`], { stdio: 'ignore' }); } catch { /* 无匹配即成功 */ }
}

/** 等旧 daemon 真正退出：--ensure 探测可能撞上尚未退出的旧进程，误判 already-running
 *  而复用旧进程内存里的旧 bootstrap/token，导致新 loader 换不到 token。 */
export async function waitDaemonDown(probe, port, { timeoutMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await probe(port))) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/** 替换 app.asar 后必须失效 @electron/asar 按路径缓存的旧 header，否则同进程后续读取拿到过期内容。 */
export function uncacheAsar(...p) {
  try { asar.uncache(...p); } catch { /* 缓存清理尽力而为 */ }
}

// ---------------------------------------------------------------- daemon spawn

export function daemonArgs(port) {
  // --qm-role=qum-daemon：keepalive 标记（server.mjs 接受并忽略；pkill -f qum-daemon 用）
  return ['--ensure', '--port', String(port), '--qm-role=qum-daemon'];
}

export function defaultSpawnDaemon({ port }) {
  const child = spawn(process.execPath, [DAEMON_SCRIPT, ...daemonArgs(port)], {
    detached: true, stdio: 'ignore', env: process.env, cwd: REPO,
  });
  child.on('error', () => { /* 拉起失败不影响安装结论 */ });
  child.unref();
  return { pid: child.pid };
}

/**
 * spawnDaemon 工厂（测试注入钩子，与 makeElevate 同风格）：
 * QUM_SPAWN_DAEMON_TEST=skip → 绝不拉起 detached daemon（返回 { pid: null }），
 * 仅经 log 打一行钩子生效凭据；生产默认不变，仍是 defaultSpawnDaemon。
 */
export function makeSpawnDaemon(log) {
  if (process.env.QUM_SPAWN_DAEMON_TEST === 'skip') {
    return ({ port }) => {
      if (log) log(`QUM_SPAWN_DAEMON_TEST=skip：daemon 拉起已跳过（port ${port}）`);
      return { pid: null };
    };
  }
  return defaultSpawnDaemon;
}

// ---------------------------------------------------------------- runInstall

export async function runInstall(opts = {}) {
  const log = opts.log || ((m) => console.log(m));
  const now = opts.now || Date.now;
  const port = Number(opts.port || process.env.QUM_PORT || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    log(`无效端口：${String(opts.port ?? process.env.QUM_PORT)}`);
    return { code: 1 };
  }
  const force = !!opts.force;
  const skipPreflight = !!opts.skipPreflight;
  const elevate = opts.elevate || makeElevate();
  const spawnDaemon = opts.spawnDaemon || makeSpawnDaemon(log);
  const killDaemon = opts.killDaemon || defaultKillDaemon;
  const probe = opts.probeHealth || defaultDaemonProbe;
  const diskFreeBytes = opts.diskFreeBytes || defaultDiskFreeBytes;
  const writeRepoPath = opts.writeRepoPath || saveRepoPath;
  const widgetFilesDir = opts.widgetFilesDir || process.env.QUM_WIDGET_DIR || path.join(REPO, 'app');
  const paths = targetPaths(opts.asarPath || appAsarPath());
  const outDir = opts.outDir || process.env.QUM_OUT_DIR || path.join(home(), 'build');

  // ---- preflight
  if (!fs.existsSync(paths.asar)) {
    log(`preflight 失败：未找到 ${paths.asar}`);
    return { code: 1 };
  }
  if (!skipPreflight) {
    const major = Number(process.versions.node.split('.')[0]);
    if (major < 20) {
      log(`preflight 失败：需要 Node >= 20，当前 ${process.versions.node}`);
      return { code: 1 };
    }
    const free = diskFreeBytes(outDir);
    if (free === null || free === undefined) {
      log(`警告：无法探测 ${outDir} 所在文件系统的空闲空间，跳过磁盘检查`);
    } else if (free < MIN_FREE_BYTES) {
      log(`preflight 失败：${outDir} 所在文件系统空闲 ${(free / 1e9).toFixed(2)}GB，不足 1.5GB`);
      return { code: 1 };
    }
    const pu = await checkPortUsable(port, probe);
    if (!pu.ok) {
      log(`preflight 失败：端口 ${port} 被其他进程占用（${pu.code}），且不是本工具 daemon。请换 --port。`);
      return { code: 1 };
    }
    const state = loadPatchState();
    if (!force && state && state.asarSha256Patched && sha256File(paths.asar) === state.asarSha256Patched) {
      log('已安装，如需重打先 --force');
      writeRepoPath(REPO); // 自愈：老版本安装缺 repo-path 时，短路路径也补齐（hook 保活依赖）
      return { code: 0, alreadyInstalled: true };
    }
  }

  // ---- 落盘前闸门：客户端在跑就拒绝（见 runningClientPid 注释）
  // 只对生产目标生效（测试一律用 opts.asarPath / QUM_APP_ASAR 指向临时目录）；
  // QUM_ALLOW_RUNNING=1 是"只构建不落盘"等场景的显式逃生门。
  const isProdTarget = !opts.asarPath && !process.env.QUM_APP_ASAR;
  const detectRunning = opts.runningClientPid || runningClientPid;
  if (isProdTarget && process.env.QUM_ALLOW_RUNNING !== '1') {
    const pid = detectRunning(paths);
    if (pid) {
      log(`落盘中止：Qoder 正在运行（pid ${pid}）。`);
      log('  运行中替换 app.asar 会让该实例读到错乱的归档 → 关闭流程卡死、再启动被单实例锁挡住，');
      log('  表现出来就是"更新完打不开"。请先完全退出 Qoder（含托盘/后台进程），再重跑本命令。');
      log('  复核：readlink ~/.config/com.qodercn.app.stable/SingletonLock 应失败（陈旧锁会指向已不存在的 pid）。');
      return { code: 3 };
    }
  }

  // ---- widget 源（Task 8 产物）与 bootstrap 码
  if (!fs.existsSync(widgetFilesDir)) {
    log(`安装中止：widget 文件目录不存在：${widgetFilesDir}`);
    return { code: 1 };
  }
  // 每次安装轮换 bootstrap：旧 asar 里的旧码随替换失效，历史泄露的 bootstrap 不再长期可用。
  // 这里只生成并嵌进新产物；写盘 + 重启 daemon 放在落盘成功之后，失败不破坏现网凭据。
  const bootstrapCode = crypto.randomBytes(8).toString('hex'); // 16 hex

  // ---- 构建（脏 outDir 重建不幂等——Task 6 台账裁定：每次先清空）
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(outDir, 0o700); // 构建产物含内嵌 bootstrap 的 app.asar → 仅本人可读
  // Task 8 台账裁定：widgetFilesDir/loader.js 是 renderLoader 的实现体模板文件；
  // 存在则作为 implBody 注入（生成的 loader.js 覆盖被复制的同名文件）。缺省沿用
  // patchTransforms 的占位 stub（旧 widget 目录布局/测试 stub 树不受影响）。
  const loaderBodyPath = path.join(widgetFilesDir, 'loader.js');
  const implBody = fs.existsSync(loaderBodyPath) ? fs.readFileSync(loaderBodyPath, 'utf8') : undefined;
  let built;
  try {
    built = await buildPatchedAsar({
      srcAsar: paths.asar, outDir, widgetFilesDir, port, bootstrapCode, version: MONITOR_VERSION, implBody,
    });
  } catch (e) {
    log(`构建失败：${e && e.message}`);
    return { code: 1 };
  }
  if (!verifyPatched(built.newAsarPath)) {
    log('构建校验失败（verifyPatched=false），中止，不落盘');
    return { code: 1 };
  }

  // .orig 备份决策（2026-10-12 真机事故修正）：客户端 auto-update 会用新版 stock 替换
  // app.asar 而不动 .orig —— 只看「存在与否」会让 .orig 停在旧版本，卸载时把客户端
  // 回滚到旧版。规则：
  //   .orig 缺失 → 备份；
  //   当前 asar 是本工具打的补丁（hash==patch-state.asarSha256Patched，或 patch-state
  //   丢失但 qum 标记在——verifyPatched 兜底）→ .orig 仍是对应的原版，保留；
  //   否则当前是更新后的新 stock 且 .orig 指纹不同 → 刷新 .orig 为新 stock。
  const prevState = loadPatchState();
  const curSha = built.sha256Orig; // 构建源即落盘前的当前 asar
  const currentIsOurs = (!!prevState && !!prevState.asarSha256Patched && curSha === prevState.asarSha256Patched)
    || verifyPatched(paths.asar);
  const needBackup = !fs.existsSync(paths.orig)
    || (!currentIsOurs && sha256File(paths.orig) !== curSha);
  // 若 .orig 已存在且无需刷新（重装/force），它是真正的原版指纹；否则备份后 .orig == 当前 asar
  const origSha = needBackup ? built.sha256Orig : sha256File(paths.orig);
  const appVersion = readAppVersion(paths);
  const record = {
    monitorVersion: MONITOR_VERSION,
    appVersion,
    asarSha256Orig: origSha,
    asarSha256Patched: built.sha256New,
    unpacked: true,
    port,
    patchedAt: new Date(now()).toISOString(),
  };

  // ---- 落盘（幂等序列）
  const hasNewUnpacked = fs.existsSync(path.join(outDir, 'app.asar.new.unpacked'));
  if (writableTarget(paths)) {
    try {
      persistWritable({ paths, outDir, needBackup, hasNewUnpacked });
    } catch (e) {
      log(`落盘失败：${(e && e.message) || e}`);
      return { code: 1 };
    }
    uncacheAsar(paths.asar);
    log('落盘完成（目标可写，直接写入）');
  } else {
    const cmds = persistCommands({ paths, outDir, needBackup, hasNewUnpacked });
    try {
      await elevate(cmds);
      uncacheAsar(paths.asar);
      log('落盘完成（提权）');
    } catch (e) {
      atomicWrite(pendingPath(), JSON.stringify({
        sha256New: built.sha256New,
        sha256Orig: origSha,
        port,
        outDir,
        appVersion,
        monitorVersion: MONITOR_VERSION,
        bootstrapCode, // --finish 落盘新凭据（与产物内嵌码一致）
        reason: String((e && e.message) || e),
      }, null, 2) + '\n');
      printManualCommands(
        log,
        `目标不可写且提权失败（${(e && e.message) || e}）。本工具不会自动执行 sudo。请按顺序手动执行以下 ${cmds.length} 步：`,
        cmds,
        '完成后运行：node scripts/install.mjs --finish 补写状态',
      );
      return { code: 2, manualCommands: cmds };
    }
  }

  // ---- 状态 + daemon + repo-path（Task 11 Step 4.6：hook 读它定位 daemon）+ 提示
  savePatchState(record);
  clearPending();
  writeRepoPath(REPO);
  // 凭据轮换：新 asar 的 loader 内嵌新 bootstrap；旧 daemon 内存里是旧码 → 必须换进程。
  // token 一并作废（删文件，initAuth 启动时生成新值），历史/配额数据不动。
  const daemonWasRunning = !!(await probe(port));
  saveBootstrap(bootstrapCode);
  clearToken();
  if (daemonWasRunning) await killDaemon({ port });
  if (daemonWasRunning && !(await waitDaemonDown(probe, port))) {
    log(`警告：端口 ${port} 上旧 daemon 未在 3s 内退出，若新进程未接管请手动重启`);
  }
  await spawnDaemon({ port, args: daemonArgs(port), daemonScript: DAEMON_SCRIPT });
  log('已轮换 bootstrap/token（旧凭据失效）');
  log('重启客户端生效（不自动重启）');
  return { code: 0, state: record };
}

// ---------------------------------------------------------------- runFinish

/** --finish：手动 4 步之后，校验当前 asar == 生成的 sha256New，仅补写状态与后续。 */
export async function runFinish(opts = {}) {
  const log = opts.log || ((m) => console.log(m));
  const now = opts.now || Date.now;
  const spawnDaemon = opts.spawnDaemon || makeSpawnDaemon(log);
  const killDaemon = opts.killDaemon || defaultKillDaemon;
  const probe = opts.probeHealth || defaultDaemonProbe;
  const writeRepoPath = opts.writeRepoPath || saveRepoPath;
  const paths = targetPaths(opts.asarPath || appAsarPath());

  const pending = loadPending();
  if (!pending || typeof pending.sha256New !== 'string') {
    log('没有待完成的安装（pending-install.json 缺失或损坏）。请先运行 install。');
    return { code: 1 };
  }
  if (!fs.existsSync(paths.asar)) {
    log(`未找到 ${paths.asar}，手动替换尚未完成。`);
    return { code: 1 };
  }
  const cur = sha256File(paths.asar);
  if (cur !== pending.sha256New) {
    log(`校验失败：当前 app.asar sha256 与待完成补丁不一致（手动步骤未完成或有出入）。\n  期望 ${pending.sha256New}\n  当前 ${cur}`);
    return { code: 1 };
  }
  const record = {
    monitorVersion: pending.monitorVersion || MONITOR_VERSION,
    appVersion: pending.appVersion || 'unknown',
    asarSha256Orig: fs.existsSync(paths.orig) ? sha256File(paths.orig) : pending.sha256Orig,
    asarSha256Patched: pending.sha256New,
    unpacked: true,
    port: Number(pending.port) || DEFAULT_PORT,
    patchedAt: new Date(now()).toISOString(),
  };
  uncacheAsar(paths.asar); // 手动替换过的文件：丢弃任何陈旧 header 缓存
  savePatchState(record);
  clearPending();
  writeRepoPath(REPO); // --finish 成功路径同样写 repo-path（与 runInstall 双覆盖）
  // 手动替换完成 → 补写与产物一致的凭据并重启 daemon（旧格式 pending 无 code：保持原凭据）。
  if (typeof pending.bootstrapCode === 'string' && /^[0-9a-f]{16}$/.test(pending.bootstrapCode)) {
    const daemonWasRunning = !!(await probe(record.port));
    saveBootstrap(pending.bootstrapCode);
    clearToken();
    if (daemonWasRunning) await killDaemon({ port: record.port });
    if (daemonWasRunning && !(await waitDaemonDown(probe, record.port))) {
      log(`警告：端口 ${record.port} 上旧 daemon 未在 3s 内退出，若新进程未接管请手动重启`);
    }
    await spawnDaemon({ port: record.port, args: daemonArgs(record.port), daemonScript: DAEMON_SCRIPT });
    log('已轮换 bootstrap/token（旧凭据失效）');
  } else {
    await spawnDaemon({ port: record.port, args: daemonArgs(record.port), daemonScript: DAEMON_SCRIPT });
  }
  log('状态已补写（--finish）');
  log('重启客户端生效（不自动重启）');
  return { code: 0, state: record };
}

// ---------------------------------------------------------------- CLI

export function parseCliArgs(argv) {
  const out = { port: undefined, finish: false, force: false, skipPreflight: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a.startsWith('--port=')) out.port = Number(a.slice(7));
    else if (a === '--finish') out.finish = true;
    else if (a === '--force') out.force = true;
    else if (a === '--skip-preflight') out.skipPreflight = true;
  }
  if (out.port !== undefined && (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535)) {
    console.error(`install: invalid --port ${String(out.port)}`);
    process.exit(1);
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  const args = parseCliArgs(process.argv.slice(2));
  const r = args.finish
    ? await runFinish({ port: args.port })
    : await runInstall({ port: args.port, force: args.force, skipPreflight: args.skipPreflight });
  process.exit(r.code);
}
