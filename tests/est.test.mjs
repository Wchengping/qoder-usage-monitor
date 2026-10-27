// tests/est.test.mjs — T16 正文估算 Output + 实测纯模型秒（daemon/est.mjs）
// 口径锚点（credits-overlay.py 移植 + 2026-10-27 校准）：est = CJK×1.3 + 其余÷3；三类块（thinking/text/tool_use）
// 按 block_text 累加；<synthetic> 整条跳过（scanner 层）；速率 = est ÷ 实测秒，无可估算/无秒 → null。
import test from 'node:test';
import assert from 'node:assert/strict';
import { estTokens, blockText, estOutOfContent, estBreakdownOfContent, parseTimingLine, mergeIntervalMs, rateTps } from '../daemon/est.mjs';
import { parseJsonlLine, parseJsonObject } from '../daemon/scanner.mjs';

test('estTokens: CJK×1.3 + 其余÷3（2026-10-27 对原生显示两样本标定）；空/非串 → 0', () => {
  assert.equal(estTokens('abcd'), 4 / 3);        // 4 ÷ 3
  assert.equal(estTokens('你好'), 2.6);            // 2 × 1.3
  assert.equal(estTokens('你好ab'), 2.6 + 2 / 3); // 2×1.3 + 2÷3
  assert.equal(estTokens('，。'), 2.6);            // CJK 标点入 CJK 桶（探针校准同范围）
  assert.equal(estTokens(''), 0);
  assert.equal(estTokens(null), 0);
  assert.equal(estTokens(42), 0);
  // 混排常见形态：ASCII 注释 + 中文说明
  assert.equal(estTokens('const x = 1; // 变量'), 16 / 3 + 2.6); // 16 ASCII ÷3 + 2 CJK ×1.3
});

test('blockText: thinking→thinking / text→text / tool_use→input JSON；其余块与缺字段 → 空串', () => {
  assert.equal(blockText({ type: 'thinking', thinking: '想' }), '想');
  assert.equal(blockText({ type: 'text', text: '答' }), '答');
  assert.equal(blockText({ type: 'tool_use', input: { a: 1 } }), '{"a":1}');
  assert.equal(blockText({ type: 'tool_use' }), '{}', '缺 input 序列化为 {}（不抛）');
  assert.equal(blockText({ type: 'redacted_thinking', data: 'x' }), '', '未知块类型不计');
  assert.equal(blockText(null), '');
  assert.equal(blockText({ type: 'text', text: 42 }), '', '乱字段不计');
});

test('estOutOfContent: 数组仅三类块累加；字符串整串估算；缺席/乱值 → 0', () => {
  const blocks = [
    { type: 'thinking', thinking: '你好你好' },           // 4×1.3 = 5.2
    { type: 'text', text: 'abcd' },                       // 4÷3
    { type: 'tool_use', input: { k: 'v' } },              // '{"k":"v"}' 9÷3
    { type: 'image', source: {} },                        // 不计
    'not-a-block', null,
  ];
  assert.equal(estOutOfContent(blocks), 5.2 + 4 / 3 + 9 / 3);
  assert.equal(estOutOfContent('你好'), 2.6, '字符串 content 整串估算');
  assert.equal(estOutOfContent(undefined), 0);
  assert.equal(estOutOfContent({}), 0);
});

// 原生样式悬停卡「输出（含思考）」需要三段拆分（thinking/正文/工具调用），
// 口径与 estOutOfContent 完全同源：thk+txt+call 必须等于合计（浮点同序相加，逐值相等）。
test('estBreakdownOfContent: thinking/text/tool_use 三类分桶；合计与 estOutOfContent 一致；字符串→txt；乱值→全 0', () => {
  const blocks = [
    { type: 'thinking', thinking: '你好你好' }, // 4×1.3 = 5.2
    { type: 'text', text: 'abcd' },             // 4÷3
    { type: 'tool_use', input: { k: 'v' } },    // 9÷3
    { type: 'image', source: {} },              // 不计
    null, 'x',
  ];
  const b = estBreakdownOfContent(blocks);
  assert.deepEqual(b, { thk: 5.2, txt: 4 / 3, call: 9 / 3 });
  assert.equal(b.thk + b.txt + b.call, estOutOfContent(blocks), '三段合计 = 既有合计（同源同序）');
  assert.deepEqual(estBreakdownOfContent('你好'), { thk: 0, txt: 2.6, call: 0 });
  assert.deepEqual(estBreakdownOfContent(undefined), { thk: 0, txt: 0, call: 0 });
  assert.deepEqual(estBreakdownOfContent({}), { thk: 0, txt: 0, call: 0 });
  // 真实 assistant message.content：thinking + text + tool_use 混排
  assert.deepEqual(estBreakdownOfContent([
    { type: 'thinking', thinking: 'abcde' },   // 5÷3
    { type: 'text', text: '好' },              // 1.3
    { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }, // '{"command":"ls"}' 16÷3
  ]), { thk: 5 / 3, txt: 1.3, call: 16 / 3 });
});

test('rateTps: est ÷ 秒 round1；无可估算输出/无秒/非有限 → null（绝不 0/NaN/Infinity）', () => {
  assert.equal(rateTps(100, 1000), 100);
  assert.equal(rateTps(1500, 4000), 375);       // 1500 tok ÷ 4s = 375 tps
  assert.equal(rateTps(100, 1001), 99.9, 'round1：99.900… → 99.9');
  assert.equal(rateTps(0, 1000), null, '0 估算 → null（防误读卡死）');
  assert.equal(rateTps(100, 0), null);
  assert.equal(rateTps(100, -5), null);
  assert.equal(rateTps(NaN, 1000), null);
  assert.equal(rateTps(100, NaN), null);
});

test('mergeIntervalMs: 重叠/相接并段求和；[lo,hi] 夹紧（轮墙钟裁剪）；零长/乱值丢弃', () => {
  assert.equal(mergeIntervalMs([[0, 10], [5, 15]]), 15, '重叠合并（并发不重复计时）');
  assert.equal(mergeIntervalMs([[0, 10], [10, 20]]), 20, '相接并段');
  assert.equal(mergeIntervalMs([[0, 10], [20, 30]]), 20, '不相接各自计');
  assert.equal(mergeIntervalMs([[0, 100]], 10, 30), 20, '夹到 [lo,hi]');
  assert.equal(mergeIntervalMs([[5, 5]]), 0, '零长区间丢弃');
  assert.equal(mergeIntervalMs([[20, 30]], 0, 10), 0, '夹后为空 → 0');
  assert.equal(mergeIntervalMs([null, 'x', [1]]), 0, '乱值丢弃');
  assert.equal(mergeIntervalMs([]), 0);
});

test('parseTimingLine: qodercli.log 计时行 → {kind, ts, rid}；非计时行/坏行 → null', () => {
  const start = '2026-10-14T18:46:03.881+08:00 INFO  [session=00000000-0000-4000-8000-000000000001 turn=00000000-0000-4000-8000-000000000002 loop=00000000-0000-4000-8000-000000000002:1 request=00000000-0000-4000-8000-000000000003] model.request.started request_index=1 request_id="00000000-0000-4000-8000-000000000003" model="qfmodel" request_message_count=887 tool_schema_count=26';
  const end = '2026-10-14T18:47:10.377+08:00 INFO  [session=00000000 turn=t loop=t:1 request=r] model.response.completed request_index=1 request_id="00000000-0000-4000-8000-000000000003" provider="qoder" model="qfmodel" stop_reason="tool_use" content_block_count=3 input_tokens=0 output_tokens=0';
  const s = parseTimingLine(start);
  assert.equal(s.kind, 'start');
  assert.equal(s.rid, '00000000-0000-4000-8000-000000000003');
  assert.equal(s.ts, Date.parse('2026-10-14T18:46:03.881+08:00'));
  const e = parseTimingLine(end);
  assert.equal(e.kind, 'end');
  assert.ok(e.ts > s.ts, 'completed ts 晚于 started');
  // 无 [session=…] 前缀的旧形态同样识别（前缀可选）
  const bare = parseTimingLine('2026-10-14T18:46:03.881+08:00 INFO model.request.started request_id="abc-123" model="qfmodel"');
  assert.deepEqual(bare, { kind: 'start', ts: Date.parse('2026-10-14T18:46:03.881+08:00'), rid: 'abc-123' });
  // 干扰行：普通文本（get_models request started 是空格形态，无 model.request. 事件名）→ null
  assert.equal(parseTimingLine('2026-10-14T18:45:25.059+08:00 INFO  debug.message [HeadlessSession] get_models request started request_id=noutsgp96n fetch_strategy=cache'), null);
  assert.equal(parseTimingLine(''), null);
  assert.equal(parseTimingLine(null), null);
  assert.equal(parseTimingLine('2026-10-14T18:46:03.881+08:00 INFO model.request.started model="qfmodel"'), null, '缺 request_id → null');
  assert.equal(parseTimingLine('not-a-date INFO model.request.started request_id="x"'), null, '坏 ts → null');
});

// ---- scanner 侧 T16 装配：outEst / rid / <synthetic> 整条跳过 ----

const asstLine = (extra = {}) => JSON.stringify({
  type: 'assistant', uuid: 'a1', sessionId: 'S', timestamp: new Date(1_760_000_000_000).toISOString(),
  message: {
    role: 'assistant', model: 'qfmodel', id: 'msg_1',
    usage: { input_tokens: 1, output_tokens: 0, request_id: 'rid-1', credits: 0.5 },
    content: [{ type: 'text', text: '你好世界' }],
    ...extra,
  },
});

test('parseJsonlLine T16: outEst（行内块估算）+ rid（日志配对键）+ 三段拆分字段', () => {
  const r = parseJsonlLine(asstLine());
  assert.equal(r.outEst, 4 * 1.3, '「你好世界」4 CJK × 1.3');
  assert.equal(r.rid, 'rid-1');
  // 原生样式悬停卡：输出按 思考/正文/工具 三段拆分（行内块；server 按 message.id 归并整消息）
  assert.equal(r.outEstThk, 0);
  assert.equal(r.outEstTxt, 4 * 1.3);
  assert.equal(r.outEstCall, 0);
  const mixed = parseJsonlLine(asstLine({ content: [
    { type: 'thinking', thinking: 'abcd' },     // 4÷3
    { type: 'text', text: 'efgh' },              // 4÷3
    { type: 'tool_use', input: { a: 1 } },       // '{"a":1}' 7÷3
  ] }));
  assert.equal(mixed.outEst, 4 / 3 + 4 / 3 + 7 / 3);
  assert.deepEqual([mixed.outEstThk, mixed.outEstTxt, mixed.outEstCall], [4 / 3, 4 / 3, 7 / 3]);
  assert.equal(parseJsonlLine(asstLine({ usage: { input_tokens: 1 } })).rid, null, '缺 request_id → null');
  // 无 usage 行不产记录（整消息估算由 server 两趟合并归并，见 server.test）
  assert.equal(parseJsonObject({ type: 'assistant', timestamp: '2026-10-10T00:00:00Z', message: { id: 'm', content: [{ type: 'text', text: 'x' }] } }), null);
});

test('<synthetic> 伪条目整条跳过（credits-overlay 同规，不贡献估算/用量）', () => {
  const syn = JSON.stringify({
    type: 'assistant', uuid: 's1', sessionId: 'S', timestamp: new Date(1_760_000_000_000).toISOString(),
    message: {
      role: 'assistant', model: '<synthetic>', id: 'msg_syn', stop_reason: 'stop_sequence',
      usage: { input_tokens: 0, output_tokens: 0 },
      content: [{ type: 'text', text: '<synthetic> 伪输出' }],
    },
  });
  assert.equal(parseJsonlLine(syn), null, '整条跳过（含带 usage 的形态）');
});
