// daemon/est.mjs
// Qoder Usage Monitor — 正文估算 Output + 实测纯模型秒（纯函数模块：零 IO，可单测）。
//
// 口径来源（用户裁定，移植自 credits-overlay.py；2026-10-27 对原生显示校准）：
//   est_tokens(s) = CJK 字数 × 1.3 + 其余字符数 ÷ 3.0
//   原式 ÷4（credits-overlay.py:571）在内置模型「usage 全 0、只能估」的轮次上，相对 Qoder 原生
//   状态栏「Out」系统性低约 17~26%（报告两样本：−26.1% / −16.9%）。按两个样本回放取折中：÷3.0 时
//   标定轮 −6.3%（168.7 vs 180 TPS）、验证轮 +6.7%（160 vs 150 TPS）；÷2.8 只贴合单一轮（另一轮 +14%）。
//   样本为 thinking/工具 JSON 密集轮，中文为主的轮次可能反向偏。估算只用于 output_tokens=0 的行；
//   BYOK 185 条真值下，÷3.0 估算本身偏差中位 +11.9%、p10/p90 = −13.9%/+34.7%（现管线直接取真值）。
//   Output = Σ est_tokens(block_text(b))，对每个 assistant 的每个内容块   （:983-995）
//     · block_text：thinking → thinking；text → text；tool_use → JSON.stringify(input)；
//       其余块类型不计。三类拆分（Thk/Txt/Call）按块类型累加，本模块只提供合计与分块入口。
//   为什么逐块累加安全：同一 message.id 的多次写入各带不同块（真机实测 lines-per-message
//   以 2/3 行为主、块形状两两不同），消费侧按 message.id 归并到带 usage 的那一行（server
//   readRecords 两趟合并），绝不重复计账。
//   <synthetic> 伪条目整条跳过（parseJsonlLine 层），不贡献任何估算。
//
// **这是估算，不是 tokenizer**。usage.output_tokens > 0 时不走这里（管线直接采用真值）；
// 只有该字段为 0 的行才估算（真机多数内置行如此，但 dfmodel/BYOK 行常有真值）。旧式 ÷4 对
// BYOK 185 条真值中位 −14%、p10/p90 = −33%/+7%；现式 ÷3.0 中位 +11.9%、p10/p90 = −13.9%/+34.7%。
// 呈现层只在估算值上带 ~（真值不带，见 outExact/outTpsExact）。
// 它只覆盖转录里有的内容：系统提示词/工具定义不在其中（那些属输入侧）；无 usage 行的孤立
// 消息（中断写入/嵌套父链回放，真机占 est ≈4%）不产记录，同样不计。
//
// 速率分母（TPS）：实测纯模型秒 = qodercli.log 的 model.request.started → response.completed
//   按 request_id 成对的区间，窗口/轮内**区间合并**（并发不重复计时）后求和；轮级再夹到该轮
//   墙钟。无日志的轮兜底 = 轮端到端 − 已配对合并的工具区间（tool_use 记录 ts → tool_result
//   记录 ts）。日志缺失的窗口/模型组不做兜底（Rate 口径 = Σ实测模型秒）。

/** CJK 字符的 token 权重 / 非 CJK 字符的每 token 字符数（2026-10-27 校准，见文件头）。 */
const CJK_WEIGHT = 1.3;
const OTHER_CHARS_PER_TOKEN = 3.0;

/** 单串估算 token 数（float；调用方按呈现需要 round）。非字符串/空串 → 0。 */
export function estTokens(s) {
  if (typeof s !== 'string' || !s.length) return 0;
  let cjk = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c >= 0x3400 && c <= 0x4dbf)   // CJK 扩展 A
      || (c >= 0x4e00 && c <= 0x9fff)   // CJK 基本区
      || (c >= 0xf900 && c <= 0xfaff)   // 兼容表意
      || (c >= 0x3000 && c <= 0x303f)   // CJK 标点
      || (c >= 0xff00 && c <= 0xffef)) { // 全角形式
      cjk++;
    }
  }
  return cjk * CJK_WEIGHT + (s.length - cjk) / OTHER_CHARS_PER_TOKEN;
}

/**
 * 内容块 → 参与估算的文本（credits-overlay block_text 同规）：
 * thinking → b.thinking；text → b.text；tool_use → JSON.stringify(b.input)（缺 input 记 '{}'）；
 * 其余块类型 → ''（不贡献）。
 */
export function blockText(b) {
  if (!b || typeof b !== 'object') return '';
  if (b.type === 'thinking') return typeof b.thinking === 'string' ? b.thinking : '';
  if (b.type === 'text') return typeof b.text === 'string' ? b.text : '';
  if (b.type === 'tool_use') {
    try {
      return b.input === undefined ? '{}' : JSON.stringify(b.input);
    } catch {
      return ''; // 循环引用等序列化失败 → 不计（绝不抛）
    }
  }
  return '';
}

/**
 * message.content → 估算 token 三段拆分 {thk, txt, call}（float）：
 * thinking/text/tool_use 各自累加；字符串 content → 全部计入 txt；缺席/乱类型 → 三项 0。
 * 三段合计与 estOutOfContent 逐值一致（同序累加）。原生样式悬停卡「输出（含思考）」用。
 */
export function estBreakdownOfContent(content) {
  const out = { thk: 0, txt: 0, call: 0 };
  if (typeof content === 'string') {
    out.txt = estTokens(content);
    return out;
  }
  if (!Array.isArray(content)) return out;
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'thinking') out.thk += estTokens(blockText(b));
    else if (b.type === 'text') out.txt += estTokens(blockText(b));
    else if (b.type === 'tool_use') out.call += estTokens(blockText(b));
  }
  return out;
}

/**
 * message.content → 估算 token 合计（float）：
 * 字符串 content → estTokens(整串)；数组 → 仅 thinking/text/tool_use 三类块按 blockText 累加；
 * 缺席/乱类型 → 0。绝不抛。合计与 estBreakdownOfContent 三段同源（见上）。
 */
export function estOutOfContent(content) {
  const b = estBreakdownOfContent(content);
  return b.thk + b.txt + b.call;
}

// qodercli.log 计时事件行（真机形态，两事件同构）：
//   2026-10-14T18:46:03.881+08:00 INFO  [session=… turn=… loop=… request=…]
//   model.request.started request_index=1 request_id="08142d99-…" model="qfmodel" …
//   … model.response.completed request_index=1 request_id="08142d99-…" provider=… model=… …
// 前缀 [session=…] 允许缺席（旧格式/其它进程行）——只要有事件名 + request_id 就算数；
// 归并只按 request_id（会话/轮归属由转录侧 usage.request_id + buildTurns 承担，日志侧不参与）。
const TIMING_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}).*?(?:\[session=\S+ turn=\S+ loop=\S+ request=\S+\] )?(model\.request\.started|model\.response\.completed)\s.*?request_id="([^"]+)"/;

/**
 * 一行 qodercli.log → 计时事件 {kind:'start'|'end', ts(ms), rid}；非计时行/坏 ts/缺 request_id → null。
 * 绝不抛。ts 经 Date.parse（ISO8601 带小数秒 + 偏移，V8 原生支持）。
 */
export function parseTimingLine(line) {
  if (typeof line !== 'string') return null;
  const m = TIMING_RE.exec(line);
  if (!m) return null;
  const ts = Date.parse(m[1]);
  if (!Number.isFinite(ts)) return null;
  return { kind: m[2] === 'model.request.started' ? 'start' : 'end', ts, rid: m[3] };
}

/**
 * 区间合并求和（union，毫秒）：可选 [lo, hi] 先夹紧（轮墙钟裁剪）；夹后空/零长区间丢弃；
 * 排序后重叠（含相接）并段求和 → 并发调用不重复计时。无有效区间 → 0。
 */
export function mergeIntervalMs(intervals, lo = -Infinity, hi = Infinity) {
  const xs = [];
  for (const iv of intervals) {
    if (!Array.isArray(iv)) continue;
    const s = Math.max(iv[0], lo);
    const e = Math.min(iv[1], hi);
    if (Number.isFinite(s) && Number.isFinite(e) && e > s) xs.push([s, e]);
  }
  if (!xs.length) return 0;
  xs.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let cs = xs[0][0];
  let ce = xs[0][1];
  for (let i = 1; i < xs.length; i++) {
    const [s, e] = xs[i];
    if (s > ce) { total += ce - cs; cs = s; ce = e; }
    else if (e > ce) ce = e;
  }
  return total + (ce - cs);
}

/** est ÷ 实测秒 → tps（round1）。无可估算输出（est≤0）/ 秒 ≤0 / 非有限 → null（呈现 '--'，
 * 绝不除出 Inf/NaN、绝不出 0 防误读卡死——与 T15 以来的空值纪律一致）。 */
export function rateTps(est, ms) {
  if (!Number.isFinite(est) || est <= 0 || !Number.isFinite(ms) || ms <= 0) return null;
  return Math.round((est / (ms / 1000)) * 10) / 10;
}
