// app/widget.js
// Qoder Usage Monitor — widget 框架：挂载、订阅轮询、mini/full、模块注册。
// 零框架、零依赖。约定（Task 8 裁定）：顶层代码绝不触碰 window/document/
// localStorage/fetch —— 它们只在 mount() 之后经 `el.ownerDocument.defaultView`
// 取得，保证 `node --test` 能直接 import 本模块做注册表断言（widgetDom.test.mjs）。
//
// 结构契约（harness 与验收脚本依赖）：
//   <div id="qum-root"><div class="qum-strip">…槽位… + 尾部「分析」时刻列</div><div class="qum-panel" hidden>…网格…</div><div class="qum-hover" hidden>…悬停摘要…</div></div>
//   window.__QUM__ = {setState, mount, expand, collapse}（mount 时挂到宿主 window）
//   strip 在文档流内（不 overlay）；仅 panel 是 overlay（z-index:9999，见 widget.css）。
//
// 底栏尾部「分析」列（用户裁定）：折叠态（= 底栏，面板是点开的覆盖层）直接可见上次分析时刻——
// 数据源 state.meta.generatedAt（daemon 每轮扫描发布时写入），格式 MM/DD HH:MM:SS（月/日 时:分:秒，
// 本地时区逐位补零，fmtClock）；title 给完整 YYYY-MM-DD HH:MM:SS。它是 **widget 元信息、不是
// mini 槽**（无 dataset.slot）：不参与槽位迁移哨兵与布局偏好，模块注册失败/空态也照常显示。
// v6（2026-10-22 用户裁定）：槽标签行删除，「分析」列也只剩数值（单行弱化，title 承载说明）。

// dev-live（2026-10-15）：URL 上的 ?v=rev 必须贯穿整张模块图——相对静态 import 会丢掉
// query，导致热换时 format/modules 仍走旧缓存（或注册到另一个 widget 实例）。无 ?v 时
// 解析出的 URL 与原先完全一致，生产模块缓存行为零变化。
export const DEV_REV = (() => {
  try { return new URL(import.meta.url).searchParams.get('v') || ''; } catch { return ''; }
})();
const DEV_Q = DEV_REV ? `?v=${DEV_REV}` : '';
const { fmtClock, fmtStamp, fmtNum, fmtPct, fmtTokens, fmtCredits, fmtCompact } = await import('./format.js' + DEV_Q);

export const LAYOUT_STORAGE_KEY = 'qum.layout.v1';
export const COLLAPSED_STORAGE_KEY = 'qum.collapsed.v1';
// P2 一级折叠：只存“折叠(true)”的模块 id，展开即删键；缺省/脏值 → 全展开（fail-open）。
// Strip layout v7（2026-10-26 用户裁定：对齐客户端原生底栏，接替 v6）：单行六槽 =
// 会话生成速度 tps（⚡ [~]N.N t/s；估算才带 ~）+ 资源包剩余 quota（◔ N%）+ 会话簇 session（[≈]N万 tok ·
// 命中% · 轮 · 请求）+ 工具/失败 tools + 会话累计 credits + 末轮耗时 turnsec。悬停出摘要卡
// （精确千分位），点击仍打开完整面板。v7 哨兵：每槽可迷你 且 含 session/tools/credits 且
// 不含 model——v4/v5（含 model）/v6（缺 session/tools）存档 → 整条回落 v7 默认。
export const DEFAULT_MINI_SLOTS = ['tps', 'quota', 'session', 'tools', 'credits', 'turnsec'];
export const POLL_COLLAPSED_MS = 30_000;
export const POLL_EXPANDED_MS = 10_000;
export const ANCHOR_WAIT_MS = 3_000;
// 2026-10-23（0.4.9 回归）：React 会把整棵会话视图换掉，root 随旧 composer 一起脱离文档；
// 这一步只查 isConnected（不触发布局），失联就按当前 DOM 重新选宿主。
export const HOST_WATCH_MS = 2_000;
export const ANCHOR_SELECTOR = '[data-turn-status-bar]';
// 2026-10-21 用户裁定：插件信息放到对话输入框底部。composer 是常驻节点（回合空闲也在），
// 作为第一宿主；旧 turn-status-bar 只在回合进行中出现，降为兼容兜底。
export const COMPOSER_SELECTOR = '[data-chat-composer]';
// 真机实测（debug.json：panes=0）：客户端并未把 data-chat-session-id 渲染进这个文档，
// 且 bundle 里带会话 id 的属性至少有三个名字——所以判定**不认属性名**：
// 祖先链上任何名字含 session 的属性，其值若等于 daemon 已知会话 id（来自 state.local.sessions），
// 即视为"当前查看的会话"。客户端日后改名也不会再失效。
export const PANE_SELECTORS = [
  '[data-chat-session-id]', '[data-chat-session-single-conversation]', '[data-chat-session-pane-conversation]',
  '[data-chat-session-pane]', '[data-session-id]',
];
export const PANE_SELECTOR = PANE_SELECTORS[0];
export const ACTIVE_PANE_SELECTOR = '[data-chat-session-id][data-active]';

/** 元素上所有名字含 session 的属性值（小写属性名 → 值），用于不认名字的判定与诊断。 */
function sessionAttrs(el) {
  const out = [];
  try {
    const list = el && el.attributes;
    if (list && typeof list.length === 'number') {
      for (let i = 0; i < list.length; i++) {
        const a = list[i];
        if (a && typeof a.name === 'string' && /session/i.test(a.name) && typeof a.value === 'string' && a.value) {
          out.push([a.name, a.value]);
        }
      }
    }
  } catch { /* 宿主 DOM 被回收 */ }
  return out;
}

/**
 * P3（spec §5.1）：解析「用户当前在看哪个会话」。返回 {sessionId, pane, method, diag}。
 * knownIds = daemon 已知的会话 id 集合（state.local.sessions[].id）——用来在不认属性名的前提下
 * 确认"这个值确实是会话 id"，避免把 pane id / 随机数误当会话。
 * 级别：① 'attr' 锚点祖先链上命中已知会话 id 的属性（真机主路径）；② 'active' 带 data-active 的
 * pane；③ 'anchor' 具名 pane 选择器命中锚点所在 pane；④ 'visible' 全页恰好一个可见 pane；
 * ⑤ 'focus' 多 pane 可见时取 document.activeElement 所在；⑥ 'only' 全页恰好一个；⑦ null 歧义不猜。
 */
export function resolveActivePane(doc, anchorEl, knownIds) {
  const known = knownIds instanceof Set ? knownIds : new Set(Array.isArray(knownIds) ? knownIds : []);
  const sidOf = (el) => {
    const v = el && el.dataset ? el.dataset.chatSessionId : undefined;
    return typeof v === 'string' && v ? v : null;
  };
  const hit = (sessionId, pane, method, diag) => ({ sessionId, pane, method, diag });
  const diag = { panes: 0, activeMarked: 0, visible: 0, attrs: [], knownSize: known.size,
    anchorFound: false, docSize: 0, docSessionAttrs: [], docKnownHit: null };
  try {
    // ① 祖先链不认名字：名字含 session 且值是已知会话 id
    for (let el = anchorEl; el && el !== el.parentNode; el = el.parentNode) {
      for (const [name, value] of sessionAttrs(el)) {
        if (!diag.attrs.includes(name)) diag.attrs.push(name);
        if (known.has(value)) return hit(value, el, 'attr', diag);
      }
      if (!el.parentElement && typeof el.closest !== 'function') break; // 无 parentElement 的假 DOM：只走一层
      if (!el.parentElement) break;
    }
    let panes = [];
    try {
      const seen = new Set();
      for (const sel of PANE_SELECTORS) {
        const found = doc && typeof doc.querySelectorAll === 'function' ? Array.from(doc.querySelectorAll(sel)) : [];
        for (const p of found) if (sidOf(p) && !seen.has(p)) { seen.add(p); panes.push(p); }
      }
    } catch { panes = []; }
    diag.panes = panes.length;
    let marked = null;
    try { marked = doc && typeof doc.querySelector === 'function' ? doc.querySelector(ACTIVE_PANE_SELECTOR) : null; } catch { marked = null; }
    diag.activeMarked = sidOf(marked) ? 1 : 0;
    if (sidOf(marked)) return hit(sidOf(marked), marked, 'active', diag);
    if (anchorEl && typeof anchorEl.closest === 'function') {
      for (const sel of PANE_SELECTORS) {
        const own = anchorEl.closest(sel);
        const sid = sidOf(own) || (own && Array.from(sessionAttrs(own)).map(([, v]) => v).find((v) => known.has(v))) || null;
        if (sid && (known.size === 0 || known.has(sid))) return hit(sid, own, 'anchor', diag);
      }
    }
    const isVisible = (el) => {
      try {
        if (el && typeof el.getBoundingClientRect === 'function') {
          const r = el.getBoundingClientRect();
          if (r && r.width > 0 && r.height > 0) return true;
        }
        return !!(el && el.offsetParent);
      } catch { return false; }
    };
    const vis = panes.filter(isVisible);
    diag.visible = vis.length;
    if (vis.length === 1) return hit(sidOf(vis[0]), vis[0], 'visible', diag);
    if (vis.length > 1 && doc && doc.activeElement) {
      for (const p of vis) {
        let owns = p === doc.activeElement;
        if (!owns && typeof p.contains === 'function') { try { owns = p.contains(doc.activeElement); } catch { owns = false; } }
        if (owns) return hit(sidOf(p), p, 'focus', diag);
      }
    }
    if (panes.length === 1) return hit(sidOf(panes[0]), panes[0], 'only', diag);
    // 侧栏选中行（真机实测：外壳文档里唯一能对上已知会话 id 的属性是 data-session-id）。
    // 近似信号：多标签/分栏时侧栏选中项未必等于嵌套聊天视图正在显示的那个，故排在所有 pane
    // 级别之后；命中即标注 method='sidebar'，面板 tooltip 如实说明这是近似口径。
    try {
      const rows = Array.from((doc && doc.querySelectorAll && doc.querySelectorAll('[data-session-id]')) || [])
        .filter((el) => known.has(el.getAttribute && el.getAttribute('data-session-id')));
      const on = (el) => el.hasAttribute && (el.hasAttribute('data-active') || el.hasAttribute('data-selected')
        || el.getAttribute('aria-current'));
      const picked = rows.find(on) || (rows.filter(isVisible).length === 1 ? rows.filter(isVisible)[0] : null);
      const sid = picked && picked.getAttribute ? picked.getAttribute('data-session-id') : null;
      if (sid) return hit(sid, picked, 'sidebar', diag);
    } catch { /* 宿主 DOM 异常 */ }
    // 全部级别落空时才做一次**有界**全文档扫描（真机排障：判断会话属性到底在哪棵树里）。
    // 只记属性名与"值是否命中已知会话 id"，不外传任何值；上限 3000 元素，最多数毫秒。
    diag.anchorFound = !!(anchorEl && typeof anchorEl.getAttribute === 'function');
    try {
      const all = doc && typeof doc.querySelectorAll === 'function' ? Array.from(doc.querySelectorAll('*')) : [];
      diag.docSize = all.length;
      for (let i = 0; i < Math.min(all.length, 3000); i++) {
        for (const [name, value] of sessionAttrs(all[i])) {
          if (!diag.docSessionAttrs.includes(name)) diag.docSessionAttrs.push(name);
          if (known.has(value) && !diag.docKnownHit) diag.docKnownHit = name;
        }
        if (diag.docSessionAttrs.length > 10) break;
      }
    } catch { /* 宿主 DOM 异常 */ }
    return hit(null, null, panes.length ? 'ambiguous' : null, diag);
  } catch {
    return hit(null, null, 'error', diag);
  }
}
export const ACCOUNT_POLL_MS = 60_000; // T10：账户 bridge 轮询节奏（另加面板展开触发一次）

// ---------------------------------------------------------------- 模块注册表
// registerModule({id,title,supports:['half','full'],defaultSize,render(ctx),renderMini?(ctx),tick?(ctx,el),slotIds?})
// ctx = {size, state, fmt}；strip 迷你另带 ctx.slot（渲染中的槽位 id，供单模块多变体，
// Strip v3：consumption/speed 各经 slotIds:['tokens']/['turnsec'] 服务一个额外迷你槽）。
// Task 9 的 modules.js/format.js 据此插入。
const registry = [];
let fmt = {};
let state = null;
let dom = null; // { doc, win, root, strip, panel, placed, anchor }
let expanded = false;
let pollTimer = null;
let token = null;
let cfg = { baseUrl: '', bootstrapCode: null };
let layout = defaultLayout();
let collapsedModules = {}; // {moduleId: true}；每次 mount 由 loadCollapsed() 从存储重建
let epoch = 0; // 每次 mount 自增：作废上一次挂载遗留的 place() 重试链
let accountTimer = null; // T10：账户 bridge 轮询定时器（与 /state 的 pollTimer 独立）
// P3：活动会话（spec §5.1）。activePane.pane = strip 当前宿主 pane；两个定时器分别做
// 观察器节流（250ms）与「切换即刷新」去抖（300ms）。
let activePane = { sessionId: null, pane: null };
let paneWatchTimer = null;
let sidPollTimer = null;
let paneObserver = null;
let hostWatchTimer = null; // 2026-10-23：宿主看门狗（root 是否仍连着文档）

function defaultLayout() {
  return { miniSlots: DEFAULT_MINI_SLOTS.slice(), collapsed: true };
}

/** 是否有可用凭据；皆无 → 纯 setState 驱动，绝不轮询（无凭据时出图不灰显）。 */
function hasCredentials() {
  return !!(token || cfg.bootstrapCode);
}

export function registerModule(def) {
  if (!def || typeof def.id !== 'string' || !def.id || typeof def.render !== 'function') {
    throw new TypeError('registerModule: {id, render(ctx)} required');
  }
  const entry = {
    title: def.id,
    supports: ['half', 'full'],
    defaultSize: 'half',
    ...def,
  };
  const i = registry.findIndex((m) => m.id === entry.id);
  if (i === -1) registry.push(entry);
  else registry[i] = entry; // 同 id 原位替换（热重载安全），保序
  if (dom) { renderStrip(); renderPanel(); renderHover(); } // 已挂载则实时刷新（Task 9 分帧注册友好）
  return entry;
}

export function getModules() {
  return registry.slice();
}

/** Task 9 注入 format.js 的格式化器；ctx.fmt 原样透传给模块 render。 */
export function setFmt(next) {
  fmt = next || {};
  if (dom) { renderStrip(); renderPanel(); renderHover(); }
}

export function setState(next) {
  state = next;
  if (dom) { renderStrip(); renderPanel(); renderHover(); }
}

// ---------------------------------------------------------------- 注册区（Task 9 接线）
// 真实模块/format 由 ./modules.js 自注册（它 import format.js 后 setFmt + registerModule×9，
// P1.5：usage/session/consumption/cache/speed/pack/mascot；T13 加 heatmap/metrics 两账户源）。
// 两条入口：
//   * harness/验收页：静态 import '/app/modules.js' → mount 前注册表即就绪；
//   * 补丁 client：loader.js 只 import widget.js（T8 契约，不得改），故 mount() 时惰性
//     import 一次；完成时 registerModule 自动重渲染 strip/panel，失败保持 '--' 占位。
// 不在顶层静态 import：(1) T8 契约测试要求 import widget.js 后注册表为空；
// (2) widget↔modules 静态互 import 会构成求值环（widget 顶层 const 处于 TDZ）。
let modulesRequested = false;
function ensureModules() {
  if (modulesRequested) return;
  modulesRequested = true;
  import('./modules.js' + DEV_Q).catch(() => { /* 模块缺失：占位 '--'，绝不崩宿主 */ });
}

/** 已知会话 id 集合（daemon 已发布的会话）——不认属性名的判定靠它确认"这值确实是会话 id"。 */
function knownSessionIds() {
  const local = state && state.local;
  const out = new Set();
  if (local && Array.isArray(local.sessions)) {
    for (const r of local.sessions) if (r && typeof r.id === 'string' && r.id) out.add(r.id);
  }
  if (local && local.session && typeof local.session.id === 'string') out.add(local.session.id);
  if (local && local.lastTurn && typeof local.lastTurn.sessionId === 'string') out.add(local.lastTurn.sessionId);
  return out;
}

/** P3：当前解析出的活动会话 id（null = 未取到 → 呈现层硬暴露）。测试与调试句柄用。 */
export function activeSessionId() { return activePane.sessionId; }

/**
 * P3 排障通道：把「widget 眼里的 DOM」回报给 daemon（随账户 POST 走，落 debug.json）。
 * 客户端把 DevTools 关了，真机上无法在控制台取证；没有这条通道，每次信号失效都要用户重装一次
 * 才能试出原因。只含计数与命中级别——不含会话内容、不含凭据（debug 在服务端从 raw 剥离，
 * 不进 state.json / quota-history.jsonl）。
 */
export function activeDiagnostics() {
  const d = (activePane && activePane.diag) || { panes: 0, activeMarked: 0, visible: 0 };
  // 2026-10-23：宿主段回答"strip 到底挂没挂上"——inDoc=false 即整棵旧视图被卸载；
  // onComposer=false 说明掉进了 fixed/别处；composers 与 visibleComposers 用来识别多视图共存。
  let host = { inDoc: false, onComposer: false, hostVisible: false, composers: 0, visibleComposers: 0, fallback: null };
  try {
    const root = dom && dom.root;
    const parent = root && root.parentNode;
    let all = [];
    try { all = dom && dom.doc && typeof dom.doc.querySelectorAll === 'function' ? Array.from(dom.doc.querySelectorAll(COMPOSER_SELECTOR)) : []; } catch { all = []; }
    const live = all.filter(isLiveNode);
    host = {
      inDoc: !!root && isLiveNode(root),
      onComposer: !!(parent && typeof parent.getAttribute === 'function' && parent.getAttribute('data-chat-composer') !== null),
      hostVisible: looksVisible(parent),
      composers: live.length,
      visibleComposers: live.filter(looksVisible).length,
      fallback: root && typeof root.getAttribute === 'function' ? (root.getAttribute('data-qum-fallback') || null) : null,
    };
  } catch { /* 宿主 DOM 异常：字段保持默认 */ }
  return {
    sid: activePane ? activePane.sessionId : null,
    method: activePane ? activePane.method : null,
    panes: d.panes, activeMarked: d.activeMarked, visible: d.visible,
    attrs: Array.isArray(d.attrs) ? d.attrs.slice(0, 8) : [],
    anchorFound: !!d.anchorFound, docSize: d.docSize || 0,
    docSessionAttrs: Array.isArray(d.docSessionAttrs) ? d.docSessionAttrs.slice(0, 10) : [],
    docKnownHit: d.docKnownHit || null,
    host,
  };
}

/**
 * P3：重算活动 pane。sid 变化时做两件事：① 把 strip 重挂到新活动 pane 的锚点之前
 * （同 pane 绝不动节点，避免抖动）；② 300ms 去抖后立即 pollOnce（不等 10s/30s 节拍）。
 * sid 未变 → 什么都不做（不产生额外请求或重渲染）。
 */
export function refreshActivePane() {
  if (!dom) return false;
  // 2026-10-23：失联/隐藏的旧宿主不能当身份锚点——否则 sid 会永远停在已卸载的那棵树里。
  const anchor = dom.anchor && isLiveNode(dom.anchor) && looksVisible(dom.anchor) ? dom.anchor : null;
  const next = resolveActivePane(dom.doc, anchor, knownSessionIds());
  const changed = next.sessionId !== activePane.sessionId;
  activePane = next;
  if (!changed) return false;
  rehostStrip();
  if (dom.win && typeof dom.win.setTimeout === 'function') {
    if (sidPollTimer !== null) dom.win.clearTimeout(sidPollTimer);
    sidPollTimer = dom.win.setTimeout(() => { sidPollTimer = null; pollOnce(); }, 300);
  }
  return true;
}

/**
 * 2026-10-21：会话输入框优先。pane 自身可能就是 composer（harness/真机会话根形态），
 * 或只是包着它的 wrapper；都没有时退回文档级 composer。两处都找不到 → null，走旧锚点兜底。
 * method='sidebar' 是近似信号（侧栏选中行），允许文档级回落；已确认的活动 pane 不跨 pane 抢。
 * 2026-10-23（0.4.9）：失联 pane（React 卸载整棵会话视图后留下的引用）里往往还能查到旧 composer，
 * 但整棵子树已不在文档中——这类宿主必须当作不存在，否则 root 会永久留在不可见子树里。
 */
export function findComposer(doc, pane, method) {
  const isComposer = (el) =>
    !!(el && typeof el.getAttribute === 'function' && el.getAttribute('data-chat-composer') !== null);
  if (isComposer(pane) && isLiveNode(pane)) return pane;
  const q = (el) => {
    if (!el || typeof el.querySelector !== 'function') return null;
    try { return el.querySelector(COMPOSER_SELECTOR); } catch { return null; }
  };
  const own = pane && isLiveNode(pane) ? q(pane) : null;
  if (own) return own;
  if (pane && method !== 'sidebar') return null;
  return docComposer(doc);
}

/** 节点是否仍在文档里。真 DOM 用 isConnected；假 DOM/旧宿主沿 parentNode 走到根判定；无法判定时维持旧行为。 */
function isLiveNode(node) {
  if (!node) return false;
  try { if (typeof node.isConnected === 'boolean') return node.isConnected; } catch { /* 忽略 */ }
  try {
    let p = node;
    for (let i = 0; p && p.parentNode && i < 1000; i++) p = p.parentNode;
    if (!p) return false;
    if (p.nodeType === 9) return true; // Document
    const tag = p.tagName ? String(p.tagName).toUpperCase() : '';
    return tag === 'BODY' || tag === 'HTML'; // 真机/假 DOM 的挂载根
  } catch { return true; }
}

/** 有 rect 能力时按 0×0 判定"没在显示"（后台标签页/被卸载前的残留）；没有能力时按可见处理。 */
function looksVisible(el) {
  try {
    if (el && typeof el.getBoundingClientRect === 'function') {
      const r = el.getBoundingClientRect();
      if (r && typeof r.width === 'number' && typeof r.height === 'number' && !(r.width > 0 && r.height > 0)) return false;
    }
  } catch { /* 宿主 DOM 异常：按可见处理 */ }
  try {
    const win = dom && dom.win;
    if (win && typeof win.getComputedStyle === 'function') {
      const cs = win.getComputedStyle(el);
      if (cs && (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse' || cs.opacity === '0')) return false;
    }
  } catch { /* 宿主 DOM 异常：按可见处理 */ }
  return true;
}

/** 文档级 composer（2026-10-23）：0.4.9 可能同时挂载多个会话视图，优先选真正有布局的那个。 */
function docComposer(doc) {
  let all = [];
  try { all = doc && typeof doc.querySelectorAll === 'function' ? Array.from(doc.querySelectorAll(COMPOSER_SELECTOR)) : []; } catch { all = []; }
  if (!all.length && doc && typeof doc.querySelector === 'function') {
    try { const one = doc.querySelector(COMPOSER_SELECTOR); if (one) all = [one]; } catch { /* 忽略 */ }
  }
  const live = all.filter(isLiveNode);
  if (!live.length) return null;
  return live.find(looksVisible) || live[0];
}

/** 把 root 挂到输入框卡片末尾（最后一行 = 底部）；CSS order 再兜一层，防 React 追加节点。 */
function insertInComposer(composer) {
  if (!composer || typeof composer.appendChild !== 'function') return false;
  dom.anchor = composer;
  composer.appendChild(dom.root); // appendChild 对已有节点等价于 move，天然幂等
  dom.placed = true;
  dom.root.classList.add('qum-inflow');
  dom.root.classList.add('qum-in-composer');
  dom.root.classList.remove('qum-fixed');
  try { dom.root.removeAttribute('data-qum-fallback'); } catch { /* 假 DOM/旧宿主 */ }
  return true;
}

/** 2026-10-23：当前该挂哪个 composer。pane 活着才认 pane；pane 失联或 root 已脱离文档时走文档级兜底。 */
function pickHost() {
  const pane = activePane.pane;
  const paneLive = !!pane && isLiveNode(pane);
  let composer = paneLive ? findComposer(dom.doc, pane, activePane.method) : null;
  if (!composer && (!paneLive || !isLiveNode(dom.root))) composer = docComposer(dom.doc);
  return composer;
}

/** 输入框被 React 重建/替换后自愈：只在“已有 composer 但 root 不在其内”时重挂。 */
function ensureHosted() {
  if (!dom || !dom.root || !dom.placed) return;
  const composer = pickHost();
  if (composer && dom.root.parentNode !== composer) {
    try { insertInComposer(composer); } catch { /* 宿主结构异常：等下一次观察 */ }
  }
}

/** P3：把 root 移到活动 pane 的 composer 末尾；无 composer 再按旧锚点。 */
function rehostStrip() {
  if (!dom || !dom.placed) return;
  const pane = activePane.pane;
  const composer = pickHost();
  if (composer) {
    if (dom.root.parentNode !== composer) {
      try { insertInComposer(composer); } catch { /* 宿主结构异常：保持现宿主，下次轮询再试 */ }
    }
    return;
  }
  if (!pane || !isLiveNode(pane)) return;
  const anchor = typeof pane.querySelector === 'function' ? pane.querySelector(ANCHOR_SELECTOR) : null;
  if (!anchor || anchor === dom.anchor) return;
  try { insertAtAnchor(anchor); } catch { /* 宿主结构异常：保持现宿主，下次轮询再试 */ }
}

/**
 * 宿主看门狗（2026-10-23）：0.4.9 的会话视图会被 React 整棵替换，root 随旧 composer 一起脱离文档；
 * 观察器不一定覆盖到（属性名/时机都可能变），所以每 2s 做一次廉价的 isConnected 检查，
 * 失联就按当前 DOM 重新选宿主。只重挂、不降级 fixed——用户已裁定贴在输入框底部。
 */
function startHostWatch() {
  if (!dom || !dom.win || typeof dom.win.setTimeout !== 'function') return;
  const tick = () => {
    hostWatchTimer = null;
    if (!dom) return;
    if (dom.placed && !isLiveNode(dom.root)) ensureHosted();
    hostWatchTimer = dom.win.setTimeout(tick, HOST_WATCH_MS);
  };
  hostWatchTimer = dom.win.setTimeout(tick, HOST_WATCH_MS);
}

/** P3：观察 pane 属性变化（data-active / data-chat-session-id）与子树增删。 */
function startPaneWatcher() {
  if (!dom || !dom.win || typeof dom.win.MutationObserver !== 'function') return; // harness/旧测试：静默跳过
  try {
    paneObserver = new dom.win.MutationObserver(() => {
      if (paneWatchTimer !== null) return; // 250ms 节流窗口内忽略
      paneWatchTimer = dom.win.setTimeout(() => {
        paneWatchTimer = null;
        refreshActivePane();
        ensureHosted(); // React 摘掉外来节点 / 换 composer：即使 sid 未变也要补挂
      }, 250);
    });
    const target = dom.doc.documentElement || dom.doc.body;
    if (target && paneObserver.observe) {
      paneObserver.observe(target, {
        attributes: true, attributeFilter: ['data-active', 'data-chat-session-id'], childList: true, subtree: true,
      });
    }
  } catch { paneObserver = null; }
}

// ---------------------------------------------------------------- 挂载

/**
 * mount(el, opts)：el=宿主容器元素（loader/harness 传 document.body）。
 * opts = { baseUrl='', token=null, bootstrapCode=null }
 *   - baseUrl：daemon 根（补丁客户端 'http://127.0.0.1:<port>'；harness 同源传 ''）。
 *   - bootstrapCode：首次 /state?bootstrap= 换取响应头 X-QM-Token，后续走 header。
 *   - token：已知 token（harness ?token= 场景），跳过 bootstrap。
 *   - 两者皆缺 → 不轮询（纯 setState 驱动，harness 无凭据时仍出图不灰显）。
 * 挂载点（2026-10-21 用户裁定）：活动 pane 的 [data-chat-composer] 卡片末尾（输入框底部）；
 * 无 composer 时退回 [data-turn-status-bar] 的最近块级祖先之前；3s 内都没有 → 留在 el 内并
 * 降级 fixed 定位（data-qum-fallback="fixed"）。React 重渲染摘除外来节点后由观察器补挂。
 */
export function mount(el, opts = {}) {
  if (!el || !el.ownerDocument) {
    throw new Error('widget.mount: needs a DOM element (no DOM here?)');
  }
  const doc = el.ownerDocument;
  const win = doc.defaultView;
  // dev-live 热换：上一个实例属于另一个模块实例，其 teardown 只能经 window 句柄回调；
  // 先让旧实例自我回收（root/轮询/观察器），再走本实例的重挂载清理。
  try {
    const prev = win && win.__QUM_INSTANCE__;
    if (prev && typeof prev.destroy === 'function') prev.destroy();
  } catch { /* 旧实例已损毁：继续 mount */ }
  teardownPrevious();
  epoch++; // 作废旧实例 place() 重试链（其捕获的 deadline 不能再降级 fixed 新 root）
  cfg = { baseUrl: opts.baseUrl || '', bootstrapCode: opts.bootstrapCode || null };
  token = opts.token || null;
  ensureStylesheet(doc, opts.rev);

  const root = doc.createElement('div');
  root.id = 'qum-root';
  const strip = doc.createElement('div');
  strip.className = 'qum-strip';
  const panel = doc.createElement('div');
  panel.className = 'qum-panel';
  panel.hidden = true;
  // v7 悬停摘要卡：作为 root 第三个子节点（strip/panel 索引保持 children[0]/[1] 不变）。
  const hover = doc.createElement('div');
  hover.className = 'qum-hover';
  hover.hidden = true;
  root.append(strip, panel, hover);
  el.appendChild(root);
  strip.addEventListener('click', () => togglePanel());
  // 悬停看摘要、点击开完整面板（原生交互）；面板展开时不弹，避免遮挡。
  root.addEventListener('mouseenter', () => {
    if (!dom || expanded) return;
    renderHover();
    dom.hover.hidden = false;
  });
  root.addEventListener('mouseleave', () => {
    if (dom && dom.hover) dom.hover.hidden = true;
  });

  dom = { doc, win, root, strip, panel, hover, placed: false, anchor: null };
  loadLayout();
  loadCollapsed();
  expanded = !layout.collapsed; // P1：localStorage 的 collapsed 决定初始态（纯展示，无副作用）
  dom.panel.hidden = !expanded;
  dom.root.classList.toggle('qum-expanded', expanded);
  ensureModules(); // 注册区：补丁 client 唯一入口（harness 已静态 import，此处命中缓存 no-op）
  renderStrip();
  renderPanel();
  renderHover(); // 摘要卡内容先备好（显隐由悬停/展开态控制）
  place();
  refreshActivePane(); // P3：首帧即确定活动会话（无 pane → 硬暴露，不带 session 参数）
  startPaneWatcher();
  startHostWatch(); // 2026-10-23：root 被 React 连带卸载时兜底归位
  if (win) {
    win.__QUM__ = __QUM__; // 调试句柄（harness/验收脚本依赖）
    win.__QUM_INSTANCE__ = { destroy: teardownPrevious }; // dev-live：跨模块实例热换的回收句柄
  }
  if (token || cfg.bootstrapCode) {
    pollOnce();
    schedulePoll();
  }
  scheduleAccountPoll(); // T10：无 bridge（harness/未打补丁）或无凭据时内部短路，绝不起表绝不 POST
  return root;
}

/** 重复 mount 前回收上一个实例：摘旧 root、清轮询定时器、置空 dom。 */
function teardownPrevious() {
  if (!dom) return;
  if (pollTimer !== null) {
    try { if (dom.win) dom.win.clearTimeout(pollTimer); } catch { /* 尽力而为 */ }
    pollTimer = null;
  }
  if (accountTimer !== null) {
    try { if (dom.win) dom.win.clearTimeout(accountTimer); } catch { /* 尽力而为 */ }
    accountTimer = null;
  }
  // P3：回收活动会话观察器与两个定时器，并把 sid 复位（新实例重新解析）。
  if (paneWatchTimer !== null) { try { dom.win.clearTimeout(paneWatchTimer); } catch { /* 尽力而为 */ } paneWatchTimer = null; }
  if (sidPollTimer !== null) { try { dom.win.clearTimeout(sidPollTimer); } catch { /* 尽力而为 */ } sidPollTimer = null; }
  if (hostWatchTimer !== null) { try { dom.win.clearTimeout(hostWatchTimer); } catch { /* 尽力而为 */ } hostWatchTimer = null; }
  if (paneObserver) { try { if (paneObserver.disconnect) paneObserver.disconnect(); } catch { /* 忽略 */ } paneObserver = null; }
  activePane = { sessionId: null, pane: null };
  const { root } = dom;
  try {
    if (root && root.parentNode) root.parentNode.removeChild(root);
    else if (root && typeof root.remove === 'function') root.remove();
  } catch { /* 旧节点已脱离：忽略 */ }
  dom = null;
}

function place() {
  const myEpoch = epoch;
  const attempt = () => {
    const composer = findComposer(dom.doc, null, null); // 首帧尚无活动 pane：文档级找常驻输入框
    if (composer) {
      try { if (insertInComposer(composer)) return true; } catch { /* 继续试旧锚点 */ }
    }
    const anchor = dom.doc.querySelector(ANCHOR_SELECTOR);
    if (anchor) { insertAtAnchor(anchor); return true; }
    return false;
  };
  if (attempt()) return;
  const deadline = Date.now() + ANCHOR_WAIT_MS;
  const tick = () => {
    if (myEpoch !== epoch || !dom || dom.placed) return; // 已被重新 mount：停掉旧重试链
    if (attempt()) return;
    if (Date.now() >= deadline) { applyFixedFallback(); return; }
    dom.win.setTimeout(tick, 100);
  };
  dom.win.setTimeout(tick, 100);
}

function insertAtAnchor(anchor) {
  dom.anchor = anchor; // P3：记住宿主锚点（resolveActivePane 第②级回落与重挂判定用）
  const target = nearestBlockAncestor(anchor) || anchor;
  if (target.parentNode && target.parentNode !== dom.root) {
    // brief：insertBefore(qum-root, composerWrap)，composerWrap=锚点最近块级祖先
    target.parentNode.insertBefore(dom.root, target);
    dom.placed = true;
    dom.root.classList.add('qum-inflow');
    dom.root.classList.remove('qum-in-composer');
    dom.root.classList.remove('qum-fixed');
    try { dom.root.removeAttribute('data-qum-fallback'); } catch { /* 假 DOM */ }
  } else {
    applyFixedFallback();
  }
}

const BLOCK_TAGS = new Set([
  'DIV', 'SECTION', 'FOOTER', 'HEADER', 'MAIN', 'ASIDE', 'ARTICLE', 'NAV', 'FORM', 'UL', 'OL', 'TABLE',
]);
function nearestBlockAncestor(node) {
  let p = node.parentElement;
  while (p && p !== dom.doc.body && p !== dom.doc.documentElement) {
    if (BLOCK_TAGS.has(p.tagName)) return p;
    p = p.parentElement;
  }
  return null;
}

function applyFixedFallback() {
  if (!dom || dom.placed) return;
  dom.placed = true;
  dom.root.classList.remove('qum-in-composer');
  dom.root.classList.add('qum-fixed');
  dom.root.setAttribute('data-qum-fallback', 'fixed');
}

function ensureStylesheet(doc, rev) {
  let href;
  try {
    // 相对自身 URL：补丁环境解析到 monitor/widget.css，harness 解析到 /app/widget.css；
    // dev-live 时唯一改动是追加 ?v=rev，让同一 link 换 rev 即触发样式热更。
    const url = new URL('./widget.css', import.meta.url);
    if (rev) url.searchParams.set('v', rev);
    href = url.href;
  } catch { return; }
  try {
    const existing = doc.querySelector('link[data-qum-style]');
    if (existing) {
      if (rev && existing.href !== href) existing.href = href; // 复用同一 link，不叠加
      return;
    }
    const link = doc.createElement('link');
    link.rel = 'stylesheet';
    link.dataset.qumStyle = '1';
    link.href = href;
    (doc.head || doc.body).appendChild(link);
  } catch { /* CSS 拿不到不致命：widget 仍可用 */ }
}

// ---------------------------------------------------------------- mini/full 与布局持久化

export function expand() { setExpanded(true); }
export function collapse() { setExpanded(false); }
function togglePanel() { setExpanded(!expanded); }

function setExpanded(v) {
  expanded = !!v;
  if (!dom) return;
  dom.panel.hidden = !expanded;
  if (dom.hover) dom.hover.hidden = true; // 展开/收起后摘要卡先收起（折叠态再次悬停才显示）
  dom.root.classList.toggle('qum-expanded', expanded);
  layout.collapsed = !expanded;
  saveLayout();
  schedulePoll(); // 30s ↔ 10s 切换，并立即补一次（展开即刷新诉求）；无凭据时内部短路
  if (token || cfg.bootstrapCode) pollOnce();
  if (expanded) accountPoll(); // T10：面板展开触发一次账户 ingest（守卫在函数内，绝不影响宿主）
}

function loadLayout() {
  layout = defaultLayout();
  try {
    const raw = dom.win.localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (!raw) return;
    const o = JSON.parse(raw);
    if (o && Array.isArray(o.miniSlots) && o.miniSlots.every((s) => typeof s === 'string')) {
      layout.miniSlots = o.miniSlots;
    }
    if (o && typeof o.collapsed === 'boolean') layout.collapsed = o.collapsed;
    // P2 会写同键的 sizes/order——P1 读到也忽略，不报错。
  } catch { /* 脏值回默认 */ }
}

function saveLayout() {
  try {
    // P1 只存 {miniSlots, collapsed}；键名与 brief 一致。
    dom.win.localStorage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({ miniSlots: layout.miniSlots, collapsed: layout.collapsed }),
    );
  } catch { /* 无痕/配额：布局记忆降级为内存态 */ }
}

// P2 一级折叠（qum.collapsed.v1）：只认 {id: true} 的键；脏 JSON/数组/非 true 值 → 全展开（fail-open）。
// 读写全程 try/catch（隐私模式/配额异常 → 内存态，功能不挂、绝不抛）。
function loadCollapsed() {
  collapsedModules = {};
  try {
    const raw = dom.win.localStorage.getItem(COLLAPSED_STORAGE_KEY);
    if (!raw) return;
    const o = JSON.parse(raw);
    if (!o || typeof o !== 'object' || Array.isArray(o)) return; // 脏值：回全展开
    for (const id of Object.keys(o)) if (o[id] === true) collapsedModules[id] = true; // 只认 true
  } catch { /* 脏 JSON 回全展开，绝不抛 */ }
}

function saveCollapsed() {
  try {
    dom.win.localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify(collapsedModules));
  } catch { /* 无痕/配额：折叠记忆降级为内存态 */ }
}

// ---------------------------------------------------------------- 渲染

/**
 * 槽位 id → 模块：精确 id → 去尾 '%' 的 base → 模块声明的 slotIds 变体槽（P1.5：
 * usage-5h/usage-week → usage 模块，renderMini 依 ctx.slot 选窗口）。都不中 → null。
 */
function moduleForSlot(slotId) {
  const base = slotId.replace(/%$/, '');
  return registry.find((m) => m.id === slotId)
    || registry.find((m) => m.id === base)
    || registry.find((m) => Array.isArray(m.slotIds) && (m.slotIds.includes(slotId) || m.slotIds.includes(base)))
    || null;
}

/** 槽位可渲染（模块已注册且有迷你变体）？ */
function hasMini(slotId) {
  const mod = moduleForSlot(slotId);
  return !!(mod && typeof mod.renderMini === 'function');
}

/**
 * 底栏尾部「分析」列（折叠态元信息，用户裁定）：state.meta.generatedAt（daemon 上次扫描/发布时刻）
 * → MM/DD HH:MM:SS（月/日 时:分:秒，本地；2026-10-22 用户裁定，旧 dd:hh:mm:ss 已废）；
 * title 给完整时刻。无/非法/未扫描（0）→ 占位 '--/-- --:--:--'。
 * 刻意不带 dataset.slot / qum-slot 类：不参与槽位迁移与布局偏好，也不计入槽位断言口径。
 * v6（2026-10-22 用户裁定）：与标签行一起删掉「分析」小字标签，仅剩数值（title 承载说明）。
 */
function analysisColumn(doc) {
  const ts = state && state.meta ? state.meta.generatedAt : null;
  const col = doc.createElement('span');
  col.className = 'qum-analysis';
  const val = doc.createElement('span');
  val.className = 'qum-analysis-value';
  val.textContent = fmtClock(ts);
  col.title = `上次分析：${fmtStamp(ts)}（月/日 时:分:秒）`;
  col.append(val);
  return col;
}

function renderStrip() {
  const { doc, strip } = dom;
  // v6 槽迁移（2026-10-22 用户裁定）：真实老用户 localStorage 存着旧默认（v4/v5
  // ['model','tokens',…]、['tokens','turnsec']、['pack','session','session-rate']、['quota-5h%',…] ……）。
  // v7 判定（2026-10-26）：每槽都可迷你 且 含 session/tools/credits 且 不含 'model'——
  // v4/v5 默认含 'model'，v6 默认缺 session/tools；任何不满足的存档 → 整体回落 v7 默认六槽
  //（绝不留 '--' 幽灵槽 / 半旧布局）。
  // 模块惰性加载期注册表暂空 → 回落默认；各槽渲染由 renderMini 承担（注册完成自动重渲染真值）。
  const isCurrent = layout.miniSlots.every(hasMini)
    && ['session', 'tools', 'credits'].every((s) => layout.miniSlots.includes(s))
    && !layout.miniSlots.includes('model');
  const slots = isCurrent ? layout.miniSlots : DEFAULT_MINI_SLOTS.slice();
  // 空态分两层（P2 spec §4.1 定义；P3 spec §5.3 把判定源换成 local.active，见下）。
  // P3 三分支（spec §4/§5.3）：判定源从 local.lastTurn 换成 local.active——
  // ① active 在但末轮无 → 整条「暂无回合数据」（切到还没发过言的会话）；
  // ② active 缺席（未取到会话身份）→ 继续走列渲染，各 renderMini 自然出 '--' 占位
  //    （列宽保留，用户看得见"哪几格是死的"），绝不出全局值；
  // ③ 正常 → 四列真值。
  const active = state && state.local && state.local.active;
  const lt = active && typeof active === 'object' ? active.lastTurn : undefined;
  if (active && typeof active === 'object' && (!lt || typeof lt !== 'object')) {
    const empty = doc.createElement('span');
    empty.className = 'qum-empty';
    empty.textContent = '暂无回合数据';
    strip.replaceChildren(empty, analysisColumn(doc)); // 空态照样给「分析」时刻（元信息与轮数据无关）
    return strip;
  }
  // 单行六列（v7，2026-10-26 用户裁定：对齐原生底栏）：span.qum-slot（dataset.slot）内仅数值
  //（模块 renderMini，数值自带单位）。session 槽是会话主信息，加 qum-slot-session 强调色。
  const columns = [];
  for (const slotId of slots) {
    const mod = moduleForSlot(slotId);
    if (!mod || typeof mod.renderMini !== 'function') continue; // 模块未注册：该列整列缺席（注册后自动补）
    const col = doc.createElement('span');
    col.className = slotId === 'session' ? 'qum-slot qum-slot-session' : 'qum-slot';
    col.dataset.slot = slotId;
    const val = doc.createElement('span');
    val.className = 'qum-slot-value';
    val.appendChild(callRender(mod, () => mod.renderMini({ ...ctxFor('mini'), slot: slotId })));
    col.append(val);
    columns.push(col);
  }
  strip.replaceChildren(...columns, analysisColumn(doc)); // 尾部追加「分析」列（非槽位，右贴边）
  return strip;
}

// ---------------------------------------------------------------- 悬停摘要卡（v7，2026-10-26 用户裁定）
// 悬停（折叠态）= 原生同款摘要卡：精确千分位 + 命中/思考/工具/编辑/时间范围；点击 strip 仍打开
// 完整面板（面板展开时不弹摘要，避免遮挡）。卡是 root 的第三个子节点（strip/panel 索引不变）。

function isFiniteNum(v) { return typeof v === 'number' && Number.isFinite(v); }

/** 活动会话（与 modules.activeSess 同规）：local.active.session 优先，缺席回落 local.session。 */
function activeSessionOf() {
  const local = state && state.local;
  const a = local && local.active;
  if (a && typeof a === 'object') {
    const s = a.session;
    return s && typeof s === 'object' && !Array.isArray(s) ? s : null;
  }
  const s = local && local.session;
  return s && typeof s === 'object' && !Array.isArray(s) ? s : null;
}

/**
 * 提示输入总量（BYOK 本地真值）。Qoder 的 input 已含 cacheRead；仅旧/异构记录
 * input < cacheRead 时按三项求和还原（与 daemon promptTotalOf 同规）。
 */
function realPromptOf(o) {
  if (!o || typeof o !== 'object') return null;
  const n = (v) => (isFiniteNum(v) ? v : 0);
  const input = n(o.input);
  const cacheRead = n(o.cacheRead);
  return input >= cacheRead ? input : input + cacheRead + n(o.cacheCreate);
}

function hoverRow(doc, key, val) {
  const row = doc.createElement('div');
  row.className = 'qum-hover-row';
  const k = doc.createElement('span');
  k.className = 'qum-hover-key';
  k.textContent = key;
  const v = doc.createElement('span');
  v.className = 'qum-hover-val';
  v.textContent = val;
  row.append(k, v);
  return row;
}

/** 重绘摘要卡内容（不改变显隐；显隐由 mouseenter/mouseleave 与展开态决定）。 */
function renderHover() {
  if (!dom || !dom.hover) return;
  const { doc, hover } = dom;
  const s = activeSessionOf();
  const local = state && state.local ? state.local : null;
  const tk = !!(local && local.billingMode === 'tokens');
  const cw = local && local.contextWindow;
  const approx = !tk && (!cw || cw.source !== 'runtime-config');
  const n = (v) => (isFiniteNum(v) ? fmtNum(v, 0) : '--');
  const head = doc.createElement('div');
  head.className = 'qum-hover-title';
  head.textContent = '会话累计 · 全部请求';
  const rows = [];
  // 输入：credits 口径 = 计费输入估算（≈ 仅 contextWindow 非 runtime-config）；tokens 口径 = 真实总量。
  const inp = s ? (tk ? realPromptOf(s) : s.billedInput) : null;
  let inVal = `${approx && isFiniteNum(inp) ? '≈' : ''}${n(inp)} tok`;
  if (s && isFiniteNum(s.cacheHitRate)) inVal += ` · 命中 ${fmtPct(s.cacheHitRate)}`;
  rows.push(hoverRow(doc, '输入', inVal));
  // 输出：最佳值（usage 真值优先，缺失才用三段估算）——全真值不带 ~，估算/混合带 ~；
  // 思考 tokens 仅在估算参与时出段（不补 0）。
  const outBest = s && isFiniteNum(s.outTok) ? s.outTok : s && isFiniteNum(s.outEst) ? s.outEst : null;
  const outExact = !!(s && isFiniteNum(s.outTok) && s.outExact === true);
  let outVal = outBest !== null ? `${outExact ? '' : '~'}${n(outBest)} tok` : '--';
  if (!outExact && s && isFiniteNum(s.outEstThk) && s.outEstThk > 0) outVal += ` · 思考 ${n(s.outEstThk)}`;
  rows.push(hoverRow(doc, '输出', outVal));
  // 用量：credits 与 tokens 并列展示，两口径绝不折算（tokens 口径无 credits → 只出 tokens）。
  // credits 主数字 = 账户实扣（creditsBillable）；旧记录未标注 billable → 回落名义值。
  const tok = s ? (tk ? realPromptOf(s) : s.billedInput) : null;
  const tokSeg = `${fmtTokens(tok)} tok`;
  const crShown = s && isFiniteNum(s.creditsBillable) ? s.creditsBillable
    : s && isFiniteNum(s.credits) ? s.credits : null;
  const usageRow = hoverRow(doc, '用量', tk ? tokSeg : `${fmtCredits(crShown)} cr · ${tokSeg}`);
  if (!tk && s && isFiniteNum(s.creditsBillable) && isFiniteNum(s.credits)) {
    const uncharged = Math.max(0, Math.round((s.credits - s.creditsBillable) * 100) / 100);
    usageRow.title = `实扣 ${fmtCredits(s.creditsBillable)} cr · 名义 ${fmtCredits(s.credits)} cr`
      + (uncharged > 0 ? ` · 未扣减 ${fmtCredits(uncharged)} cr` : '');
  }
  rows.push(usageRow);
  // 规模：轮（rounds）/请求（requests）/工具/失败。
  const t = s && s.tools && typeof s.tools === 'object' && !Array.isArray(s.tools) ? s.tools : null;
  rows.push(hoverRow(doc, '规模',
    `${n(s && s.rounds)} 轮 · ${n(s && s.requests)} 次 · ${n(t && t.calls)} 工具 · ${n(t && t.errors)} 失败`));
  // 时间范围 / 代码变更（仅 Edit/Write 类编辑；无数据 → '--'）+ 分析时刻。
  rows.push(hoverRow(doc, '时间范围', `${fmtStamp(s && s.firstTs)} → ${fmtStamp(s && s.lastTs)}`));
  const e = s && s.edits && typeof s.edits === 'object' && !Array.isArray(s.edits) ? s.edits : null;
  const edits = e && isFiniteNum(e.added) && isFiniteNum(e.removed)
    ? `+${n(e.added)} / −${n(e.removed)} · ${isFiniteNum(e.files) ? n(e.files) : '--'} 文件`
    : '--';
  rows.push(hoverRow(doc, '代码变更', edits));
  rows.push(hoverRow(doc, '分析时刻', fmtStamp(state && state.meta ? state.meta.generatedAt : null)));
  const foot = doc.createElement('div');
  foot.className = 'qum-hover-foot';
  foot.textContent = '点击展开完整面板';
  hover.replaceChildren(head, ...rows, foot);
}

function renderPanel() {
  const { doc, panel } = dom;
  panel.replaceChildren(...registry.map((mod) => {
    const want = mod.defaultSize === 'full' ? 'full' : 'half'; // P1 编辑模式在 P2
    const size = mod.supports.includes(want) ? want : mod.supports.includes('half') ? 'half' : 'full';
    const cell = doc.createElement('div');
    cell.className = 'qum-cell ' + (size === 'full' ? 'qum-cell-full' : 'qum-cell-half');
    cell.dataset.module = mod.id;
    // P2 一级折叠：标题栏 = 模块名 + 折叠箭头 ▾/▸；点击切换该模块内容显隐（标题行始终可见）。
    const head = doc.createElement('div');
    head.className = 'qum-module-title';
    head.style.cursor = 'pointer';
    const name = doc.createElement('span');
    name.className = 'qum-module-name';
    name.textContent = mod.title;
    if (typeof mod.titleTip === 'string') name.title = mod.titleTip; // P3：口径说明（如「最近活跃会话」）
    const caret = doc.createElement('span');
    caret.className = 'qum-collapse';
    head.append(name, caret);
    head.addEventListener('click', () => {
      if (collapsedModules[mod.id]) delete collapsedModules[mod.id];
      else collapsedModules[mod.id] = true;
      saveCollapsed();
      applyCollapsed(cell, caret, mod.id);
    });
    const body = callRender(mod, () => mod.render(ctxFor(size)));
    cell.append(head, body);
    applyCollapsed(cell, caret, mod.id); // 渲染即按内存态落地（重渲染恢复折叠）
    if (typeof mod.tick === 'function') {
      try { mod.tick(ctxFor(size), body); } catch { /* tick 失败不拖垮面板 */ }
    }
    return cell;
  }));
}

/** 一级折叠落地：cell 增删 `qum-collapsed`（CSS 藏 body），箭头 ▾/▸ 同步。 */
function applyCollapsed(cell, caret, id) {
  const on = !!collapsedModules[id];
  cell.classList.toggle('qum-collapsed', on);
  caret.textContent = on ? '▸' : '▾';
}

function ctxFor(size) {
  return { size, state, fmt };
}

/** 模块 render 必须返回 HTMLElement；异常/异常返回值 → 安全 '--' 节点，绝不让宿主页面崩。 */
function callRender(mod, fn) {
  const { doc } = dom;
  try {
    const node = fn();
    if (node && node.nodeType === 1) return node;
  } catch { /* fall through */ }
  const box = doc.createElement('span');
  box.textContent = '--';
  return box;
}

// ---------------------------------------------------------------- /state 订阅

function schedulePoll() {
  if (!dom || !hasCredentials()) return; // 无凭据：绝不轮询（含展开/收起触发的重排）
  if (pollTimer !== null) { dom.win.clearTimeout(pollTimer); pollTimer = null; }
  const ms = expanded ? POLL_EXPANDED_MS : POLL_COLLAPSED_MS;
  pollTimer = dom.win.setTimeout(() => {
    pollTimer = null;
    if (!hasCredentials()) return; // 凭据中途消失（不会发生，防御性）
    pollOnce().finally(() => schedulePoll());
  }, ms);
}

async function pollOnce() {
  if (!dom || !hasCredentials()) return; // 无凭据时不 fetch → 不会 401 灰显
  const { strip } = dom;
  try {
    // P3（spec §5.1）：每次轮询前静默重算活动 pane——观察器不可用（harness/旧宿主）时，轮询
    // 节拍本身就是刷新点。此处**不**触发 300ms 去抖轮询（正在轮询中），只在 sid 变化时重挂。
    const before = activePane.sessionId;
    activePane = resolveActivePane(dom.doc, dom.anchor || null, knownSessionIds());
    if (before !== activePane.sessionId) rehostStrip();
    const headers = {};
    if (token) headers['X-QM-Token'] = token;
    // P3：带活动会话 → daemon 回请求态 local.active；未取到身份 → 不带参数（响应无 active
    // 键），呈现层据此硬暴露（用户裁定：绝不静默回落到全局最新会话）。
    const qs = [];
    if (!token && cfg.bootstrapCode) qs.push('bootstrap=' + encodeURIComponent(cfg.bootstrapCode));
    if (activePane.sessionId) qs.push('session=' + encodeURIComponent(activePane.sessionId));
    let url = cfg.baseUrl + '/state' + (qs.length ? '?' + qs.join('&') : '');
    const res = await dom.win.fetch(url, { headers });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const issued = res.headers.get('X-QM-Token'); // bootstrap 成功时 daemon 签发
    const hadToken = !!token;
    if (issued) token = issued;
    strip.removeAttribute('data-qum-offline');
    setState(await res.json());
    // T10：补丁 client 冷启动没有 token——bootstrap 换到 token 即"安装时"时刻，
    // 立刻补一次账户 ingest（真机 spike 靠这条拿到首份 raw）。
    if (token && !hadToken) accountPoll();
  } catch {
    strip.setAttribute('data-qum-offline', '1'); // 灰显由 CSS 承担
  }
}

// ---------------------------------------------------------------- 账户 bridge ingest（T10，T13 扩四源，T14 加模型目录）
// 真机路径：补丁 client 里 win.qoderDesktop 的 getAccountUsage()/getAccountPlan()/
// getAccountCreditsHeatmap('app')/getAccountProfileMetrics('app')/listChatComposerModels({fetchStrategy,workspaceDirectories})
// 给出账户 raw JSON 与模型目录，POST /ingest/quota（body={usage,plan,heatmap,metrics,models}，X-QM-Token 头）。
// 节奏：60s 一次 + 面板展开触发一次 + bootstrap 首次换到 token 时一次（见 pollOnce）。
// 铁律：无 bridge（harness/未打补丁）→ accountPoll 永不执行；无 token 且无 bootstrapCode
// → 永不 POST（无凭据规则；POST 必需 token，bootstrap 要等 /state 首轮换发）。
// 一切异常（bridge 抛、fetch 拒）静默吞掉——绝不影响宿主客户端。
// T14（用户报告）：第 5 源 listChatComposerModels 是一级 preload API（IPC chatComposerModelsList），
// 只返回模型目录（非凭据）——用于把 session model id/builtin 句柄解析为人类名。**绝不读客户端
// 凭据存储**（Local Storage leveldb / *.dat / Cookies / sqlite auth 表）；该源缺席（旧 client）→
// typeof 守卫记 null；models 单独有数不触发 POST，也不抑制（跳过 POST 的守卫仍只看四账户源）。

/** brief 守卫：仅 mount 上下文经 dom.win 访问，顶层不摸 window。 */
function hasAccountBridge() {
  const win = dom && dom.win;
  return !!(win && typeof win.qoderDesktop?.getAccountUsage === 'function');
}

/** bridge 返回体容错：字符串尝试按 JSON 解析（失败保留原文给服务端存 raw），其余原样。 */
function asBridgeJson(v) {
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return v; }
  }
  return v === undefined ? null : v;
}

function callBridge(member, ...args) {
  const qt = dom && dom.win && dom.win.qoderDesktop;
  if (!qt || typeof member !== 'function') return Promise.resolve(null);
  return Promise.resolve()
    .then(() => member.call(qt, ...args)) // 绑 receiver：client 侧实现可能用 this
    .then(asBridgeJson, () => null); // 同步抛/异步拒 → 该项记 null，不阻断本轮
}

/**
 * T13/T14：bridge 五源（用量/计划/热力/累计指标/模型目录）并发。
 * 新源在旧 client 上根本不存在 → typeof 守卫记 null（绝不因缺 fn 崩本轮）；
 * heatmap/metrics 的 scope 只允许 'app'|'all'（main 进程校验，乱值抛"产品统计范围无效"），
 * 本模块按用户裁定固定 'app'。listChatComposerModels 参数固定 {fetchStrategy:'live',
 * workspaceDirectories:[]}（live 取真机目录；空工作区目录 = 全量目录，非凭据）。Promise.allSettled：
 * 任一源拒绝都不影响其余。
 */
async function bridgeSources() {
  const qt = dom.win.qoderDesktop;
  const fn = (name) => (typeof qt[name] === 'function' ? qt[name] : null);
  const settled = await Promise.allSettled([
    callBridge(fn('getAccountUsage')),
    callBridge(fn('getAccountPlan')),
    callBridge(fn('getAccountCreditsHeatmap'), 'app'),
    callBridge(fn('getAccountProfileMetrics'), 'app'),
    callBridge(fn('listChatComposerModels'), { fetchStrategy: 'live', workspaceDirectories: [] }),
  ]);
  return settled.map((r) => (r.status === 'fulfilled' ? r.value : null));
}

async function accountPoll() {
  if (!dom || !token) return; // POST 必需 token（header 鉴权；daemon /ingest 不认 bootstrap）
  if (!hasAccountBridge()) return;
  try {
    const [usage, plan, heatmap, metrics, models] = await bridgeSources();
    // Final-review Fix#2（T13 泛化到四账户源，T14 保持）：全 null（本轮一个账户源都没拿到）→
    // 跳过 POST，不向 /ingest/quota 发四样 null 把 last-good 账户显示打回本地 "--"。
    // 任一账户源有数照常 POST（缺的新源以 null 入体，服务端 pickHeatmap/pickMetrics → null）。
    // T14：models 单独有数不触发 POST、缺席也不抑制——跳过守卫只看四账户源（模型目录不是账户态）。
    // 服务端 ingest 语义不变：P2 测试工具仍可直接 POST null。
    if (usage === null && plan === null && heatmap === null && metrics === null) return;
    await dom.win.fetch(cfg.baseUrl + '/ingest/quota', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-QM-Token': token },
      body: JSON.stringify({ usage, plan, heatmap, metrics, models, debug: activeDiagnostics() }),
    });
  } catch { /* daemon 不可达等：本轮放弃，节奏由重排定时器继续 */ }
}

function scheduleAccountPoll() {
  if (dom && accountTimer !== null) {
    try { if (dom.win) dom.win.clearTimeout(accountTimer); } catch { /* 尽力而为 */ }
  }
  accountTimer = null;
  if (!dom || !hasAccountBridge()) return; // bridge 缺席：连定时器都不起
  if (!hasCredentials()) return; // 无凭据规则：no token & no bootstrap → 永不 POST
  accountTimer = dom.win.setTimeout(() => {
    accountTimer = null;
    if (!hasCredentials()) return;
    accountPoll().finally(() => scheduleAccountPoll());
  }, ACCOUNT_POLL_MS);
}

// ---------------------------------------------------------------- 公开句柄

export const __QUM__ = { setState, mount, expand, collapse, activeSessionId, refreshActivePane };
