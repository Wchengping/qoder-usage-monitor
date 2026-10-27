// tests/install.test.mjs
// Task 7 orchestration tests — the 5-item acceptance contract from the brief.
// Everything runs against FAKE asars under os.tmpdir() via QUM_APP_ASAR + QUM_HOME
// env overrides; these tests NEVER touch /opt, NEVER execute sudo/pkexec
// (CLI honors QUM_ELEVATE_TEST=fail|ok) and NEVER launch a real detached daemon
// (CLI honors QUM_SPAWN_DAEMON_TEST=skip on every subprocess call).
import test from 'node:test';
import assert from 'node:assert/strict';
import asar from '@electron/asar';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { runInstall, runFinish, runningClientPid } from '../scripts/install.mjs';
import { runUninstall } from '../scripts/uninstall.mjs';
import { runCheckUpdate } from '../scripts/check-update.mjs';
import { resourcesDir, defaultResourcesDir, targetPaths, sha256File } from '../scripts/lib/asarPaths.mjs';
import { verifyPatched } from '../scripts/asarPipeline.mjs';

const REPO = path.resolve(import.meta.dirname, '..');
const scenarios = [];

test.after(() => {
  // Deterministic order: kill any daemon on the dedicated test port FIRST (a live
  // daemon lazily re-mkdirs its QUM_HOME, which would resurrect tmp dirs we delete),
  // then tear down the scenario dirs. Pattern covers both the --ensure wrapper
  // (server.mjs --ensure --port N …) and the keep-alive grandchild (server.mjs --port N).
  spawnSync('pkill', ['-f', `server\\.mjs.*--port ${TEST_PORT}`]);
  for (const sc of scenarios) {
    try { fs.chmodSync(sc.res, 0o755); } catch { /* best effort */ }
    try { fs.rmSync(sc.root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

const TEST_PORT = 49857; // dedicated rare port so preflight/health never collide

// Minimal fake-client scenario, same shape as tests/asarPipeline.test.mjs:
// out/renderer/index.html carries the SAMPLE CSP meta; one native file is
// unpacked at file level. resources/ also holds app-update.yml (appVersion source).
async function mkScenario() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qumi-'));
  const res = path.join(root, 'resources');
  fs.mkdirSync(res, { recursive: true });
  const src = path.join(root, 'src');
  fs.mkdirSync(path.join(src, 'out/renderer'), { recursive: true });
  fs.writeFileSync(path.join(src, 'out/renderer/index.html'),
    `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self';"/>
<script type="module" src="./assets/main.js"></script></head><body></body>`);
  fs.mkdirSync(path.join(src, 'node_modules/native'), { recursive: true });
  fs.writeFileSync(path.join(src, 'node_modules/native/binding.node'), 'BIN');
  const a = path.join(res, 'app.asar');
  await asar.createPackageWithOptions(src, a, { unpack: '**/node_modules/native/binding.node' });
  fs.writeFileSync(path.join(res, 'app-update.yml'), 'owner: qoder\nversion: 1.2.3\n');
  const pristine = path.join(root, 'pristine.asar');
  fs.copyFileSync(a, pristine);
  const widgetDir = path.join(root, 'widget');
  fs.mkdirSync(widgetDir, { recursive: true });
  fs.writeFileSync(path.join(widgetDir, 'widget.js'), '/*widget*/');
  fs.writeFileSync(path.join(widgetDir, 'widget.css'), '/*css*/');
  const sc = {
    root, res, asar: a, orig: a + '.orig', unpacked: path.join(res, 'app.asar.unpacked'),
    pristine, origHash: sha256File(a), home: path.join(root, 'home'),
    outDir: path.join(root, 'build'), widgetDir,
  };
  scenarios.push(sc);
  return sc;
}

function useEnv(sc) {
  process.env.QUM_APP_ASAR = sc.asar;
  process.env.QUM_HOME = sc.home;
}

const failElevate = () => { throw new Error('no tty / auth denied (test fake)'); };
const collect = () => { const out = []; return { out, log: (m) => out.push(String(m)) }; };

// ---------------------------------------------------------------- contract 1
test('install with writable target reaches patched state without elevation', async () => {
  const sc = await mkScenario();
  useEnv(sc);
  const { out, log } = collect();
  let spawned = null;
  const r = await runInstall({
    port: TEST_PORT, outDir: sc.outDir, widgetFilesDir: sc.widgetDir,
    elevate: failElevate, // must never be reached on a writable target
    spawnDaemon: (opts) => { spawned = opts; },
    diskFreeBytes: () => 3e9,
    log,
  });
  assert.equal(r.code, 0, out.join('\n'));

  // app.asar replaced in place and is the patched artifact
  assert.equal(verifyPatched(sc.asar), true);
  // 权限：内嵌 bootstrap 的 asar 与构建产物都只允许属主读（阻断同机其他用户换 token）
  assert.equal(fs.statSync(sc.asar).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(sc.outDir, 'app.asar.new')).mode & 0o777, 0o600);
  // .orig backup exists and fingerprints the pristine asar
  assert.ok(fs.existsSync(sc.orig));
  assert.equal(sha256File(sc.orig), sc.origHash);

  // patch-state.json: exact field set, hashes consistent
  const state = JSON.parse(fs.readFileSync(path.join(sc.home, 'patch-state.json'), 'utf8'));
  assert.deepEqual(Object.keys(state).sort(),
    ['appVersion', 'asarSha256Orig', 'asarSha256Patched', 'monitorVersion', 'patchedAt', 'port', 'unpacked']);
  assert.equal(state.asarSha256Orig, sc.origHash);
  assert.equal(state.asarSha256Patched, sha256File(sc.asar));
  assert.equal(state.appVersion, '1.2.3'); // from resources/app-update.yml
  assert.equal(state.port, TEST_PORT);
  assert.equal(state.unpacked, true);
  assert.match(state.monitorVersion, /^\d+\.\d+\.\d+/);
  assert.ok(!Number.isNaN(Date.parse(state.patchedAt)));

  // unpacked native dir landed next to the asar
  assert.ok(fs.existsSync(path.join(sc.unpacked, 'node_modules', 'native', 'binding.node')));

  // bootstrap code: exactly 16 hex chars in QUM_HOME
  const boot = JSON.parse(fs.readFileSync(path.join(sc.home, 'bootstrap.json'), 'utf8'));
  assert.match(boot.code, /^[0-9a-f]{16}$/);

  // Task 11: repo-path（一行仓库绝对路径）落盘——SessionStart hook 靠它定位 daemon
  assert.equal(fs.readFileSync(path.join(sc.home, 'repo-path'), 'utf8').trim(), REPO);

  // daemon ensure-spawned with the qum-daemon role marker + restart hint
  assert.ok(spawned && spawned.port === TEST_PORT);
  assert.ok(spawned.args.includes('--ensure'));
  assert.ok(spawned.args.some((a) => String(a).includes('--qm-role')));
  assert.ok(out.some((l) => l.includes('重启客户端生效（不自动重启）')));

  // re-run without --force → already-installed short circuit, exit code 0
  const r2 = await runInstall({
    port: TEST_PORT, outDir: sc.outDir, widgetFilesDir: sc.widgetDir,
    elevate: failElevate, spawnDaemon: () => {}, diskFreeBytes: () => 3e9, log: () => {},
  });
  assert.equal(r2.code, 0);
  assert.equal(r2.alreadyInstalled, true);
});

// ---------------------------------------------------------------- contract 2
test('CLI: QUM_ELEVATE_TEST=fail + non-writable target → exit 2 with sudo cp block', async () => {
  const sc = await mkScenario();
  fs.chmodSync(sc.res, 0o555); // directory not writable by us → elevation required
  const r = spawnSync(process.execPath, [path.join(REPO, 'scripts/install.mjs'), '--port', String(TEST_PORT)], {
    env: {
      ...process.env, QUM_APP_ASAR: sc.asar, QUM_HOME: sc.home,
      QUM_ELEVATE_TEST: 'fail', QUM_SPAWN_DAEMON_TEST: 'skip', QUM_WIDGET_DIR: sc.widgetDir,
    },
    encoding: 'utf8', timeout: 120_000,
  });
  fs.chmodSync(sc.res, 0o755);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /sudo cp -a/); // copy-pasteable 4-step manual block
  assert.match(r.stdout, /sudo chmod 600/);
  assert.match(r.stdout, /--finish/);
  // nothing landed on the protected target, resume state was persisted
  assert.equal(sha256File(sc.asar), sc.origHash);
  assert.ok(!fs.existsSync(sc.orig));
  const pending = JSON.parse(fs.readFileSync(path.join(sc.home, 'pending-install.json'), 'utf8'));
  assert.match(pending.sha256New, /^[0-9a-f]{64}$/);
  assert.equal(pending.port, TEST_PORT);
});

// ---------------------------------------------------------------- contract 3
test('CLI: manual placement then --finish writes state only, exit 0, no real daemon', async () => {
  const sc = scenarios[1]; // resume the scenario from contract 2
  const build = path.join(sc.home, 'build'); // installer default outDir
  // simulate the user having run the printed manual block (sudo redline: we do it
  // ourselves on the now-writable dir, NOT via sudo)
  fs.copyFileSync(sc.asar, sc.orig);
  fs.copyFileSync(path.join(build, 'app.asar.new'), sc.asar);
  fs.cpSync(path.join(build, 'app.asar.new.unpacked'), sc.unpacked, { recursive: true });
  const cliEnv = {
    ...process.env, QUM_APP_ASAR: sc.asar, QUM_HOME: sc.home,
    QUM_SPAWN_DAEMON_TEST: 'skip', // subprocess CLI must never launch the real daemon
  };
  const r = spawnSync(process.execPath, [path.join(REPO, 'scripts/install.mjs'), '--finish'], {
    env: cliEnv, encoding: 'utf8', timeout: 120_000,
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  // the skip hook was exercised: --finish completed its daemon step as a no-op…
  assert.match(r.stdout, /QUM_SPAWN_DAEMON_TEST=skip/);
  // …and really no daemon exists: pgrep must find neither the --ensure wrapper
  // nor a keep-alive grandchild on the test port (pre-fix this leaked a real one).
  const pg = spawnSync('pgrep', ['-f', `server\\.mjs.*--port ${TEST_PORT}`], { encoding: 'utf8' });
  assert.equal(pg.status, 1, `daemon process leaked: ${pg.stdout.trim()}`);
  const state = JSON.parse(fs.readFileSync(path.join(sc.home, 'patch-state.json'), 'utf8'));
  assert.equal(state.asarSha256Patched, sha256File(sc.asar));
  assert.equal(state.asarSha256Orig, sc.origHash);
  assert.equal(state.port, TEST_PORT);
  // Task 11: --finish 成功路径同样写 repo-path（两条成功路径都要覆盖，hook 保活依赖）
  assert.equal(fs.readFileSync(path.join(sc.home, 'repo-path'), 'utf8').trim(), REPO);
  assert.ok(!fs.existsSync(path.join(sc.home, 'pending-install.json')));
  assert.match(r.stdout, /重启客户端生效/);
  // --finish without pending state → error, exit 1
  const r2 = spawnSync(process.execPath, [path.join(REPO, 'scripts/install.mjs'), '--finish'], {
    env: cliEnv, encoding: 'utf8', timeout: 120_000,
  });
  assert.equal(r2.status, 1);
});

// ---------------------------------------------------------------- contract 4
test('check-update reports the three states with exit codes 0/10/20', async () => {
  const sc = await mkScenario();
  useEnv(sc);
  const down = async () => false;
  const { log } = collect();
  const r = await runInstall({
    port: TEST_PORT, outDir: sc.outDir, widgetFilesDir: sc.widgetDir,
    elevate: failElevate, spawnDaemon: () => {}, diskFreeBytes: () => 3e9, log,
  });
  assert.equal(r.code, 0);

  let cu = await runCheckUpdate({ probeHealth: down, log: () => {} });
  assert.equal(cu.code, 0);
  assert.equal(cu.json.status, 'patched');
  assert.equal(cu.json.daemon.running, false);

  // client update overwrote the patched asar: current == .orig, orig still present
  fs.copyFileSync(sc.pristine, sc.asar);
  cu = await runCheckUpdate({ probeHealth: down, log: () => {} });
  assert.equal(cu.code, 10);
  assert.equal(cu.json.status, 'overwritten-by-update');

  // never-installed shape: no .orig at all
  fs.rmSync(sc.orig);
  fs.copyFileSync(sc.pristine, sc.asar);
  fs.rmSync(path.join(sc.home, 'patch-state.json'));
  cu = await runCheckUpdate({ probeHealth: down, log: () => {} });
  assert.equal(cu.code, 20);
  assert.equal(cu.json.status, 'unpatched');

  // documented edge: patch-state.json missing but asar IS patched (marker found) → patched
  const scB = await mkScenario();
  useEnv(scB);
  const rB = await runInstall({
    port: TEST_PORT, outDir: scB.outDir, widgetFilesDir: scB.widgetDir,
    elevate: failElevate, spawnDaemon: () => {}, diskFreeBytes: () => 3e9, log: () => {},
  });
  assert.equal(rB.code, 0);
  fs.rmSync(path.join(scB.home, 'patch-state.json'));
  cu = await runCheckUpdate({ probeHealth: down, log: () => {} });
  assert.equal(cu.json.status, 'patched');
  assert.equal(cu.code, 0);
});

// ---------------------------------------------------------------- contract 5
test('uninstall restores .orig (hash==orig after), kills daemon, keeps history', async () => {
  const sc = await mkScenario();
  useEnv(sc);
  fs.mkdirSync(sc.home, { recursive: true });
  fs.writeFileSync(path.join(sc.home, 'history.jsonl'), '{"date":"2026-10-10"}\n');
  const { out, log } = collect();
  const ins = await runInstall({
    port: TEST_PORT, outDir: sc.outDir, widgetFilesDir: sc.widgetDir,
    elevate: failElevate, spawnDaemon: () => {}, diskFreeBytes: () => 3e9, log,
  });
  assert.equal(ins.code, 0);
  // Final-review Fix#1 fixture: install 已写 repo-path（SessionStart hook 靠它保活）；
  // 显式落盘一份，确保断言检测的是 uninstall 删除行为而非 install 副作用缺失。
  fs.writeFileSync(path.join(sc.home, 'repo-path'), `${REPO}\n`);
  // 安装已轮换成新凭据；补一枚 token 模拟 daemon 运行期产物，卸载后两者都不得残留
  fs.writeFileSync(path.join(sc.home, 'daemon.token'), 'f'.repeat(64), { mode: 0o600 });
  assert.ok(fs.existsSync(path.join(sc.home, 'bootstrap.json')));

  let killedPort = null;
  const un = await runUninstall({
    port: TEST_PORT,
    elevate: failElevate, // writable target → must never elevate
    killDaemon: (opts) => { killedPort = opts.port; },
    log,
  });
  assert.equal(un.code, 0, out.join('\n'));
  assert.equal(sha256File(sc.asar), sc.origHash); // restored
  assert.ok(!fs.existsSync(sc.orig)); // .orig consumed
  assert.ok(!fs.existsSync(path.join(sc.home, 'patch-state.json')));
  assert.equal(killedPort, TEST_PORT);
  // safety redline: history dir survives uninstall, only reported
  assert.equal(fs.readFileSync(path.join(sc.home, 'history.jsonl'), 'utf8').trim(), '{"date":"2026-10-10"}');
  // 凭据随卸载清除：daemon 已停，残留的 bootstrap/token 只会成为可被同机进程利用的后门
  assert.ok(!fs.existsSync(path.join(sc.home, 'bootstrap.json')), 'bootstrap must be removed on uninstall');
  assert.ok(!fs.existsSync(path.join(sc.home, 'daemon.token')), 'daemon token must be removed on uninstall');
  assert.ok(out.some((l) => l.includes('历史') && l.includes(sc.home)));
  // Final-review Fix#1: repo-path 必删（否则 cli-plugin SessionStart hook 每次新会话
  // 都会 --ensure 复活 daemon），且打印手动移除插件的提示
  assert.ok(!fs.existsSync(path.join(sc.home, 'repo-path')), 'repo-path must be gone after uninstall');
  assert.ok(out.some((l) => l.includes('还需手动移除 CLI 插件')), 'uninstall must print cli-plugin hook notice');

  // hash == orig with .orig present → 已被更新覆盖，无需恢复 (still exit 0, no restore)
  const sc2 = await mkScenario();
  useEnv(sc2);
  fs.copyFileSync(sc2.asar, sc2.orig); // .orig sits next to an unpatched current asar
  fs.mkdirSync(sc2.home, { recursive: true });
  fs.writeFileSync(path.join(sc2.home, 'repo-path'), `${REPO}\n`); // 保活钩子残留：no-restore 路径同样要拆
  fs.writeFileSync(path.join(sc2.home, 'bootstrap.json'), JSON.stringify({ code: 'a'.repeat(16) }));
  fs.writeFileSync(path.join(sc2.home, 'daemon.token'), 'b'.repeat(64));
  const { out: out2, log: log2 } = collect();
  const un2 = await runUninstall({ port: TEST_PORT, elevate: failElevate, killDaemon: () => {}, log: log2 });
  assert.equal(un2.code, 0);
  assert.ok(out2.some((l) => l.includes('已被更新覆盖，无需恢复')));
  assert.equal(sha256File(sc2.asar), sc2.origHash);
  assert.ok(!fs.existsSync(path.join(sc2.home, 'repo-path')), 'repo-path must be gone on no-restore path');
  assert.ok(!fs.existsSync(path.join(sc2.home, 'bootstrap.json')), 'no-restore path must clear credentials too');
  assert.ok(!fs.existsSync(path.join(sc2.home, 'daemon.token')), 'no-restore path must clear token too');
  assert.ok(out2.some((l) => l.includes('还需手动移除 CLI 插件')), 'no-restore path must print the notice too');

  // neither patched nor matching .orig fingerprint and no marker → error, don't guess
  const sc3 = await mkScenario();
  useEnv(sc3);
  const { log: log3 } = collect();
  const un3 = await runUninstall({ port: TEST_PORT, elevate: failElevate, killDaemon: () => {}, log: log3 });
  assert.equal(un3.code, 1);

  // non-writable target + genuinely patched asar on disk → elevate is attempted,
  // fails once → exit 2 with a sudo restore block, nothing changed
  const sc4 = await mkScenario();
  useEnv(sc4);
  const ins4 = await runInstall({
    port: TEST_PORT, outDir: sc4.outDir, widgetFilesDir: sc4.widgetDir,
    elevate: failElevate, spawnDaemon: () => {}, diskFreeBytes: () => 3e9, log: () => {},
  });
  assert.equal(ins4.code, 0);
  fs.chmodSync(sc4.res, 0o555);
  const { out: out4, log: log4 } = collect();
  const un4 = await runUninstall({ port: TEST_PORT, elevate: failElevate, killDaemon: () => {}, log: log4 });
  fs.chmodSync(sc4.res, 0o755);
  assert.equal(un4.code, 2);
  assert.match(out4.join('\n'), /sudo cp -a/);
  assert.equal(verifyPatched(sc4.asar), true); // untouched by the failed attempt
  assert.ok(fs.existsSync(sc4.orig));
  assert.ok(fs.existsSync(path.join(sc4.home, 'patch-state.json')));

  // elevate success branch (QUM_ELEVATE_TEST=ok complement): non-writable target,
  // fake elevate captures the privileged command list and install completes.
  const sc5 = await mkScenario();
  useEnv(sc5);
  fs.chmodSync(sc5.res, 0o555);
  const cmdsSeen = [];
  const ins5 = await runInstall({
    port: TEST_PORT, widgetFilesDir: sc5.widgetDir,
    elevate: (cmds) => { cmdsSeen.push(cmds); },
    spawnDaemon: () => {}, diskFreeBytes: () => 3e9, log: () => {},
  });
  fs.chmodSync(sc5.res, 0o755);
  assert.equal(ins5.code, 0);
  assert.equal(cmdsSeen.length, 1);
  const flat = cmdsSeen[0].map((c) => c.join(' ')).join('\n');
  assert.match(flat, /cp -a .*/);
  assert.match(flat, /chmod 600/);
  assert.ok(fs.existsSync(path.join(sc5.home, 'patch-state.json')));
  assert.ok(!fs.existsSync(path.join(sc5.home, 'pending-install.json')));
});

// ---------------------------------------------------------------- Task 8 wiring
test('install feeds <widgetFilesDir>/loader.js into renderLoader as implBody', async () => {
  const sc = await mkScenario();
  useEnv(sc);
  // 真实约定：app/loader.js 是模板体（IIFE 内可用 return），不是完整模块文件。
  fs.writeFileSync(path.join(sc.widgetDir, 'loader.js'),
    "if (window.location.search.includes('surface=')) return; /*QUM-TEST-LOADER-BODY*/");
  const { out, log } = collect();
  const r = await runInstall({
    port: TEST_PORT, outDir: sc.outDir, widgetFilesDir: sc.widgetDir,
    elevate: failElevate, spawnDaemon: () => {}, diskFreeBytes: () => 3e9, log,
  });
  assert.equal(r.code, 0, out.join('\n'));
  const loader = asar.extractFile(sc.asar, 'out/renderer/monitor/loader.js').toString();
  assert.match(loader, /QUM-TEST-LOADER-BODY/); // 模板体被注入
  assert.match(loader, /surface=/);
  assert.match(loader, /const QUM_BOOTSTRAP = "[0-9a-f]{16}";/); // 模板常量包裹仍在
  assert.match(loader, new RegExp(`const QUM_PORT = ${TEST_PORT};`)); // 常量区仍由模板生成
  assert.doesNotMatch(loader, /qum loader stub/); // Task 8 起占位 stub 不再出现
});

// ---------------------------------------------------------------- lib sanity
test('asarPaths honors QUM_APP_ASAR and defaults to the detected /opt layout (never touched)', () => {
  const sc = { asar: '/tmp/x/resources/app.asar' };
  process.env.QUM_APP_ASAR = sc.asar;
  assert.equal(resourcesDir(), path.join('/tmp/x', 'resources'));
  const tp = targetPaths();
  assert.equal(tp.asar, sc.asar);
  assert.equal(tp.orig, sc.asar + '.orig');
  assert.equal(tp.unpacked, sc.asar + '.unpacked');
  delete process.env.QUM_APP_ASAR;
  // 2026-10-23：0.4.9 安装目录迁移 /opt/Qoder CN → /opt/Qoder-CN，按 app.asar 存在性回退。
  assert.equal(defaultResourcesDir(() => true), '/opt/Qoder-CN/resources');
  assert.equal(defaultResourcesDir((p) => p === '/opt/Qoder CN/resources/app.asar'), '/opt/Qoder CN/resources');
  assert.equal(defaultResourcesDir(() => false), '/opt/Qoder-CN/resources');
});

// ---------------------------------------------------------------- 自动更新陈旧 .orig（2026-10-12 真机事故）
// 事故形态：安装后客户端 auto-update 用新版 stock 替换 app.asar（.orig 仍是旧版指纹）。
// 旧 needBackup 只看 .orig 是否存在 → 不刷新 → 之后 uninstall 会把客户端回滚到旧版本。
// 契约：当前 asar 不是本工具补丁（hash≠patch-state 且无 qum 标记）且 ≠ .orig →
// 重新安装必须把 .orig 刷新为当前 stock；卸载恢复出的必须是新版 stock。
test('install after client auto-update refreshes stale .orig; uninstall restores NEW stock, no version rollback', async () => {
  const sc = await mkScenario();
  useEnv(sc);
  const install = () => runInstall({
    port: TEST_PORT, outDir: sc.outDir, widgetFilesDir: sc.widgetDir,
    elevate: failElevate, spawnDaemon: () => {}, diskFreeBytes: () => 3e9, log: () => {},
  });
  let r = await install();
  assert.equal(r.code, 0);
  const boot0 = JSON.parse(fs.readFileSync(path.join(sc.home, 'bootstrap.json'), 'utf8')).code;
  assert.match(boot0, /^[0-9a-f]{16}$/);

  // 无更新的普通 --force 重打：当前是本工具补丁 → .orig 保留 pristine 指纹（不误刷新）
  r = await install();
  assert.equal(r.code, 0);
  assert.equal(sha256File(sc.orig), sc.origHash, 'force 重打不得改动 .orig');
  assert.equal(JSON.parse(fs.readFileSync(path.join(sc.home, 'bootstrap.json'), 'utf8')).code, boot0,
    'already-installed 短路不得轮换凭据（没有新产物需要匹配）');

  // 模拟客户端 auto-update：新 stock asar（不同内容）覆盖当前文件，.orig 留下旧指纹
  const src2 = path.join(sc.root, 'src2');
  fs.mkdirSync(path.join(src2, 'out/renderer'), { recursive: true });
  fs.writeFileSync(path.join(src2, 'out/renderer/index.html'),
    `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self';"/>
<script type="module" src="./assets/main-v2.js"></script></head><body></body>`);
  fs.mkdirSync(path.join(src2, 'node_modules/native'), { recursive: true });
  fs.writeFileSync(path.join(src2, 'node_modules/native/binding.node'), 'BIN2');
  await asar.createPackageWithOptions(src2, sc.asar, { unpack: '**/node_modules/native/binding.node' });
  const newStock = sha256File(sc.asar);
  assert.notEqual(newStock, sc.origHash, 'fixture: 新 stock ≠ 旧 pristine');
  assert.notEqual(newStock, sha256File(sc.orig), 'fixture: .orig 已陈旧');

  // 重新安装 → .orig 必须刷新为新 stock，patch-state 记录新 stock 指纹
  r = await install();
  assert.equal(r.code, 0);
  assert.equal(verifyPatched(sc.asar), true, '当前 asar 应为补丁态');
  assert.equal(sha256File(sc.orig), newStock, '.orig 必须刷新为更新后的 stock（否则卸载回滚版本）');
  const st = JSON.parse(fs.readFileSync(path.join(sc.home, 'patch-state.json'), 'utf8'));
  assert.equal(st.asarSha256Orig, newStock);
  // 每次真实重装都轮换 bootstrap：旧产物/旧备份里泄露的码不能继续换 token
  const boot1 = JSON.parse(fs.readFileSync(path.join(sc.home, 'bootstrap.json'), 'utf8')).code;
  assert.notEqual(boot1, boot0, '重新安装必须轮换 bootstrap');
  const loaderTxt = asar.extractFile(sc.asar, 'out/renderer/monitor/loader.js').toString();
  assert.match(loaderTxt, new RegExp(`const QUM_BOOTSTRAP = "${boot1}";`), '新产物必须内嵌新码');

  // 卸载 → 恢复出的必须是新版 stock（版本不回滚）
  const un = await runUninstall({
    port: TEST_PORT, elevate: failElevate, killDaemon: () => {}, log: () => {},
  });
  assert.equal(un.code, 0);
  assert.equal(sha256File(sc.asar), newStock, '卸载恢复新版 stock，绝不回滚到旧版本');
});

// ---------------------------------------------------------------- 落盘闸门（2026-10-23 真机事故回归）
// 事故：客户端运行中 cp 覆盖 app.asar（同一 inode）→ 运行实例读到错乱归档 →
// 关闭流程卡死 → 单实例锁被占 → 再启动被转发 → 表现为"打不开"。
test('runningClientPid: 无锁 → 未运行；陈旧锁 → 未运行；活锁 → 返回 pid', async () => {
  const sc = await mkScenario();
  fs.writeFileSync(path.join(sc.res, 'product.json'),
    JSON.stringify({ dataDirectoryName: 'com.qum.regress' }));
  const paths = targetPaths(sc.asar);
  const oldHome = process.env.HOME;
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'qumh-'));
  process.env.HOME = fakeHome; // appUserDataDir 走 os.homedir() → $HOME
  try {
    assert.equal(runningClientPid(paths), null, '没有 SingletonLock → 视为未运行');
    const dir = path.join(fakeHome, '.config', 'com.qum.regress');
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync('7090-999999', path.join(dir, 'SingletonLock'));
    assert.equal(runningClientPid(paths), null, '陈旧锁（pid 已不存在）→ 安全放行');
    fs.unlinkSync(path.join(dir, 'SingletonLock'));
    fs.symlinkSync(`7090-${process.pid}`, path.join(dir, 'SingletonLock'));
    assert.equal(runningClientPid(paths), process.pid, '活锁 → 必须拦住落盘');
  } finally {
    process.env.HOME = oldHome;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('可写目标落盘用 rename 换 inode（不再就地覆盖同一 inode）', async () => {
  const sc = await mkScenario();
  useEnv(sc);
  const inodeBefore = fs.statSync(sc.asar).ino;
  const r = await runInstall({
    asarPath: sc.asar, port: TEST_PORT, force: true, elevate: failElevate,
    spawnDaemon: () => {}, diskFreeBytes: () => 3e9, log: () => {},
  });
  assert.equal(r.code, 0, '落盘应成功');
  assert.notEqual(fs.statSync(sc.asar).ino, inodeBefore, '必须是新 inode 的原子替换');
  assert.equal(fs.existsSync(sc.asar + '.qum-new'), false, '暂存文件应已被 mv 掉');
});
