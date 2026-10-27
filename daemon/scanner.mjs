// daemon/scanner.mjs
// Qoder Usage Monitor — session JSONL 聚合引擎（纯函数模块：不 import fs/网络，可单测，供 daemon 进程内复用）
//
// 数据来源（spec F1）：session JSONL 行
//   {"type":"assistant","uuid":"…","timestamp":"ISO8601","isSidechain":false,
//    "message":{"role":"assistant","usage":{"input_tokens":…,"output_tokens":…,
//      "cache_creation_input_tokens":…,"cache_read_input_tokens":…,"credits":…}}}
// 部分会话 usage 全 0（spec F2）：指标保持 0，不得崩溃/产生 NaN。
//
// T12 credits 校准（真机验收裁定，binding）：当前 Qoder CN 客户端写 usage 时 token 字段全 0、
// 但逐回合 credits 非零（如 0.8022897630）。
// P0 准确性修复（2026-10-26 审计）：usage 同时写 billable——billable:false 的消耗不扣账户
// 资源包（addOnQuota.used 不动），credits 全量求和会虚高。故记录保留 billable，聚合拆
// credits（名义）/ creditsBillable（实扣）/ creditsFree（免费）。呈现层以实扣为主数字，
// 名义与免费仅作附注；billable 字段整体缺失（旧日志）→ 实扣/免费为 null（未知，不补 0）。
// 聚合语义（documented ruling，防过度设计）：credits = Σ 非 null 记录值（null 记 0 贡献，
// 含旧记录无 credits 字段的 undefined），结果 round2（保留 2 位小数：消 float 漂移，
// 如 0.1+0.2 → 0.3 而非 0.30000000000000004）；空窗口/全 null → 0，是诚实累加值，
// 不再另设 creditsKnown 标志。
//
// Session strip（用户裁定：条上 5h/周两槽换「本会 credits + 近30分钟速率」）：记录增补
// sessionId（顶层字符串字段，缺失/非串 → null）。向后兼容：~/.qoder-monitor 的 scan-cache
// 可能持有升级前的旧记录——其 sessionId 为 undefined（字段整个缺席），消费侧（sessionStats）
// 一律按"无会话归属"容忍；mergeDaily/dailyRows/aggregate 不读 sessionId，完全不受影响。

// T16 口径（用户裁定，移植 credits-overlay.py）：**Output 用正文估算，不是 usage 上报**——
// 内置模型 usage.output_tokens 恒 0（真机实测无一非零），生成速度分子改为 est.mjs 的
// est_tokens 估算（thinking/text/tool_use 块，<synthetic> 整条跳过，呈现带 ~）；分母为
// qodercli.log request.started→completed 按 request_id 配对的**实测纯模型秒**（区间合并，
// 并发不重复计时），轮级无日志兜底 = 轮墙钟 − 工具区间。outTps / outTps30 / byModel.outTps
// 三族字段同源换算；window 的 speedTps（P1 历史指标，呈现层已不消费）保留旧口径不动。

import { estBreakdownOfContent, mergeIntervalMs, rateTps } from './est.mjs';

const FIVE_H_MS = 5 * 3600_000;
const THIRTY_MIN_MS = 30 * 60_000; // sessionStats 速率窗口（近 30 分钟）；亦作 avgTurnSec idle 阈值（gap>30min 剔除）
const CLUSTER_GAP_MS = 120_000; // 相邻记录间隔 <120s 归同一 turn 簇

// 计费输入 tokens 的 contextWindow 兜底（official qoder-credits-inspector v2.7.4 约定：
// runtime-config 缺字段/为 null → 200000 估算，呈现层以 ≈ 标注）。
export const FALLBACK_CONTEXT_WINDOW = 200000;

const round2 = (x) => Math.round(x * 100) / 100;

/**
 * Σ credits 三口径后各自**一次性** round2（T12 口径：Σ 值 → round2）。
 * 绝不逐条 round2 累加——55 条量级的回合会漂移 0.06 cr，且 byModel 各行之和与
 * session.credits 对不上（2026-10-26 独立审计实测：877.22/702.49/140.73 vs 877.17/702.35/140.68）。
 *  - credits：名义值（全量，兼容既有消费面）；
 *  - creditsBillable：实扣（billable===true，账户资源包真正扣减的部分）；
 *  - creditsFree：免费（billable===false，不扣账户）。
 * 记录没有任何 billable 布尔字段（旧日志）→ 后两项 null（未知，绝不冒充 0）；
 * 无任何有效 credits → credits null（诚实读数，不补 0）。
 */
function creditFactsOf(recs) {
  let nominal = 0;
  let billable = 0;
  let free = 0;
  let any = false;
  let anyFlag = false;
  for (const r of recs) {
    if (typeof r.credits !== 'number' || !Number.isFinite(r.credits)) continue;
    any = true;
    nominal += r.credits;
    if (r.billable === true) { billable += r.credits; anyFlag = true; }
    else if (r.billable === false) { free += r.credits; anyFlag = true; }
  }
  return {
    credits: any ? round2(nominal) : null,
    creditsBillable: anyFlag ? round2(billable) : null,
    creditsFree: anyFlag ? round2(free) : null,
  };
}

/**
 * 解析一行 JSONL → runtime-config 记录（contextWindow 真值来源）；非该类型 / JSON 非法 → null（绝不抛）。
 * 真机形状：{"type":"runtime-config","sessionId":"…","model":"qfmodel","contextWindow":null,…,
 *            "timestamp":"ISO8601"}——contextWindow 允许为 null（本机 qfmodel 实测），如实保留交由
 * 消费侧兜底；同会话多条时"最新者胜"（按 ts，由 daemon 扫描层裁决）。
 * server readRecords 单次 JSON.parse 后走 runtimeConfigOf（对象形态，语义同）。
 */
export function parseRuntimeConfig(line) {
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  return runtimeConfigOf(o);
}

/** runtimeConfigOf(o)：parseRuntimeConfig 的对象形态（绝不抛；见上注）。 */
export function runtimeConfigOf(o) {
  if (!o || typeof o !== 'object' || o.type !== 'runtime-config') return null;
  const cw = o.contextWindow;
  const contextWindow = typeof cw === 'number' && Number.isFinite(cw) && cw > 0 ? cw : null;
  const t = Date.parse(o.timestamp);
  return {
    contextWindow,
    model: typeof o.model === 'string' ? o.model : null,
    sessionId: typeof o.sessionId === 'string' ? o.sessionId : null,
    ts: Number.isFinite(t) ? t : null, // 坏 ts → null（不整条丢弃；latest-wins 裁决按位序兜底）
  };
}

/**
 * 记录级计费口径（真机数据自证，用户裁定）：内置模型写 credits 且 token 恒 0 → 'credits'；
 * 自定义 BYOK 模型（model 前缀 qoder-custom-<uuid>/）不写 credits，只有真实 token → 'tokens'。
 * 判据只看数据：credits 是有限 ≥0 数字 → 'credits'；否则任一 token 非零 → 'tokens'；否则 null
 * （未知，消费侧回落 'credits' 现状）。两口径不可换算，绝不折算。
 * 同时服务 parseJsonlLine（新记录）与旧 scan-cache 记录（无 billingMode 字段时现推）。
 */
function modeOfRecord(r) {
  if (!r || typeof r !== 'object') return null;
  if (typeof r.credits === 'number' && Number.isFinite(r.credits) && r.credits >= 0) return 'credits';
  if ((r.input || 0) + (r.output || 0) + (r.cacheRead || 0) + (r.cacheCreate || 0) > 0) return 'tokens';
  return null;
}

/** 解析一行 JSONL → 记录；非 assistant / 无 usage / 无有效 timestamp / JSON 非法 → null（绝不抛）。 */
export function parseJsonlLine(line) {
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  return parseJsonObject(o);
}

/**
 * 已解析对象 → 记录（server readRecords 单次 JSON.parse 复用；判定与 parseJsonlLine 逐字一致）。
 * T16 增补两字段：
 *  - outEst：本行正文估算 Output（est.mjs estOutOfContent；thinking/text/tool_use 三类块）。
 *    同一 message 多行写入时这里是**行内块**估算——整消息合计由 server 两趟合并按 message.id
 *    归并到带 usage 的行（scan-cache v3 起记录级持久），故聚合永不重复计账。
 *  - rid：usage.request_id（qodercli.log 计时配对键；缺失/非串 → null）。
 * T16：<synthetic> 伪条目**整条跳过**（credits-overlay 同规，不贡献估算与用量，返回 null）。
 */
export function parseJsonObject(o) {
  if (!o || typeof o !== 'object') return null;
  if (o.type === 'user') {
    const pts = Date.parse(o.timestamp);
    const sid = o.sessionId;
    if (!Number.isFinite(pts) || typeof sid !== 'string' || !sid) return null;
    const content = o.message && o.message.content;
    const isPrompt = typeof content === 'string' ? content.length > 0
      : Array.isArray(content) ? content.length > 0 && !content.some((b) => b && b.type === 'tool_result')
      : false;
    if (!isPrompt) return null;
    return { kind: 'prompt', ts: pts, uuid: typeof o.uuid === 'string' ? o.uuid : '', sessionId: sid };
  }
  if (o.type !== 'assistant') return null;
  const msg = o.message;
  if (msg && typeof msg === 'object' && msg.model === '<synthetic>') return null; // T16 整条跳过
  const u = msg && msg.usage;
  if (!u || typeof u !== 'object') return null;
  const ts = Date.parse(o.timestamp);
  if (!Number.isFinite(ts)) return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  // credits：三态——有限 ≥0 数字保留；缺失/负数/NaN/Infinity/非数字 → null（未知，聚合记 0 贡献）
  const c = u.credits ?? null;
  const credits = typeof c === 'number' && Number.isFinite(c) && c >= 0 ? c : null;
  // billable：三态——布尔保留；缺失/非布尔 → null（未知；聚合不计入实扣/免费）。
  // 真机：同一会话内 billable:false 的行 credits 非零但账户 addOnQuota 不扣减。
  const billable = typeof u.billable === 'boolean' ? u.billable : null;
  // ratio：计费输入真值链的乘数——usage.context_usage_ratio，有限且 0<r≤1 才保留（0 视为无真值）；
  // 缺失/乱值 → null（旧缓存记录字段整个缺席，消费侧按 null 容忍，聚合不贡献）。
  const ru = u.context_usage_ratio ?? null;
  const ratio = typeof ru === 'number' && Number.isFinite(ru) && ru > 0 && ru <= 1 ? ru : null;
  // 原生样式悬停卡：输出三段拆分（thinking/正文/工具调用；行内块，server 按 message.id 归并）
  const est = estBreakdownOfContent(msg && msg.content);
  const rec = {
    ts,
    uuid: typeof o.uuid === 'string' ? o.uuid : '', // uuid 缺失时由调用方补（file:lineIndex）
    sessionId: typeof o.sessionId === 'string' ? o.sessionId : null, // Session strip；旧记录缺失 → null（记录形状向后兼容）
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cacheCreate: num(u.cache_creation_input_tokens),
    credits,
    billable,
    ratio,
    sub: !!o.isSidechain,
    model: msg && typeof msg.model === 'string' && msg.model ? msg.model : null,
    outEst: est.thk + est.txt + est.call, // T16 正文估算（行内块；server 按 message.id 归并整消息）
    outEstThk: est.thk,
    outEstTxt: est.txt,
    outEstCall: est.call,
    rid: typeof u.request_id === 'string' ? u.request_id : null, // T16 日志计时配对键
  };
  rec.billingMode = modeOfRecord(rec); // 'credits' | 'tokens' | null（见 modeOfRecord）
  return rec;
}

/** 同一 uuid 去重（幂等，spec §5.2）；无 uuid 的记录不参与去重。重复项保留入参中最先出现者；调用方去重后再按 ts 排序。 */
function dedupe(records) {
  const seen = new Set();
  const out = [];
  for (const r of records) {
    if (r.uuid) {
      if (seen.has(r.uuid)) continue;
      seen.add(r.uuid);
    }
    out.push(r);
  }
  return out;
}

/**
 * P1 遗留簇速率（speedTps 专用）：按 ts 排序后相邻间隔 <120s 归同簇；单条簇时长取 1s 下限。
 * speedTps = Σ output / Σ max(簇时长秒, 1)（窗口加权平均）；无记录 → 0。
 * T16 注：仅 aggregate 三窗口的 speedTps 仍走此口径（P1 历史指标，呈现层已不消费）；
 * 生成速度三族字段（outTps/outTps30/byModel.outTps）已换「正文估算 ÷ 实测纯模型秒」，见下。
 */
function speedOf(sorted) {
  let outSum = 0;
  let secSum = 0;
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1].ts - sorted[j].ts < CLUSTER_GAP_MS) j++;
    for (let k = i; k <= j; k++) outSum += sorted[k].output;
    secSum += Math.max((sorted[j].ts - sorted[i].ts) / 1000, 1);
    i = j + 1;
  }
  return secSum === 0 ? 0 : outSum / secSum;
}

// ---- T16：正文估算 Output ÷ 实测纯模型秒（est.mjs 口径的记录级装配）----

/** Σ outEst（有限数才计；旧缓存记录缺字段 → 0 贡献，绝不 NaN）。 */
function estSum(arr) {
  let s = 0;
  for (const r of arr) if (typeof r.outEst === 'number' && Number.isFinite(r.outEst)) s += r.outEst;
  return s;
}

/** 记录是否携带 qodercli.log 配对区间 [mt0, mt1]（T16 实测纯模型秒的最小单位）。 */
function isPaired(r) {
  return Number.isFinite(r.mt0) && Number.isFinite(r.mt1);
}

/** 记录携带的 qodercli.log 配对区间 [[mt0, mt1]]（server 逐轮注入；未配对记录不产出）。 */
function intervalsOf(arr) {
  const out = [];
  for (const r of arr) if (isPaired(r)) out.push([r.mt0, r.mt1]);
  return out;
}

/**
 * T16 记录集生成速度（窗口/模型组通用）：**仅已配对记录参与**——分子（正文估算）与分母
 * （实测纯模型秒，区间合并防并发重复）取同一记录集，速率不被"有输出没日志"的记录抬高；
 * 无任何配对记录 → null（'-- tps'，窗口/模型组不兜底：Rate = Σ实测模型秒）。
 */
function pairedRate(arr) {
  const paired = arr.filter(isPaired);
  if (!paired.length) return null;
  return rateTps(estSum(paired), mergeIntervalMs(intervalsOf(paired)));
}

// 编辑类工具（代码变更行数只在它们的入参里可重建；Bash 驱动的改文件无法还原 → 不计）。
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

/**
 * 工具调用统计（原生样式底栏/悬停卡数据源，纯函数）：toolEvents 为 server readRecords 产出的
 * [{sid, ts, name, err, add, del, file}]（tool_use 按 tool id 去重，tool_result.is_error → err）。
 * 返回 {calls, errors, byName:[{name,calls,errors}], edits:{added,removed,files}|null}：
 *  - 只统计 sid === sessionId 的事件（缺 sid/乱值/其他会话 → 不计，绝不串味）；
 *  - byName 按 calls 降序、name 升序；缺 name → '(unknown)'；
 *  - edits 只聚合 Edit/Write/MultiEdit 的 add/del 行数与文件并集；无编辑类工具 → null
 *    （呈现 '--'，绝不补 +0/−0）。
 * 无事件/缺会话 id → 空形状（calls 0 / edits null）。
 */
export function toolStatsOf(toolEvents, sessionId) {
  const empty = { calls: 0, errors: 0, byName: [], edits: null };
  if (typeof sessionId !== 'string' || !sessionId || !Array.isArray(toolEvents)) return empty;
  const by = new Map();
  let calls = 0;
  let errors = 0;
  let added = 0;
  let removed = 0;
  let hasEdit = false;
  const files = new Set();
  for (const ev of toolEvents) {
    if (!ev || typeof ev !== 'object' || ev.sid !== sessionId) continue;
    const name = typeof ev.name === 'string' && ev.name ? ev.name : '(unknown)';
    const isErr = ev.err === true;
    calls++;
    if (isErr) errors++;
    const row = by.get(name) || { name, calls: 0, errors: 0 };
    row.calls++;
    if (isErr) row.errors++;
    by.set(name, row);
    if (EDIT_TOOLS.has(name)) {
      hasEdit = true;
      if (typeof ev.add === 'number' && Number.isFinite(ev.add) && ev.add > 0) added += ev.add;
      if (typeof ev.del === 'number' && Number.isFinite(ev.del) && ev.del > 0) removed += ev.del;
      if (typeof ev.file === 'string' && ev.file) files.add(ev.file);
    }
  }
  const byName = [...by.values()].sort((a, b) => (b.calls - a.calls) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { calls, errors, byName, edits: hasEdit ? { added, removed, files: files.size } : null };
}

/**
 * 轮内兜底工具区间（ms）：toolSpans（server 从转录配对：assistant tool_use 记录 ts →
 * 匹配的 user tool_result 记录 ts）取本会话、夹到轮窗口 [lo, hi] 后合并求和。
 * 入参缺/乱 → 0（= 兜底退化为纯轮墙钟，绝不抛）。
 */
function toolSecMs(toolSpans, sessionId, lo, hi) {
  if (!Array.isArray(toolSpans)) return 0;
  const ivs = [];
  for (const s of toolSpans) {
    if (s && s.sid === sessionId && Number.isFinite(s.start) && Number.isFinite(s.end)) {
      ivs.push([s.start, s.end]);
    }
  }
  return mergeIntervalMs(ivs, lo, hi);
}

/** AgentAgg：对已按 ts 排序的记录做聚合；cacheHitRate 分母 0 → null；credits 三口径（名义/实扣/免费，round2）。 */
function aggOf(sorted) {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheCreate = 0;
  for (const r of sorted) {
    input += r.input;
    output += r.output;
    cacheRead += r.cacheRead;
    cacheCreate += r.cacheCreate;
  }
  const denom = cacheRead + input + cacheCreate;
  const cf = creditFactsOf(sorted);
  return {
    input,
    output,
    cacheRead,
    cacheCreate,
    turns: sorted.length,
    speedTps: speedOf(sorted),
    cacheHitRate: denom === 0 ? null : cacheRead / denom,
    // 窗口/按天契约沿用旧消费面：无 credits 记录 → 0（聚合读数），不补 null。
    credits: cf.credits === null ? 0 : cf.credits,
    creditsBillable: cf.creditsBillable,
    creditsFree: cf.creditsFree,
  };
}

/**
 * 会话元数据读取（contextWindow + model）——统一 ctxMap 的两种入参形态，向后兼容：
 *   · 旧形态 Map<sessionId, number|null>（既有测试/旧调用面，值为 contextWindow 裸数）；
 *   · 新形态 Map<sessionId, {contextWindow, model}>（daemon scan 层 ctxMeta，model 源于 runtime-config）。
 * 缺 map/缺项/值非法 → {contextWindow:null, model:null}（消费侧走 200k 兜底 / model 出 '--'）。
 * 旧缓存 windows 条目无 model 字段 → model null（迁移容忍），绝不抛。
 */
function ctxEntry(ctxMap, id) {
  const none = { contextWindow: null, model: null };
  if (!ctxMap || typeof ctxMap.get !== 'function' || id == null) return none;
  const v = ctxMap.get(id);
  if (typeof v === 'number') {
    return Number.isFinite(v) && v > 0 ? { contextWindow: v, model: null } : none;
  }
  if (v && typeof v === 'object') {
    const cw = v.contextWindow;
    const contextWindow = typeof cw === 'number' && Number.isFinite(cw) && cw > 0 ? cw : null;
    const model = typeof v.model === 'string' && v.model ? v.model : null;
    return { contextWindow, model };
  }
  return none;
}

/**
 * 计费输入 tokens（inspector "计费输入总量" 真值公式）：Σ ratio × contextWindow（仅 ratio>0 记录贡献）。
 * contextWindow 按记录 sessionId 经 ctxEntry 查表（兼容 Map<sid,数> 与 Map<sid,{contextWindow,model}>），
 * 缺 map/缺项/值为 null → FALLBACK_CONTEXT_WINDOW 兜底。返回 {billedInput(round 整数|null),
 * billedInputSource ('runtime-config'|'fallback200k'|'mixed'|null)}；null source = 无一条 ratio 记录
 * （与 0 区分）。旧缓存记录无 ratio 字段（undefined）→ 自然不贡献，迁移安全。
 */
function billedOf(records, ctxWindows) {
  let sum = 0;
  let runtime = false;
  let fallback = false;
  let any = false;
  for (const r of records) {
    const ratio = r.ratio;
    if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio <= 0 || ratio > 1) continue;
    const w = ctxEntry(ctxWindows, r.sessionId).contextWindow;
    if (typeof w === 'number' && Number.isFinite(w) && w > 0) {
      runtime = true;
      sum += ratio * w;
    } else {
      fallback = true;
      sum += ratio * FALLBACK_CONTEXT_WINDOW;
    }
    any = true;
  }
  if (!any) return { billedInput: null, billedInputSource: null };
  const billedInputSource = runtime && fallback ? 'mixed' : runtime ? 'runtime-config' : 'fallback200k';
  return { billedInput: Math.round(sum), billedInputSource };
}

/**
 * 窗口聚合：过滤 [start, end)，产出窗口对象（AgentAgg 字段 + resetAt/paceRatio/byAgent
 * + billedInput/billedInputSource）。
 * paceRatio = 数据新鲜度：(lastRecordTs − windowStart) / windowDuration，空窗口为 0（controller 裁定，
 * 非时间进度；账户 5h 配额真实进度属 Task 10 账户数据）。
 * ctxWindows（可选）：Map<sessionId, contextWindowOrNull>，缺省 → 计费输入一律 200k 兜底 +
 * 'fallback200k' 标注（呈现层加 ≈）。byAgent 子聚合不含 billedInput（消费侧只读窗口级）。
 */
function windowOf(sorted, start, end, resetAt, ctxWindows) {
  const inWin = sorted.filter((r) => r.ts >= start && r.ts < end);
  const agg = aggOf(inWin);
  agg.resetAt = resetAt;
  const duration = end - start;
  agg.paceRatio =
    inWin.length === 0 || duration <= 0 ? 0 : (inWin[inWin.length - 1].ts - start) / duration;
  agg.byAgent = {
    main: aggOf(inWin.filter((r) => !r.sub)),
    sub: aggOf(inWin.filter((r) => r.sub)),
  };
  const billed = billedOf(inWin, ctxWindows);
  agg.billedInput = billed.billedInput;
  agg.billedInputSource = billed.billedInputSource;
  return agg;
}

/** 本地当日 00:00（毫秒）。 */
function startOfLocalDay(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 从某天 00:00 起按本地日历偏移 days 天（DST 安全：走 Date 日期运算而非固定毫秒数）。 */
function shiftLocalDay(dayStartMs, days) {
  const d = new Date(dayStartMs);
  d.setDate(d.getDate() + days);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 本地时区周一 00:00（毫秒）。JS getDay(): 0=周日…6=周六 → 周一偏移 (day+6)%7。 */
function startOfLocalWeek(now) {
  const dayStart = startOfLocalDay(now);
  const diffToMonday = (new Date(dayStart).getDay() + 6) % 7;
  return shiftLocalDay(dayStart, -diffToMonday);
}

/**
 * 三窗口聚合：window5h=[now−5h,now)（resetAt=窗口端点 now）；
 * week=[本地周一 00:00, now)（resetAt=下周一 00:00 本地）；today=[本地 00:00, now)（resetAt=次日 00:00 本地）。
 * records 需为 parseJsonlLine 产出的对象数组，顺序不限。
 * ctxWindows（可选第三参）：Map<sessionId, contextWindowOrNull>（runtime-config 真值表），
 * 缺席/缺项 → 计费输入按 200k 兜底并标 'fallback200k'。
 */
export function aggregate(records, now, ctxWindows) {
  const all = dedupe([...records]).sort((a, b) => a.ts - b.ts);
  const sorted = all.filter((r) => r.kind !== 'prompt'); // P2：prompt 记录不参与窗口聚合（缺 token 字段 → NaN 防线）
  const weekStart = startOfLocalWeek(now);
  const dayStart = startOfLocalDay(now);
  return {
    window5h: windowOf(sorted, now - FIVE_H_MS, now, now, ctxWindows),
    week: windowOf(sorted, weekStart, now, shiftLocalDay(weekStart, 7), ctxWindows),
    today: windowOf(sorted, dayStart, now, shiftLocalDay(dayStart, 1), ctxWindows),
  };
}

/**
 * 按天历史行：{date, ...AgentAgg, main:AgentAgg, sub:AgentAgg}，按日期升序。
 * tz 为 IANA 时区名（如 'Asia/Shanghai'），缺省用系统本地时区。
 */
export function dailyRows(records, tz) {
  const all = dedupe([...records]).sort((a, b) => a.ts - b.ts);
  const sorted = all.filter((r) => r.kind !== 'prompt'); // P2：prompt 记录不参与按天聚合
  const fmt = new Intl.DateTimeFormat(
    'en-CA',
    tz ? { dateStyle: 'short', timeZone: tz } : { dateStyle: 'short' },
  );
  const days = new Map();
  for (const r of sorted) {
    const date = fmt.format(new Date(r.ts)); // en-CA short → 'YYYY-MM-DD'
    if (!days.has(date)) days.set(date, []);
    days.get(date).push(r);
  }
  return [...days.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, recs]) => {
      const agg = aggOf(recs);
      agg.date = date;
      agg.main = aggOf(recs.filter((r) => !r.sub));
      agg.sub = aggOf(recs.filter((r) => r.sub));
      return agg;
    });
}

/**
 * 当前会话统计（Session strip 数据源，纯函数）：records 为 parseJsonlLine 产物（顺序不限，
 * 同 uuid 去重与 aggregate 同规）。返回 {id, credits, turns, rateCpm30, billedInput, avgTurnSec,
 * model, tps30}：
 *  - id：max ts 记录的 sessionId（多会话取"最近活跃"）。无 sessionId 的记录（null，含旧缓存
 *    记录的 undefined）不参与 id 选择——向后跳过，取带 id 的最新记录所在会话；
 *  - 全池都拿不到 id → 等同空输入：{id:null, credits:null, turns:0, rateCpm30:null,
 *    billedInput:null, avgTurnSec:null, model:null, tps30:null}
 *    （不知道"本会话"是谁时绝不猜数，呈现层出 '--'）；
 *  - credits：Σ 该会话记录的非 null credits（null/undefined 记 0 贡献，round2，同 aggregate 语义）；
 *  - turns：该会话记录条数（parseJsonlLine 只产 assistant 记录，条数即回合数）；
 *  - rateCpm30：Σ 该会话 ts > now−30min（严格排他：恰 30 分钟整不计）的 credits / 30，round2；
 *    会话存在但窗内无消耗 → 0（诚实读数，与 null"未知"区分）；
 *  - billedInput：同 aggregate 公式（ratio×contextWindow，ctxWindows 表兜底 200k），仅计本会话
 *    ratio>0 记录；无 → null（旧缓存记录无 ratio 字段 → 迁移安全，绝不 NaN）；
 *  - avgTurnSec：本会话相邻 assistant 记录间隔均值（秒，round 整数）；gap >30min 剔为 idle
 *    （恰 30min 保留）；合格 gap <2 → null（样本不足以称"平均"）。
 *  - model：ctxWindows（Map<sid,{contextWindow,model}> 或旧 Map<sid,数>）里本会话的 model，
 *    非空字符串保留，否则 null（旧缓存无 model 字段 → null，呈现层出 '--'）；
 *  - tps30：输入吞吐（tok/s，用户裁定）——Σ 本会话 ts > now−30min 的 (ratio×contextWindow) / 1800，
 *    round 1 位小数；窗内无 ratio 记录 → null（与 0 区分）。**非生成速度**：真机 output token
 *    恒 0 无本地真值，此为计费输入速率（inspector 口径），呈现层须如实标注。
 * 速率 rateCpm30 仍是 credits/min（T12 校准主单位）——与 tps30 并存（币种不同，皆本地真值）。
 * 计费口径（用户裁定，见 modeOfRecord）另发三个字段：
 *  - billingMode：本会话口径（'credits'|'tokens'|null，取最新一条可判定记录；中途换模型跟随最新）；
 *  - input/output/cacheRead/cacheCreate：本会话真实 token 合计（内置模型恒 0，BYOK 才有值）；
 *  - tps30Tokens：真实 token 输入吞吐 Σ(input+cacheRead+cacheCreate 窗内)/1800 round1；
 *    窗内无记录 → null，有记录但 token 全零 → 0。tokens 口径呈现须用它而非 tps30（估算）。
 *  - outTps30：生成速度（tok/s，用户裁定 T16 口径）——近30分钟窗内
 *    **正文估算 Output ÷ 实测纯模型秒**（分子 est.mjs est_tokens；分母 qodercli.log
 *    request 配对区间合并秒，round1）。窗口级不做工具时间兜底（Rate = Σ实测模型秒）；
 *    无可估算输出或无实测秒 → null（呈现 '-- tps'，不出 0 防误读）。
 *  - outEst：本会话正文估算 Output 合计（整数，呈现带 ~）。内置模型 usage.output_tokens
 *    恒 0 时它就是唯一可见的输出口径；只覆盖转录正文（系统提示词/工具定义属输入侧）。
 *  - 原生样式数据面（2026-10-26，第 5 参 toolEvents 为 server readRecords 的 [{sid,ts,name,err,add,del,file}]）：
 *    rounds（buildTurns 轮数）、requests（request_id 去重；缺 rid 各行计 1）、
 *    cacheHitRate（cacheRead/(input+cacheRead+cacheCreate)；分母 0 → null）、
 *    firstTs/lastTs（本会话 usage 时间范围）、outEstThk/Txt/Call（三段估算，各自取整）、
 *    tools {calls,errors,byName} 与 edits {added,removed,files}|null（见 toolStatsOf）。
 *    toolEvents 缺省 → 空工具形状（旧调用面/测试兼容）。
 */
// P3 T2：主体自 sessionStats 抽出（字段语义逐字不变）；sessionStats = 求全局锚定 sid 后转调本函数。
// sid 无效 / 该会话无 usage 记录 → null（区别于 sessionStats 的 empty 形状：请求态要能表达
// 「这个会话确实没数据」，呈现层据此出 '--'，绝不回落全局值）。
export function sessionStatsFor(records, now, ctxWindows, sessionId, toolEvents) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  const all = dedupe([...records]).sort((a, b) => a.ts - b.ts);
  const sorted = all.filter((r) => r.kind !== 'prompt'); // P2：prompt 记录不参与统计口径
  const mine = sorted.filter((r) => r.sessionId === sessionId);
  if (mine.length === 0) return null;
  const rateStart = now - THIRTY_MIN_MS;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheCreate = 0;
  let winTokens = 0;
  let requests = 0;        // 请求数：request_id 去重；缺 rid 的记录各计 1（诚实计数）
  let estThk = 0;
  let estTxt = 0;
  let estCall = 0;
  const rids = new Set();
  const inWindow = [];
  for (const r of mine) {
    input += r.input;
    output += r.output;
    cacheRead += r.cacheRead;
    cacheCreate += r.cacheCreate;
    if (r.rid) {
      if (!rids.has(r.rid)) { rids.add(r.rid); requests++; }
    } else requests++;
    if (typeof r.outEstThk === 'number' && Number.isFinite(r.outEstThk)) estThk += r.outEstThk;
    if (typeof r.outEstTxt === 'number' && Number.isFinite(r.outEstTxt)) estTxt += r.outEstTxt;
    if (typeof r.outEstCall === 'number' && Number.isFinite(r.outEstCall)) estCall += r.outEstCall;
    if (r.ts > rateStart) {
      inWindow.push(r);
      winTokens += r.input + r.cacheRead + r.cacheCreate; // 真实计费输入总量（含缓存读写）
    }
  }
  const cf = creditFactsOf(mine);
  const cfRecent = creditFactsOf(inWindow); // 窗内可能全无 credits → null，速率按 0 处理（保持既有语义）
  // 口径跟随"最新一条能判出口径的记录"（会话中途换模型 → 用当前模型的口径）；
  // 旧缓存记录无 billingMode 字段 → modeOfRecord 现推。全会话推不出 → null（消费侧回落 credits）。
  let billingMode = null;
  for (let i = mine.length - 1; i >= 0 && billingMode === null; i--) {
    billingMode = mine[i].billingMode ?? modeOfRecord(mine[i]);
  }
  const gaps = [];
  for (let i = 1; i < mine.length; i++) {
    const gap = mine[i].ts - mine[i - 1].ts;
    if (gap <= THIRTY_MIN_MS) gaps.push(gap); // >30min 剔为 idle（非回合时长）
  }
  const avgTurnSec = gaps.length < 2 ? null : Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length / 1000);
  const billedWin = billedOf(inWindow, ctxWindows).billedInput;
  // T16 生成速度：分子 = 窗内**已配对**记录的正文估算 Output（est.mjs；message.id 归并口径）；
  // 分母 = 同一记录集的日志配对区间**合并**秒（并发调用不重复计时）。分子分母同集，
  // 无实测秒 / 无可估算输出 → null（'-- tps'，与 0 区分，不出 0 防误读）。
  const outTps30 = pairedRate(inWindow);
  const turns = buildTurns(all.filter((r) => r.sessionId === sessionId)); // 轮构建用含 prompt 的 all
  // P3 #64：null 轮（全空闲测不出）不计入总耗时；一个都没有 → null（呈现 '--'）。
  const timed = turns.filter((t) => typeof t.turnSec === 'number');
  const totalTurnSec = timed.length === 0 ? null : Math.round(timed.reduce((a, t) => a + t.turnSec, 0));
  const byModel = byModelOf(mine, turns, ctxWindows);
  // 工具/编辑统计（原生样式数据面）：toolEvents 缺省 → 空形状（旧调用面兼容）。
  const tools = toolStatsOf(toolEvents, sessionId);
  const cacheDenom = cacheRead + input + cacheCreate;
  return {
    id: sessionId,
    // 会话级契约（沿用旧消费面）：会话存在但全无 credits（BYOK）→ 0，不是 null。
    // creditsBillable/Free 仍按「有无 billable 标注」诚实给 null（未知 ≠ 0）。
    credits: cf.credits === null ? 0 : cf.credits,
    creditsBillable: cf.creditsBillable,
    creditsFree: cf.creditsFree,
    turns: mine.length,
    rateCpm30: round2((cfRecent.credits ?? 0) / 30),
    rateCpm30Billable: cfRecent.creditsBillable === null ? null : round2(cfRecent.creditsBillable / 30),
    billedInput: billedOf(mine, ctxWindows).billedInput,
    avgTurnSec,
    model: ctxEntry(ctxWindows, sessionId).model,
    tps30: billedWin === null ? null : Math.round((billedWin / 1800) * 10) / 10,
    billingMode,
    input,
    output,
    outEst: Math.round(estSum(mine)), // T16 本会话正文估算 Output 合计（整数；呈现带 ~）
    outEstThk: Math.round(estThk),    // 原生样式：思考段估算（整数）
    outEstTxt: Math.round(estTxt),    // 原生样式：正文段估算（整数）
    outEstCall: Math.round(estCall),  // 原生样式：工具调用入参段估算（整数）
    cacheRead,
    cacheCreate,
    // 真实 token 输入吞吐（tokens 口径呈现用）：窗内无记录 → null；有记录但 token 全零 → 0。
    tps30Tokens: inWindow.length === 0 ? null : Math.round((winTokens / 1800) * 10) / 10,
    outTps30,
    byModel,
    totalTurnSec,
    // ---- 原生样式（2026-10-26）：底栏会话簇 + 悬停摘要卡 ----
    rounds: turns.length,                                  // 轮数（真实轮段；turns 仍是 usage 行数，兼容旧消费面）
    requests,                                              // 请求数（rid 去重；缺 rid 各行计 1）
    cacheHitRate: cacheDenom === 0 ? null : cacheRead / cacheDenom, // 真实缓存命中率；无缓存 token → null（隐藏，不补 0%）
    firstTs: mine[0].ts,
    lastTs: mine[mine.length - 1].ts,
    tools: { calls: tools.calls, errors: tools.errors, byName: tools.byName },
    edits: tools.edits,
  };
}

export function sessionStats(records, now, ctxWindows, toolEvents) {
  const empty = { id: null, credits: null, creditsBillable: null, creditsFree: null, turns: 0, rateCpm30: null, rateCpm30Billable: null, billedInput: null, avgTurnSec: null, model: null, tps30: null, billingMode: null, input: 0, output: 0, outEst: null, cacheRead: 0, cacheCreate: 0, tps30Tokens: null, outTps30: null, byModel: [], totalTurnSec: null, rounds: 0, requests: 0, cacheHitRate: null, firstTs: null, lastTs: null, outEstThk: 0, outEstTxt: 0, outEstCall: 0, tools: { calls: 0, errors: 0, byName: [] }, edits: null };
  const all = dedupe([...records]).sort((a, b) => a.ts - b.ts);
  const sorted = all.filter((r) => r.kind !== 'prompt'); // P2：prompt 记录不参与统计口径
  let id = null;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const sid = sorted[i].sessionId;
    if (typeof sid === 'string' && sid) { id = sid; break; }
  }
  if (id === null) return empty;
  // P3：主体已抽 sessionStatsFor；锚定 sid 必然有其 usage，null 分支只作防御（回落既有 empty 形状）。
  return sessionStatsFor(records, now, ctxWindows, id, toolEvents) ?? empty;
}

// ---- P2：轮段构建（prompt 开段，到下一 prompt 前含尾）----
// P3 #64：turnSec = **活动跨度**——按事件序列（prompt → 各 usage 记录）累加 ≤THIRTY_MIN_MS 的
// 相邻间隔，>30min 的空闲段整段剔除（真机实况：客户端重启/跨夜续跑会把 14.8 小时空闲并进一轮，
// 原「末条 − 起点」会把空闲算成耗时）。idle 阈值与 sessionStats.avgTurnSec 同源，不另立规则。
// 一段都不剩（prompt 与唯一记录之间即空闲）→ null：测不出就呈现 '--'，绝不编 0 或整段跨度。
export function buildTurns(sessionRecords) {
  const all = dedupe([...sessionRecords]).sort((a, b) => a.ts - b.ts);
  const turns = [];
  let cur = null;
  const activeSpan = (t) => {
    let sum = 0;
    let prev = t.promptTs;
    for (const r of t.records) {
      const gap = r.ts - prev;
      prev = r.ts;
      if (gap >= 0 && gap <= THIRTY_MIN_MS) sum += gap;
    }
    return sum;
  };
  const flush = () => {
    if (!cur) return;
    if (cur.records.length > 0) {
      const endTs = cur.records[cur.records.length - 1].ts;
      const span = activeSpan(cur);
      turns.push({
        promptTs: cur.promptTs, endTs,
        turnSec: span === 0 ? null : Math.round(span / 100) / 10, // round1（亚秒级仍可为 0.x）
        records: cur.records,
      });
    }
    cur = null;
  };
  for (const r of all) {
    if (r.kind === 'prompt') { flush(); cur = { promptTs: r.ts, records: [] }; }
    else if (cur) cur.records.push(r);
  }
  flush();
  return turns;
}

// ---- P3 T1：按指定会话取末轮（「跟随当前会话」数据源；字段与 lastTurnOf 完全同形）----
// sid 无效 / 该会话无轮 → null（对应呈现层空态「暂无回合数据」，绝不补近似值）。
// T16 第 4 参 toolSpans（可选，server 从转录配对的 [{sid,start,end}]）：轮级兜底分母用。
export function lastTurnOfSession(records, ctxMeta, sessionId, toolSpans) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  const all = dedupe([...records]).sort((a, b) => a.ts - b.ts);
  const turns = buildTurns(all.filter((r) => r.sessionId === sessionId)); // 轮构建用含 prompt 的 all
  if (turns.length === 0) return null;
  const t = turns[turns.length - 1];
  const cf = creditFactsOf(t.records);
  let input = 0; let output = 0; let cacheRead = 0; let cacheCreate = 0;
  for (const r of t.records) {
    input += r.input || 0; output += r.output || 0;
    cacheRead += r.cacheRead || 0; cacheCreate += r.cacheCreate || 0;
  }
  let billingMode = null;
  for (let i = t.records.length - 1; i >= 0; i--) {
    const m = t.records[i].billingMode ?? modeOfRecord(t.records[i]);
    if (m) { billingMode = m; break; }
  }
  const billed = billedOf(t.records, ctxMeta);
  // T16 轮级生成速度 = 本轮正文估算 Output ÷ 本轮纯模型秒：
  //   首选（实测）：轮内已配对记录（分子分母同集）区间合并并夹到轮墙钟 [promptTs, endTs]——
  //   同轮多请求/并发不重复计时；
  //   兜底（无可用日志的轮）：轮端到端 − 已配对合并的工具区间（toolSpans 未传 → 纯墙钟），
  //   分子取轮内全部记录估算；
  //   分母或分子为 0 → null（'-- tps'，绝不除 0、不出 0 防误读）。
  const paired = t.records.filter(isPaired);
  const pairedMs = mergeIntervalMs(intervalsOf(paired), t.promptTs, t.endTs);
  const usePaired = pairedMs > 0;
  const secMs = usePaired
    ? pairedMs
    : Math.max(0, (t.endTs - t.promptTs) - toolSecMs(toolSpans, sessionId, t.promptTs, t.endTs));
  const outTps = rateTps(estSum(usePaired ? paired : t.records), secMs);
  const last = t.records[t.records.length - 1];
  return {
    sessionId, promptTs: t.promptTs, endTs: t.endTs, turnSec: t.turnSec,
    model: typeof last.model === 'string' && last.model ? last.model : null,
    modelName: null,
    billingMode,
    credits: cf.credits,
    creditsBillable: cf.creditsBillable,
    creditsFree: cf.creditsFree,
    input, output, cacheRead, cacheCreate,
    billedInput: billed.billedInput, billedSource: billed.billedInputSource,
    outTps,
  };
}

// ---- P2：最新一轮（会话锚点与 sessionStats 同规：过滤后集合 max-ts 有效 sessionId）----
// P3 起 = 求锚点 sid 后转调 lastTurnOfSession（签名与行为逐值不变，既有存量断言即护栏）。
// T16：第 3 参 toolSpans（可选）透传给 lastTurnOfSession（轮级兜底分母）。
export function lastTurnOf(records, ctxMeta, toolSpans) {
  const all = dedupe([...records]).sort((a, b) => a.ts - b.ts);
  const usage = all.filter((r) => r.kind !== 'prompt'); // spec §3.2：锚点按过滤后集合
  let sessionId = null;
  for (let i = usage.length - 1; i >= 0; i--) {
    const sid = usage[i].sessionId;
    if (typeof sid === 'string' && sid) { sessionId = sid; break; }
  }
  if (sessionId === null) return null;
  return lastTurnOfSession(records, ctxMeta, sessionId, toolSpans);
}

// ---- P2：会话内按模型聚合（轮参与 = 模型键 Set 去重）----
export function byModelOf(usageRecs, turns, ctxMeta) {
  const mine = dedupe([...usageRecs]).sort((a, b) => a.ts - b.ts);
  const groups = new Map();
  for (const r of mine) {
    const key = typeof r.model === 'string' && r.model ? r.model : null;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const participated = new Map();
  for (const t of turns) {
    const models = new Set(t.records.map((r) => (typeof r.model === 'string' && r.model ? r.model : null)));
    for (const key of models) {
      if (!participated.has(key)) participated.set(key, { turns: 0, sum: 0, timed: 0 });
      // P3 #64：turns 仍是参与轮数（含无计时轮）；sum/avg 只吃有计时的轮，避免 null 污染成 NaN。
      const p = participated.get(key); p.turns += 1;
      if (typeof t.turnSec === 'number') { p.timed += 1; p.sum += t.turnSec; }
    }
  }
  const rows = [];
  for (const [key, g] of groups) {
    let billingMode = null;
    for (let i = g.length - 1; i >= 0; i--) {
      const m = g[i].billingMode ?? modeOfRecord(g[i]);
      if (m) { billingMode = m; break; }
    }
    const cf = creditFactsOf(g);
    const billed = billedOf(g, ctxMeta);
    // T16 模型组生成速度 = 该组已配对记录的「正文估算 Output ÷ 实测纯模型秒」（区间合并，
    // 并发不重复计时；无配对记录 → null，'-- tps'）。旧 speedOf(output>0 簇) 口径退役。
    const speed = pairedRate(g);
    const p = participated.get(key);
    rows.push({
      model: key, modelName: null, billingMode, credits: cf.credits,
      creditsBillable: cf.creditsBillable, creditsFree: cf.creditsFree,
      input: g.reduce((a, r) => a + (r.input || 0), 0),
      output: g.reduce((a, r) => a + (r.output || 0), 0),
      cacheRead: g.reduce((a, r) => a + (r.cacheRead || 0), 0),
      cacheCreate: g.reduce((a, r) => a + (r.cacheCreate || 0), 0),
      billedInput: billed.billedInput, billedSource: billed.billedInputSource,
      turns: p ? p.turns : 0,
      outTps: speed,
      avgTurnSec: p && p.timed > 0 ? Math.round(p.sum / p.timed) : null,
    });
  }
  rows.sort((a, b) => {
    const ac = a.credits == null ? -Infinity : a.credits;
    const bc = b.credits == null ? -Infinity : b.credits;
    if (ac !== bc) return bc - ac;
    if (a.turns !== b.turns) return b.turns - a.turns;
    const am = a.model == null ? '\uffff' : a.model;
    const bm = b.model == null ? '\uffff' : b.model;
    return am < bm ? -1 : am > bm ? 1 : 0;
  });
  return rows;
}

// ---- P2：近 7 日/今日窗口按模型聚合 ----
export function byModelWindowOf(all, ctxMeta, now) {
  const todayStart = startOfLocalDay(now);
  const windowStart = shiftLocalDay(todayStart, -6);
  const recs = dedupe([...all]).sort((a, b) => a.ts - b.ts);
  const inWindow = recs.filter((r) => r.kind !== 'prompt' && r.ts >= windowStart);
  if (inWindow.length === 0) return { windowStart, todayStart, rows: [] };
  const groups = new Map();
  for (const r of inWindow) {
    const key = typeof r.model === 'string' && r.model ? r.model : null;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const usageById = new Map();
  const promptsById = new Map();
  for (const r of recs) {
    const map = r.kind === 'prompt' ? promptsById : usageById;
    if (!map.has(r.sessionId)) map.set(r.sessionId, []);
    map.get(r.sessionId).push(r);
  }
  const participated = new Map();
  for (const [id, srecs] of usageById) {
    if (!srecs.some((r) => r.ts >= windowStart)) continue;
    const sr = [...srecs, ...(promptsById.get(id) || [])];
    for (const t of buildTurns(sr)) {
      if (t.endTs < windowStart) continue;
      const models = new Set(t.records.map((r) => (typeof r.model === 'string' && r.model ? r.model : null)));
      for (const key of models) {
        if (!participated.has(key)) participated.set(key, { turns: 0, sum: 0, timed: 0 });
        // P3 #64：与 byModelOf 同规——turns 是参与轮数，sum/avg 只吃有计时的轮（null 不污染）。
        const p = participated.get(key); p.turns += 1;
        if (typeof t.turnSec === 'number') { p.timed += 1; p.sum += t.turnSec; }
      }
    }
  }
  const creditsOf = (arr) => creditFactsOf(arr);
  const keys = new Set([...groups.keys(), ...participated.keys()]);
  const rows = [];
  for (const key of keys) {
    const g = groups.get(key) || [];
    let billingMode = null;
    for (let i = g.length - 1; i >= 0; i--) {
      const m = g[i].billingMode ?? modeOfRecord(g[i]);
      if (m) { billingMode = m; break; }
    }
    const billed = billedOf(g, ctxMeta);
    // T16 模型组生成速度 = 该组已配对记录的「正文估算 Output ÷ 实测纯模型秒」（区间合并，
    // 并发不重复计时；无配对记录 → null，'-- tps'）。旧 speedOf(output>0 簇) 口径退役。
    const speed = pairedRate(g);
    const p = participated.get(key);
    const cfToday = creditsOf(g.filter((r) => r.ts >= todayStart));
    const cf7d = creditsOf(g);
    rows.push({
      model: key, modelName: null, billingMode,
      creditsToday: cfToday.credits, credits7d: cf7d.credits,
      creditsTodayBillable: cfToday.creditsBillable, credits7dBillable: cf7d.creditsBillable,
      creditsTodayFree: cfToday.creditsFree, credits7dFree: cf7d.creditsFree,
      input: g.reduce((a, r) => a + (r.input || 0), 0),
      output: g.reduce((a, r) => a + (r.output || 0), 0),
      cacheRead: g.reduce((a, r) => a + (r.cacheRead || 0), 0),
      cacheCreate: g.reduce((a, r) => a + (r.cacheCreate || 0), 0),
      billedInput: billed.billedInput, billedSource: billed.billedInputSource,
      turns: p ? p.turns : 0,
      outTps: speed,
      avgTurnSec: p && p.timed > 0 ? Math.round(p.sum / p.timed) : null,
    });
  }
  rows.sort((a, b) => {
    const ac = a.credits7d == null ? -Infinity : a.credits7d;
    const bc = b.credits7d == null ? -Infinity : b.credits7d;
    if (ac !== bc) return bc - ac;
    const am = a.model == null ? '\uffff' : a.model;
    const bm = b.model == null ? '\uffff' : b.model;
    return am < bm ? -1 : am > bm ? 1 : 0;
  });
  return { windowStart, todayStart, rows };
}

/**
 * 每会话用量明细（会话明细 panel 数据源，纯函数，用户裁定）：按 sessionId 分组（仅顶层 sessionId
 * 为非空字符串的记录成组；无 id 记录无法归属会话 → 跳过），对每组产出
 * {id, model, credits(round2), billedInput(整数|null), billedSource, turns, lastTs, avgTurnSec}：
 *  - credits/model/billedInput/avgTurnSec 口径与 sessionStats 完全一致（复用 billedOf/ctxEntry）；
 *  - billedSource = billedInputSource（'runtime-config'|'fallback200k'|'mixed'|null，呈现层据
 *    fallback/mixed 决定 ≈ 前缀）；
 *  - turns = 组内去重后记录数，lastTs = 组内 max ts；
 *  - billingMode + input/output/cacheRead/cacheCreate：该行自身的计费口径与真实 token 合计
 *    （口径判定与 sessionStats 同规；tokens 口径的会话明细行须显示 tok 而非 cr，见 modules）。
 *  - 排序：lastTs 降序（最近活跃在前），取前 10（面板半格可容）。
 * ctxMeta：Map<sessionId,{contextWindow,model}>（daemon scan 层产物；亦容忍旧 Map<sid,数> 形态）。
 * now 暂未参与过滤（全扫描范围），保留入参以与 sessionStats 同形。绝不抛。
 */
export function sessionsSummary(records, now, ctxMeta) { // eslint-disable-line no-unused-vars
  const all = dedupe([...records]).sort((a, b) => a.ts - b.ts);
  const promptsById = new Map();
  for (const r of all) {
    if (r.kind !== 'prompt') continue;
    if (!promptsById.has(r.sessionId)) promptsById.set(r.sessionId, []);
    promptsById.get(r.sessionId).push(r);
  }
  const sorted = all.filter((r) => r.kind !== 'prompt');
  const byId = new Map();
  for (const r of sorted) {
    const sid = r.sessionId;
    if (typeof sid !== 'string' || !sid) continue; // 无会话归属的记录不成组
    if (!byId.has(sid)) byId.set(sid, []);
    byId.get(sid).push(r);
  }
  const rows = [];
  for (const [id, recs] of byId) {
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheCreate = 0;
    let requests = 0;
    const rids = new Set();
    for (const r of recs) {
      input += r.input;
      output += r.output;
      cacheRead += r.cacheRead;
      cacheCreate += r.cacheCreate;
      if (r.rid) {
        if (!rids.has(r.rid)) { rids.add(r.rid); requests++; }
      } else requests++;
    }
    const cf = creditFactsOf(recs);
    // 行口径 = 该会话最新一条能判出口径的记录（与 sessionStats 同规；recs 已按 ts 升序）。
    let billingMode = null;
    for (let i = recs.length - 1; i >= 0 && billingMode === null; i--) {
      billingMode = recs[i].billingMode ?? modeOfRecord(recs[i]);
    }
    const gaps = [];
    for (let i = 1; i < recs.length; i++) {
      const gap = recs[i].ts - recs[i - 1].ts;
      if (gap <= THIRTY_MIN_MS) gaps.push(gap);
    }
    const avgTurnSec = gaps.length < 2 ? null : Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length / 1000);
    const billed = billedOf(recs, ctxMeta);
    const turns = buildTurns([...recs, ...(promptsById.get(id) || [])]); // 轮构建用含 prompt 的集合
    const byModel = byModelOf(recs, turns, ctxMeta);
    rows.push({
      id,
      model: ctxEntry(ctxMeta, id).model,
      // 同 sessionStats：会话存在但全无 credits → 0；billable 未知 → null。
      credits: cf.credits === null ? 0 : cf.credits,
      creditsBillable: cf.creditsBillable,
      creditsFree: cf.creditsFree,
      billedInput: billed.billedInput,
      billedSource: billed.billedInputSource,
      turns: recs.length,
      rounds: turns.length,
      requests,
      lastTs: recs[recs.length - 1].ts,
      avgTurnSec,
      billingMode,
      input,
      output,
      cacheRead,
      cacheCreate,
      byModel,
    });
  }
  rows.sort((a, b) => b.lastTs - a.lastTs);
  return rows.slice(0, 10);
}
