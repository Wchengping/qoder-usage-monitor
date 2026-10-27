// tests/doctor.test.mjs
// Task 11 — doctor.mjs 8 项自检 + 退出码 0/10/20 + --json 形状 + --show-quota-raw 脱敏。
// 全部跑在 os.tmpdir() 假树（QUM_APP_ASAR + QUM_HOME），探针默认依赖注入（DI）保持快速、
// 确定性；仅一个真实 daemon E2E（测试端口 49866，SIGTERM 杀进程、pgrep 零残留）。
// 永不触碰 /opt、真实 ~/.qoder-monitor、不执行 sudo。
import test from 'node:test';
import assert from 'node:assert/strict';
import asar from '@electron/asar';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { runInstall } from '../scripts/install.mjs';
import { runDoctor, redactRawText, quotaRawPreview, quotaParsePreview, CHECK_NAMES } from '../scripts/doctor.mjs';
import { sha256File } from '../scripts/lib/asarPaths.mjs';
import { home } from '../daemon/store.mjs';

const REPO = path.resolve(import.meta.dirname, '..');
const DIAG_PORT = 49865; // 无真实 daemon 的诊断场景专用端口（探测即时 ECONNREFUSED）
const E2E_PORT = 49866;  // 唯一真实 daemon E2E

const scenarios = [];
test.after(() => {
  spawnSync('pkill', ['-f', `server\\.mjs.*--port ${E2E_PORT}`]);
  for (const sc of scenarios) {
    try { fs.rmSync(sc.root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

async function mkScenario() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qumd-'));
  const res = path.join(root, 'resources');
  fs.mkdirSync(res, { recursive: true });
  const src = path.join(root, 'src');
  fs.mkdirSync(path.join(src, 'out/renderer'), { recursive: true });
  fs.writeFileSync(path.join(src, 'out/renderer/index.html'),
    `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self';"/>
<script type="module" src="./assets/main.js"></script></head><body></body>`);
  const a = path.join(res, 'app.asar');
  await asar.createPackage(src, a);
  fs.writeFileSync(path.join(res, 'app-update.yml'), 'owner: qoder\nversion: 1.2.3\n');
  const pristine = path.join(root, 'pristine.asar');
  fs.copyFileSync(a, pristine);
  const widgetDir = path.join(root, 'widget');
  fs.mkdirSync(widgetDir, { recursive: true });
  fs.writeFileSync(path.join(widgetDir, 'widget.js'), '/*widget*/');
  fs.writeFileSync(path.join(widgetDir, 'widget.css'), '/*css*/');
  const sc = {
    root, res, asar: a, orig: a + '.orig', pristine,
    home: path.join(root, 'home'), outDir: path.join(root, 'build'), widgetDir,
  };
  scenarios.push(sc);
  return sc;
}

/** 安装出 patched asar + patch-state.json + bootstrap.json（均经真实 runInstall，daemon spawn 注入 noop）。 */
async function installInto(sc) {
  process.env.QUM_APP_ASAR = sc.asar;
  process.env.QUM_HOME = sc.home;
  const r = await runInstall({
    port: DIAG_PORT, outDir: sc.outDir, widgetFilesDir: sc.widgetDir,
    elevate: () => { throw new Error('must not elevate'); },
    spawnDaemon: () => {}, diskFreeBytes: () => 3e9, log: () => {},
  });
  assert.equal(r.code, 0);
  return r;
}

function writePrivate(name, content) {
  const p = path.join(home(), name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, { mode: 0o600 });
  fs.chmodSync(p, 0o600);
  return p;
}

function stateJson({ fetchedAt, scanErrors = [], account = {}, raw = undefined } = {}) {
  return JSON.stringify({
    meta: { generatedAt: Date.now(), daemonVersion: '0.1.0', scanErrors },
    local: { window5h: null, week: null, today: null, history: [] },
    account: account === null ? null : { source: 'widget', fetchedAt, raw: raw ?? { plan: { plan_tier: 'pro' } }, planRem: 1000, packRem: 300, packs: [], nextRefresh: null },
    external: null,
  });
}

/** 全绿底座：安装 + state.json（新鲜账户）+ history + 全套 0600 敏感文件。 */
async function mkHealthy(sc, now) {
  await installInto(sc);
  writePrivate('state.json', stateJson({ fetchedAt: now - 60_000 }));
  writePrivate('history.jsonl', '{"date":"2026-10-09","requests":3}\n{"date":"2026-10-10","requests":5}\n');
  writePrivate('daemon.token', 'a'.repeat(64));
  writePrivate('quota-history.jsonl', JSON.stringify({ ts: now - 60_000, raw: { plan: {} } }) + '\n');
  asar.uncache(sc.asar);
}

const upProbe = async () => ({ ok: true, version: '0.1.0' });
const downProbe = async () => null;
const NOW = 1791600000000;

function byName(checks) {
  return Object.fromEntries(checks.map((c) => [c.name, c]));
}

// ---------------------------------------------------------------- 全绿 → 0

test('all-green scenario: 8 checks in order, all ok, exit 0', async () => {
  const sc = await mkScenario();
  await mkHealthy(sc, NOW);
  const lines = [];
  const r = await runDoctor({
    probeHealth: upProbe, probeHarness: async () => true, now: () => NOW,
    log: (m) => lines.push(String(m)),
  });
  assert.deepEqual(r.checks.map((c) => c.name), CHECK_NAMES);
  assert.equal(CHECK_NAMES.length, 8);
  for (const c of r.checks) {
    assert.deepEqual(Object.keys(c).sort(), ['detail', 'name', 'status']);
    assert.equal(c.status, 'ok', `${c.name}: ${c.detail}`);
    assert.equal(typeof c.detail, 'string');
  }
  assert.equal(r.exitCode, 0);
  assert.ok(lines.some((l) => l.includes('[OK]')));
});

// ---------------------------------------------------------------- warn → 10

test('stale account (>10min) and scanErrors degrade to warn, exit 10', async () => {
  const sc = await mkScenario();
  await mkHealthy(sc, NOW);
  writePrivate('state.json', stateJson({
    fetchedAt: NOW - 11 * 60_000,
    scanErrors: [{ file: '/x/broken.jsonl', error: 'bad line' }],
  }));
  const r = await runDoctor({ probeHealth: upProbe, probeHarness: async () => true, now: () => NOW, log: () => {} });
  const cs = byName(r.checks);
  assert.equal(cs['account'].status, 'warn');
  assert.equal(cs['scan-errors'].status, 'warn');
  assert.equal(r.exitCode, 10);

  // account 缺失（补丁未生效或桥接未返回）同为 warn
  writePrivate('state.json', stateJson({ fetchedAt: 0, account: null }));
  const r2 = await runDoctor({ probeHealth: upProbe, probeHarness: async () => true, now: () => NOW, log: () => {} });
  assert.equal(byName(r2.checks)['account'].status, 'warn');
  assert.equal(byName(r2.checks)['account'].detail, '尚无账户数据（补丁未生效或桥接未返回）');
  assert.equal(r2.exitCode, 10);
});

// ---------------------------------------------------------------- fail → 20

test('dead daemon → fail exit 20', async () => {
  const sc = await mkScenario();
  await mkHealthy(sc, NOW);
  const r = await runDoctor({ probeHealth: downProbe, probeHarness: async () => false, now: () => NOW, log: () => {} });
  assert.equal(byName(r.checks)['daemon-health'].status, 'fail');
  assert.equal(r.exitCode, 20);
});

test('unpatched asar (client update overwrite) → asar-marker fail, patch-state warn, exit 20', async () => {
  const sc = await mkScenario();
  await mkHealthy(sc, NOW);
  fs.copyFileSync(sc.pristine, sc.asar); // hash == .orig → overwritten-by-update(warn) + 无标记(fail)
  asar.uncache(sc.asar);
  const r = await runDoctor({ probeHealth: upProbe, probeHarness: async () => true, now: () => NOW, log: () => {} });
  const cs = byName(r.checks);
  assert.equal(cs['patch-state'].status, 'warn');
  assert.equal(cs['asar-marker'].status, 'fail');
  assert.equal(r.exitCode, 20);
});

test('loose group/world perms on quota-history.jsonl → permissions fail, exit 20', async () => {
  const sc = await mkScenario();
  await mkHealthy(sc, NOW);
  fs.chmodSync(path.join(home(), 'quota-history.jsonl'), 0o644);
  const r = await runDoctor({ probeHealth: upProbe, probeHarness: async () => true, now: () => NOW, log: () => {} });
  const cs = byName(r.checks);
  assert.equal(cs['permissions'].status, 'fail');
  assert.match(cs['permissions'].detail, /quota-history\.jsonl/);
  assert.equal(r.exitCode, 20);
});

// ---------------------------------------------------------------- --json CLI 形状

test('CLI --json: machine-readable {exitCode, checks[]} of 8 {name,status,detail}', async () => {
  const sc = await mkScenario();
  await mkHealthy(sc, NOW);
  const r = spawnSync(process.execPath, [path.join(REPO, 'scripts/doctor.mjs'), '--json'], {
    env: { ...process.env, QUM_APP_ASAR: sc.asar, QUM_HOME: sc.home },
    encoding: 'utf8', timeout: 60_000,
  });
  assert.equal(r.status, 20, r.stdout + r.stderr); // 真实探测：该端口无 daemon → fail
  const j = JSON.parse(r.stdout);
  assert.equal(j.exitCode, 20);
  assert.deepEqual(j.checks.map((c) => c.name), CHECK_NAMES);
  for (const c of j.checks) assert.deepEqual(Object.keys(c).sort(), ['detail', 'name', 'status']);
});

// ---------------------------------------------------------------- --show-quota-raw 脱敏

test('redactRawText scrubs string values of keys matching /user|email|id\\b/i only', () => {
  const src = JSON.stringify({
    user_id: 'UID-SECRET-42',
    email: 'alice@example.com',
    plan_tier: 'pro',
    SessionId: 'sid-1', // Id 结尾 → id\b 命中
    quota: { total_value: 2500 }, // 数字不属字符串脱敏范围（键名也不命中）
    remaining: '680 left', // 键名不命中 → 原样
  });
  const out = redactRawText(src);
  assert.ok(!out.includes('UID-SECRET-42'));
  assert.ok(!out.includes('alice@example.com'));
  assert.ok(!out.includes('sid-1'));
  assert.ok(out.includes('plan_tier'));
  assert.ok(out.includes('680 left'));
  assert.ok(out.includes('[REDACTED]'));
});

test('quotaRawPreview respects the 800-char head of the redacted text', () => {
  const big = { user_id: 'UID-SECRET-42', notes: 'x'.repeat(2000) + 'TAILMARKER' };
  const p = quotaRawPreview({ source: 'widget', fetchedAt: 1, raw: big });
  assert.equal(p.length <= 800, true);
  assert.ok(!p.includes('TAILMARKER'));
  assert.ok(p.includes('[REDACTED]'));
  assert.equal(quotaRawPreview(null), '尚无账户数据（补丁未生效或桥接未返回）');
});

test('CLI --show-quota-raw: secrets never printed, 800-char head enforced', async () => {
  const sc = await mkScenario();
  await mkHealthy(sc, NOW);
  const raw = {
    user_id: 'UID-SECRET-42',
    email: 'alice@example.com',
    plan: { plan_tier: 'pro' },
    notes: 'y'.repeat(1600) + 'TAILMARKER-ZZZ',
  };
  writePrivate('state.json', stateJson({ fetchedAt: NOW - 60_000, raw }));
  const r = spawnSync(process.execPath, [path.join(REPO, 'scripts/doctor.mjs'), '--show-quota-raw'], {
    env: { ...process.env, QUM_APP_ASAR: sc.asar, QUM_HOME: sc.home },
    encoding: 'utf8', timeout: 60_000,
  });
  assert.doesNotMatch(r.stdout, /alice@example\.com/);
  assert.doesNotMatch(r.stdout, /UID-SECRET-42/);
  assert.doesNotMatch(r.stdout, /TAILMARKER-ZZZ/);
  assert.match(r.stdout, /\[REDACTED\]/);
  assert.match(r.stdout, /plan_tier/); // 非敏感键保留
  // 尚无账户数据分支
  writePrivate('state.json', stateJson({ fetchedAt: 0, account: null }));
  const r2 = spawnSync(process.execPath, [path.join(REPO, 'scripts/doctor.mjs'), '--show-quota-raw'], {
    env: { ...process.env, QUM_APP_ASAR: sc.asar, QUM_HOME: sc.home },
    encoding: 'utf8', timeout: 60_000,
  });
  assert.match(r2.stdout, /尚无账户数据（补丁未生效或桥接未返回）/);
});

// ---------------------------------------------------------------- T13 --show-quota-raw 解析摘要
// 首帧 heatmap 形状未知 → 预览必须一眼给出 pickHeatmap 命中了哪个候选、有没有数（P2 校准入口）。

test('T13 quotaParsePreview：metrics/heatmap 各一段摘要；命中候选名 + 有值计数 + 峰值 + 最新日', () => {
  const p = quotaParsePreview({
    source: 'widget', fetchedAt: 1, raw: {},
    metrics: {
      totalCredits: 1280.4, peakCredits: 86.4, currentStreakDays: 4,
      longestStreakDays: 9, totalActiveDays: 23, failedSources: ['streak'],
    },
    heatmap: { source: 'items', days: [{ date: '2026-10-09', credits: 86.4 }, { date: '2026-10-10', credits: null }] },
  });
  assert.match(p, /metrics 总计1280\.4 峰值86\.4 连续4\/最长9 活跃23 失败源1/);
  assert.match(p, /heatmap 候选=items 天数=2 有值=1 峰值86\.4 最新2026-10-10/);
});

test('T13 quotaParsePreview：缺席/未命中 → 校准话术（不谎称有数），account 缺失不抛', () => {
  assert.equal(quotaParsePreview(null), 'metrics 无（bridge 未返回/旧客户端） | heatmap 无（bridge 未返回/旧客户端）');
  const absent = quotaParsePreview({ source: 'widget', fetchedAt: 1, raw: {} });
  assert.match(absent, /metrics 无（bridge 未返回\/旧客户端）/);
  assert.match(absent, /heatmap 无（bridge 未返回\/旧客户端）/);
  // pickHeatmap 全候选不中（服务端存 null）→ 指向 raw head 校准
  const miss = quotaParsePreview({ raw: {}, heatmap: null, metrics: null });
  assert.match(miss, /heatmap 无（bridge 未返回\/旧客户端）/);
  assert.match(miss, /metrics 无（bridge 未返回\/旧客户端）/);
  assert.equal(quotaParsePreview({ raw: {}, heatmap: { source: 'data', days: [] }, metrics: {} }),
    'metrics 总计-- 峰值-- 连续--\/最长-- 活跃-- 失败源-- | heatmap 候选=data 天数=0 有值=0 峰值-- 最新--');
});

test('CLI --show-quota-raw: 在 raw head 之后追加 [quota-parse] 摘要行', async () => {
  const sc = await mkScenario();
  await mkHealthy(sc, NOW);
  writePrivate('state.json', JSON.stringify({
    meta: { generatedAt: NOW, daemonVersion: '0.1.0', scanErrors: [] },
    local: { window5h: null, week: null, today: null, history: [] },
    account: {
      source: 'widget', fetchedAt: NOW - 60_000, raw: { plan: { plan_tier: 'pro' } },
      packs: [], planRem: 0, packRem: 450, nextRefresh: null,
      heatmap: { source: 'days', days: [{ date: '2026-10-09', credits: 86.4 }] },
      metrics: {
        totalCredits: 1280.4, peakCredits: 86.4, currentStreakDays: 4,
        longestStreakDays: 9, totalActiveDays: 23, failedSources: [],
      },
    },
    external: null,
  }));
  const r = spawnSync(process.execPath, [path.join(REPO, 'scripts/doctor.mjs'), '--show-quota-raw'], {
    env: { ...process.env, QUM_APP_ASAR: sc.asar, QUM_HOME: sc.home },
    encoding: 'utf8', timeout: 60_000,
  });
  assert.match(r.stdout, /\[quota-parse\]/);
  assert.match(r.stdout, /metrics 总计1280\.4 峰值86\.4/);
  assert.match(r.stdout, /heatmap 候选=days 天数=1 有值=1/);
});

// ---------------------------------------------------------------- 真实 daemon E2E（唯一）

test('E2E: real daemon on 49866 → daemon-health ok + dev 通道关闭（生产态）via default probes', async () => {
  const sc = await mkScenario();
  await installInto(sc);
  const e2eHome = path.join(sc.root, 'e2e-home');
  const projects = path.join(sc.root, 'projects-empty');
  fs.mkdirSync(projects, { recursive: true });
  const env = { ...process.env, QUM_HOME: e2eHome, QUM_PROJECTS_DIR: projects };
  const child = spawn(process.execPath, [path.join(REPO, 'daemon', 'server.mjs'), '--port', String(E2E_PORT)], {
    env, stdio: 'ignore', detached: false,
  });
  test.after(async () => {
    child.kill('SIGTERM');
    try { execFileSync('pgrep', ['-f', `server\\.mjs.*--port ${E2E_PORT}`], { encoding: 'utf8' }); } catch { /* 期望无残留 */ }
  });
  const deadline = Date.now() + 10_000;
  let up = false;
  while (Date.now() < deadline && !up) {
    await new Promise((r) => setTimeout(r, 200));
    try { up = (await fetch(`http://127.0.0.1:${E2E_PORT}/health`)).ok; } catch { /* 未就绪 */ }
  }
  assert.ok(up, 'real daemon did not come up');
  try {
    const r = await runDoctor({ asarPath: sc.asar, port: E2E_PORT, log: () => {} });
    const cs = byName(r.checks);
    assert.equal(cs['daemon-health'].status, 'ok');   // 默认 defaultDaemonProbe 真探测
    // 该 daemon 未带 QUM_DEV → /dev/manifest 404：harness 通道按设计关闭，记为 ok 而非故障
    assert.equal(cs['harness'].status, 'ok');
    assert.match(cs['harness'].detail, /符合预期/);
    // 该 home 无账户/历史 → 按规则 warn（10），不许 fail
    assert.equal(cs['account'].status, 'warn');
    assert.equal(cs['history'].status, 'warn');
    assert.equal(r.exitCode, 10);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    let residue = '';
    try { residue = execFileSync('pgrep', ['-f', `server\\.mjs.*--port ${E2E_PORT}`], { encoding: 'utf8' }); }
    catch (e) { residue = String(e.stdout || ''); }
    assert.equal(residue.trim(), '', 'zero daemon residue on ' + E2E_PORT);
    fs.rmSync(e2eHome, { recursive: true, force: true }); // daemon 已死：可安全清目录
  }
});
