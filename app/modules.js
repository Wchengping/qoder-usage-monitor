// app/modules.js
// Qoder Usage Monitor — P1.5 模块集（Task 9 + 用户裁定的真实模型重排 + T13 账户两新源）。
// import 本文件即完成接线：setFmt(format.js) 注入 widget 的 ctx.fmt，registerModule 注册
// 12 个模块（usage/session/sessions/models/consumption/cache/speed/tools/pack/mascot/heatmap/metrics）。
// 顶层不摸 window/document：DOM 创建只发生在 render/renderMini 内（经
// globalThis.document），因此 node --test 可直接 import 断言注册表元数据；
// 浏览器侧由 widget.js mount() 的注册区惰性 import（补丁 client 的 loader 只
// import widget.js），harness 页则静态 import —— 模块图评估完成后 registerModule
// 会自动重渲染已挂载的 strip/panel。
//
// P1.5 真实模型裁定（用户决定，binding，覆盖此前所有"5h/周额度"文案）：
//  - Qoder 没有 5 小时/周额度上限（那是参考项目 Claude 式模型的照搬）。真实模型是
//    单周期 credits：userQuota（计划）+ addOnQuota（资源包）。原 quota-5h/quota-week
//    两条假额度条（同一账户仪表挂两个误导性标题）整体删除，连带移除 accountQuota
//    共享仪表、本地/账户徽标、假条 pace 刻度与重置倒计时（资源包无重置字段，不出
//    任何倒计时——保持事实面）。
//  - pack（资源包）升级为真仪表（Strip v3：面板专有，无 renderMini）：full = .qum-bar
//    fill（used/total，CSS 类合法复用，无 pace tick）+ 单行「已用 750 / 1200 · 剩余 450 cr」
//    （fmtCredits，无 k 缩写）；used/total 不可得 → 降级为仅剩余行、不出 bar。half =「剩余 N」
//    （pickPack 链，候选键链逐字全防御，链不中/无账户 → '--'）。
//  - usage（用量节奏，新模块，接替两条假条的信息面）：full 两行「近5小时 N cr」「本周
//    N cr」（本地窗口 credits 为主，token 非零才追加 · in/out——沿用 consumption 行
//    格式）；half 一行「今日 N cr」。无 bar/百分比/徽标——本地口径由模块标题承担。
//    （Strip layout v3：usage 无 slotIds/renderMini——面板 render 不变。）
//  - cacheHitRate null → '--'（真机本地不落盘缓存字段，长期 -- 会被误读为故障）：null 行值
//    span 加 title「客户端未落盘缓存字段」；整宽三窗口全 null → 追加 sub-line「本地无缓存数据」
//    （部分有数不谎称全无）；half 仅 -- + title，宽度紧不加 note 行。
//  - mascot 阈值（P1.5 rekey）：addOnQuota 剩余 >50% 🙂 / 20–50% 😐 / <20% 😨；
//    无账户数据（account.raw 缺席）→ 🫥；有账户但 addOnQuota 读不出用量 → 🙂 中性。
//    used/total 优先，percentage（0–100 制）兜底。气泡取 today。
//  - T12 credits 校准（真机验收裁定，binding）：当前客户端 token 全 0、逐回合 credits 真实
//    → credits 为本地口径主单位（scanner 已聚合）；consumption half 加「今日 N cr」行、
//    full 各行带「 · N cr」；mascot 气泡 credits>0 显示 cr、否则回落 in/out（三元，见下）。
//  - P0 准确性（2026-10-26 用户裁定，binding）：主数字一律**账户实扣** creditsBillable
//    （billable:true）；名义 credits / 未扣减量只进 tooltip。billable:false 的 credits 非零
//    但不扣资源包（真机 5h/今日全属此类），旧记录无 billable 字段 → 回落名义值并在 tooltip
//    标注「实扣未知」。credits 与 creditsBillable 不可互相加总。
//  - 计费输入 tokens（用户裁定，接替死指标 tps）：token 字段中唯一有本地真值链的是
//    usage.context_usage_ratio（平台真值）→ billedInput = Σ ratio×contextWindow（inspector
//    公式；contextWindow 取 runtime-config，缺 → 200k 兜底加 ≈）。speed 模块整体替换为
//    「速度/时长」（平均回合秒 + 计费输入 + cr/min，见模块内注释）；consumption/usage full
//    行尾追加计费段。
//
// T13+ 用户裁定（strip v4 / 模型名 / 会话明细）：
//  - 生成速度 tps（T16 口径，覆盖 T15）：**Output 真值优先，缺失才估算**——usage.output_tokens
//    > 0 直接用真值；为 0（内置模型多数行）才用 est.mjs 正文估算（thinking/text/tool_use 块；
//    est_tokens = CJK×1.3 + 其余÷3）。分母为 qodercli.log request 配对的**实测纯模型秒**（区间
//    合并；无日志轮兜底 = 轮时长−工具时间）。估算值带 ~、全真值不带：speed 模块 full「生成速度
//    N tps · 近30分钟」+ 诚实注记；strip 'tps' 迷你槽读会话 outTps30 / 末轮 outTps
//    （null → '-- tps'）。此前的输入速率字段（tps30/tps30Tokens）保留在 daemon 数据面但不再
//    呈现；tokens 口径「输出」行同源用 outTok（真值优先，估算才带 ~）。
//  - 模型名：runtime-config 顶层 model（真机 'qfmodel'）→ daemon 发布 local.session.model /
//    local.sessions[].model；session 模块 full 增「模型」行 + strip 'model' 迷你槽（T14：解析名
//    ≤18 字原样、超长加 '…'；未解析回落短句柄/id:<8>，绝不做中段标识符截断）。
//  - 会话明细 sessions 模块（panel 专有）：state.local.sessions 每会话一行
//    「<id8> · N cr · ≈Nk tok · R 轮 · Q 次 · <model>」（R=rounds，Q=requests）。
//    strip v5 默认五槽（P2，均读 lastTurn）：['model','tokens','credits','tps','turnsec']。
// dev-live：本模块由 widget.js 动态 import，URL 上的 ?v=rev 必须传给同伴模块，
// 否则会解析出「未带 rev 的第二份 widget.js」——registerModule 落到另一个实例，
// 渲染空转。静态 import 无法运行时加查询串，故用 TLA + 动态 import 透传 rev。
const DEV_REV = (() => {
  try { return new URL(import.meta.url).searchParams.get('v') || ''; } catch { return ''; }
})();
const DEV_Q = DEV_REV ? `?v=${DEV_REV}` : '';
const { registerModule, setFmt } = await import('./widget.js' + DEV_Q);
const { fmtK, fmtPct, fmtCountdown, fmtTps, fmtTokens, fmtCredits, barPcts, fmtNum, fmtDur, fmtCompact } = await import('./format.js' + DEV_Q);

/** 格式化器集合：setFmt 注入后成为 widget ctx.fmt 透传给所有 render。 */
export const fmt = { fmtK, fmtPct, fmtCountdown, fmtTps, fmtTokens, fmtCredits, barPcts, fmtNum, fmtDur, fmtCompact };

// ---------------------------------------------------------------- DOM/读数小工具
function h(tag, className, text) {
  const e = globalThis.document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined && text !== null) e.textContent = String(text);
  return e;
}

/** label + value 一行（视觉间距走内联样式，文本拼接不引入额外空格）。 */
function line(label, value) {
  const row = h('div', 'qum-line');
  const l = h('span', 'qum-line-label', label);
  l.style.marginRight = '4px';
  row.append(l, h('span', 'qum-line-value', value));
  return row;
}

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * 主数字口径（P0 准确性，2026-10-26）：账户实扣优先。
 * creditsBillable = billable:true 记录的 credits 合计（真正从资源包扣减）；
 * credits 为名义值（含 billable:false 的免费量，真机当前 5h/今日全为免费）。
 * 实扣未知（旧记录无 billable 字段）→ 回落名义值，避免整行 '--'；tooltip 如实标注。
 */
function creditShown(o, key = 'credits') {
  if (!o || typeof o !== 'object') return null;
  const bill = o[key + 'Billable'];
  if (isNum(bill)) return bill;
  const nom = o[key];
  return isNum(nom) ? nom : null;
}

/** 主数字 tooltip：实扣 / 名义 / 未扣减（缺项如实省略；无任何值 → null）。 */
function creditTip(o, key, f) {
  if (!o || typeof o !== 'object') return null;
  const bill = o[key + 'Billable'];
  const nom = o[key];
  if (creditShown(o, key) === null) return null;
  if (!isNum(bill)) return `实扣未知（记录未标注 billable）· 名义 ${f.fmtCredits(nom)} cr`;
  if (!isNum(nom)) return `实扣 ${f.fmtCredits(bill)} cr`;
  const uncharged = Math.max(0, Math.round((nom - bill) * 100) / 100);
  return `实扣 ${f.fmtCredits(bill)} cr · 名义 ${f.fmtCredits(nom)} cr`
    + (uncharged > 0 ? ` · 未扣减 ${f.fmtCredits(uncharged)} cr` : '');
}

/** 给元素挂 credits tooltip（无值不设 title，避免空悬停）。 */
function withCreditTip(el, o, key, f) {
  const t = creditTip(o, key, f);
  if (t) el.title = t;
  return el;
}

function win(state, key) {
  const local = state && state.local;
  const w = local && local[key];
  return w && typeof w === 'object' ? w : null;
}

/**
 * 计费输入 tokens 派生段（窗口级，usage/consumption full 行共用）：
 * billedInput = scanner 派生真值 Σ(ratio × contextWindow)；null/非法（升级前缓存记录无
 * ratio）→ null → 调用方省略整段（不出 '≈--' 噪声）。billedInputSource ≠ 'runtime-config'
 * （'fallback200k'/'mixed'/乱值）→ 前缀 ≈（200k 兜底口径标注，inspector 约定）。
 */
function billedSeg(f, w) {
  const b = w ? w.billedInput : null;
  if (!isNum(b)) return null;
  const approx = w.billedInputSource !== 'runtime-config';
  return `${approx ? '≈' : ''}${f.fmtTokens(b)} tok`;
}

/** 优先用 widget 经 setFmt 注入的 ctx.fmt（接线可被集成测试真实检验），缺省回落直接 import。 */
function fmtOf(ctx) {
  const f = ctx && ctx.fmt;
  const complete = f && ['fmtK', 'fmtPct', 'fmtCountdown', 'fmtTps', 'fmtTokens', 'fmtCredits', 'barPcts', 'fmtNum', 'fmtDur', 'fmtCompact']
    .every((k) => typeof f[k] === 'function');
  return complete ? f : fmt;
}

/**
 * 账户容器序（P1.5 后仅供 pickPack/addOnBlock 取真机壳）：候选容器 = raw 自身 →
 * raw.usage → raw.plan（与 daemon/quotaPick.mjs 同规；T10 桥体为 {usage,plan}，
 * 兼容旧扁平体）。
 */
function accountContainers(raw) {
  const out = [];
  const push = (v) => { if (v && typeof v === 'object' && !Array.isArray(v)) out.push(v); };
  push(raw);
  if (raw && typeof raw === 'object') { push(raw.usage); push(raw.plan); }
  return out;
}

/** 各容器内的真机 qoderUsage 壳（防御式收集，乱值跳过）。 */
function qoderShells(raw) {
  const out = [];
  for (const c of accountContainers(raw)) {
    const qu = c.qoderUsage && typeof c.qoderUsage === 'object' && !Array.isArray(c.qoderUsage)
      ? c.qoderUsage : null;
    if (qu) out.push(qu);
  }
  return out;
}

function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

/**
 * 真机资源包块 addOnQuota（首个对象壳命中即返回，字段原样）：{used,total,remaining,
 * percentage,unit} 各值或 undefined。P1.5 真实模型的唯一"额度类"数据源——
 * pack full 仪表（used/total）与 mascot 阈值（percentage）都读它；缺席 → null。
 */
function addOnBlock(account) {
  const a = account && typeof account === 'object' ? account : null;
  if (!a || !a.raw || typeof a.raw !== 'object') return null;
  for (const qu of qoderShells(a.raw)) {
    const ad = qu.addOnQuota;
    if (ad && typeof ad === 'object' && !Array.isArray(ad)) return ad;
  }
  return null;
}

/**
 * 资源包剩余比例（0..1，供 v7 底栏 quota 槽「◔ N%」）：addOnQuota 内
 * remaining/total → 1-used/total → 1-percentage/100（percentage 是已用百分比）；
 * 缺块/字段不可得（如仅有 packRem）→ null（呈现 '◔ --'，绝不猜）。
 */
function quotaRatio(account) {
  const ad = addOnBlock(account);
  if (!ad) return null;
  if (isNum(ad.remaining) && isNum(ad.total) && ad.total > 0) return clamp01(ad.remaining / ad.total);
  if (isNum(ad.used) && isNum(ad.total) && ad.total > 0) return clamp01(1 - ad.used / ad.total);
  if (isNum(ad.percentage)) return clamp01(1 - ad.percentage / 100);
  return null;
}

/**
 * pack 资源包剩余（候选键链，逐字、全防御，任一环节缺失/非数字即落下一候选）：
 *   HEAD：raw.usage.qoderUsage.addOnQuota.remaining（T12 spike 实据——doctor --show-quota-raw
 *   捕获真机 payload，见 tests/quota-sample.json；T9“无实据不加第三候选”至此已满足）
 *   → resource_package_quota.quota_summary.remaining_value → resourcePack.remaining（旧兜底）
 * T10：结构化字段 account.packRem（服务端同链解析所得）存在则优先；raw 链作兜底。
 * 容器序含 {usage,plan} 壳（同 addOnBlock 规）。
 */
export function pickPack(account) {
  const a = account && typeof account === 'object' ? account : null;
  if (!a) return null;
  if (isNum(a.packRem)) return a.packRem;
  const raw = a.raw;
  if (!raw || typeof raw !== 'object') return null;
  for (const qu of qoderShells(raw)) {
    const ad = qu.addOnQuota && typeof qu.addOnQuota === 'object' ? qu.addOnQuota : null;
    const v0 = ad ? ad.remaining : null;
    if (isNum(v0)) return v0;
  }
  for (const c of accountContainers(raw)) {
    const pack = c.resource_package_quota;
    const v1 = pack && pack.quota_summary && pack.quota_summary.remaining_value;
    if (isNum(v1)) return v1;
    const rp = c.resourcePack;
    const v2 = rp && rp.remaining;
    if (isNum(v2)) return v2;
  }
  return null;
}

/** 0..1 → CSS 百分比字符串（一位小数，钳位）。 */
function pctStyle(ratio) {
  const clamped = ratio < 0 ? 0 : ratio > 1 ? 1 : ratio;
  return Math.round(clamped * 1000) / 10 + '%';
}

// ---------------------------------------------------------------- usage（P1.5：用量节奏）/ session（本会话，面板专有）
// Qoder 无 5h/周额度上限——原 quota-5h/quota-week 假额度条（同一账户仪表双标题）按
// 用户裁定删除。本模块保留其"信息面"并诚实改名：纯本地窗口用量数（credits 主单位），
// 无 fill/百分比/徽标/倒计时——本地口径由模块标题「用量节奏」直接承担。
// Strip layout v3（用户截图反馈裁定）：usage 无 slotIds/renderMini（面板 render 不变）；
// strip 的 tokens/turnsec 两槽分别由 consumption/speed 服务，本会话信息全部移入 panel。
const usage = {
  id: 'usage',
  title: '用量节奏',
  supports: ['half', 'full'],
  defaultSize: 'half',
  render(ctx) {
    const f = fmtOf(ctx);
    const st = ctx.state;
    const tk = tokensMode(st); // token 口径：真实 in/out，不出 cr、不出 ≈ 估算段
    const box = h('div', 'qum-usage');
    const row = (label, key) => {
      const w = win(st, key);
      if (tk) return line(label, ioText(f, w));
      let v = `${f.fmtCredits(creditShown(w))} cr`;
      // token 非零才追加 in/out 段（真机现写 0）；格式沿用 consumption 行。
      const inp = w ? w.input : null;
      const out = w ? w.output : null;
      if ((isNum(inp) && inp > 0) || (isNum(out) && out > 0)) {
        v += ` · ${f.fmtK(inp)} in / ${f.fmtK(out)} out`;
      }
      // 计费输入紧凑段（派生真值）：真机 token 全 0 时行形态即「近5小时 0 cr · ≈45k tok」
      const seg = billedSeg(f, w);
      if (seg) v += ` · ${seg}`;
      return withCreditTip(line(label, v), w, 'credits', f);
    };
    if (ctx.size === 'full') box.append(row('近5小时', 'window5h'), row('本周', 'week'));
    else box.append(row('近5小时', 'window5h')); // 去重（修订②）：half 与 full 首行同规（今日归「token 消耗」）
    return box;
  },
};

// session（本会话，面板专有 + model 迷你槽）：数据源 state.local.session = daemon sessionStats 产出
// {id, credits, turns, rateCpm30, billedInput, avgTurnSec, model, tps30}。Strip layout v4（用户裁定）：
// session 经 slotIds:['model'] 提供 strip「模型」迷你槽（当前会话解析名 ≤18 字，未解析回落短句柄/
// id:<8>，null → '--'）；
// 会话其余信息只留展开面板。面板 full 五行事实：本会话（实扣 cr · 轮 · 次）、近30分钟 cr/min、计费输入 tok
//（≈ 判定同 speed）、会话 id 前 8 字、模型（T13 新增）；half 单行：本会 cr。平均耗时只归「吞吐/时长」
//（P2 去重，修订②）。full 行清单末尾 + byModel 表（每模型一行；空 → 暂无模型明细）。
// 防御：state.local.session 缺失/乱值（升级前 daemon 快照）→ full「暂无数据」、half 单行 '--'，绝不抛。
function sessOf(state) {
  const local = state && state.local;
  const s = local && local.session;
  return s && typeof s === 'object' && !Array.isArray(s) ? s : null;
}

/**
 * 呈现口径（用户裁定"只跟随当前会话口径"）：state.local.billingMode === 'tokens' → token 口径
 * （当前会话是 BYOK：本地不写 credits，只有真实 token）；其余（'credits'/缺失/乱值/旧 daemon）
 * → credits 口径 = 现状文案，一字不改。两口径不可换算，绝不折算。
 */
function tokensMode(state) {
  const local = state && state.local;
  return !!(local && local.billingMode === 'tokens');
}

/** v5 迷你槽数据源（P2）：state.local.lastTurn（最新一轮，daemon lastTurnOf 产出）；非对象 → null。 */
const ltOf = (state) => {
  const lt = state && state.local && state.local.lastTurn;
  return lt && typeof lt === 'object' ? lt : null;
};

/** 迷你槽口径（v5）：优先该轮 billingMode（轮内换过模型 → 跟该轮），缺失/乱值回落全局会话口径。 */
const ltTokensMode = (state, lt) => {
  if (lt.billingMode === 'tokens') return true;
  if (lt.billingMode === 'credits') return false;
  return tokensMode(state);
};

// ---------------------------------------------------------------- P3 活动会话取数（spec §5.3）
// 三个会话级模块（session 的 model 槽、consumption 的 tokens/credits 槽、speed 的 tps/turnsec 槽
// 与 full 三行）改读 state.local.active —— 用户当前查看的会话（daemon 按 ?session= 请求态产出）。
// 真机结论（debug.json：anchorFound=false，docSize=1672）：widget 注入的是工作台外壳文档，聊天视图
// （composer 与 data-turn-status-bar 锚点）在嵌套文档里，DOM 侧拿不到「用户正在看哪个会话」。
// 故 active 缺席时**回落到全局锚定（= P2 行为）**，并把模块如实改名为「最近活跃会话」
// （用户裁定 2026-10-14）。daemon 的 ?session= 请求态保留：日后做「面板点行钉选会话」可直接用。
const activeOf = (state) => {
  const a = state && state.local && state.local.active;
  return a && typeof a === 'object' ? a : null;
};
const activeLt = (state) => {
  const a = activeOf(state);
  if (a) { const lt = a.lastTurn; return lt && typeof lt === 'object' ? lt : null; }
  return ltOf(state); // 无活动会话信号 → 全局最新一轮
};
const activeSess = (state) => {
  const a = activeOf(state);
  if (a) { const s = a.session; return s && typeof s === 'object' && !Array.isArray(s) ? s : null; }
  return sessOf(state); // 同上回落
};
const activeSidOf = (state) => {
  const a = activeOf(state);
  return a && typeof a.sessionId === 'string' && a.sessionId ? a.sessionId : null;
};
/** 活动会话口径（优先其自身 billingMode，缺席才回落全局 local.billingMode）。两口径绝不折算。 */
function activeMode(state) {
  const s = activeSess(state);
  if (s && s.billingMode === 'tokens') return true;
  if (s && s.billingMode === 'credits') return false;
  return tokensMode(state);
}
/** 末轮口径（同 ltTokensMode 规则，但回落基准换成活动会话口径）。 */
const activeLtTokensMode = (state, lt) => {
  if (lt.billingMode === 'tokens') return true;
  if (lt.billingMode === 'credits') return false;
  return activeMode(state);
};

/** 真实计费输入总量（BYOK 本地真值，非 billedInput 估算）：input + cacheRead + cacheCreate。 */
function realPrompt(o) {
  if (!o || typeof o !== 'object') return null;
  const n = (v) => (isNum(v) ? v : 0);
  return n(o.input) + n(o.cacheRead) + n(o.cacheCreate);
}

/** token 口径的窗口行文本：`N in / M out`（真实值，fmtK 风格与 credits 口径的 in/out 段一致）。 */
function ioText(f, w) {
  return `${f.fmtK(w ? w.input : null)} in / ${f.fmtK(w ? w.output : null)} out`;
}

/** 模型目录条目数组（state.modelCatalog.entries；缺失/乱值 → []）。 */
function catalogEntries(state) {
  const cat = state && state.modelCatalog;
  return cat && Array.isArray(cat.entries) ? cat.entries : [];
}

/** 目录中匹配 model id 的条目（精确 modelKey → 斜杠后缀/前缀，含反向；与 daemon resolveModelName 同规）。 */
function catalogEntryFor(state, id) {
  if (typeof id !== 'string' || !id) return null;
  const entries = catalogEntries(state);
  for (const e of entries) {
    if (e && typeof e === 'object' && e.modelKey === id) return e;
  }
  for (const e of entries) {
    if (!e || typeof e !== 'object' || typeof e.modelKey !== 'string' || !e.modelKey) continue;
    if (e.modelKey.endsWith('/' + id) || e.modelKey.startsWith(id + '/')
      || id.endsWith('/' + e.modelKey) || id.startsWith(e.modelKey + '/')) return e;
  }
  return null;
}

/**
 * 模型显示文本（T14 display policy，模块层）：
 *   解析名（server 落盘 modelName，非空串）→ 自身；
 *   否则原始 id 为短句柄（/^[a-z][a-z0-9._-]{1,20}$/i）→ 自身（如 'qfmodel'）；
 *   否则有 id → `id:<前8>`（明确标注这是 id 而非名字）；无 id → null（呈现 '--'）。
 * 目的：绝不把 'qoder-custom-f' 式中段截断的原始 id 当模型名。
 */
function modelDisplay(state, session) {
  const name = session && typeof session.modelName === 'string' && session.modelName ? session.modelName : null;
  if (name) return name;
  const id = session && typeof session.model === 'string' ? session.model : null;
  if (!id) return null;
  return MODEL_HANDLE_RE.test(id) ? id : 'id:' + id.slice(0, 8);
}

/** 该会话模型对应目录条目是否 byok:true（「(byok)」标注依据）。 */
function modelByok(state, session) {
  const e = catalogEntryFor(state, session && session.model);
  return !!(e && e.byok === true);
}

/** 短句柄形态（内建模型 id，如 'qfmodel'）：首字符字母 + 1..20 个 [a-z0-9._-]。 */
const MODEL_HANDLE_RE = /^[a-z][a-z0-9._-]{1,20}$/i;

/** 计费输入 tokens 段（会话级）：billedInput + contextWindow.source 定 ≈（同 speed/billedSeg 约定）。 */
function sessBilledSeg(f, s, state) {
  const b = s ? s.billedInput : null;
  const cw = state && state.local && state.local.contextWindow;
  const approx = !cw || cw.source !== 'runtime-config';
  return `${isNum(b) && approx ? '≈' : ''}${f.fmtTokens(b)} tok`;
}

const session = {
  id: 'session',
  // 真机拿不到「正在看哪个会话」（见上方 P3 取数注释），故如实命名并给 tooltip 说明口径。
  title: '当前会话',
  titleTip: '跟随侧栏选中的会话（近似信号：多标签/分栏时未必等于正在看的视图）；取不到时回落最近活跃会话',
  supports: ['half', 'full'],
  // P2 预览裁定：byModel 表（目标 2「本会话可看 per-model 明细」）只在 full 分支——本模块以 full
  // 进面板，否则真机不可达。half 形态保留（供未来编辑模式/窄布局）。
  defaultSize: 'full',
  // v7（2026-10-26 用户裁定：对齐客户端原生底栏）：session 重新拥有 strip 迷你槽，形态是
  // 「会话簇」——[≈]N万 tok · [N% 命中] · N 轮 · N 次（轮=rounds，次=requests）。
  // tokens 口径（BYOK）用 input+cacheRead+cacheCreate 真实总量且无 ≈；credits 口径用 billedInput
  //（≈ 仅 contextWindow 非 runtime-config）。命中率缺失 → 整段省略（不补 0%）。无会话 → '--'。
  slotIds: ['session'],
  renderMini(ctx) {
    const f = fmtOf(ctx);
    const s = activeSess(ctx && ctx.state);
    if (!s) return h('span', 'qum-mini', '--');
    const tk = activeMode(ctx.state);
    const cw = ctx.state && ctx.state.local && ctx.state.local.contextWindow;
    const approx = !tk && (!cw || cw.source !== 'runtime-config');
    const tok = tk ? realPrompt(s) : s.billedInput;
    const parts = [`${approx && isNum(tok) ? '≈' : ''}${f.fmtCompact(tok)} tok`];
    if (isNum(s.cacheHitRate)) parts.push(`${f.fmtPct(s.cacheHitRate)} 命中`);
    parts.push(`${isNum(s.rounds) ? f.fmtNum(s.rounds, 0) : '--'} 轮`);
    parts.push(`${isNum(s.requests) ? f.fmtNum(s.requests, 0) : '--'} 次`);
    return h('span', 'qum-mini', parts.join(' · '));
  },
  render(ctx) {
    const f = fmtOf(ctx);
    const s = activeSess(ctx.state); // P3：本会话跟随活动会话（active 缺席 → 硬暴露）
    const tk = activeMode(ctx.state); // token 口径（BYOK）：真实 tok，无 cr/cr·min
    // 源缺失/乱值（升级前 daemon 快照）：full 出「暂无数据」不猜数（同 heatmap 降级）；
    // half 宽度紧，出单行 '--'（本会），行不消失。
    if (!s) {
      if (ctx.size !== 'full') {
        const box = h('div', 'qum-session');
        box.append(line('本会', tk ? '-- tok' : '-- cr'));
        return box;
      }
      // P3 回退后：active 缺席已回落全局，所以走到这里就是「真的没有会话数据」（空 state /
      // 旧快照垃圾值 / 该会话无 usage）——统一说「暂无数据」，不再断言客户端结构问题。
      return h('div', 'qum-note', '暂无数据');
    }
    if (ctx.size !== 'full') {
      const box = h('div', 'qum-session');
      box.append(tk
        ? line('本会', `${f.fmtTokens(realPrompt(s))} tok`)
        : withCreditTip(line('本会', `${f.fmtCredits(creditShown(s))} cr`), s, 'credits', f));
      return box;
    }
    const box = h('div', 'qum-session');
    // 轮 = rounds（用户轮次），次 = requests（去重请求）；旧 daemon 无字段 → '--'，绝不拿 turns 冒充
    const rounds = isNum(s.rounds) ? String(Math.round(s.rounds)) : '--';
    const req = isNum(s.requests) ? ` · ${Math.round(s.requests)} 次` : '';
    const scale = `${rounds} 轮${req}`;
    if (tk) {
      // 真实 token 三明细（BYOK 本地真值）：未命中输入 / 缓存命中读 / 输出（T16：输出真值优先，
      // 无真值才估算）；速度行 = T16 生成速度 outTps30（最佳输出 ÷ 实测秒，估算才带 ~）。
      box.append(line('本会话', `${f.fmtTokens(realPrompt(s))} tok · ${scale}`));
      box.append(line('生成速度', tpsText(f, isNum(s.outTps30) ? s.outTps30 : null, s.outTps30Exact === true)));
      box.append(line('输入未命中', `${f.fmtTokens(s.input)} tok`));
      box.append(line('缓存命中', `${f.fmtTokens(s.cacheRead)} tok`));
      // Output 最佳值：真值优先（usage.output_tokens > 0），无真值才带 ~ 估算；旧 state 回落 outEst。
      const outBest = isNum(s.outTok) ? s.outTok : isNum(s.outEst) ? s.outEst : null;
      const outApprox = !(isNum(s.outTok) && s.outExact === true);
      box.append(line('输出', outBest !== null
        ? `${outApprox ? '~' : ''}${f.fmtTokens(outBest)} tok`
        : `${f.fmtTokens(s.output)} tok`));
    } else {
      box.append(withCreditTip(
        line('本会话', `${f.fmtCredits(creditShown(s))} cr · ${scale}`), s, 'credits', f));
      box.append(withCreditTip(
        line('近30分钟', `${f.fmtCredits(creditShown(s, 'rateCpm30'))} cr/min`), s, 'rateCpm30', f));
      box.append(line('计费输入', sessBilledSeg(f, s, ctx.state)));
    }
    box.append(line('会话', typeof s.id === 'string' && s.id ? s.id.slice(0, 8) : '--'));
    // T13/T14：模型行显示解析后的人类名（server 落盘 modelName）；BYOK 目录条目 byok:true → 追加
    // 「 (byok)」；未解析回落短句柄/id:<8>；null → '--'。
    const mdisp = modelDisplay(ctx.state, s);
    box.append(line('模型', mdisp === null ? '--' : mdisp + (modelByok(ctx.state, s) ? ' (byok)' : '')));
    // P2：byModel 表（每模型一行）；空/缺失（旧 daemon）→ 一行「暂无模型明细」，绝不抛
    const bm = Array.isArray(s.byModel) ? s.byModel : [];
    if (!bm.length) box.append(h('div', 'qum-note', '暂无模型明细'));
    else for (const m of bm) box.append(h('div', 'qum-line', byModelRowText(f, ctx.state, m)));
    return box;
  },
};

// sessions（会话明细，用户裁定 T13，面板专有）：数据源 state.local.sessions = daemon sessionsSummary
// 产出（≤10 会话，已按 lastTs 降序；每项 {id, model, credits, creditsBillable, creditsFree,
// billedInput, billedSource, turns, rounds, requests, lastTs, avgTurnSec}）。每会话一行
// 「<id8> · N cr · ≈Nk tok · R 轮 · Q 次 · <model>」——≈ 仅当该会话
// billedSource 为 fallback200k/mixed（inspector 口径）；full = 逐行（≤10）；half =「近 N 个会话」+
// 首行（最近活跃）。防御（用户裁定）：源缺失/乱值/空表 → 一行「暂无数据」；单项字段 null → 该段 '--'
// （行不消失）；fmtCredits/fmtTokens 对 null 已出 '--'，model 缺失 → '--'。无 renderMini（非 strip 槽）。
function sessionsOf(state) {
  const local = state && state.local;
  const arr = local && local.sessions;
  return Array.isArray(arr) ? arr : null;
}

/** 行口径：行自身 billingMode 优先，缺字段跟随全局（sessions/byModel 共用）。 */
function rowTokensMode(state, o) {
  if (o && o.billingMode === 'tokens') return true;
  if (o && o.billingMode === 'credits') return false;
  return tokensMode(state);
}

/** 单会话行文本（full/half 共用）：credits 行 `<id8> · N cr · [≈]Nk tok · R 轮 · Q 次 · <model>`；
 * tokens 行（BYOK，行自身 billingMode='tokens'，缺字段跟随全局口径）去 cr 段、tok 用真实总量（无 ≈）。
 * R=rounds（用户轮次），Q=requests（去重请求）；旧 daemon 无 rounds → '-- 轮'（绝不拿记录数冒充轮）。
 * T14：model 段用解析后的人类名（server 落盘 modelName），未解析回落短句柄/id:<8>。 */
function sessionRowText(f, state, s) {
  const o = s && typeof s === 'object' ? s : {};
  const id8 = typeof o.id === 'string' && o.id ? o.id.slice(0, 8) : '--';
  const rowTk = rowTokensMode(state, o);
  const rounds = isNum(o.rounds) ? `${Math.round(o.rounds)} 轮` : '-- 轮';
  const req = isNum(o.requests) ? ` · ${Math.round(o.requests)} 次` : '';
  const mdisp = modelDisplay(state, o);
  const model = mdisp === null ? '--' : mdisp;
  if (rowTk) return `${id8} · ${f.fmtTokens(realPrompt(o))} tok · ${rounds}${req} · ${model}`;
  const approx = o.billedSource === 'fallback200k' || o.billedSource === 'mixed';
  const tok = `${approx ? '≈' : ''}${f.fmtTokens(o.billedInput)} tok`;
  return `${id8} · ${f.fmtCredits(creditShown(o))} cr · ${tok} · ${rounds}${req} · ${model}`;
}

/** 单会话行元素（credits tooltip；tokens 口径不挂 cr 说明）。 */
function sessionRowEl(f, state, s) {
  const el = h('div', 'qum-line', sessionRowText(f, state, s));
  if (!rowTokensMode(state, s)) {
    const tip = creditTip(s, 'credits', f);
    if (tip) el.title = tip;
  }
  return el;
}

/** 生成速度显示：有值 → '[~]N.N tps'（exact=true 时无 ~，真值）；null/乱值 → '-- tps'。 */
function tpsText(f, v, exact = false) {
  return isNum(v) ? `${exact ? '' : '~'}${f.fmtNum(v, 1)} tps` : '-- tps';
}

/** byModel 单模型行文本（session full 表与会话明细展开行共用，spec §4.5）：
 * `名[(byok)] · [--/N] cr · [≈]N tok · ~N.N tps · Ns · N 轮`；行自身口径优先，缺字段逐段 '--'。 */
function byModelRowText(f, state, m) {
  const o = m && typeof m === 'object' ? m : {};
  const disp = modelDisplay(state, o);
  const name = (disp === null ? '--' : disp) + (disp !== null && modelByok(state, o) ? ' (byok)' : '');
  const rowTk = rowTokensMode(state, o);
  // byModel.turns = 该模型参与的轮数（scanner byModelOf 口径），故标「轮」。
  const turns = isNum(o.turns) ? String(Math.round(o.turns)) : '--';
  const outTps = tpsText(f, o.outTps, o.outTpsExact === true);
  const avg = isNum(o.avgTurnSec) ? `${Math.round(o.avgTurnSec)}s` : '--';
  const crSeg = rowTk ? '-- cr' : `${f.fmtCredits(creditShown(o))} cr`;
  const approx = o.billedSource === 'fallback200k' || o.billedSource === 'mixed';
  const tokSeg = rowTk
    ? `${f.fmtTokens(realPrompt(o))} tok`
    : `${approx ? '≈' : ''}${f.fmtTokens(o.billedInput)} tok`;
  return `${name} · ${crSeg} · ${tokSeg} · ${outTps} · ${avg} · ${turns} 轮`;
}

let accExpandedId = null; // 手风琴：当前展开的会话 id（互斥；滑出列表自然失效，无需清理）

const sessions = {
  id: 'sessions',
  title: '会话明细',
  supports: ['half', 'full'],
  // P2 预览裁定：二级手风琴（验收 2「真机可用」）只在 full 分支（列表语义，≤10 行）——本模块以
  // full 进面板。half 形态（近 N 个会话摘要）保留。
  defaultSize: 'full',
  render(ctx) {
    const f = fmtOf(ctx);
    const list = sessionsOf(ctx.state);
    if (!list || !list.length) return h('div', 'qum-note', '暂无数据');
    const box = h('div', 'qum-sessions');
    if (ctx.size !== 'full') {
      box.append(h('div', 'qum-line', `近 ${list.length} 个会话`));
      box.append(sessionRowEl(f, ctx.state, list[0]));
      return box;
    }
    const paint = () => {
      box.replaceChildren(...list.map((s) => {
        const item = h('div', 'qum-session-item');
        const rows = s && Array.isArray(s.byModel) ? s.byModel : [];
        const id = s && typeof s.id === 'string' ? s.id : null;
        // P3：当前查看的会话在列表里标出来（列表保持全局窗口语义，仅加视觉锚点，spec §5.3）。
        if (id && id === activeSidOf(ctx.state)) item.classList.add('qum-session-active');
        if (rows.length > 0) {
          item.style.cursor = 'pointer';
          const caret = h('span', 'qum-session-caret', accExpandedId === id ? '▾' : '▸');
          item.append(caret);
          item.addEventListener('click', () => {
            accExpandedId = accExpandedId === id ? null : id; // 开新收旧
            paint();
          });
        }
        item.append(sessionRowEl(f, ctx.state, s));
        if (rows.length > 0 && accExpandedId === id) {
          const detail = h('div', 'qum-session-detail');
          for (const m of rows) {
            const row = h('div', 'qum-line', byModelRowText(f, ctx.state, m));
            if (!rowTokensMode(ctx.state, m)) {
              const tip = creditTip(m, 'credits', f);
              if (tip) row.title = tip;
            }
            detail.append(row);
          }
          item.append(detail);
        }
        return item;
      }));
    };
    paint();
    return box;
  },
};

// ---------------------------------------------------------------- models（「按模型消耗」，修订④）
// 跨会话 × 近7日 per-model 卡片（数据源 local.byModelWindow.rows，窗口聚合见 spec §3.7）。
// 只进展开面板（supports:['full']，无 half/mini——卡片列表半格放不下）；排序/占比/条长均由
// 本模块就地计算（数据面不冗余），排序为模块内存态（切换不重拉数据）。用户裁定：不做状态列
// 与副标签行（目录无数据源）；缺失上报显示 '-'，绝不按 0 计入 Σ/max/排序主键。
const MODEL_WINDOW_SORT_OPTIONS = ['7日消耗', '今日消耗', 'Tokens', '时延', '回合', '占比'];
const MODELS_PALETTE = ['#3b82f6', '#22c55e', '#f59e0b', '#a855f7']; // 按显示位次循环（非按模型固定）
let modelsSortKey = '7日消耗'; // 模块内存态：当前排序主键（重渲染保持；白名单外回落默认）

/** byModelWindow.rows（local.byModelWindow 缺失/乱值 → []）。 */
function modelWindowRows(state) {
  const local = state && state.local;
  const bw = local && local.byModelWindow;
  return bw && Array.isArray(bw.rows) ? bw.rows : [];
}

/** credits 口径数值：有限数取自身，其余（null/undefined/NaN/字符串）→ null（缺失不按 0 计入）。 */
function creditNum(v) { return isNum(v) ? v : null; }

/** 行 Token 总量（近7日和：input+output+cacheRead+cacheCreate；两口径同义的真实量）。 */
function tokenSum(r) {
  const o = r && typeof r === 'object' ? r : {};
  const n = (v) => (isNum(v) ? v : 0);
  return n(o.input) + n(o.output) + n(o.cacheRead) + n(o.cacheCreate);
}

/**
 * 缓存命中率（2026-10-22 用户裁定）：只在确有缓存读取（cacheRead > 0）的模型上出徽标；
 * 无命中可报（credits 口径 token 全 0 / 上游未上报）→ null，不渲染、不补 0%。
 * 率 = cacheRead / (input + cacheRead + cacheCreate)；cacheRead>0 已保证分母>0。
 */
function cacheRateOf(r) {
  const o = r && typeof r === 'object' ? r : {};
  const n = (v) => (isNum(v) ? v : 0);
  const hit = n(o.cacheRead);
  if (hit <= 0) return null;
  return hit / (n(o.input) + hit + n(o.cacheCreate));
}

/** 排序主键取值（缺失 → null 垫底）。'占比' 与 '7日消耗' 同键（同分母 → 同序）。 */
function modelsSortVal(key, r) {
  switch (key) {
    case '今日消耗': return creditShown(r, 'creditsToday');
    case 'Tokens': return tokenSum(r);
    case '时延': return creditNum(r.avgTurnSec);
    case '回合': return creditNum(r.turns);
    default: return creditShown(r, 'credits7d'); // '7日消耗' / '占比'
  }
}

/** 排序（确定性）：主键降序（null 垫底）→ credits7d 降序 → Tokens 降序 → model 升序。 */
function modelsSortedRows(state) {
  const key = MODEL_WINDOW_SORT_OPTIONS.includes(modelsSortKey) ? modelsSortKey : '7日消耗';
  const rows = modelWindowRows(state).filter((r) => r && typeof r === 'object');
  return rows.sort((a, b) => {
    const va = modelsSortVal(key, a);
    const vb = modelsSortVal(key, b);
    if (va !== vb) return vb === null ? -1 : va === null ? 1 : vb - va;
    const ca = creditShown(a, 'credits7d');
    const cb = creditShown(b, 'credits7d');
    if (ca !== cb) return cb === null ? -1 : ca === null ? 1 : cb - ca;
    const ta = tokenSum(a);
    const tb = tokenSum(b);
    if (ta !== tb) return tb - ta;
    const ma = typeof a.model === 'string' ? a.model : '';
    const mb = typeof b.model === 'string' ? b.model : '';
    return ma < mb ? -1 : ma > mb ? 1 : 0;
  });
}

/** 条长基准 max：仅有限实扣 credits7d 参与；无有限值 → null。 */
function modelsMaxCredits7d(rows) {
  let max = null;
  for (const r of rows) {
    const v = creditShown(r, 'credits7d');
    if (v !== null && (max === null || v > max)) max = v;
  }
  return max;
}

/** 占比分母 Σ：仅有限实扣 credits7d 参与；无有限值 → null。 */
function modelsSumCredits7d(rows) {
  let sum = null;
  for (const r of rows) {
    const v = creditShown(r, 'credits7d');
    if (v !== null) sum = (sum === null ? 0 : sum) + v;
  }
  return sum;
}

/** 单模型卡片（照图）：左缘 4px 彩条（按位次）+ 名（byok 后缀）+ 五列两行式 + 条形/今日亮段。 */
function modelsCard(f, state, r, i, max, sum) {
  const color = MODELS_PALETTE[i % MODELS_PALETTE.length];
  const card = h('div', 'qum-models-card');
  card.style.borderLeft = `4px solid ${color}`;
  const disp = modelDisplay(state, r);
  const name = (disp === null ? '--' : disp) + (disp !== null && modelByok(state, r) ? ' (byok)' : '');
  const head = h('div', 'qum-models-head');
  head.append(h('div', 'qum-models-name', name));
  const rate = cacheRateOf(r);
  if (rate !== null) {
    const chip = h('span', 'qum-models-cache', `缓存 ${f.fmtPct(rate)}`);
    chip.title = '缓存命中率 = 缓存读取 / (输入 + 缓存读取 + 缓存写入)';
    head.append(chip);
  }
  card.append(head);
  const c7 = creditShown(r, 'credits7d');
  const cToday = creditShown(r, 'creditsToday');
  const tip7 = creditTip(r, 'credits7d', f);
  const tipToday = creditTip(r, 'creditsToday', f);
  if (tip7 || tipToday) {
    card.title = [tip7 && `近7日｜${tip7}`, tipToday && `今日｜${tipToday}`].filter(Boolean).join('\n');
  }
  const cell = (label, value) => {
    const c = h('div', 'qum-models-cell');
    c.append(h('div', 'qum-models-label', label), h('div', 'qum-models-value', value));
    return c;
  };
  const cols = h('div', 'qum-models-cols');
  cols.append(
    cell('今日', cToday === null ? '-' : `${f.fmtCredits(cToday)} cr`),
    cell('近7日', c7 === null ? '-' : `${f.fmtCredits(c7)} cr`),
    cell('Tokens', f.fmtTokens(tokenSum(r))),
    cell('时延/回合', isNum(r.avgTurnSec) ? `${Math.round(r.avgTurnSec)}s/回合` : '-'),
    cell('占比', c7 === null || !isNum(sum) || sum <= 0 ? '-' : `${Math.round(c7 / sum * 100)}%`),
  );
  card.append(cols);
  if (c7 !== null && isNum(max) && max > 0) { // credits7d null → 不画条
    const track = h('div', 'qum-models-track');
    const bar = h('div', 'qum-models-bar');
    bar.style.width = pctStyle(c7 / max);
    bar.style.background = color;
    if (cToday !== null && cToday > 0 && c7 > 0) { // 缺失/0 不画亮段（不按 0 计入）
      const lit = h('span', 'qum-models-lit');
      lit.style.width = pctStyle(cToday / c7); // 相对条宽折算：实际亮段占轨宽 = creditsToday/max（同一 max）
      bar.append(lit);
    }
    track.append(bar);
    card.append(track);
  }
  return card;
}

const models = {
  id: 'models',
  title: '按模型消耗',
  supports: ['full'],
  defaultSize: 'full',
  render(ctx) {
    const f = fmtOf(ctx);
    const box = h('div', 'qum-models');
    const listBox = h('div', 'qum-models-list');
    const repaint = () => {
      const rows = modelsSortedRows(ctx.state);
      if (!rows.length) {
        listBox.replaceChildren(h('div', 'qum-note', '近7日暂无数据')); // 空态：图例照常（旧 daemon 无字段同处理）
        return;
      }
      const max = modelsMaxCredits7d(rows);
      const sum = modelsSumCredits7d(rows);
      listBox.replaceChildren(...rows.map((r, i) => modelsCard(f, ctx.state, r, i, max, sum)));
    };
    const toolbar = h('div', 'qum-models-toolbar');
    toolbar.append(h('span', 'qum-models-sort-label', '排序：'));
    const sel = globalThis.document.createElement('select');
    sel.className = 'qum-models-sort';
    for (const opt of MODEL_WINDOW_SORT_OPTIONS) {
      const o = globalThis.document.createElement('option');
      o.className = 'qum-models-option';
      o.textContent = opt;
      sel.append(o);
    }
    sel.value = modelsSortKey;
    sel.addEventListener('change', () => {
      if (MODEL_WINDOW_SORT_OPTIONS.includes(sel.value)) modelsSortKey = sel.value; // 白名单，乱值不落态
      repaint(); // 就地重排（同一 DOM 树，不重拉数据）
    });
    toolbar.append(sel);
    box.append(toolbar);
    box.append(h('div', 'qum-models-legend', '条=近7日实扣；内嵌亮段=今日；缺失上报显示 -，不按0计入；悬停看名义/免费。'));
    box.append(listBox);
    repaint();
    return box;
  },
};

// ---------------------------------------------------------------- consumption / cache / speed
// T12 credits 校准：真机客户端 token 字段全 0、逐回合 credits 非零 → credits 为本地口径主单位。
//  - consumption half：追加「今日 <fmtCredits> cr」行于 in/out 行之上（in/out 保留，token 为次口径）；
//  - consumption full：5h/周/今日三行各自行尾带「 · <实扣 fmtCredits> cr」；
//  - 窗口 credits 缺席/非法（升级前 state.json）→ fmtCredits → '--'，行不消失、不谎报。
const consumption = {
  id: 'consumption',
  title: 'token 消耗',
  supports: ['half', 'full'],
  defaultSize: 'half',
  slotIds: ['tokens', 'credits'],
  // Strip layout v7（2026-10-26 用户裁定）：tokens 槽仍是「最新一轮计费输入」（credits 口径
  // [≈]billedInput，≈ 仅 source 非 runtime-config；tokens 口径 = 该轮真实总量 input+cacheRead+
  // cacheCreate，无 ≈）；credits 槽改为「会话累计实扣 credits」（active.session.creditsBillable，两位小数
  // 裁尾零）——原生底栏的 credits 是会话级口径，不是末轮。tokens 口径下 credits 不存在 → '-- cr'。
  // 口径按该轮 billingMode（lt.billingMode ?? 全局）。lastTurn 缺 → tokens 槽 '-- tok' 占位
  // （整条空态「暂无回合数据」由 widget.renderStrip 承担），绝不出「≈--」噪声。
  renderMini(ctx) {
    const f = fmtOf(ctx);
    const lt = activeLt(ctx && ctx.state); // P3：读活动会话末轮
    if (ctx && ctx.slot === 'credits') {
      const s = activeSess(ctx && ctx.state);
      const c = creditShown(s);
      const v = s && !activeMode(ctx.state) && isNum(c) ? `${f.fmtNum(c, 2)} cr` : '-- cr';
      const el = h('span', 'qum-mini', v);
      if (isNum(c) && !activeMode(ctx.state)) {
        const tip = creditTip(s, 'credits', f);
        if (tip) el.title = tip;
      }
      return el;
    }
    // tokens 槽：按该轮口径（轮内换过模型跟随该轮）
    if (lt && activeLtTokensMode(ctx.state, lt)) {
      return h('span', 'qum-mini', `${f.fmtNum(realPrompt(lt), 0)} tok`);
    }
    if (!lt || !isNum(lt.billedInput)) return h('span', 'qum-mini', '-- tok');
    const approx = lt.billedSource !== 'runtime-config' ? '≈' : '';
    return h('span', 'qum-mini', `${approx}${f.fmtNum(lt.billedInput, 0)} tok`);
  },
  render(ctx) {
    const f = fmtOf(ctx);
    const st = ctx.state;
    const tk = tokensMode(st);
    const box = h('div', 'qum-consumption');
    const crOf = (key) => {
      const w = win(st, key);
      return f.fmtCredits(creditShown(w));
    };
    const row = (label, key) => {
      const w = win(st, key);
      if (tk) return line(label, ioText(f, w)); // 真实 in/out（BYOK 本地真值），无 cr / 无 ≈ 段
      const io = `${f.fmtK(w && w.input)} in / ${f.fmtK(w && w.output)} out`;
      if (ctx.size !== 'full') return withCreditTip(line(label, io), w, 'credits', f);
      // full 行尾依次：credits（T12 主单位，实扣优先）→ 计费输入 tokens（派生真值，null 省略段）
      const seg = billedSeg(f, w);
      return withCreditTip(line(label, `${io} · ${crOf(key)} cr${seg ? ` · ${seg}` : ''}`), w, 'credits', f);
    };
    if (ctx.size === 'full') {
      box.append(row('5h', 'window5h'), row('周', 'week'), row('今日', 'today'));
    } else if (tk) {
      box.append(row('今日', 'today')); // token 口径：今日 cr 行无意义（BYOK 不消耗 credits）→ 单行
    } else {
      box.append(withCreditTip(line('今日', `${crOf('today')} cr`), win(st, 'today'), 'credits', f),
        row('今日', 'today'));
    }
    return box;
  },
};

const cache = {
  id: 'cache',
  title: '缓存命中',
  supports: ['half', 'full'],
  defaultSize: 'half',
  render(ctx) {
    const f = fmtOf(ctx);
    const st = ctx.state;
    const box = h('div', 'qum-cache');
    const rateOf = (key) => { const w = win(st, key); return w ? w.cacheHitRate : null; };
    const row = (label, key) => {
      const rate = rateOf(key);
      const el = line(label, f.fmtPct(rate)); // cacheHitRate null → '--'
      // 真机本地客户端不落盘缓存字段 → 长期 '--' 会让用户误读为故障。null 行加诚实说明：
      // 值 span 上 title（纯文本/属性，无新 CSS，不动 widget.css）。
      if (!isNum(rate)) el.children[1].setAttribute('title', '客户端未落盘缓存字段');
      return el;
    };
    if (ctx.size === 'full') {
      box.append(row('5h', 'window5h'), row('周', 'week'), row('今日', 'today'));
      // 三窗口全 null（真机实况）才补一行 sub-line 说明——部分有数时不谎称「本地无缓存数据」。
      if (!isNum(rateOf('window5h')) && !isNum(rateOf('week')) && !isNum(rateOf('today'))) {
        box.append(h('div', 'qum-cache-note', '本地无缓存数据'));
      }
    } else {
      box.append(row('今日', 'today')); // half 仅 -- + title，宽度紧不加 note 行
    }
    return box;
  },
};

// speed（T16 口径：最佳 Output ÷ 实测纯模型秒，见 daemon/est.mjs）：面板数据源 state.local.session。
// 本模块经 slotIds:['tps','turnsec'] 提供两个 strip 迷你槽（v5，全读 state.local.lastTurn 最新一轮）
// ——「tps」= 该轮生成速度 outTps「[~]N.N tps」（估算才带 ~；null → '-- tps'，两种计费口径统一）；
// 「turnsec」= 该轮耗时 turnSec「N.N s」。标题「吞吐/时长」（模块仍含回合时长面），id 与注册序不变。
//  - full：「最新一轮 N s」、「平均回合 N s」、「总耗时」、「生成速度 [~]N tps · 近30分钟」
//    （outTps30 = 窗内已配对最佳输出 ÷ 实测秒；null → '-- tps'）、「近30分钟 X cr/min」（仅 credits
//    口径）＋ 一行诚实说明（估算口径 + 无日志兜底）；
//  - half：「均 Ns」紧凑一行；mini（v5）：tps 槽「[~]N.N tps」/「-- tps」、turnsec 槽「N.N s」/「--」。
//    旧 state（无 lastTurn 派生字段）→ '-- tps'，绝不抛。
const speed = {
  id: 'speed',
  title: '吞吐/时长',
  supports: ['half', 'full'],
  // P2 预览裁定：时长三行（最新一轮/平均回合/总耗时，目标 4）只在 full 分支——本模块以 full 进面板。
  // half「均 Ns」保留。
  defaultSize: 'full',
  slotIds: ['turnsec', 'tps'],
  // Strip layout v7（2026-10-26 用户裁定：对齐客户端原生底栏）：tps 槽 = 会话近30分钟生成速度
  // outTps30「⚡ [~]N.N t/s」（真值无 ~；缺失/非数 → 回落末轮 outTps，仍缺失 → '⚡ -- t/s'，
  // 绝不编造 0）；turnsec 槽 = 末轮耗时 turnSec（一位小数，秒为单位绝无 min；null → '--'）。
  renderMini(ctx) {
    const f = fmtOf(ctx);
    const lt = activeLt(ctx && ctx.state); // P3：读活动会话末轮
    if (ctx && ctx.slot === 'turnsec') {
      return h('span', 'qum-mini', isNum(lt && lt.turnSec) ? `${f.fmtNum(lt.turnSec, 1)} s` : '--');
    }
    const s = activeSess(ctx && ctx.state);
    const useSess = s && isNum(s.outTps30);
    const v = useSess ? s.outTps30
      : lt && isNum(lt.outTps) ? lt.outTps : null;
    const exact = useSess ? s.outTps30Exact === true : lt && lt.outTpsExact === true;
    return h('span', 'qum-mini', isNum(v) ? `⚡ ${exact ? '' : '~'}${f.fmtNum(v, 1)} t/s` : '⚡ -- t/s');
  },
  render(ctx) {
    const f = fmtOf(ctx);
    const s = activeSess(ctx.state); // P3：吞吐/时长跟随活动会话
    const tk = activeMode(ctx.state);
    const box = h('div', 'qum-speed');
    const sec = s && isNum(s.avgTurnSec) ? Math.round(s.avgTurnSec) : null;
    if (ctx.size === 'full') {
      // P2 时长集中（修订②）：最新一轮（lastTurn.turnSec round1 一位小数）→ 平均回合 → 总耗时 → 生成速度 →（credits）近30分钟；计费输入行删除
      const lt = activeLt(ctx.state);
      const turnSec = lt && isNum(lt.turnSec) ? lt.turnSec : null;
      box.append(line('最新一轮', turnSec === null ? '--' : `${f.fmtNum(turnSec, 1)} s`));
      box.append(line('平均回合', sec === null ? '--' : `${sec} s`));
      const total = s && isNum(s.totalTurnSec) ? s.totalTurnSec : null;
      box.append(line('总耗时', f.fmtDur(total)));
      if (tk) {
        const t = s && isNum(s.outTps30) ? s.outTps30 : null;
        box.append(line('生成速度', tpsText(f, t, s && s.outTps30Exact === true) + ' · 近30分钟'));
      } else {
        const t = s ? s.outTps30 : null;
        box.append(line('生成速度', tpsText(f, t, s && s.outTps30Exact === true) + ' · 近30分钟'));
        box.append(withCreditTip(
          line('近30分钟', `${f.fmtCredits(creditShown(s, 'rateCpm30'))} cr/min`), s, 'rateCpm30', f));
      }
      box.append(h('div', 'qum-note', '生成速度 = 最佳输出（真值优先，缺失才估算）÷ 实测纯模型秒（~ 为估算；无日志轮按轮时长扣工具时间）'));
    } else {
      box.append(line('均', sec === null ? '--' : `${sec}s`));
    }
    return box;
  },
};

// ---------------------------------------------------------------- pack（P1.5 真仪表，Strip v3 面板专有）/ mascot
// ---------------------------------------------------------------- tools（工具与失败，v7 新增）
// 2026-10-26 用户裁定（对齐客户端原生底栏的「工具/失败/代码变更」信息面）：数据源
// state.local.active.session.tools = {calls, errors, byName:[{name,calls,errors}]}（数据面
// toolStatsOf 产出）+ .edits = {added, removed, files}（仅 Edit/Write 类编辑，scanner 口径）。
// Strip：经 slotIds:['tools'] 提供「工具 N · 失败 M」迷你槽（缺失双 '--'）。
// 面板 full/half：调用/失败/代码变更三行汇总 + 至多 8 行分工具明细（失败 > 0 才追加段），
// 末尾一行诚实注记（代码变更不含终端/脚本改动）。会话/工具缺失 → 各段 '--'，绝不猜数。
const TOOLS_MAX_ROWS = 8;

function toolCountText(f, v) {
  return isNum(v) ? f.fmtNum(v, 0) : '--';
}

const tools = {
  id: 'tools',
  title: '工具与失败',
  supports: ['half', 'full'],
  defaultSize: 'half',
  slotIds: ['tools'],
  renderMini(ctx) {
    const f = fmtOf(ctx);
    const s = activeSess(ctx && ctx.state);
    const t = s && s.tools && typeof s.tools === 'object' && !Array.isArray(s.tools) ? s.tools : null;
    return h('span', 'qum-mini', `工具 ${toolCountText(f, t && t.calls)} · 失败 ${toolCountText(f, t && t.errors)}`);
  },
  render(ctx) {
    const f = fmtOf(ctx);
    const s = activeSess(ctx.state);
    if (!s) return h('div', 'qum-note', '暂无数据');
    const t = s.tools && typeof s.tools === 'object' && !Array.isArray(s.tools) ? s.tools : null;
    const box = h('div', 'qum-tools');
    box.append(line('调用', `${toolCountText(f, t && t.calls)} 次`));
    box.append(line('失败', `${toolCountText(f, t && t.errors)} 次`));
    const e = s.edits && typeof s.edits === 'object' && !Array.isArray(s.edits) ? s.edits : null;
    const edits = e && isNum(e.added) && isNum(e.removed)
      ? `+${f.fmtNum(e.added, 0)} / −${f.fmtNum(e.removed, 0)} · ${isNum(e.files) ? f.fmtNum(e.files, 0) : '--'} 文件`
      : null;
    box.append(line('代码变更', edits === null ? '--' : edits));
    const names = t && Array.isArray(t.byName) ? t.byName : [];
    for (const n of names.slice(0, TOOLS_MAX_ROWS)) {
      if (!n || typeof n !== 'object') continue;
      const name = typeof n.name === 'string' && n.name ? n.name : '--';
      const err = isNum(n.errors) && n.errors > 0 ? ` · ${f.fmtNum(n.errors, 0)} 失败` : '';
      box.append(h('div', 'qum-line', `${name} · ${toolCountText(f, n.calls)} 次${err}`));
    }
    box.append(h('div', 'qum-note', '代码变更仅统计 Edit/Write 类编辑，不含终端/脚本改动；失败 = 工具返回错误'));
    return box;
  },
};

// 资源包即真实模型的"额度"面：addOnQuota{used,total,remaining,percentage,unit:'credits'}。
// Strip layout v7（2026-10-26 用户裁定：对齐客户端原生底栏）：pack 经 slotIds:['quota'] 提供
// 「◔ N%」剩余比例迷你槽（remaining/total → 1-used/total → 1-percentage/100；仅有 packRem 或
// 无账户 → '◔ --'，绝不猜）。面板 render 不变。
// full：.qum-bar fill = used/total（CSS 类合法复用；资源包无重置字段 → 无 pace tick、
// 无倒计时、无徽标——保持事实）+ 一行「已用 750 / 1200 · 剩余 450 cr」（fmtCredits
// 无 k 缩写，与客户端用量页对账）。used/total 不可得 → 降级为仅剩余行、不出 bar。
// half：「剩余 N」（pickPack 候选链原样，含 packRem 优先）。
const pack = {
  id: 'pack',
  title: '资源包',
  supports: ['half', 'full'],
  defaultSize: 'half',
  slotIds: ['quota'],
  renderMini(ctx) {
    const f = fmtOf(ctx);
    const r = quotaRatio(ctx && ctx.state && ctx.state.account);
    return h('span', 'qum-mini', `◔ ${r === null ? '--' : f.fmtPct(r)}`);
  },
  render(ctx) {
    const f = fmtOf(ctx);
    const acct = ctx.state && ctx.state.account;
    const rem = pickPack(acct); // T10 前 account 通常为 null → '--'
    const box = h('div', 'qum-pack');
    const ad = addOnBlock(acct);
    const used = ad && isNum(ad.used) ? ad.used : null;
    const total = ad && isNum(ad.total) ? ad.total : null;
    if (ctx.size === 'full' && used !== null && total !== null && total > 0) {
      const bar = h('div', 'qum-bar');
      const fill = h('div', 'qum-bar-fill');
      const p = f.barPcts(used, total);
      fill.style.width = isNum(p.ratio) ? pctStyle(p.ratio) : '0%';
      bar.append(fill);
      box.append(bar);
      const remain = ad && isNum(ad.remaining) ? ad.remaining : rem;
      box.append(line('已用',
        `${f.fmtCredits(used)} / ${f.fmtCredits(total)} · 剩余 ${isNum(remain) ? f.fmtCredits(remain) : '--'} cr`));
      return box;
    }
    box.append(line('剩余', rem === null ? '--' : f.fmtK(rem)));
    return box;
  },
};

const mascot = {
  id: 'mascot',
  title: '状态',
  supports: ['half', 'full'],
  defaultSize: 'half',
  render(ctx) {
    const st = ctx.state;
    // P1.5 rekey（阈值改读真资源包，假 quota 仪表已删）：无账户数据 → 🫥；
    // addOnQuota used/total 优先、percentage（0–100）兜底算剩余；有账户但读不出 → 🙂 中性。
    const acct = st && st.account;
    const hasAcctData = !!(acct && acct.raw && typeof acct.raw === 'object');
    let remain = null;
    if (hasAcctData) {
      const ad = addOnBlock(acct);
      if (ad) {
        if (isNum(ad.used) && isNum(ad.total) && ad.total > 0) remain = clamp01(1 - ad.used / ad.total);
        else if (isNum(ad.percentage)) remain = clamp01(1 - ad.percentage / 100);
      }
    }
    const face = !hasAcctData ? '🫥'
      : remain === null ? '🙂'
        : remain > 0.5 ? '🙂' : remain >= 0.2 ? '😐' : '😨';
    const box = h('div', 'qum-mascot');
    const big = h('span', 'qum-mascot-face', face);
    big.style.fontSize = ctx.size === 'full' ? '28px' : '20px';
    big.style.marginRight = '6px';
    box.append(big);
    return box;
  },
};

// ---------------------------------------------------------------- T13 账户两新源：累计指标 / 用量热力
// bridge 扩到四源后（widget.accountPoll），daemon 把 getAccountProfileMetrics('app') 与
// getAccountCreditsHeatmap('app') 的响应分别归一为 state.account.metrics / .heatmap。
//  - metrics：客户端 main **已归一**、形状稳定（六字段，允许 null）→ 直读，非法/缺失一律 '--'。
//    非 strip 槽（无 renderMini）。failedSources 非空时加一行诚实说明，不静默吞掉数据源故障。
//  - heatmap：首帧真实形状未知（pickHeatmap 候选链产物 {days:[{date,credits}],source}）→
//    拿不到可用条目就出「暂无数据」一行，绝不画空网格/猜数。full = 每日格子的 CSS grid
//    （≤60 格，底色 alpha 按 credits/窗口内 max 缩放，0 或 null → 空格走轨道色）；
//    half = 一行「近7日 ΣN cr」（null 条目按 0 计入，全 null → --）。无 renderMini。

/** 面板单元格上限：60 天回包也只画最近 60 格（half 面板宽度装得下）。 */
export const HEATMAP_MAX_CELLS = 60;

function accountField(state, key) {
  const a = state && typeof state === 'object' ? state.account : null;
  return a && typeof a === 'object' ? a[key] : null;
}

/** 天数读数：有限数取整，其余 '--'（credits 类走 fmtCredits，天数不走）。 */
function daysText(v) {
  return isNum(v) ? String(Math.round(v)) : '--';
}

const metrics = {
  id: 'metrics',
  title: '累计指标',
  supports: ['half', 'full'],
  defaultSize: 'half',
  render(ctx) {
    const f = fmtOf(ctx);
    const raw = accountField(ctx.state, 'metrics');
    const m = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
    const cr = (v) => `${f.fmtCredits(isNum(v) ? v : null)} cr`;
    const box = h('div', 'qum-metrics');
    box.append(line('总计', cr(m ? m.totalCredits : null)));
    if (ctx.size === 'full') {
      box.append(line('峰值', `${cr(m ? m.peakCredits : null)}/日`));
      box.append(line('连续',
        `${m ? daysText(m.currentStreakDays) : '--'} 天 · 活跃${m ? daysText(m.totalActiveDays) : '--'} 天`));
      const failed = m && Array.isArray(m.failedSources)
        ? m.failedSources.filter((s) => typeof s === 'string') : [];
      if (failed.length) box.append(h('div', 'qum-note', `部分数据源失败：${failed.join(', ')}`));
    }
    return box;
  },
};

/** pickHeatmap 产物 → 可用条目数组（不合形状/空 → null，交由 render 出「暂无数据」）。 */
function heatDays(state) {
  const hm = accountField(state, 'heatmap');
  if (!hm || typeof hm !== 'object' || !Array.isArray(hm.days) || !hm.days.length) return null;
  return hm.days;
}

function heatTitle(d, f) {
  const date = d && typeof d.date === 'string' ? d.date : '--';
  return `${date} · ${f.fmtCredits(d && isNum(d.credits) ? d.credits : null)} cr`;
}

const heatmap = {
  id: 'heatmap',
  title: '用量热力',
  supports: ['half', 'full'],
  defaultSize: 'half',
  render(ctx) {
    const f = fmtOf(ctx);
    const days = heatDays(ctx.state);
    if (!days) return h('div', 'qum-note', '暂无数据'); // 诚实降级：无源/形状不合
    if (ctx.size !== 'full') {
      let sum = null;
      for (const d of days.slice(-7)) if (d && isNum(d.credits)) sum = (sum === null ? 0 : sum) + d.credits;
      const box = h('div', 'qum-heat-sum');
      box.append(line('近7日', `${f.fmtCredits(sum)} cr`));
      return box;
    }
    const cells = days.slice(-HEATMAP_MAX_CELLS); // 尾部 = 最近（pickHeatmap 已按日期升序）
    let max = null;
    for (const d of cells) {
      if (d && isNum(d.credits) && (max === null || d.credits > max)) max = d.credits;
    }
    const scaled = isNum(max) && max > 0; // 全 0/全 null 窗口：整格轨道色，不除零
    const box = h('div', 'qum-heat');
    for (const d of cells) {
      const cell = h('div', 'qum-heat-cell');
      cell.setAttribute('title', heatTitle(d, f));
      const credits = d && isNum(d.credits) ? d.credits : null;
      if (scaled && credits !== null && credits > 0) {
        // alpha 按 credits/max 缩放；非零至少 15% 保证肉眼可见（0/null 留空格）
        const pct = Math.max(15, Math.round(clamp01(credits / max) * 100));
        cell.style.background = `color-mix(in srgb, var(--qum-accent) ${pct}%, transparent)`;
      }
      box.append(cell);
    }
    return box;
  },
};

// ---------------------------------------------------------------- 注册（import 即接线，一次）
setFmt(fmt);
for (const def of [usage, session, sessions, models, consumption, cache, speed, tools, pack, mascot, heatmap, metrics]) {
  registerModule(def);
}
