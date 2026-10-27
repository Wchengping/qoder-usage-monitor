// daemon/quotaPick.mjs
// Task 10 — pickQuotaFields：从账户 quota ingest raw（{usage,plan} 桥 body，兼容旧扁平体）
// 防御式解析出结构化字段 {packs, planRem, packRem, nextRefresh}。纯函数：零 IO、零依赖，
// 绝不抛（乱结构 → 对应字段留 null，raw 由 server 侧原样保留）；tests/quotaPick.test.mjs
// 可直接 import，不需要拉起 daemon。
//
// T12 spike 校准（ground truth，tests/quota-sample.json 为真机捕获样本）：
//   usage.qoderUsage.userQuota{total,used,remaining,percentage,unit:"credits"}
//   usage.qoderUsage.addOnQuota{同上}、dedicatedResourcePackages[]、orgResourcePackage、
//   expiresAt（ms；Free 用户为哨兵 253402214400000≈year 9999）。
// 候选链 = 真机 HEAD、credit-watch 旧键（quota_summary/plan_quota/resource_package_quota/
// next_refresh_date）保留为兜底（零成本防御一跳，兼容混合/旧客户端形态）。
//
// packRem 候选链与 app/modules.js pickPack 逐字同规（真机 HEAD → 钉死旧两级）：
//   qoderUsage.addOnQuota.remaining
//   → resource_package_quota.quota_summary.remaining_value → resourcePack.remaining
// nextRefresh 单位归一（T9 审查 (iii)）：数值 < 1e11 视作“秒”→ *1000。
// 该阈值的已知代价：ms 时间戳 < 1e11 等价于 2001-09-09T01:46:40Z 之前——next refresh
// 恒为未来时间，真实数据不可能落在这个区间，误判无虞；秒制（~1.7e9）在 5138 年前都 <1e11。
// expiresAt 额外窗口（T12 裁定）：delta∈(0,90d) 才采信，year-9999 哨兵 → null → 无倒计时
// （诚实降级：spec 的倒计时行按缺席处理，绝不虚增）。now 由第二参注入（缺省 Date.now()），
// 保持可测确定性。

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** number → 自身；其余 → null（boolean/字符串/NaN/Infinity 一律不是数字）。 */
function num(v) {
  return isNum(v) ? v : null;
}

/** 纯对象（非数组非 null）→ 自身；否则 null。所有属性访问都经它过滤。 */
function obj(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
}

/**
 * 候选容器序：body 自身（兼容旧扁平 ingest，如 {planQuota:{used:750}}）→ usage 壳 → plan 壳。
 * bridge body 固定为 {usage:<raw json>, plan:<raw json>}，已知字段绝大多数在 usage 内。
 */
function containers(body) {
  const b = obj(body);
  if (!b) return [];
  const out = [b];
  for (const key of ['usage', 'plan']) {
    const v = obj(b[key]);
    if (v) out.push(v);
  }
  return out;
}

/**
 * 数值毫秒归一：number 走 <1e11→秒 启发式；数字串同路；ISO 串经 Date.parse。
 * 其余（乱值/不可解析串）→ null。
 */
function toMs(v) {
  if (isNum(v)) return Math.abs(v) < 1e11 ? v * 1000 : v;
  if (typeof v === 'string') {
    if (/^-?\d+$/.test(v.trim())) return toMs(Number(v));
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/**
 * 配额块 → 剩余量：quota_summary（或块自身）的 remaining_value|remainingValue|remaining
 * 优先，缺失时用 total_value|totalValue|total|limit 减 used_value|usedValue|used 推导。
 * 仅用于 plan 块与 packs 归一（packRem 不走这里——钉死链独立实现）。
 */
function blockRemain(block) {
  const b = obj(block);
  if (!b) return null;
  const s = obj(b.quota_summary) ?? obj(b.quotaSummary) ?? b;
  const rem = num(s.remaining_value) ?? num(s.remainingValue) ?? num(s.remaining);
  if (rem !== null) return rem;
  const used = num(s.used_value) ?? num(s.usedValue) ?? num(s.used);
  const total = num(s.total_value) ?? num(s.totalValue) ?? num(s.total) ?? num(s.limit);
  if (used !== null && total !== null) return total - used;
  return null;
}

/** 配额块 → {used,remaining,total,expiringSoon} 归一（各值可 null）；全 null 的废块 → null。 */
function normPack(block) {
  const b = obj(block);
  if (!b) return null;
  const s = obj(b.quota_summary) ?? obj(b.quotaSummary) ?? b;
  const used = num(s.used_value) ?? num(s.usedValue) ?? num(s.used);
  const total = num(s.total_value) ?? num(s.totalValue) ?? num(s.total) ?? num(s.limit);
  const remaining = blockRemain(b);
  const expiringSoon = num(b.expiring_soon) ?? num(b.expiringSoon);
  if (used === null && total === null && remaining === null && expiringSoon === null) return null;
  return { used, remaining, total, expiringSoon };
}

/** 真机 T12：各容器（body → usage → plan）里的 qoderUsage 壳，防御式收集。 */
function qoderShells(cs) {
  const out = [];
  for (const c of cs) {
    const qu = obj(c.qoderUsage);
    if (qu) out.push(qu);
  }
  return out;
}

/**
 * 输入 ingest body（{usage,plan} 或扁平对象，可为任意乱值），输出恒为
 * { packs: Array, planRem: number|null, packRem: number|null, nextRefresh: number|null }。
 * now：expiresAt 窗口判定基准（缺省 Date.now()，测试可注入）。
 */
export function pickQuotaFields(raw, now = Date.now()) {
  const result = { packs: [], planRem: null, packRem: null, nextRefresh: null };
  const cs = containers(raw);
  const qus = qoderShells(cs);

  // planRem：T12 真机 HEAD = qoderUsage.userQuota.remaining（used/total 可推导兜底），
  // 其后保留 credit-watch 旧链 plan_quota|planQuota（混合/旧客户端形态兜底）。
  for (const qu of qus) {
    const rem = blockRemain(qu.userQuota);
    if (rem !== null) {
      result.planRem = rem;
      break;
    }
  }
  for (const c of cs) {
    if (result.planRem !== null) break;
    for (const key of ['plan_quota', 'planQuota']) {
      const rem = blockRemain(c[key]);
      if (rem !== null) {
        result.planRem = rem;
        break;
      }
    }
  }

  // packRem：真机 HEAD = qoderUsage.addOnQuota.remaining（T12 spike 实据：
  // doctor --show-quota-raw 捕获，见 tests/quota-sample.json），旧钉死两级链兜底：
  //   resource_package_quota.quota_summary.remaining_value → resourcePack.remaining
  for (const qu of qus) {
    const rem = blockRemain(qu.addOnQuota);
    if (rem !== null) {
      result.packRem = rem;
      break;
    }
  }
  for (const c of cs) {
    if (result.packRem !== null) break;
    const rpq = obj(c.resource_package_quota);
    const qs = rpq && obj(rpq.quota_summary);
    const v1 = qs ? num(qs.remaining_value) : null;
    if (v1 !== null) {
      result.packRem = v1;
      break;
    }
    const rp = obj(c.resourcePack);
    const v2 = rp ? num(rp.remaining) : null;
    if (v2 !== null) {
      result.packRem = v2;
      break;
    }
  }

  // packs：真机 HEAD = dedicatedResourcePackages[] + orgResourcePackage 存在性
  // （P1 表示最小化：packRem 已承载数量语义，此处仅归一收集，不过度工程）。
  // 任一容器出现 dedicatedResourcePackages 数组或 org 包即视为真机形态，旧链不再混入；
  // 完全缺席 → credit-watch 旧链 resource_package_quota 各容器归一收集。
  let dedicatedSeen = false;
  for (const qu of qus) {
    if (Array.isArray(qu.dedicatedResourcePackages)) {
      dedicatedSeen = true;
      for (const p of qu.dedicatedResourcePackages) {
        const n = normPack(p);
        if (n) result.packs.push(n);
      }
    }
    const org = normPack(qu.orgResourcePackage);
    if (org) {
      dedicatedSeen = true;
      result.packs.push(org);
    }
  }
  if (!dedicatedSeen) {
    for (const c of cs) {
      const p = normPack(c.resource_package_quota);
      if (p) result.packs.push(p);
    }
  }

  // nextRefresh：真机 HEAD = qoderUsage.expiresAt，且仅当 delta∈(0,90d)（year-9999 哨兵
  // 落窗外 → 不采信 → 无倒计时）；单位启发同 toMs。旧链 next_refresh_date|nextRefreshDate 兜底。
  for (const qu of qus) {
    const ms = toMs(qu.expiresAt);
    const delta = ms === null ? null : ms - now;
    if (delta !== null && delta > 0 && delta < 90 * 86_400_000) {
      result.nextRefresh = ms;
      break;
    }
  }
  for (const c of cs) {
    if (result.nextRefresh !== null) break;
    for (const key of ['next_refresh_date', 'nextRefreshDate']) {
      const ms = toMs(c[key]);
      if (ms !== null) {
        result.nextRefresh = ms;
        break;
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------- T13: 账户累计指标（pickMetrics）
// ground truth（只读 asar 侦察，trust it）：client main 的 getAccountProfileMetrics(scope)
// 响应已被**归一化**为恰好
//   {totalCredits, peakCredits, currentStreakDays, longestStreakDays, totalActiveDays, failedSources}
// （null 允许；failedSources 是 string[]）。形状稳定 → 不做候选链，直取 + 类型收口：
// 只认有限数字（数字串/布尔不采信——出现非法类型说明上游形状已变，交 doctor 校准），
// failedSources 只保留字符串项。raw 不是对象 → null（无此数据源）；是对象但字段全空 →
// 返回全 null 对象（语义"该源在线但无读数"，与 null 区分，modules 侧据此出 '--'）。

const METRIC_FIELDS = [
  'totalCredits', 'peakCredits', 'currentStreakDays', 'longestStreakDays', 'totalActiveDays',
];

/** 归一 profile metrics；见上注。纯函数，绝不抛。 */
export function pickMetrics(raw) {
  const b = obj(raw);
  if (!b) return null;
  const out = {};
  for (const k of METRIC_FIELDS) out[k] = num(b[k]);
  out.failedSources = Array.isArray(b.failedSources)
    ? b.failedSources.filter((s) => typeof s === 'string')
    : null;
  return out;
}

// ---------------------------------------------------------------- T13: 用量热力（pickHeatmap）
// getAccountCreditsHeatmap(scope) 转发的是服务端 /sash/api/v1/ai-conversations/credits-heatmap
// 原始 JSON（client 近乎透传）——**首帧真实形状未知**（包裹键、条目键、days 常量都待校准）。
// 因此这里是候选链而非直取，命中序 binding：
//   raw.days → raw.items → raw.heatmap → raw.data → raw 自身为数组（source 'self'）
// 候选必须是数组且至少归一出 1 条可用条目（日期或数值有一）才算命中；否则继续下一候选。
// 返回 {days:[{date:YYYY-MM-DD|null, credits:number|null}], source:'候选名'}——source 让
// doctor --show-quota-raw 一眼看出命中了哪个候选（P2 校准入口）。全不中 → null。
//
// 条目键名候选（同样防御）：日期 date|day|date_str|ts|timestamp，数值 credits|total|used|value。
// 日期归一：YYYY-MM-DD 前缀直取（允许带时间后缀）；数值走 <1e11→秒 启发后取 UTC 日历日；
// 数字串同路；其余乱值 → null。全条目都有日期 → 按日期升序（服务端乱序也能对账），否则保序。

const HEAT_ARRAY_KEYS = ['days', 'items', 'heatmap', 'data'];
const HEAT_DATE_KEYS = ['date', 'day', 'date_str', 'ts', 'timestamp'];
const HEAT_CREDIT_KEYS = ['credits', 'total', 'used', 'value'];

/** epoch ms → 'YYYY-MM-DD'（UTC 日历日）；越界/非法日期 → null（Date.toISOString 会抛，故 try 收）。 */
function msToDate(ms) {
  if (!isNum(ms)) return null;
  try {
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

/** 日期候选值 → 'YYYY-MM-DD'|null（串/epoch ms/epoch 秒/数字串/可解析 ISO 都归一）。 */
function toDate(v) {
  if (typeof v === 'string') {
    const s = v.trim();
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    if (/^-?\d+$/.test(s)) return toDate(Number(s));
    const t = Date.parse(s);
    return Number.isFinite(t) ? msToDate(t) : null;
  }
  if (isNum(v)) return msToDate(Math.abs(v) < 1e11 ? v * 1000 : v); // 同 toMs 的单位启发
  return null;
}

/** 单条目 → {date, credits}（各可 null）；日期与数值都拿不到 → null（废条目丢弃）。 */
function heatEntry(e) {
  const o = obj(e);
  if (!o) return null;
  let date = null;
  for (const k of HEAT_DATE_KEYS) {
    const d = toDate(o[k]);
    if (d !== null) { date = d; break; }
  }
  let credits = null;
  for (const k of HEAT_CREDIT_KEYS) {
    const n = num(o[k]);
    if (n !== null) { credits = n; break; }
  }
  if (date === null && credits === null) return null;
  return { date, credits };
}

/** 归一日用 credits 热力；见上注候选序。纯函数，绝不抛。 */
export function pickHeatmap(raw) {
  const candidates = [];
  const b = obj(raw);
  if (b) {
    for (const k of HEAT_ARRAY_KEYS) if (Array.isArray(b[k])) candidates.push([k, b[k]]);
  }
  if (Array.isArray(raw)) candidates.push(['self', raw]);
  for (const [source, arr] of candidates) {
    const days = [];
    for (const e of arr) {
      const n = heatEntry(e);
      if (n) days.push(n);
    }
    if (!days.length) continue; // 空数组/全废条目 → 该候选不算命中
    if (days.every((d) => typeof d.date === 'string')) {
      days.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
    }
    return { days, source };
  }
  return null;
}

// ---------------------------------------------------------------- T14: 模型名解析（用户报告）
// 用户报告：「模型名字显示不正确，当前是自定义的 DeepSeek-Flash，不要显示 qoder-custom-f」。
// ground truth（只读 asar 侦察，client renderer）：一级 preload API
//   window.qoderDesktop.listChatComposerModels({fetchStrategy:'live', workspaceDirectories:[]})
// （IPC chatComposerModelsList）返回模型档案数组，字段含
//   {modelKey, modelDisplayName, typeKey, typeDisplayName, isVision, isReasoning,
//    availableContextWindows, defaultContextWindow, maxInputTokens, byok, outerProvider, efforts, ...}
// BYOK 自定义模型 byok:true，modelDisplayName 是人类名（如 'DeepSeek-Flash'）。session jsonl 的
// `model` 字段取值是 byok 模型 id（uuid 形态，如 '0f0f0f0f-…'）或内建短句柄（如 'qfmodel'）。
// **红线**：绝不读客户端凭据存储（Local Storage leveldb / *.dat / Cookies / sqlite auth 表）——
// 本目录 API 只返回模型目录，安全；调用方须以 typeof fn==='function' 守卫。
//
// resolveModelName(modelId, catalog)：精确 modelKey 命中 → modelDisplayName；否则 catalog 里
// 某条 modelKey 以 `'/'+modelId` 结尾或以 `modelId+'/'` 开头 → 该条 modelDisplayName；
// 否则 null。catalog 接受数组或 {entries:[…]} 对象形态；纯函数、零 IO、绝不抛。
// display policy 属呈现层（app/modules.js）：resolved ?? （短句柄 → 自身） ?? `id:${id.slice(0,8)}`。

/** 取目录条目数组：入参为数组 → 自身；为 {entries:[…]} → entries；其余 → []。 */
function catalogArray(catalog) {
  if (Array.isArray(catalog)) return catalog;
  if (catalog && typeof catalog === 'object' && Array.isArray(catalog.entries)) return catalog.entries;
  return [];
}

/** modelDisplayName 非空串才采信；否则该条不可用于解析。 */
function displayOf(entry) {
  return entry && typeof entry === 'object' && typeof entry.modelDisplayName === 'string' && entry.modelDisplayName
    ? entry.modelDisplayName : null;
}

/** 见上注。纯函数，绝不抛。 */
export function resolveModelName(modelId, catalog) {
  if (typeof modelId !== 'string' || !modelId) return null;
  const entries = catalogArray(catalog);
  for (const e of entries) {
    if (e && typeof e === 'object' && e.modelKey === modelId) {
      const d = displayOf(e);
      if (d !== null) return d;
    }
  }
  for (const e of entries) {
    if (!e || typeof e !== 'object' || typeof e.modelKey !== 'string' || !e.modelKey) continue;
    if (e.modelKey.endsWith('/' + modelId) || e.modelKey.startsWith(modelId + '/')) {
      const d = displayOf(e);
      if (d !== null) return d;
    }
    // 反向斜杠（2026-10-12 真机）：session.model 形如 <profile>/<key>，而目录 key
    // 只有后段（或反之 <key>/<variant> 对目录前段）——两个方向都要求整段边界。
    if (modelId.endsWith('/' + e.modelKey) || modelId.startsWith(e.modelKey + '/')) {
      const d = displayOf(e);
      if (d !== null) return d;
    }
  }
  return null;
}

/**
 * trimModelCatalog(models)：模型目录瘦身（state 体积/JSON 序列化成本控制）。
 * 输入双形态（2026-10-12 真机实测 listChatComposerModels 顶层是 key/displayName/byok 对象；
 * modelKey/modelDisplayName 是 BYOK 配置档案形态，作为兼容回退）：
 *   新 {key, displayName, byok(对象|真)} → 旧 {modelKey, modelDisplayName, ...}
 * 只留 {modelKey, modelDisplayName, typeDisplayName, byok} 四字段输出；非对象/数组条目丢弃；
 * 字符串字段非串 → null；byok 接受严格 true 或对象（composer 条目 byok 是
 * {providerKey,...} 对象，缺省为 undefined）；封顶 300 条。非数组入参 → []。
 * 纯函数，绝不抛。
 */
export function trimModelCatalog(models) {
  const out = [];
  if (!Array.isArray(models)) return out;
  for (const m of models) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) continue;
    const key = typeof m.key === 'string' ? m.key
      : (typeof m.modelKey === 'string' ? m.modelKey : null);
    const display = typeof m.displayName === 'string' ? m.displayName
      : (typeof m.modelDisplayName === 'string' ? m.modelDisplayName : null);
    const type = typeof m.typeDisplayName === 'string' ? m.typeDisplayName
      : (typeof m.type === 'string' ? m.type : null);
    out.push({
      modelKey: key,
      modelDisplayName: display,
      typeDisplayName: type,
      byok: m.byok === true || (m.byok !== null && typeof m.byok === 'object'),
    });
    if (out.length >= 300) break;
  }
  return out;
}
