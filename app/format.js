// app/format.js
// Qoder Usage Monitor — Task 9 纯格式化函数。node 与浏览器双端可 import：
// 无 DOM、无 window、无 locale（toFixed/String 输出对 `.` 分隔符是确定的），纯函数确定性。
//
// 口径裁定（与 tests/format.test.mjs 一一对账）：
//   fmtK(n)          null/undefined/NaN/±Infinity → '--'；|n|≥1000 → (n/1000).toFixed(1)+'k'
//                    （一位小数四舍五入，允许 '3912.8k' 这类大值，P1 无 M 单位）；
//                    |n|<1000 → Math.round(n) 的整数字符串。
//   fmtTokens(n)     计费输入 tokens 呈现（fmtK 同风格 + M 档）：|n|≥1M → 'x.xM'；
//                    |n|≥1000 → 'x.xk'；否则整数字符串；非有限数 → '--'。
//   fmtPct(r)        比值 0..1 → 一位小数百分数，尾数 '.0' 自然省略（'86.1%'/'50%'/'100%'）；
//                    越界钳到 [0,100]；非有限数 → '--'。
//   fmtCountdown(ms) ms>0 → '2h31m' 形态（h≥1 时 `HhMm`，否则 `Mm`，均向下取整）；
//                    ms≤0（含负值）→ '0m'（钳位）；非有限数 → '--'。
//   fmtTps(v)        一位小数 + ' tps'（0 → '0.0 tps'，列宽稳定）；非有限数 → '--'。
//   fmtCredits(v)    T12 credits 校准（本地口径主单位）：|v|<10 → 一位小数舍入后自然省略尾数
//                    '.0'（0.8022897630 → '0.8'，6.54 → '6.5'，0 → '0'）；|v|≥10 → 四舍五入
//                    整数（12.4 → '12'，无 k 单位——credits 不做千分位缩写）；
//                    null/undefined/NaN/±Infinity → '--'（旧 state 无 credits 字段的诚实降级）。
//   barPcts(u,t)     合法时 {ratio,remain}：used 钳到 [0,total]，各值四舍五入 4 位小数，
//                    ratio+remain 由各自独立舍入（和可能差 0.0001，仅展示用）。
//                    u/t 任一非有限数或 total≤0 → {ratio:null,remain:null}（容错 null）。
//   fmtClock(ts)     绝对时刻（ms）→ 'MM/DD HH:MM:SS'（月/日 时:分:秒，本地时区，逐位补零）；
//                    非有限数/≤0 → '--/-- --:--:--'（底栏「分析」列：上次分析时刻）。
//   fmtStamp(ts)     绝对时刻（ms）→ 'YYYY-MM-DD HH:MM:SS'（本地；tooltip 完整时刻）；
//                    非有限数/≤0 → '--'。
//   fmtCompact(n)    v7 底栏会话簇的中文紧凑单位：|n|≥1e8 → 'x.xx亿'、|n|≥1e4 → 'x.xx万'
//                    （两位小数裁尾零）；<1e4 → fmtNum 千分位整数；非有限数 → '--'。

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

const round4 = (x) => Math.round(x * 1e4) / 1e4;

/** token 数千分位简写：482130 → '482.1k'；999 → '999'；null → '--'。 */
export function fmtK(n) {
  if (!isNum(n)) return '--';
  if (Math.abs(n) >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(Math.round(n));
}

/**
 * 计费输入 tokens（ratio×contextWindow 派生值）呈现：fmtK 风格加 M 档——
 * 1234567 → '1.2M'；45600 → '45.6k'；820 → '820'；null/非有限 → '--'。
 * ≈ 前缀（200k 兜底口径标记）属呈现层职责，由调用方按 billedInputSource 添加。
 */
export function fmtTokens(n) {
  if (!isNum(n)) return '--';
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (Math.abs(n) >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(Math.round(n));
}

/** 比值(0..1) → 百分数一位小数：0.861 → '86.1%'；0.5 → '50%'；null → '--'。 */
export function fmtPct(r) {
  if (!isNum(r)) return '--';
  const clamped = r < 0 ? 0 : r > 1 ? 1 : r;
  return Math.round(clamped * 1000) / 10 + '%';
}

/** 剩余毫秒 → '2h31m'；<1h → 'Mm'；≤0 → '0m'；非数字 → '--'。 */
export function fmtCountdown(ms) {
  if (!isNum(ms)) return '--';
  if (ms <= 0) return '0m';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h${m}m` : `${m}m`;
}

/** tokens/s → '3.4 tps'；null → '--'。 */
export function fmtTps(v) {
  if (!isNum(v)) return '--';
  return v.toFixed(1) + ' tps';
}

/** credits → 主呈现格式：<10 一位小数（尾 .0 省略，0 → '0'）；≥10 四舍五入整数；null → '--'。 */
export function fmtCredits(v) {
  if (!isNum(v)) return '--';
  if (Math.abs(v) >= 10) return String(Math.round(v));
  return String(Math.round(v * 10) / 10);
}

/** 用量/总量 → {ratio, remain}（均钳 [0,1]、4 位小数）；容错：任一入参缺失/非法 → null 对。 */
export function barPcts(used, total) {
  if (!isNum(used) || !isNum(total) || total <= 0) return { ratio: null, remain: null };
  const clamped = used < 0 ? 0 : used > total ? total : used;
  const raw = clamped / total;
  return { ratio: round4(raw), remain: round4(1 - raw) };
}

// 千分位 + 裁尾零（仅底栏数字样式；decimals=0 不裁零，防 '100'→'1'）
export function fmtNum(n, decimals = 0) {
  if (!isNum(n)) return '--';
  const neg = n < 0;
  let s = Math.abs(n).toFixed(decimals);
  if (decimals > 0) s = s.replace(/\.?0+$/, '');
  const [int, frac] = s.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const out = frac ? `${grouped}.${frac}` : grouped;
  return neg ? `-${out}` : out;
}

// 时长（秒）→ 'Ns' / 'Nm' / 'Hh Mm'（m=0 只 'Nh'）
export function fmtDur(sec) {
  if (!isNum(sec)) return '--';
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/**
 * 绝对时刻 → 'MM/DD HH:MM:SS'（月/日 时:分:秒，本地时区，逐位补零）——底栏「分析」列专用：
 * daemon 每次扫描发布 state 时写 meta.generatedAt（= 上次分析时刻），这里如实呈现该时刻。
 * 2026-10-22 用户裁定：由旧 dd:hh:mm:ss 改为带月份的 MM/DD HH:MM:SS（跨日阅读不必猜月份）。
 * 非有限数 / ≤0 → '--/-- --:--:--'（首轮扫描前 generatedAt=0，绝不显示 1970 年的日期）。
 */
export function fmtClock(ts) {
  if (!isNum(ts) || ts <= 0) return '--/-- --:--:--';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 绝对时刻 → 'YYYY-MM-DD HH:MM:SS'（本地，底栏「分析」列 title 提示用）；非有限/≤0 → '--'。 */
export function fmtStamp(ts) {
  if (!isNum(ts) || ts <= 0) return '--';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 两位小数裁尾零（'12.00' → '12'，'12.80' → '12.8'）。 */
const trim2 = (s) => s.replace(/\.?0+$/, '');

/**
 * v7 底栏会话簇的中文紧凑单位（2026-10-26 用户裁定，对齐客户端原生底栏）：
 * 1234567 → '123.46万'；128000 → '12.8万'；100000000 → '1亿'；9999 → '9,999'；null → '--'。
 * 只做展示缩写，值本身不失真（悬停卡给精确千分位）。
 */
export function fmtCompact(n) {
  if (!isNum(n)) return '--';
  const abs = Math.abs(n);
  if (abs >= 1e8) return trim2((n / 1e8).toFixed(2)) + '亿';
  if (abs >= 1e4) return trim2((n / 1e4).toFixed(2)) + '万';
  return fmtNum(n, 0);
}
