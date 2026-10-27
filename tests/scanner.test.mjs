// tests/scanner.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonlLine, parseRuntimeConfig, aggregate, dailyRows, sessionStats, sessionStatsFor, sessionsSummary, buildTurns, lastTurnOf, lastTurnOfSession, byModelOf, byModelWindowOf, toolStatsOf } from '../daemon/scanner.mjs';

const H = 3600_000;
const line = (ts, u, sub = false, uuid = 'x' + ts) => JSON.stringify({
  type: 'assistant', uuid, timestamp: new Date(ts).toISOString(),
  isSidechain: sub, message: { role: 'assistant', usage: u },
});

test('parseJsonlLine picks usage records only', () => {
  const now = Date.now();
  assert.equal(parseJsonlLine(''), null);
  assert.equal(parseJsonlLine('not json {'), null);
  assert.equal(parseJsonlLine(JSON.stringify({ type: 'user', uuid: 'a', timestamp: '2026-10-10T00:00:00Z' })), null);
  assert.equal(parseJsonlLine(JSON.stringify({ type: 'assistant', uuid: 'b', timestamp: '2026-10-10T00:00:00Z' })), null); // no usage
  assert.equal(parseJsonlLine(JSON.stringify({ type: 'assistant', uuid: 'c', timestamp: 'garbage', message: { usage: {} } })), null); // bad ts
  const r = parseJsonlLine(line(now, { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 10 }));
  assert.deepEqual({ input: r.input, output: r.output, cacheRead: r.cacheRead, cacheCreate: r.cacheCreate, sub: r.sub },
    { input: 100, output: 5, cacheRead: 1000, cacheCreate: 10, sub: false });
  assert.equal(r.ts, now);
  assert.equal(r.uuid, 'x' + now);
  // all-zero usage still parses (spec F2: must not crash / be dropped)
  const z = parseJsonlLine(line(now, {}));
  assert.deepEqual({ input: z.input, output: z.output, cacheRead: z.cacheRead, cacheCreate: z.cacheCreate },
    { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });
});

// ---- T1：user prompt 行识别（轮起点记录池）----
const userLine = (ts, content, extra = {}) => JSON.stringify({
  type: 'user', uuid: extra.uuid || `u${ts}`, sessionId: extra.sessionId || 'S-u',
  timestamp: new Date(ts).toISOString(), message: { role: 'user', content },
});

test('T1 parseJsonlLine: user 行判定表——tool_result/空/非串非数组 → null；string 非空 / 含非 tool_result 数组 → prompt', () => {
  const T0 = new Date(2026, 9, 10, 12, 0, 0).getTime();
  // 轮起点：纯文本 string
  assert.deepEqual(parseJsonlLine(userLine(T0, 'hello'), 0), { kind: 'prompt', ts: T0, uuid: 'u' + T0, sessionId: 'S-u' });
  // 轮起点：数组含非 tool_result 块
  assert.deepEqual(parseJsonlLine(userLine(T0, [{ type: 'text', text: 'hi' }]), 0), { kind: 'prompt', ts: T0, uuid: 'u' + T0, sessionId: 'S-u' });
  // 非轮起点：数组全 tool_result
  assert.equal(parseJsonlLine(userLine(T0, [{ type: 'tool_result', content: 'x' }]), 0), null);
  // 非轮起点：空数组 / 空串
  assert.equal(parseJsonlLine(userLine(T0, []), 0), null);
  assert.equal(parseJsonlLine(userLine(T0, ''), 0), null);
  // 非轮起点：非 string 非数组（对象/数字）
  assert.equal(parseJsonlLine(userLine(T0, { foo: 1 }), 0), null);
  assert.equal(parseJsonlLine(userLine(T0, 42), 0), null);
  // ts 非法或 sessionId 缺失 → null（与既有 unknown 行同纪律）
  assert.equal(parseJsonlLine(JSON.stringify({ type: 'user', uuid: 'x', sessionId: 'S', message: { content: 'hi' } }), 0), null);
  assert.equal(parseJsonlLine(JSON.stringify({ type: 'user', uuid: 'x', timestamp: new Date(T0).toISOString(), message: { content: 'hi' } }), 0), null);
  // 既有 L16 兼容：user 无 message 行仍 null
  assert.equal(parseJsonlLine(JSON.stringify({ type: 'user', uuid: 'x', sessionId: 'S', timestamp: new Date(T0).toISOString() }), 1), null);
});

test('T1 parseJsonlLine: assistant rec 携带 message.model（非空 string 才收，否则 null）', () => {
  const T0 = new Date(2026, 9, 10, 12, 0, 0).getTime();
  const asst = (model) => JSON.stringify({
    type: 'assistant', uuid: 'a1', sessionId: 'S', timestamp: new Date(T0).toISOString(),
    message: { role: 'assistant', model, usage: { input_tokens: 10, output_tokens: 1 } },
  });
  assert.equal(parseJsonlLine(asst('qfmodel'), 0).model, 'qfmodel');
  assert.equal(parseJsonlLine(asst(''), 0).model, null, '空串 → null');
  assert.equal(parseJsonlLine(asst(undefined), 0).model, null, '缺 model → null');
  assert.equal(parseJsonlLine(asst(42), 0).model, null, '非 string → null');
});

test('window5h filters and computes', () => {
  const now = Date.UTC(2026, 9, 10, 12, 0, 0);
  const recs = [
    { ts: now - 4 * H, uuid: 'a', input: 1000, output: 100, cacheRead: 9000, cacheCreate: 0, sub: false },
    { ts: now - 6 * H, uuid: 'b', input: 7000, output: 700, cacheRead: 0, cacheCreate: 0, sub: false }, // 窗外
    { ts: now - 2 * H, uuid: 'c', input: 500, output: 50, cacheRead: 4500, cacheCreate: 0, sub: true },
  ];
  const a = aggregate(recs, now);
  assert.equal(a.window5h.input, 1500);
  assert.equal(a.window5h.output, 150);
  // 修正：brief 片段写 9000/(9000+1500) 是漏算了 sub 记录的 cacheRead 4500；
  // 按接口定义 formula cacheRead/(cacheRead+input+cacheCreate) 应为 (9000+4500)/(13500+1500)
  assert.equal(a.window5h.cacheHitRate, 13500 / (13500 + 1500));
  assert.equal(a.window5h.turns, 2);
  assert.equal(a.window5h.byAgent.main.input, 1000);
  assert.equal(a.window5h.byAgent.sub.output, 50);
  // Controller ruling: paceRatio = 数据新鲜度 = (lastRecordTs - windowStart)/windowDuration
  // lastTs = now-2h, start = now-5h → 3h/5h = 0.6（覆盖 brief Step-1 的区间断言）
  assert.equal(a.window5h.paceRatio, 0.6);
  // 5h 窗口 resetAt = 窗口端点 now
  assert.equal(a.window5h.resetAt, now);
});

test('aggregate dedupes by uuid (idempotent)', () => {
  const now = Date.UTC(2026, 9, 10, 12, 0, 0);
  const rec = { ts: now - H, uuid: 'dup', input: 100, output: 10, cacheRead: 0, cacheCreate: 0, sub: false };
  const a = aggregate([rec, { ...rec }], now);
  assert.equal(a.window5h.turns, 1);
  assert.equal(a.window5h.input, 100);
});

test('empty window: turns 0, paceRatio 0, cacheHitRate null, no div-by-zero', () => {
  const now = Date.UTC(2026, 9, 10, 12, 0, 0);
  const a = aggregate([], now);
  for (const w of [a.window5h, a.week, a.today]) {
    assert.equal(w.turns, 0);
    assert.equal(w.input, 0);
    assert.equal(w.output, 0);
    assert.equal(w.speedTps, 0);
    assert.equal(w.paceRatio, 0);
    assert.equal(w.cacheHitRate, null);
    assert.equal(w.byAgent.main.cacheHitRate, null);
    assert.equal(w.byAgent.sub.turns, 0);
  }
});

test('all-zero usage: metrics stay 0, cacheHitRate null', () => {
  const now = Date.UTC(2026, 9, 10, 12, 0, 0);
  const recs = [{ ts: now - H, uuid: 'z', input: 0, output: 0, cacheRead: 0, cacheCreate: 0, sub: false }];
  const a = aggregate(recs, now);
  assert.equal(a.window5h.turns, 1);
  assert.equal(a.window5h.speedTps, 0); // 0 output / cluster seconds → 0, no NaN
  assert.equal(a.window5h.cacheHitRate, null); // denom 0
  assert.equal(a.window5h.paceRatio, 4 / 5); // (now-1h - (now-5h))/5h
});

test('speed clusters by 120s gap', () => {
  // 用 runner 本地正午作为 now（同 resetAt 测试的构造方式）：所有分钟级记录在任何时区都落在本地 today 窗口内，
  // 避免固定偏移写法（如 12:00+08:00）在别的 TZ 恰好命中本地午夜导致窗口为空
  const now = new Date(2026, 9, 10, 12, 0, 0).getTime();
  const t = (minAgo) => now - minAgo * 60_000;
  const recs = [
    { ts: t(10), uuid: '1', input: 0, output: 100, cacheRead: 0, cacheCreate: 0, sub: false },
    { ts: t(9), uuid: '2', input: 0, output: 100, cacheRead: 0, cacheCreate: 0, sub: false }, // 同簇，时长60s
    { ts: t(5), uuid: '3', input: 0, output: 60, cacheRead: 0, cacheCreate: 0, sub: false }, // 新簇单条→1s
  ];
  const a = aggregate(recs, now + 1000); // 使全部落 5h/today 内
  // 簇1: 200 tok/60s=3.333, 簇2: 60/1=60 → 加权 260/61
  assert.ok(Math.abs(a.today.speedTps - 260 / 61) < 1e-9);
});

test('week/today resetAt: next Monday 00:00 / next 00:00, local tz', () => {
  const now = new Date(2026, 9, 10, 12, 0, 0).getTime(); // 本地周六
  const a = aggregate([], now);
  assert.equal(a.today.resetAt, new Date(2026, 9, 11, 0, 0, 0).getTime());
  assert.equal(a.week.resetAt, new Date(2026, 9, 12, 0, 0, 0).getTime()); // 下周一
});

test('dailyRows groups by local date', () => {
  const recs = [
    { ts: new Date('2026-10-09T23:59:00+08:00').getTime(), uuid: '1', input: 10, output: 1, cacheRead: 0, cacheCreate: 0, sub: false },
    { ts: new Date('2026-10-10T00:01:00+08:00').getTime(), uuid: '2', input: 20, output: 2, cacheRead: 5, cacheCreate: 0, sub: true },
  ];
  const rows = dailyRows(recs, 'Asia/Shanghai');
  assert.equal(rows.length, 2);
  const r9 = rows.find(r => r.date === '2026-10-09');
  const r10 = rows.find(r => r.date === '2026-10-10');
  assert.equal(r9.input, 10);
  assert.equal(r9.turns, 1);
  assert.equal(r9.cacheHitRate, 0); // denom=10≠0, cacheRead=0
  assert.equal(r9.speedTps, 1); // 单条簇 1s 下限, output 1
  assert.equal(r10.sub.input, 20);
  assert.equal(r10.cacheHitRate, 5 / (5 + 20));
});

// ---------------------------------------------------------------- T12 credits 校准
// 真机 ground truth：当前 Qoder CN 客户端 message.usage 的 token 字段全 0，
// 但每条 assistant 记录带非零 credits（如 0.8022897630/回合）。credits 成为本地口径主聚合单位。

test('parseJsonlLine picks credits: finite ≥0 kept, missing/negative/NaN/Infinity/non-number → null', () => {
  const now = Date.now();
  const r = parseJsonlLine(line(now, { input_tokens: 0, output_tokens: 0, credits: 0.8022897630 }));
  assert.equal(r.credits, 0.8022897630);
  assert.equal(r.input, 0); // token 字段口径字节稳定（真机全 0 也保留）
  const m = parseJsonlLine(line(now + 1, { input_tokens: 5, output_tokens: 1 }));
  assert.equal(m.credits, null); // 无 credits 字段（旧会话）→ null
  for (const bad of [-1, NaN, Infinity, '0.8', null]) {
    const b = parseJsonlLine(line(now + 2, { input_tokens: 1, credits: bad }));
    assert.equal(b.credits, null, `credits=${String(bad)} → null`);
  }
  const z = parseJsonlLine(line(now + 3, { input_tokens: 0, credits: 0 }));
  assert.equal(z.credits, 0); // 0 是合法读数（billable:false 回合），与 null（未知）区分
});

test('aggregate: windows + byAgent gain credits = sum of non-null records credits', () => {
  const now = new Date(2026, 9, 10, 12, 0, 0).getTime();
  const base = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  const recs = [
    { ts: now - 2 * H, uuid: 'a', ...base, credits: 0.1, sub: false },
    { ts: now - 1 * H, uuid: 'b', ...base, credits: 0.2, sub: false },
    { ts: now - 30 * 60_000, uuid: 'c', ...base, credits: null, sub: true }, // null 记 0 贡献
  ];
  const a = aggregate(recs, now);
  assert.equal(a.window5h.credits, 0.3); // 0.1+0.2 → round2 消 float drift（裸加=0.30000000000000004）
  assert.equal(a.week.credits, 0.3);
  assert.equal(a.today.credits, 0.3);
  assert.equal(a.window5h.byAgent.main.credits, 0.3);
  assert.equal(a.window5h.byAgent.sub.credits, 0);
  const e = aggregate([], now);
  for (const w of [e.window5h, e.week, e.today]) {
    assert.equal(w.credits, 0); // 空窗口 0（与 -- 的区分交给呈现层：0 cr 是诚实值）
    assert.equal(w.byAgent.main.credits, 0);
    assert.equal(w.byAgent.sub.credits, 0);
  }
  // 记录缺 credits 字段（scan-cache 旧记录回读）→ 视同 null，不产生 NaN
  const legacy = [{ ts: now - H, uuid: 'L', ...base, sub: false }];
  assert.equal(aggregate(legacy, now).window5h.credits, 0);
});

test('aggregate credits rounds to 2 decimals (documented sum semantics)', () => {
  const now = new Date(2026, 9, 10, 12, 0, 0).getTime();
  const base = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, sub: false };
  const recs = [60, 40, 20].map((minAgo) => ({ ts: now - minAgo * 60_000, uuid: 'r' + minAgo, ...base, credits: 0.8022897630 }));
  assert.equal(aggregate(recs, now).today.credits, 2.41); // 3×0.8022897630=2.406869289 → 2.41
});

test('dailyRows: rows + main/sub carry credits per day', () => {
  const recs = [
    { ts: new Date('2026-10-10T09:00:00+08:00').getTime(), uuid: 'd1', input: 0, output: 0, cacheRead: 0, cacheCreate: 0, credits: 0.8, sub: false },
    { ts: new Date('2026-10-10T10:00:00+08:00').getTime(), uuid: 'd2', input: 0, output: 0, cacheRead: 0, cacheCreate: 0, credits: null, sub: true },
    { ts: new Date('2026-10-11T09:00:00+08:00').getTime(), uuid: 'd3', input: 0, output: 0, cacheRead: 0, cacheCreate: 0, credits: 1.25, sub: false },
  ];
  const rows = dailyRows(recs, 'Asia/Shanghai');
  const r10 = rows.find((r) => r.date === '2026-10-10');
  assert.equal(r10.credits, 0.8);
  assert.equal(r10.main.credits, 0.8);
  assert.equal(r10.sub.credits, 0); // null-credit 记录 → 0 贡献（sum 语义）
  assert.equal(rows.find((r) => r.date === '2026-10-11').credits, 1.25);
});

// ---------------------------------------------------------------- Session strip（用户裁定：5h/周槽 → 本会话 credits + 近30分钟速率）
// parseJsonlLine 增补 sessionId（顶层字符串字段，缺失 → null）。scan-cache（~/.qoder-monitor）
// 可能持有升级前的旧记录（无该字段 → undefined）：sessionStats 必须容忍，绝不抛。

test('parseJsonlLine: sessionId 顶层字符串保留，缺失/非字符串 → null（记录形状向后兼容）', () => {
  const now = Date.now();
  const mk = (extra) => JSON.stringify({
    type: 'assistant', uuid: 'sid-test', ...extra,
    timestamp: new Date(now).toISOString(),
    message: { role: 'assistant', usage: { input_tokens: 1, credits: 0.5 } },
  });
  assert.equal(parseJsonlLine(mk({ sessionId: 'abc-123' })).sessionId, 'abc-123');
  assert.equal(parseJsonlLine(mk({})).sessionId, null); // 旧记录无字段 → null（不是 undefined）
  assert.equal(parseJsonlLine(mk({ sessionId: 42 })).sessionId, null); // 非字符串 → null
  assert.equal(parseJsonlLine(mk({ sessionId: '' })).sessionId, '', '空串仍是字符串（消费侧按 falsy 跳过）');
});

test('sessionStats: 多会话取最新活跃（max ts 记录的 sessionId）；credits/turns/rateCpm30 只计该会话', () => {
  const now = new Date(2026, 9, 10, 12, 0, 0).getTime();
  const base = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, sub: false };
  const recs = [
    { ts: now - 2 * 3600_000, uuid: 'a1', ...base, sessionId: 'S-old', credits: 10 },
    { ts: now - 1 * 3600_000, uuid: 'a2', ...base, sessionId: 'S-old', credits: 5 },
    { ts: now - 5 * 60_000, uuid: 'b1', ...base, sessionId: 'S-cur', credits: 0.9 }, // 最新活跃会话
    { ts: now - 1 * 3600_000, uuid: 'a3', ...base, sessionId: 'S-old', credits: null }, // null 记 0 贡献
  ];
  assert.deepEqual(sessionStats(recs, now), {
    id: 'S-cur', credits: 0.9, creditsBillable: null, creditsFree: null, // 记录无 billable 标注 → 实扣/免费未知
    turns: 1, rateCpm30: Math.round((0.9 / 30) * 100) / 100, rateCpm30Billable: null, // 0.03
    billedInput: null, avgTurnSec: null, // 记录无 ratio（旧形态）→ null；单回合 <2 gap → null
    model: null, tps30: null, // 无 ctxMeta → model null；窗内无 ratio 记录 → tps30 null
    billingMode: 'credits', input: 0, output: 0, outEst: 0, outTok: 0, outExact: true, cacheRead: 0, cacheCreate: 0, tps30Tokens: 0, // 有 credits → credits 口径；窗内有记录但 token 全零 → 0；outEst=估算（无正文块 → 0）
    outTps30: null, outTps30Exact: null, // T16：窗内无实测模型秒（日志未配对）→ null
    byModel: [{ model: null, modelName: null, billingMode: 'credits', credits: 0.9, creditsBillable: null, creditsFree: null, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, billedInput: null, billedSource: null, turns: 0, outTps: null, outTpsExact: null, avgTurnSec: null }],
    totalTurnSec: null,
    // 原生样式数据面：无 prompt → 0 轮；无 rid → 每条 usage 各计 1 次请求；无真实 cache token → null
    rounds: 0, requests: 1, cacheHitRate: null, firstTs: now - 5 * 60_000, lastTs: now - 5 * 60_000,
    outEstThk: 0, outEstTxt: 0, outEstCall: 0, tools: { calls: 0, errors: 0, byName: [] }, edits: null,
  });
});

test('sessionStats: 无 sessionId 记录（含旧缓存 undefined）不参与 id 选择，但已选会话内照常聚合', () => {
  const now = new Date(2026, 9, 10, 12, 0, 0).getTime();
  const base = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, sub: false };
  // 最新记录无 sessionId（真机旧缓存形态）→ id 落到"带 id 的最新记录"所在会话
  const recs = [
    { ts: now - 10 * 60_000, uuid: 'x1', ...base, credits: 1 }, // undefined sessionId：容忍
    { ts: now - 2 * 60_000, uuid: 'x2', ...base, sessionId: null, credits: 2 }, // null：同样跳过 id 选择
    { ts: now - 3 * 60_000, uuid: 'y1', ...base, sessionId: 'S-a', credits: 0.4 },
    { ts: now - 40 * 60_000, uuid: 'y2', ...base, sessionId: 'S-a', credits: 0.6 }, // 窗外：计入 credits，不计入速率
  ];
  assert.deepEqual(sessionStats(recs, now), { id: 'S-a', credits: 1, creditsBillable: null, creditsFree: null, turns: 2, rateCpm30: Math.round((0.4 / 30) * 100) / 100, rateCpm30Billable: null, billedInput: null, avgTurnSec: null, model: null, tps30: null, billingMode: 'credits', input: 0, output: 0, outEst: 0, outTok: 0, outExact: true, cacheRead: 0, cacheCreate: 0, tps30Tokens: 0, outTps30: null, outTps30Exact: null, byModel: [{ model: null, modelName: null, billingMode: 'credits', credits: 1, creditsBillable: null, creditsFree: null, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, billedInput: null, billedSource: null, turns: 0, outTps: null, outTpsExact: null, avgTurnSec: null }], totalTurnSec: null, rounds: 0, requests: 2, cacheHitRate: null, firstTs: now - 40 * 60_000, lastTs: now - 3 * 60_000, outEstThk: 0, outEstTxt: 0, outEstCall: 0, tools: { calls: 0, errors: 0, byName: [] }, edits: null }); // 0.4/30→0.01；gap 37min>30min 剔为 idle → 合格 gap<2 → null；窗内 output 全零 → outTps30 null
  // 全池都没有 sessionId → 等同空输入（诚实降级：不知道"本会话"是谁）
  assert.deepEqual(sessionStats([{ ts: now, uuid: 'z', ...base, credits: 1 }], now),
    { id: null, credits: null, creditsBillable: null, creditsFree: null, turns: 0, rateCpm30: null, rateCpm30Billable: null, billedInput: null, avgTurnSec: null, model: null, tps30: null, billingMode: null, input: 0, output: 0, outEst: null, outTok: null, outExact: null, cacheRead: 0, cacheCreate: 0, tps30Tokens: null, outTps30: null, outTps30Exact: null, byModel: [], totalTurnSec: null, rounds: 0, requests: 0, cacheHitRate: null, firstTs: null, lastTs: null, outEstThk: 0, outEstTxt: 0, outEstCall: 0, tools: { calls: 0, errors: 0, byName: [] }, edits: null });
});

test('sessionStats: 速率窗口 ts > now-30min 严格排他（恰 30 分钟整不计），速率 = Σ/30 round2', () => {
  const now = new Date(2026, 9, 10, 12, 0, 0).getTime();
  const base = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, sub: false, sessionId: 'S' };
  const recs = [
    { ts: now - 30 * 60_000, uuid: 'edge', ...base, credits: 6 }, // 恰在边界 → 排除
    { ts: now - 30 * 60_000 - 1, uuid: 'older', ...base, credits: 1 },
    { ts: now - 29 * 60_000, uuid: 'fresh', ...base, credits: 0.2 },
  ];
  const s = sessionStats(recs, now);
  assert.equal(s.id, 'S');
  assert.equal(s.credits, 7.2); // 全会话 Σ（含窗外）
  assert.equal(s.turns, 3);
  assert.equal(s.rateCpm30, Math.round((0.2 / 30) * 100) / 100); // 0.0066… → 0.01（仅窗内 0.2）
  // 窗内无记录 → 0（不是 null：会话存在，速率是诚实读数 0）
  const stale = [{ ts: now - 60 * 60_000, uuid: 'q', ...base, credits: 3 }];
  assert.equal(sessionStats(stale, now).rateCpm30, 0);
});

test('sessionStats: credits round2 消 float drift；turns 按 uuid 去重后计数', () => {
  const now = new Date(2026, 9, 10, 12, 0, 0).getTime();
  const base = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, sub: false, sessionId: 'S' };
  const recs = [60, 40, 20].map((minAgo) => ({ ts: now - minAgo * 60_000, uuid: 'r' + minAgo, ...base, credits: 0.8022897630 }));
  const s = sessionStats(recs, now);
  assert.equal(s.credits, 2.41); // 3×0.8022897630=2.406869289 → 2.41
  assert.equal(s.rateCpm30, Math.round((0.802289763 / 30) * 100) / 100); // 窗内仅 20min 前一条 → 0.03
  const dup = [...recs, { ...recs[0] }]; // 同 uuid 重复（cache 幂等约定，同 aggregate）
  const d = sessionStats(dup, now);
  assert.equal(d.turns, 3);
  assert.equal(d.credits, 2.41);
});

test('sessionStats: 空输入 → {id:null, credits:null, turns:0, rateCpm30:null, billedInput:null, avgTurnSec:null, model:null, tps30:null}；不修改入参', () => {
  const now = Date.now();
  assert.deepEqual(sessionStats([], now), { id: null, credits: null, creditsBillable: null, creditsFree: null, turns: 0, rateCpm30: null, rateCpm30Billable: null, billedInput: null, avgTurnSec: null, model: null, tps30: null, billingMode: null, input: 0, output: 0, outEst: null, outTok: null, outExact: null, cacheRead: 0, cacheCreate: 0, tps30Tokens: null, outTps30: null, outTps30Exact: null, byModel: [], totalTurnSec: null, rounds: 0, requests: 0, cacheHitRate: null, firstTs: null, lastTs: null, outEstThk: 0, outEstTxt: 0, outEstCall: 0, tools: { calls: 0, errors: 0, byName: [] }, edits: null });
  const recs = [{ ts: now, uuid: 'k', input: 0, output: 0, cacheRead: 0, cacheCreate: 0, credits: 1, sub: false }];
  const before = recs.map((r) => r.uuid);
  sessionStats(recs, now);
  assert.deepEqual(recs.map((r) => r.uuid), before, '纯函数：排序不产生副作用');
});

// ---------------------------------------------------------------- 计费输入 tokens + 平均回合时长
// 真机 ground truth（official qoder-credits-inspector v2.7.4 方法学 + 本机探针）：
//  - assistant 记录 message.usage.context_usage_ratio 是平台真值（如 0.138735）；
//  - 计费输入 tokens = ratio × contextWindow（inspector "计费输入总量" 公式）；
//  - contextWindow 来源：runtime-config 记录顶层字段（本机 qfmodel 实测可为 null → 兜底
//    200000 并以 ≈ 标注，inspector 约定）；output/cache tokens 本地无真值（全 0）→
//    tps 无法诚实呈现，换用会话内相邻回合间隔均值（>30min 剔为 idle）。

test('parseJsonlLine: ratio 提取 usage.context_usage_ratio——0<r≤1 保留，缺失/0/>1/非数字 → null', () => {
  const now = Date.now();
  const r = parseJsonlLine(line(now, { credits: 0.5, context_usage_ratio: 0.138735 }));
  assert.equal(r.ratio, 0.138735); // 真机平台真值
  assert.equal(parseJsonlLine(line(now + 1, { credits: 0.5 })).ratio, null); // 旧记录无字段
  assert.equal(parseJsonlLine(line(now + 2, { credits: 0.5, context_usage_ratio: 1 })).ratio, 1); // 边界 1 合法
  for (const bad of [0, -0.1, 1.0001, 12000, NaN, Infinity, '0.5', null, {}]) {
    assert.equal(parseJsonlLine(line(now + 3, { credits: 0.5, context_usage_ratio: bad })).ratio,
      null, `ratio=${String(bad)} → null`);
  }
});

test('parseRuntimeConfig: 顶层 contextWindow/model/sessionId/ts；window null 如实保留；非该类型/坏 JSON → null', () => {
  const now = Date.now();
  const mk = (o = {}) => JSON.stringify({
    type: 'runtime-config', sessionId: 'S1', model: 'qfmodel',
    contextWindow: 180000, timestamp: new Date(now).toISOString(), ...o,
  });
  assert.deepEqual(parseRuntimeConfig(mk()),
    { contextWindow: 180000, model: 'qfmodel', sessionId: 'S1', ts: now });
  // 本机实况：qfmodel 会话 contextWindow 写 null——记录仍有效（消费侧走 200k 兜底 + ≈）
  assert.equal(parseRuntimeConfig(mk({ contextWindow: null })).contextWindow, null);
  assert.equal(parseRuntimeConfig(mk({ contextWindow: '180000' })).contextWindow, null); // 非数字
  assert.equal(parseRuntimeConfig(mk({ contextWindow: -5 })).contextWindow, null); // 负数
  assert.equal(parseRuntimeConfig(mk({ contextWindow: NaN })).contextWindow, null);
  assert.equal(parseRuntimeConfig(mk({ model: null })).model, null); // 缺失/非串 → null
  assert.equal(parseRuntimeConfig(mk({ timestamp: 'garbage' })).ts, null); // 坏 ts → null（不整条丢弃）
  assert.equal(parseRuntimeConfig(mk({ sessionId: 42 })).sessionId, null);
  assert.equal(parseRuntimeConfig(''), null); // 坏 JSON
  assert.equal(parseRuntimeConfig('not json {'), null);
  assert.equal(parseRuntimeConfig(line(now, { credits: 1 })), null); // assistant 类型 → null
  assert.equal(parseRuntimeConfig(JSON.stringify({ type: 'user', uuid: 'a' })), null);
});

test('aggregate(ctxWindows): billedInput = Σ ratio×window（每记录 sessionId 查表），round 整数；source 三态', () => {
  const now = new Date(2026, 9, 10, 12, 0, 0).getTime();
  const base = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, credits: 0.5 };
  const recs = [
    { ts: now - 2 * 60_000, uuid: 'a', ...base, sub: false, sessionId: 'S1', ratio: 0.5 },
    { ts: now - 60 * 60_000, uuid: 'b', ...base, sub: false, sessionId: 'S2', ratio: 0.25 }, // 窗外（5h 窗 = [now-5h,now)，60min 前仍在窗内）——注意
  ];
  // 两条都在 5h 窗内（2min/60min 前）；S1 有 runtime 180000，S2 表缺 → 兜底 200000 → mixed
  const a = aggregate(recs, now, new Map([['S1', 180000]]));
  assert.equal(a.window5h.billedInput, 0.5 * 180000 + 0.25 * 200000); // 90000+50000=140000
  assert.equal(a.window5h.billedInputSource, 'mixed');
  // 全部 runtime 命中 → 无 ≈ 语义（source runtime-config）
  const b = aggregate(recs, now, new Map([['S1', 180000], ['S2', 100000]]));
  assert.equal(b.window5h.billedInput, 90000 + 25000);
  assert.equal(b.window5h.billedInputSource, 'runtime-config');
  // 表值 null（本机 qfmodel 实况）→ 视同缺席，兜底 200000 + fallback200k
  const c = aggregate(recs, now, new Map([['S1', null], ['S2', null]]));
  assert.equal(c.window5h.billedInput, 0.5 * 200000 + 0.25 * 200000); // 150000
  assert.equal(c.window5h.billedInputSource, 'fallback200k');
  // 不传第三参（旧调用面）→ 一律兜底
  const d = aggregate(recs, now);
  assert.equal(d.window5h.billedInput, 150000);
  assert.equal(d.window5h.billedInputSource, 'fallback200k');
  // 结果四舍五入到整数（0.2×180000=36000 整除路径 + 漂移路径）
  const e = aggregate([{ ts: now - 60_000, uuid: 'r', ...base, sub: false, sessionId: 'S9', ratio: 1 / 3 }], now, new Map([['S9', 180000]]));
  assert.equal(e.window5h.billedInput, 60000); // 59999.999…94 → 60000
  assert.equal(Number.isInteger(e.window5h.billedInput), true);
});

test('aggregate billedInput: 无 ratio>0 记录（含全窗窗外）→ null + source null；既有字段不动', () => {
  const now = new Date(2026, 9, 10, 12, 0, 0).getTime();
  const base = { input: 100, output: 10, cacheRead: 0, cacheCreate: 0, sub: false, credits: null };
  const a = aggregate([
    { ts: now - 60_000, uuid: 'no-ratio', ...base }, // ratio undefined（旧缓存记录形态）
    { ts: now - 120_000, uuid: 'ratio-null', ...base, ratio: null },
    { ts: now - 180_000, uuid: 'ratio-0', ...base, ratio: 0 }, // 0 无真值语义 → 不贡献
  ], now);
  for (const w of [a.window5h, a.week, a.today]) {
    assert.equal(w.billedInput, null);
    assert.equal(w.billedInputSource, null);
    assert.equal(w.input, 300); // 既有字段 untouched（三条记录均在 5h/today 窗内，now=本地正午）
  }
  // ratio 记录全在 5h 窗外 → 5h null，week/today 有值（本地正午 now，6h 前 = 当日 06:00）
  const b = aggregate([{ ts: now - 6 * 3600_000, uuid: 'old', ...base, sessionId: 'S', ratio: 0.5 }], now);
  assert.equal(b.window5h.billedInput, null);
  assert.equal(b.week.billedInput, 100000);
  assert.equal(b.today.billedInput, 100000);
  assert.equal(a.window5h.turns, 3);
});

test('aggregate billedInput 计入 null-credit/ratio 混合记录，round2 credits 语义不变', () => {
  const now = new Date(2026, 9, 10, 12, 0, 0).getTime();
  const recs = [
    { ts: now - 60_000, uuid: 'x', input: 0, output: 0, cacheRead: 0, cacheCreate: 0, sub: false, sessionId: 'S', ratio: 0.138735, credits: 0.8022897630 },
  ];
  const a = aggregate(recs, now, new Map([['S', 200000]]));
  assert.equal(a.window5h.billedInput, Math.round(0.138735 * 200000)); // 27747
  assert.equal(a.window5h.billedInputSource, 'runtime-config');
  assert.equal(a.window5h.credits, 0.8); // 既有 credits 路径原样
});

test('sessionStats: billedInput（本会话 ratio×window 同公式）+ avgTurnSec（会话内相邻 gap 均值，>30min 剔 idle）', () => {
  const now = new Date(2026, 9, 10, 12, 0, 0).getTime();
  const base = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, sub: false, credits: 0.5 };
  const t = (minAgo) => now - minAgo * 60_000;
  const recs = [
    { ts: t(60), uuid: 'o1', ...base, sessionId: 'S-old', ratio: 0.9 }, // 非本会话：不计
    { ts: t(30), uuid: 'g1', ...base, sessionId: 'S-cur', ratio: 0.5 },
    { ts: t(28), uuid: 'g2', ...base, sessionId: 'S-cur', ratio: 0.25 }, // gap 120s
    { ts: t(20), uuid: 'g3', ...base, sessionId: 'S-cur' }, // gap 480s（ratio 缺失：不贡献 billed）
    { ts: t(19.5), uuid: 'g4', ...base, sessionId: 'S-cur', ratio: null }, // gap 30s
  ];
  const s = sessionStats(recs, now, new Map([['S-cur', 180000]]));
  assert.equal(s.id, 'S-cur');
  assert.equal(s.billedInput, Math.round(0.5 * 180000 + 0.25 * 180000)); // 135000（S-old 的 0.9 不算）
  // 合格 gap（秒）：120, 480, 30 → 均值 210
  assert.equal(s.avgTurnSec, 210);
});

test('sessionStats avgTurnSec: >30min 剔为 idle（恰 30min 保留）；合格 gap <2 → null；跨会话不串味', () => {
  const now = new Date(2026, 9, 10, 12, 0, 0).getTime();
  const base = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, sub: false, credits: 0.5, sessionId: 'S' };
  const mk = (minAgo, uuid) => ({ ts: now - minAgo * 60_000, uuid, ...base });
  // gap 序列（minAgo 64→62→31→8）：2min 保留、31min 剔为 idle、23min 保留 → 合格 [120,1380] → 750
  const a = sessionStats([mk(64, 'i1'), mk(62, 'i2'), mk(31, 'i3'), mk(8, 'i4')], now);
  assert.equal(a.avgTurnSec, Math.round((120 + 1380) / 2));
  // 恰 30min 的 gap 保留（严格 ">30min" 才剔）：两 gap 均 1800s → 1800
  assert.equal(sessionStats([mk(100, 'e1'), mk(70, 'e2'), mk(40, 'e3')], now).avgTurnSec, 1800);
  // 会话仅 2 条记录 → 1 个合格 gap → null（样本 <2 不谎称"平均"）
  assert.equal(sessionStats([mk(10, 'p'), mk(8, 'q')], now).avgTurnSec, null);
  // 其余全部剔为 idle → 合格 0 → null
  assert.equal(sessionStats([mk(120, 'x'), mk(60, 'y')], now).avgTurnSec, null);
  // 跨会话：S-old 的大间隔不得混入 S-cur 均值
  const t = (minAgo) => now - minAgo * 60_000;
  const mix = [
    { ts: t(200), uuid: 'o1', ...base, sessionId: 'S-old' },
    { ts: t(100), uuid: 'o2', ...base, sessionId: 'S-old' }, // 100min gap（若非本会话则无关）
    { ts: t(10), uuid: 'c1', ...base, sessionId: 'S-cur' },
    { ts: t(7), uuid: 'c2', ...base, sessionId: 'S-cur' },
    { ts: t(5), uuid: 'c3', ...base, sessionId: 'S-cur' }, // 180s+120s → 150
  ];
  assert.equal(sessionStats(mix, now).avgTurnSec, 150);
});

test('sessionStats billedInput: ctxWindows 兜底 200000 与缺 map 同值；旧记录无 ratio → null 不崩（迁移）', () => {
  const now = new Date(2026, 9, 10, 12, 0, 0).getTime();
  const base = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, sub: false, credits: 0.5 };
  const recs = [
    { ts: now - 10 * 60_000, uuid: 'm1', ...base, sessionId: 'S', ratio: 0.2 },
    { ts: now - 5 * 60_000, uuid: 'm2', ...base, sessionId: 'S', ratio: 0.1 },
  ];
  assert.equal(sessionStats(recs, now).billedInput, 60000); // 无 map → 0.3×200000
  assert.equal(sessionStats(recs, now, new Map([['S', 200000]])).billedInput, 60000); // 同值
  // 迁移主场景：升级前 scan-cache 记录既无 ratio 字段也无 sessionId → 一切 null，绝不抛/绝不 NaN
  const legacy = [{ ts: now - 60_000, uuid: 'L', ...base }];
  const l = sessionStats(legacy, now, new Map());
  assert.deepEqual(l, { id: null, credits: null, creditsBillable: null, creditsFree: null, turns: 0, rateCpm30: null, rateCpm30Billable: null, billedInput: null, avgTurnSec: null, model: null, tps30: null, billingMode: null, input: 0, output: 0, outEst: null, outTok: null, outExact: null, cacheRead: 0, cacheCreate: 0, tps30Tokens: null, outTps30: null, outTps30Exact: null, byModel: [], totalTurnSec: null, rounds: 0, requests: 0, cacheHitRate: null, firstTs: null, lastTs: null, outEstThk: 0, outEstTxt: 0, outEstCall: 0, tools: { calls: 0, errors: 0, byName: [] }, edits: null });
});

// ---------------------------------------------------------------- T13+：模型名 + 输入吞吐（tps）+ 会话明细
// 用户裁定：真机 output token 恒 0 无本地真值 → 量「计费输入吞吐」tps30 = Σ 本会话近30分钟
// ratio×contextWindow / 1800（一位小数）；模型名取自 runtime-config（真机 'qfmodel'）；会话明细
// sessionsSummary 逐会话聚合（panel 数据源）。

test('sessionStats: model 取自 ctxMeta（对象形态 {contextWindow,model}），旧 Map<sid,数> 形态 model null', () => {
  const now = new Date(2026, 9, 10, 12, 0, 0).getTime();
  const base = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, sub: false, credits: 0.5 };
  const recs = [{ ts: now - 5 * 60_000, uuid: 'a', ...base, sessionId: 'S', ratio: 0.3 }];
  assert.equal(sessionStats(recs, now, new Map([['S', { contextWindow: 180000, model: 'qfmodel' }]])).model, 'qfmodel');
  assert.equal(sessionStats(recs, now, new Map([['S', 180000]])).model, null, '旧裸数形态 → model null（向后兼容）');
  assert.equal(sessionStats(recs, now).model, null, '无 ctxMeta → null');
  // model 非空字符串才认（空串/非串 → null）
  assert.equal(sessionStats(recs, now, new Map([['S', { contextWindow: 180000, model: '' }]])).model, null);
  assert.equal(sessionStats(recs, now, new Map([['S', { contextWindow: 180000, model: 42 }]])).model, null);
});

test('sessionStats: tps30 = Σ本会话近30分钟(ratio×contextWindow)/1800 round1（恰 30min 排除；窗外 ratio 不计）；无窗内 ratio → null', () => {
  const now = new Date(2026, 9, 10, 12, 0, 0).getTime();
  const base = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, sub: false, credits: 0.5, sessionId: 'S' };
  const t = (minAgo) => now - minAgo * 60_000;
  const recs = [
    { ts: t(40), uuid: 'c1', ...base, ratio: 0.9 }, // 窗外（40min）→ 不计 tps30
    { ts: t(20), uuid: 'c2', ...base, ratio: 0.3 }, // 窗内
    { ts: t(5), uuid: 'c3', ...base, ratio: 0.55 }, // 窗内
  ];
  const ctxMeta = new Map([['S', { contextWindow: 200000, model: 'qfmodel' }]]);
  const s = sessionStats(recs, now, ctxMeta);
  // 窗内 billed = 0.3×200000 + 0.55×200000 = 170000 → /1800 = 94.444… → 94.4
  assert.equal(s.tps30, 94.4);
  assert.equal(s.billedInput, Math.round((0.9 + 0.3 + 0.55) * 200000)); // 会话全量（350000）不动
  // 恰 30min 整：tps30 窗严格排他（该记录不计）；窗内无 ratio → null（与 0 区分）
  const edge = sessionStats([{ ts: now - 30 * 60_000, uuid: 'e', ...base, ratio: 0.5 }], now, ctxMeta);
  assert.equal(edge.tps30, null);
  assert.equal(edge.billedInput, 100000, '会话 billedInput 仍计入（仅 tps30 窗排除）');
  // 旧裸数 Map 形态同公式（window 取裸数）
  assert.equal(sessionStats(recs, now, new Map([['S', 200000]])).tps30, 94.4);
});

// T16（用户裁定，移植 credits-overlay.py）：**Output 用正文估算，不是 usage 上报**——
// outTps30 = 近30分钟窗内「正文估算 Output（est.mjs est_tokens）÷ 实测纯模型秒」：
// 分子含窗内全部记录的 outEst（message.id 归并口径）；分母 = 日志配对区间 [mt0,mt1] **合并**
// 求和（并发不重复计时），窗口级不兜底（Rate = Σ实测模型秒）。无实测秒 / 无可估算输出 →
// null（呈现 '-- tps'，与 0 区分，绝不出 0 防误读）。
test('sessionStats: outTps30 = 窗内正文估算 ÷ 实测纯模型秒（区间合并）；无实测秒/无估算 → null（与 0 区分）', () => {
  const now = new Date(2026, 9, 10, 12, 0, 0).getTime();
  const base = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, sub: false, credits: 0.5, sessionId: 'S' };
  const t = (minAgo) => now - minAgo * 60_000;
  // 有估算、无日志配对 → null（窗内有记录也不猜，呈现 -- tps）
  assert.equal(sessionStats([{ ts: t(5), uuid: 'z1', ...base, outEst: 400 }], now).outTps30, null);
  // 实测形态：窗外记录不进分子分母；窗内区间重叠合并（a1+a2 并段 = 15s，非 10+10）；
  // z2 有实测秒但无可估算输出 → 只进分母（真实耗时如实计）。
  const recs = [
    { ts: t(40), uuid: 'o1', ...base, outEst: 99999, mt0: t(40), mt1: t(40) + 10_000 }, // 窗外（40min）→ 不计
    { ts: t(20), uuid: 'a1', ...base, outEst: 600, mt0: t(20), mt1: t(20) + 10_000 },
    { ts: t(19), uuid: 'a2', ...base, outEst: 600, mt0: t(20) + 5_000, mt1: t(20) + 15_000 },
    { ts: t(10), uuid: 'z2', ...base, outEst: 0, mt0: t(10), mt1: t(10) + 5_000 },
    { ts: t(5), uuid: 'm1', ...base, outEst: 700 }, // 有估算无日志 → 分子分母皆不计（窗口级不兜底）
  ];
  const s = sessionStats(recs, now);
  // 分子 = 600+600+0 = 1200（窗外 o1 与无日志 m1 不计）；分母 = 15s + 5s = 20s → 60 tps
  assert.equal(s.outTps30, 60);
  assert.equal(s.outEst, 99999 + 600 + 600 + 0 + 700, 'outEst 是全会话估算合计（不受 30min 窗限制）');
  assert.equal(s.output, 0, '真实 output 字段照旧保留（内置恒 0；估算另走 outEst）');
  // 恰 30min 整：复用 inWindow 窗（严格排他）→ 窗外 → 无实测秒 → null
  assert.equal(sessionStats([{ ts: now - 30 * 60_000, uuid: 'e', ...base, outEst: 999, mt0: now - 30 * 60_000, mt1: now - 30 * 60_000 + 1000 }], now).outTps30, null);
});

test('sessionsSummary: 按 lastTs 降序、逐会话字段（credits round2 / billedInput+billedSource / model / turns / avgTurnSec）；无 id 记录不成组', () => {
  const now = new Date(2026, 9, 10, 12, 0, 0).getTime();
  const base = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, sub: false };
  const t = (minAgo) => now - minAgo * 60_000;
  const recs = [
    { ts: t(50), uuid: 'a1', ...base, sessionId: 'S-A', credits: 0.5, ratio: 0.5 },
    { ts: t(10), uuid: 'b1', ...base, sessionId: 'S-B', credits: 0.8022897630, ratio: 0.25 },
    { ts: t(5), uuid: 'b2', ...base, sessionId: 'S-B', credits: null, ratio: null }, // null 记 0 贡献
    { ts: t(120), uuid: 'c1', ...base, sessionId: 'S-C', credits: 1.25 }, // 无 ratio → billed null
    { ts: t(3), uuid: 'n1', ...base, credits: 9 }, // 无 sessionId → 不成组（不入明细）
  ];
  const ctxMeta = new Map([
    ['S-A', { contextWindow: 180000, model: 'qfmodel' }],
    ['S-B', { contextWindow: null, model: 'qfmodel-pro' }], // window null → 200k 兜底 → fallback200k
    // S-C 缺项 → model null + 200k 兜底
  ]);
  const rows = sessionsSummary(recs, now, ctxMeta);
  assert.deepEqual(rows.map((r) => r.id), ['S-B', 'S-A', 'S-C'], 'lastTs 降序（S-B 最近）');
  assert.deepEqual(rows[0], {
    id: 'S-B', model: 'qfmodel-pro', credits: 0.8, // 0.8022897630 round2
    creditsBillable: null, creditsFree: null, // 记录无 billable 标注 → 实扣/免费未知（不补 0）
    billedInput: Math.round(0.25 * 200000), billedSource: 'fallback200k', // 50000（window null 兜底）
    turns: 2, rounds: 0, requests: 2, lastTs: t(5), avgTurnSec: null, // 2 条 → 1 gap <2 → null
    billingMode: 'credits', input: 0, output: 0, cacheRead: 0, cacheCreate: 0,
    byModel: [{ model: null, modelName: null, billingMode: 'credits', credits: 0.8, creditsBillable: null, creditsFree: null, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, billedInput: Math.round(0.25 * 200000), billedSource: 'fallback200k', turns: 0, outTps: null, outTpsExact: null, avgTurnSec: null }],
  });
  assert.deepEqual(rows[1], {
    id: 'S-A', model: 'qfmodel', credits: 0.5,
    creditsBillable: null, creditsFree: null,
    billedInput: Math.round(0.5 * 180000), billedSource: 'runtime-config', // 90000
    turns: 1, rounds: 0, requests: 1, lastTs: t(50), avgTurnSec: null,
    billingMode: 'credits', input: 0, output: 0, cacheRead: 0, cacheCreate: 0,
    byModel: [{ model: null, modelName: null, billingMode: 'credits', credits: 0.5, creditsBillable: null, creditsFree: null, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, billedInput: Math.round(0.5 * 180000), billedSource: 'runtime-config', turns: 0, outTps: null, outTpsExact: null, avgTurnSec: null }],
  });
  assert.deepEqual(rows[2], {
    id: 'S-C', model: null, credits: 1.25, creditsBillable: null, creditsFree: null,
    billedInput: null, billedSource: null,
    turns: 1, rounds: 0, requests: 1, lastTs: t(120), avgTurnSec: null,
    billingMode: 'credits', input: 0, output: 0, cacheRead: 0, cacheCreate: 0,
    byModel: [{ model: null, modelName: null, billingMode: 'credits', credits: 1.25, creditsBillable: null, creditsFree: null, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, billedInput: null, billedSource: null, turns: 0, outTps: null, outTpsExact: null, avgTurnSec: null }],
  });
  // avgTurnSec：≥2 合格 gap 才出值（同 sessionStats 口径，>30min 剔 idle）
  const gaps = [
    { ts: t(10), uuid: 'g1', ...base, sessionId: 'S-G', credits: 0 },
    { ts: t(8), uuid: 'g2', ...base, sessionId: 'S-G', credits: 0 }, // 120s
    { ts: t(4), uuid: 'g3', ...base, sessionId: 'S-G', credits: 0 }, // 240s → 均值 180
  ];
  assert.equal(sessionsSummary(gaps, now, new Map())[0].avgTurnSec, 180);
  // 空/仅无 id 记录 → []
  assert.deepEqual(sessionsSummary([], now, new Map()), []);
  assert.deepEqual(sessionsSummary([{ ts: now, uuid: 'x', ...base, credits: 1 }], now, new Map()), []);
});

test('sessionsSummary: 上限 10（取 lastTs 最近者），merge 到 scan 全量 records 之上', () => {
  const now = new Date(2026, 9, 10, 12, 0, 0).getTime();
  const base = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, sub: false };
  const recs = [];
  for (let i = 0; i < 12; i++) {
    recs.push({ ts: now - (12 - i) * 60_000, uuid: 'm' + i, ...base, sessionId: 'S' + i, credits: i });
  }
  const rows = sessionsSummary(recs, now, new Map());
  assert.equal(rows.length, 10, '≤10');
  assert.equal(rows[0].id, 'S11', '最近活跃在前');
  assert.equal(rows[9].id, 'S2');
  // ctxMeta 缺 → model null / billedSource 依 ratio 判定（此处全无 ratio → null）
  assert.equal(rows[0].model, null);
  assert.equal(rows[0].billedSource, null);
});

// ---------------------------------------------------------------- 计费口径（credits vs tokens，用户裁定）
// 真机 ground truth（本机 jsonl 按模型聚合）：内置模型（qfmodel/qmodel_38max/auto/kmodel_latest）
// 写 credits 且 token 字段恒 0；自定义 BYOK 模型（model 前缀 qoder-custom-<uuid>/，如
// mimo-v2.6-flash / step-5-preview）**根本不写 credits 字段**，只有真实 token
// （input/output/cache_read/cache_creation）。故口径由数据自证，不猜模型名：
//   usage.credits 是有限 ≥0 数字 → 'credits'；否则任一 token 非零 → 'tokens'；否则 null。
// 呈现层按"当前会话口径"整体切换（两口径不可换算，绝不折算）。
test('parseJsonlLine: billingMode 数据自证（credits 字段优先，无 credits 且有 token → tokens，皆无 → null）', () => {
  const now = Date.now();
  assert.equal(parseJsonlLine(line(now, { credits: 0.5 })).billingMode, 'credits');
  assert.equal(parseJsonlLine(line(now + 1, { credits: 0 })).billingMode, 'credits', 'credits=0 仍是 credits 口径');
  assert.equal(parseJsonlLine(line(now + 2, { input_tokens: 100, output_tokens: 5 })).billingMode, 'tokens', 'BYOK 真机形态：无 credits');
  assert.equal(parseJsonlLine(line(now + 3, { cache_read_input_tokens: 10 })).billingMode, 'tokens');
  assert.equal(parseJsonlLine(line(now + 4, { credits: 0.5, input_tokens: 999 })).billingMode, 'credits', '双有 → credits 优先');
  assert.equal(parseJsonlLine(line(now + 5, {})).billingMode, null, '全零无 credits → 未知');
  assert.equal(parseJsonlLine(line(now + 6, { credits: 'x' })).billingMode, null, 'credits 非数字 → 未知');
});

test('sessionStats: tokens 口径会话 → 真实 token 四元组 + billingMode + tps30Tokens（输入吞吐用真实 token，非 billedInput 估算）', () => {
  const now = new Date(2026, 9, 10, 12, 0, 0).getTime();
  // BYOK 形态记录：无 credits，真实 token；ratio 也存在（billedInput 会虚高 → 呈现层须改用真值）
  const recs = [
    { ts: now - 10 * 60_000, uuid: 't1', sessionId: 'S-byok', input: 5000, output: 300, cacheRead: 90000, cacheCreate: 1000, sub: false, credits: null, ratio: 0.5, billingMode: 'tokens' },
    { ts: now - 5 * 60_000, uuid: 't2', sessionId: 'S-byok', input: 2000, output: 200, cacheRead: 0, cacheCreate: 0, sub: false, credits: null, ratio: 0.1, billingMode: 'tokens' },
    { ts: now - 1 * 60_000, uuid: 't3', sessionId: 'S-byok', input: 0, output: 0, cacheRead: 0, cacheCreate: 0, sub: false, credits: null, ratio: null, billingMode: null }, // 全零 → 不改口径
  ];
  const s = sessionStats(recs, now, new Map([['S-byok', { contextWindow: 200000, model: 'qoder-custom-f4e/mimo-v2.6-flash' }]]));
  assert.equal(s.billingMode, 'tokens');
  assert.equal(s.input, 7000);
  assert.equal(s.output, 500);
  assert.equal(s.cacheRead, 90000);
  assert.equal(s.cacheCreate, 1000);
  assert.equal(s.credits, 0, 'BYOK 无 credits → 0（不是 null：会话存在）');
  // 真实输入吞吐 = Σ(input+cacheRead+cacheCreate 窗内)/1800 = (7000+90000+1000)/1800
  assert.equal(s.tps30Tokens, Math.round((98000 / 1800) * 10) / 10);
  assert.equal(s.tps30, Math.round((s.billedInput / 1800) * 10) / 10, 'billed 口径 tps30 保留（credits 口径用）');
});

test('sessionStats: 会话中途换模型 → billingMode 跟随最新一条有口径的记录', () => {
  const now = new Date(2026, 9, 10, 12, 0, 0).getTime();
  const mk = (minAgo, extra) => ({ ts: now - minAgo * 60_000, uuid: `u${minAgo}`, sessionId: 'S', input: 0, output: 0, cacheRead: 0, cacheCreate: 0, sub: false, ...extra });
  // 早期 BYOK(tokens) → 最近切到内置(credits)：口径须跟随最近的 credits
  const toCredits = sessionStats([mk(30, { credits: 1, billingMode: 'tokens' }), mk(2, { credits: 0.4, input: 0, billingMode: 'credits' })], now);
  assert.equal(toCredits.billingMode, 'credits');
  // 反向：早期内置 → 最近 BYOK
  const toTokens = sessionStats([mk(30, { credits: 1, billingMode: 'credits' }), mk(2, { credits: null, input: 700, billingMode: 'tokens' })], now);
  assert.equal(toTokens.billingMode, 'tokens');
  // 旧缓存记录无 billingMode 字段 → 由数据现推（credits 非 null → credits）
  const legacy = sessionStats([mk(5, { credits: 0.3 })], now);
  assert.equal(legacy.billingMode, 'credits');
  const legacyTok = sessionStats([mk(5, { credits: null, cacheRead: 1200 })], now);
  assert.equal(legacyTok.billingMode, 'tokens');
  // 全会话都推不出口径 → null（呈现层回落 credits 现状）
  assert.equal(sessionStats([mk(5, { credits: null })], now).billingMode, null);
});

test('sessionStats: 无 token 记录时 tps30Tokens=null；窗内有记录但 token 全零 → 0（诚实读数）', () => {
  const now = new Date(2026, 9, 10, 12, 0, 0).getTime();
  const base = { uuid: 'a', sessionId: 'S', input: 0, output: 0, cacheRead: 0, cacheCreate: 0, sub: false, credits: 1 };
  assert.equal(sessionStats([{ ...base, ts: now - 60 * 60_000 }], now).tps30Tokens, null, '窗外无记录 → null');
  assert.equal(sessionStats([{ ...base, ts: now - 60_000 }], now).tps30Tokens, 0, '窗内有记录但 token 全零 → 0');
});

test('sessionsSummary: 每行带自身 billingMode 与真实 token（会话明细按行切口径）', () => {
  const now = new Date(2026, 9, 10, 12, 0, 0).getTime();
  const recs = [
    { ts: now - 20 * 60_000, uuid: 'c1', sessionId: 'S-cr', input: 0, output: 0, cacheRead: 0, cacheCreate: 0, sub: false, credits: 2, billingMode: 'credits' },
    { ts: now - 10 * 60_000, uuid: 't1', sessionId: 'S-tk', input: 3000, output: 40, cacheRead: 50000, cacheCreate: 0, sub: false, credits: null, billingMode: 'tokens' },
  ];
  const rows = sessionsSummary(recs, now, new Map());
  const cr = rows.find((r) => r.id === 'S-cr');
  const tk = rows.find((r) => r.id === 'S-tk');
  assert.equal(cr.billingMode, 'credits');
  assert.equal(cr.input, 0);
  assert.equal(tk.billingMode, 'tokens');
  assert.equal(tk.input, 3000);
  assert.equal(tk.cacheRead, 50000);
  assert.equal(tk.output, 40);
  assert.equal(tk.credits, 0);
});

// ---------------------------------------------------------------- T2：轮段构建 + 最新一轮
const T2T0 = new Date(2026, 9, 10, 12, 0, 0).getTime();
const t2min = (m) => T2T0 + m * 60_000;
const usageRec = (minAgo, sec, extra = {}) => ({ kind: 'usage', ts: t2min(minAgo), uuid: `r${minAgo}`, sessionId: 'S-t2', input: 100, output: sec, cacheRead: 0, cacheCreate: 0, sub: false, credits: 0.5, model: 'qfmodel', ...extra });

test('T2 buildTurns: prompt 开段/末段收尾；首 prompt 前缀不产轮；段内无 usage 不产轮；turnSec round1', () => {
  const recs = [
    { kind: 'usage', ts: t2min(-5), uuid: 'pre', sessionId: 'S-t2', input: 9, output: 9, cacheRead: 0, cacheCreate: 0, sub: false, credits: null, model: null }, // 首 prompt 前缀（孤儿）
    { kind: 'prompt', ts: t2min(0), uuid: 'p1', sessionId: 'S-t2' },
    usageRec(1, 10), usageRec(2, 20),                       // 轮1：0→2min
    { kind: 'prompt', ts: t2min(3), uuid: 'p2', sessionId: 'S-t2' }, // 空段（无 usage）不产轮
    { kind: 'prompt', ts: t2min(4), uuid: 'p3', sessionId: 'S-t2' },
    usageRec(5, 30),                                        // 轮3：4→5min
  ];
  const turns = buildTurns(recs);
  assert.equal(turns.length, 2, '前缀与空段都不产轮');
  assert.equal(turns[0].promptTs, t2min(0)); assert.equal(turns[0].endTs, t2min(2));
  assert.equal(turns[0].turnSec, 120);
  assert.equal(turns[1].promptTs, t2min(4)); assert.equal(turns[1].endTs, t2min(5));
  assert.equal(turns[1].turnSec, 60);
  assert.equal(turns[0].records.length, 2);
  // 亚秒级：endTs−promptTs 不足 1s → round1 后可为 0.x（76.100s 例子）
  const sub = buildTurns([
    { kind: 'prompt', ts: t2min(0) + 442, uuid: 's1', sessionId: 'S-t2' },
    { kind: 'usage', ts: t2min(0) + 442 + 76100, uuid: 's2', sessionId: 'S-t2', input: 1, output: 1, cacheRead: 0, cacheCreate: 0, sub: false, credits: 0.1, model: 'm' },
  ]);
  assert.equal(sub[0].turnSec, 76.1);
});

test('T2 lastTurnOf: 取过滤后集合（usage）max-ts 会话的末轮；credits/四元组求和；model=末条字面；billingMode 末向前回退；outTps = 真值优先÷实测秒（配对合并/兜底）', () => {
  const recs = [
    { kind: 'prompt', ts: t2min(0), uuid: 'pa', sessionId: 'S-old' },
    { kind: 'usage', ts: t2min(1), uuid: 'oa', sessionId: 'S-old', input: 1, output: 1, cacheRead: 0, cacheCreate: 0, sub: false, credits: 9.9, model: 'oldmodel' },
    { kind: 'prompt', ts: t2min(10), uuid: 'pb', sessionId: 'S-new' },   // max ts prompt → S-new
    // T16：outEst = 正文估算；mt0/mt1 = 日志配对区间（两区间重叠 → 合并 30s，非 20+20）
    { kind: 'usage', ts: t2min(11), uuid: 'nb', sessionId: 'S-new', input: 1000, output: 10, cacheRead: 8000, cacheCreate: 100, sub: false, credits: 0.3, model: 'qfmodel', billingMode: null, ratio: 0.3, outEst: 900, mt0: t2min(11), mt1: t2min(11) + 20_000 },
    { kind: 'usage', ts: t2min(11) + 30_000, uuid: 'nb2', sessionId: 'S-new', input: 500, output: 20, cacheRead: 1000, cacheCreate: 0, sub: false, credits: 0.5, model: 'qfmodel', outEst: 900, mt0: t2min(11) + 10_000, mt1: t2min(11) + 30_000 },
  ];
  const cm = new Map([['S-new', { contextWindow: 200000, model: 'qfmodel' }]]);
  const lt = lastTurnOf(recs, cm);
  assert.equal(lt.sessionId, 'S-new');
  assert.equal(lt.promptTs, t2min(10));
  assert.equal(lt.endTs, t2min(11) + 30_000);
  assert.equal(lt.turnSec, 90, '(60s+30s)/1000 = 90 → round1');
  assert.equal(lt.credits, 0.8);                                     // 0.3+0.5 round2
  assert.equal(lt.input, 1500); assert.equal(lt.output, 30);
  assert.equal(lt.cacheRead, 9000); assert.equal(lt.cacheCreate, 100);
  // billedOf：ratio 0.3 × 200000 = 60000（nb2 无 ratio 不计）→ billedSource runtime-config
  assert.equal(lt.billedInput, 60000);
  assert.equal(lt.billedSource, 'runtime-config');
  // outTps（T16）：分子 10+20 = 30 真值（output_tokens > 0，不估）；分母 = 重叠区间合并 30s → 1
  assert.equal(lt.outTok, 30);
  assert.equal(lt.outExact, true);
  assert.equal(lt.outTps, 1);
  assert.equal(lt.outTpsExact, true);
  assert.equal(lt.model, 'qfmodel');
  assert.equal(lt.modelName, null, 'modelName 由 server decorate 解析，scanner 层恒 null');
  // 全池无 prompt → null
  assert.equal(lastTurnOf([{ kind: 'usage', ts: 1, uuid: 'x', sessionId: 'S', input: 1, output: 1, cacheRead: 0, cacheCreate: 0, sub: false, credits: 1, model: null }], new Map()), null);
  // 末条无 model → model null（不向前找补）
  const tail = lastTurnOf([
    { kind: 'prompt', ts: t2min(0), uuid: 'p', sessionId: 'S' },
    { kind: 'usage', ts: t2min(1), uuid: 'a', sessionId: 'S', input: 1, output: 1, cacheRead: 0, cacheCreate: 0, sub: false, credits: 1, model: 'first' },
    { kind: 'usage', ts: t2min(2), uuid: 'b', sessionId: 'S', input: 1, output: 1, cacheRead: 0, cacheCreate: 0, sub: false, credits: 1, model: null },
  ], new Map());
  assert.equal(tail.model, null);
  // credits 全 null → null（诚实读数）；无可估算输出 → outTps null（不出 0 防误读）
  const nc = lastTurnOf([
    { kind: 'prompt', ts: t2min(0), uuid: 'p', sessionId: 'S' },
    { kind: 'usage', ts: t2min(1), uuid: 'a', sessionId: 'S', input: 1, output: 0, cacheRead: 0, cacheCreate: 0, sub: false, credits: null, model: 'm' },
  ], new Map());
  assert.equal(nc.credits, null);
  assert.equal(nc.outTps, null, '无估算输出 → null');
  // T16 轮级兜底：无日志的轮 → 轮端到端 − 已配对工具区间（toolSpans 第 4 参）；未传 → 纯墙钟
  const fbRecs = [
    { kind: 'prompt', ts: 1000, uuid: 'fp', sessionId: 'S-f' },
    { kind: 'usage', ts: 4000, uuid: 'fu', sessionId: 'S-f', input: 1, output: 0, cacheRead: 0, cacheCreate: 0, sub: false, credits: 1, model: 'm', outEst: 100 },
  ];
  assert.equal(lastTurnOf(fbRecs, new Map(), [{ sid: 'S-f', start: 1500, end: 3500 }]).outTps, 100, '轮 3s − 工具 2s = 纯模型 1s；100 tok ÷ 1s');
  assert.equal(lastTurnOf(fbRecs, new Map()).outTps, 33.3, '未传 spans → 纯墙钟 3s；100 ÷ 3 = 33.3');
  // P2 锁定：会话锚点按过滤后集合（usage max-ts 有效 sessionId，sessionStats 同规）——
  // 新会话仅 prompt、尚无 usage → 不夺锚点，回退到上一有完整轮的会话
  const q = lastTurnOf([
    { kind: 'prompt', ts: t2min(10), uuid: 'qp', sessionId: 'S-p' },
    { kind: 'usage', ts: t2min(11), uuid: 'qu', sessionId: 'S-p', input: 1, output: 1, cacheRead: 0, cacheCreate: 0, sub: false, credits: 1, model: 'm' },
    { kind: 'prompt', ts: t2min(20), uuid: 'qq', sessionId: 'S-q' },
  ], new Map());
  assert.equal(q.sessionId, 'S-p', '进行中会话（仅 prompt）不夺锚点');
  assert.equal(q.turnSec, 60, 'S-p 轮：prompt t2min(10) → usage t2min(11)');
});

// ---- T3：byModelOf 会话内按模型聚合 ----
test('T3 byModelOf: 轮参与 Set 去重；credits 求和/全 null→null；outTps = 真值优先÷实测秒（仅配对记录）；默认序 credits 降→turns 降→model 升', () => {
  const now = new Date(2026, 9, 10, 12, 0, 0).getTime();
  const recs = [
    { kind: 'prompt', ts: now - 10 * 60_000, uuid: 'p1', sessionId: 'S' },
    { kind: 'usage', ts: now - 9 * 60_000, uuid: 'u1', sessionId: 'S', input: 100, output: 30, cacheRead: 0, cacheCreate: 0, sub: false, credits: 1, model: 'B', outEst: 300, mt0: now - 9 * 60_000, mt1: now - 9 * 60_000 + 10_000 },
    { kind: 'usage', ts: now - 8 * 60_000, uuid: 'u2', sessionId: 'S', input: 50, output: 20, cacheRead: 0, cacheCreate: 0, sub: false, credits: 0.5, model: 'B', outEst: 300, mt0: now - 8 * 60_000, mt1: now - 8 * 60_000 + 20_000 },
    { kind: 'prompt', ts: now - 5 * 60_000, uuid: 'p2', sessionId: 'S' },
    { kind: 'usage', ts: now - 4 * 60_000, uuid: 'u3', sessionId: 'S', input: 10, output: 0, cacheRead: 0, cacheCreate: 0, sub: false, credits: null, model: 'A', outEst: 100 },
  ];
  const turns = buildTurns(recs);
  const rows = byModelOf(recs.filter((r) => r.kind !== 'prompt'), turns, new Map());
  assert.deepEqual(rows.map((r) => r.model), ['B', 'A'], 'B credits 1.5 > A null（垫底）');
  const B = rows[0];
  assert.equal(B.billingMode, 'credits');
  assert.equal(B.credits, 1.5);
  assert.equal(B.input, 150); assert.equal(B.output, 50);
  assert.equal(B.turns, 1, '同轮同模型两条记录只计 1 轮');
  assert.equal(B.avgTurnSec, 120, '单轮均值即该轮（p1→u2 120s）');
  assert.equal(B.outTps, 1.7, '真值 30+20 ÷ 配对秒 10+20 = 50/30 = 1.7');
  assert.equal(B.outTpsExact, true);
  assert.equal(B.billedInput, null, '无 ratio 记录 → null');
  const A = rows[1];
  assert.equal(A.credits, null, '全 null 诚实读数');
  assert.equal(A.turns, 1);
  assert.equal(A.avgTurnSec, 60, 'p2→u3 60s 单轮');
  assert.equal(A.outTps, null, '有估算但无配对日志 → null（模型组不兜底）');
  assert.equal(A.outTpsExact, null);
});

test('T3 回归: credits 原值求和后一次 round2（逐条 round2 会漂移，且 byModel 各行之和对不上 session 合计）', () => {
  const now = new Date(2026, 9, 10, 12, 0, 0).getTime();
  const mk = (i, credits, model = 'M') => ({ kind: 'usage', ts: now + 1000 * (i + 1), uuid: 'u' + i, sessionId: 'S', input: 1, output: 0, cacheRead: 0, cacheCreate: 0, sub: false, credits, model });
  // 逐条 round2 会把 0.004 抹成 0；Σ0.012 正确为 0.01
  const tiny = [{ kind: 'prompt', ts: now, uuid: 'p', sessionId: 'S' }, mk(0, 0.004), mk(1, 0.004), mk(2, 0.004)];
  assert.equal(lastTurnOf(tiny, new Map()).credits, 0.01, 'lastTurn: Σ0.012 → 0.01');
  assert.equal(byModelOf(tiny.filter((r) => r.kind !== 'prompt'), buildTurns(tiny), new Map())[0].credits, 0.01, 'byModel: 同规');
  // 真机量级形态：55 条 0.1x 记录，逐条 round2 会漂移数分
  const many = Array.from({ length: 55 }, (_, i) => mk(i, 0.1514 + (i % 3) * 0.001));
  const raw = many.reduce((a, r) => a + r.credits, 0);
  assert.equal(lastTurnOf([{ kind: 'prompt', ts: now, uuid: 'pm', sessionId: 'S' }, ...many], new Map()).credits, Math.round(raw * 100) / 100);
});


test('T3 回归: 同一份记录混入 prompt 后，aggregate 三窗与 dailyRows 与纯 usage 入参逐字节一致', () => {
  const now = new Date(2026, 9, 10, 12, 0, 0).getTime();
  const usage = [
    { kind: 'usage', ts: now - 20 * 60_000, uuid: 'g1', sessionId: 'S', input: 100, output: 10, cacheRead: 0, cacheCreate: 0, sub: false, credits: 0.5, ratio: 0.5 },
    { kind: 'usage', ts: now - 10 * 60_000, uuid: 'g2', sessionId: 'S', input: 50, output: 5, cacheRead: 0, cacheCreate: 0, sub: false, credits: 0.25, ratio: 0.25 },
  ];
  const withPrompts = [
    { kind: 'prompt', ts: now - 30 * 60_000, uuid: 'p1', sessionId: 'S' },
    ...usage,
    { kind: 'prompt', ts: now - 5 * 60_000, uuid: 'p2', sessionId: 'S' },
  ];
  const cm = new Map([['S', { contextWindow: 200000, model: 'qfmodel' }]]);
  // 过滤前：prompt 无 token 字段 → 求和 NaN → 本断言必炸；过滤后逐字节一致（spec §3.2 不变式）
  assert.deepEqual(aggregate(withPrompts, now, cm), aggregate(usage, now, cm), '混入 prompt 后三窗逐字节不变');
  assert.deepEqual(dailyRows(withPrompts), dailyRows(usage), 'dailyRows 逐字节不变');
});

// ---- T4：近 7 日/今日双列窗口 ----
test('T4 byModelWindowOf: 今日/7日双列；窗内轮参与（endTs≥windowStart）计 turns/avgTurnSec；越窗模型无行；默认序 7日降→model 升；空池 rows:[]', () => {
  const now = new Date(2026, 9, 10, 18, 0, 0).getTime();            // 10-10 18:00 本地
  const todayStart = new Date(2026, 9, 10, 0, 0, 0).getTime();
  const windowStart = new Date(2026, 9, 4, 0, 0, 0).getTime();      // todayStart − 6 天
  const at = (dayOffset, h) => new Date(2026, 9, 10 + dayOffset, h, 0, 0).getTime();
  const recs = [
    { kind: 'prompt', ts: at(-8, 9), uuid: 'pc1', sessionId: 'S-w' },                                  // 窗外的轮起点
    { kind: 'usage', ts: at(-8, 9) + 30_000, uuid: 'c1', sessionId: 'S-w', input: 999, output: 9, cacheRead: 0, cacheCreate: 0, sub: false, credits: 99, model: 'C' },
    { kind: 'prompt', ts: at(-2, 9), uuid: 'pa1', sessionId: 'S-w' },                                  // 轮2（10-08，窗内）
    { kind: 'usage', ts: at(-2, 9) + 60_000, uuid: 'a1', sessionId: 'S-w', input: 100, output: 10, cacheRead: 0, cacheCreate: 0, sub: false, credits: 2, model: 'A', outEst: 500, mt0: at(-2, 9) + 60_000, mt1: at(-2, 9) + 70_000 },
    { kind: 'prompt', ts: at(0, 8), uuid: 'pa2', sessionId: 'S-w' },                                   // 轮3（10-10 今日）
    { kind: 'usage', ts: at(0, 8) + 120_000, uuid: 'a2', sessionId: 'S-w', input: 300, output: 30, cacheRead: 0, cacheCreate: 0, sub: false, credits: 5, model: 'A', outEst: 500, mt0: at(0, 8) + 120_000, mt1: at(0, 8) + 130_000 },
    { kind: 'usage', ts: at(0, 8) + 180_000, uuid: 'a3', sessionId: 'S-w', input: 50, output: 5, cacheRead: 0, cacheCreate: 0, sub: false, credits: 1, model: 'B', outEst: 50, mt0: at(0, 8) + 180_000, mt1: at(0, 8) + 185_000 },
  ];
  const bw = byModelWindowOf(recs, new Map(), now);
  assert.equal(bw.windowStart, windowStart);
  assert.equal(bw.todayStart, todayStart);
  assert.equal(bw.windowStart + 6 * 86400000, bw.todayStart, '窗口恰为 7 天');
  assert.deepEqual(bw.rows.map((r) => r.model), ['A', 'B'], 'C 窗内无参与且无记录 → 无行');
  const A = bw.rows[0];
  assert.equal(A.billingMode, 'credits');
  assert.equal(A.credits7d, 7); assert.equal(A.creditsToday, 5);     // 2+5；仅 a2 在今日
  assert.equal(A.input, 400); assert.equal(A.output, 40);
  assert.equal(A.turns, 2, '轮2+轮3 各计 1（轮1 endTs 越窗排除）');
  assert.equal(A.avgTurnSec, 120, '(60s+180s)/2');
  assert.equal(A.outTps, 2, 'T16：真值 10+30 ÷ 配对秒 10+10 = 40/20 = 2');
  assert.equal(A.outTpsExact, true);
  assert.equal(A.billedInput, null);
  const B = bw.rows[1];
  assert.equal(B.credits7d, 1); assert.equal(B.creditsToday, 1);
  assert.equal(B.turns, 1); assert.equal(B.avgTurnSec, 180, '单轮即 p2→a3 180s');
  assert.equal(B.outTps, 1, 'T16：真值 5 ÷ 配对秒 5 = 1');
  assert.equal(B.outTpsExact, true);
  assert.deepEqual(byModelWindowOf([], new Map(), now), { windowStart, todayStart, rows: [] });
});

// ---- P3 T1: lastTurnOfSession（按 sid 取末轮；全局锚定行为必须逐值不变）----
test('P3 T1 lastTurnOfSession: 指定 sid 出该会话末轮；无该会话/空 sid → null；lastTurnOf 全局锚定不受影响', () => {
  const T = (min) => 1_760_000_000_000 + min * 60_000;
  const recs = [
    { kind: 'prompt', ts: T(0), uuid: 'p1', sessionId: 'S-a' },
    { kind: 'usage', ts: T(1), uuid: 'u1', sessionId: 'S-a', input: 100, output: 5, cacheRead: 0, cacheCreate: 0, sub: false, credits: 1.5, model: 'qfmodel' },
    { kind: 'prompt', ts: T(10), uuid: 'p2', sessionId: 'S-b' },
    { kind: 'usage', ts: T(12), uuid: 'u2', sessionId: 'S-b', input: 200, output: 20, cacheRead: 50, cacheCreate: 0, sub: false, credits: 0.25, model: 'dfmodel' },
  ];
  const cm = new Map();
  const a = lastTurnOfSession(recs, cm, 'S-a');
  assert.equal(a.sessionId, 'S-a');
  assert.equal(a.promptTs, T(0));
  assert.equal(a.endTs, T(1));
  assert.equal(a.turnSec, 60, '末轮 60s → round1 = 60');
  assert.equal(a.credits, 1.5);
  assert.equal(a.input, 100); assert.equal(a.output, 5);
  assert.equal(a.model, 'qfmodel');
  assert.equal(a.modelName, null, 'scanner 层恒 null（modelName 由 server decorate 解析）');
  assert.equal(lastTurnOfSession(recs, cm, 'S-missing'), null, '无该会话记录 → null（空态数据源）');
  assert.equal(lastTurnOfSession(recs, cm, ''), null, '空串 sid → null');
  assert.equal(lastTurnOfSession(recs, cm, null), null, 'null sid → null');
  // 全局锚定（spec §1 根因规则）必须一字不变：仍取过滤后集合 max-ts usage 所属会话
  const g = lastTurnOf(recs, cm);
  assert.equal(g.sessionId, 'S-b');
  assert.equal(g.credits, 0.25);
});

// ---- P3 T2: sessionStatsFor（按 sid 聚合；sessionStats 全局行为必须逐值不变）----
test('P3 T2 sessionStatsFor: 指定 sid 出该会话聚合；无该会话/空 sid → null；sessionStats 全局锚定不变', () => {
  const T = (min) => 1_760_000_000_000 + min * 60_000;
  const now = T(100);
  const recs = [
    { kind: 'prompt', ts: T(0), uuid: 'p1', sessionId: 'S-a' },
    { kind: 'usage', ts: T(1), uuid: 'u1', sessionId: 'S-a', input: 100, output: 5, cacheRead: 0, cacheCreate: 0, sub: false, credits: 1.5, model: 'qfmodel' },
    { kind: 'prompt', ts: T(10), uuid: 'p2', sessionId: 'S-b' },
    { kind: 'usage', ts: T(12), uuid: 'u2', sessionId: 'S-b', input: 200, output: 20, cacheRead: 50, cacheCreate: 0, sub: false, credits: 0.25, model: 'dfmodel' },
  ];
  const cm = new Map();
  const a = sessionStatsFor(recs, now, cm, 'S-a');
  assert.equal(a.id, 'S-a');
  assert.equal(a.credits, 1.5);
  assert.equal(a.turns, 1, 'turns = 该会话 usage 条数（prompt 不计）');
  assert.equal(a.input, 100); assert.equal(a.output, 5); assert.equal(a.cacheRead, 0);
  assert.ok(Array.isArray(a.byModel), 'byModel 形状与全局口径一致');
  assert.equal(a.byModel[0].model, 'qfmodel');
  assert.equal(sessionStatsFor(recs, now, cm, 'S-zzz'), null, '无该会话 usage → null（空态数据源）');
  assert.equal(sessionStatsFor(recs, now, cm, ''), null);
  assert.equal(sessionStatsFor(recs, now, cm, undefined), null);
  const g = sessionStats(recs, now, cm);
  assert.equal(g.id, 'S-b', '全局锚定仍是过滤后 max-ts 会话');
  assert.equal(g.credits, 0.25);
});

// ---- P3 #64：turnSec = 活动跨度（剔除轮内 >30min 空闲），全空闲轮 null ----
test('P3 #64 buildTurns: 轮内 >30min 空闲不计入 turnSec；全空闲轮 → null（测不出就 --，绝不编 0 或 4 小时）', () => {
  const T = (min) => 1_760_000_000_000 + min * 60_000;
  const p = (min) => ({ kind: 'prompt', ts: T(min), uuid: `p${min}`, sessionId: 'S-x' });
  const u = (min) => ({ kind: 'usage', ts: T(min), uuid: `u${min}`, sessionId: 'S-x',
    input: 1, output: 1, cacheRead: 0, cacheCreate: 0, sub: false, credits: 0.1, model: 'm' });
  assert.equal(buildTurns([p(0), u(10), u(20)])[0].turnSec, 1200, '两段各 10min 均 ≤30min → 活动跨度 20min');
  assert.equal(buildTurns([p(0), u(10), u(882)])[0].turnSec, 600, '872min 跨夜空闲段剔除，只剩 10min 活动跨度');
  assert.equal(buildTurns([p(0), u(240)])[0].turnSec, null, '唯一一段即空闲 → null');
});

test('P3 #64 sessionStatsFor/byModelOf: totalTurnSec 与 avgTurnSec 只计有计时的轮；回合数仍按参与轮计', () => {
  const T = (min) => 1_760_000_000_000 + min * 60_000;
  const p = (min) => ({ kind: 'prompt', ts: T(min), uuid: `p${min}`, sessionId: 'S' });
  const u = (min) => ({ kind: 'usage', ts: T(min), uuid: `u${min}`, sessionId: 'S',
    input: 10, output: 1, cacheRead: 0, cacheCreate: 0, sub: false, credits: 1, model: 'm1' });
  const recs = [p(0), u(10), p(100), u(102), p(200), u(500)];
  const st = sessionStatsFor(recs, T(600), new Map(), 'S');
  assert.equal(st.totalTurnSec, 720, '600 + 120，第三轮 null 不计');
  assert.equal(st.byModel[0].turns, 3, '回合数按参与轮计（含无计时轮）');
  assert.equal(st.byModel[0].avgTurnSec, 360, '时延/回合 = (600+120)/2 个有计时的轮');
});

// ---------------------------------------------------------------- 原生样式数据面（2026-10-26）
// 用户裁定：底栏对齐 Qoder 原生统计条 + 悬停摘要卡。数据面新增：
//  - 工具调用数/失败数（tool_use + tool_result.is_error，按 tool id 配对）；
//  - 代码变更 +/− 行数与文件数（仅 Edit/Write/MultiEdit；Bash 改文件不可重建 → 不计）；
//  - 思考/正文/工具三段输出估算；请求数（request_id 去重）；会话时间范围；真实缓存命中率。

test('toolStatsOf: 调用/失败按工具名分组（calls 降序→name 升序）；Edit/Write/MultiEdit 聚合行数与文件并集；无编辑 → edits null', () => {
  const ev = (o) => ({ sid: 'S-a', ts: 1_760_000_000_000, name: 'Bash', err: false, add: 0, del: 0, file: null, ...o });
  const events = [
    ev({ name: 'Edit', add: 4, del: 3, file: '/p/a.js' }),
    ev({ name: 'Bash', err: true }),
    ev({ name: 'Write', add: 2, del: 0, file: '/p/b.js' }),
    ev({ name: 'Read' }),
    ev({ name: 'Edit', add: 1, del: 1, file: '/p/a.js' }), // 同文件 → files 并集仍 2
    ev({ name: 'MultiEdit', add: 2, del: 2, file: '/p/c.js' }),
    ev({ sid: 'S-other', name: 'Bash', err: true }),       // 其他会话不串味
    null, { name: 42 },                                    // 乱值忽略
  ];
  const s = toolStatsOf(events, 'S-a');
  assert.equal(s.calls, 6);
  assert.equal(s.errors, 1);
  assert.deepEqual(s.byName, [
    { name: 'Edit', calls: 2, errors: 0 },
    { name: 'Bash', calls: 1, errors: 1 },
    { name: 'MultiEdit', calls: 1, errors: 0 },
    { name: 'Read', calls: 1, errors: 0 },
    { name: 'Write', calls: 1, errors: 0 },
  ]);
  assert.deepEqual(s.edits, { added: 9, removed: 6, files: 3 });
  // 无编辑类工具 → null（呈现 '--'，绝不补 +0/−0）；无事件/缺 sid → 空形状
  assert.equal(toolStatsOf([ev({ name: 'Bash' })], 'S-a').edits, null);
  assert.deepEqual(toolStatsOf([], 'S-a'), { calls: 0, errors: 0, byName: [], edits: null });
  assert.deepEqual(toolStatsOf(undefined, 'S-a'), { calls: 0, errors: 0, byName: [], edits: null });
  assert.deepEqual(toolStatsOf(events, ''), { calls: 0, errors: 0, byName: [], edits: null }, '缺 sid → 不猜会话');
});

test('原生样式数据面 sessionStatsFor: rounds/requests/cacheHitRate/时间范围/三段估算/tools/edits；缺 toolEvents 兼容旧调用面', () => {
  const T = (min) => 1_760_000_000_000 + min * 60_000;
  const records = [
    { kind: 'prompt', ts: T(0), uuid: 'p1', sessionId: 'S-a' },
    { kind: 'usage', ts: T(2), uuid: 'u1', sessionId: 'S-a', rid: 'r1', input: 100, output: 10, cacheRead: 900, cacheCreate: 100,
      sub: false, credits: 1, model: 'm', outEst: 60, outEstThk: 20, outEstTxt: 30, outEstCall: 10 },
    { kind: 'usage', ts: T(4), uuid: 'u2', sessionId: 'S-a', rid: 'r1', input: 50, output: 5, cacheRead: 0, cacheCreate: 0,
      sub: false, credits: 0, model: 'm', outEst: 25, outEstThk: 5, outEstTxt: 10, outEstCall: 10 }, // 同一 request 的第二行
    { kind: 'usage', ts: T(6), uuid: 'u3', sessionId: 'S-a', rid: null, input: 10, output: 1, cacheRead: 0, cacheCreate: 0,
      sub: false, credits: null, model: 'm', outEst: 9.4, outEstTxt: 9.4 },                            // 缺 request_id → 记 1 次
    { kind: 'usage', ts: T(3), uuid: 'z1', sessionId: 'S-b', rid: 'rx', input: 1, output: 1, cacheRead: 1, cacheCreate: 1,
      sub: false, credits: 1, model: 'm' },
  ];
  const events = [
    { sid: 'S-a', ts: T(2), name: 'Edit', err: false, add: 4, del: 3, file: '/p/a.js' },
    { sid: 'S-a', ts: T(3), name: 'Bash', err: true, add: 0, del: 0, file: null },
    { sid: 'S-a', ts: T(4), name: 'Write', err: false, add: 2, del: 0, file: '/p/b.js' },
    { sid: 'S-b', ts: T(4), name: 'Bash', err: false, add: 0, del: 0, file: null },
  ];
  const s = sessionStatsFor(records, T(100), new Map(), 'S-a', events);
  assert.equal(s.rounds, 1, 'rounds = buildTurns 轮数（1 个 prompt → 1 轮），不是 usage 行数');
  assert.equal(s.turns, 3, 'turns 旧字段语义不变（usage 行数）');
  assert.equal(s.requests, 2, 'r1 两行去重为 1 + 缺 rid 记录各计 1');
  assert.equal(s.cacheHitRate, 900 / (160 + 900 + 100), 'cacheRead /(input+cacheRead+cacheCreate)；分母非 0');
  assert.equal(s.firstTs, T(2));
  assert.equal(s.lastTs, T(6));
  assert.deepEqual([s.outEstThk, s.outEstTxt, s.outEstCall], [25, 49, 20], '三段各自取整；25+49+20 = outEst 94');
  assert.equal(s.outEst, 94);
  assert.equal(s.tools.calls, 3, 'S-b 的工具不串味');
  assert.equal(s.tools.errors, 1);
  assert.deepEqual(s.tools.byName.map((x) => x.name), ['Bash', 'Edit', 'Write']);
  assert.deepEqual(s.edits, { added: 6, removed: 3, files: 2 });
  // 旧调用面（不传 toolEvents）→ 空工具/编辑形状（不抛、不猜）；真实 token 全零 → cacheHitRate null
  const bare = sessionStatsFor(records, T(100), new Map(), 'S-a');
  assert.deepEqual(bare.tools, { calls: 0, errors: 0, byName: [] });
  assert.equal(bare.edits, null);
  const zero = sessionStatsFor([
    { kind: 'usage', ts: T(1), uuid: 'q1', sessionId: 'S-z', input: 0, output: 0, cacheRead: 0, cacheCreate: 0, sub: false, credits: 1, model: 'm' },
  ], T(100), new Map(), 'S-z');
  assert.equal(zero.cacheHitRate, null, 'credits 口径无真实缓存 token → null（呈现隐藏，不补 0%）');
  // 全局锚定调用的透传：sessionStats(第 4 参) → 当前会话 tools/edits
  const g = sessionStats(records, T(100), new Map(), events);
  assert.equal(g.id, 'S-a');
  assert.equal(g.tools.calls, 3);
});