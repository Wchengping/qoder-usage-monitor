// tests/modules.test.mjs
// Task 9 + P1.5 — app/modules.js 模块集冒烟（零新依赖，沿用 T8 假 DOM 模式）。
// P1.5 用户裁定（真实模型）：Qoder 无 5h/周额度上限（那是参考项目 Claude 式假模型），
// quota-5h/quota-week 两条假额度条删除；资源包升级为真仪表（pack：used/total fill +
// 已用/剩余 事实行，无 pace tick 无倒计时）；usage（用量节奏）在 v8 因与 consumption
// 重复已删除。coverage：注册表元数据（13 模块 +
// session.slotIds 双迷你槽）、pickPack 候选键链全防御、各模块 render（含 legacy 槽位
// 迁移容忍：旧 miniSlots 未注册 → 整体回落新默认）、widget ctx.fmt 注入 + strip/panel 集成。
// 控制器裁定（binding）：不倒计时、不读 window.resetAt；pack 候选键缺失 → --；
// cacheHitRate null → --；mascot 阈值 keying = addOnQuota（used/total 或 percentage），
// 无账户数据 🫥、有账户但 addOnQuota 读不出 → 🙂 中性。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fmtClock } from '../app/format.js';

const REPO = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const mock = JSON.parse(read('tests/harness/mock-state.json'));

// T14（用户报告）：BYOK 自定义模型 id（session jsonl `model` 字段的 byok 形态）——mock 目录里
// 映射到人类名 'DeepSeek-Flash'。helper 在 mock 上覆写本地会话字段以驱动解析/回落分支。
const BYOK_ID = '11111111-1111-4111-8111-111111111111';
const withSession = (partial) => syncActive({ ...mock, local: { ...mock.local, session: { ...mock.local.session, ...partial } } });
// T9（strip v5）：迷你槽读 local.lastTurn——helper 在其上覆写字段驱动 mini 分支（面板仍读 session）。
// P3：存量 P2 用例的语义是「给定末轮/会话数据 → 出某文案」，等价于"用户正在看这个锚定会话"。
// 三模块取数源换到 local.active 后，用本助手把 active 与 lastTurn/session 同步（深拷贝，
// 绝不改动共享 mock），断言文案本身一字不改。P3 新增用例自行构造分歧态，不经本助手。
const syncActive = (st) => {
  if (!st || !st.local) return st;
  const c = JSON.parse(JSON.stringify(st));
  const lt = c.local.lastTurn;
  const se = c.local.session;
  const prev = c.local.active && typeof c.local.active === 'object' ? c.local.active : {};
  c.local.active = {
    sessionId: (lt && lt.sessionId) || (se && se.id) || null,
    lastTurn: lt === undefined ? null : lt,
    session: se === undefined ? null : se,
    // 2026-10-30：波形 / 逐轮速度同为请求态 active 字段（缺省 null，模拟升级前 daemon）
    pulse: prev.pulse === undefined ? null : prev.pulse,
    turnSpeeds: prev.turnSpeeds === undefined ? null : prev.turnSpeeds,
  };
  return c;
};

const withLt = (partial) => syncActive({ ...mock, local: { ...mock.local, lastTurn: { ...mock.local.lastTurn, ...partial } } });

// ---------------------------------------------------------------- 假 DOM
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
    get className() { return [...classes].join(' '); },
    set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
    classList: {
      add: (...cs) => cs.forEach((c) => classes.add(c)),
      remove: (...cs) => cs.forEach((c) => classes.delete(c)),
      contains: (c) => classes.has(c),
      toggle: (c, force) => { const on = force === undefined ? !classes.has(c) : !!force; if (on) classes.add(c); else classes.delete(c); return on; },
    },
    get textContent() { return el._text; },
    set textContent(v) { el._text = String(v); el.children = []; },
    append(...ns) { for (const n of ns) if (n) { el.children.push(n); n.parentNode = el; } },
    appendChild(n) { el.append(n); return n; },
    replaceChildren(...ns) { el.children = []; el.append(...ns); },
    removeChild(n) { const i = el.children.indexOf(n); if (i !== -1) { el.children.splice(i, 1); n.parentNode = null; } },
    remove() { if (el.parentNode) el.parentNode.removeChild(el); },
    insertBefore(node, ref) { const i = el.children.indexOf(ref); if (i === -1) el.append(node); else { el.children.splice(i, 0, node); node.parentNode = el; } },
    setAttribute(k, v) { el.attrs[k] = String(v); },
    getAttribute(k) { return k in el.attrs ? el.attrs[k] : null; },
    removeAttribute(k) { delete el.attrs[k]; },
    _listeners: {},
    addEventListener(type, fn) { (el._listeners[type] = el._listeners[type] || []).push(fn); },
    // v8.1：keydown 需要读 event.key → fire 允许携带事件载荷（缺省空对象，旧用例不变）
    fire(type, ev) { (el._listeners[type] || []).forEach((fn) => fn(ev || {})); },
  };
  return el;
}
const fakeDoc = {
  createElement: (t) => makeEl(t),
  // 2026-10-30：波形 SVG（pulse 模块）经 createElementNS 创建；假 DOM 同样记录属性/子节点。
  createElementNS: (_ns, t) => makeEl(t),
};
globalThis.document = fakeDoc; // 模块 render 只经 globalThis.document（顶层不摸）

// 与真实 DOM textContent 语义一致：子树文本无分隔拼接。
function textOf(el) {
  return el._text + el.children.map(textOf).join('');
}
function findAll(el, cls, acc = []) {
  if (String(el.className).split(/\s+/).includes(cls)) acc.push(el);
  for (const c of el.children) findAll(c, cls, acc);
  return acc;
}

// ---------------------------------------------------------------- 模块注册表
// T13：bridge 两新源 → 面板两新模块（heatmap 用量热力 / metrics 累计指标）。
// 二者都不是 strip 槽（无 renderMini），defaultSize 沿用 P1 约定 'half'。
// Strip layout v3（用户裁定）：strip 两槽 = tokens（今日计费输入）+ turnsec（平均回合秒），
// 分别由 consumption/speed 经 slotIds 提供服务。pack/session 移出 strip（面板专有）——
// 二者无 renderMini → 旧存档里的 pack/session/session-rate/usage-5h/usage-week 槽
// 一律未注册 → 命中 hasMini 整条回落机制。
// T13+（strip v4 / 模型名 / 会话明细）：strip 四槽 = model（session）+ tokens（consumption）+
// tps（speed）+ turnsec（speed）；新增 sessions 模块（会话明细，panel 专有）。
// P2 修订④：新增 models（「按模型消耗」全宽卡片列表，supports:['full']/defaultSize:'full'）。
// P2（strip v5 两行式 / T9）：五槽 = model + tokens + credits（皆 lastTurn 数据面）+ tps + turnsec。
// v6（2026-10-22 用户裁定）：模型槽删除（输入框自身已显示模型名）+ 标签行删除 → 单行四槽
// tokens/credits/tps/turnsec；哨兵 = 含 'credits' 且不含 'model'（v4/v5 存档 → 整条回落 v6）。
// v7（2026-10-26 用户裁定：对齐客户端原生底栏）：默认六槽 = tps（会话近30分钟生成速度）+
// quota（资源包剩余 %）+ session（会话簇：tokens 万/命中/轮/请求）+ tools（工具/失败）+
// credits（会话累计）+ turnsec（最新一轮秒）；新增 tools 模块；pack/session 恢复 strip 迷你槽。
// 哨兵 = 含 session/tools/credits 且不含 model（v4/v5/v6 存档 → 整条回落 v7）。
// v8（2026-10-30 用户裁定）：面板顶部新增 pulse（用量波形，full）+ turnspeed（逐轮生成速度，full）；
// usage（用量节奏）与 consumption 今日行重复，按"删重复"裁定整体删除（含 strip 无槽）。
// 二者皆 panel 专有（无 renderMini/slotIds），不影响 v7 六槽哨兵。
const EXPECTED_IDS = ['pulse', 'turnspeed', 'session', 'sessions', 'models', 'consumption', 'cache', 'speed', 'tools', 'pack', 'mascot', 'heatmap', 'metrics'];

const widget = await import('../app/widget.js'); // 先 widget：验证注册表确实从空开始
test('pre-modules registry is empty; importing modules.js registers the P1.5 module set in order', async () => {
  assert.deepEqual(widget.getModules().map((m) => m.id), []); // T8 契约：import widget 不注册
  const modules = await import('../app/modules.js');
  const mods = widget.getModules();
  assert.deepEqual(mods.map((m) => m.id), EXPECTED_IDS);
  assert.equal(mods.some((m) => m.id === 'quota-5h' || m.id === 'quota-week'), false,
    'P1.5：假额度条模块已删除（用户裁定：Qoder 无 5h/周额度上限）');
  for (const m of mods) {
    if (['models', 'pulse', 'turnspeed'].includes(m.id)) continue; // 全宽卡片：supports:['full']/defaultSize:'full'（下方单独断言）
    assert.deepEqual(m.supports, ['half', 'full'], `${m.id} supports`);
    // P2 预览裁定：本会话 byModel 表（目标 2）、会话明细手风琴（验收 2）、时长三行（目标 4）
    // 均只存在于 full 分支——模块须以 full 进面板，否则真机不可达。其余模块维持 P1.5 的 half 紧凑形态。
    const wantFull = ['session', 'sessions', 'speed'].includes(m.id);
    assert.equal(m.defaultSize, wantFull ? 'full' : 'half', `${m.id} defaultSize`);
    assert.equal(typeof m.render, 'function', `${m.id} render`);
    assert.ok(m.title && typeof m.title === 'string', `${m.id} title`);
  }
  const modelsMod = mods.find((m) => m.id === 'models');
  assert.deepEqual(modelsMod.supports, ['full'], 'models supports（panel 专有全文卡片）');
  assert.equal(modelsMod.defaultSize, 'full', 'models defaultSize');
  assert.equal(modelsMod.title, '按模型消耗');
  assert.equal(typeof modelsMod.render, 'function');
  assert.equal(modelsMod.slotIds, undefined, 'models 非 strip 槽');
  assert.equal(typeof modelsMod.renderMini, 'undefined');
  // strip 六槽（v7）：tps/turnsec←speed、credits←consumption、quota←pack、session←session、
  // tools←tools。每个槽都必须有 renderMini 变体（哨兵 every(hasMini) 仍是回落前提）。
  const miniIds = mods.filter((m) => typeof m.renderMini === 'function').map((m) => m.id);
  assert.deepEqual(miniIds.sort(), ['consumption', 'pack', 'session', 'speed', 'tools']);
  // v8：usage（用量节奏）已删（与 consumption 重复）；波形/逐轮速度均为 full 卡片，panel 专有。
  assert.equal(mods.some((m) => m.id === 'usage'), false, 'usage 模块删除（2026-10-30 用户裁定：删重复）');
  const pulse = mods.find((m) => m.id === 'pulse');
  assert.equal(pulse.title, '用量波形');
  assert.deepEqual(pulse.supports, ['full']);
  assert.equal(pulse.defaultSize, 'full');
  assert.equal(pulse.slotIds, undefined, 'pulse 非 strip 槽');
  assert.equal(typeof pulse.renderMini, 'undefined');
  assert.equal(typeof pulse.render, 'function');
  const turnspeed = mods.find((m) => m.id === 'turnspeed');
  assert.equal(turnspeed.title, '逐轮生成速度');
  assert.deepEqual(turnspeed.supports, ['full']);
  assert.equal(turnspeed.defaultSize, 'full');
  assert.equal(turnspeed.slotIds, undefined, 'turnspeed 非 strip 槽');
  assert.equal(typeof turnspeed.renderMini, 'undefined');
  const consumption = mods.find((m) => m.id === 'consumption');
  assert.deepEqual(consumption.slotIds, ['tokens', 'credits'], 'consumption 经 slotIds 服务 tokens（末轮计费输入）+ credits（会话累计）两槽');
  const speed = mods.find((m) => m.id === 'speed');
  assert.deepEqual(speed.slotIds, ['turnsec', 'tps'], 'speed 经 slotIds 服务 turnsec（末轮耗时秒）+ tps（会话生成速度 outTps30）两槽');
  const session = mods.find((m) => m.id === 'session');
  assert.deepEqual(session.slotIds, ['session'], 'session 服务 v7 会话簇迷你槽（tokens 万/命中/轮/请求）');
  assert.equal(typeof session.renderMini, 'function', 'session 有 renderMini（v7 会话簇）');
  assert.equal(session.title, '当前会话');
  const sessions = mods.find((m) => m.id === 'sessions');
  assert.equal(sessions.title, '会话明细');
  assert.equal(sessions.slotIds, undefined, '会话明细面板专有（无 strip 槽）');
  assert.equal(typeof sessions.renderMini, 'undefined');
  const pack = mods.find((m) => m.id === 'pack');
  assert.deepEqual(pack.slotIds, ['quota'], 'pack 经 slotIds 服务 quota（资源包剩余 %）槽');
  assert.equal(typeof pack.renderMini, 'function', 'pack 有 renderMini（v7 额度 %）');
  assert.equal(pack.title, '资源包');
  const tools = mods.find((m) => m.id === 'tools');
  assert.deepEqual(tools.slotIds, ['tools'], 'tools 经 slotIds 服务 tools 槽');
  assert.equal(typeof tools.renderMini, 'function');
  assert.equal(tools.title, '工具与失败');
  assert.equal(typeof modules.pickPack, 'function');
  assert.equal(typeof modules.quotaAgg, 'function', 'quotaAgg：套餐资源包聚合（addOn + dedicated，2026-10-30 用户反馈）');
});

// ---------------------------------------------------------------- pickPack
test('pickPack: T12 真机 HEAD（addOnQuota.remaining）+ 钉死旧链兜底 + packRem 优先（T9“无实据不加第三候选”由本 spike 满足）', async () => {
  const { pickPack } = await import('../app/modules.js');
  assert.equal(pickPack({ raw: { resource_package_quota: { quota_summary: { remaining_value: 50 } } } }), 50);
  assert.equal(pickPack({ raw: { resourcePack: { remaining: 42 } } }), 42);
  assert.equal(pickPack({ raw: { resource_package_quota: { remaining: 300 } } }), null); // 链 1 无 quota_summary → 链 2 无 resourcePack → null
  assert.equal(pickPack(null), null);
  assert.equal(pickPack({}), null);
  assert.equal(pickPack({ raw: 'not-an-object' }), null);
  assert.equal(pickPack({ raw: { resource_package_quota: { quota_summary: { remaining_value: 'x' } } } }), null); // 非数字拒绝
  // T10：{usage,plan} 桥体容器 —— 候选链在 usage 壳内同样命中
  assert.equal(pickPack({ raw: { usage: { resource_package_quota: { quota_summary: { remaining_value: 88 } } } } }), 88);
  assert.equal(pickPack({ raw: { usage: {}, plan: { resourcePack: { remaining: 7 } } } }), 7);
  // T10：服务端解析字段优先（packRem 有限数即取，raw 链不再生效）
  assert.equal(pickPack({ packRem: 77, raw: { resourcePack: { remaining: 42 } } }), 77);
  assert.equal(pickPack({ packRem: null, raw: { resourcePack: { remaining: 42 } } }), 42); // null → 落链
  // T12 spike 真机 HEAD：usage.qoderUsage.addOnQuota.remaining 先于钉死旧链
  assert.equal(pickPack({ raw: { usage: { qoderUsage: { addOnQuota: { remaining: 450 } } } } }), 450);
  assert.equal(pickPack({ raw: { usage: { qoderUsage: { addOnQuota: { remaining: 450 } }, resource_package_quota: { quota_summary: { remaining_value: 50 } } } } }), 450); // HEAD 优先
  assert.equal(pickPack({ raw: { usage: { qoderUsage: { addOnQuota: { remaining: 'x' } } }, plan: { resourcePack: { remaining: 42 } } } }), 42); // 非数字 → 仍落旧链
  assert.equal(pickPack({ raw: { usage: { qoderUsage: 'nope' } } }), null); // 乱壳不抛
  // mock 与 daemon 产出对账：account 结构化字段 == pickQuotaFields(raw)
  const { pickQuotaFields } = await import('../daemon/quotaPick.mjs');
  assert.deepEqual(pickQuotaFields(mock.account.raw), {
    packs: mock.account.packs, planRem: mock.account.planRem,
    packRem: mock.account.packRem, nextRefresh: mock.account.nextRefresh,
  });
});

// ---------------------------------------------------------------- pulse（用量波形）/ turnspeed（逐轮生成速度）
// v8（2026-10-30 用户裁定，批准静态预览）：pulse = 三页签（近1小时/近24小时/全程，默认全程）+
// 名义合计/实扣/峰值 + SVG 面积波形（峰值点）+ 起止轴 + 每格脚注；tokens 口径（BYOK）纵轴换输出量。
// turnspeed = 每模型一行：参与/可测轮数 + 平均 tps + min–max + 每轮柱（按模型最高轮归一，虚线 = 平均）。
// 空态如实说明原因，绝不回落其它会话数据。
test('pulse full：三页签默认「全程」+ 名义/实扣/峰值 + SVG 波形/峰值点 + 起止轴/每格脚注；页签切换就地重绘', async () => {
  const { getModules } = await import('../app/widget.js');
  const def = getModules().find((m) => m.id === 'pulse');
  const el = def.render({ size: 'full', state: syncActive(mock), fmt: {} });
  const tabs = findAll(el, 'qum-pulse-tab');
  assert.deepEqual(tabs.map(textOf), ['近1小时', '近24小时', '全程']);
  assert.equal(tabs.find((t) => t.classList.contains('on'))._text, '全程', '默认全程（信息量最大）');
  assert.deepEqual(findAll(el, 'qum-pulse-stat-label').map(textOf), ['名义合计', '实扣', '峰值']);
  assert.deepEqual(findAll(el, 'qum-pulse-stat-value').map(textOf), ['53.6 cr', '10 cr', '50 cr']);
  const svg = findAll(el, 'qum-pulse-wave')[0];
  assert.ok(svg, 'SVG 波形存在');
  assert.equal(svg.attrs.viewBox, '0 0 644 96');
  assert.ok(findAll(svg, 'qum-pulse-area').length === 1 && findAll(svg, 'qum-pulse-line').length === 1, '面积 + 线');
  assert.equal(findAll(svg, 'qum-pulse-peak').length, 1, '峰值点');
  assert.match(textOf(findAll(el, 'qum-pulse-axis')[0]), /现在/);
  assert.match(textOf(findAll(el, 'qum-pulse-foot')[0]), /每格 12 小时 · 名义 credits（含免扣）· 本窗口实扣 10 cr \/ 免扣 43.6 cr/);
  assert.match(textOf(findAll(el, 'qum-pulse-chip')[0]), /本会话 · qfmodel|本会话 · --/);
  // 页签切换：h1 统计/脚注就地更新（同一 DOM 树，不重拉数据）
  tabs[0].fire('click');
  const tabs2 = findAll(el, 'qum-pulse-tab');
  assert.equal(tabs2.find((t) => t.classList.contains('on'))._text, '近1小时');
  assert.deepEqual(findAll(el, 'qum-pulse-stat-value').map(textOf), ['4.6 cr', '1.2 cr', '3.2 cr']);
  assert.match(textOf(findAll(el, 'qum-pulse-foot')[0]), /每格 1 分钟/);
  tabs2[2].fire('click'); // 复位全程（模块内存态不污染其它用例）
  assert.equal(findAll(el, 'qum-pulse-tab').find((t) => t.classList.contains('on'))._text, '全程');
});

test('pulse tokens 口径：BYOK 会话改输出量（输出合计/峰值/每格，无 cr）；无 active / 无会话 / 无波形 → 三种空态说明原因', async () => {
  const { getModules } = await import('../app/widget.js');
  const def = getModules().find((m) => m.id === 'pulse');
  const win = (over) => ({ step: 60_000, n: 2, from: 1791604680000, to: 1791604740000, vals: [0, 0], outs: [100, 200],
    counts: [1, 1], total: 0, billTotal: null, freeTotal: null, peak: 0, peakAt: null, peakOut: 200, outTotal: 300, rows: 2, ...over });
  const st = JSON.parse(JSON.stringify(mock));
  st.local.active.session = { ...st.local.active.session, billingMode: 'tokens' };
  st.local.active.pulse = { sessionId: 'mock-session-abc123', h1: win({}), h24: win({}), all: win({ n: 2 }) };
  const el = def.render({ size: 'full', state: st, fmt: {} });
  assert.deepEqual(findAll(el, 'qum-pulse-stat-label').map(textOf), ['输出合计', '峰值', '每格']);
  assert.deepEqual(findAll(el, 'qum-pulse-stat-value').map(textOf), ['300 tok', '200 tok', '1 分钟']);
  assert.match(textOf(findAll(el, 'qum-pulse-foot')[0]), /输出 tokens.*纵轴自动换为输出量/);
  assert.doesNotMatch(textOf(findAll(el, 'qum-pulse-stats')[0]), /cr/);
  // 空态三态
  const noActive = JSON.parse(JSON.stringify(mock));
  delete noActive.local.active;
  assert.match(textOf(def.render({ size: 'full', state: noActive, fmt: {} })), /未识别当前会话（客户端未暴露会话身份）/);
  const noSess = { sessionId: 'S-x', lastTurn: null, session: null, pulse: null, turnSpeeds: null };
  assert.match(textOf(def.render({ size: 'full', state: { ...mock, local: { ...mock.local, active: noSess } }, fmt: {} })), /本会话暂无回合/);
  const noPulse = { ...mock.local.active, pulse: null };
  assert.match(textOf(def.render({ size: 'full', state: { ...mock, local: { ...mock.local, active: noPulse } }, fmt: {} })), /回合未落盘 usage/);
});

test('turnspeed full：每模型 可测/参与轮 + 平均 tps + min–max + 每轮柱（峰值柱高亮）/平均虚线；全不可测 → 说明原因；无 active → 未识别', async () => {
  const { getModules } = await import('../app/widget.js');
  const def = getModules().find((m) => m.id === 'turnspeed');
  const el = def.render({ size: 'full', state: syncActive(mock), fmt: {} });
  assert.deepEqual(findAll(el, 'qum-tps-name').map(textOf), ['qfmodel', 'Mimo-V2.6']);
  assert.deepEqual(findAll(el, 'qum-tps-meta').map(textOf), [
    '3/3 轮 · 平均 56.5 tps · 40–70',
    '1/1 轮 · 平均 46 tps · 46–46',
  ]);
  const bars = findAll(el, 'qum-tps-bar');
  assert.equal(bars.length, 4, '每轮一根柱（两模型 3+1 轮）');
  assert.equal(findAll(el, 'qum-tps-bar').filter((b) => b.classList.contains('p')).length, 2, '每模型最高轮高亮');
  assert.equal(findAll(el, 'qum-tps-mean').length, 2, '每模型一条平均虚线');
  assert.match(textOf(findAll(el, 'qum-tps-chip')[0]), /本会话 · 23 轮 · 4 轮可测/);
  assert.match(textOf(findAll(el, 'qum-tps-foot')[0]), /算术平均.*加权/);
  // 全不可测（timed 全 0）→ 说明原因；行仍如实列出
  const unp = JSON.parse(JSON.stringify(mock));
  unp.local.active.turnSpeeds = JSON.parse(JSON.stringify(unp.local.active.turnSpeeds));
  unp.local.active.turnSpeeds.rows = unp.local.active.turnSpeeds.rows.map((r) => ({ ...r, timed: 0, mean: null, min: null, max: null, series: [] }));
  unp.local.active.turnSpeeds.timedTurns = 0;
  const e2 = def.render({ size: 'full', state: unp, fmt: {} });
  assert.match(textOf(e2), /本会话回合未配对日志实测秒，逐轮 tps 无法测算/);
  assert.deepEqual(findAll(e2, 'qum-tps-meta').map(textOf), ['3/3 轮 · 无实测秒（-- tps）', '1/1 轮 · 无实测秒（-- tps）']);
  // 无 active → 未识别
  const noActive = JSON.parse(JSON.stringify(mock));
  delete noActive.local.active;
  assert.match(textOf(def.render({ size: 'full', state: noActive, fmt: {} })), /未识别当前会话/);
});

// v8.1（2026-10-30 用户追加）：柱可点选查看该轮精确 tps。读数紧跟所选行柱图下方；
// 同一时刻仅一根选中（跨行也互斥）；重复点取消、点其它柱切换；面板轮询重渲染后保留
// （按 会话+模型+轮开始时间 记忆）；切会话自动失效且不复活。键盘 Enter/Space 与点击等效。
test('turnspeed 点选柱：所选行下方出「第 N 轮 · HH:MM · tps」读数；切换/取消/重渲染保留/切会话失效；键盘等效', async () => {
  const { getModules } = await import('../app/widget.js');
  const def = getModules().find((m) => m.id === 'turnspeed');
  const state = syncActive(mock);
  const hm = (ts) => {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  const el = def.render({ size: 'full', state, fmt: {} });
  assert.equal(findAll(el, 'qum-tps-pick').length, 0, '默认无读数');
  const bars0 = findAll(el, 'qum-tps-bar');
  assert.equal(bars0[0].getAttribute('role'), 'button', '柱可交互');
  assert.equal(bars0[0].getAttribute('tabindex'), '0', '柱可 Tab 聚焦');
  assert.equal(bars0[0].getAttribute('aria-pressed'), 'false');

  bars0[2].fire('click'); // qfmodel 第 3 轮
  let picks = findAll(el, 'qum-tps-pick');
  assert.equal(picks.length, 1);
  assert.equal(textOf(picks[0]), `第 3 轮 · ${hm(1791604700000)} · 54.5 tps`);
  assert.equal(findAll(el, 'qum-tps-row')[0].children.includes(picks[0]), true, '读数挂在所选行内');
  let bars = findAll(el, 'qum-tps-bar');
  assert.equal(bars[2].getAttribute('aria-pressed'), 'true');
  assert.equal(bars[2].classList.contains('on'), true, '选中柱高亮');

  // 点第二行柱 → 切换；跨行仍只有一条读数
  bars[3].fire('click');
  picks = findAll(el, 'qum-tps-pick');
  assert.equal(picks.length, 1);
  assert.equal(textOf(picks[0]), `第 1 轮 · ${hm(1791580000000)} · 46 tps`);
  assert.equal(findAll(el, 'qum-tps-row')[1].children.includes(picks[0]), true);

  // 再点同一根 → 取消
  bars = findAll(el, 'qum-tps-bar');
  bars[3].fire('click');
  assert.equal(findAll(el, 'qum-tps-pick').length, 0);
  assert.equal(findAll(el, 'qum-tps-bar')[3].getAttribute('aria-pressed'), 'false');

  // 键盘 Enter / Space 与点击等效
  findAll(el, 'qum-tps-bar')[0].fire('keydown', { key: 'Enter', preventDefault() {} });
  assert.equal(textOf(findAll(el, 'qum-tps-pick')[0]), `第 1 轮 · ${hm(1791579000000)} · 45 tps`);
  findAll(el, 'qum-tps-bar')[0].fire('keydown', { key: ' ', preventDefault() {} });
  assert.equal(findAll(el, 'qum-tps-pick').length, 0, 'Space 再点同一根取消');

  // 轮询重渲染（同 state 新 DOM）→ 选中保留
  findAll(el, 'qum-tps-bar')[0].fire('click');
  const el2 = def.render({ size: 'full', state, fmt: {} });
  const picks2 = findAll(el2, 'qum-tps-pick');
  assert.equal(picks2.length, 1);
  assert.equal(textOf(picks2[0]), `第 1 轮 · ${hm(1791579000000)} · 45 tps`);
  assert.equal(findAll(el2, 'qum-tps-bar')[0].classList.contains('on'), true);

  // 切会话 → 失效且清空；回到原会话也不复活（绝不跨会话残留）
  const other = JSON.parse(JSON.stringify(state));
  other.local.active.sessionId = 'mock-session-other';
  assert.equal(findAll(def.render({ size: 'full', state: other, fmt: {} }), 'qum-tps-pick').length, 0);
  assert.equal(findAll(def.render({ size: 'full', state, fmt: {} }), 'qum-tps-pick').length, 0, '切会话已清空');
});

// ---------------------------------------------------------------- strip 迷你槽（v5 读 lastTurn）
// P2 用户裁定（v5 两行式 → v6 单行四槽）：槽数据源全部换到 local.lastTurn——tokens 槽 = consumption.renderMini
// （该轮计费输入 billedInput；tokens 口径用真实提示输入总量（input 已含 cacheRead）；
// 值来自 billedSource，展示不为来源加标记）；credits 槽 = consumption.renderMini（该轮 credits「N.N cr」）；turnsec 槽 =
// speed.renderMini（该轮 turnSec 一位小数，秒为单位绝无 min）；tps 槽 = speed.renderMini（该轮
// outTps 生成速度）。lastTurn 缺 → 各槽 '--' 占位（整条空态由 widget.renderStrip 承担）。
test('v7 consumption renderMini: tokens 槽=末轮计费输入（credits 口径 N,NNN tok；null→-- tok）；credits 槽=会话累计 credits（tokens 口径不适用 → -- cr）', async () => {
  const { getModules } = await import('../app/widget.js');
  const def = getModules().find((m) => m.id === 'consumption');
  const mini = (slot, state) => textOf(def.renderMini({ size: 'mini', slot, state: syncActive(state), fmt: {} }));
  assert.equal(mini('tokens', mock), '48,123 tok');       // fallback200k；无估算标记
  assert.equal(mini('credits', mock), '123.4 cr');          // v7：会话累计 credits（不再读末轮 0.6）
  const rt = JSON.parse(JSON.stringify(mock));
  rt.local.lastTurn.billedSource = 'runtime-config';
  assert.equal(mini('tokens', rt), '48,123 tok');
  const nullBilled = JSON.parse(JSON.stringify(mock));
  nullBilled.local.lastTurn.billedInput = null;
  assert.equal(mini('tokens', nullBilled), '-- tok');
  const noLt = JSON.parse(JSON.stringify(mock));
  noLt.local.lastTurn = null;
  assert.equal(mini('tokens', noLt), '-- tok');
  assert.equal(mini('credits', noLt), '123.4 cr', '末轮缺失不影响会话累计 credits');
  assert.equal(mini('tokens', { ...mock, local: null }), '-- tok');
  // tokens 口径（BYOK）：credits 不存在 → '-- cr'；末轮 credits=null 同样 --（原有诚实降级）
  const tok = JSON.parse(JSON.stringify(mock));
  tok.local.billingMode = 'tokens';
  assert.equal(mini('credits', tok), '-- cr');
  const noSess = { ...mock, local: { ...mock.local, session: undefined, active: undefined } };
  assert.equal(mini('credits', noSess), '-- cr');
});

test('v7 speed renderMini: tps 槽=会话 outTps30「⚡ N.N t/s」（缺失回落末轮 outTps）/turnsec 槽=末轮「N.N s」', async () => {
  const { getModules } = await import('../app/widget.js');
  const def = getModules().find((m) => m.id === 'speed');
  const mini = (slot, state) => textOf(def.renderMini({ size: 'mini', slot, state: syncActive(state), fmt: {} }));
  assert.equal(mini('tps', mock), '⚡ 45.6 t/s'); // 原生口径：会话近30分钟生成速度（不是末轮 56.5）
  assert.equal(mini('turnsec', mock), '32.4 s');
  assert.doesNotMatch(mini('turnsec', mock), /min/);
  const noTps30 = JSON.parse(JSON.stringify(mock));
  delete noTps30.local.session.outTps30;
  assert.equal(mini('tps', noTps30), '⚡ 56.5 t/s', '会话速度缺失 → 回落末轮 outTps（诚实降级，不编造）');
  const noOut = JSON.parse(JSON.stringify(mock));
  noOut.local.session.outTps30 = null;
  noOut.local.lastTurn.outTps = null;
  assert.equal(mini('tps', noOut), '⚡ -- t/s');
  const noTurn = JSON.parse(JSON.stringify(mock));
  noTurn.local.lastTurn.turnSec = null;
  assert.equal(mini('turnsec', noTurn), '--');
  const noLt = JSON.parse(JSON.stringify(mock));
  noLt.local.lastTurn = null;
  assert.equal(mini('turnsec', noLt), '--');
  assert.equal(mini('tps', noLt), '⚡ 45.6 t/s', 'tps 只依赖会话聚合，末轮缺失不影响');
});

test('v7 session renderMini（会话簇）: tokens 万单位 [] + 命中% + 轮/请求；命中率缺失 → 整段省略；tokens 口径用真实总量', async () => {
  const { getModules } = await import('../app/widget.js');
  const def = getModules().find((m) => m.id === 'session');
  const mini = (state) => textOf(def.renderMini({ size: 'mini', slot: 'session', state: syncActive(state), fmt: {} }));
  assert.equal(mini(mock), '12.8万 tok · 86.1% 命中 · 23 轮 · 187 次'); // fallback200k；无估算标记；轮≠turns，次=请求
  const rt = JSON.parse(JSON.stringify(mock));
  rt.local.contextWindow = { value: 200000, source: 'runtime-config' };
  assert.equal(mini(rt), '12.8万 tok · 86.1% 命中 · 23 轮 · 187 次', 'runtime-config；无估算标记');
  const noHit = JSON.parse(JSON.stringify(mock));
  noHit.local.session.cacheHitRate = null;
  assert.equal(mini(noHit), '12.8万 tok · 23 轮 · 187 次', '无缓存字段 → 不显示命中段（不补 0%）');
  const tok = JSON.parse(JSON.stringify(mock));
  tok.local.billingMode = 'tokens';
  // 口径裁定（2026-10-27）：input_tokens 已含缓存命中（cacheRead ⊂ input），tokens 口径的
  // 真实总量就是 input 自身，绝不再加 cacheRead/cacheCreate。
  tok.local.session = { ...tok.local.session, billingMode: 'tokens', input: 98000, cacheRead: 90000, cacheCreate: 0 };
  assert.equal(mini(tok), '9.8万 tok · 86.1% 命中 · 23 轮 · 187 次', 'tokens 口径用 input（已含缓存）98,000，不叠加');
  const noSess = { ...mock, local: { ...mock.local, session: undefined, active: undefined } };
  assert.equal(mini(noSess), '--');
});

test('v7 tools renderMini: 「工具 N · 失败 M」；tools 缺失/非对象 → 双 --；面板出代码变更与分工具明细', async () => {
  const { getModules } = await import('../app/widget.js');
  const def = getModules().find((m) => m.id === 'tools');
  const mini = (state) => textOf(def.renderMini({ size: 'mini', slot: 'tools', state: syncActive(state), fmt: {} }));
  assert.equal(mini(mock), '工具 42 · 失败 3');
  const noTools = JSON.parse(JSON.stringify(mock));
  delete noTools.local.session.tools;
  assert.equal(mini(noTools), '工具 -- · 失败 --');
  const noSess = { ...mock, local: { ...mock.local, session: undefined, active: undefined } };
  assert.equal(mini(noSess), '工具 -- · 失败 --');
  const full = def.render({ size: 'full', state: syncActive(mock), fmt: {} });
  const t = textOf(full);
  assert.match(t, /调用42 次/);
  assert.match(t, /失败3 次/);
  assert.match(t, /代码变更\+126 \/ −38 · 7 文件/);
  assert.match(t, /Read · 18 次/);
  assert.match(t, /Bash · 8 次 · 2 失败/);
  assert.equal(findAll(full, 'qum-line').length, 7, '3 汇总行 + 4 工具行');
});

test('v7 pack renderMini: 「◔ 剩余%」（remaining/total 优先，percentage 兜底）；无账户/无额度 → ◔ --', async () => {
  const { getModules } = await import('../app/widget.js');
  const def = getModules().find((m) => m.id === 'pack');
  const mini = (state) => textOf(def.renderMini({ size: 'mini', slot: 'quota', state, fmt: {} }));
  assert.equal(mini(mock), '◔ 37.5%'); // 450 / 1200
  const pctOnly = JSON.parse(JSON.stringify(mock));
  const ad = pctOnly.account.raw.usage.qoderUsage.addOnQuota;
  delete ad.remaining; delete ad.used; delete ad.total; ad.percentage = 58;
  assert.equal(mini(pctOnly), '◔ 42%', 'percentage 是已用百分比 → 剩余 42%');
  assert.equal(mini({ ...mock, account: null }), '◔ --');
  assert.equal(mini({ ...mock, account: { ...mock.account, raw: {}, packRem: 450 } }), '◔ --', '只有 packRem 无 used/total → 无法算百分比');
});

test('session 面板（面板专有）：full 五行 本会话/近30分钟/计费输入/会话id 前 8 字/模型；half 本会单行；源缺失 → 暂无数据 不猜数（P2：平均回合行删除——只归「吞吐/时长」）', async () => {
  const { getModules } = await import('../app/widget.js');
  const def = getModules().find((m) => m.id === 'session');
  const full = def.render({ size: 'full', state: syncActive(mock), fmt: {} });
  assert.deepEqual(findAll(full, 'qum-line').map(textOf),
    ['本会话123.4 cr · 23 轮 · 187 次', '近30分钟2.1 cr/min', '计费输入128.0k tok', '会话mock-ses', '模型qfmodel',
      'qfmodel · 0.6 cr · 48.1k tok · 56.5 tps · 66s · 3 轮',
      'Mimo-V2.6 (byok) · -- cr · 104.0k tok · 46 tps · 41s · 1 轮']); // byModel 表（P2；T16 估算速率、一位小数、无标记）
  assert.doesNotMatch(textOf(full), /平均回合/, '去重（修订②）：平均耗时只归「吞吐/时长」');
  const half = def.render({ size: 'half', state: syncActive(mock), fmt: {} });
  assert.deepEqual(findAll(half, 'qum-line').map(textOf), ['本会123.4 cr']);
  // id/credits 为 null（会话未知/旧快照）→ 各行 '--'，行不消失
  const none = { ...mock, local: { ...mock.local, session: { id: null, credits: null, turns: 0, rateCpm30: null } } };
  assert.deepEqual(findAll(def.render({ size: 'full', state: syncActive(none), fmt: {} }), 'qum-line').map(textOf),
    ['本会话-- cr · -- 轮', '近30分钟-- cr/min', '计费输入-- tok', '会话--', '模型--']);
  // 源缺失/乱值（升级前快照、旧 daemon 无 session 字段）→ full 出「暂无数据」，half 出 -- 单行，绝不抛
  for (const st of [{ ...mock, local: { ...mock.local, session: undefined } },
    { ...mock, local: { ...mock.local, session: 'garbage' } },
    { ...mock, local: null }, {}]) {
    assert.match(textOf(def.render({ size: 'full', state: syncActive(st), fmt: {} })), /暂无数据/);
    assert.equal(findAll(def.render({ size: 'full', state: syncActive(st), fmt: {} }), 'qum-line').length, 0);
    assert.deepEqual(findAll(def.render({ size: 'half', state: syncActive(st), fmt: {} }), 'qum-line').map(textOf), ['本会-- cr']);
  }
});

test('session 面板 模型行：解析人类名 + 目录条目 byok:true → 追加 " (byok)"；无 byok 内建无后缀；未解析 → id:<8>', async () => {
  const { getModules } = await import('../app/widget.js');
  const def = getModules().find((m) => m.id === 'session');
  const modelRow = (state) => findAll(def.render({ size: 'full', state: syncActive(state), fmt: {} }), 'qum-line').map(textOf)[4]; // P2：删平均回合行 → 模型行前移一位
  // 用户报告场景：byok id → 'DeepSeek-Flash'，并据 mock.modelCatalog 该条目 byok:true 追加后缀
  assert.equal(modelRow(withSession({ model: BYOK_ID, modelName: 'DeepSeek-Flash' })), '模型DeepSeek-Flash (byok)');
  // 内建解析名（mock 目录 typeDisplayName 'Built-in', byok:false）→ 无 (byok) 后缀
  assert.equal(modelRow(withSession({ model: 'qfmodel-lite', modelName: 'Qoder Lite' })), '模型Qoder Lite');
  // 未解析长 id → id:<8>（清晰标注是 id）
  assert.equal(modelRow(withSession({ model: 'a-very-long-model-name-123', modelName: null })), '模型id:a-very-l');
  // mock 默认（未解析短句柄 qfmodel）→ 自身，无后缀（既有口径不回归）
  assert.equal(modelRow(mock), '模型qfmodel');
});

test('session 模型行 byok 标注：session id=<profile>/<key> 反向命中目录 key（catalogEntryFor 与 daemon 同规）', async () => {
  const { getModules } = await import('../app/widget.js');
  const def = getModules().find((m) => m.id === 'session');
  const modelRow = (state) => findAll(def.render({ size: 'full', state: syncActive(state), fmt: {} }), 'qum-line').map(textOf)[4]; // P2：删平均回合行 → 模型行前移一位
  // 真机场景：session.model 是 <profile-id>/<model-key>，目录条目 key 只有后段 —— 反向
  // 斜杠必须命中才能给 (byok) 后缀（正向规则命中不了，旧实现漏标）。
  const st = {
    ...withSession({
      model: 'qoder-custom-22222222-2222-4222-8222-222222222222/mimo-v2.6-flash',
      modelName: 'DeepSeek-Flash',
    }),
    modelCatalog: {
      fetchedAt: 1791604740000,
      entries: [{ modelKey: 'mimo-v2.6-flash', modelDisplayName: 'DeepSeek-Flash', typeDisplayName: null, byok: true }],
    },
  };
  assert.equal(modelRow(st), '模型DeepSeek-Flash (byok)');
  // 边界整段：key 'model' 不得命中 id 'a/modelx' → 无后缀
  const st2 = {
    ...withSession({ model: 'a/modelx', modelName: 'X' }),
    modelCatalog: { fetchedAt: 1, entries: [{ modelKey: 'model', modelDisplayName: 'M', byok: true }] },
  };
  assert.equal(modelRow(st2), '模型X');
});

test('session 模型行：BYOK <provider>/<slug> 无目录名 → 完整 slug + (byok)，绝不截成 id:qoder-cu', async () => {
  const { getModules } = await import('../app/widget.js');
  const def = getModules().find((m) => m.id === 'session');
  const modelRow = (state) => findAll(def.render({ size: 'full', state: syncActive(state), fmt: {} }), 'qum-line').map(textOf)[4];
  // 真机 2026-10-28：step-* 已从目录删除，只剩 provider 前缀 + slug；显示完整 slug 才是诚实读数
  const st = withSession({
    model: 'qoder-custom-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/step-5-preview',
    modelName: null,
  });
  assert.equal(modelRow(st), '模型step-5-preview (byok)');
});

test('session/byModel 模型行：目录 key 为 byok:<uuid> 时按显示名归一化解析并标 (byok)（真机 uuid 与 provider 不同）', async () => {
  const { getModules } = await import('../app/widget.js');
  const def = getModules().find((m) => m.id === 'session');
  const lines = (state) => findAll(def.render({ size: 'full', state: syncActive(state), fmt: {} }), 'qum-line').map(textOf);
  const st = {
    ...withSession({
      model: 'qoder-custom-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/mimo-v2.6-flash',
      modelName: null,
      byModel: [{
        model: 'qoder-custom-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/mimo-v2.6-flash',
        modelName: null, billingMode: 'credits', credits: 1.5, turns: 2,
      }],
    }),
    modelCatalog: {
      fetchedAt: 1,
      entries: [{ modelKey: 'byok:cccccccc-cccc-4ccc-8ccc-cccccccccccc', modelDisplayName: 'Mimo-V2.6-Flash', typeDisplayName: null, byok: true }],
    },
  };
  const ls = lines(st);
  assert.equal(ls[4], '模型Mimo-V2.6-Flash (byok)'); // 目录显示名（归一大写/连字符差异）
  assert.match(ls[5], /^Mimo-V2\.6-Flash \(byok\) · /); // byModel 行同规
});

// v7（2026-10-26 用户裁定）：session 重新拥有迷你槽，但形态是「会话簇」
// （tokens 万/命中/轮/请求），不再是模型名；面板 render 的「模型」行保留（上方 modelRow 断言不变）。

// ---------------------------------------------------------------- sessions（会话明细，新模块）
// 数据源 state.local.sessions（daemon sessionsSummary 产出，≤10、lastTs 降序）。每行
// 「<id8> · N cr · Nk tok · R 轮 · Q 次 · <model>」；full = 逐行；half =「近 N 个会话」+ 首行；
// 源缺失/空表 → 一行「暂无数据」；单项 null → 该段 '--'。
test('sessions 会话明细：full 逐行（id8/cr/tok/轮/次/model；不加估算标记）；half 近 N + 首行；空源 → 暂无数据', async () => {
  const { getModules } = await import('../app/widget.js');
  const def = getModules().find((m) => m.id === 'sessions');
  const full = def.render({ size: 'full', state: syncActive(mock), fmt: {} });
  assert.deepEqual(findAll(full, 'qum-line').map(textOf), [
    'mock-ses · 123.4 cr · 128.0k tok · 23 轮 · 187 次 · qfmodel', // mixed；无估算标记
    'mock-ses · 88.2 cr · 96.0k tok · 17 轮 · 96 次 · qfmodel',    // runtime-config；无估算标记（def456 slice(0,8)='mock-ses'）
    'mock-ses · 12.1 cr · -- tok · 5 轮 · 12 次 · qfmodel-pro',    // billedInput null → -- tok（行不消失）
  ]);
  const half = def.render({ size: 'half', state: syncActive(mock), fmt: {} });
  assert.deepEqual(findAll(half, 'qum-line').map(textOf),
    ['近 3 个会话', 'mock-ses · 123.4 cr · 128.0k tok · 23 轮 · 187 次 · qfmodel']);
  // 源缺失/乱值/空表 → 一行「暂无数据」，绝不抛
  for (const st of [{ ...mock, local: { ...mock.local, sessions: undefined } },
    { ...mock, local: { ...mock.local, sessions: [] } },
    { ...mock, local: { ...mock.local, sessions: 'garbage' } },
    { ...mock, local: null }, {}]) {
    assert.match(textOf(def.render({ size: 'full', state: syncActive(st), fmt: {} })), /暂无数据/);
    assert.equal(findAll(def.render({ size: 'full', state: syncActive(st), fmt: {} }), 'qum-line').length, 0);
    assert.match(textOf(def.render({ size: 'half', state: syncActive(st), fmt: {} })), /暂无数据/);
  }
  // 单项字段 null/乱值 → 各段 '--'（model → '--'，rounds/requests 非数 → '-- 轮' 且省次数段）
  const messy = { ...mock, local: { ...mock.local, sessions: [{ id: 'xyz', credits: null, billedInput: null, billedSource: 'fallback200k', turns: null, model: null }] } };
  assert.match(textOf(def.render({ size: 'full', state: syncActive(messy), fmt: {} })), /xyz · -- cr · -- tok · -- 轮 · --/);
  // T14：会话明细同样显示解析人类名（server 落盘 modelName）；byok id → 'DeepSeek-Flash'
  const named = { ...mock, local: { ...mock.local, sessions: [
    { id: 'abc', credits: 1, billedInput: 1000, billedSource: 'runtime-config', turns: 2, rounds: 2, requests: 5, model: BYOK_ID, modelName: 'DeepSeek-Flash' },
    { id: 'def', credits: 2, billedInput: 2000, billedSource: 'runtime-config', turns: 3, rounds: 3, requests: 8, model: 'a-very-long-model-name-123', modelName: null },
  ] } };
  assert.deepEqual(findAll(def.render({ size: 'full', state: syncActive(named), fmt: {} }), 'qum-line').map(textOf), [
    'abc · 1 cr · 1.0k tok · 2 轮 · 5 次 · DeepSeek-Flash',
    'def · 2 cr · 2.0k tok · 3 轮 · 8 次 · id:a-very-l',
  ]);
  // 无 renderMini（面板专有）
  assert.equal(typeof def.renderMini, 'undefined');
});

// ---------------------------------------------------------------- 其余模块
test('consumption T12 credits 校准：half 今日 credits 行（置于 in/out 行之上）；full 5h/周/今日各行带 credits + 计费输入 Nk tok 段（null 省略）', async () => {
  const { getModules } = await import('../app/widget.js');
  const def = getModules().find((m) => m.id === 'consumption');
  const halfEl = def.render({ size: 'half', state: syncActive(mock), fmt: {} });
  const half = textOf(halfEl);
  assert.match(half, /今日52\.6\s*cr/); // fmtCredits(mock today 52.6) = '53'
  assert.match(half, /今日964\.3k in \/ 63\.1k out/); // in/out 行保留
  const halfLines = findAll(halfEl, 'qum-line');
  assert.equal(halfLines.length, 2);
  assert.match(textOf(halfLines[0]), /cr/, 'credits 行在 in/out 行之上');
  assert.match(textOf(halfLines[1]), /in \/ .* out/);
  assert.doesNotMatch(half, /5h/);
  assert.doesNotMatch(half, /tok/, 'half 不变：计费输入段仅 full 出');
  const full = textOf(def.render({ size: 'full', state: syncActive(mock), fmt: {} }));
  assert.match(full, /5h482\.1k in \/ 31\.8k out · 34.8 cr · 45\.6k tok/); // runtime-config；无估算标记
  assert.match(full, /周3912\.8k in \/ 260\.4k out · 142.6 cr · 310\.0k tok/); // fallback200k；无估算标记
  assert.match(full, /今日964\.3k in \/ 63\.1k out · 52.6 cr · 82\.0k tok/); // mixed；无估算标记
  // 旧 state（窗口无 credits 字段，如升级前落盘的 state.json 快照）→ '-- cr'，不崩溃
  const legacy = JSON.parse(JSON.stringify(mock));
  delete legacy.local.today.credits;
  assert.match(textOf(def.render({ size: 'half', state: syncActive(legacy), fmt: {} })), /今日--\s*cr/);
  // billedInput null（旧缓存记录无 ratio）→ full 行无计费段、不出 '--'，行不消失
  const noBilled = JSON.parse(JSON.stringify(mock));
  for (const k of ['window5h', 'week', 'today']) { noBilled.local[k].billedInput = null; noBilled.local[k].billedInputSource = null; }
  const fb = textOf(def.render({ size: 'full', state: syncActive(noBilled), fmt: {} }));
  assert.doesNotMatch(fb, /tok/);
  assert.match(fb, /5h482\.1k in \/ 31\.8k out · 34.8 cr/);
});

test('cache：fmtPct 数值路径；null → -- + title 说明；整宽全 null → 追加 本地无缓存数据 note（T12 真机：客户端不落盘缓存字段）', async () => {
  const { getModules } = await import('../app/widget.js');
  const def = getModules().find((m) => m.id === 'cache');
  // 数值路径：mock today 0.864 → 86.4%（half 只展 today，缓存字段落盘时正常出数）
  const numEl = def.render({ size: 'half', state: syncActive(mock), fmt: {} });
  assert.match(textOf(numEl), /86\.4%/);
  assert.equal(findAll(numEl, 'qum-line-value')[0].attrs.title, undefined, '有数据行不加说明 title');
  // half null：-- + title「客户端未落盘缓存字段」（保持紧凑，不加 note 行）
  const noToday = JSON.parse(JSON.stringify(mock));
  noToday.local.today.cacheHitRate = null;
  const half = def.render({ size: 'half', state: syncActive(noToday), fmt: {} });
  assert.match(textOf(half), /--/);
  assert.equal(findAll(half, 'qum-line-value')[0].attrs.title, '客户端未落盘缓存字段');
  assert.equal(findAll(half, 'qum-cache-note').length, 0, 'half 不加 note 行');
  // full 混合（mock 实况：window5h null 而 week/today 有数）→ 该行 title，但不谎称全无缓存（无 note）
  const fullMix = def.render({ size: 'full', state: syncActive(mock), fmt: {} });
  assert.equal(findAll(fullMix, 'qum-cache-note').length, 0, '仍有部分窗口有数 → 不加“本地无缓存数据”');
  const mixVals = findAll(fullMix, 'qum-line-value');
  assert.equal(mixVals[0].attrs.title, '客户端未落盘缓存字段', '5h 行 null → 带 title');
  assert.equal(mixVals[1].attrs.title, undefined, '周 行有数 → 无 title');
  // full 全 null → 追加 note「本地无缓存数据」
  const allNone = JSON.parse(JSON.stringify(mock));
  for (const k of ['window5h', 'week', 'today']) allNone.local[k].cacheHitRate = null;
  const fullNone = def.render({ size: 'full', state: syncActive(allNone), fmt: {} });
  assert.equal(findAll(fullNone, 'qum-cache-note').length, 1, '整宽全 null → note 出现');
  assert.match(textOf(fullNone), /本地无缓存数据/);
});

test('speed 吞吐/时长（P2 去重+时长集中）：full 行序 最新一轮/平均回合/总耗时/生成速度/近30分钟 + 诚实注记（计费输入行删除——与「本会话」重复）；half「均 Ns」保持；旧 state 全 -- 不崩', async () => {
  const { getModules } = await import('../app/widget.js');
  const def = getModules().find((m) => m.id === 'speed');
  assert.equal(def.title, '吞吐/时长');
  assert.equal(typeof def.renderMini, 'function', 'speed 提供 tps + turnsec 两 mini 变体');
  const full = def.render({ size: 'full', state: syncActive(mock), fmt: {} });
  assert.deepEqual(findAll(full, 'qum-line').map(textOf),
    ['最新一轮32.4 s', '平均回合45 s', '总耗时4m', '生成速度45.6 tps · 近30分钟', '近30分钟2.1 cr/min']); // T16：速率 = 估算（一位小数，无标记）÷ 实测秒
  // 去重（修订②）：计费输入行删除；本模块不再出现估算标记段
  assert.doesNotMatch(textOf(full), /计费输入/);
  assert.doesNotMatch(textOf(full), /[\u2248~]/);
  // 诚实注记（T16 口径：正文估算 ÷ 实测纯模型秒）保留；死指标不回归
  assert.match(findAll(full, 'qum-note').map(textOf).join('|'), /生成速度 = 最佳输出（真值优先，缺失才估算）÷ 实测纯模型秒/);
  assert.doesNotMatch(textOf(full), /输入吞吐/);
  assert.doesNotMatch(textOf(full), /174\.8/, '死指标 speedTps 不再出现');
  // half：紧凑「均 Ns」（保持）
  assert.deepEqual(findAll(def.render({ size: 'half', state: syncActive(mock), fmt: {} }), 'qum-line').map(textOf), ['均45s']);
  // 旧 daemon（lastTurn/totalTurnSec/outTps30 全缺）→ 行不消失全 '--'，绝不抛
  const oldDaemon = { ...mock, local: { ...mock.local, lastTurn: null, session: { id: 'S', credits: 5, turns: 3, rateCpm30: 0.1 } } };
  assert.deepEqual(findAll(def.render({ size: 'full', state: syncActive(oldDaemon), fmt: {} }), 'qum-line').map(textOf),
    ['最新一轮--', '平均回合--', '总耗时--', '生成速度-- tps · 近30分钟', '近30分钟0.1 cr/min']);
  assert.equal(textOf(findAll(def.render({ size: 'half', state: syncActive(oldDaemon), fmt: {} }), 'qum-line')[0]), '均--');
  // 整 session 缺席（首轮扫描前）→ 同 '--' 降级（lastTurn 仍在则最新一轮照出）
  const nosess = { ...mock, local: { ...mock.local, session: null } };
  assert.deepEqual(findAll(def.render({ size: 'full', state: syncActive(nosess), fmt: {} }), 'qum-line').map(textOf),
    ['最新一轮32.4 s', '平均回合--', '总耗时--', '生成速度-- tps · 近30分钟', '近30分钟-- cr/min']);
});

test('pack（P1.5 真仪表升级）：half 仍「剩余 N」（pickPack 链，含链不中 --）；full = used/total fill + 已用 750 / 1200 · 剩余 450 cr（无刻度/倒计时/徽标）；used/total 缺 → full 降级为剩余行不出 bar', async () => {
  const { getModules } = await import('../app/widget.js');
  const def = getModules().find((m) => m.id === 'pack');
  assert.match(textOf(def.render({ size: 'half', state: syncActive(mock), fmt: {} })), /剩余\s*450/); // packRem=450（HEAD 链同值）
  const miss = { ...mock, account: { source: 'widget', fetchedAt: 0, raw: { resource_package_quota: { remaining: 300 } } } };
  assert.match(textOf(def.render({ size: 'half', state: syncActive(miss), fmt: {} })), /--/); // 链不中 → --（钉死旧链仍不认扁平 .remaining）
  const hit = { ...mock, account: { source: 'widget', fetchedAt: 0, raw: { resourcePack: { remaining: 42 } } } };
  assert.match(textOf(def.render({ size: 'half', state: syncActive(hit), fmt: {} })), /42/);
  // full：真机 addOnQuota {used:750,total:1200,remaining:450} → fill 62.5%（750/1200）+ 事实行
  const full = def.render({ size: 'full', state: syncActive(mock), fmt: {} });
  assert.equal(findAll(full, 'qum-bar-fill')[0].style.width, '62.5%');
  assert.match(textOf(full), /已用\s*750 \/ 1200 · 剩余 450 cr/); // fmtCredits 无 k 缩写：1200 原样
  assert.equal(findAll(full, 'qum-pace-tick').length, 0, '资源包无重置语义——刻度已随假条移除，pack 也不画');
  assert.doesNotMatch(textOf(full), /重置|倒计时|本地|账户/);
  // full 降级：仅剩余可得（packRem 路径，无 used/total）→ 不出 bar，剩 行如实
  const remOnly = { ...mock, account: { source: 'widget', fetchedAt: 0, packRem: 77, raw: { resourcePack: { remaining: 77 } } } };
  const f2 = def.render({ size: 'full', state: syncActive(remOnly), fmt: {} });
  assert.equal(findAll(f2, 'qum-bar').length, 0);
  assert.match(textOf(f2), /剩余\s*77/);
  assert.equal(typeof def.renderMini, 'function', 'v7：pack 恢复 quota 迷你槽（剩余%）');
});

// ---------------------------------------------------------------- quotaAgg（2026-10-30 用户反馈：套餐分母漏专属积分）
// 用户截图：userQuota 2,000/2,000、addOnQuota 222/2,000、dedicated「Qwen 专属积分」0/2,000。
// 原生用量页把 addOnQuota + 每个 dedicatedResourcePackages[] 都计入额度（套餐内 Credits /
// 资源包 / 个人专属资源包）；插件此前只读 addOnQuota → 1,778/2,000 = 89%，分母漏掉专属积分。
// quotaAgg 聚合 addOn + dedicated（不聚合 orgResourcePackage：原生页未展示、无真机实据），
// strip/pack/mascot 同源；plan credits（userQuota）不是资源包，仍不计入。
test('quotaAgg：资源包聚合 = addOnQuota + dedicatedResourcePackages（分母含专属积分）；strip/pack/mascot 同源；无 total → null 不猜', async () => {
  const modules = await import('../app/modules.js');
  const { getModules } = await import('../app/widget.js');
  const acct = {
    source: 'widget',
    fetchedAt: 1,
    raw: { usage: { qoderUsage: {
      userQuota: { total: 2000, used: 2000, remaining: 0, percentage: 100 },
      addOnQuota: { total: 2000, used: 222, remaining: 1778, percentage: 11.1 },
      dedicatedResourcePackages: [{ name: 'Qwen 专属积分', total: 2000, used: 0, remaining: 2000 }],
    } } },
  };
  assert.deepEqual(modules.quotaAgg(acct), {
    used: 222, total: 4000, remaining: 3778, ratio: 0.9445,
    parts: [
      { name: '资源包', used: 222, total: 2000, remaining: 1778 },
      { name: 'Qwen 专属积分', used: 0, total: 2000, remaining: 2000 },
    ],
  });
  const st = { ...mock, account: acct };
  const packDef = getModules().find((m) => m.id === 'pack');
  assert.equal(textOf(packDef.renderMini({ size: 'mini', slot: 'quota', state: st, fmt: {} })), '◔ 94.5%', 'strip：剩余 3778/4000');
  const full = packDef.render({ size: 'full', state: st, fmt: {} });
  assert.equal(findAll(full, 'qum-bar-fill')[0].style.width, '5.6%', '已用 222/4000 = 5.55% → 5.6%');
  assert.match(textOf(full), /已用\s*222 \/ 4000 · 剩余 3778 cr/, '合计行（分母含专属积分）');
  assert.match(textOf(full), /资源包\s*222 \/ 2000/, '拆分：addOn 段');
  assert.match(textOf(full), /Qwen 专属积分\s*0 \/ 2000/, '拆分：专属积分段');
  assert.match(textOf(packDef.render({ size: 'half', state: st, fmt: {} })), /剩余\s*3\.8k/);
  const mascotDef = getModules().find((m) => m.id === 'mascot');
  assert.match(textOf(mascotDef.render({ size: 'half', state: st, fmt: {} })), /🙂/);
  // mock 不变：仅 addOn → 与旧口径完全一致（37.5%，现有用例即回归网）
  assert.equal(textOf(packDef.renderMini({ size: 'mini', slot: 'quota', state: mock, fmt: {} })), '◔ 37.5%');
  // 旧链/无 total → null（绝不猜；percentage-only 仍由 mascot 的 addOn 兜底路径处理）
  assert.equal(modules.quotaAgg(null), null);
  assert.equal(modules.quotaAgg({ raw: { resourcePack: { remaining: 42 } } }), null);
  assert.equal(modules.quotaAgg({ raw: { usage: { qoderUsage: { addOnQuota: { percentage: 58 } } } } }), null);
});

test('mascot：P1.5 阈值 rekey 到 addOnQuota（used/total 优先、percentage 0–100 兜底）；无账户数据 🫥；有账户读不出 → 🙂 中性；P2 去重：无今日行（仅表情）', async () => {
  const { getModules } = await import('../app/widget.js');
  const def = getModules().find((m) => m.id === 'mascot');
  const faceOf = (account, state = mock) => textOf(def.render({ size: 'half', state: syncActive({ ...state, account }), fmt: {} }));
  assert.match(faceOf(null), /🫥/); // 无账户数据（P1 实况路径）
  assert.match(faceOf(undefined), /🫥/);
  // mock addOnQuota 750/1200 → 剩余 37.5% → 20–50% 😐
  assert.match(faceOf(mock.account), /😐/);
  // used/total 档位：剩余 60% → 🙂；剩余 16% → 😨
  assert.match(faceOf({ raw: { usage: { qoderUsage: { addOnQuota: { used: 1000, total: 2500 } } } } }), /🙂/);
  assert.match(faceOf({ raw: { usage: { qoderUsage: { addOnQuota: { used: 2100, total: 2500 } } } } }), /😨/);
  // percentage 兜底（0–100 制）：已用 30% → 剩余 70% → 🙂；已用 58 → 😐
  assert.match(faceOf({ raw: { usage: { qoderUsage: { addOnQuota: { percentage: 30 } } } } }), /🙂/);
  assert.match(faceOf({ raw: { usage: { qoderUsage: { addOnQuota: { percentage: 58 } } } } }), /😐/);
  // 有账户但 addOnQuota 不可得（旧 credit-watch 形态）→ 🙂 中性（不再读假 quota_summary ratio）
  assert.match(faceOf({ raw: { quota_summary: { used_value: 2100, total_value: 2500 } } }), /🙂/);
  // P2 去重（修订②）：今日数字归「token 消耗」——本模块仅表情，无任何数字行
  const onlyFace = def.render({ size: 'half', state: syncActive(mock), fmt: {} });
  assert.equal(findAll(onlyFace, 'qum-line').length, 0);
  assert.doesNotMatch(textOf(onlyFace), /今日|cr/);
  // local 缺席不崩（表情阈值只读 account）
  assert.match(textOf(def.render({ size: 'full', state: syncActive({ ...mock, local: null }), fmt: {} })), /😐/);
});

// ---------------------------------------------------------------- T13 metrics（累计指标）
// 数据源：state.account.metrics（客户端 main 已归一，形状稳定 → 直读；缺字段/--，缺源整列 --）。
test('metrics full：三行 总计/峰值/连续·活跃（credits 走 fmtCredits，天数取整）；half 仅总计行；无 renderMini（非 strip 槽）', async () => {
  const { getModules } = await import('../app/widget.js');
  const def = getModules().find((m) => m.id === 'metrics');
  assert.equal(def.title, '累计指标');
  assert.equal(typeof def.renderMini, 'undefined', '累计指标不是 strip 槽');
  const full = def.render({ size: 'full', state: syncActive(mock), fmt: {} });
  const rows = findAll(full, 'qum-line').map(textOf);
  assert.deepEqual(rows, ['总计1280.4 cr', '峰值86.4 cr/日', '连续4 天 · 活跃23 天']);
  const half = def.render({ size: 'half', state: syncActive(mock), fmt: {} });
  assert.deepEqual(findAll(half, 'qum-line').map(textOf), ['总计1280.4 cr']);
  // 单字段 null → 该行 '--'，行不消失（客户端允许空读数）
  const partial = JSON.parse(JSON.stringify(mock));
  partial.account.metrics = {
    totalCredits: null, peakCredits: 86.4, currentStreakDays: null,
    longestStreakDays: 9, totalActiveDays: null, failedSources: [],
  };
  assert.deepEqual(findAll(def.render({ size: 'full', state: syncActive(partial), fmt: {} }), 'qum-line').map(textOf),
    ['总计-- cr', '峰值86.4 cr/日', '连续-- 天 · 活跃-- 天']);
  // 整源缺失（旧 daemon 快照 / 未打补丁）→ 全行 --，绝不抛
  for (const st of [{ ...mock, account: null }, { ...mock, account: { ...mock.account, metrics: null } },
    { ...mock, account: { ...mock.account, metrics: 'garbage' } }]) {
    assert.deepEqual(findAll(def.render({ size: 'full', state: syncActive(st), fmt: {} }), 'qum-line').map(textOf),
      ['总计-- cr', '峰值-- cr/日', '连续-- 天 · 活跃-- 天'], JSON.stringify(st.account && st.account.metrics));
  }
  // failedSources 非空 → 诚实标注哪些源挂了（乱值不抛，非字符串项忽略）
  const failed = JSON.parse(JSON.stringify(mock));
  failed.account.metrics.failedSources = ['heatmap', 'streak'];
  assert.match(textOf(def.render({ size: 'full', state: syncActive(failed), fmt: {} })), /数据源失败：heatmap, streak/);
});

// ---------------------------------------------------------------- T13 heatmap（用量热力）
// 数据源：state.account.heatmap（daemon pickHeatmap 产物 {days:[{date,credits}],source}，
// 首帧真实形状未知 → 形状不合即 null → 面板出「暂无数据」，绝不猜数）。
test('heatmap full：14 格 CSS grid，格底色按 credits/max 缩放，title「YYYY-MM-DD · N cr」；0/null → 空格', async () => {
  const { getModules } = await import('../app/widget.js');
  const def = getModules().find((m) => m.id === 'heatmap');
  assert.equal(def.title, '用量热力');
  assert.equal(typeof def.renderMini, 'undefined', '用量热力不是 strip 槽');
  const full = def.render({ size: 'full', state: syncActive(mock), fmt: {} });
  const cells = findAll(full, 'qum-heat-cell');
  assert.equal(cells.length, 14);
  assert.equal(findAll(full, 'qum-heat').length, 1);
  // max = 86.4（2026-10-09）→ 100%；52.6/86.4=60.9%→61%（非零至少 15% 保证可见）
  assert.equal(cells[12].attrs.title, '2026-10-09 · 86.4 cr');
  assert.match(String(cells[12].style.background || cells[12].style.backgroundColor), /var\(--qum-accent\) 100%/);
  assert.equal(cells[13].attrs.title, '2026-10-10 · 52.6 cr');
  assert.match(String(cells[13].style.background || cells[13].style.backgroundColor), /var\(--qum-accent\) 61%/);
  const tiny = JSON.parse(JSON.stringify(mock));
  tiny.account.heatmap.days[0] = { date: '2026-09-27', credits: 1 }; // 1/86.4 → 落在 15% 地板
  assert.match(String(findAll(def.render({ size: 'full', state: syncActive(tiny), fmt: {} }), 'qum-heat-cell')[0].style.background), /15%/);
  // credits 0 → 空格（无 inline 底色，走 CSS 轨道色）；credits null → 空格 + title '--'
  assert.equal(cells[0].style.background, undefined, '0 cr 不写 inline 底色');
  assert.equal(cells[10].attrs.title, '2026-10-07 · -- cr');
  assert.equal(cells[10].style.background, undefined);
  // 无日期条目（pickHeatmap 保留 credits）→ title 日期位 '--'
  const noDate = JSON.parse(JSON.stringify(mock));
  noDate.account.heatmap.days = [{ date: null, credits: 5 }];
  assert.equal(findAll(def.render({ size: 'full', state: syncActive(noDate), fmt: {} }), 'qum-heat-cell')[0].attrs.title, '-- · 5 cr');
});

test('heatmap full 单元格上限 60（90 天回包 → 最近 60 天）；half 一行 近7日 Σ（null 计入 0，全 null → --）', async () => {
  const { getModules } = await import('../app/widget.js');
  const def = getModules().find((m) => m.id === 'heatmap');
  const wide = JSON.parse(JSON.stringify(mock));
  wide.account.heatmap.days = Array.from({ length: 90 }, (_, i) => ({
    date: new Date(Date.UTC(2026, 8, 10 + i)).toISOString().slice(0, 10), credits: i % 7,
  }));
  const cells = findAll(def.render({ size: 'full', state: syncActive(wide), fmt: {} }), 'qum-heat-cell');
  assert.equal(cells.length, 60, '≤60 cells');
  assert.equal(cells[0].attrs.title, '2026-10-10 · 2 cr', '取尾部 60 天（最近优先）');
  assert.equal(cells[59].attrs.title, '2026-12-08 · 5 cr');
  // half：mock 近 7 日 = 33.2+11.4+28.7+null+44.8+86.4+52.6 = 257.1 → 257
  const half = def.render({ size: 'half', state: syncActive(mock), fmt: {} });
  assert.match(textOf(half), /近7日257.1 cr/);
  const allNull = JSON.parse(JSON.stringify(mock));
  allNull.account.heatmap.days = allNull.account.heatmap.days.map((d) => ({ date: d.date, credits: null }));
  assert.match(textOf(def.render({ size: 'half', state: syncActive(allNull), fmt: {} })), /近7日-- cr/);
});

test('heatmap 诚实降级：无账户 / 无 heatmap / 形状不合（pickHeatmap→null）→ 一行「暂无数据」，不出空网格', async () => {
  const { getModules } = await import('../app/widget.js');
  const def = getModules().find((m) => m.id === 'heatmap');
  for (const st of [{ ...mock, account: null }, { ...mock, account: undefined },
    { ...mock, account: { ...mock.account, heatmap: null } },
    { ...mock, account: { ...mock.account, heatmap: { days: [], source: 'days' } } },
    { ...mock, account: { ...mock.account, heatmap: 'garbage' } }]) {
    const el = def.render({ size: 'full', state: syncActive(st), fmt: {} });
    assert.match(textOf(el), /暂无数据/, JSON.stringify(Object.keys(st)));
    assert.equal(findAll(el, 'qum-heat-cell').length, 0);
    assert.match(textOf(def.render({ size: 'half', state: syncActive(st), fmt: {} })), /暂无数据/);
  }
});

// ---------------------------------------------------------------- widget 集成
function makeHost() {
  const timers = [];
  let seq = 0;
  const win = {
    localStorage: { store: {}, getItem(k) { return k in this.store ? this.store[k] : null; }, setItem(k, v) { this.store[k] = String(v); } },
    setTimeout(fn, delay) { const id = ++seq; timers.push({ fn, delay, id }); return id; },
    clearTimeout(id) { const i = timers.findIndex((t) => t.id === id); if (i !== -1) timers.splice(i, 1); },
    fetch() { return Promise.resolve({ ok: false, status: 508, headers: { get: () => null }, json: () => Promise.resolve({}) }); },
  };
  const body = makeEl('body');
  const doc = { defaultView: win, body, head: body, documentElement: body, createElement: (t) => makeEl(t), querySelector: () => null };
  const host = makeEl('body');
  host.ownerDocument = doc;
  return host;
}

test('widget 集成：mount 后 strip 出六槽单行式（tps/quota/session/tools/credits/turnsec，无标签行）+ 尾部「分析」时刻列、panel 出 13 模块（ctx.fmt 已由 setFmt 注入）', async () => {
  const mod = await import('../app/widget.js');
  mod.setState(mock);
  const host = makeHost();
  const root = mod.mount(host, { baseUrl: '' }); // 无凭据：不轮询，纯 setState 渲染
  const strip = root.children[0];
  const panel = root.children[1];
  // 六槽 + 尾部「分析」列（非槽位：无 dataset.slot，用户裁定）——列数断言 6 → 7
  assert.equal(strip.children.length, 7);
  assert.deepEqual(strip.children.filter((s) => s.dataset.slot).map((s) => s.dataset.slot),
    ['tps', 'quota', 'session', 'tools', 'credits', 'turnsec']);
  assert.equal(strip.children[6].className, 'qum-analysis', '末列固定为「分析」时刻');
  // Strip layout v7（2026-10-26 用户裁定：原生同款）：单行式（无标签行，数值自带单位）
  assert.equal(findAll(strip, 'qum-slot-label').length, 0, '无标签行（单行式）');
  const values = findAll(strip, 'qum-slot-value').map(textOf);
  assert.deepEqual(values, [
    '⚡ 45.6 t/s', '◔ 37.5%', '12.8万 tok · 86.1% 命中 · 23 轮 · 187 次',
    '工具 42 · 失败 3', '123.4 cr', '32.4 s',
  ]);
  assert.equal(findAll(strip, 'qum-slot').length, 6);
  // 会话簇是原生样式的高亮主信息（CSS 强调色；非新槽位）
  assert.ok(strip.children.filter((s) => s.dataset.slot === 'session')[0].classList.contains('qum-slot-session'));
  // 「分析」列：单行弱化 MM/DD HH:MM:SS（= state.meta.generatedAt 的本地月/日 时:分:秒）；title 给完整时刻
  const ana = findAll(strip, 'qum-analysis')[0];
  assert.ok(ana, '「分析」列存在（折叠态可见上次分析时刻）');
  assert.equal(findAll(ana, 'qum-analysis-label').length, 0, '「分析」列无标签（单行值）');
  assert.equal(textOf(findAll(ana, 'qum-analysis-value')[0]), fmtClock(mock.meta.generatedAt), '值 = 上次分析时刻（MM/DD HH:MM:SS）');
  assert.match(textOf(findAll(ana, 'qum-analysis-value')[0]), /^\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/, '格式钉死 MM/DD HH:MM:SS（2026-10-22 用户裁定）');
  assert.match(ana.title, /^上次分析：\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}（月\/日 时:分:秒）$/);
  const stripText = strip.children.map(textOf).join('|');
  assert.doesNotMatch(stripText, /min/, 'strip 不再出现分钟/min');
  assert.equal(panel.children.length, EXPECTED_IDS.length);
  assert.deepEqual(panel.children.map((c) => c.dataset.module), EXPECTED_IDS);
  const speedCell = textOf(panel.children.find((c) => c.dataset.module === 'speed'));
  // P2 预览裁定：吞吐/时长以 full 进面板（时长三行，目标 4）——断言三行 + fmt 注入生效
  //（round1 一位小数 / 整数秒 / fmtDur 分钟档）
  assert.match(speedCell, /最新一轮32\.4 s平均回合45 s总耗时4m/, 'setFmt(fmt) 注入 → ctx.fmt 数字已格式化（吞吐/时长 full 时长三行）');
  const pulseCell = textOf(panel.children.find((c) => c.dataset.module === 'pulse'));
  assert.match(pulseCell, /用量波形/, 'v8：波形卡片进面板（默认全程）');
  assert.match(pulseCell, /名义合计/, '波形统计行来自 active.pulse');
  assert.match(pulseCell, /53\.6 cr/, '波形名义合计 = mock 全程 total');
  const tpsCell = textOf(panel.children.find((c) => c.dataset.module === 'turnspeed'));
  assert.match(tpsCell, /逐轮生成速度/, 'v8：逐轮速度卡片进面板');
  assert.match(tpsCell, /平均 56\.5 tps/, '逐轮速度来自 active.turnSpeeds（mock）');
  const sessionsCell = textOf(panel.children.find((c) => c.dataset.module === 'sessions'));
  assert.match(sessionsCell, /会话明细/, 'sessions 面板标题');
  assert.match(sessionsCell, /23 轮 · 187 次 · qfmodel/, 'sessions 面板会话行');
  const toolsCell = textOf(panel.children.find((c) => c.dataset.module === 'tools'));
  assert.match(toolsCell, /工具与失败/, 'tools 面板标题');
  assert.match(toolsCell, /代码变更\+126 \/ −38 · 7 文件/, 'tools 面板代码变更');
});

test('槽位迁移（hasMini + v7 哨兵）：旧存档（v4/v5/v6 默认及更早）→ 整条回落 v7 六槽；含 session/tools/credits 的自定义布局原样保留', async () => {
  const mod = await import('../app/widget.js');
  mod.setState(mock);
  const mountWith = (slots) => {
    const host = makeHost();
    host.ownerDocument.defaultView.localStorage.store['qum.layout.v1'] = JSON.stringify({ miniSlots: slots, collapsed: true });
    return mod.mount(host, { baseUrl: '' });
  };
  const V7 = ['tps', 'quota', 'session', 'tools', 'credits', 'turnsec'];
  const slotsOf = (root) => root.children[0].children.filter((s) => s.dataset.slot).map((s) => s.dataset.slot); // 「分析」列无 dataset.slot → 天然排除
  // v6 默认 ['tokens','credits','tps','turnsec']（缺 session/tools 哨兵）→ 整条回落 v7
  const root6 = mountWith(['tokens', 'credits', 'tps', 'turnsec']);
  assert.deepEqual(slotsOf(root6), V7, 'v6 默认触发回落（缺 session/tools 哨兵）');
  // 上一代默认 ['model','tokens','tps','turnsec']：含 model → 整条回落
  const root00 = mountWith(['model', 'tokens', 'tps', 'turnsec']);
  assert.deepEqual(slotsOf(root00), V7, 'v4 默认触发回落（含 model 槽）');
  assert.doesNotMatch(root00.children[0].children.map(textOf).join('|'), /qfmodel/, '回落默认后不再有模型槽');
  // 更早一代默认 ['tokens','turnsec']（缺哨兵）
  const root0 = mountWith(['tokens', 'turnsec']);
  assert.deepEqual(slotsOf(root0), V7, 'v3 默认触发回落（哨兵缺席）');
  // 更早一代：pack/session/session-rate（当年 pack 无 renderMini）
  const root1 = mountWith(['pack', 'session', 'session-rate']);
  assert.deepEqual(slotsOf(root1), V7, 'pack/session/session-rate → 回落 v7 默认');
  assert.match(root1.children[0].children.map(textOf).join('|'), /12\.8万 tok/);
  // 更早一代：usage-5h/usage-week
  const root2 = mountWith(['pack', 'usage-5h', 'usage-week']);
  assert.deepEqual(slotsOf(root2), V7);
  // 再早一代（quota-5h% 假条时代）
  const root3 = mountWith(['quota-5h%', 'quota-week%', 'pack']);
  assert.deepEqual(slotsOf(root3), V7);
  // v5 哨兵时代（model+credits 在场）的自定义顺序存档：含 model → v7 整条回落
  const root4 = mountWith(['turnsec', 'tps', 'credits', 'tokens', 'model']);
  assert.deepEqual(slotsOf(root4), V7, '含 model 的 v5 自定义 → 回落 v7');
  // v7 合法自定义（每槽可迷你、含 session/tools/credits、不含 model）：原样保留，顺序自定
  const custom = ['turnsec', 'tools', 'session', 'credits', 'quota', 'tps'];
  const root5 = mountWith(custom);
  assert.deepEqual(slotsOf(root5), custom);
});

test('P2 strip 空态（P3 起判定源＝active）: active.lastTurn 缺/非对象 → 单「暂无回合数据」+「分析」列照常', async () => {
  const mod = await import('../app/widget.js');
  const { setState, mount } = mod;
  const host = makeHost();
  // P3 spec §5.3：空态由「活动会话存在但本轮无数据」驱动（切到还没发言的会话）；
  // 连 active 都没有属于"身份未取到"，走四列 '--' 占位（由 widgetDom T9 用例覆盖）。
  setState({ meta: {}, local: { active: { sessionId: 'S-x', lastTurn: null, session: null } }, account: null, external: null });
  const root = mount(host, { baseUrl: '' });
  const strip = root.children[0];
  assert.match(textOf(strip), /暂无回合数据/);
  assert.equal(findAll(strip, 'qum-slot').length, 0);
  // 空态是轮数据缺失，不是分析缺失：元信息列照常，meta 缺 generatedAt → 占位格式
  assert.equal(findAll(strip, 'qum-analysis').length, 1);
  assert.equal(textOf(findAll(strip, 'qum-analysis-value')[0]), '--/-- --:--:--');
  assert.match(findAll(strip, 'qum-analysis')[0].title, /^上次分析：--/);
});

test('注册区接线：widget.js mount 惰性 import modules.js；harness 静态 import 同步', async () => {
  const widgetSrc = read('app/widget.js');
  assert.match(widgetSrc, /import\('\.\/modules\.js'\s*\+\s*DEV_Q\)/, "widget.js 注册区须动态 import('./modules.js') 并透传 dev rev");
  const html = read('tests/harness/index.html');
  assert.match(html, /import\s*'\/app\/modules\.js'/, 'harness 页静态 import modules.js（T9 同步）');
  assert.match(html, /from\s+'\/app\/widget\.js'/, 'T8 契约 import 保留');
});

// ---------------------------------------------------------------- 计费口径切换（tokens，用户裁定）
// state.local.billingMode='tokens'（当前会话是 BYOK：无 credits、只有真实 token）时，面板与底栏
// 整体切到 token 口径：真实 token（不加估算标记，不是 billedInput 估算）、无 cr/cr·min 行；
// 'credits'/缺失/乱值 → 现状完全不变（既有断言即回归网）。
const tokState = () => {
  const st = JSON.parse(JSON.stringify(mock));
  const L = st.local;
  L.billingMode = 'tokens';
  // 真机口径（2026-10-27）：input 是 prompt 总量，cacheRead 是其中的缓存命中子集。
  // 本夹具：prompt 98,000（命中 90,000 → 未命中 8,000），命中率 90,000/98,000 = 91.8%。
  const w = { input: 98000, output: 500, cacheRead: 90000, cacheCreate: 0, credits: 0, turns: 3, billedInput: 120000, billedInputSource: 'fallback200k', cacheHitRate: 0.918 };
  L.window5h = { ...w }; L.week = { ...w }; L.today = { ...w };
  L.contextWindow = { value: 200000, source: 'fallback200k' };
  L.session = { id: 'sess-byok', credits: 0, turns: 3, rateCpm30: 0, billedInput: 120000, avgTurnSec: 91, totalTurnSec: 262, model: 'qoder-custom-f4e/mimo-v2.6-flash', modelName: 'mimo-v2.6-flash', tps30: 66.7, billingMode: 'tokens', input: 98000, output: 500, outEst: 421, outEstThk: 30, outEstTxt: 351, outEstCall: 40, cacheRead: 90000, cacheCreate: 0, outTps30: 55.8, rounds: 3, requests: 5, cacheHitRate: 0.918, firstTs: 1791793000000, lastTs: 1791793816142, tools: { calls: 6, errors: 0, byName: [{ name: 'Read', calls: 6, errors: 0 }] }, edits: { added: 10, removed: 2, files: 2 } }; // outEst：T16 正文估算（「输出」行换它，一位小数、无标记）
  L.sessions = [{ id: 'sess-byok', model: 'qoder-custom-f4e/mimo-v2.6-flash', modelName: 'mimo-v2.6-flash', credits: 0, billedInput: 120000, billedSource: 'fallback200k', turns: 3, rounds: 3, requests: 5, lastTs: 1791793816142, avgTurnSec: 91, billingMode: 'tokens', input: 98000, output: 500, cacheRead: 90000, cacheCreate: 0 }];
  // T9：strip v5 迷你槽读 lastTurn（BYOK 真机形态——轮内真实 token、credits null）
  L.lastTurn = {
    sessionId: 'S-tk', promptTs: 0, endTs: 45600, turnSec: 45.6,
    model: 'qoder-custom-x/mimo-v2.6-flash', modelName: 'Mimo-V2.6',
    billingMode: 'tokens', credits: null,
    input: 104000, output: 500, cacheRead: 96000, cacheCreate: 0,
    billedInput: null, billedSource: null, outTps: 45.6,
  };
  return st;
};
const linesOf = async (id, state, size) => {
  const { getModules } = await import('../app/widget.js');
  const def = getModules().find((m) => m.id === id);
  return findAll(def.render({ size, state: syncActive(state), fmt: {} }), 'qum-line').map(textOf);
};

// v8：usage（用量节奏）已删（与 consumption 重复，用户裁定「删重复」）——原 tokens 口径 usage 用例
// 随模块一并移除；tokens 口径的波形呈现由 pulse 用例覆盖。

test('tokens 口径：session 本会话 half/full 改真实 token 三明细 + 生成速度（outTps30；无 cr、无 cr/min；P2 删平均回合行）', async () => {
  const st = tokState();
  assert.deepEqual(await linesOf('session', st, 'half'), ['本会98.0k tok']);
  assert.deepEqual(await linesOf('session', st, 'full'), [
    '本会话98.0k tok · 3 轮 · 5 次', '生成速度55.8 tps',
    '输入未命中8.0k tok', '缓存命中90.0k tok', '输出421 tok', '会话sess-byo', // 未命中 = input − cacheRead（缓存是 input 的子集）
    '模型mimo-v2.6-flash (byok)', // T8：mock 目录新增 mimo-v2.6-flash（byok:true）→ 后缀标注
  ]);
  assert.match((await linesOf('session', mock, 'half'))[0], /cr$/);
});

test('T16 真值优先：outTok/outExact/outTps30Exact=true 时输出与速度不加估算标记（BYOK 真实 output_tokens）', async () => {
  const st = tokState();
  const s = st.local.session;
  s.outTok = 500;           // 真实 output_tokens 合计（outEst 421 是估算，被真值覆盖）
  s.outExact = true;
  s.outTps30Exact = true;
  s.byModel = [{
    model: 'qoder-custom-f4e/mimo-v2.6-flash', modelName: 'mimo-v2.6-flash', billingMode: 'tokens',
    credits: null, creditsBillable: null, creditsFree: null, input: 104000, output: 500,
    cacheRead: 96000, cacheCreate: 0, billedInput: null, billedSource: null,
    turns: 1, outTps: 12.3, outTpsExact: true, avgTurnSec: 10,
  }];
  const rows = await linesOf('session', st, 'full');
  assert.ok(rows.includes('输出500 tok'), '真值输出无估算标记');
  assert.ok(rows.includes('生成速度55.8 tps'), '真值速率无估算标记');
  assert.ok(rows.some((r) => r.includes('12.3 tps')), 'byModel 真值速率已格式化');
  // 混合/估算 → 同样不加标记（outExact=false）
  s.outExact = false;
  s.outTps30Exact = false;
  assert.ok((await linesOf('session', st, 'full')).includes('输出500 tok'));
  const { getModules } = await import('../app/widget.js');
  const def = getModules().find((m) => m.id === 'speed');
  assert.equal(textOf(def.renderMini({ size: 'mini', slot: 'tps', state: syncActive(st), fmt: {} })), '⚡ 55.8 t/s');
  s.outTps30Exact = true;
  assert.equal(textOf(def.renderMini({ size: 'mini', slot: 'tps', state: syncActive(st), fmt: {} })), '⚡ 55.8 t/s');
});

test('tokens 口径：consumption 今日行去 cr、tokens 迷你槽读 lastTurn 真实计费输入总量（无估算标记）、credits 槽 -- cr；session 簇切真实 token', async () => {
  const st = tokState();
  assert.deepEqual(await linesOf('consumption', st, 'half'), ['今日98.0k in / 500 out']);
  assert.deepEqual(await linesOf('consumption', st, 'full'),
    ['5h98.0k in / 500 out', '周98.0k in / 500 out', '今日98.0k in / 500 out']);
  const { getModules } = await import('../app/widget.js');
  const def = getModules().find((m) => m.id === 'consumption');
  // v7：tokens 槽仍是末轮真实总量（input 已含缓存 = 104,000）；credits 槽在 tokens 口径不适用
  assert.equal(textOf(def.renderMini({ size: 'mini', slot: 'tokens', state: syncActive(st), fmt: {} })), '104,000 tok');
  assert.equal(textOf(def.renderMini({ size: 'mini', slot: 'credits', state: syncActive(st), fmt: {} })), '-- cr');
  // v7：session 会话簇在 tokens 口径用真实总量（input 已含缓存 = 98,000 → 9.8万），无估算标记
  const sdef = getModules().find((m) => m.id === 'session');
  assert.equal(textOf(sdef.renderMini({ size: 'mini', slot: 'session', state: syncActive(st), fmt: {} })),
    '9.8万 tok · 91.8% 命中 · 3 轮 · 5 次');
});

test('tokens 口径：speed 迷你槽与 full 行（P2 行序：最新一轮/平均回合/总耗时/生成速度；无估算标记、无 cr/min 行）', async () => {
  const st = tokState();
  const { getModules } = await import('../app/widget.js');
  const def = getModules().find((m) => m.id === 'speed');
  // v7：tps 槽 = 会话 outTps30（55.8）；turnsec 槽 = 末轮 turnSec（45.6）
  assert.equal(textOf(def.renderMini({ size: 'mini', slot: 'tps', state: syncActive(st), fmt: {} })), '⚡ 55.8 t/s');
  assert.equal(textOf(def.renderMini({ size: 'mini', slot: 'turnsec', state: syncActive(st), fmt: {} })), '45.6 s');
  const rows = await linesOf('speed', st, 'full');
  assert.deepEqual(rows, ['最新一轮45.6 s', '平均回合91 s', '总耗时4m', '生成速度55.8 tps · 近30分钟']);
  assert.doesNotMatch(rows.join('|'), /cr/, 'tokens 口径无 cr/min 行');
  // credits 口径 mini 读 mock.session.outTps30 45.6（不再是末轮 56.5）
  assert.equal(textOf(def.renderMini({ size: 'mini', slot: 'tps', state: syncActive(mock), fmt: {} })), '⚡ 45.6 t/s');
});

test('tokens 口径：sessions 会话明细行按行自身口径出 tok（无 cr、无估算标记）；混排行各用各自口径', async () => {
  const st = tokState();
  assert.deepEqual(await linesOf('sessions', st, 'full'),
    ['sess-byo · 98.0k tok · 3 轮 · 5 次 · mimo-v2.6-flash']);
  // 混排：第二条是 credits 口径会话 → 该行仍出 cr
  st.local.sessions.push({ id: 'sess-cr', model: 'qfmodel', modelName: null, credits: 12.4, billedInput: 90000, billedSource: 'runtime-config', turns: 2, rounds: 2, requests: 4, lastTs: 1, avgTurnSec: null, billingMode: 'credits', input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });
  assert.deepEqual(await linesOf('sessions', st, 'full'), [
    'sess-byo · 98.0k tok · 3 轮 · 5 次 · mimo-v2.6-flash',
    'sess-cr · 12.4 cr · 90.0k tok · 2 轮 · 4 次 · qfmodel',
  ]);
});

// ---------------------------------------------------------------- P2 byModel 呈现（session 表 + sessions 手风琴）
test('session byModel 表（P2）：模型行后每模型一行（同会话明细展开格式）；空/缺失 → 「暂无模型明细」；half 不追加', async () => {
  const { getModules } = await import('../app/widget.js');
  const def = getModules().find((m) => m.id === 'session');
  const rows = findAll(def.render({ size: 'full', state: syncActive(mock), fmt: {} }), 'qum-line').map(textOf);
  assert.deepEqual(rows.slice(5), [
    'qfmodel · 0.6 cr · 48.1k tok · 56.5 tps · 66s · 3 轮', // fallback200k；0.6→'0.6'；T16 估算速率、一位小数、无标记
    'Mimo-V2.6 (byok) · -- cr · 104.0k tok · 46 tps · 41s · 1 轮', // tokens 口径：cr 段 -- cr、tok 段真实总量
  ]);
  // byModel 空 → 「暂无模型明细」（qum-note，不入行集）；旧 daemon（无字段）→ 同处理
  const empty = { ...mock, local: { ...mock.local, session: { ...mock.local.session, byModel: [] } } };
  assert.match(textOf(def.render({ size: 'full', state: syncActive(empty), fmt: {} })), /暂无模型明细/);
  const old = { ...mock, local: { ...mock.local, session: { id: 'S', credits: 5, turns: 3 } } };
  assert.match(textOf(def.render({ size: 'full', state: syncActive(old), fmt: {} })), /暂无模型明细/);
  assert.equal(findAll(def.render({ size: 'full', state: syncActive(old), fmt: {} }), 'qum-line').length, 5, '旧会话仍出基础五行 + note 不算行（P2：本会话/近30分钟/计费输入/会话/模型）');
  // half 宽度紧：不追加 byModel 行
  assert.deepEqual(findAll(def.render({ size: 'half', state: syncActive(mock), fmt: {} }), 'qum-line').map(textOf), ['本会123.4 cr']);
});

test('sessions 手风琴（P2）：整行点击展开 byModel 明细、互斥开新收旧、按 id 记忆（重渲染保持）、无 byModel 不可展开、滑出自然丢弃', async () => {
  const { getModules } = await import('../app/widget.js');
  const def = getModules().find((m) => m.id === 'sessions');
  const el = def.render({ size: 'full', state: syncActive(mock), fmt: {} });
  assert.equal(findAll(el, 'qum-session-item').length, 3, '每会话一个 item 容器');
  assert.equal(findAll(el, 'qum-session-caret').length, 2, 'ghi789 byModel:[] → 无 caret（不可展开）');
  assert.deepEqual(findAll(el, 'qum-session-caret').map(textOf), ['▸', '▸']);
  assert.equal(findAll(el, 'qum-session-detail').length, 0);
  // 展开 abc123（byModel 两行）
  findAll(el, 'qum-session-item')[0].fire('click');
  assert.deepEqual(findAll(el, 'qum-session-detail').map(textOf), [
    'qfmodel · 0.6 cr · 48.1k tok · 56.5 tps · 66s · 3 轮Mimo-V2.6 (byok) · -- cr · 104.0k tok · 46 tps · 41s · 1 轮',
  ]);
  assert.deepEqual(findAll(el, 'qum-session-caret').map(textOf), ['▾', '▸']);
  // 互斥：展开 def456 → abc123 自动收起（同时只展开一个）
  findAll(el, 'qum-session-item')[1].fire('click');
  assert.deepEqual(findAll(el, 'qum-session-caret').map(textOf), ['▸', '▾']);
  assert.equal(findAll(el, 'qum-session-detail').length, 1);
  assert.match(textOf(findAll(el, 'qum-session-detail')[0]), /^qfmodel · 88.2 cr · 96\.0k tok · 44 tps · 62s · 30 轮$/);
  // 不可展开行点击无响应（无 listener）
  findAll(el, 'qum-session-item')[2].fire('click');
  assert.equal(findAll(el, 'qum-session-detail').length, 1);
  assert.deepEqual(findAll(el, 'qum-session-caret').map(textOf), ['▸', '▾']);
  // 重渲染（每次 poll 重建 DOM）按会话 id 记忆：def456 仍展开
  const el2 = def.render({ size: 'full', state: syncActive(mock), fmt: {} });
  assert.deepEqual(findAll(el2, 'qum-session-caret').map(textOf), ['▸', '▾']);
  assert.match(textOf(findAll(el2, 'qum-session-detail')[0]), /30 轮/);
  // 滑出 top10（新 state 无该 id）→ 记忆不指向任何行 → 无展开（自然丢弃）
  const short = { ...mock, local: { ...mock.local, sessions: mock.local.sessions.slice(0, 1) } };
  assert.equal(findAll(def.render({ size: 'full', state: syncActive(short), fmt: {} }), 'qum-session-detail').length, 0);
  // 收尾：收起 def456，恢复模块内存态（不污染后续测试）
  findAll(el, 'qum-session-item')[1].fire('click');
  assert.equal(findAll(el, 'qum-session-detail').length, 0);
  // half 形态保持「近 N 个会话 + 首行」（无 caret/item 包装）
  assert.equal(findAll(def.render({ size: 'half', state: syncActive(mock), fmt: {} }), 'qum-session-item').length, 0);
});

// ---------------------------------------------------------------- P2 修订④「按模型消耗」（models）
test('models 按模型消耗（修订④）：默认 7 日序卡片五列值 + byok 后缀（真机目录 DeepSeek-Flash 亦 byok，规则同会话行）+ 左缘彩条按位次 + 条形/今日亮段；图例与排序控件原文', async () => {
  const { getModules } = await import('../app/widget.js');
  const def = getModules().find((m) => m.id === 'models');
  assert.equal(def.title, '按模型消耗');
  assert.deepEqual(def.supports, ['full']);
  assert.equal(def.defaultSize, 'full');
  const el = def.render({ size: 'full', state: syncActive(mock), fmt: {} });
  // 顶部行：排序控件（「排序：」+ select，右对齐靠 CSS；value 即当前主键）
  assert.equal(textOf(findAll(el, 'qum-models-sort-label')[0]), '排序：');
  const sel = findAll(el, 'qum-models-sort')[0];
  assert.equal(sel.value, '7日消耗');
  assert.deepEqual(findAll(sel, 'qum-models-option').map(textOf), ['7日消耗', '今日消耗', 'Tokens', '时延', '回合', '占比']);
  // 图例行（照图逐字）
  assert.equal(textOf(findAll(el, 'qum-models-legend')[0]), '条=近7日实扣；内嵌亮段=今日；缺失上报显示 -，不按0计入；悬停看名义/免费。');
  // 默认序 = credits7d 降序（null 垫底）；byok 后缀随目录条目
  const cards = findAll(el, 'qum-models-card');
  assert.equal(cards.length, 5);
  assert.deepEqual(findAll(el, 'qum-models-name').map(textOf),
    ['DeepSeek-Flash (byok)', 'Qwen3.8-27B', 'GLM-5.3', 'Kimi K3', 'Mimo-V2.6 (byok)']);
  // 五列值（照图：今日/近7日/Tokens/时延/占比；Mimo 无 cr 上报 → -）
  assert.deepEqual(cards.map((c) => findAll(c, 'qum-models-value').map(textOf)), [
    ['29 cr', '912 cr', '60.4M', '63s/回合', '83.1%'],
    ['6 cr', '128 cr', '8.6M', '71s/回合', '11.7%'],
    ['3 cr', '43 cr', '3.9M', '88s/回合', '3.9%'],
    ['1 cr', '15 cr', '3.4M', '74s/回合', '1.4%'],
    ['-', '-', '1.3M', '41s/回合', '-'],
  ]);
  // 左缘彩条：按显示位次循环（第 5 行回绕蓝）；条色同左缘
  assert.deepEqual(cards.map((c) => c.style.borderLeft),
    ['4px solid #3b82f6', '4px solid #22c55e', '4px solid #f59e0b', '4px solid #a855f7', '4px solid #3b82f6']);
  const bar0 = findAll(cards[0], 'qum-models-bar')[0];
  assert.equal(bar0.style.width, '100%', '条长 = credits7d/max');
  assert.equal(bar0.style.background, '#3b82f6');
  assert.equal(findAll(cards[0], 'qum-models-lit')[0].style.width, '3.2%', '亮段宽（相对条宽折算）= creditsToday/max');
  assert.equal(findAll(cards[1], 'qum-models-bar')[0].style.width, '14%');   // 128/912
  assert.equal(findAll(cards[1], 'qum-models-lit')[0].style.width, '4.7%'); // 6/128
  assert.equal(findAll(cards[4], 'qum-models-bar').length, 0, 'credits7d 缺失 → 不画条');
  assert.equal(findAll(cards[4], 'qum-models-lit').length, 0, '缺失也不画亮段');
});

test('models 空态与防御（修订④）：byModelWindow 缺失/乱值/空 rows → 图例照常 + 「近7日暂无数据」；乱行滤除；缺字段 - 守位（绝不按 0 计入）；排序确定（乱序输入同结果）', async () => {
  const { getModules } = await import('../app/widget.js');
  const def = getModules().find((m) => m.id === 'models');
  for (const st of [
    { ...mock, local: { ...mock.local, byModelWindow: { windowStart: null, todayStart: null, rows: [] } } },
    { ...mock, local: { ...mock.local, byModelWindow: null } },
    { ...mock, local: { ...mock.local, byModelWindow: 'garbage' } },
    { ...mock, local: { ...mock.local, byModelWindow: { rows: 'x' } } },
    { ...mock, local: null },
    {},
  ]) {
    const el = def.render({ size: 'full', state: syncActive(st), fmt: {} });
    assert.match(textOf(el), /近7日暂无数据/);
    assert.equal(findAll(el, 'qum-models-card').length, 0);
    assert.match(textOf(el), /条=近7日实扣；内嵌亮段=今日；缺失上报显示 -，不按0计入；悬停看名义\/免费。/, '图例行照常');
  }
  // 乱行（非对象）滤除；缺字段行 - 守位；条长/占比只认有限 credits7d
  const rows = [
    { model: 'm-x', modelName: null, billingMode: null, creditsToday: null, credits7d: null, input: null, output: null, cacheRead: null, cacheCreate: null, turns: null, outTps: null, avgTurnSec: null },
    'not-an-object',
    { model: 'm-y', modelName: 'Y', billingMode: 'credits', creditsToday: 2, credits7d: 2, input: 100, output: 0, cacheRead: 0, cacheCreate: 0, turns: 1, outTps: 1, avgTurnSec: 2 },
  ];
  const ragged = { ...mock, local: { ...mock.local, byModelWindow: { windowStart: null, todayStart: null, rows } } };
  const el = def.render({ size: 'full', state: syncActive(ragged), fmt: {} });
  const cards = findAll(el, 'qum-models-card');
  assert.equal(cards.length, 2, '乱行被滤，不渲染残行');
  assert.deepEqual(findAll(el, 'qum-models-name').map(textOf), ['Y', 'm-x'], '有限 credits7d 在前，null 垫底');
  assert.deepEqual(findAll(cards[0], 'qum-models-value').map(textOf), ['2 cr', '2 cr', '100', '2s/回合', '100%']);
  assert.equal(findAll(cards[0], 'qum-models-bar')[0].style.width, '100%');
  assert.equal(findAll(cards[0], 'qum-models-lit')[0].style.width, '100%');
  assert.deepEqual(findAll(cards[1], 'qum-models-value').map(textOf), ['-', '-', '0', '-', '-']);
  assert.equal(findAll(cards[1], 'qum-models-bar').length, 0);
  // 排序确定性：同一数据乱序输入 → 渲染结果一致（杜绝抖动）
  const shuffled = { ...mock, local: { ...mock.local, byModelWindow: { windowStart: null, todayStart: null, rows: [rows[2], rows[1], rows[0]] } } };
  assert.deepEqual(findAll(def.render({ size: 'full', state: syncActive(shuffled), fmt: {} }), 'qum-models-name').map(textOf), ['Y', 'm-x']);
  // 并列兜底链：credits7d 相同 → Tokens 降序 → model 升序
  const tie = (model, modelName, tokens) => ({ model, modelName, billingMode: 'credits', creditsToday: 5, credits7d: 5, input: tokens, output: 0, cacheRead: 0, cacheCreate: 0, turns: 1, outTps: 0, avgTurnSec: 3 });
  const tieState = { ...mock, local: { ...mock.local, byModelWindow: { windowStart: null, todayStart: null, rows: [tie('t-b', 'TB', 100), tie('t-a', 'TA', 100), tie('t-c', 'TC', 300)] } } };
  assert.deepEqual(findAll(def.render({ size: 'full', state: syncActive(tieState), fmt: {} }), 'qum-models-name').map(textOf),
    ['TC', 'TA', 'TB'], 'Tokens 大者先 → 同 Tokens 按 model 升序');
});

test('models 排序切换（修订④）：下拉 change 就地重排（不重拉数据）；时延/回合降序；颜色随位次移动；复原默认 7日消耗', async () => {
  const { getModules } = await import('../app/widget.js');
  const def = getModules().find((m) => m.id === 'models');
  const el = def.render({ size: 'full', state: syncActive(mock), fmt: {} });
  const sel = findAll(el, 'qum-models-sort')[0];
  const names = () => findAll(el, 'qum-models-name').map(textOf);
  // 时延（avgTurnSec）降序：GLM-5.3 88s 居首
  sel.value = '时延';
  sel.fire('change');
  assert.deepEqual(names(), ['GLM-5.3', 'Kimi K3', 'Qwen3.8-27B', 'DeepSeek-Flash (byok)', 'Mimo-V2.6 (byok)']);
  // 颜色随位次（非按模型固定）：GLM 行现在是第一位 → 蓝
  assert.equal(findAll(el, 'qum-models-card')[0].style.borderLeft, '4px solid #3b82f6');
  // 回合降序：DeepSeek-Flash 63 轮居首
  sel.value = '回合';
  sel.fire('change');
  assert.equal(names()[0], 'DeepSeek-Flash (byok)');
  // 复原默认（模块内存态，避免污染后续用例）
  sel.value = '7日消耗';
  sel.fire('change');
  assert.deepEqual(names(), ['DeepSeek-Flash (byok)', 'Qwen3.8-27B', 'GLM-5.3', 'Kimi K3', 'Mimo-V2.6 (byok)']);
});

test('models 缓存命中徽标（2026-10-22 用户裁定，2026-10-27 口径修正）：仅 cacheRead>0 的模型渲染；率=cacheRead/input（cacheRead 是 input 的子集，不再叠加）；无命中不出节点也不补 0%', async () => {
  await import('../app/modules.js'); // 自注册（单用例跑 --test-name-pattern 时也成立）
  const { getModules } = await import('../app/widget.js');
  const def = getModules().find((m) => m.id === 'models');
  const row = (model, modelName, input, cacheRead, cacheCreate) => ({
    model, modelName, billingMode: 'tokens',
    creditsToday: null, credits7d: null,
    input, output: 0, cacheRead, cacheCreate,
    billedInput: null, billedSource: null,
    turns: 1, outTps: 10, avgTurnSec: 5,
  });
  const rows = [
    row('m-a', '缓存 90', 100000, 90000, 0), // 90000 / 100000
    row('m-b', '无缓存', 0, 0, 0),            // 分母 0
    row('m-c', '仅输入', 12345, 0, 0),        // 有分母但无缓存命中
    row('m-d', '缓存 25', 40, 10, 0),         // 10 / 40
  ];
  const st = { ...mock, local: { ...mock.local, byModelWindow: { windowStart: null, todayStart: null, rows } } };
  const el = def.render({ size: 'full', state: syncActive(st), fmt: {} });
  const cards = findAll(el, 'qum-models-card');
  const cardOf = (name) => cards.find((c) => textOf(findAll(c, 'qum-models-name')[0]) === name);
  const chipOf = (name) => findAll(cardOf(name), 'qum-models-cache');
  assert.equal(chipOf('缓存 90').length, 1, '有缓存读取 → 渲染一个徽标');
  assert.equal(textOf(chipOf('缓存 90')[0]), '缓存 90%');
  assert.equal(chipOf('缓存 25').length, 1);
  assert.equal(textOf(chipOf('缓存 25')[0]), '缓存 25%', '率 = cacheRead / input');
  assert.equal(chipOf('无缓存').length, 0, 'token 全 0 → 不渲染徽标');
  assert.equal(chipOf('仅输入').length, 0, '有输入但 cacheRead=0 → 没有命中可报，不渲染');
  // 徽标与模型名同一行（head），不是新增的第六列
  const head = findAll(cardOf('缓存 90'), 'qum-models-head')[0];
  assert.ok(head, '存在名字行容器');
  assert.equal(head.children.includes(chipOf('缓存 90')[0]), true);
});

// ---- P3 T8: 三个会话级模块读 active 而非全局；active 缺席 → 硬暴露 ----
test('P3 T8: active 与全局分歧时，底栏槽/本会话/吞吐时长出 active 的值', async () => {
  await import('../app/modules.js'); // 自注册（setState/mount 在 widget.js）
  const mod = await import('../app/widget.js');
  const st = JSON.parse(JSON.stringify(mock));
  st.local.active = {
    sessionId: 'S-y',
    lastTurn: { sessionId: 'S-y', promptTs: 1, endTs: 2, turnSec: 7.5, model: 'dfmodel', modelName: 'DeepSeek-Flash',
      billingMode: 'credits', credits: 2.25, input: 900, output: 12, cacheRead: 0, cacheCreate: 0,
      billedInput: 40000, billedSource: 'runtime-config', outTps: 3.4 },
    session: { id: 'S-y', credits: 33.5, turns: 9, rateCpm30: 0.5, billedInput: 120000, avgTurnSec: 40,
      model: 'dfmodel', modelName: 'DeepSeek-Flash', tps30: 1, billingMode: 'credits', input: 10, output: 5,
      cacheRead: 0, cacheCreate: 0, tps30Tokens: null, outTps30: 8.8, byModel: [], totalTurnSec: 360,
      rounds: 9, requests: 20, cacheHitRate: 0.5, firstTs: 100, lastTs: 200,
      outEst: 50, outEstThk: 10, outEstTxt: 30, outEstCall: 10,
      tools: { calls: 4, errors: 0, byName: [] }, edits: null },
  };
  mod.setState(st);
  const root = mod.mount(makeHost(), { baseUrl: '' });
  const val = (slot) => {
    const col = findAll(root.children[0], 'qum-slot').find((n) => n.dataset.slot === slot);
    return textOf(findAll(col, 'qum-slot-value')[0]);
  };
  // v7（2026-10-26 用户裁定：六槽原生样式）
  assert.deepEqual(root.children[0].children.filter((c) => c.dataset.slot).map((c) => c.dataset.slot),
    ['tps', 'quota', 'session', 'tools', 'credits', 'turnsec'], 'v7 六槽单行式');
  assert.equal(findAll(root.children[0], 'qum-slot').filter((n) => n.dataset.slot === 'model').length, 0, '不再有模型槽');
  assert.equal(val('credits'), '33.5 cr', 'credits 槽出 active 会话累计');
  assert.equal(val('turnsec'), '7.5 s', '耗时槽出 active 末轮 turnSec');
  assert.equal(val('tps'), '⚡ 8.8 t/s', '速率槽出 active 会话 outTps30（T16 估算，一位小数、无标记）');
  assert.equal(val('session'), '12万 tok · 50% 命中 · 9 轮 · 20 次', '会话簇出 active 会话（不是全局 12.8万/23 轮）');
  assert.equal(val('tools'), '工具 4 · 失败 0', '工具槽出 active 会话');
  const sessCell = textOf(root.children[1].children.find((c) => c.dataset.module === 'session'));
  assert.match(sessCell, /本会话33.5 cr · 9 轮 · 20 次/, '本会话模块读 active.session（33.5 → fmtCredits 一位小数）');
  assert.match(sessCell, /会话S-y/, '会话 id 行也是 active 的（不是全局 abc123）');
  assert.doesNotMatch(sessCell, /未取到当前会话/, '有 active 时不出硬暴露说明');
  const speedCell = textOf(root.children[1].children.find((c) => c.dataset.module === 'speed'));
  assert.match(speedCell, /最新一轮7\.5 s/, '吞吐/时长读 active.lastTurn.turnSec');
  assert.match(speedCell, /总耗时6m/, '吞吐/时长读 active.session.totalTurnSec（360s → 6m）');
  assert.match(speedCell, /生成速度8\.8 tps/, '吞吐/时长读 active.session.outTps30（8.8 → fmtNum 一位小数，T16 估算、无标记）');
});

test('P3 T8 回退（真机结论）: active 缺席 → 六槽出全局值、无结构告警（DOM 在嵌套文档里拿不到会话）', async () => {
  const mod = await import('../app/widget.js');
  const st = JSON.parse(JSON.stringify(mock));
  delete st.local.active;
  mod.setState(st);
  const root = mod.mount(makeHost(), { baseUrl: '' });
  const stripText = root.children[0].children.map(textOf).join('|');
  assert.match(stripText, /12\.8万 tok/, '回落到全局会话簇（P2 行为）');
  assert.match(stripText, /123\.4 cr/, 'credits 槽回落全局会话累计');
  assert.doesNotMatch(stripText, /未取到当前会话/);
  const sessCell = textOf(root.children[1].children.find((c) => c.dataset.module === 'session'));
  assert.match(sessCell, /当前会话/, '模块如实改名');
  assert.doesNotMatch(sessCell, /未取到当前会话（客户端结构可能已变）/, '不再断言客户端结构问题');
});

// ---- 2026-10-28 上游反馈 §1：跟随标记 + 无 active → 硬暴露，绝不回落全局最新会话 ----
// 真机复现：4 个会话并存，strip 出现了另一个会话的轮/次/credits（= 全局最新会话），
// 而用户正在看的会话是另一个。根因 = daemon 在 ?session= 缺席时仍回填 local.session（全局最新），
// 呈现层再静默回落。widget 现在给每次真实轮询打 meta.activeTracked=true：此时 local.active 缺席
// 就是「没解析出身份」，必须显示 -- 与说明，而不是别人的数字。
test('P3 修复 §1: activeTracked 且无 local.active → 六槽/本会话/工具硬暴露，不出现全局最新会话的数字', async () => {
  const mod = await import('../app/widget.js');
  const st = JSON.parse(JSON.stringify(mock));
  delete st.local.active;
  st.meta = { ...st.meta, activeTracked: true };
  mod.setState(st);
  const root = mod.mount(makeHost(), { baseUrl: '' });
  const stripText = root.children[0].children.map(textOf).join('|');
  assert.doesNotMatch(stripText, /12\.8万|123\.4 cr|45\.6 t\/s|32\.4 s/,
    `不得出现全局最新会话的任何数字：${stripText}`);
  const val = (slot) => {
    const col = findAll(root.children[0], 'qum-slot').find((n) => n.dataset.slot === slot);
    return textOf(findAll(col, 'qum-slot-value')[0]);
  };
  assert.equal(val('session'), '--');
  assert.equal(val('tools'), '工具 -- · 失败 --');
  assert.equal(val('credits'), '-- cr');
  assert.equal(val('tps'), '⚡ -- t/s');
  assert.equal(val('turnsec'), '--');
  const sessCell = textOf(root.children[1].children.find((c) => c.dataset.module === 'session'));
  assert.match(sessCell, /未识别当前会话（客户端未暴露会话身份）/, '会话模块如实说明未识别');
  assert.doesNotMatch(sessCell, /本会话\d/, '不得显示任何本会话数字');
  const toolsCell = textOf(root.children[1].children.find((c) => c.dataset.module === 'tools'));
  assert.match(toolsCell, /未识别当前会话/);
});

// ---- 2026-10-28 上游反馈 §2：实扣 0 / 名义 > 0 → 「0/名义」----
// 真机实况：窗口与多数会话全为免费量（billable:false）→ creditsBillable=0、名义几十上百。
// 旧呈现只出裸「0 cr」，会被读成「没花 credits」。主数字仍是实扣（P0 裁定不变），
// 只在 0 且有名义值时并列名义，tooltip 继续给完整 实扣/名义/未扣减。
test('§2 实扣 0 / 名义 >0 → 底栏/本会话/近30分钟/窗口/会话行/byModel/模型卡均出「0/名义」，tooltip 保持三口径', async () => {
  const mod = await import('../app/widget.js');
  const st = JSON.parse(JSON.stringify(mock));
  st.local.session = {
    ...st.local.session, creditsBillable: 0, credits: 79.68, rateCpm30: 1.234, rateCpm30Billable: 0,
  };
  st.local.session.byModel = st.local.session.byModel.map((m, i) => (i === 0
    ? { ...m, creditsBillable: 0, credits: 8.4 } : m));
  st.local.window5h = { ...st.local.window5h, creditsBillable: 0, credits: 57.98 };
  st.local.sessions = st.local.sessions.map((s, i) => (i === 0
    ? { ...s, creditsBillable: 0, credits: 133.66 } : s));
  st.local.byModelWindow = {
    ...st.local.byModelWindow,
    rows: st.local.byModelWindow.rows.map((r, i) => (i === 0
      ? { ...r, creditsTodayBillable: 0, creditsToday: 29, credits7d: 912, credits7dBillable: 0 } : r)),
  };
  st.meta = { ...st.meta, activeTracked: true };
  const state = syncActive(st);
  mod.setState(state);
  const root = mod.mount(makeHost(), { baseUrl: '' });
  const val = (slot) => {
    const col = findAll(root.children[0], 'qum-slot').find((n) => n.dataset.slot === slot);
    return textOf(findAll(col, 'qum-slot-value')[0]);
  };
  assert.equal(val('credits'), '0/79.7 cr', '底栏 credits 槽：实扣 0 并列名义（两位小数）');
  const sessCell = root.children[1].children.find((c) => c.dataset.module === 'session');
  const sessText = textOf(sessCell);
  assert.match(sessText, /本会话0\/79\.7 cr · 23 轮 · 187 次/, '面板主数字 0/名义（一位小数）');
  assert.match(sessText, /近30分钟0\/1\.2 cr\/min/, '近30分钟速率同样并列');
  assert.match(sessText, /0\/8\.4 cr/, 'byModel 行同样并列');
  const lines = findAll(sessCell, 'qum-line');
  assert.equal(lines[0].title, '实扣 0 cr · 名义 79.7 cr · 未扣减 79.7 cr', 'tooltip 三口径不变');
  const sessionsCell = textOf(root.children[1].children.find((c) => c.dataset.module === 'sessions'));
  assert.match(sessionsCell, /0\/133\.7 cr/, '会话明细行并列名义（133.66 → 133.7）');
  const modelsCell = textOf(root.children[1].children.find((c) => c.dataset.module === 'models'));
  assert.match(modelsCell, /0\/29 cr/, '模型卡今日并列名义（真实字段名 creditsToday）');
  assert.match(modelsCell, /0\/912 cr/, '模型卡近7日并列名义');
  // 实扣 > 0 时维持单值（不引入噪声）
  const st2 = JSON.parse(JSON.stringify(st));
  st2.local.session = { ...st2.local.session, creditsBillable: 12.5 };
  mod.setState(syncActive(st2));
  const root2 = mod.mount(makeHost(), { baseUrl: '' });
  const val2 = (slot) => {
    const col = findAll(root2.children[0], 'qum-slot').find((n) => n.dataset.slot === slot);
    return textOf(findAll(col, 'qum-slot-value')[0]);
  };
  assert.equal(val2('credits'), '12.5 cr', '实扣非零 → 仍只显示实扣');
});

// ---- P3 T10: 会话明细里当前会话行带高亮类（列表本身仍是全局窗口，spec §5.3）----
test('P3 T10: sessions 列表中 sessionId === active.sessionId 的行加 .qum-session-active', async () => {
  const mod = await import('../app/widget.js');
  const { setState, mount } = mod;
  const st = JSON.parse(JSON.stringify(mock));
  const target = st.local.sessions[1].id; // 第二行，证明不是"只标第一行"
  st.local.active = { sessionId: target, lastTurn: st.local.lastTurn, session: st.local.session };
  setState(st);
  const root = mount(makeHost(), { baseUrl: '' });
  const cell = root.children[1].children.find((c) => c.dataset.module === 'sessions');
  const items = findAll(cell, 'qum-session-item');
  assert.ok(items.length >= 2, '列表有多行');
  const marked = items.filter((n) => n.classList.contains('qum-session-active'));
  assert.equal(marked.length, 1, '恰好一行高亮');
  assert.match(textOf(marked[0]), new RegExp(String(target).slice(0, 8)), '高亮的正是当前会话那一行');
});

// 2026-10-29 用户裁定：展示层不再出现估算符号（≈ / ~），指标最多一位小数。
test('展示层：所有模块 full/half 与迷你槽均不含 ≈ / ~ 估算标记，数值最多一位小数', async () => {
  const { getModules } = await import('../app/widget.js');
  const st = syncActive(mock);
  for (const m of getModules()) {
    for (const size of m.supports) {
      const t = textOf(m.render({ size, state: st, fmt: {} }));
      assert.doesNotMatch(t, /[≈~]/, `${m.id}/${size} 不应出现估算标记`);
      assert.doesNotMatch(t, /\d\.\d{2,}/, `${m.id}/${size} 数值最多一位小数`);
    }
    for (const slot of m.slotIds || []) {
      const t = textOf(m.renderMini({ size: 'mini', slot, state: st, fmt: {} }));
      assert.doesNotMatch(t, /[≈~]/, `${m.id}/${slot} 不应出现估算标记`);
      assert.doesNotMatch(t, /\d\.\d{2,}/, `${m.id}/${slot} 数值最多一位小数`);
    }
  }
});
