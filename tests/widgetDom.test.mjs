// tests/widgetDom.test.mjs
// Task 8 — widget 框架冒烟测试（无 happy-dom/jsdom，遵守仓库零新依赖裁定）。
// 覆盖：widget.js 在 node 下可 import（顶层不摸 window）、注册表 API 契约、
// 常量契约（轮询间隔/localStorage 键/锚点选择器）、harness 文件与 mock-state
// 真实 schema 对账、loader 模板体关键守卫存在。DOM 行为本身由 Step 3 的
// browser-use 截图验收（controller 负责）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fmtStamp } from '../app/format.js';

const REPO = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

test('widget.js imports under node: no top-level window access, registry API exported', async () => {
  assert.equal(typeof globalThis.window, 'undefined'); // node 环境本无 window
  const mod = await import('../app/widget.js'); // 顶层若摸 window，此处必抛
  for (const fn of ['setState', 'mount', 'expand', 'collapse']) {
    assert.equal(typeof mod.__QUM__[fn], 'function', `__QUM__.${fn} must be a function`);
  }
  assert.equal(typeof mod.registerModule, 'function');
  assert.equal(typeof mod.getModules, 'function');
  assert.equal(typeof mod.setFmt, 'function');
});

test('contract constants match the brief verbatim', async () => {
  const mod = await import('../app/widget.js');
  assert.equal(mod.LAYOUT_STORAGE_KEY, 'qum.layout.v1');
  // Strip layout v7（2026-10-26 用户裁定：对齐客户端原生底栏）：
  // tps（会话近30分钟生成速度）+ quota（资源包剩余%）+ session（会话簇：tokens 万/命中/轮/请求）
  // + tools（工具/失败）+ credits（会话累计）+ turnsec（最新一轮秒）；
  // 哨兵 = 含 session/tools/credits 且不含 model（v4/v5/v6 存档 → 整条回落 v7）。
  assert.deepEqual(mod.DEFAULT_MINI_SLOTS, ['tps', 'quota', 'session', 'tools', 'credits', 'turnsec']);
  assert.equal(mod.POLL_COLLAPSED_MS, 30_000);
  assert.equal(mod.POLL_EXPANDED_MS, 10_000);
  assert.equal(mod.ANCHOR_WAIT_MS, 3_000);
  assert.equal(mod.ANCHOR_SELECTOR, '[data-turn-status-bar]');
  // 2026-10-21 用户裁定：插件信息移入对话输入框底部——composer 为第一宿主
  assert.equal(mod.COMPOSER_SELECTOR, '[data-chat-composer]');
  assert.equal(mod.COLLAPSED_STORAGE_KEY, 'qum.collapsed.v1');
});

test('registerModule: validate, append in order, replace same id, getModules copy', async () => {
  const { registerModule, getModules } = await import('../app/widget.js');
  assert.deepEqual(getModules(), []); // 单例模块图：本文件内首个注册测试
  const fake = {
    id: 'demo', title: 'Demo', supports: ['half', 'full'], defaultSize: 'half',
    render: () => 'x', tick: () => {},
  };
  registerModule(fake);
  assert.deepEqual(getModules().map((m) => m.id), ['demo']);
  registerModule({ id: 'demo2', render: () => 'y' }); // title/supports 允许缺省
  assert.deepEqual(getModules().map((m) => m.id), ['demo', 'demo2']);
  registerModule({ ...fake, title: 'Demo v2' }); // 同 id 替换且保序（热重载安全）
  assert.deepEqual(getModules().map((m) => [m.id, m.title]), [['demo', 'Demo v2'], ['demo2', 'demo2']]);
  assert.deepEqual(getModules()[0].supports, ['half', 'full']);
  assert.throws(() => registerModule(null), TypeError);
  assert.throws(() => registerModule({ id: 'no-render' }), TypeError);
  assert.throws(() => registerModule({ render: () => {} }), TypeError);
  // getModules 返回副本，外部改动不污染注册表
  getModules().push({ id: 'nope' });
  assert.equal(getModules().some((m) => m.id === 'nope'), false);
});

test('pre-mount API is headless-safe: setState buffers, expand/collapse no-throw, mount needs DOM', async () => {
  const { setState, expand, collapse, mount } = await import('../app/widget.js');
  setState({ meta: {}, local: {}, account: null, external: null }); // 未挂载：只缓存，不抛
  expand();
  collapse();
  assert.throws(() => mount(null), /DOM/);
  assert.throws(() => mount(undefined), /DOM/);
});

test('app/loader.js body carries the mandated guards (surface skip, anchor poll, dynamic import)', () => {
  const body = read('app/loader.js');
  assert.match(body, /window\.location\.search\.includes\('surface='\)/);
  assert.match(body, /document\.body/);
  // 2026-10-21：composer 常驻，优先等它；旧回合状态栏保留为兼容兜底
  assert.match(body, /\[data-chat-composer\], \[data-turn-status-bar\]/);
  assert.match(body, /import\('\.\/widget\.js'\)/);
  // 模板体：不得含静态 import/export（它被注入 renderLoader 的 IIFE 内）
  assert.doesNotMatch(body, /^import\s/m);
  assert.doesNotMatch(body, /^export\s/m);
  assert.doesNotMatch(body, /QUM_LOADER_IMPL/); // 占位区标记由 renderLoader 模板持有
});

test('harness page fetches mock state, mounts via __QUM__ over daemon /app + /harness routes', () => {
  const html = read('tests/harness/index.html');
  assert.match(html, /<script type="module">/);
  assert.match(html, /from\s+'\/app\/widget\.js'/);
  assert.match(html, /data-chat-composer/, 'harness 假 composer 须带真机属性，才能验证输入框底部挂载');
  assert.match(html, /__QUM__/);
  assert.match(html, /fetch\('\/harness\/mock-state\.json'\)/);
  assert.match(html, /setState/);
  assert.match(html, /mount\(document\.body/);
  // widget.css 由 widget.js 自身按 import.meta.url 注入，验收页无需手工 link
  const widget = read('app/widget.js');
  assert.match(widget, /widget\.css/);
});

test('mock-state.json mirrors the real daemon state.json schema', () => {
  const s = JSON.parse(read('tests/harness/mock-state.json'));
  assert.deepEqual(Object.keys(s).sort(), ['account', 'external', 'local', 'meta', 'modelCatalog']);
  assert.equal(s.meta.daemonVersion, '0.1.0');
  assert.equal(typeof s.meta.generatedAt, 'number');
  assert.ok(Array.isArray(s.meta.scanErrors));
  assert.deepEqual(Object.keys(s.local).sort(),
    ['active', 'byModelWindow', 'contextWindow', 'history', 'lastTurn', 'modelCatalogMeta', 'session', 'sessions', 'today', 'week', 'window5h']);
  // Session strip：local.session = scanner sessionStats 产出（形状钉死——v7 原生样式新增
  // rounds/requests/cacheHitRate/时间范围/思考三段/工具体/编辑增量；T16 增补
  // outTok/outExact/outTps30Exact：真值优先输出，源数据保留 exact 标记供内部判断，UI 不显示估算符号）
  assert.deepEqual(Object.keys(s.local.session).sort(),
    ['avgTurnSec', 'billedInput', 'byModel', 'cacheHitRate', 'credits', 'creditsBillable', 'creditsFree',
      'edits', 'firstTs', 'id', 'lastTs', 'model', 'modelName', 'outEst', 'outEstCall', 'outEstThk',
      'outEstTxt', 'outExact', 'outTok', 'outTps30', 'outTps30Exact', 'rateCpm30',
      'rateCpm30Billable', 'requests', 'rounds', 'tools', 'totalTurnSec', 'tps30', 'turns']);
  assert.equal(typeof s.local.session.id, 'string');
  assert.equal(s.local.session.credits, 123.4);
  assert.equal(s.local.session.turns, 41);
  assert.equal(s.local.session.rounds, 23); // 原生口径：轮 ≠ usage 行数（turns）
  assert.equal(s.local.session.requests, 187); // 请求数（唯一 request_id）
  assert.equal(s.local.session.cacheHitRate, 0.861); // 会话累计缓存命中率
  assert.deepEqual(s.local.session.tools, {
    calls: 42, errors: 3,
    byName: [
      { name: 'Read', calls: 18, errors: 0 },
      { name: 'Edit', calls: 12, errors: 1 },
      { name: 'Bash', calls: 8, errors: 2 },
      { name: 'Write', calls: 4, errors: 0 },
    ],
  });
  assert.deepEqual(s.local.session.edits, { added: 126, removed: 38, files: 7 });
  assert.ok(s.local.session.firstTs < s.local.session.lastTs);
  assert.equal(s.local.session.outEstThk + s.local.session.outEstTxt + s.local.session.outEstCall,
    s.local.session.outEst, '思考/正文/工具三段估算之和 = 纯估算输出');
  assert.equal(s.local.session.outTok, 94); // 真值优先输出（mock 无真实 output → 回落估算）
  assert.equal(s.local.session.outExact, false, '含估算 → 呈现不加标记');
  assert.equal(s.local.session.outTps30Exact, false);
  // active.session 与全局锚定会话同形（v7 悬停卡/会话簇都读它）
  for (const k of ['rounds', 'requests', 'cacheHitRate', 'tools', 'edits']) {
    assert.deepEqual(s.local.active.session[k], s.local.session[k], `active.session.${k}`);
  }
  assert.equal(s.local.session.rateCpm30, 2.1);
  assert.equal(s.local.session.billedInput, 128000); // ratio×contextWindow 派生计费输入（整数）
  assert.equal(Number.isInteger(s.local.session.billedInput), true);
  assert.equal(s.local.session.avgTurnSec, 45); // 会话内相邻回合 gap 均值（idle 剔除后，整秒）
  assert.equal(s.local.session.model, 'qfmodel'); // runtime-config 顶层 model（真机 'qfmodel'）
  assert.equal(s.local.session.modelName, null); // 目录无 'qfmodel' 条目 → 未解析（呈现层回落短句柄）
  assert.equal(s.local.session.tps30, 12300); // 输入速率字段保留在数据面（不再呈现；近30分钟计费输入/1800）
  assert.equal(s.local.session.outTps30, 45.6); // T15 生成速度（近30分钟真实 output 簇速率，round1）→ 呈现 '46 tps'
  // 模型目录：state.modelCatalog {fetchedAt, entries}（trim 四字段）+ local.modelCatalogMeta {count,fetchedAt}
  assert.deepEqual(Object.keys(s.modelCatalog).sort(), ['entries', 'fetchedAt']);
  assert.ok(Array.isArray(s.modelCatalog.entries) && s.modelCatalog.entries.length >= 1);
  for (const e of s.modelCatalog.entries) {
    assert.deepEqual(Object.keys(e).sort(), ['byok', 'modelDisplayName', 'modelKey', 'typeDisplayName']);
    assert.equal(typeof e.byok, 'boolean');
  }
  const byok = s.modelCatalog.entries.find((e) => e.byok === true);
  assert.equal(byok.modelDisplayName, 'DeepSeek-Flash', 'BYOK 自定义模型 → 人类名（用户报告场景）');
  assert.deepEqual(Object.keys(s.local.modelCatalogMeta).sort(), ['count', 'fetchedAt']);
  assert.equal(s.local.modelCatalogMeta.count, s.modelCatalog.entries.length);
  // 会话明细（sessionsSummary 产出）：≤10、lastTs 降序；mock 3 行形状钉死。
  assert.ok(Array.isArray(s.local.sessions) && s.local.sessions.length === 3);
  for (const row of s.local.sessions) {
    assert.deepEqual(Object.keys(row).sort(),
      ['avgTurnSec', 'billedInput', 'billedSource', 'byModel', 'credits', 'creditsBillable', 'creditsFree',
        'id', 'lastTs', 'model', 'modelName', 'requests', 'rounds', 'turns']);
    assert.equal(typeof row.id, 'string');
  }
  assert.deepEqual(s.local.sessions.map((r) => r.id),
    ['mock-session-abc123', 'mock-session-def456', 'mock-session-ghi789']);
  for (let i = 1; i < s.local.sessions.length; i++) {
    assert.ok(s.local.sessions[i - 1].lastTs >= s.local.sessions[i].lastTs, 'lastTs 降序');
  }
  assert.equal(s.local.sessions[0].model, 'qfmodel');
  assert.equal(s.local.sessions[2].billedSource, null); // 无 ratio 会话 → billedSource null
  // local.contextWindow {value, source}：数据面来源标记（UI 不再显示估算符号）
  assert.deepEqual(Object.keys(s.local.contextWindow).sort(), ['source', 'value']);
  assert.equal(s.local.contextWindow.value, 200000);
  assert.ok(['runtime-config', 'fallback200k', 'mixed'].includes(s.local.contextWindow.source));
  // T12 credits 校准：credits 为主聚合单位，窗口/聚合行必须携带（与 scanner 输出形状一致）
  const WINDOW_KEYS = ['input', 'output', 'cacheRead', 'cacheCreate', 'turns', 'speedTps',
    'cacheHitRate', 'resetAt', 'paceRatio', 'credits', 'billedInput', 'billedInputSource', 'byAgent'];
  const AGG_KEYS = ['input', 'output', 'cacheRead', 'cacheCreate', 'turns', 'speedTps', 'cacheHitRate', 'credits'];
  for (const w of ['window5h', 'week', 'today']) {
    for (const k of WINDOW_KEYS) assert.ok(k in s.local[w], `local.${w}.${k} missing`);
    assert.ok(['runtime-config', 'fallback200k', 'mixed'].includes(s.local[w].billedInputSource),
      `local.${w}.billedInputSource=${String(s.local[w].billedInputSource)}`);
    assert.deepEqual(Object.keys(s.local[w].byAgent).sort(), ['main', 'sub']);
    for (const k of AGG_KEYS) assert.ok(k in s.local[w].byAgent.main);
    assert.equal('billedInput' in s.local[w].byAgent.main, false, 'byAgent 子形状保持原样（计费输入仅窗口级）');
  }
  assert.ok(Array.isArray(s.local.history) && s.local.history.length >= 2);
  for (const row of s.local.history) {
    for (const k of [...AGG_KEYS, 'date', 'main', 'sub']) assert.ok(k in row, `history row.${k}`);
  }
  assert.equal(s.account.source, 'widget'); // 与 server.ingestQuota 写入口径一致
  assert.equal(typeof s.account.fetchedAt, 'number');
  assert.equal(typeof s.account.raw, 'object');
  // T13：bridge 两新源解析后并列落在 account 上（daemon ingestQuota 的写入口径）
  assert.equal(s.account.heatmap.source, 'days');
  assert.ok(Array.isArray(s.account.heatmap.days) && s.account.heatmap.days.length >= 14);
  for (const d of s.account.heatmap.days) {
    assert.deepEqual(Object.keys(d).sort(), ['credits', 'date']);
    assert.ok(d.date === null || /^\d{4}-\d{2}-\d{2}$/.test(d.date), `heatmap day.date=${String(d.date)}`);
    assert.ok(d.credits === null || typeof d.credits === 'number');
  }
  assert.deepEqual(Object.keys(s.account.metrics).sort(),
    ['currentStreakDays', 'failedSources', 'longestStreakDays', 'peakCredits', 'totalActiveDays', 'totalCredits']);
  assert.equal(s.account.metrics.totalCredits, 1280.4);
  assert.ok(Array.isArray(s.account.metrics.failedSources));
  assert.equal(s.external, null); // T10 前 account.raw 存原样，external 未启用
  // P2：新数据面 shape（数值来自 mock 自身，消费方 T9-T13 依赖）
  assert.equal(s.local.lastTurn.turnSec, 32.4);
  assert.equal(s.local.lastTurn.endTs - s.local.lastTurn.promptTs, 32400);
  assert.equal(s.local.lastTurn.billedInput, 48123);
  assert.equal(s.local.lastTurn.billedSource, 'fallback200k');
  assert.equal(s.local.lastTurn.outTps, 56.5);
  assert.equal(s.local.lastTurn.model, 'qfmodel');
  assert.equal(s.local.byModelWindow.windowStart + 6 * 86400000, s.local.byModelWindow.todayStart);
  assert.equal(s.local.byModelWindow.rows.length, 5);
  assert.equal(s.local.byModelWindow.rows[0].model, '11111111-1111-4111-8111-111111111111');
  assert.equal(s.local.byModelWindow.rows[0].credits7d, 912);
  const sum7 = s.local.byModelWindow.rows.reduce((a, r) => a + (typeof r.credits7d === 'number' ? r.credits7d : 0), 0);
  assert.equal(sum7, 1098, '占比分母自洽');
  assert.equal(s.local.session.byModel.length, 2);
  assert.equal(s.local.session.byModel[0].credits, 0.6);
  assert.equal(s.local.session.totalTurnSec, 262);
  assert.equal(s.modelCatalog.entries.length, 6);
  assert.equal(s.modelCatalog.entries[0].modelKey, '11111111-1111-4111-8111-111111111111', '首 byok 仍 DeepSeek-Flash');
});

test('widget.css carries the mandated structural styles', () => {
  const css = read('app/widget.css');
  // v6 单行式通栏（2026-10-22 用户裁定：去模型槽/去标签行）：strip 占满整行，槽间 1px 竖直分隔线
  assert.match(css, /width:\s*100%/, 'strip 通栏');
  assert.doesNotMatch(css, /\.qum-slot-label\s*\{/, 'v6 无槽标签行样式');
  assert.doesNotMatch(css, /\.qum-analysis-label\s*\{/, 'v6「分析」列单行无标签');
  assert.match(css, /\.qum-slot-value/);
  // 2026-10-29：尾部「分析」时刻列不得被长会话簇挤出 overflow:hidden 的可视区
  assert.match(css, /\.qum-slot\s*\{[^}]*min-width:\s*0[^}]*flex-shrink:\s*0/, '短槽保持完整宽度');
  assert.match(css, /\.qum-slot-session\s*\{[^}]*flex-shrink:\s*100/, '仅会话簇可收缩');
  assert.match(css, /\.qum-slot-value\s*\{[^}]*text-overflow:\s*ellipsis/, '收缩槽用省略号');
  assert.match(css, /\.qum-analysis\s*\{[^}]*flex-shrink:\s*0/, '「分析」时刻列不收缩');
  assert.match(css, /border-left:\s*1px solid/, '槽间分隔线');
  assert.match(css, /font-size:\s*12px/);
  assert.match(css, /@media\s*\(prefers-color-scheme:\s*dark\)/);
  assert.match(css, /\.qum-bar\s*\{[^}]*height:\s*4px/);
  assert.match(css, /\.qum-pace-tick/);
  assert.match(css, /\.qum-panel\s*\{[^}]*max-height:\s*60vh[^}]*overflow(-y)?:\s*auto/);
  assert.match(css, /z-index:\s*9999/); // 仅 panel overlay（controller 裁定），strip 在文档流
  assert.match(css, /data-qum-offline="1"/);
  assert.match(css, /qum-fixed/);
  // 2026-10-21：输入框底部内嵌（卡片末尾 + order 压底；外框换成上分隔线）
  assert.match(css, /#qum-root\.qum-in-composer\s*\{[^}]*order:\s*999/);
  // 2026-10-22 二次裁定：紧贴工具栏下方，不留外边距
  assert.match(css, /#qum-root\.qum-in-composer\s*\{[^}]*margin:\s*0\s*;/);
  assert.match(css, /#qum-root\.qum-in-composer\s+\.qum-strip\s*\{[^}]*border-top:\s*1px solid/);
  // 2026-10-22 用户裁定：按模型消耗缓存命中徽标（仅 cacheRead>0 渲染；条件由模块层承担）
  assert.match(css, /\.qum-models-head\s*\{[^}]*display:\s*flex/);
  assert.match(css, /\.qum-models-cache\s*\{[^}]*border-radius:\s*999px/);
  // T13：用量热力模块的合法最小样式面（grid 容器 + 单元格 + 暗色变体）
  assert.match(css, /\.qum-heat\s*\{[^}]*display:\s*grid/);
  assert.match(css, /\.qum-heat-cell\s*\{/);
  assert.match(css, /@media\s*\(prefers-color-scheme:\s*dark\)[\s\S]*\.qum-heat-cell/);
  // v7 原生样式：会话簇强调色 + 悬停摘要卡（向上覆盖、不拦截鼠标、hidden 真正隐藏）
  assert.match(css, /\.qum-slot-session[^{]*\{|\.qum-slot\[data-slot="session"\]/);
  assert.match(css, /\.qum-hover\s*\{[^}]*position:\s*absolute/);
  assert.match(css, /\.qum-hover\s*\{[^}]*bottom:\s*calc\(100%\s*\+\s*6px\)/);
  assert.match(css, /\.qum-hover\s*\{[^}]*pointer-events:\s*none/);
  assert.match(css, /\.qum-hover\[hidden\]\s*\{[^}]*display:\s*none/);
  assert.match(css, /\.qum-hover-row\s*\{[^}]*display:\s*flex/);
  assert.match(css, /\.qum-hover-val\s*\{[^}]*tabular-nums/);
});

// ---------------------------------------------------------------- Fix round 1
// 无 happy-dom/jsdom，用最小假 DOM 驱动 mount/expand，观测「是否挂了轮询定时器 /
// 是否调用 fetch / 旧 root 是否被回收」——三者都是真实外部可观测行为，非同义反复。
// 放在文件末尾：会置位模块单例 dom，且注册 demo/demo2 已早于本组，顺序无污染。

function makeFakeDom() {
  const timers = []; // { fn, delay, id }
  let seq = 0;
  const fetchCalls = [];
  const win = {
    localStorage: {
      store: {},
      getItem(k) { return Object.prototype.hasOwnProperty.call(this.store, k) ? this.store[k] : null; },
      setItem(k, v) { this.store[k] = String(v); },
    },
    setTimeout(fn, delay) { const id = ++seq; timers.push({ fn, delay, id }); return id; },
    clearTimeout(id) { const i = timers.findIndex((t) => t.id === id); if (i !== -1) timers.splice(i, 1); },
    fetch(url, init) { fetchCalls.push({ url, init }); return Promise.resolve({
      ok: false, status: 508, headers: { get: () => null }, json: () => Promise.resolve({}),
    }); },
    __QUM__: null,
    // 2026-10-21：真实宿主用 MutationObserver 做 composer 自愈重挂。假工厂只捕获回调，
    // 用例手动触发（并在 250ms 节流定时器落定后断言），不引入真实观察循环。
    __moCallback: null,
    MutationObserver: class {
      constructor(cb) { win.__moCallback = cb; }
      observe() {}
      disconnect() {}
    },
  };
  function makeEl(tag) {
    const classes = new Set();
    const el = {
      tagName: String(tag || 'div').toUpperCase(),
      nodeType: 1,
      children: [],
      parentNode: null,
      dataset: {},
      style: {},
      attrs: {},
      hidden: false,
      id: '',
      href: '',
      rel: '',
      _text: '',
      _replaceCalls: 0,
      get className() { return [...classes].join(' '); },
      set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
      classList: {
        toggle(c, force) { const on = force === undefined ? !classes.has(c) : !!force; if (on) classes.add(c); else classes.delete(c); return on; },
        add(...cs) { cs.forEach((c) => classes.add(c)); },
        remove(...cs) { cs.forEach((c) => classes.delete(c)); },
        contains(c) { return classes.has(c); },
      },
      get textContent() { return el._text; },
      set textContent(v) { el._text = String(v); el.children = []; },
      append(...ns) { for (const n of ns) if (n) { el.children.push(n); n.parentNode = el; } },
      appendChild(n) { el.append(n); return n; },
      replaceChildren(...ns) { el._replaceCalls++; el.children = []; el.append(...ns); },
      removeChild(n) { const i = el.children.indexOf(n); if (i !== -1) { el.children.splice(i, 1); n.parentNode = null; } },
      remove() { if (el.parentNode) el.parentNode.removeChild(el); },
      insertBefore(node, ref) { const i = el.children.indexOf(ref); if (i === -1) el.append(node); else { el.children.splice(i, 0, node); node.parentNode = el; } },
      setAttribute(k, v) { el.attrs[k] = String(v); },
      getAttribute(k) { return k in el.attrs ? el.attrs[k] : null; },
      removeAttribute(k) { delete el.attrs[k]; },
      _listeners: {},
      addEventListener(type, fn) { (el._listeners[type] = el._listeners[type] || []).push(fn); },
      fire(type) { (el._listeners[type] || []).forEach((fn) => fn({})); },
    };
    return el;
  }
  const body = makeEl('body');
  const doc = {
    defaultView: win,
    body,
    head: body,
    documentElement: body,
    createElement: (tag) => makeEl(tag),
    __panes: null, // P3：假会话 pane 注册表（null = 无 pane，等价旧客户端/harness 未补属性）
    __composers: null, // 2026-10-21：真机 [data-chat-composer] 注册表（null = 无 composer 宿主）
    querySelector(sel) {
      // P3 只新增 pane 两类选择器；其余（锚点、样式 link）保持既有"一律 null"语义，
      // 使 place() 仍走 fixed 降级、既有 25 个用例行为不变。
      if (sel === '[data-chat-session-id][data-active]') return (doc.__panes || []).find((p) => p.dataset.chatSessionId && p.active) || null;
      if (sel === '[data-chat-session-id]') return (doc.__panes || []).find((p) => p.dataset.chatSessionId) || null;
      if (sel === '[data-chat-composer]') return (doc.__composers || [])[0] || null;
      // dev-live 样式热更：既有 link 可被找到才能复用并更新 href（无则返回 null，与原语义一致）
      if (sel === 'link[data-qum-style]') return (doc.head.children || []).find((el) => el.dataset && el.dataset.qumStyle) || null;
      return null; // 无锚点、无既有样式 link
    },
    querySelectorAll: (sel) => {
      if (sel === '[data-chat-session-id]') return (doc.__panes || []).filter((p) => p.dataset.chatSessionId);
      if (sel === '[data-chat-composer]') return (doc.__composers || []).slice();
      return [];
    },
  };
  const host = makeEl('body');
  host.ownerDocument = doc;
  // P3 装配助手：挂一个带会话 id 的假 pane（active = 真机 data-active），锚点置于其内。
  const addPaneWithAnchor = (sid, { active = false } = {}) => {
    const paneEl = makeEl('div');
    paneEl.dataset.chatSessionId = sid;
    if (active) paneEl.active = true;
    const anchorEl = makeEl('div');
    anchorEl.setAttribute('data-turn-status-bar', '1');
    paneEl.append(anchorEl);
    host.append(paneEl);
    doc.__panes = (doc.__panes || []).concat(paneEl);
    return { paneEl, anchorEl };
  };
  // 2026-10-21：真机 composer 替身（卡片内已有编辑区与工具栏；widget 应把 root 挂到卡片末尾）
  const addComposer = () => {
    const composer = makeEl('div');
    composer.setAttribute('data-chat-composer', '1');
    const editor = makeEl('div');
    editor.setAttribute('data-chat-composer-resizable-content', '1');
    const toolbar = makeEl('div');
    toolbar.setAttribute('data-chat-composer-toolbar', '1');
    composer.append(editor, toolbar);
    host.append(composer);
    doc.__composers = (doc.__composers || []).concat(composer);
    return { composer, editor, toolbar };
  };
  return { win, doc, host, timers, fetchCalls, makeEl, addPaneWithAnchor, addComposer };
}

// 轮询定时器与锚点重试定时器以 delay 区分：place 用 100ms，schedulePoll 用 30k/10k。
const pollDelays = (timers, mod) =>
  timers.filter((t) => t.delay === mod.POLL_COLLAPSED_MS || t.delay === mod.POLL_EXPANDED_MS);

test('Fix#1: no-credential expand() does NOT arm a poll timer or fetch; token() does (control)', async () => {
  const mod = await import('../app/widget.js');
  const { setState, mount, expand } = mod;

  // 无凭据：mount + expand 全程不排轮询定时器、不 fetch（出图不灰显不变量）
  const a = makeFakeDom();
  setState({ meta: {}, local: {}, account: null, external: null });
  mount(a.host, { baseUrl: '' }); // 无 token / bootstrapCode
  assert.equal(pollDelays(a.timers, mod).length, 0, 'no-cred mount must not arm poll');
  expand(); // ← 旧 bug 在这里无条件 schedulePoll()，会排一个 10k 定时器
  assert.equal(pollDelays(a.timers, mod).length, 0, 'no-cred expand must not arm poll');
  assert.equal(a.fetchCalls.length, 0, 'no-cred must never fetch /state');

  // 正对照：带 token 确实排轮询定时器并 fetch（证明上述断言真的在检测轮询，而非恒真）
  const b = makeFakeDom();
  mount(b.host, { baseUrl: '', token: 'tok-xyz' });
  assert.ok(pollDelays(b.timers, mod).length >= 1, 'token mount must arm poll');
  assert.ok(b.fetchCalls.length >= 1, 'token mount must fetch');
  await new Promise((r) => setImmediate(r)); // 让 pollOnce 的 await 落定，避免悬挂
});

test('Fix#2: registerModule with renderMini refreshes the strip, not just the panel', async () => {
  const mod = await import('../app/widget.js');
  const { setState, mount } = mod;
  const f = makeFakeDom();
  setState({ meta: {}, local: {}, account: null, external: null });
  const root = mount(f.host, { baseUrl: '' });
  const strip = root.children[0];
  const panel = root.children[1];
  const before = strip._replaceCalls;
  mod.registerModule({ id: 'zz-mini', render: () => f.makeEl('span'), renderMini: () => f.makeEl('span') });
  assert.ok(strip._replaceCalls > before, 'registerModule must re-render strip');
  assert.ok(panel._replaceCalls >= 1, 'panel also refreshed');
});

test('Fix#3: re-mount tears down the previous instance (single root, no orphan retry chain)', async () => {
  const mod = await import('../app/widget.js');
  const { setState, mount } = mod;
  const f = makeFakeDom();
  setState({ meta: {}, local: {}, account: null, external: null });
  const root1 = mount(f.host, { baseUrl: '' });
  assert.equal(f.host.children.length, 1);
  const root2 = mount(f.host, { baseUrl: '' });
  // 旧 root 已从 DOM 摘除，宿主内只剩新实例
  assert.equal(root1.parentNode, null, 'old root must be detached on remount');
  assert.equal(f.host.children.length, 1, 'host must not accumulate qum-root across remounts');
  assert.equal(f.host.children[0], root2);
  assert.ok(root2 !== root1);
});

// ------------------------------------------------ dev-live（2026-10-15）：保存即生效
// 跨模块实例热换（loader 每次 rev 变化都会 import 一个新 URL → 新模块实例）。
test('dev 热换：新模块实例 mount 回收旧实例的 root 与轮询表', async () => {
  const a = await import('../app/widget.js?devswap=a');
  const b = await import('../app/widget.js?devswap=b');
  const f = makeFakeDom();
  a.setState({ meta: {}, local: {}, account: null, external: null });
  const rootA = a.mount(f.host, { baseUrl: '', token: 'tok-dev' });
  assert.equal(f.host.children.filter((el) => el.id === 'qum-root').length, 1);
  assert.equal(f.timers.filter((t) => t.delay === a.POLL_COLLAPSED_MS).length, 1, 'A 实例轮询已起');

  b.setState({ meta: {}, local: {}, account: null, external: null });
  const rootB = b.mount(f.host, { baseUrl: '', token: 'tok-dev' });
  const roots = f.host.children.filter((el) => el.id === 'qum-root');
  assert.equal(roots.length, 1, '旧实例 root 必须被新实例回收');
  assert.equal(roots[0], rootB);
  assert.equal(rootA.parentNode, null, '旧 root 已从宿主摘下');
  assert.equal(f.timers.filter((t) => t.delay === a.POLL_COLLAPSED_MS).length, 1, '轮询表不得翻倍');
  await new Promise((r) => setImmediate(r));
});

test('dev 热换：mount({rev}) 样式表带 ?v=，换 rev 复用同一 link 并更新 href', async () => {
  const a = await import('../app/widget.js?devcss=a');
  const b = await import('../app/widget.js?devcss=b');
  const f = makeFakeDom();
  const links = () => f.doc.head.children.filter((el) => el.dataset && el.dataset.qumStyle);
  a.setState({ meta: {}, local: {}, account: null, external: null });
  a.mount(f.host, { baseUrl: '', rev: 'r1' });
  assert.equal(links().length, 1);
  assert.match(links()[0].href, /widget\.css\?v=r1$/);

  b.setState({ meta: {}, local: {}, account: null, external: null });
  b.mount(f.host, { baseUrl: '', rev: 'r2' });
  assert.equal(links().length, 1, '不得追加第二个样式 link');
  assert.match(links()[0].href, /widget\.css\?v=r2$/, '同一 link 换 rev 触发样式热更');
  await new Promise((r) => setImmediate(r));
});

// ---------------------------------------------------------------- Task 10：accountPoll
// node 侧诚实检验：bridge 只以 window.qoderDesktop 桩（假实现）出现，断言的是
// accountPoll 的 fetch body 构造与守卫（无 bridge/无凭据 → 永不 POST），不涉及真客户端。

const flushMicrotasks = () => new Promise((r) => setImmediate(r));

test('T10/T13: bridge+token → 60s 账户定时器；展开触发一次 POST；tick 再 POST 并重排（旧 client 无两新 fn → body 记 null）', async () => {
  const mod = await import('../app/widget.js');
  const f = makeFakeDom();
  const usage = { quota_summary: { used_value: 1820, total_value: 2500 }, next_refresh_date: 1791691200 };
  const plan = { plan_tier: 'pro' };
  f.win.qoderDesktop = { getAccountUsage: () => usage, getAccountPlan: () => plan }; // 无 heatmap/metrics：升级前客户端
  mod.setState({ meta: {}, local: {}, account: null, external: null });
  mod.mount(f.host, { baseUrl: 'http://127.0.0.1:9', token: 'tok-abc' });
  const acctTimers = () => f.timers.filter((t) => t.delay === mod.ACCOUNT_POLL_MS);
  assert.equal(mod.ACCOUNT_POLL_MS, 60_000, 'brief 常量：60s');
  assert.equal(acctTimers().length, 1, 'mount(bridge+token) 起且仅起一个 60s 表');
  const posts = () => f.fetchCalls.filter((c) => c.init && c.init.method === 'POST');
  assert.equal(posts().length, 0, 'mount 已知 token 时不立即 POST（节奏=60s+展开+bootstrap 首发）');

  mod.expand(); // 面板展开 → 触发一次
  await flushMicrotasks(); await flushMicrotasks();
  assert.equal(posts().length, 1, 'expand 触发一次 POST');
  const p = posts()[0];
  assert.equal(p.url, 'http://127.0.0.1:9/ingest/quota');
  assert.equal(p.init.headers['X-QM-Token'], 'tok-abc', 'token 头复用现有 token 态');
  assert.equal(p.init.headers['content-type'], 'application/json');
  assert.deepEqual(((_b)=>{ delete _b.debug; return _b; })(JSON.parse(p.init.body)), { usage, plan, heatmap: null, metrics: null, models: null },
    'body=五源 {usage,plan,heatmap,metrics,models}；typeof 守卫缺失的新 fn 记 null');

  const beforeTick = acctTimers().length;
  acctTimers()[0].fn(); // 手动走一拍 60s tick
  await flushMicrotasks(); await flushMicrotasks(); await flushMicrotasks();
  assert.equal(posts().length, 2, '60s tick 再 POST 一次');
  // 假 DOM 的 timers 数组不自动摘除已触发的表（只 clearTimeout 摘）：重排=净增一张 60s 新表
  assert.equal(acctTimers().length, beforeTick + 1, 'tick 后重排下一拍（链式 60s）');
});

test('T13: 四源 allSettled 并发，heatmap/metrics 以 scope="app" 调用并原样入 body', async () => {
  const mod = await import('../app/widget.js');
  const f = makeFakeDom();
  const scopes = [];
  const heatmap = { days: [{ date: '2026-10-10', credits: 7.5 }] };
  const metrics = { totalCredits: 1280.4, peakCredits: 86.4, currentStreakDays: 4, longestStreakDays: 9, totalActiveDays: 23, failedSources: [] };
  f.win.qoderDesktop = {
    getAccountUsage: () => ({ u: 1 }),
    getAccountPlan: () => ({ p: 2 }),
    getAccountCreditsHeatmap: (scope) => { scopes.push(['heatmap', scope]); return heatmap; },
    getAccountProfileMetrics: (scope) => { scopes.push(['metrics', scope]); return metrics; },
  };
  mod.setState({ meta: {}, local: {}, account: null, external: null });
  mod.mount(f.host, { baseUrl: 'http://127.0.0.1:9', token: 't13' });
  mod.expand();
  await flushMicrotasks(); await flushMicrotasks();
  const post = f.fetchCalls.find((c) => c.init && c.init.method === 'POST');
  assert.ok(post, '四源齐 → POST');
  const body = JSON.parse(post.init.body);
  assert.deepEqual({ usage: body.usage, plan: body.plan, heatmap: body.heatmap, metrics: body.metrics, models: body.models },
    { usage: { u: 1 }, plan: { p: 2 }, heatmap, metrics, models: null });
  assert.deepEqual(Object.keys(body.debug).sort(), ['activeMarked', 'anchorFound', 'attrs', 'docKnownHit', 'docSessionAttrs', 'docSize', 'host', 'method', 'panes', 'sid', 'visible'],
    'P3：账户 POST 顺带回报活动会话诊断（无凭据、无用户内容），真机排障时读 ~/.qoder-monitor/debug.json');
  assert.deepEqual(scopes, [['heatmap', 'app'], ['metrics', 'app']],
    'main 进程只认 app|all：本模块固定传 app');
});

test('T10: bridge 返回字符串/抛异常 → body 容错构造（parse 字符串存对象，异常项记 null）', async () => {
  const mod = await import('../app/widget.js');
  const f = makeFakeDom();
  f.win.qoderDesktop = {
    getAccountUsage: () => '{"quota_summary":{"used_value":7}}', // JSON 字符串 → 解析
    getAccountPlan: () => { throw new Error('bridge boom'); },    // 同步抛 → null，不阻断
  };
  mod.setState({ meta: {}, local: {}, account: null, external: null });
  mod.mount(f.host, { baseUrl: '', token: 't2' });
  mod.expand();
  await flushMicrotasks(); await flushMicrotasks();
  const post = f.fetchCalls.find((c) => c.init && c.init.method === 'POST');
  assert.ok(post, '异常项不阻断本轮 POST');
  assert.deepEqual(((_b)=>{ delete _b.debug; return _b; })(JSON.parse(post.init.body)), { usage: { quota_summary: { used_value: 7 } }, plan: null, heatmap: null, metrics: null, models: null });
});

test('T13: 四源全 null → 跳过 POST（泛化守卫）；任一源非 null（含仅 usage）→ 仍 POST（positive control）', async () => {
  const mod = await import('../app/widget.js');
  const fourRejection = {
    getAccountUsage: () => Promise.reject(new Error('no usage')),
    getAccountPlan: () => Promise.reject(new Error('no plan')),
    getAccountCreditsHeatmap: () => { throw new Error('no heatmap'); },
    getAccountProfileMetrics: () => Promise.reject(new Error('no metrics')),
  };
  const f = makeFakeDom();
  f.win.qoderDesktop = fourRejection;
  mod.setState({ meta: {}, local: {}, account: null, external: null });
  mod.mount(f.host, { baseUrl: 'http://127.0.0.1:9', token: 't4' });
  mod.expand();
  await flushMicrotasks(); await flushMicrotasks(); await flushMicrotasks();
  assert.equal(f.fetchCalls.filter((c) => c.init && c.init.method === 'POST').length, 0,
    '四源全 null → 本轮绝不 POST（last-good 保护）');

  // positive control：只剩 usage 一个非 null（plan/heatmap/metrics 全 null）仍必须 POST
  const g = makeFakeDom();
  g.win.qoderDesktop = {
    getAccountUsage: () => ({ u: 1 }),
    getAccountPlan: () => null,
    getAccountCreditsHeatmap: () => Promise.reject(new Error('no heatmap')),
    getAccountProfileMetrics: () => 'not json', // 字符串解析失败 → 原样入 body（服务端存 raw）
  };
  mod.setState({ meta: {}, local: {}, account: null, external: null });
  mod.mount(g.host, { baseUrl: 'http://127.0.0.1:9', token: 't4' });
  g.fetchCalls.length = 0;
  mod.expand();
  await flushMicrotasks(); await flushMicrotasks();
  const post = g.fetchCalls.find((c) => c.init && c.init.method === 'POST');
  assert.ok(post, 'only-usage-null（此处仅 usage 有数）仍 POST');
  assert.deepEqual(((_b)=>{ delete _b.debug; return _b; })(JSON.parse(post.init.body)), { usage: { u: 1 }, plan: null, heatmap: null, metrics: 'not json', models: null });
});

test('Fix#2（T13 泛化为四源守卫）：usage/plan 双侧 bridge 均拒且无新源 → 本轮绝不 POST，保 last-good；单侧 null 仍 POST（positive control）', async () => {
  const mod = await import('../app/widget.js');
  // 全 null：accountPoll 必须短路，不发 {usage:null,plan:null,...}（否则服务端覆盖 last-good）
  const f = makeFakeDom();
  f.win.qoderDesktop = {
    getAccountUsage: () => Promise.reject(new Error('no usage')),
    getAccountPlan: () => Promise.reject(new Error('no plan')),
  };
  mod.setState({ meta: {}, local: {}, account: null, external: null });
  mod.mount(f.host, { baseUrl: 'http://127.0.0.1:9', token: 't-guard' });
  mod.expand();
  await flushMicrotasks(); await flushMicrotasks(); await flushMicrotasks();
  assert.equal(f.fetchCalls.filter((c) => c.init && c.init.method === 'POST').length, 0,
    'all-null round must skip POST entirely');

  // positive control：单侧 null 仍 POST（守卫不能过宽）
  const g = makeFakeDom();
  g.win.qoderDesktop = {
    getAccountUsage: () => ({ u: 1 }),
    getAccountPlan: () => Promise.reject(new Error('no plan')),
  };
  mod.setState({ meta: {}, local: {}, account: null, external: null });
  mod.mount(g.host, { baseUrl: 'http://127.0.0.1:9', token: 't-guard' });
  g.fetchCalls.length = 0; // 清掉 mount 触发的 /state GET，只看 POST
  mod.expand();
  await flushMicrotasks(); await flushMicrotasks();
  const post = g.fetchCalls.find((c) => c.init && c.init.method === 'POST');
  assert.ok(post, 'one-side null must still POST');
  assert.deepEqual(((_b)=>{ delete _b.debug; return _b; })(JSON.parse(post.init.body)), { usage: { u: 1 }, plan: null, heatmap: null, metrics: null, models: null });
});

// T14（用户报告）：第五桥 listChatComposerModels 是 preload 一等 API（模型目录），
// 调参固定 {fetchStrategy:'live', workspaceDirectories:[]}；与其余四源经 allSettled 并发，
// typeof 守卫（旧 client 无此 fn → null）；body.models 原样透传数组。
test('T14: listChatComposerModels({fetchStrategy:"live",workspaceDirectories:[]}) 第五源 → body.models 原样；缺 fn 仍 null 不崩', async () => {
  const mod = await import('../app/widget.js');
  const f = makeFakeDom();
  const calls = [];
  const models = [{ modelKey: '11111111-1111-4111-8111-111111111111', modelDisplayName: 'DeepSeek-Flash', byok: true }];
  f.win.qoderDesktop = {
    getAccountUsage: () => ({ u: 1 }),
    getAccountPlan: () => ({ p: 2 }),
    listChatComposerModels: (arg) => { calls.push(arg); return models; },
  };
  mod.setState({ meta: {}, local: {}, account: null, external: null });
  mod.mount(f.host, { baseUrl: 'http://127.0.0.1:9', token: 't14' });
  mod.expand();
  await flushMicrotasks(); await flushMicrotasks();
  assert.deepEqual(calls, [{ fetchStrategy: 'live', workspaceDirectories: [] }],
    '固定调参：live + 空 workspaceDirectories（一级 preload API，不触凭据存储）');
  const post = f.fetchCalls.find((c) => c.init && c.init.method === 'POST');
  assert.ok(post, '有数 → POST');
  assert.deepEqual(((_b)=>{ delete _b.debug; return _b; })(JSON.parse(post.init.body)).models, models, '模型目录原样入 body');
});

test('T14 守卫：四源全 null 时即使 models 有数也跳过 POST（models 不触发也不抑制）；models 失败不影响他源 POST', async () => {
  const mod = await import('../app/widget.js');
  // 四源全 null，仅 models 有数 → 仍跳过 POST（last-good 保护守卫只看四源）
  const f = makeFakeDom();
  f.win.qoderDesktop = {
    getAccountUsage: () => Promise.reject(new Error('x')),
    getAccountPlan: () => Promise.reject(new Error('x')),
    getAccountCreditsHeatmap: () => Promise.reject(new Error('x')),
    getAccountProfileMetrics: () => Promise.reject(new Error('x')),
    listChatComposerModels: () => ([{ modelKey: 'k', modelDisplayName: 'N' }]),
  };
  mod.setState({ meta: {}, local: {}, account: null, external: null });
  mod.mount(f.host, { baseUrl: 'http://127.0.0.1:9', token: 't14b' });
  mod.expand();
  await flushMicrotasks(); await flushMicrotasks(); await flushMicrotasks();
  assert.equal(f.fetchCalls.filter((c) => c.init && c.init.method === 'POST').length, 0,
    'models 有数不触发 POST（守卫只看 usage/plan/heatmap/metrics）');
  // models 抛异常（缺失/旧 client）→ 记 null，usage 有数照常 POST
  const g = makeFakeDom();
  g.win.qoderDesktop = {
    getAccountUsage: () => ({ u: 1 }),
    listChatComposerModels: () => { throw new Error('boom'); },
  };
  mod.setState({ meta: {}, local: {}, account: null, external: null });
  mod.mount(g.host, { baseUrl: 'http://127.0.0.1:9', token: 't14c' });
  g.fetchCalls.length = 0;
  mod.expand();
  await flushMicrotasks(); await flushMicrotasks();
  const post = g.fetchCalls.find((c) => c.init && c.init.method === 'POST');
  assert.ok(post, 'models 拒不服碍他源 → 仍 POST');
  assert.deepEqual(((_b)=>{ delete _b.debug; return _b; })(JSON.parse(post.init.body)), { usage: { u: 1 }, plan: null, heatmap: null, metrics: null, models: null });
});

test('T10 守卫：无 bridge → 永不表永不 POST；无凭据+有 bridge → 同样永不 POST（无凭据规则）', async () => {
  const mod = await import('../app/widget.js');
  // 无 bridge（harness/未打补丁 client）：带 token 也不起账户表
  const a = makeFakeDom();
  mod.setState({ meta: {}, local: {}, account: null, external: null });
  mod.mount(a.host, { baseUrl: '', token: 'tok' });
  assert.equal(a.timers.filter((t) => t.delay === mod.ACCOUNT_POLL_MS).length, 0);
  mod.expand();
  await flushMicrotasks(); await flushMicrotasks();
  assert.equal(a.fetchCalls.filter((c) => c.init && c.init.method === 'POST').length, 0, 'bridge 缺席绝不 POST');

  // 有 bridge、无凭据（无 token 无 bootstrap）：不起表；expand 触发也短路
  const b = makeFakeDom();
  b.win.qoderDesktop = { getAccountUsage: () => ({}), getAccountPlan: () => ({}) };
  mod.setState({ meta: {}, local: {}, account: null, external: null });
  mod.mount(b.host, { baseUrl: '' });
  assert.equal(b.timers.filter((t) => t.delay === mod.ACCOUNT_POLL_MS).length, 0, '无凭据不起账户表');
  mod.expand();
  await flushMicrotasks(); await flushMicrotasks();
  assert.equal(b.fetchCalls.length, 0, 'no token & no bootstrap → 永不 POST');
});

test('T10: bootstrap 首次换到 token → 立即补一次 POST（真机“安装时”首份 raw；spike 数据源）', async () => {
  const mod = await import('../app/widget.js');
  const f = makeFakeDom();
  f.win.qoderDesktop = { getAccountUsage: () => ({ ok: 1 }), getAccountPlan: () => ({ p: 2 }) };
  // 假 /state：bootstrap 成功响应带 X-QM-Token 头
  f.win.fetch = (url, init) => {
    f.fetchCalls.push({ url, init });
    if (init && init.method === 'POST') return Promise.resolve({ ok: true, status: 202, headers: { get: () => null }, json: () => Promise.resolve({ ok: true }) });
    return Promise.resolve({
      ok: true, status: 200,
      headers: { get: (k) => (String(k).toLowerCase() === 'x-qm-token' ? 'issued-tok' : null) },
      json: () => Promise.resolve({ meta: {}, local: {}, account: null, external: null }),
    });
  };
  mod.setState({ meta: {}, local: {}, account: null, external: null });
  mod.mount(f.host, { baseUrl: '', bootstrapCode: 'boot-1' }); // 无 token，仅 bootstrap
  await flushMicrotasks(); await flushMicrotasks(); await flushMicrotasks();
  const posts = f.fetchCalls.filter((c) => c.init && c.init.method === 'POST');
  assert.equal(posts.length, 1, 'bootstrap 换到 token 当轮即触发账户 POST');
  assert.equal(posts[0].init.headers['X-QM-Token'], 'issued-tok', 'POST 用换发下来的新 token');
});

// ---------------------------------------------------------------- T10: 面板一级折叠
// 行为：点模块标题栏折叠/展开该卡片；折叠态按模块 id 存 localStorage('qum.collapsed.v1')，
// 只存 true 的键（展开即删键）；重挂载/registerModule 重渲染后按存档/内存恢复。
// 断言全部落在外部可观测行为上（class 增删、箭头字形、localStorage 字符串），不测内部函数。

const COLLAPSED_KEY = 'qum.collapsed.v1';
const cellOf = (panel, id) => panel.children.find((c) => c.dataset.module === id);
const caretOf = (cell) => cell.children[0].children[1];
const state0 = { meta: {}, local: {}, account: null, external: null };

test('T10#1: default all expanded; dedicated module registers cleanly', async () => {
  const mod = await import('../app/widget.js');
  mod.registerModule({ id: 'col-demo', title: 'Col Demo', render: () => ({ nodeType: 1, children: [], append() {}, }) });
  const f = makeFakeDom();
  mod.setState(state0);
  const root = mod.mount(f.host, { baseUrl: '' });
  const panel = root.children[1];
  assert.ok(panel.children.length >= 2, 'panel rendered registered modules');
  for (const cell of panel.children) {
    assert.equal(cell.classList.contains('qum-collapsed'), false, `${cell.dataset.module} expanded by default`);
    assert.equal(caretOf(cell).textContent, '▾', `${cell.dataset.module} caret points down`);
  }
  const head = cellOf(panel, 'col-demo').children[0];
  assert.equal(head.className, 'qum-module-title');
  assert.equal(head.children[0].className, 'qum-module-name');
  assert.equal(head.children[0].textContent, 'Col Demo');
  assert.equal(head.children[1].className, 'qum-collapse');
  assert.equal(f.win.localStorage.getItem(COLLAPSED_KEY), null, 'no storage write before first toggle');
});

test('T10#2: head click collapses and writes {"col-demo":true}; second click removes the key', async () => {
  const mod = await import('../app/widget.js');
  const f = makeFakeDom();
  mod.setState(state0);
  const root = mod.mount(f.host, { baseUrl: '' });
  const panel = root.children[1];
  const cell = cellOf(panel, 'col-demo');
  cell.children[0].fire('click');
  assert.equal(cell.classList.contains('qum-collapsed'), true, 'collapse applied in place');
  assert.equal(caretOf(cell).textContent, '▸', 'caret flips to right');
  assert.equal(f.win.localStorage.getItem(COLLAPSED_KEY), '{"col-demo":true}');
  cell.children[0].fire('click');
  assert.equal(cell.classList.contains('qum-collapsed'), false, 'expand removes class');
  assert.equal(caretOf(cell).textContent, '▾');
  assert.equal(f.win.localStorage.getItem(COLLAPSED_KEY), '{}', 'expand deletes the key (true-only map)');
});

test('T10#3: registerModule re-render restores collapsed state; other modules unaffected', async () => {
  const mod = await import('../app/widget.js');
  const f = makeFakeDom();
  mod.setState(state0);
  const root = mod.mount(f.host, { baseUrl: '' });
  const panel = root.children[1];
  cellOf(panel, 'col-demo').children[0].fire('click'); // 折叠 col-demo
  assert.equal(cellOf(panel, 'col-demo').classList.contains('qum-collapsed'), true);
  mod.registerModule({ id: 'col-late', title: 'Col Late', render: () => ({ nodeType: 1, children: [], append() {}, }) });
  const cell2 = cellOf(panel, 'col-demo'); // 整面板已重建：新节点
  assert.equal(cell2.classList.contains('qum-collapsed'), true, 'collapsed survives full re-render (memory state)');
  assert.equal(caretOf(cell2).textContent, '▸');
  assert.equal(cellOf(panel, 'col-late').classList.contains('qum-collapsed'), false, 'new module starts expanded');
  cell2.children[0].fire('click'); // 收尾：内存与存档回全展开
  assert.equal(cellOf(panel, 'col-demo').classList.contains('qum-collapsed'), false);
});

test('T10#4: re-mount restores collapsed state from localStorage (same window)', async () => {
  const mod = await import('../app/widget.js');
  const f = makeFakeDom();
  mod.setState(state0);
  const root1 = mod.mount(f.host, { baseUrl: '' });
  cellOf(root1.children[1], 'col-demo').children[0].fire('click'); // 折叠并落盘
  const root2 = mod.mount(f.host, { baseUrl: '' }); // 同一 win 重挂载 → loadCollapsed 读存档
  const cell = cellOf(root2.children[1], 'col-demo');
  assert.equal(cell.classList.contains('qum-collapsed'), true, 'state restored from storage on mount');
  assert.equal(caretOf(cell).textContent, '▸');
  assert.equal(cellOf(root2.children[1], 'demo2').classList.contains('qum-collapsed'), false);
  cell.children[0].fire('click'); // 收尾：回全展开，避免污染后续文件末测试
});

test('T10#5: corrupted / non-object / non-true storage → all expanded, never throws', async () => {
  const mod = await import('../app/widget.js');
  const f = makeFakeDom();
  mod.setState(state0);
  f.win.localStorage.setItem(COLLAPSED_KEY, '{not json'); // 脏 JSON
  const root1 = mod.mount(f.host, { baseUrl: '' });
  for (const cell of root1.children[1].children) {
    assert.equal(cell.classList.contains('qum-collapsed'), false);
  }
  f.win.localStorage.setItem(COLLAPSED_KEY, '["col-demo"]'); // 数组非对象
  const root2 = mod.mount(f.host, { baseUrl: '' });
  assert.equal(cellOf(root2.children[1], 'col-demo').classList.contains('qum-collapsed'), false);
  f.win.localStorage.setItem(COLLAPSED_KEY, '{"col-demo":"yes"}'); // 值非 true → 忽略
  const root3 = mod.mount(f.host, { baseUrl: '' });
  assert.equal(cellOf(root3.children[1], 'col-demo').classList.contains('qum-collapsed'), false);
});

// ---- P3 T5: resolveActivePane 四级回落（活动 pane → 锚点所在 pane → 全页唯一 pane → null）----
// 自带最小假 DOM（专测回落链，不动共享 makeFakeDom 的既有行为）。
const mkPane = (sid, active) => ({ dataset: sid === undefined ? {} : { chatSessionId: sid }, ...(active ? { active: true } : {}), querySelector: () => null });
const mkDoc = (panes) => ({
  querySelector(sel) {
    if (sel === '[data-chat-session-id][data-active]') return panes.find((p) => p.dataset.chatSessionId && p.active) || null;
    if (sel === '[data-chat-session-id]') return panes.find((p) => p.dataset.chatSessionId) || null;
    return null;
  },
  querySelectorAll: () => panes.filter((p) => p.dataset.chatSessionId),
});

test('P3 T5 resolveActivePane: 命中活动 pane；回落锚点 pane；回落全页唯一 pane；歧义与全空 → 双 null；脏值不抛', async () => {
  const { resolveActivePane } = await import('../app/widget.js');
  const a = mkPane('S-a', true); const b = mkPane('S-b');
  const r1 = resolveActivePane(mkDoc([a, b]), null);
  assert.equal(r1.sessionId, 'S-a', '多个 pane 时取带 data-active 者');
  assert.equal(r1.pane, a);
  // ② 无活动标记，但锚点在自己的 pane 内
  const own = mkPane('S-c');
  const anchorIn = { closest: (sel) => (sel === '[data-chat-session-id]' ? own : null) };
  const r2 = resolveActivePane({ querySelector: () => null, querySelectorAll: () => [] }, anchorIn);
  assert.equal(r2.sessionId, 'S-c', '回落②：锚点 closest');
  assert.equal(r2.pane, own);
  // ③ 全页唯一 pane
  const only = mkPane('S-d');
  assert.equal(resolveActivePane(mkDoc([only]), null).sessionId, 'S-d', '回落③：全页唯一 pane');
  // ③ 不成立：两个 pane 且都无活动标记 → 不猜
  const r4 = resolveActivePane(mkDoc([mkPane('S-e'), mkPane('S-f')]), null);
  assert.deepEqual({ s: r4.sessionId, p: r4.pane }, { s: null, p: null }, '歧义时宁可不猜（硬暴露）');
  // ④ 全空
  const r5 = resolveActivePane({ querySelector: () => null, querySelectorAll: () => [] }, null);
  assert.equal(r5.sessionId, null); assert.equal(r5.pane, null);
  // 脏值与异常
  assert.equal(resolveActivePane({ querySelector: () => ({}), querySelectorAll: () => [] }, null).sessionId, null, 'pane 无 dataset → null，绝不抛');
  assert.equal(resolveActivePane(mkDoc([mkPane('')]), null).sessionId, null, '空串 sid 视为无');
  assert.equal(resolveActivePane({ querySelector() { throw new Error('detached'); } }, null).sessionId, null, 'DOM 访问异常一律吞成 null');
});

// ---- 2026-10-28 上游反馈 §1：身份属性白名单与权威顺序 ----
// 祖先链只认「值确实是会话 id 的具名会话容器属性」（0.4.11 bundle 实测）：
// data-chat-session-standalone-conversation / data-chat-session-id / data-session-id。
// 其它名字含 session 的属性（路由 / 上次会话指针）即便值命中已知会话也不采纳。
const attrNode = (attrs, parent = null) => ({
  attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })),
  getAttribute: (n) => (n in attrs ? String(attrs[n]) : null),
  get parentNode() { return parent; },
  parentElement: parent,
  closest: () => null,
});
const EMPTY_DOC = { querySelector: () => null, querySelectorAll: () => [] };

test('2026-10-28 §1 resolveActivePane: 只认白名单容器属性；锚点容器证据优先于侧栏近似；活动 pane 最优先', async () => {
  const { resolveActivePane } = await import('../app/widget.js');
  const known = new Set(['S-known', 'S-pane', 'S-root']);
  // 非白名单指针（路由/上次会话）→ 绝不采纳
  const badRoot = attrNode({ 'data-last-session-id': 'S-known' });
  const leafBad = attrNode({}, badRoot);
  const rBad = resolveActivePane(EMPTY_DOC, leafBad, known);
  assert.equal(rBad.sessionId, null, '名字含 session 但不在白名单 → 不采纳（哪怕值命中已知会话）');
  assert.deepEqual(rBad.diag.attrs, [], '诊断也不把它记成身份属性');
  // 单会话根（0.4.11 真机形态）→ method='attr'
  const goodRoot = attrNode({ 'data-chat-session-standalone-conversation': 'S-root' });
  const leaf = attrNode({}, goodRoot);
  const rRoot = resolveActivePane(EMPTY_DOC, leaf, known);
  assert.equal(rRoot.sessionId, 'S-root');
  assert.equal(rRoot.method, 'attr');
  assert.equal(rRoot.pane, goodRoot);
  assert.deepEqual(rRoot.diag.attrs, ['data-chat-session-standalone-conversation']);
  // 侧栏选中行（近似）与锚点容器（结构证据）冲突 → 取容器
  const rowEl = {
    attributes: [{ name: 'data-session-id', value: 'S-known' }],
    getAttribute: (n) => (n === 'data-session-id' ? 'S-known' : null),
    hasAttribute: (n) => n === 'data-session-id' || n === 'data-active',
    offsetParent: {},
  };
  const docWithRow = {
    querySelector: () => null,
    querySelectorAll: (sel) => (sel === '[data-session-id]' ? [rowEl] : []),
  };
  const rConflict = resolveActivePane(docWithRow, leaf, known);
  assert.equal(rConflict.sessionId, 'S-root', '锚点所在会话容器优先于侧栏选中行（近似信号）');
  assert.equal(rConflict.method, 'attr');
  // 显式活动 pane 仍压过一切
  const paneEl = mkPane('S-pane', true);
  const rPane = resolveActivePane(mkDoc([paneEl]), leaf, known);
  assert.equal(rPane.sessionId, 'S-pane');
  assert.equal(rPane.method, 'active');
});

test('2026-10-28 §1 withActiveTracking: 打标不修改入参；meta 缺失/乱值/空载荷也不抛', async () => {
  const { withActiveTracking } = await import('../app/widget.js');
  const src = { meta: { generatedAt: 5, scanErrors: [] }, local: { session: null } };
  const out = withActiveTracking(src, true);
  assert.equal(out.meta.activeTracked, true);
  assert.equal(out.meta.generatedAt, 5, '其它元数据原样保留');
  assert.equal(src.meta.activeTracked, undefined, '不得修改入参（daemon 响应对象只读原则）');
  assert.equal(out.local, src.local, '浅拷贝：大对象不复制');
  assert.equal(withActiveTracking(null, true).meta.activeTracked, true);
  assert.equal(withActiveTracking({ meta: 'x' }, false).meta.activeTracked, false);
});

// ---- 2026-10-28 §1/§2：悬停卡硬暴露与「0/名义」 ----
test('2026-10-28 悬停卡: activeTracked 无 active → 标题明确未识别、各行 --；实扣 0/名义>0 → 0/名义', async () => {
  const mod = await import('../app/widget.js');
  await import('../app/modules.js');
  const MOCK = JSON.parse(read('tests/harness/mock-state.json'));
  // ① 跟随中但未识别：绝不显示全局最新会话的数字
  const st = JSON.parse(JSON.stringify(MOCK));
  delete st.local.active;
  mod.setState(mod.withActiveTracking(st, true));
  const f1 = makeFakeDom();
  const root1 = mod.mount(f1.host, { baseUrl: '' });
  root1.fire('mouseenter');
  const t1 = deepText(root1.children[2]);
  assert.match(t1, /未识别当前会话/);
  assert.match(t1, /用量-- cr · -- tok/);
  assert.match(t1, /规模-- 轮 · -- 次 · -- 工具 · -- 失败/);
  assert.doesNotMatch(t1, /123\.4 cr/, '不得出现全局最新会话的 credits');
  // ② 实扣 0 / 名义 79.68 → 0/79.7
  const st2 = JSON.parse(JSON.stringify(MOCK));
  st2.local.active.session = { ...st2.local.active.session, creditsBillable: 0, credits: 79.68 };
  mod.setState(mod.withActiveTracking(st2, true));
  const f2 = makeFakeDom();
  const root2 = mod.mount(f2.host, { baseUrl: '' });
  root2.fire('mouseenter');
  const t2 = deepText(root2.children[2]);
  assert.match(t2, /用量0\/79\.7 cr · 128\.0k tok/, '实扣 0 并列名义');
  // ③ 旧快照（无标记）保持既有回落，标题不变
  mod.setState(st);
  const f3 = makeFakeDom();
  const root3 = mod.mount(f3.host, { baseUrl: '' });
  root3.fire('mouseenter');
  assert.match(deepText(root3.children[2]), /会话累计 · 全部请求/, '无标记的夹具仍按 P2 行为回落');
});


test('P3 T6: 有活动 pane → /state 带 session 参数；pane 切换 → sid 跟随并挂 300ms 去抖轮询', async () => {
  const mod = await import('../app/widget.js');
  const f = makeFakeDom();
  const A = f.addPaneWithAnchor('S-alpha', { active: true });
  const B = f.addPaneWithAnchor('S-beta');
  mod.mount(f.host, { baseUrl: 'http://x', token: 'tk' });
  assert.ok(f.fetchCalls.some((c) => /\/state\?session=S-alpha$/.test(c.url)),
    `URL 应带 session：${JSON.stringify(f.fetchCalls.map((c) => c.url))}`);
  assert.equal(mod.activeSessionId(), 'S-alpha');
  // 切活动 pane（真机＝点另一分栏）
  A.paneEl.active = false;
  B.paneEl.active = true;
  mod.refreshActivePane();
  assert.equal(mod.activeSessionId(), 'S-beta', '活动 pane 切换后 sid 跟随');
  assert.ok(f.timers.some((t) => t.delay === 300), 'sid 变化 → 300ms 去抖立即轮询定时器已挂');
  assert.ok(f.fetchCalls.every((c) => !/session=S-beta/.test(c.url)), '去抖未触发前不发新请求（不重复打 daemon）');
  const t300 = f.timers.find((t) => t.delay === 300);
  t300.fn();
  assert.ok(f.fetchCalls.some((c) => /\/state\?session=S-beta$/.test(c.url)),
    `去抖后轮询应带新 sid：${JSON.stringify(f.fetchCalls.map((c) => c.url))}`);
  // sid 未变时再 refresh：不重复挂去抖定时器
  const before = f.timers.filter((t) => t.delay === 300).length;
  mod.refreshActivePane();
  assert.equal(f.timers.filter((t) => t.delay === 300).length, before, 'sid 未变 → 不产生额外轮询');
});

test('P3 T6: 无任何 pane → 不带 session 参数（硬暴露由 T9 呈现层承担）', async () => {
  const mod = await import('../app/widget.js');
  const f = makeFakeDom();
  mod.mount(f.host, { baseUrl: 'http://x', token: 'tk' });
  assert.equal(mod.activeSessionId(), null);
  assert.ok(f.fetchCalls.length > 0 && f.fetchCalls.every((c) => !/session=/.test(c.url)),
    '未取到身份时不发带参请求（daemon 回 P2 形状 → 呈现层出 --）');
});

test('P3 T7: mock-state.json 含 local.active（{sessionId,lastTurn,session,pulse,turnSpeeds} 五键，等值于全局锚定会话）', () => {
  const s = JSON.parse(read('tests/harness/mock-state.json'));
  assert.equal(typeof s.local.active, 'object', 'active 必须是对象（缺席 = 硬暴露态）');
  assert.deepEqual(Object.keys(s.local.active).sort(), ['lastTurn', 'pulse', 'session', 'sessionId', 'turnSpeeds']);
  assert.equal(s.local.active.sessionId, s.local.lastTurn.sessionId, 'mock 里 active 即当前锚定会话');
  assert.equal(s.local.active.lastTurn.turnSec, s.local.lastTurn.turnSec);
  assert.equal(s.local.active.session.id, s.local.session.id);
  assert.equal(s.local.active.session.credits, s.local.session.credits);
  // 2026-10-30：波形与逐轮速度同为请求态字段（daemon buildActive 产出；缺省 null 由 upgrade 前快照容忍）
  assert.equal(s.local.active.pulse.sessionId, s.local.active.sessionId);
  assert.equal(s.local.active.turnSpeeds.sessionId, s.local.active.sessionId);
});

// ---- P3 T9: 底栏三分支（active 有但无末轮 → 空态；active 缺席 → 六列占位；正常 → 六列真值，v7）----
const slotCols = (root) => root.children[0].children.filter((c) => c.dataset && c.dataset.slot);
const deepText = (el) => (el.textContent || '') + (el.children || []).map(deepText).join(''); // 值在 renderMini 的内层 span 上
const colsText = (cols) => cols.map(deepText).join('|');

test('P3 T9 renderStrip（回退后契约）: active.lastTurn=null → 空态；active 缺席 → 出全局值', async () => {
  const mod = await import('../app/widget.js');
  await import('../app/modules.js');
  const MOCK = JSON.parse(read('tests/harness/mock-state.json'));
  const mountWith = (mut) => {
    const st = JSON.parse(JSON.stringify(MOCK));
    mut(st.local);
    const f = makeFakeDom();
    globalThis.document = f.doc;
    mod.setState(st);
    return mod.mount(f.host, { baseUrl: '' });
  };
  const r1 = mountWith((l) => { l.active = { sessionId: 'S-z', lastTurn: null, session: null }; });
  assert.match(deepText(r1.children[0]), /暂无回合数据/, 'active 在而末轮无 → 空态');
  assert.equal(slotCols(r1).length, 0);
  const r2 = mountWith((l) => { delete l.active; });
  assert.equal(slotCols(r2).length, 6, 'active 缺席 → v7 六列仍在');
  assert.match(colsText(slotCols(r2)), /12\.8万 tok/, '回落到全局会话（真机无 DOM 信号，用户裁定）');
  const r3 = mountWith(() => {});
  assert.match(colsText(slotCols(r3)), /12\.8万 tok/);
});

// ---- v7（2026-10-26 用户裁定：对齐客户端原生底栏）：悬停摘要卡 + 点击仍开完整面板 ----
test('v7 悬停摘要卡：折叠态 mouseenter 出「会话累计 · 全部请求」（精确千分位/命中/思考/工具/编辑）；mouseleave 隐藏；展开态不弹；点击 strip 仍开面板', async () => {
  const mod = await import('../app/widget.js');
  await import('../app/modules.js');
  const MOCK = JSON.parse(read('tests/harness/mock-state.json'));
  mod.setState(MOCK);
  const f = makeFakeDom();
  const root = mod.mount(f.host, { baseUrl: '' });
  const strip = root.children[0];
  const panel = root.children[1];
  const hover = root.children[2];
  // 悬停卡是 root 第三个子节点：不改 strip/panel 既有索引（大量验收脚本依赖 children[0]/[1]）
  assert.ok(hover && String(hover.className).includes('qum-hover'), '存在 .qum-hover 摘要卡');
  assert.equal(hover.hidden, true, '默认收起');
  root.fire('mouseenter');
  assert.equal(hover.hidden, false, '折叠态悬停显示');
  const t = deepText(hover);
  const sess = MOCK.local.active.session;
  assert.match(t, /会话累计 · 全部请求/);
  assert.match(t, /输入128,000 tok · 命中 86\.1%/, '输入：精确千分位 + 缓存命中率');
  assert.match(t, /输出94 tok · 思考 25/, '输出：含思考（三段估算）');
  assert.match(t, /用量123\.4 cr · 128\.0k tok/, 'credits 与 tokens 两口径并列，绝不折算');
  assert.match(t, /规模23 轮 · 187 次 · 42 工具 · 3 失败/, '规模：轮/请求/工具/失败');
  assert.ok(t.includes(fmtStamp(sess.firstTs)) && t.includes(fmtStamp(sess.lastTs)), '时间范围：完整起点/终点时刻');
  assert.match(t, /代码变更\+126 \/ −38 · 7 文件/, '代码变更：+行/−行/文件数');
  assert.ok(t.includes(fmtStamp(MOCK.meta.generatedAt)), '分析时刻 = 上次分析');
  assert.match(t, /点击展开完整面板/);
  root.fire('mouseleave');
  assert.equal(hover.hidden, true, '移出即隐藏');
  // 原生交互：悬停看摘要，点击开既有完整面板；面板展开时悬停不再弹摘要
  strip.fire('click');
  assert.equal(panel.hidden, false, '点击 strip 打开完整面板（行为不变）');
  root.fire('mouseenter');
  assert.equal(hover.hidden, true, '展开态悬停不弹摘要（避免遮挡面板）');
  strip.fire('click');
  assert.equal(panel.hidden, true, '再点收起面板');
  root.fire('mouseenter');
  assert.equal(hover.hidden, false, '收起后悬停恢复');
  root.fire('mouseleave');
});

test('v7 悬停摘要卡诚实降级：无会话数据 → 各行为 -- 占位，不抛不出假数', async () => {
  const mod = await import('../app/widget.js');
  mod.setState({ meta: { generatedAt: 0 }, local: {}, account: null, external: null });
  const f = makeFakeDom();
  const root = mod.mount(f.host, { baseUrl: '' });
  const hover = root.children[2];
  root.fire('mouseenter');
  assert.equal(hover.hidden, false);
  const t = deepText(hover);
  assert.match(t, /输入-- tok/);
  assert.match(t, /输出--/);
  assert.match(t, /用量-- cr · -- tok/);
  assert.match(t, /规模-- 轮 · -- 次 · -- 工具 · -- 失败/);
  assert.match(t, /代码变更--/);
});


// ---- P3 T5b：真机取证后的回落补强（可见 pane / 焦点 pane），并回报命中级别供诊断 ----
test('P3 T5b resolveActivePane: data-active 缺席时按"唯一可见 pane"命中；再回落焦点 pane；method 标注级别', async () => {
  const { resolveActivePane } = await import('../app/widget.js');
  const visPane = (sid, { active = false, visible = true } = {}) => ({
    dataset: { chatSessionId: sid }, ...(active ? { active: true } : {}),
    offsetParent: visible ? {} : null, getBoundingClientRect: () => ({ width: visible ? 800 : 0, height: visible ? 600 : 0 }),
    contains(other) { return this === other || (other && this.__kids ? this.__kids.includes(other) : false); },
  });
  // 标签页式：三个 pane 都挂载、都没有 data-active，只有一个是可见的
  const shown = visPane('S-shown'); const hid1 = visPane('S-h1', { visible: false }); const hid2 = visPane('S-h2', { visible: false });
  const doc3 = {
    querySelector: (sel) => (sel === '[data-chat-session-id][data-active]'
      ? [shown, hid1, hid2].find((p) => p.active) || null : null),
    querySelectorAll: () => [shown, hid1, hid2],
    activeElement: null,
  };
  let r = resolveActivePane(doc3, null);
  assert.equal(r.sessionId, 'S-shown', '唯一可见 pane 即当前查看的会话');
  assert.equal(r.method, 'visible');
  assert.equal(r.pane, shown);
  // 两个都可见（真分栏）→ 不猜，交给焦点元素那一级
  const b = visPane('S-b');
  const doc4 = { ...doc3, querySelectorAll: () => [shown, b], activeElement: b };
  containsOf(shown, []); containsOf(b, [b]);
  r = resolveActivePane(doc4, null);
  assert.equal(r.sessionId, 'S-b', '多 pane 可见时用 document.activeElement 所在 pane');
  assert.equal(r.method, 'focus');
  // 焦点也不在任何一个 pane 里 → 仍不猜（硬暴露），method 记录歧义原因
  const doc5 = { ...doc4, activeElement: {} };
  r = resolveActivePane(doc5, null);
  assert.equal(r.sessionId, null, '歧义时绝不猜第一个');
  assert.equal(r.method, 'ambiguous');
  // 诊断计数：真机排障用（多少个 pane、几个可见、有无 active 标记）
  const d = resolveActivePane(doc3, null).diag;
  assert.deepEqual({ panes: d.panes, visible: d.visible, activeMarked: d.activeMarked }, { panes: 3, visible: 1, activeMarked: 0 });
});
function containsOf(el, kids) { el.contains = (o) => o === el || kids.includes(o); }

// ---- P3 T12：活动会话诊断回报（免 DevTools 的真机排障通道）----
test('P3 T12 activeDiagnostics: 无 pane → sid null/method null 且计数为 0；有活动 pane → 带 sid 与命中级别', async () => {
  const mod = await import('../app/widget.js');
  const f = makeFakeDom();
  mod.setState({ meta: {}, local: {}, account: null, external: null });
  mod.mount(f.host, { baseUrl: '' });
  assert.deepEqual(mod.activeDiagnostics(), { sid: null, method: null, panes: 0, activeMarked: 0, visible: 0, attrs: [],
    anchorFound: false, docSize: 0, docSessionAttrs: [], docKnownHit: null,
    host: { inDoc: true, onComposer: false, hostVisible: true, composers: 0, visibleComposers: 0, fallback: null } },
  '0.4.9：host 段回报「strip 到底挂没挂上」——debug.json 一眼分辨失联/挂错宿主');
  const f2 = makeFakeDom();
  f2.addPaneWithAnchor('S-diag', { active: true });
  mod.setState({ meta: {}, local: {}, account: null, external: null });
  mod.mount(f2.host, { baseUrl: '' });
  const d = mod.activeDiagnostics();
  assert.equal(d.sid, 'S-diag'); assert.equal(d.method, 'active');
  assert.equal(d.panes, 1); assert.equal(d.activeMarked, 1);
});

// ---- P3 T13（2026-10-28 二次修订）：祖先链只认白名单会话容器属性 ----
// 旧契约「任意 data-*session* 属性命中已知 id 即采信」正是上游反馈 §1 的根因之一：
// 路由/上次会话指针这类属性会把别的会话 id 塞进来。现只认结构化容器白名单。
// 2026-10-28 用户反馈 §2：结构性容器（值 = sessionId）**不依赖**已知集合——新建会话在
// daemon 首次扫描/发布前也必须跟随，否则首轮整条 strip 全 '--'（被误读为自定义模型没数据）。
test('P3 T13 resolveActivePane: 祖先链只认白名单容器属性；结构容器跟随新会话；侧栏属性仍须已知', async () => {
  const { resolveActivePane } = await import('../app/widget.js');
  const mk = (attrs, parent) => ({
    attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })),
    parentElement: parent || null, parentNode: parent || null, dataset: {},
  });
  const known = new Set(['S-real', 'S-other']);
  const NEW_SID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
  const emptyDoc = { querySelector: () => null, querySelectorAll: () => [] };
  // 非白名单属性（旧客户端形态 data-conv-session）即使值命中已知 id → 不采纳
  const oldRoot = mk({ 'data-conv-session': 'S-real', 'data-testid': 'chat-view' });
  const oldMid = mk({ 'data-role': 'composer' }, oldRoot);
  const oldAnchor = mk({ 'data-turn-status-bar': '1' }, oldMid);
  const rOld = resolveActivePane(emptyDoc, oldAnchor, known);
  assert.equal(rOld.sessionId, null, '非白名单属性绝不采信（哪怕值命中已知会话）');
  assert.deepEqual(rOld.diag.attrs, [], '诊断身份属性只记白名单名');
  // 白名单单会话根（0.4.11 真机形态）→ method='attr'
  const root = mk({ 'data-chat-session-standalone-conversation': 'S-real', 'data-testid': 'chat-view' });
  const mid = mk({ 'data-role': 'composer' }, root);
  const anchor = mk({ 'data-turn-status-bar': '1' }, mid);
  const r = resolveActivePane(emptyDoc, anchor, known);
  assert.equal(r.sessionId, 'S-real', '白名单属性 + 已知值 → 命中');
  assert.equal(r.method, 'attr');
  assert.deepEqual(r.diag.attrs, ['data-chat-session-standalone-conversation'],
    '诊断只记祖先链上的白名单属性名（不含值，避免把会话内容外传）');
  // 结构容器 + 值不在已知集合（新建会话，daemon 尚未发布）→ 仍采信（首轮跟随）
  const root2 = mk({ 'data-chat-session-standalone-conversation': NEW_SID });
  const a2 = mk({ 'data-turn-status-bar': '1' }, root2);
  const r2 = resolveActivePane(emptyDoc, a2, known);
  assert.equal(r2.sessionId, NEW_SID, '结构容器值不依赖已知集合');
  assert.equal(r2.method, 'attr');
  // 已知集合为空（首轮 /state 前）→ 结构容器同样采信
  assert.equal(resolveActivePane(emptyDoc, anchor, new Set()).sessionId, 'S-real',
    '无已知 id 时结构容器仍可跟随');
  // 侧栏行属性 data-session-id 不是结构容器：未知值仍不采信（近似信号守门）
  const root3 = mk({ 'data-session-id': NEW_SID });
  const a3 = mk({ 'data-turn-status-bar': '1' }, root3);
  assert.equal(resolveActivePane(emptyDoc, a3, known).sessionId, null,
    'data-session-id 未知值不采信');
});

test('P3 T13b resolveActivePane: data-chat-session-id pane 的新会话 id 不依赖已知集合', async () => {
  const { resolveActivePane } = await import('../app/widget.js');
  const NEW_SID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
  const own = mkPane(NEW_SID);
  const anchor = { closest: (sel) => (sel === '[data-chat-session-id]' ? own : null) };
  const doc = { querySelector: () => null, querySelectorAll: () => [] };
  const r = resolveActivePane(doc, anchor, new Set(['S-known']));
  assert.equal(r.sessionId, NEW_SID, '锚点所在 pane 的 dataset id 是结构证据');
  assert.equal(r.method, 'anchor');
  assert.equal(r.pane, own);
});

// ---- P3 T14：侧栏选中行信号（真机唯一可用来源，method='sidebar'）----
test('P3 T14 resolveActivePane: 无 pane 时用侧栏选中行的 data-session-id；无选中态且多行可见则不猜', async () => {
  const { resolveActivePane } = await import('../app/widget.js');
  const row = (sid, attrs = {}, visible = true) => ({
    attributes: [{ name: 'data-session-id', value: sid }, ...Object.entries(attrs).map(([name, value]) => ({ name, value }))],
    getAttribute: (n) => (n === 'data-session-id' ? sid : (n in attrs ? String(attrs[n]) : null)),
    hasAttribute: (n) => n === 'data-session-id' || n in attrs,
    offsetParent: visible ? {} : null,
    getBoundingClientRect: () => ({ width: visible ? 200 : 0, height: visible ? 24 : 0 }),
  });
  const known = new Set(['S-a', 'S-b']);
  const rows = [row('S-a', { 'data-selected': '' }), row('S-b')];
  const doc = { querySelector: () => null, querySelectorAll: (sel) => (sel === '[data-session-id]' ? rows : []) };
  const r = resolveActivePane(doc, null, known);
  assert.equal(r.sessionId, 'S-a', '取带选中态的那一行');
  assert.equal(r.method, 'sidebar');
  // 无选中态且两行都可见 → 不猜
  const doc2 = { querySelector: () => null, querySelectorAll: (sel) => (sel === '[data-session-id]' ? [row('S-a'), row('S-b')] : []) };
  assert.equal(resolveActivePane(doc2, null, known).sessionId, null);
  // 无选中态但只有一行可见 → 采信可见行
  const doc3 = { querySelector: () => null, querySelectorAll: (sel) => (sel === '[data-session-id]' ? [row('S-a', {}, true), row('S-b', {}, false)] : []) };
  assert.equal(resolveActivePane(doc3, null, known).sessionId, 'S-a');
  // 值不在已知会话集合里 → 绝不采信（避免把别处的 data-session-id 当会话）
  const doc4 = { querySelector: () => null, querySelectorAll: (sel) => (sel === '[data-session-id]' ? [row('unknown-1', { 'data-selected': '' })] : []) };
  assert.equal(resolveActivePane(doc4, null, known).sessionId, null);
});

// ---- 2026-10-21 用户裁定：插件信息移入对话输入框底部 ----
test('findComposer: 活动 pane 自身就是 composer（harness 形态）时不得返回 null', async () => {
  const { findComposer } = await import('../app/widget.js');
  const f = makeFakeDom();
  const { composer } = f.addComposer();
  // 真机 harness：data-chat-session-id 直接落在 [data-chat-composer] 上
  assert.equal(findComposer(f.doc, composer, 'active'), composer, 'self 必须命中，否则随后会退回旧锚点把 root 挪出去');
  // 常规 wrapper pane 内嵌 composer（真 DOM 元素必有 querySelector，假工厂按需补一个）；
  // 2026-10-23：pane 必须真的在文档里（失联 pane 现在会被当作不存在）
  const pane = f.makeEl('div');
  pane.appendChild(composer);
  f.host.appendChild(pane);
  pane.querySelector = (sel) => (sel === '[data-chat-composer]' ? composer : null);
  assert.equal(findComposer(f.doc, pane, 'active'), composer);
  // 活动 pane 内无 composer 且非 sidebar → 不跨 pane 抢别处输入框
  const empty = f.makeEl('div');
  assert.equal(findComposer(f.doc, empty, 'active'), null);
  // 侧栏近似行 → 允许文档级回落
  assert.equal(findComposer(f.doc, empty, 'sidebar'), composer);
});

test('输入框宿主：composer 存在时 root 挂在卡片末尾（底部），带内嵌类且不再 fixed', async () => {
  const mod = await import('../app/widget.js');
  const f = makeFakeDom();
  const { composer } = f.addComposer();
  mod.setState({ meta: {}, local: {}, account: null, external: null });
  const root = mod.mount(f.host, { baseUrl: '' });
  assert.equal(root.parentNode, composer, '优先 composer，而非 body/fixed');
  assert.equal(composer.children[composer.children.length - 1], root, '挂到卡片末尾（输入框底部）');
  assert.equal(root.classList.contains('qum-in-composer'), true);
  assert.equal(root.classList.contains('qum-fixed'), false);
});

test('输入框宿主：React 摘掉 root 后，观察器节流 250ms 自愈重挂到卡片末尾', async () => {
  const mod = await import('../app/widget.js');
  const f = makeFakeDom();
  const { composer } = f.addComposer();
  mod.setState({ meta: {}, local: {}, account: null, external: null });
  const root = mod.mount(f.host, { baseUrl: '' });
  assert.equal(root.parentNode, composer);
  composer.removeChild(root);
  assert.equal(root.parentNode, null, '模拟 React 重渲染摘除外来节点');
  assert.equal(typeof f.win.__moCallback, 'function', '真机观察器必须已接线');
  f.win.__moCallback();
  const t = f.timers.find((x) => x.delay === 250);
  assert.ok(t, '观察器回调应经 250ms 节流');
  t.fn();
  assert.equal(root.parentNode, composer, '自愈重挂回同一 composer');
  assert.equal(composer.children[composer.children.length - 1], root, '重挂仍在卡片末尾');
});

// ---- 0.4.9 回归：React 把整棵会话视图换掉（composer 随祖先一起脱离文档）----
// 真机症状：debug.json 新鲜、sid/method 正常，但窗口里看不到 strip。根因是宿主判定只看
// 「旧 pane 里还能不能查到 composer」，不校验该子树是否仍在文档中；整棵视图被卸载后，
// root 与旧 composer 一起躺在 detached 子树里，观察器与旧逻辑都认为「无需重挂」。
test('0.4.9 回归: 旧会话视图整棵被 React 卸载 → 观察器必须把 root 重挂到同会话的新 composer', async () => {
  const mod = await import('../app/widget.js');
  const f = makeFakeDom();
  mod.setState({ meta: {}, local: { sessions: [{ id: 'S-live' }] }, account: null, external: null });
  // 与真机同形的祖先链：standalone-conversation（带会话 id）> composer
  const oldWrap = f.makeEl('div');
  oldWrap.setAttribute('data-chat-session-standalone-conversation', 'S-live');
  const oldComposer = f.makeEl('div');
  oldComposer.setAttribute('data-chat-composer', '1');
  oldWrap.append(oldComposer);
  oldWrap.querySelector = (sel) => (sel === '[data-chat-composer]' ? oldComposer : null);
  f.host.append(oldWrap);
  f.doc.__composers = [oldComposer];
  const root = mod.mount(f.host, { baseUrl: '' });
  assert.equal(root.parentNode, oldComposer, '首帧挂在当时唯一的 composer');

  // React 卸载旧视图（root 随之脱离文档），挂上同一会话的新视图
  f.host.removeChild(oldWrap);
  const newWrap = f.makeEl('div');
  newWrap.setAttribute('data-chat-session-standalone-conversation', 'S-live');
  const newComposer = f.makeEl('div');
  newComposer.setAttribute('data-chat-composer', '1');
  newWrap.append(newComposer);
  newWrap.querySelector = (sel) => (sel === '[data-chat-composer]' ? newComposer : null);
  f.host.append(newWrap);
  f.doc.__composers = [newComposer];

  f.win.__moCallback();
  const t = f.timers.find((x) => x.delay === 250);
  assert.ok(t, '观察器回调应经 250ms 节流');
  t.fn();
  assert.equal(root.parentNode, newComposer, '旧宿主已脱离文档：必须跟随到新 composer，否则 strip 永久不可见');
  const host = mod.activeDiagnostics().host;
  assert.equal(host.inDoc, true, '自愈后 root 必须回到文档内');
  assert.equal(host.onComposer, true);
});

test('0.4.9 回归: 无 mutation 时由看门狗兜底（root 脱离文档 → 重挂到新宿主）', async () => {
  const mod = await import('../app/widget.js');
  const f = makeFakeDom();
  const { composer } = f.addComposer();
  mod.setState({ meta: {}, local: {}, account: null, external: null });
  const root = mod.mount(f.host, { baseUrl: '' });
  assert.equal(root.parentNode, composer);
  // 整张卡被替换，但恰好奇没有触发观察器（此处不手动调 __moCallback）
  f.host.removeChild(composer);
  const fresh = f.makeEl('div');
  fresh.setAttribute('data-chat-composer', '1');
  f.host.append(fresh);
  f.doc.__composers = [fresh];
  const w = f.timers.find((x) => x.delay === mod.HOST_WATCH_MS);
  assert.ok(w, 'mount 后应起宿主看门狗');
  w.fn();
  assert.equal(root.parentNode, fresh, '看门狗必须把脱离文档的 root 拉回新宿主');
});

test('findComposer 文档级回落: 多会话视图同时挂载时优先可见 composer', async () => {
  const { findComposer } = await import('../app/widget.js');
  const f = makeFakeDom();
  const hidden = f.addComposer().composer;
  const shown = f.addComposer().composer;
  hidden.getBoundingClientRect = () => ({ width: 0, height: 0 });
  shown.getBoundingClientRect = () => ({ width: 640, height: 120 });
  assert.equal(findComposer(f.doc, null, null), shown, '0×0（后台标签视图）不该被当作宿主');
  assert.equal(findComposer(f.doc, null, 'sidebar'), shown);
});
