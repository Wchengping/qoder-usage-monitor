// tests/store.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qum-'));
process.env.QUM_HOME = TMP;
const {
  home, mergeDaily, atomicWrite, loadHistory, saveHistory,
  loadScanCache, saveScanCache, loadTimingCache, saveTimingCache, writeToken, readToken, saveBootstrap, loadBootstrap,
} = await import('../daemon/store.mjs');

test('mergeDaily: derived overrides stored same day, stale stored kept', () => {
  const stored = [{ date: '2026-10-08', input: 5 }, { date: '2026-10-09', input: 1 }];
  const derived = [{ date: '2026-10-09', input: 9 }];
  const m = mergeDaily(derived, stored);
  assert.deepEqual(m.map(r => [r.date, r.input]), [['2026-10-08', 5], ['2026-10-09', 9]]);
});

test('atomicWrite roundtrip + 0600 + history jsonl', () => {
  atomicWrite(path.join(TMP, 'x'), 'hi');
  assert.equal(fs.readFileSync(path.join(TMP, 'x'), 'utf8'), 'hi');
  saveHistory([{ date: '2026-10-09', input: 1 }]);
  assert.equal(loadHistory()[0].input, 1);
});

test('token + bootstrap persist and load', () => {
  writeToken(); assert.match(readToken(), /^[0-9a-f]{64}$/);
  saveBootstrap('abc123'); assert.equal(loadBootstrap().code, 'abc123');
});

// —— 额外覆盖 ——

test('mergeDaily: main/sub 等字段整体取 derived 行（whole-row replace，非 deep merge）', () => {
  const stored = [{ date: '2026-10-09', input: 1, main: { input: 1, legacy: 'x' }, sub: { input: 0 } }];
  const derived = [{ date: '2026-10-09', input: 9, main: { input: 9 } }];
  const m = mergeDaily(derived, stored);
  assert.equal(m.length, 1);
  assert.deepEqual(m[0], derived[0]); // 合并结果 = derived 行本身，stored 的字段不残留
});

test('loadHistory: 跳过坏行（非法 JSON / 非对象 / 无 date），保留好行', () => {
  fs.appendFileSync(path.join(TMP, 'history.jsonl'), 'not json\n{"date":"2026-10-10"}\n[1,2]\n{"noDate":1}\n');
  const rows = loadHistory();
  assert.deepEqual(rows.map(r => r.date), ['2026-10-09', '2026-10-10']);
});

test('atomicWrite: 文件模式恒为 0600（含覆盖已有普通权限文件）', () => {
  const p = path.join(TMP, 'secret');
  atomicWrite(p, 'a');
  assert.equal(fs.statSync(p).mode & 0o777, 0o600);
  fs.chmodSync(p, 0o644);
  atomicWrite(p, 'b');
  assert.equal(fs.statSync(p).mode & 0o777, 0o600);
});

test('home: QUM_HOME 多级不存在目录递归创建（lazy per call）', () => {
  const nested = path.join(TMP, 'deep', 'deeper', 'deepest');
  const prev = process.env.QUM_HOME;
  try {
    process.env.QUM_HOME = nested;
    assert.equal(home(), nested);
    assert.equal(fs.statSync(nested).isDirectory(), true);
  } finally {
    process.env.QUM_HOME = prev;
  }
});

test('scan cache roundtrip + 缺省为空结构', () => {
  assert.deepEqual(loadScanCache(), { files: {}, records: [] });
  const cache = { files: { '/p/a.jsonl': { size: 10, mtimeMs: 5 } }, records: [{ ts: 1 }] };
  saveScanCache(cache);
  assert.deepEqual(loadScanCache(), cache);
});

test('readToken/loadBootstrap: 文件不存在时返回 null', () => {
  const fresh = path.join(TMP, 'fresh-home');
  const prev = process.env.QUM_HOME;
  try {
    process.env.QUM_HOME = fresh;
    assert.equal(readToken(), null);
    assert.equal(loadBootstrap(), null);
    assert.deepEqual(loadHistory(), []);
  } finally {
    process.env.QUM_HOME = prev;
  }
});

// ---- T12 credits 校准：mergeDaily 整行替换语义下 mixed 行（新行有 credits / 旧行缺）不得崩溃 ----

test('mergeDaily: derived 新行带 credits 与 stored 旧行缺 credits 混合 —— 无崩溃、值保留、旧行字段缺席即 null 语义', () => {
  const stored = [{ date: '2026-10-08', input: 5, main: { input: 5 } }]; // legacy 行：无 credits
  const derived = [{ date: '2026-10-09', input: 9, credits: 3.2, main: { input: 9, credits: 3.2 }, sub: { input: 0, credits: 0 } }];
  const m = mergeDaily(derived, stored);
  assert.deepEqual(m.map((r) => r.date), ['2026-10-08', '2026-10-09']);
  assert.equal(m[1].credits, 3.2); // derived 行原样保留
  assert.equal(m[1].main.credits, 3.2);
  assert.equal('credits' in m[0], false); // 旧行不虚构 credits —— 消费侧按 undefined/null 呈现 '--'
  // 反向：stored 带 credits、derived（同日）也带 → derived 整行覆盖，stored 的 credits 不残留
  const m2 = mergeDaily(
    [{ date: '2026-10-09', input: 1, credits: 0.5 }],
    [{ date: '2026-10-09', input: 2, credits: 9.9 }],
  );
  assert.equal(m2[0].credits, 0.5);
});

test('saveHistory/loadHistory roundtrip 保留 credits（jsonl 无损）', () => {
  saveHistory([
    { date: '2026-10-09', input: 0, output: 0, credits: 2.41, main: { credits: 2.41 }, sub: { credits: 0 } },
    { date: '2026-10-10', input: 10, output: 1, credits: null },
  ]);
  const rows = loadHistory();
  assert.equal(rows[0].credits, 2.41);
  assert.equal(rows[0].main.credits, 2.41);
  assert.equal(rows[1].credits, null); // null 显式落盘、回读仍是 null（与缺席区分）
});

// ---- 版本门（P2 v2：记录池加 prompt 行；T16 v3：记录增补 outEst/rid + toolSpans；
//      原生样式 v4：条目增补 toolEvents；P0 准确性 v5：记录增补 billable）----
test('scan-cache 版本门 v5: 无 v / 旧 v(v1..v4) / 非对象 → 空结构；v:5 往返保留（含 toolEvents）且有 v 落盘、load 剥离', () => {
  const file = path.join(TMP, 'scan-cache.json'); // = QUM_HOME/scan-cache.json（load/save 无参，走 inHome）
  // 旧包（P1 格式，无 v）→ 空
  fs.writeFileSync(file, JSON.stringify({ files: { a: { mtime: 1, size: 2 } }, records: [{ ts: 1 }] }));
  assert.deepEqual(loadScanCache(), { files: {}, records: [] });
  // 乱 v → 空
  fs.writeFileSync(file, JSON.stringify({ v: 1, files: { a: {} }, records: [{ ts: 1 }] }));
  assert.deepEqual(loadScanCache(), { files: {}, records: [] });
  // P2 的 v:2 包（缺 outEst/rid/toolSpans）→ 作废
  fs.writeFileSync(file, JSON.stringify({ v: 2, files: { a: {} }, records: [{ ts: 1 }] }));
  assert.deepEqual(loadScanCache(), { files: {}, records: [] });
  // T16 的 v:3 包（缺 toolEvents）→ 原生样式数据面作废，强制全量重扫
  fs.writeFileSync(file, JSON.stringify({ v: 3, files: { a: {} }, records: [{ ts: 1 }] }));
  assert.deepEqual(loadScanCache(), { files: {}, records: [] });
  // 原生样式的 v:4 包（记录缺 billable）→ P0 准确性作废，强制全量重扫
  fs.writeFileSync(file, JSON.stringify({ v: 4, files: { a: {} }, records: [{ ts: 1 }] }));
  assert.deepEqual(loadScanCache(), { files: {}, records: [] });
  // v:5 正例：往返保留（条目 toolEvents 原样通过）且有 v 落盘、load 剥离
  const toolEvents = [{ sid: 'S', ts: 9, name: 'Edit', err: false, add: 2, del: 1, file: '/p/a.js' }];
  saveScanCache({ files: { b: { mtime: 3, size: 4, toolEvents } }, records: [{ ts: 5, uuid: 'x' }] });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).v, 5);
  assert.deepEqual(loadScanCache(), { files: { b: { mtime: 3, size: 4, toolEvents } }, records: [{ ts: 5, uuid: 'x' }] });
  // 落盘 0600（atomicWrite 纪律）
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

// ---- T16：timing-cache（qodercli.log 计时配对增量缓存）----
test('timing-cache roundtrip + 缺省空结构 + 版本门 + 0600', () => {
  assert.deepEqual(loadTimingCache(), { files: {}, pairs: {} }); // 文件不存在 → 空
  const cache = { files: { '/log/a.log': { pos: 123 } }, pairs: { 'rid-1': [1000, 2500], 'rid-2': [null, 900] } };
  saveTimingCache(cache);
  assert.deepEqual(loadTimingCache(), cache); // 缺 start 侧的 [null, ts] 如实回读
  const file = path.join(TMP, 'timing-cache.json');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).v, 1);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  // 旧/坏包 → 空
  fs.writeFileSync(file, JSON.stringify({ v: 99, pairs: { x: [1, 2] } }));
  assert.deepEqual(loadTimingCache(), { files: {}, pairs: {} });
});
