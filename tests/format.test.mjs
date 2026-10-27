// tests/format.test.mjs
// Task 9 — app/format.js 纯格式化函数（TDD）。双端可 import（node/浏览器），无 DOM、
// 无 locale、确定性输出。边界口径（与 format.js 头部注释一致）：
//   fmtK: ≥1000 → 'x.xk'（一位小数四舍五入，可到 '3912.8k'，无 M 单位）；<1000 → 四舍
//         五入整数字符串；null/undefined/NaN/±Infinity → '--'。
//   fmtPct: 比值(0..1)→一位小数百分数，尾数 '.0' 省略（'86.1%'/'50%'/'100%'）；越界钳到
//         [0,100]；null → '--'。
//   fmtCountdown: 9_060_000 → '2h31m'；<1h → 'Mm'；ms≤0 → '0m'（负值钳位）；非数字 → '--'。
//   fmtTps: 一位小数 + ' tps'（0 → '0.0 tps'）；null → '--'。
//   barPcts: {ratio,remain} 各钳 [0,1] 并舍入 4 位小数；used/total 非有限数或 total≤0
//         → {ratio:null,remain:null}（容错 null）。
//   fmtClock(ts): 绝对时刻 → 'MM/DD HH:MM:SS'（月/日 时:分:秒，本地时区，逐位补零）；
//         非有限数 / ≤0 → '--/-- --:--:--'（首轮扫描前 generatedAt=0）。
//   fmtStamp(ts): 绝对时刻 → 'YYYY-MM-DD HH:MM:SS'（本地）；非有限/≤0 → '--'。
//   fmtCompact(n): 底栏会话簇用万/亿紧凑单位（128000 → '12.8万'；<1e4 → fmtNum 千分位整数）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { fmtK, fmtPct, fmtCountdown, fmtTps, barPcts, fmtCredits, fmtTokens, fmtNum, fmtDur, fmtClock, fmtStamp, fmtCompact } from '../app/format.js';

test('fmtK: k 单位 / 整数字符串 / null 容错', () => {
  assert.equal(fmtK(482130), '482.1k');
  assert.equal(fmtK(260415), '260.4k');
  assert.equal(fmtK(1000), '1.0k');
  assert.equal(fmtK(3912770), '3912.8k');
  assert.equal(fmtK(999), '999');
  assert.equal(fmtK(0), '0');
  assert.equal(fmtK(null), '--');
  assert.equal(fmtK(undefined), '--');
  assert.equal(fmtK(NaN), '--');
});

test('fmtPct: 一位小数、.0 省略、钳位、null → --', () => {
  assert.equal(fmtPct(0.861), '86.1%');
  assert.equal(fmtPct(0.5), '50%');
  assert.equal(fmtPct(1), '100%');
  assert.equal(fmtPct(0), '0%');
  assert.equal(fmtPct(1.4), '100%'); // 钳上界
  assert.equal(fmtPct(-0.3), '0%'); // 钳下界
  assert.equal(fmtPct(null), '--');
  assert.equal(fmtPct(undefined), '--');
});

test('fmtCountdown: 2h31m 形态、分钟退化、负值钳 0m、null → --', () => {
  assert.equal(fmtCountdown(9_060_000), '2h31m');
  assert.equal(fmtCountdown(3_600_000), '1h0m');
  assert.equal(fmtCountdown(90_061_000), '25h1m'); // h 不设上限
  assert.equal(fmtCountdown(120_000), '2m');
  assert.equal(fmtCountdown(59_999), '0m');
  assert.equal(fmtCountdown(0), '0m');
  assert.equal(fmtCountdown(-5_000), '0m'); // 负值钳位
  assert.equal(fmtCountdown(null), '--');
});

test('fmtTps: 一位小数 tps、null → --', () => {
  assert.equal(fmtTps(3.44), '3.4 tps');
  assert.equal(fmtTps(174.8), '174.8 tps');
  assert.equal(fmtTps(0), '0.0 tps');
  assert.equal(fmtTps(null), '--');
  assert.equal(fmtTps(undefined), '--');
});

test('barPcts: ratio/remain 分数 + 钳位 + 容错 null', () => {
  assert.deepEqual(barPcts(1820, 2500), { ratio: 0.728, remain: 0.272 });
  assert.deepEqual(barPcts(0, 100), { ratio: 0, remain: 1 });
  assert.deepEqual(barPcts(3000, 2500), { ratio: 1, remain: 0 }); // used 超 total → 钳满
  assert.deepEqual(barPcts(-10, 100), { ratio: 0, remain: 1 }); // used 负 → 钳 0
  assert.deepEqual(barPcts(null, 2500), { ratio: null, remain: null });
  assert.deepEqual(barPcts(100, null), { ratio: null, remain: null });
  assert.deepEqual(barPcts(100, 0), { ratio: null, remain: null }); // 分母 0
});

// T12 credits 校准：credits 是本地口径主单位（当前客户端 token 字段全 0、逐回合 credits 真实）。
test('fmtCredits: <10 一位小数（尾数 .0 省略，0 → "0"）；≥10 四舍五入整数；null/undefined/NaN → --', () => {
  assert.equal(fmtCredits(null), '--');
  assert.equal(fmtCredits(undefined), '--');
  assert.equal(fmtCredits(NaN), '--');
  assert.equal(fmtCredits(0), '0');
  assert.equal(fmtCredits(0.8), '0.8');
  assert.equal(fmtCredits(0.8022897630), '0.8'); // 真机单回合值
  assert.equal(fmtCredits(6.54), '6.5');
  assert.equal(fmtCredits(9.96), '10'); // 一位小数舍入到 10.0 → 尾数省略
  assert.equal(fmtCredits(12.4), '12');
  assert.equal(fmtCredits(52.6), '53');
  assert.equal(fmtCredits(1234.5), '1235'); // 无 k 单位：credits 直接整数呈现
});

// 计费输入 tokens（ratio×contextWindow 派生真值）呈现：fmtK 风格 + M 档（B 档不需要，200k 窗口
// 的 ratio 上限即 200000/记录，累计到 M 级足够；≥1M 走 'x.xM' 避免 '1234.5k' 长串）。
test('fmtTokens: ≥1M → x.xM；≥1000 → x.xk；<1000 整数字符串；null/undefined/NaN/Infinity → --', () => {
  assert.equal(fmtTokens(1234567), '1.2M');
  assert.equal(fmtTokens(1000000), '1.0M');
  assert.equal(fmtTokens(999999), '1000.0k'); // 阈值分界：k 档上沿（与 fmtK 同规则）
  assert.equal(fmtTokens(45600), '45.6k');
  assert.equal(fmtTokens(1000), '1.0k');
  assert.equal(fmtTokens(820), '820');
  assert.equal(fmtTokens(0), '0');
  assert.equal(fmtTokens(-1500), '-1.5k'); // 负值走 abs 阈值、符号保留（同 fmtK）
  assert.equal(fmtTokens(null), '--');
  assert.equal(fmtTokens(undefined), '--');
  assert.equal(fmtTokens(NaN), '--');
  assert.equal(fmtTokens(Infinity), '--');
});

// ---- P2：底栏千分位与时长 ----
test('P2 fmtNum: 千分位 + 裁尾零（仅 d>0）；负数；非数 → --', () => {
  assert.equal(fmtNum(12847), '12,847');
  assert.equal(fmtNum(48123), '48,123');
  assert.equal(fmtNum(96000), '96,000');
  assert.equal(fmtNum(1234567), '1,234,567');
  assert.equal(fmtNum(1.8, 2), '1.8');
  assert.equal(fmtNum(0.6, 2), '0.6');
  assert.equal(fmtNum(86.0, 1), '86');
  assert.equal(fmtNum(56.5, 1), '56.5');
  assert.equal(fmtNum(100, 0), '100', 'd=0 绝不裁零');
  assert.equal(fmtNum(100, 1), '100', 'd=1 裁尾零后整百仍是 100');
  assert.equal(fmtNum(10.05, 2), '10.05');
  assert.equal(fmtNum(10.5, 2), '10.5');
  assert.equal(fmtNum(-1234), '-1,234');
  assert.equal(fmtNum(-0.5, 1), '-0.5');
  assert.equal(fmtNum(0), '0');
  assert.equal(fmtNum(0, 1), '0');
  assert.equal(fmtNum(NaN), '--');
  assert.equal(fmtNum(null), '--');
  assert.equal(fmtNum(Infinity), '--');
});

test('P2 fmtDur: Ns/Nm/Hh Mm（m=0 只 Nh）；非数 → --', () => {
  assert.equal(fmtDur(45), '45s');
  assert.equal(fmtDur(59), '59s');
  assert.equal(fmtDur(59.6), '1m', 'round 后 60 进 m 档');
  assert.equal(fmtDur(262), '4m');
  assert.equal(fmtDur(7200), '2h');
  assert.equal(fmtDur(7980), '2h 13m');
  assert.equal(fmtDur(null), '--');
  assert.equal(fmtDur('60'), '--');
});

// T17（2026-10-22 用户裁定改版）：底栏「分析」列显示上次分析时刻，格式 MM/DD HH:MM:SS
// （月/日 时:分:秒，本地逐位补零，如 10/22 17:47:02）。旧格式 dd:hh:mm:ss 已废。
// 断言用本地 Date 构造取样（与被测函数同时区），避免测试机时区不同导致假红。
test('T17 fmtClock: 上次分析时刻 → MM/DD HH:MM:SS（本地、逐位补零）；0/非法 → --/-- --:--:--', () => {
  assert.equal(fmtClock(new Date(2026, 9, 15, 14, 32, 5).getTime()), '10/15 14:32:05');
  assert.equal(fmtClock(new Date(2026, 9, 9, 5, 7, 3).getTime()), '10/09 05:07:03', '单位数月/日/时/分/秒逐位补零');
  assert.equal(fmtClock(new Date(2026, 11, 31, 23, 59, 59).getTime()), '12/31 23:59:59');
  assert.equal(fmtClock(new Date(2026, 0, 1, 0, 0, 0).getTime()), '01/01 00:00:00');
  // 首轮扫描前 generatedAt=0、daemon 未起、乱值 → 占位（绝不显示 1970 年的日期）
  assert.equal(fmtClock(0), '--/-- --:--:--');
  assert.equal(fmtClock(-1), '--/-- --:--:--');
  assert.equal(fmtClock(null), '--/-- --:--:--');
  assert.equal(fmtClock(undefined), '--/-- --:--:--');
  assert.equal(fmtClock(NaN), '--/-- --:--:--');
  assert.equal(fmtClock('1791604800000'), '--/-- --:--:--', '字符串不采信');
});

test('T17 fmtStamp: 完整时刻 YYYY-MM-DD HH:MM:SS（本地，title 提示用）；0/非法 → --', () => {
  assert.equal(fmtStamp(new Date(2026, 9, 15, 14, 32, 5).getTime()), '2026-10-15 14:32:05');
  assert.equal(fmtStamp(new Date(2026, 0, 2, 3, 4, 5).getTime()), '2026-01-02 03:04:05');
  assert.equal(fmtStamp(0), '--');
  assert.equal(fmtStamp(null), '--');
  assert.equal(fmtStamp(Infinity), '--');
});

// v7 原生样式（2026-10-26 用户裁定）：底栏会话簇的 token 用万/亿紧凑单位（中文习惯），
// 悬停卡再给精确千分位；<1e4 不缩写（'9,999'），非有限数 → '--'。
test('v7 fmtCompact: 万/亿两位小数裁尾零；<1e4 千分位整数；非数 → --', () => {
  assert.equal(fmtCompact(128000), '12.8万');
  assert.equal(fmtCompact(120000), '12万');
  assert.equal(fmtCompact(482130), '48.21万');
  assert.equal(fmtCompact(10000), '1万');
  assert.equal(fmtCompact(9999), '9,999'); // 万档下沿：不足一万不缩写
  assert.equal(fmtCompact(123456789), '1.23亿');
  assert.equal(fmtCompact(100000000), '1亿');
  assert.equal(fmtCompact(0), '0');
  assert.equal(fmtCompact(-128000), '-12.8万');
  assert.equal(fmtCompact(null), '--');
  assert.equal(fmtCompact(undefined), '--');
  assert.equal(fmtCompact(NaN), '--');
  assert.equal(fmtCompact(Infinity), '--');
});
