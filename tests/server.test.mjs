// tests/server.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(),'qumd-'));
const PROJ = path.join(TMP,'projects','ws'); fs.mkdirSync(PROJ,{recursive:true});
// fixture.jsonl 内保存的是写入时刻的 now-1min/now-3h/now-9h ISO 串；
// 测试在运行时按“与 fixture 最新时间戳的偏移”重打时间戳到当前时刻，
// 保证窗口断言（f1+f2 在 5h 窗内、f3 在窗外）在任何日期执行都成立。
{
  const lines = fs.readFileSync(new URL('./fixture.jsonl',import.meta.url),'utf8')
    .split('\n').filter(Boolean).map((l)=>JSON.parse(l));
  const anchor = Math.max(...lines.map((o)=>Date.parse(o.timestamp)));
  const now = Date.now();
  for (const o of lines) o.timestamp = new Date(now-(anchor-Date.parse(o.timestamp))).toISOString();
  // T16：assistant 行补 message.id / 正文块 / request_id（估算分子 + qodercli.log 配对键）。
  // f1 另写一条同 message.id 的**无 usage 行**（正文 'abcd'）→ e2e 验证整消息估算归并：
  // 该行不产记录，est 6.53 = 5.2(你好世界) + 4÷3(abcd) 全部落到 f1.outEst。f2/f3 不给 message.id
  // → 走"行内 est"路径，两条路径同 e2e 覆盖。
  const asst = lines.filter((o) => o.type === 'assistant'); // [f1 qfmodel, f2 mimo, f3 mimo]
  const withT16 = (o, { mid, rid, content }) => {
    if (mid) o.message.id = mid;
    o.message.content = content;
    o.message.usage.request_id = rid;
  };
  withT16(asst[0], { mid: 'msg-f1', rid: 'rid-f1', content: [{ type: 'text', text: '你好世界' }] }); // est 5.2
  withT16(asst[1], { rid: 'rid-f2', content: [{ type: 'text', text: 'abcdefgh' }] });                // est 8÷3
  withT16(asst[2], { rid: 'rid-f3', content: [{ type: 'thinking', thinking: '12345678' }] });        // est 8÷3
  lines.splice(1, 0, {
    type: 'assistant', uuid: 'f1b', sessionId: 'sess-cur', timestamp: asst[0].timestamp, isSidechain: false,
    message: { role: 'assistant', model: 'qfmodel', id: 'msg-f1', content: [{ type: 'text', text: 'abcd' }] },
  });
  // 原生样式数据面（2026-10-26）：工具调用/失败/编辑行数。全部是**无 usage** 的 assistant 行与
  // tool_result 行 → 不产 usage 记录（窗口/历史聚合逐值不变），只进 readRecords 的 toolEvents。
  // Edit：old 3 行 → new 4 行（+4/−3）；Bash：is_error → 失败 1；Write：content 2 行（+2/−0）；
  // files 并集 = /p/a.js + /p/b.js = 2。时间放在 u1 prompt 之后、f1 之前（真实轮内位置）。
  const curTs = Date.parse(asst[0].timestamp);
  const at = (msOff) => new Date(curTs + msOff).toISOString();
  lines.push(
    { type: 'assistant', uuid: 'tl1', sessionId: 'sess-cur', timestamp: at(-70_000), isSidechain: false,
      message: { role: 'assistant', model: 'qfmodel', id: 'msg-tools-1', content: [
        { type: 'tool_use', id: 'tu-edit', name: 'Edit', input: { file_path: '/p/a.js', old_string: 'a\nb\nc', new_string: 'a\nB\nC\nD' } },
        { type: 'tool_use', id: 'tu-bash', name: 'Bash', input: { command: 'ls' } },
      ] } },
    { type: 'user', uuid: 'tl2', sessionId: 'sess-cur', timestamp: at(-69_000), message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tu-edit', content: 'ok' } ] } },
    { type: 'user', uuid: 'tl3', sessionId: 'sess-cur', timestamp: at(-68_000), message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tu-bash', content: 'boom', is_error: true } ] } },
    { type: 'assistant', uuid: 'tl4', sessionId: 'sess-cur', timestamp: at(-60_000), isSidechain: false,
      message: { role: 'assistant', model: 'qfmodel', id: 'msg-tools-2', content: [
        { type: 'tool_use', id: 'tu-write', name: 'Write', input: { file_path: '/p/b.js', content: 'x\ny' } },
      ] } },
    { type: 'user', uuid: 'tl5', sessionId: 'sess-cur', timestamp: at(-59_000), message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tu-write', content: 'ok' } ] } },
  );
  fs.writeFileSync(path.join(PROJ,'s1.jsonl'), lines.map((o)=>JSON.stringify(o)).join('\n')+'\n');
  // T16 计时日志（qodercli.log 形态）：logsRoot = dirname(QUM_PROJECTS_DIR)/logs = TMP/projects/logs。
  // f1 区间落在其轮窗 [u1, f1] 内（f1−5s → f1−1.9s，3.1s）→ 6.53 ÷ 3.1 = 2.1 tps；
  // f2/f3 各 1s 且相隔 6h（不重叠）→ mimo 组 (8÷3 + 8÷3)÷(1+1) = 2.7 tps。
  const iso = (ms) => new Date(ms).toISOString().replace('Z', '+00:00');
  const ev = (kind, rid, ms, model, sid) =>
    `${iso(ms)} INFO  [session=${sid} turn=${rid} loop=${rid}:1 request=${rid}] model.${kind} request_index=1 request_id="${rid}" model="${model}" stop_reason="end_turn"\n`;
  const f1Ts = Date.parse(asst[0].timestamp);
  const f2Ts = Date.parse(asst[1].timestamp);
  const f3Ts = Date.parse(asst[2].timestamp);
  const logDir = path.join(TMP, 'projects', 'logs', 'runs', 'r1');
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, 'qodercli.log'),
    ev('request.started', 'rid-f1', f1Ts - 5000, 'qfmodel', 'sess-cur') +
    ev('response.completed', 'rid-f1', f1Ts - 1900, 'qfmodel', 'sess-cur') +
    ev('request.started', 'rid-f2', f2Ts, 'mimo-v2.6-flash', 'sess-prev') +
    ev('response.completed', 'rid-f2', f2Ts + 1000, 'mimo-v2.6-flash', 'sess-prev') +
    ev('request.started', 'rid-f3', f3Ts, 'mimo-v2.6-flash', 'sess-prev') +
    ev('response.completed', 'rid-f3', f3Ts + 1000, 'mimo-v2.6-flash', 'sess-prev'));
}
let PORT = 49800 + (process.pid % 100);
if (PORT === 49863) PORT = 49864; // 避让 quotaPick.test.mjs 的 E2E 固定端口（brief 指定 49863）
// 静态根可测性：QUM_APP_DIR / QUM_HARNESS_DIR 覆盖（默认 repo app/ 与 tests/harness/，同计划“路径可测性”约定）
const APPD = path.join(TMP,'app'); fs.mkdirSync(APPD,{recursive:true});
fs.writeFileSync(path.join(APPD,'widget.js'),'export const qum=1;');
fs.writeFileSync(path.join(APPD,'widget.css'),'body{}');
fs.writeFileSync(path.join(APPD,'secret.txt'),'nope');
const HARD = path.join(TMP,'harness'); fs.mkdirSync(HARD,{recursive:true});
fs.writeFileSync(path.join(HARD,'index.html'),'<!doctype html><title>qum harness</title>');
const HOME = path.join(TMP,'home'); fs.mkdirSync(HOME,{recursive:true});
fs.writeFileSync(path.join(HOME,'.history.json.dead.tmp'),'leaked tmp'); // daemon 启动须清扫
const env = {...process.env, QUM_HOME:HOME, QUM_PROJECTS_DIR:PROJ, QUM_APP_DIR:APPD, QUM_HARNESS_DIR:HARD, QUM_DEV:'1'};
const srv = spawn(process.execPath,['daemon/server.mjs','--port',String(PORT)],{env,stdio:'ignore'});
test.after(()=>{ srv.kill('SIGKILL'); fs.rmSync(TMP,{recursive:true,force:true}); });

const get = (p,headers={}) => fetch(`http://127.0.0.1:${PORT}${p}`,{headers});
async function waitUp(){ for(let i=0;i<60;i++){ try{ if((await get('/health')).ok) return; }catch{} await new Promise(r=>setTimeout(r,200)); } throw new Error('daemon not up'); }

test('health ok, state needs auth', async ()=>{
  await waitUp();
  assert.equal((await get('/health')).ok, true);
  assert.equal((await get('/state')).status, 401);
});
test('/dev/manifest: dev 模式（QUM_DEV=1）免 token，返回仓库 app/ 的实时指纹', async ()=>{
  await waitUp();
  const res = await get('/dev/manifest');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*', 'loader(file://) 跨源读取需要 ACAO');
  const m = await res.json();
  assert.equal(m.enabled, true);
  assert.equal(m.dir, APPD, '必须是 daemon 实际使用的静态根（QUM_APP_DIR 覆盖生效）');
  assert.match(m.rev, /^[0-9a-f]{12}$/);
});
test('生产态（无 QUM_DEV）：/dev/manifest 与 dev 静态根一律 404，不暴露仓库路径/源码', async ()=>{
  const PORT_NODEV = 49912;
  const HOME_NODEV = path.join(TMP,'home-nodev'); fs.mkdirSync(HOME_NODEV,{recursive:true});
  const e = {...process.env, QUM_HOME:HOME_NODEV, QUM_PROJECTS_DIR:PROJ, QUM_APP_DIR:APPD, QUM_HARNESS_DIR:HARD};
  delete e.QUM_DEV;
  const s = spawn(process.execPath,['daemon/server.mjs','--port',String(PORT_NODEV)],{env:e,stdio:'ignore'});
  try {
    const g = (p) => fetch(`http://127.0.0.1:${PORT_NODEV}${p}`);
    let up = false;
    for (let i = 0; i < 60; i++) {
      try { if ((await g('/health')).ok) { up = true; break; } } catch { /* 未就绪 */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(up, true, 'production daemon not up');
    assert.equal((await g('/dev/manifest')).status, 404);
    assert.equal((await g('/app/widget.js')).status, 404);
    assert.equal((await g('/harness/')).status, 404);
    assert.equal((await g('/state')).status, 401); // 关 dev 通道不影响鉴权边界
  } finally {
    s.kill('SIGKILL');
  }
});
test('bootstrap exchanges for token, state aggregates fixture', async ()=>{
  await waitUp();
  const boot = JSON.parse(fs.readFileSync(path.join(env.QUM_HOME,'bootstrap.json'),'utf8')).code;
  const res = await get('/state?bootstrap='+boot);
  assert.equal(res.status,200);
  const token = res.headers.get('x-qm-token'); assert.ok(token && token.length===64);
  const st = await res.json();
  assert.equal(st.local.window5h.input, 3000);            // f1+f2（f3 在窗外）
  assert.equal(st.local.window5h.byAgent.sub.output, 20); // f2
  // T12 credits：publish 对窗口对象整体透传（无字段白名单）——credits 必须原样到达 widget 侧
  assert.equal(st.local.window5h.credits, 1.3);           // f1(0.8)+f2(0.5)，round2
  assert.equal(st.local.window5h.byAgent.main.credits, 0.8);
  assert.equal(st.local.window5h.byAgent.sub.credits, 0.5);
  // Session strip：publish 增补 local.session = sessionStats(records, now, ctxMeta)——fixture 最新
  // 活跃会话为 f1（sess-cur，重打戳后即 now）：credits 0.8、1 回合、速率 0.8/30 round2=0.03、
  // billedInput=0.5×180000(runtime-config 真值)=90000、avgTurnSec null（单回合 <2 合格 gap）、
  // model='qfmodel'（runtime-config 顶层）、tps30=0.5×180000/1800=50（近30分钟窗口内）、
  // T16 生成速度：outTps30 = 窗内已配对 **真值** 10（usage.output_tokens）÷ 日志配对 3.1s = 3.2；
  // outEst = round(6.53) = 7（纯估算合计，保留）；outTok = 10（真值优先）、outExact = true。
  // byModel/totalTurnSec（T6 终值）：fixture 已补 u1 prompt 行（f1−76100ms）与 f1 model →
  // byModel 单行 qfmodel（turns 1、单轮均值 = round(76.1) = 76、outTps 同 3.2）；totalTurnSec = 76。
  // 原生样式数据面（2026-10-26）：rounds=轮数（1）；requests=rid 去重（f1 一条 rid-f1）；
  // cacheHitRate=8000/(1000+8000+100)；tools/edits 来自 fixture 的 3 次工具调用（Bash 失败 1、
  // Edit +4/−3、Write +2/−0、文件并集 2）；输出三段：f1 整消息归并只有正文 6.53 → txt 7。
  // 时间范围退化到一个点（fixture 仅一条本会话 usage）——单独断言，避免钉死动态时间戳。
  const { firstTs: sessFirstTs, lastTs: sessLastTs, ...sessRest } = st.local.session;
  assert.deepEqual(sessRest, { id: 'sess-cur', credits: 0.8, creditsBillable: null, creditsFree: null, turns: 1, rateCpm30: 0.03, rateCpm30Billable: null, billedInput: 90000, avgTurnSec: null, model: 'qfmodel', modelName: null, tps30: 50, billingMode: 'credits', input: 1000, output: 10, outEst: 7, outTok: 10, outExact: true, cacheRead: 8000, cacheCreate: 100, tps30Tokens: Math.round((9100 / 1800) * 10) / 10, outTps30: 3.2, outTps30Exact: true, byModel: [{ model: 'qfmodel', modelName: null, billingMode: 'credits', credits: 0.8, creditsBillable: null, creditsFree: null, input: 1000, output: 10, cacheRead: 8000, cacheCreate: 100, billedInput: 90000, billedSource: 'runtime-config', turns: 1, outTps: 3.2, outTpsExact: true, avgTurnSec: 76 }], totalTurnSec: 76, rounds: 1, requests: 1, cacheHitRate: 8000 / 9100, outEstThk: 0, outEstTxt: 7, outEstCall: 0, tools: { calls: 3, errors: 1, byName: [{ name: 'Bash', calls: 1, errors: 1 }, { name: 'Edit', calls: 1, errors: 0 }, { name: 'Write', calls: 1, errors: 0 }] }, edits: { added: 6, removed: 3, files: 2 } });
  assert.equal(sessFirstTs, sessLastTs, '单条 usage → 时间范围退化到一个点（不编造）');
  // 计费口径（用户裁定）：内置模型 fixture（有 credits、token 字段虽非零但 credits 优先）→ credits。
  assert.equal(st.local.billingMode, 'credits');
  // 计费输入 tokens（派生真值）：窗口级 = Σ ratio×contextWindow（f1 runtime 90000 +
  // f2 sess-prev 表缺 → 200k 兜底 50000 = 140000，source mixed）；byAgent 子形状保持原样。
  assert.equal(st.local.window5h.billedInput, 140000);
  assert.equal(st.local.window5h.billedInputSource, 'mixed');
  assert.equal(st.local.window5h.byAgent.main.billedInput, undefined);
  // local.contextWindow（兜底来源的数据面，UI 不显示估算符号）：当前会话命中 runtime-config 真值
  assert.deepEqual(st.local.contextWindow, { value: 180000, source: 'runtime-config' });
  // 会话明细（sessionsSummary）：≤10、lastTs 降序；sess-cur（f1）在前、sess-prev（f2/f3）随后。
  assert.deepEqual(st.local.sessions.map((s) => s.id), ['sess-cur', 'sess-prev']);
  assert.deepEqual({ ...st.local.sessions[0], lastTs: 0 }, {
    id: 'sess-cur', model: 'qfmodel', modelName: null, credits: 0.8, creditsBillable: null, creditsFree: null,
    billedInput: 90000,
    billedSource: 'runtime-config', turns: 1, rounds: 1, requests: 1, lastTs: 0, avgTurnSec: null,
    billingMode: 'credits', input: 1000, output: 10, cacheRead: 8000, cacheCreate: 100,
    // T6 终值（同 session pin；sessionsSummary 行无 totalTurnSec）；T16 outTps = 真值 10 ÷ 3.1s = 3.2
    byModel: [{ model: 'qfmodel', modelName: null, billingMode: 'credits', credits: 0.8, creditsBillable: null, creditsFree: null, input: 1000, output: 10, cacheRead: 8000, cacheCreate: 100, billedInput: 90000, billedSource: 'runtime-config', turns: 1, outTps: 3.2, outTpsExact: true, avgTurnSec: 76 }],
  });
  assert.ok(st.local.sessions[0].lastTs >= st.local.sessions[1].lastTs, 'lastTs 降序');
  assert.equal(st.local.sessions[1].billedSource, 'fallback200k'); // sess-prev 无 runtime-config
  assert.equal(st.local.sessions[1].model, null); // 无 runtime-config → model null（旧缓存兼容）
  assert.equal(st.local.sessions[1].turns, 2); // f2 + f3
  assert.ok(st.meta.generatedAt>0);
  // 第二次纯 token 访问
  const r2 = await get('/state',{'x-qm-token':token}); assert.equal(r2.status,200);
});
test('ingest quota stored raw + Host spoof blocked', async ()=>{
  await waitUp();
  const boot = JSON.parse(fs.readFileSync(path.join(env.QUM_HOME,'bootstrap.json'),'utf8')).code;
  const token = (await get('/state?bootstrap='+boot)).headers.get('x-qm-token');
  const post = await fetch(`http://127.0.0.1:${PORT}/ingest/quota`,{method:'POST',
    headers:{'content-type':'application/json','x-qm-token':token},
    body:JSON.stringify({planQuota:{used:750,total:900}})});
  assert.equal(post.status,202);
  const st = await (await get('/state',{'x-qm-token':token})).json();
  assert.equal(st.account.raw.planQuota.used, 750);
  // Node fetch(undici) 会静默重写自定义 Host 头，伪造 Host 必须走 raw http client 才能真正发到服务端
  const bad = await new Promise((resolve,reject)=>{
    const rq=http.request({host:'127.0.0.1',port:PORT,path:'/health',headers:{Host:'evil.com'}},
      (r)=>{ r.resume(); resolve(r.statusCode); });
    rq.on('error',reject); rq.end();
  });
  assert.equal(bad,403);
});
// ---- P2：lastTurn / byModelWindow / emptyState（须在 catalog ingest 测试之前——后者的 decorate
// 会把 modelName 解析成 'Qoder Model'，本块按「未 ingest catalog → null」锚定未解析态）----
test('P2: local.lastTurn 为 sess-cur 最新一轮（turnSec 76.1/credits 0.8/billedInput 90000/outTps=真值10÷实测3.1s=3.2）；时间戳相对关系', async () => {
  await waitUp();
  const boot = JSON.parse(fs.readFileSync(path.join(env.QUM_HOME, 'bootstrap.json'), 'utf8')).code;
  const token = (await get('/state?bootstrap=' + boot)).headers.get('x-qm-token');
  const st = await (await get('/state', { 'x-qm-token': token })).json();
  const lt = st.local.lastTurn;
  assert.ok(lt && typeof lt === 'object', 'lastTurn 必须就绪');
  assert.equal(lt.sessionId, 'sess-cur');
  assert.equal(lt.model, 'qfmodel');
  assert.equal(lt.modelName, null, '未 ingest catalog → null');
  assert.equal(lt.turnSec, 76.1);
  assert.equal(lt.endTs - lt.promptTs, 76100);
  assert.equal(lt.credits, 0.8);
  assert.equal(lt.input, 1000); assert.equal(lt.output, 10);
  assert.equal(lt.cacheRead, 8000); assert.equal(lt.cacheCreate, 100);
  assert.equal(lt.billedInput, 90000);
  assert.equal(lt.billedSource, 'runtime-config');
  assert.equal(lt.billingMode, 'credits');
  assert.equal(lt.outTok, 10);
  assert.equal(lt.outExact, true);
  assert.equal(lt.outTps, 3.2); // T16：真值 10 ÷ 实测配对 3.1s（夹轮墙钟内）= 3.2
  assert.equal(lt.outTpsExact, true);
});

test('P2: local.byModelWindow 双列——守恒 Σcredits7d=1.6；qfmodel 行确定；mimo 行 turns 0/outTps=真值50÷实测2s=25/今日列时刻相关', async () => {
  await waitUp();
  const boot = JSON.parse(fs.readFileSync(path.join(env.QUM_HOME, 'bootstrap.json'), 'utf8')).code;
  const token = (await get('/state?bootstrap=' + boot)).headers.get('x-qm-token');
  const st = await (await get('/state', { 'x-qm-token': token })).json();
  const bw = st.local.byModelWindow;
  assert.ok(bw && typeof bw === 'object', 'byModelWindow 必须就绪');
  assert.equal(bw.windowStart + 6 * 86400000, bw.todayStart);
  assert.equal(bw.rows.length, 2);
  assert.deepEqual(bw.rows.map((r) => r.model), ['mimo-v2.6-flash', 'qfmodel'], 'credits7d 同 0.8 → model 升序');
  const sum7 = bw.rows.reduce((a, r) => a + (typeof r.credits7d === 'number' ? r.credits7d : 0), 0);
  assert.equal(Math.round(sum7 * 100) / 100, 1.6, '守恒：qfmodel 0.8 + mimo 0.8');
  const q = bw.rows.find((r) => r.model === 'qfmodel');
  assert.equal(q.creditsToday, 0.8); // f1 为重打戳锚点（max ts → now）→ 恒今日
  assert.equal(q.credits7d, 0.8);
  assert.equal(q.input, 1000); assert.equal(q.output, 10);
  assert.equal(q.cacheRead, 8000); assert.equal(q.cacheCreate, 100);
  assert.equal(q.billedInput, 90000); assert.equal(q.billedSource, 'runtime-config');
  assert.equal(q.turns, 1); assert.equal(q.avgTurnSec, 76); assert.equal(q.outTps, 3.2);
  assert.equal(q.outTpsExact, true);
  assert.equal(q.billingMode, 'credits');
  const m = bw.rows.find((r) => r.model === 'mimo-v2.6-flash');
  assert.equal(m.credits7d, 0.8);
  assert.ok([null, 0.5, 0.8].includes(m.creditsToday), 'f2/f3 跨午夜与否取决于运行时刻');
  assert.equal(m.input, 5000); assert.equal(m.output, 50);
  assert.equal(m.cacheRead, 24000);
  assert.equal(m.billedInput, 50000); assert.equal(m.billedSource, 'fallback200k');
  assert.equal(m.turns, 0, 'sess-prev 无 prompt 记录 → 无轮参与');
  assert.equal(m.avgTurnSec, null);
  assert.equal(m.outTps, 25, 'T16：真值 20+30 ÷ 配对秒 1s+1s（f2/f3 相隔 6h 不重叠）= 25');
  assert.equal(m.outTpsExact, true);
});

test('P2: emptyState() 导出且含 P2 默认字段', async () => {
  const { emptyState } = await import('../daemon/server.mjs');
  const st = emptyState();
  assert.equal(st.local.lastTurn, null);
  assert.deepEqual(st.local.byModelWindow, { windowStart: null, todayStart: null, rows: [] });
  assert.equal(st.local.session, null, 'P1 语义保留：首轮 scan 前无会话统计（只增不改）');
  assert.deepEqual(st.local.sessions, []);
});
test('T14: models catalog ingest → state.modelCatalog trim + local.modelCatalogMeta + session/sessions modelName 解析（raw 不含目录）', async ()=>{
  await waitUp();
  const boot = JSON.parse(fs.readFileSync(path.join(env.QUM_HOME,'bootstrap.json'),'utf8')).code;
  const token = (await get('/state?bootstrap='+boot)).headers.get('x-qm-token');
  const models = [
    { modelKey:'qoder/qfmodel', modelDisplayName:'Qoder Model', typeDisplayName:'Built-in', byok:false, extraField:'drop-me', availableContextWindows:[200000] },
    { modelKey:'11111111-1111-4111-8111-111111111111', modelDisplayName:'DeepSeek-Flash', typeDisplayName:'BYOK', byok:true },
    'garbage', 42, null, [],
  ];
  const post = await fetch(`http://127.0.0.1:${PORT}/ingest/quota`,{method:'POST',
    headers:{'content-type':'application/json','x-qm-token':token},
    body:JSON.stringify({ usage:{ qoderUsage:{ addOnQuota:{ remaining:5 } } }, models })});
  assert.equal(post.status,202);
  const st = await (await get('/state',{'x-qm-token':token})).json();
  // 目录只留四字段、丢非对象、带 fetchedAt
  assert.deepEqual(st.modelCatalog.entries, [
    { modelKey:'qoder/qfmodel', modelDisplayName:'Qoder Model', typeDisplayName:'Built-in', byok:false },
    { modelKey:'11111111-1111-4111-8111-111111111111', modelDisplayName:'DeepSeek-Flash', typeDisplayName:'BYOK', byok:true },
  ]);
  assert.equal(typeof st.modelCatalog.fetchedAt,'number');
  assert.deepEqual(st.local.modelCatalogMeta, { count:2, fetchedAt:st.modelCatalog.fetchedAt });
  // session(===sess-cur, model 'qfmodel') 经斜杠后缀规则解析；id 原样保留；sess-prev model null → null
  assert.equal(st.local.session.modelName,'Qoder Model');
  assert.equal(st.local.session.model,'qfmodel');
  assert.deepEqual(st.local.sessions.map((s)=>[s.model,s.modelName]),
    [['qfmodel','Qoder Model'],[null,null]]);
  // 目录不入 raw（quota-history 尺寸保护）：account.raw 与磁盘 state.json 均无 models
  assert.equal(st.account.raw.models, undefined);
  assert.equal(st.account.raw.usage.qoderUsage.addOnQuota.remaining, 5);
  const disk = JSON.parse(fs.readFileSync(path.join(env.QUM_HOME,'state.json'),'utf8'));
  assert.equal(disk.account.raw.models, undefined);
  assert.equal(disk.modelCatalog.entries.length, 2);
  // P2：decorate 贯通四新字段 modelName
  const st2 = await (await get('/state', { 'x-qm-token': token })).json();
  assert.equal(st2.local.lastTurn.modelName, 'Qoder Model');
  assert.deepEqual(st2.local.session.byModel.map((r) => r.modelName), ['Qoder Model']);
  assert.deepEqual(st2.local.sessions.map((s) => s.byModel.map((r) => r.modelName)), [['Qoder Model'], [null]]);
});
test('--ensure is idempotent against live server', async ()=>{
  await waitUp();
  const r = await new Promise(res=>{
    const p=spawn(process.execPath,['daemon/server.mjs','--ensure','--port',String(PORT)],{env});
    let o='';p.stdout.on('data',d=>o+=d);p.on('close',c=>res({c,o}));
  });
  assert.match(r.o, /already-running/); assert.equal(r.c,0);
});

// ---- Controller 裁定扩展（超出 brief 逐行测试的部分）----
test('static /app allowlist + traversal guard; /harness serves without token（dev 模式）', async ()=>{
  await waitUp();
  const js = await get('/app/widget.js'); assert.equal(js.status,200);
  assert.match(js.headers.get('content-type'), /javascript/);
  assert.equal((await get('/app/widget.css')).status,200);
  assert.equal((await get('/app/secret.txt')).status,404);           // 非白名单扩展名
  const trav = await fetch(`http://127.0.0.1:${PORT}/app/${encodeURIComponent('../home/escape.js')}`);
  assert.equal(trav.status,403);                                     // 路径穿越拒绝
  const idx = await get('/harness/'); assert.equal(idx.status,200);   // 无 token
  assert.match(await idx.text(), /qum harness/);
});
test('quota-history hourly throttle + state.json disk snapshot', async ()=>{
  await waitUp();
  const boot = JSON.parse(fs.readFileSync(path.join(env.QUM_HOME,'bootstrap.json'),'utf8')).code;
  const token = (await get('/state?bootstrap='+boot)).headers.get('x-qm-token');
  await fetch(`http://127.0.0.1:${PORT}/ingest/quota`,{method:'POST',
    headers:{'content-type':'application/json','x-qm-token':token},
    body:JSON.stringify({planQuota:{used:750,total:900}})});        // 本 test 内第 2 次 ingest（第 1 次在上一 test）
  const rows = fs.readFileSync(path.join(env.QUM_HOME,'quota-history.jsonl'),'utf8').trim().split('\n');
  assert.equal(rows.length,1);                                       // 两次间隔 <1h → 只落 1 行
  const st = JSON.parse(fs.readFileSync(path.join(env.QUM_HOME,'state.json'),'utf8'));
  assert.equal(st.account.raw.planQuota.used,750);
  assert.equal(st.meta.daemonVersion,'0.1.0');
  assert.equal(st.external,null);
});
test('startup swept leaked .tmp files in QUM_HOME', async ()=>{
  await waitUp();
  assert.equal(fs.existsSync(path.join(env.QUM_HOME,'.history.json.dead.tmp')), false);
});

// ---- Task 10 carry-ins ----
test('T7 carry-in: runEnsure respawn argv preserves --qm-role marker', async ()=>{
  // main 有 invokedDirectly 守卫：import 不会副作用拉起 daemon
  const { respawnArgs } = await import('../daemon/server.mjs');
  const out = respawnArgs(49789, ['--ensure','--port','49789','--qm-role=qum-daemon']);
  assert.equal(out[1],'--port'); assert.equal(out[2],'49789');
  assert.ok(out.includes('--qm-role=qum-daemon'),
    'respawned command line must carry the marker, or pkill -f qum-daemon misses keep-alived daemons');
  assert.ok(!out.includes('--ensure'), 'must not re-run the ensure flow in the child');
  assert.equal(out.filter((a)=>String(a).startsWith('--port')).length, 1); // 旧 --port 值对被剔除，无重复
  assert.deepEqual(respawnArgs(1, ['--port=9','--ensure','--x=1']),
    [respawnArgs(1,['--port=9'])[0],'--port','1','--x=1']); // --port= 形式同样剔除
});
test('T4 carry-in: quota ingest disk write failure → 500 JSON, daemon survives (no crash)', async ()=>{
  await waitUp();
  const boot = JSON.parse(fs.readFileSync(path.join(env.QUM_HOME,'bootstrap.json'),'utf8')).code;
  const token = (await get('/state?bootstrap='+boot)).headers.get('x-qm-token');
  // 注入失败：把已存在的 quota-history.jsonl 换成目录 → appendPrivateLine 同步抛 EISDIR
  // （与 EACCES/ENOSPC 同路径：任何 fs 写盘异常都必须被 handler 捕获）
  const QH = path.join(env.QUM_HOME,'quota-history.jsonl');
  fs.rmSync(QH,{force:true});
  fs.mkdirSync(QH,{recursive:true});
  const post = await fetch(`http://127.0.0.1:${PORT}/ingest/quota`,{method:'POST',
    headers:{'content-type':'application/json','x-qm-token':token},
    body:JSON.stringify({quota_summary:{used_value:1,total_value:2}})});
  assert.equal(post.status,500);
  assert.deepEqual(await post.json(),{error:'quota-store-failed'});
  // daemon 未被打死：服务照常
  assert.equal((await get('/health')).ok, true);
  const st = await (await get('/state',{'x-qm-token':token})).json();
  // 失败的 ingest 不留半成品：仍是此前 throttle 测试成功 ingest 的旧快照
  assert.equal(st.account.raw.planQuota.used, 750);
  assert.equal(st.account.raw.quota_summary, undefined);
  assert.equal(st.account.fetchedAt > 0, true);
  // 现场恢复：留个目录会让后续所有 ingest 用例都 500（P3 T12b 就是这样被误伤的）。
  // appendPrivateLine 会在下次成功 ingest 时重建该文件，这里只需清掉注入物。
  fs.rmSync(QH, { recursive: true, force: true });
});


// ---------------------------------------------------------------- 计费口径切换（BYOK 会话端到端）
// 真机形态：自定义 BYOK 模型（qoder-custom-<uuid>/…）的 assistant 记录**不写 credits 字段**，
// 只有真实 token（input/output/cache_read/cache_creation）。用户裁定"只跟随当前会话口径"：
// 这类会话下 daemon 必须把 local.billingMode 置为 'tokens'，并把真实 token 与真实吞吐
// （tps30Tokens/outTps30，非 billedInput 估算）发到 state，供呈现层整体切换口径。
test('BYOK 会话 → local.billingMode=tokens + 真实 token 四元组 + tps30Tokens/outTps30（独立 daemon，端口 49911）', async () => {
  const TMP2 = fs.mkdtempSync(path.join(os.tmpdir(), 'qumdt-'));
  const PROJ2 = path.join(TMP2, 'projects', 'ws'); fs.mkdirSync(PROJ2, { recursive: true });
  const HOME2 = path.join(TMP2, 'home'); fs.mkdirSync(HOME2, { recursive: true });
  const now = Date.now();
  const rec = (minAgo, u) => JSON.stringify({
    type: 'assistant', uuid: `b${minAgo}`, sessionId: 'S-byok', isSidechain: false,
    timestamp: new Date(now - minAgo * 60_000).toISOString(), message: { role: 'assistant', usage: u },
  });
  fs.writeFileSync(path.join(PROJ2, 'byok.jsonl'), [
    rec(20, { input_tokens: 5000, output_tokens: 300, cache_read_input_tokens: 90000, cache_creation_input_tokens: 1000, context_usage_ratio: 0.5 }),
    rec(3, { input_tokens: 2000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, context_usage_ratio: 0.1 }),
  ].join('\n') + '\n');
  const PORT2 = 49911; // 避开 49800+pid%100 动态段与 49857/49863/49864/49865/49866/49789
  const srv2 = spawn(process.execPath, ['daemon/server.mjs', '--port', String(PORT2)], {
    env: { ...process.env, QUM_HOME: HOME2, QUM_PROJECTS_DIR: PROJ2 }, stdio: 'ignore',
  });
  try {
    const g = (p) => fetch(`http://127.0.0.1:${PORT2}${p}`);
    for (let i = 0; i < 60; i++) { try { if ((await g('/health')).ok) break; } catch { /* 未就绪 */ } await new Promise((r) => setTimeout(r, 200)); }
    const boot = JSON.parse(fs.readFileSync(path.join(HOME2, 'bootstrap.json'), 'utf8')).code;
    const st = await (await g(`/state?bootstrap=${boot}`)).json();
    assert.equal(st.local.billingMode, 'tokens', 'BYOK 会话 → 全 state 口径切 tokens');
    assert.equal(st.local.session.billingMode, 'tokens');
    assert.equal(st.local.session.input, 7000);
    assert.equal(st.local.session.output, 500);
    assert.equal(st.local.session.cacheRead, 90000);
    assert.equal(st.local.session.cacheCreate, 1000);
    assert.equal(st.local.session.credits, 0, '无 credits 字段的会话 → 0（诚实读数，非 null）');
    assert.equal(st.local.session.tps30Tokens, Math.round((98000 / 1800) * 10) / 10);
    // 输出：真实 usage.output_tokens 合计（500），无正文块也无妨；无日志配对 → 速率 null。
    assert.equal(st.local.session.outTok, 500);
    assert.equal(st.local.session.outExact, true, '全部来自真实 output_tokens');
    assert.equal(st.local.session.outTps30, null, '无日志配对 → -- tps');
    assert.equal(st.local.sessions[0].billingMode, 'tokens', '会话明细行带自身口径');
    // 窗口求和天然分口径：BYOK 记录不贡献 credits，内置记录不贡献 token → 今日两列各自干净
    assert.equal(st.local.today.credits, 0);
    assert.equal(st.local.today.input, 7000);
  } finally {
    srv2.kill('SIGKILL');
    fs.rmSync(TMP2, { recursive: true, force: true });
  }
});

// 子代理转录在 projects/[ws]/[session]/subagents/*.jsonl：usage 独立于父会话、uuid 无重叠。
// 只扫一/两层会漏掉这部分真实用量；递归扫描后必须计入且不重复（合计 = 父 + 子）。
test('subagents/ 嵌套转录递归纳入统计（父会话合计不漏子代理用量）', async () => {
  const TMP3 = fs.mkdtempSync(path.join(os.tmpdir(), 'qumds-'));
  const PROJ3 = path.join(TMP3, 'projects', 'ws'); fs.mkdirSync(PROJ3, { recursive: true });
  const SUB = path.join(PROJ3, 'S-parent', 'subagents'); fs.mkdirSync(SUB, { recursive: true });
  const HOME3 = path.join(TMP3, 'home'); fs.mkdirSync(HOME3, { recursive: true });
  const now = Date.now();
  const rec = (uuid, minAgo, credits, output) => JSON.stringify({
    type: 'assistant', uuid, sessionId: 'S-parent', isSidechain: uuid === 'child-1',
    timestamp: new Date(now - minAgo * 60_000).toISOString(),
    message: { role: 'assistant', model: 'dfmodel', id: `msg-${uuid}`, content: [{ type: 'text', text: 'hi' }], usage: {
      input_tokens: 0, output_tokens: output, credits, billable: false,
    } },
  });
  fs.writeFileSync(path.join(PROJ3, 'parent.jsonl'), rec('parent-1', 5, 2.5, 30) + '\n');
  fs.writeFileSync(path.join(SUB, 'agent-x.jsonl'), rec('child-1', 4, 1.5, 20) + '\n');
  const PORT3 = 49913;
  const srv3 = spawn(process.execPath, ['daemon/server.mjs', '--port', String(PORT3)], {
    env: { ...process.env, QUM_HOME: HOME3, QUM_PROJECTS_DIR: PROJ3 }, stdio: 'ignore',
  });
  try {
    const g = (p) => fetch(`http://127.0.0.1:${PORT3}${p}`);
    for (let i = 0; i < 60; i++) { try { if ((await g('/health')).ok) break; } catch { /* 未就绪 */ } await new Promise((r) => setTimeout(r, 200)); }
    const boot = JSON.parse(fs.readFileSync(path.join(HOME3, 'bootstrap.json'), 'utf8')).code;
    const st = await (await g(`/state?bootstrap=${boot}`)).json();
    assert.equal(st.local.window5h.credits, 4, '父 2.5 + 子代理 1.5');
    assert.equal(st.local.window5h.output, 50, '父 30 + 子代理 20（无重复）');
    assert.equal(st.local.session.credits, 4);
    assert.equal(st.local.session.turns, 2);
    assert.equal(st.local.session.outTok, 50);
    assert.equal(st.local.session.outExact, true, '两条都是真实 output_tokens');
    assert.equal(st.local.session.outTps30, null, '无日志配对 → -- tps');
    assert.equal(st.local.sessions.length, 1, '子代理用量归入同一 sessionId');
  } finally {
    srv3.kill('SIGKILL');
    fs.rmSync(TMP3, { recursive: true, force: true });
  }
});

// ---- P2 T14：verify-p2.mjs 对账脚本 smoke（真实 daemon + fixture 独立复算）
test('P2 对账脚本：verify-p2.mjs 独立复算 /state → exit 0「对账通过」；死端口 → exit 1（绝不静默假绿）', async () => {
  await waitUp();
  const { execFile } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const script = fileURLToPath(new URL('../scripts/verify-p2.mjs', import.meta.url));
  const run = (port) => new Promise((resolve) => {
    execFile(process.execPath, [script, '--port', String(port)], { env, timeout: 20000 },
      (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
  });
  const r1 = await run(PORT);
  assert.equal(r1.code, 0, `verify 应对账全通过\nstdout=${r1.stdout}\nstderr=${r1.stderr}`);
  assert.match(r1.stdout, /对账通过/);
  const r2 = await run(49865); // doctor.test 专用死端口（无 daemon 监听；只 fetch 不 bind）
  assert.equal(r2.code, 1, '取数失败必须非零退出');
  assert.match(`${r2.stdout}${r2.stderr}`, /ECONNREFUSED|取数失败/i);
});

// ---- P3 T3: buildActive 纯函数（请求态 active 形状 + modelName 解析 + 三态区分）----
test('P3 T3 buildActive: 无 sid → null（不加字段）；未知 sid → 两值 null；有记录 → 解析 modelName（含 byModel 行）', async () => {
  const { buildActive } = await import('../daemon/server.mjs');
  const T = (min) => 1_760_000_000_000 + min * 60_000;
  const records = [
    { kind: 'prompt', ts: T(0), uuid: 'p1', sessionId: 'S-a' },
    { kind: 'usage', ts: T(1), uuid: 'u1', sessionId: 'S-a', input: 100, output: 5, cacheRead: 0, cacheCreate: 0,
      sub: false, credits: 1.5, model: 'qfmodel', billingMode: 'credits', ratio: 0.2 },
  ];
  const pool = { records, ctxMeta: new Map([['S-a', { contextWindow: 200000, model: 'qfmodel' }]]),
    toolEvents: [{ sid: 'S-a', ts: T(1), name: 'Bash', err: true, add: 0, del: 0, file: null }] };
  const now = T(100);
  assert.equal(buildActive(pool, '', now, []), null, '空串 sid → null（调用方不加 local.active 字段）');
  assert.equal(buildActive(pool, null, now, []), null);
  const miss = buildActive(pool, 'S-zzz', now, []);
  assert.deepEqual(miss, { sessionId: 'S-zzz', lastTurn: null, session: null, pulse: null, turnSpeeds: null }, '未知会话 → 空态（非 null）');
  const entries = [{ modelKey: 'qfmodel', modelDisplayName: 'Qoder Flash', typeDisplayName: 'Chat', byok: false }];
  const hit = buildActive(pool, 'S-a', now, entries);
  assert.equal(hit.sessionId, 'S-a');
  assert.equal(hit.lastTurn.credits, 1.5);
  assert.equal(hit.lastTurn.modelName, 'Qoder Flash', 'lastTurn.modelName 按目录解析');
  assert.equal(hit.session.credits, 1.5);
  assert.equal(hit.session.modelName, 'Qoder Flash', 'session.modelName 解析（与全局 session 同规）');
  assert.equal(hit.session.byModel[0].modelName, 'Qoder Flash', 'byModel 行同样解析');
  assert.equal(hit.session.tools.calls, 1, 'pool.toolEvents → 请求态工具统计');
  assert.equal(hit.session.tools.errors, 1);
  assert.equal(hit.session.edits, null, '无编辑类工具 → null（呈现 --）');
  // 2026-10-30：波形 + 逐轮速度（请求时算，仅供面板；形状与 scanner 纯函数一致）
  assert.equal(hit.pulse.h1.n, 60);
  assert.equal(hit.pulse.h24.n, 48);
  assert.deepEqual([hit.pulse.all.rows, hit.pulse.all.total], [1, 1.5]);
  assert.deepEqual([hit.turnSpeeds.totalTurns, hit.turnSpeeds.timedTurns], [1, 0], '记录无 mt0/mt1 → 无实测秒，轮不可测');
  assert.deepEqual(hit.turnSpeeds.rows.map((r) => [r.model, r.modelName, r.turns, r.timed]),
    [['qfmodel', 'Qoder Flash', 1, 0]], 'turnSpeeds 行同样解析 modelName');
  assert.deepEqual(buildActive(null, 'S-a', now, []), { sessionId: 'S-a', lastTurn: null, session: null, pulse: null, turnSpeeds: null },
    '池缺席（首轮 scan 前）→ 出空态而非抛错；不是"未提供身份"的 null（那会让 widget 误报结构变更）');
  const loose = buildActive({ records, ctxMeta: pool.ctxMeta }, 'S-a', now, 'not-an-array');
  assert.equal(loose.sessionId, 'S-a');
  assert.equal(loose.session.modelName, null, 'entries 非数组 → 兜底空目录，未解析即 null');
});

// ---- P3 T4: GET /state?session= 请求态接线（含不带参回归与 state.json 不落 active）----
test('P3 T4 /state?session=: 带参出 local.active、不带参无该键、未知会话出空态、state.json 恒不落 active', async () => {
  await waitUp();
  const boot = JSON.parse(fs.readFileSync(path.join(env.QUM_HOME, 'bootstrap.json'), 'utf8')).code;
  const getRaw = async (qs) => (await get(`/state?bootstrap=${boot}${qs}`)).json();
  const plain = await getRaw('');
  assert.equal('active' in plain.local, false, '不带 session → 无 active 键（P2 形状逐字节不变）');
  const sid = plain.local.session.id; // fixture 锚定会话
  const hit = await getRaw(`&session=${encodeURIComponent(sid)}`);
  assert.equal(hit.local.active.sessionId, sid);
  assert.equal(hit.local.active.lastTurn.sessionId, sid);
  assert.equal(hit.local.active.session.id, sid);
  assert.equal(hit.local.active.lastTurn.credits, plain.local.lastTurn.credits, '锚定会话的 active ≡ 全局 lastTurn');
  assert.equal(hit.local.active.session.turns, plain.local.session.turns, 'active.session ≡ 全局 session（同会话）');
  // 2026-10-30：请求态携带波形与逐轮速度（不落盘；供面板两新模块读取）
  assert.ok(hit.local.active.pulse && hit.local.active.pulse.all.rows > 0, '带参响应含脉冲波形');
  assert.ok(Array.isArray(hit.local.active.turnSpeeds.rows), '带参响应含逐轮速度行');
  // 原生样式数据面：active.session 与全局同源（请求态透传 toolEvents/规模/编辑）
  const as = hit.local.active.session;
  assert.equal(as.rounds, 1);
  assert.equal(as.requests, 1);
  assert.equal(as.tools.calls, 3);
  assert.equal(as.tools.errors, 1);
  assert.deepEqual(as.edits, { added: 6, removed: 3, files: 2 });
  assert.ok(as.firstTs <= as.lastTs, '会话时间范围有序');
  assert.deepEqual([as.outEstThk, as.outEstTxt, as.outEstCall], [0, 7, 0], '思考/正文/工具三段拆分经 active 透传');
  const miss = await getRaw('&session=S-not-exist');
  assert.deepEqual(miss.local.active, { sessionId: 'S-not-exist', lastTurn: null, session: null, pulse: null, turnSpeeds: null });
  const disk = JSON.parse(fs.readFileSync(path.join(env.QUM_HOME, 'state.json'), 'utf8'));
  assert.equal('active' in disk.local, false, '请求态绝不落盘（多窗口互不污染）');
  assert.equal(plain.local.billingMode, hit.local.billingMode, '全局口径字段不因带参改变');
});

// ---- 原生样式数据面：scan-cache v4 落盘 toolEvents（无 usage 行也入缓存，重启无需重扫）----
test('原生样式数据面: scan-cache v4 + 条目 toolEvents（工具名/失败/编辑行数持久化）', async () => {
  await waitUp();
  const boot = JSON.parse(fs.readFileSync(path.join(env.QUM_HOME, 'bootstrap.json'), 'utf8')).code;
  await get('/state?bootstrap=' + boot); // 触发本轮 ingest（缓存落盘）
  const cache = JSON.parse(fs.readFileSync(path.join(env.QUM_HOME, 'scan-cache.json'), 'utf8'));
  assert.equal(cache.v, 5, 'scan-cache 版本门升 v5（旧 v4 包记录缺 billable → 作废重扫）');
  const entry = Object.values(cache.files).find((e) => Array.isArray(e.toolEvents) && e.toolEvents.length);
  assert.ok(entry, '条目必须持久化 toolEvents');
  assert.deepEqual(entry.toolEvents.map((e) => e.name).sort(), ['Bash', 'Edit', 'Write']);
  const bash = entry.toolEvents.find((e) => e.name === 'Bash');
  assert.equal(bash.err, true, 'tool_result.is_error → err 标记');
  assert.equal(bash.sid, 'sess-cur');
  const edit = entry.toolEvents.find((e) => e.name === 'Edit');
  assert.deepEqual({ add: edit.add, del: edit.del, file: edit.file }, { add: 4, del: 3, file: '/p/a.js' });
});

// ---- P3 T11: verify-p2 --session 对账（已知会话逐项对得上；未知会话两侧同为 null，不假绿）----
test('P3 T11 verify-p2 --session: 已知 sid 出 active 对账行且 exit 0；未知 sid 两侧一致为 null', async () => {
  await waitUp();
  const { execFile } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const script = fileURLToPath(new URL('../scripts/verify-p2.mjs', import.meta.url));
  const run = (args) => new Promise((resolve) => {
    execFile(process.execPath, [script, ...args], { env, timeout: 20000 },
      (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
  });
  const boot = JSON.parse(fs.readFileSync(path.join(env.QUM_HOME, 'bootstrap.json'), 'utf8')).code;
  const st = await (await get(`/state?bootstrap=${boot}`)).json();
  const sid = st.local.session.id;
  const ok = await run(['--port', String(PORT), '--session', sid]);
  assert.equal(ok.code, 0, `已知会话应对账通过\nstdout=${ok.stdout}\nstderr=${ok.stderr}`);
  assert.match(ok.stdout, /active\.sessionId/);
  assert.match(ok.stdout, /active\.lastTurn\.turnSec/);
  assert.match(ok.stdout, /active\.session\.totalTurnSec/);
  assert.match(ok.stdout, /对账通过/);
  const miss = await run(['--port', String(PORT), '--session', 'S-does-not-exist']);
  assert.equal(miss.code, 0, `空态两侧一致应为 0\nstdout=${miss.stdout}`);
  assert.match(miss.stdout, /active\.session\.turns\s+daemon=null\s+复算=null/, '必须真打印双方值，证明对账跑过而非跳过');
});

// ---- P3 T12b：诊断回报落盘（从 raw 剥离，单独 0600 debug.json）----
test('P3 T12b POST /ingest/quota 带 debug → 落 ~/.qoder-monitor/debug.json，且 raw/state.json 均不含 debug', async () => {
  await waitUp();
  const token = fs.readFileSync(path.join(env.QUM_HOME, 'daemon.token'), 'utf8').trim();
  const res = await fetch(`http://127.0.0.1:${PORT}/ingest/quota`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'X-QM-Token': token },
    body: JSON.stringify({ usage: { qoderUsage: { userQuota: { remaining: 9 } } }, plan: null, heatmap: null, metrics: null, models: null,
      debug: { sid: 'S-diag', method: 'visible', panes: 3, activeMarked: 0, visible: 1 } }),
  });
  assert.equal(res.status, 202);
  const dbg = JSON.parse(fs.readFileSync(path.join(env.QUM_HOME, 'debug.json'), 'utf8'));
  assert.equal(dbg.sid, 'S-diag'); assert.equal(dbg.method, 'visible');
  assert.equal(dbg.panes, 3); assert.equal(typeof dbg.ts, 'number');
  const st = JSON.parse(fs.readFileSync(path.join(env.QUM_HOME, 'state.json'), 'utf8'));
  assert.equal('debug' in st.account, false, 'debug 不进 account 顶层');
  assert.equal('debug' in (st.account.raw || {}), false, 'debug 从 raw 剥离（不进 state.json / quota-history）');
  const mode = (fs.statSync(path.join(env.QUM_HOME, 'debug.json')).mode & 0o777).toString(8);
  assert.equal(mode, '600', '诊断文件恒 0600');
  // 无 debug 字段的旧体不受影响
  const res2 = await fetch(`http://127.0.0.1:${PORT}/ingest/quota`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'X-QM-Token': token },
    body: JSON.stringify({ usage: { qoderUsage: { userQuota: { remaining: 8 } } } }),
  });
  assert.equal(res2.status, 202);
  assert.equal(JSON.parse(fs.readFileSync(path.join(env.QUM_HOME, 'debug.json'), 'utf8')).sid, 'S-diag',
    '缺 debug → 保留上一份，不清空');
});
