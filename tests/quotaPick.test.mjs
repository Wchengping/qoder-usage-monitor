// tests/quotaPick.test.mjs
// Task 10 — pickQuotaFields 防御式解析纯函数（daemon/quotaPick.mjs，不拉起 daemon 即可 import）
// + 账户 ingest 端到端（tmp QUM_HOME + 49863 daemon：POST tests/quota-sample.json → /state 解析字段
//   + quota-history.jsonl 首行 → SIGTERM 确定性杀进程、pgrep 零残留）。
// 样本组（brief binding + T12 spike 校准）：真机 qoderUsage 结构（ground truth）、
// credit-watch 旧结构（fallback 链回归）、{planQuota:{used:750}} 简化结构、乱结构不抛。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { pickQuotaFields, pickHeatmap, pickMetrics, resolveModelName, trimModelCatalog } from '../daemon/quotaPick.mjs';

const REPO = path.resolve(import.meta.dirname, '..');

// ---------------------------------------------------------------- 纯函数：三组样本

test('样本1 credit-watch 结构（{usage,plan} bridge body）：候选键全中', () => {
  const out = pickQuotaFields({
    usage: {
      user_id: 'u-9',
      email: 'x@example.invalid',
      plan_tier: 'pro',
      quota_summary: { used_value: 1820, remaining_value: 680, total_value: 2500 },
      plan_quota: { quota_summary: { used_value: 1500, remaining_value: 1000, total_value: 2500 } },
      resource_package_quota: {
        quota_summary: { used_value: 320, remaining_value: 300, total_value: 620 },
        expiring_soon: 100,
      },
      next_refresh_date: 1791691200000,
    },
    plan: { plan_tier: 'pro' },
  });
  const SORTED = ['nextRefresh', 'packRem', 'packs', 'planRem']; // ASCII 序：packRem < packs（'R'<'s'）
  assert.deepEqual(Object.keys(out).sort(), SORTED);
  assert.equal(out.planRem, 1000); // plan_quota.quota_summary.remaining_value
  assert.equal(out.packRem, 300);  // 钉死候选链①：resource_package_quota.quota_summary.remaining_value
  assert.equal(out.nextRefresh, 1791691200000);
  assert.equal(out.packs.length, 1);
  assert.equal(out.packs[0].remaining, 300);
  assert.equal(out.packs[0].used, 320);
  assert.equal(out.packs[0].total, 620);
  assert.equal(out.packs[0].expiringSoon, 100);
});

test('样本2 简化结构 {planQuota:{used:750}}：不抛、允许部分 null；used+total 可推导', () => {
  const out = pickQuotaFields({ planQuota: { used: 750 } });
  assert.equal(out.planRem, null); // 只有 used 无 total → 剩余不可得，留 null（raw 仍全量保留）
  assert.equal(out.packRem, null);
  assert.equal(out.nextRefresh, null);
  assert.deepEqual(out.packs, []);
  assert.equal(pickQuotaFields({ planQuota: { used: 750, total: 900 } }).planRem, 150);
  assert.equal(pickQuotaFields({ plan_quota: { used: 100, limit: 250 } }).planRem, 150); // limit 别名
});

test('样本3 乱结构不抛，输出恒为 {packs,planRem,packRem,nextRefresh} 形', () => {
  const junks = [
    null, undefined, 0, 'str', true, [], [1, 2], {},
    { usage: 'x' }, { usage: [1] }, { usage: null, plan: 42 },
    { quota_summary: 3 }, { plan_quota: { quota_summary: 'no' } },
    { plan_quota: { used: 'a', total: 'b' } },
    { next_refresh_date: 'not-a-date' }, { next_refresh_date: {} },
    { resource_package_quota: { quota_summary: { remaining_value: 'x' } } },
    { resource_package_quota: [] }, { resourcePack: 'nope' },
    // T12 真机壳乱值：qoderUsage 各成员畸形也不抛
    { usage: { qoderUsage: 'x' } }, { usage: { qoderUsage: [] } },
    { usage: { qoderUsage: { userQuota: 3, addOnQuota: [], expiresAt: 'nope' } } },
    { usage: { qoderUsage: { userQuota: 'q', dedicatedResourcePackages: 'x', orgResourcePackage: 7 } } },
    { usage: { qoderUsage: { expiresAt: {} } }, plan: { qoderUsage: null } },
  ];
  for (const j of junks) {
    const out = pickQuotaFields(j);
    assert.ok(out && typeof out === 'object');
    assert.deepEqual(Object.keys(out).sort(), ['nextRefresh', 'packRem', 'packs', 'planRem']);
    assert.ok(Array.isArray(out.packs));
    for (const k of ['planRem', 'packRem', 'nextRefresh']) {
      assert.ok(out[k] === null || typeof out[k] === 'number', `${k} 只能是 number|null`);
    }
  }
});

// ---------------------------------------------------------------- T12 spike：真机 qoderUsage 结构（ground truth）

const DAY = 86_400_000;

/** T12 spike 捕获的真机 payload（doctor --show-quota-raw，Free 用户 + 加油包）——模板，可覆写。 */
function realBody(patch = {}) {
  const qu = {
    userType: 'personal_free',
    expiresAt: 253402214400000, // 服务端哨兵"永不过期"（year 9999）
    upgradeUrl: 'https://qoder.com/pricing?client=qoder',
    userQuota: { total: 0, used: 0, remaining: 0, percentage: 0, unit: 'credits' },
    addOnQuota: { total: 1200, used: 750, remaining: 450, percentage: 63, unit: 'credits' },
    dedicatedResourcePackages: [],
    orgResourcePackage: null,
    ...(patch.qoderUsage || {}),
  };
  return {
    usage: { displayMode: 'qoder', qoderUsage: qu, ...(patch.usage || {}) },
    plan: { userType: 'personal_free', planTierName: 'Free', isHighestTier: false, isPersonalVersion: true, organization: null, ...(patch.plan || {}) },
  };
}

test('T12 真机 payload（Free+加油包）：planRem=userQuota.remaining(0)、packRem=addOnQuota.remaining(450)、packs=[]、expiresAt 哨兵年9999→nextRefresh=null', () => {
  const out = pickQuotaFields(realBody());
  assert.equal(out.planRem, 0);   // userQuota.remaining=0 是合法读数，不是缺失
  assert.equal(out.packRem, 450); // addOnQuota.remaining
  assert.deepEqual(out.packs, []); // dedicatedResourcePackages 空 + orgResourcePackage null
  assert.equal(out.nextRefresh, null); // 253402214400000 距 now 远超 90 天 → 哨兵 → 无倒计时
});

test('T12 expiresAt 窗口：delta ∈ (0,90d) 才认（ms 原样）；秒制先走单位启发；越窗/过去 → null 落旧链', () => {
  const now = Date.now();
  const in3d = Math.floor((now + 3 * DAY) / 1000) * 1000; // 秒对齐，保证秒→ms 启发可精确对账
  assert.equal(pickQuotaFields(realBody({ qoderUsage: { expiresAt: in3d } }), now).nextRefresh, in3d);
  assert.equal(pickQuotaFields(realBody({ qoderUsage: { expiresAt: now - 1 } }), now).nextRefresh, null); // 过去
  assert.equal(pickQuotaFields(realBody({ qoderUsage: { expiresAt: now + 90 * DAY + 1 } }), now).nextRefresh, null); // 越窗
  assert.equal(pickQuotaFields(realBody({ qoderUsage: { expiresAt: in3d / 1000 } }), now).nextRefresh, in3d); // 秒→ms
  // 哨兵 expiresAt 不阻断旧 next_refresh_date 链（兼容混合形态）
  assert.equal(pickQuotaFields({ usage: { qoderUsage: { expiresAt: 253402214400000 }, next_refresh_date: 1791691200000 } }, now).nextRefresh, 1791691200000);
});

test('T12 付费变体：userQuota.total>0 → planRem 取 userQuota；dedicatedResourcePackages+orgResourcePackage → packs 计数；2026-10-30 包名保留（套餐聚合呈现用）', () => {
  const out = pickQuotaFields(realBody({
    qoderUsage: {
      userQuota: { total: 3000, used: 900, remaining: 2100, percentage: 30, unit: 'credits' },
      dedicatedResourcePackages: [
        { name: 'Qwen 专属积分', total: 500, used: 100, remaining: 400 },
        { name: '  次要包  ', quota_summary: { used_value: 20, remaining_value: 48, total_value: 68 } },
        { total: 30, used: 10, remaining: 20 },
      ],
      orgResourcePackage: { total: 900, used: 300, remaining: 600 },
    },
  }));
  assert.equal(out.planRem, 2100);
  assert.equal(out.packRem, 450); // 加油包剩余仍为 packRem 头（与 gauge 同源，packs 只作计数面）
  assert.equal(out.packs.length, 4); // 3 dedicated + 1 org
  assert.equal(out.packs[0].remaining, 400);
  assert.equal(out.packs[1].remaining, 48);
  assert.equal(out.packs[2].total, 30);
  assert.equal(out.packs[3].total, 900);
  // 2026-10-30 用户反馈：套餐用户的专属资源包必须可按名字拆解呈现 → normPack 保留 name
  assert.equal(out.packs[0].name, 'Qwen 专属积分');
  assert.equal(out.packs[1].name, '次要包', 'name 去首尾空白');
  assert.equal(out.packs[2].name, null, '无 name → null（呈现层回落「专属资源包」）');
  assert.equal(out.packs[3].name, null, 'orgResourcePackage 无 name → null');
});

test('T12 真机 HEAD 优先于旧候选：qoderUsage 与 credit-watch 键并存时取前者，旧链仅在缺席时兜底', () => {
  const out = pickQuotaFields({
    usage: {
      qoderUsage: {
        userQuota: { total: 100, used: 10, remaining: 90 },
        addOnQuota: { total: 1200, used: 750, remaining: 450 },
      },
      plan_quota: { quota_summary: { remaining_value: 999 } },
      resource_package_quota: { quota_summary: { remaining_value: 555 } },
    },
  });
  assert.equal(out.planRem, 90);
  assert.equal(out.packRem, 450);
});

// ---------------------------------------------------------------- 时间单位归一（T9 审查 (iii)）

test('nextRefresh 单位归一：<1e11 视作秒 →*1000（边界≈2001-09-09 ms 值会被误判，未来日期无虞）', () => {
  assert.equal(pickQuotaFields({ next_refresh_date: 1791691200 }).nextRefresh, 1791691200000); // 秒
  assert.equal(pickQuotaFields({ next_refresh_date: 1791691200000 }).nextRefresh, 1791691200000); // ms 原样
  assert.equal(pickQuotaFields({ next_refresh_date: 1e11 - 1 }).nextRefresh, (1e11 - 1) * 1000);
  assert.equal(pickQuotaFields({ next_refresh_date: 1e11 }).nextRefresh, 1e11);
  assert.equal(pickQuotaFields({ usage: { next_refresh_date: 1791691200 } }).nextRefresh, 1791691200000);
  assert.equal(pickQuotaFields({ next_refresh_date: '1791691200' }).nextRefresh, 1791691200000); // 数字串
  assert.equal(pickQuotaFields({ nextRefreshDate: 1791691200000 }).nextRefresh, 1791691200000); // camel
  const iso = '2026-10-11T04:00:00Z';
  assert.equal(pickQuotaFields({ next_refresh_date: iso }).nextRefresh, Date.parse(iso)); // ISO 串
});

// ---------------------------------------------------------------- 候选键细节

test('packRem 钉死候选链：resource_package_quota.quota_summary.remaining_value → resourcePack.remaining', () => {
  assert.equal(pickQuotaFields({
    resource_package_quota: { quota_summary: { remaining_value: 50 } },
    resourcePack: { remaining: 42 },
  }).packRem, 50); // ①优先
  assert.equal(pickQuotaFields({ resourcePack: { remaining: 42 } }).packRem, 42); // ②
  // 不新增第三候选：resource_package_quota.remaining 不在链上（与 modules.pickPack 同规）
  assert.equal(pickQuotaFields({ resource_package_quota: { remaining: 300 } }).packRem, null);
  assert.equal(pickQuotaFields({ resource_package_quota: { quota_summary: { remaining_value: 'x' } } }).packRem, null);
});

test('容器序：body 自身(老扁平样本) → usage → plan；同名键先中先得', () => {
  assert.equal(pickQuotaFields({ planQuota: { remaining: 7 } }).planRem, 7); // 扁平（T4 旧测试形态）
  const out = pickQuotaFields({
    usage: { plan_quota: { quota_summary: { remaining_value: 11 } } },
    plan: { plan_quota: { quota_summary: { remaining_value: 99 } } },
  });
  assert.equal(out.planRem, 11); // usage 先于 plan
});

// ---------------------------------------------------------------- T13: pickMetrics（客户端已归一，形状稳定 → 直取）
// ground truth（只读 asar 侦察）：main 侧 getAccountProfileMetrics(scope) 的响应恒为
// {totalCredits, peakCredits, currentStreakDays, longestStreakDays, totalActiveDays, failedSources}
// ——null 允许存在，failedSources 是 string[]。因此本函数是"直取 + 类型收口"，不做候选链。

const METRICS_KEYS = ['totalCredits', 'peakCredits', 'currentStreakDays', 'longestStreakDays', 'totalActiveDays', 'failedSources'];

test('pickMetrics：规范化真形状直取，键集精确，failedSources 保留', () => {
  const out = pickMetrics({
    totalCredits: 1280.4, peakCredits: 86.4, currentStreakDays: 4,
    longestStreakDays: 9, totalActiveDays: 23, failedSources: [],
  });
  assert.deepEqual(Object.keys(out).sort(), [...METRICS_KEYS].sort());
  assert.equal(out.totalCredits, 1280.4);
  assert.equal(out.peakCredits, 86.4);
  assert.equal(out.currentStreakDays, 4);
  assert.equal(out.longestStreakDays, 9);
  assert.equal(out.totalActiveDays, 23);
  assert.deepEqual(out.failedSources, []);
});

test('pickMetrics：null 是合法读数（客户端字段可空）；非数字（串/布尔/NaN）一律收口为 null', () => {
  const out = pickMetrics({
    totalCredits: null, peakCredits: '86.4', currentStreakDays: true,
    longestStreakDays: NaN, totalActiveDays: 23, failedSources: ['heatmap', 7, null],
  });
  assert.equal(out.totalCredits, null);
  assert.equal(out.peakCredits, null);   // 数字串不采信（客户端已归一，出现字符串=形状变了）
  assert.equal(out.currentStreakDays, null);
  assert.equal(out.longestStreakDays, null);
  assert.equal(out.totalActiveDays, 23);
  assert.deepEqual(out.failedSources, ['heatmap']); // 只保留字符串项
});

test('pickMetrics：无回包（null/字符串/数组）→ null；空对象 → 全 null 对象（“该形状无数据”≠“没数据源”）', () => {
  assert.equal(pickMetrics(null), null);
  assert.equal(pickMetrics(undefined), null);
  assert.equal(pickMetrics('{"totalCredits":1}'), null); // bridge 未解开的字符串 → 不猜
  assert.equal(pickMetrics([]), null);
  assert.equal(pickMetrics(42), null);
  assert.deepEqual(pickMetrics({}), {
    totalCredits: null, peakCredits: null, currentStreakDays: null,
    longestStreakDays: null, totalActiveDays: null, failedSources: null,
  });
  // failedSources 非数组 → null（不虚构空数组）
  assert.equal(pickMetrics({ failedSources: 'oops' }).failedSources, null);
});

// ---------------------------------------------------------------- T13: pickHeatmap（首帧形状未知 → 候选链防御）
// 服务端 /sash/api/v1/ai-conversations/credits-heatmap 原始 JSON 由 client 近乎透传，
// 真实包裹键与条目键名均未知 → 候选序（binding）：raw.days → raw.items → raw.heatmap →
// raw.data → raw 自身为数时。命中即返回 {days:[{date,credits}], source:'候选名'}（source
// 让 doctor --show-quota-raw 一眼校准），全不中 → null。绝不抛。

test('pickHeatmap 候选1 raw.days（[{date,credits}]，最可能形状）', () => {
  const out = pickHeatmap({ days: [
    { date: '2026-10-09', credits: 86.4 },
    { date: '2026-10-10', credits: 52.6 },
  ] });
  assert.deepEqual(Object.keys(out).sort(), ['days', 'source']);
  assert.equal(out.source, 'days');
  assert.deepEqual(out.days, [{ date: '2026-10-09', credits: 86.4 }, { date: '2026-10-10', credits: 52.6 }]);
  assert.deepEqual(Object.keys(out.days[0]).sort(), ['credits', 'date']);
});

test('pickHeatmap 候选2/3/4：items(day,total) / heatmap(date_str,used) / data(value)+乱序 → 日期升序归一', () => {
  assert.equal(pickHeatmap({ items: [{ day: '2026-10-10', total: 3 }, { day: '2026-10-08', total: 9 }] }).source, 'items');
  assert.deepEqual(pickHeatmap({ items: [{ day: '2026-10-10', total: 3 }] }).days, [{ date: '2026-10-10', credits: 3 }]);
  assert.equal(pickHeatmap({ heatmap: [{ date_str: '2026-10-10', used: 4 }] }).source, 'heatmap');
  assert.equal(pickHeatmap({ heatmap: [{ date_str: '2026-10-10', used: 4 }] }).days[0].credits, 4);
  const dh = pickHeatmap({ heatmap: [{ date_str: '2026-10-11', used: 1 }, { date_str: '2026-10-09', used: 2 }] });
  assert.deepEqual(dh.days.map((d) => d.date), ['2026-10-09', '2026-10-11'], '全有日期 → 升序（服务端乱序可对账）');
  assert.equal(pickHeatmap({ data: [{ date: '2026-10-10', value: 5 }] }).source, 'data');
  assert.equal(pickHeatmap({ data: [{ date: '2026-10-10', value: 5 }] }).days[0].credits, 5);
});

test('pickHeatmap 候选5 raw 自身为数组 + epoch 归一（ms/秒/带时间的 ISO 串 → YYYY-MM-DD）', () => {
  const out = pickHeatmap([{ date: '2026-10-10', credits: 2 }]);
  assert.equal(out.source, 'self');
  assert.deepEqual(out.days, [{ date: '2026-10-10', credits: 2 }]);
  const ms = Date.UTC(2026, 9, 10, 13, 45); // 同日不同时区无涉：UTC 日历日
  assert.equal(pickHeatmap({ days: [{ ts: ms, credits: 1 }] }).days[0].date, '2026-10-10');
  assert.equal(pickHeatmap({ days: [{ ts: Math.floor(ms / 1000), credits: 1 }] }).days[0].date, '2026-10-10'); // 秒→ms
  assert.equal(pickHeatmap({ days: [{ date: '2026-10-10T21:00:00Z', credits: 1 }] }).days[0].date, '2026-10-10');
  assert.equal(pickHeatmap({ days: [{ date: String(ms), credits: 1 }] }).days[0].date, '2026-10-10'); // 数字串 epoch
});

test('pickHeatmap 候选序与落空：坏候选被跳过、落下一候选；全不中 → null', () => {
  const usable = [{ date: '2026-10-10', credits: 1 }];
  assert.equal(pickHeatmap({ days: 'not-an-array', items: usable }).source, 'items');
  assert.equal(pickHeatmap({ days: [], items: usable }).source, 'items', '空数组不算命中');
  assert.equal(pickHeatmap({ days: [{ credits: 'x' }, 7, null, {}], data: usable }).source, 'data');
  assert.equal(pickHeatmap({ days: usable, items: usable }).source, 'days', '候选序 binding：days 先中先得');
  assert.equal(pickHeatmap({}), null);
  assert.equal(pickHeatmap({ other: usable }), null);
  assert.equal(pickHeatmap({ days: [{ foo: 1 }] }), null); // 条目既无日期又无数值 → 整体不可用
});

test('pickHeatmap 乱输入绝不抛，输出恒为 null 或 {days:[{date,credits}],source}', () => {
  const junks = [null, undefined, 0, 'str', true, [], [1, 2], {},
    { days: 'x' }, { days: 42 }, { days: {} }, { days: [null, 1, 'x', []] },
    { data: [{ date: 'not-a-date', credits: 'x' }] }, { data: [{ date: 'not-a-date', credits: 3 }] },
    { days: [{ date: {}, credits: 1 }] }, { heatmap: [{ day: -1 }] },
    { days: [{ date: '2026-13-45', credits: 1 }] }];
  for (const j of junks) {
    const out = pickHeatmap(j);
    if (out === null) continue;
    assert.deepEqual(Object.keys(out).sort(), ['days', 'source']);
    assert.equal(typeof out.source, 'string');
    assert.ok(Array.isArray(out.days) && out.days.length > 0);
    for (const d of out.days) {
      assert.deepEqual(Object.keys(d).sort(), ['credits', 'date']);
      assert.ok(d.date === null || typeof d.date === 'string', 'date 只能是 YYYY-MM-DD 串或 null');
      assert.ok(d.credits === null || typeof d.credits === 'number', 'credits 只能是 number 或 null');
    }
  }
  // 有数值无日期：保留（cells 仍可渲染，title 由 modules 侧出 '--'）
  assert.deepEqual(pickHeatmap({ data: [{ date: 'not-a-date', credits: 3 }] }),
    { days: [{ date: null, credits: 3 }], source: 'data' });
});

// ---------------------------------------------------------------- 模型目录解析（用户报告：模型名显示不正确）
// ground truth（只读 asar 侦察）：window.qoderDesktop.listChatComposerModels({fetchStrategy:'live',
// workspaceDirectories:[]}) → 模型档案数组，字段含 {modelKey, modelDisplayName, typeDisplayName,
// byok, ...}。BYOK 自定义模型 byok:true、modelDisplayName 是人类名（如 'DeepSeek-Flash'）。
// session jsonl 的 model 字段是 byok 模型 id（uuid 形态）或内建短句柄（如 'qfmodel'）。
// resolveModelName：精确 modelKey → displayName；否则 modelKey 以 '/'+id 结尾或以 id+'/' 开头
// → displayName；否则 null。纯函数，绝不抛。display policy（modules 层）：
//   resolved ?? （短句柄 → 自身） ?? `id:${id.slice(0,8)}`。
test('resolveModelName: 精确 modelKey 命中（用户场景 byok id → DeepSeek-Flash）', () => {
  const cat = [{ modelKey: '11111111-1111-4111-8111-111111111111', modelDisplayName: 'DeepSeek-Flash', typeDisplayName: 'BYOK', byok: true }];
  assert.equal(resolveModelName('11111111-1111-4111-8111-111111111111', cat), 'DeepSeek-Flash');
  // 精确优先于斜杠规则（两条都可能命中时取精确）
  const both = [
    { modelKey: 'vendor/qfmodel', modelDisplayName: 'Slash Name' },
    { modelKey: 'qfmodel', modelDisplayName: 'Exact Name' },
  ];
  assert.equal(resolveModelName('qfmodel', both), 'Exact Name');
});

test('resolveModelName: 斜杠后缀/前缀匹配（modelKey 形如 <vendor>/<id> 或 <id>/<variant>）', () => {
  const suf = [{ modelKey: 'qoder/qfmodel', modelDisplayName: 'Qoder Model', byok: false }];
  assert.equal(resolveModelName('qfmodel', suf), 'Qoder Model');
  const pre = [{ modelKey: '11111111-1111-4111-8111-111111111111/thinking', modelDisplayName: 'DeepSeek-Flash Think', byok: true }];
  assert.equal(resolveModelName('11111111-1111-4111-8111-111111111111', pre), 'DeepSeek-Flash Think');
  // 接受 {entries:[...]} 目录对象形态（state.modelCatalog 原样）
  assert.equal(resolveModelName('qfmodel', { fetchedAt: 1, entries: suf }), 'Qoder Model');
  // 子串边界必须是整段：'model' 不得命中 'a/modelx'
  assert.equal(resolveModelName('model', [{ modelKey: 'a/modelx', modelDisplayName: 'X' }]), null);
});

test('resolveModelName: BYOK <provider>/<slug> 按目录显示名归一化命中（真机 2026-10-28：byok:<uuid> 与 provider uuid 不同）', () => {
  const cat = { entries: [
    { modelKey: 'byok:cccccccc-cccc-4ccc-8ccc-cccccccccccc', modelDisplayName: 'Mimo-V2.6-Flash', byok: true },
    { modelKey: 'byok:dddddddd-dddd-4ddd-8ddd-dddddddddddd', modelDisplayName: 'Mimo-V2.6-Pro', byok: true },
    { modelKey: 'dfmodel', modelDisplayName: 'DeepSeek-Flash', byok: false },
  ] };
  assert.equal(
    resolveModelName('qoder-custom-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/mimo-v2.6-flash', cat),
    'Mimo-V2.6-Flash');
  assert.equal(
    resolveModelName('qoder-custom-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/mimo-v2.6-pro', cat),
    'Mimo-V2.6-Pro');
  // 目录已删除的 BYOK 模型（step-*）没有显示名 → null；由呈现层回落完整 slug
  assert.equal(resolveModelName('qoder-custom-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/step-5-preview', cat), null);
  // 归一化后同名但显示文本不同 → 不猜（歧义 → null）
  const amb = [
    { modelKey: 'byok:a', modelDisplayName: 'Mimo V2.6 Flash', byok: true },
    { modelKey: 'byok:b', modelDisplayName: 'Mimo-V2.6-Flash', byok: true },
  ];
  assert.equal(resolveModelName('qoder-custom-x/mimo-v2.6-flash', amb), null);
  // 精确/斜杠命中优先于归一化（同一 id 两种规则都可命中时取前面规则）
  const both = [{ modelKey: 'qoder-custom-x/mimo-v2.6-flash', modelDisplayName: 'Slash Exact', byok: true }];
  assert.equal(resolveModelName('qoder-custom-x/mimo-v2.6-flash', both), 'Slash Exact');
});

test('resolveModelName: 未命中/乱输入 → null，绝不抛（非字符串 id、非数组目录、废条目）', () => {
  const cat = [{ modelKey: 'qoder/qfmodel', modelDisplayName: 'Qoder Model' }];
  assert.equal(resolveModelName('nope', cat), null);
  assert.equal(resolveModelName('qfmodel', []), null);
  assert.equal(resolveModelName('qfmodel', null), null);
  assert.equal(resolveModelName('qfmodel', undefined), null);
  assert.equal(resolveModelName('qfmodel', 'not-catalog'), null);
  assert.equal(resolveModelName('qfmodel', 42), null);
  assert.equal(resolveModelName('qfmodel', [null, 7, 'x', { modelKey: 9 }, { modelKey: 'qoder/qfmodel' }]), null, '命中条目无 displayName → null');
  assert.equal(resolveModelName('qfmodel', [{ modelKey: 'qoder/qfmodel', modelDisplayName: '' }]), null, '空 displayName 不采信');
  for (const bad of [null, undefined, 0, 42, {}, [], true, NaN]) {
    assert.equal(resolveModelName(bad, cat), null, `非字符串 id ${String(bad)} → null`);
  }
});

test('trimModelCatalog: 只留 {modelKey,modelDisplayName,typeDisplayName,byok} 四字段，丢非对象、封顶 300', () => {
  const one = trimModelCatalog([{ modelKey: 'k', modelDisplayName: 'N', typeDisplayName: 'T', byok: true, extra: 1, nested: { a: 1 } }]);
  assert.deepEqual(one, [{ modelKey: 'k', modelDisplayName: 'N', typeDisplayName: 'T', byok: true }]);
  // 缺字段 → null / byok 收口 false；非对象/数组条目丢弃
  assert.deepEqual(trimModelCatalog([null, 7, 'x', [], { modelKey: 'k2' }]),
    [{ modelKey: 'k2', modelDisplayName: null, typeDisplayName: null, byok: false }]);
  // 非数组输入 → 空数组，绝不抛
  for (const bad of [null, undefined, 42, 'x', {}]) assert.deepEqual(trimModelCatalog(bad), []);
  // 封顶 300
  const big = Array.from({ length: 350 }, (_, i) => ({ modelKey: `k${i}`, modelDisplayName: `N${i}` }));
  const trimmed = trimModelCatalog(big);
  assert.equal(trimmed.length, 300);
  assert.equal(trimmed[299].modelKey, 'k299');
});

// 真机实测修正（2026-10-12）：listChatComposerModels 返回条目顶层字段是
// {key, displayName, byok(对象或缺省), source, enabled, tags, ...}。
// modelKey/modelDisplayName 是 BYOK 配置档案的形态，composer 列表条目里并不存在
// ——旧 trim 按 modelKey 读取导致 state.modelCatalog 所有条目全 null，
// 底栏模型名永远回落 `id:qoder-cu`（用户截图实证）。输出形态保持四字段不变。
test('trimModelCatalog: 真实 composer 形态 {key,displayName,byok对象} → 标准四字段', () => {
  const real = [{
    key: 'mimo-v2.6-flash', displayName: 'DeepSeek-Flash',
    byok: { providerKey: 'custom', providerDisplayName: 'Custom' },
    source: 'custom', enabled: true, tags: [], outerProvider: undefined,
  }];
  assert.deepEqual(trimModelCatalog(real),
    [{ modelKey: 'mimo-v2.6-flash', modelDisplayName: 'DeepSeek-Flash', typeDisplayName: null, byok: true }]);
  // 双形态混排：新 key/displayName 优先，旧 modelKey/modelDisplayName 仍兼容
  const mixed = [{ key: 'a', displayName: 'A' }, { modelKey: 'b', modelDisplayName: 'B', byok: true }];
  assert.deepEqual(trimModelCatalog(mixed), [
    { modelKey: 'a', modelDisplayName: 'A', typeDisplayName: null, byok: false },
    { modelKey: 'b', modelDisplayName: 'B', typeDisplayName: null, byok: true },
  ]);
  // key/displayName 非字符串 → null 收口（绝不抛）
  assert.deepEqual(trimModelCatalog([{ key: 7, displayName: {} }]),
    [{ modelKey: null, modelDisplayName: null, typeDisplayName: null, byok: false }]);
});

test('resolveModelName: 反向斜杠匹配（session id=<profile>/<key>，目录 key 只有后段）', () => {
  const tail = [{ modelKey: 'mimo-v2.6-flash', modelDisplayName: 'DeepSeek-Flash' }];
  assert.equal(
    resolveModelName('qoder-custom-22222222-2222-4222-8222-222222222222/mimo-v2.6-flash', tail),
    'DeepSeek-Flash');
  // 反向前缀：session id = <key>/<variant>，目录 key 只有前段
  const head = [{ modelKey: 'qoder-custom-22222222-2222-4222-8222-222222222222', modelDisplayName: 'Custom Prof' }];
  assert.equal(
    resolveModelName('qoder-custom-22222222-2222-4222-8222-222222222222/mimo-v2.6-flash', head),
    'Custom Prof');
  // 边界仍是整段：key 'model' 不得命中 id 'a/modelx'（反向也一样）
  assert.equal(resolveModelName('a/modelx', [{ modelKey: 'model', modelDisplayName: 'X' }]), null);
});

// ---------------------------------------------------------------- E2E（brief Step 4）

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qum-e2e-'));
const HOME = path.join(TMP, 'home');
fs.mkdirSync(HOME, { recursive: true });
const PORT = 49863; // brief 指定端口；server.test.mjs 已避让此值
const env = { ...process.env, QUM_HOME: HOME, QUM_PROJECTS_DIR: path.join(TMP, 'projects') };
const srv = spawn(process.execPath, ['daemon/server.mjs', '--port', String(PORT)], {
  env, cwd: REPO, stdio: 'ignore',
});
test.after(() => {
  try { srv.kill('SIGKILL'); } catch { /* 已退出 */ }
  fs.rmSync(TMP, { recursive: true, force: true });
});

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (r.ok) return;
    } catch { /* 未就绪 */ }
    await new Promise((res) => setTimeout(res, 200));
  }
  throw new Error('daemon not up');
}

test('E2E: curl 等价 POST tests/quota-sample.json → /state 解析字段 + quota-history 首行 + 干净杀进程', async () => {
  await waitUp();
  const boot = JSON.parse(fs.readFileSync(path.join(HOME, 'bootstrap.json'), 'utf8')).code;
  const res = await fetch(`http://127.0.0.1:${PORT}/state?bootstrap=${encodeURIComponent(boot)}`);
  assert.equal(res.status, 200);
  const token = res.headers.get('x-qm-token');
  assert.ok(token && token.length === 64);

  // Fix round 1（0600 红线）：预置 0644 的 quota-history.jsonl，验证既有文件的 chmod 路径——
  // appendFileSync 的 mode 只对新建生效，世界可读的账户 raw 必须被 ingest 强制收口到 0600。
  const QH = path.join(HOME, 'quota-history.jsonl');
  fs.writeFileSync(QH, ''); // 空文件：lastSnapshotTs → null，不干扰首条追加
  fs.chmodSync(QH, 0o644);
  assert.equal(fs.statSync(QH).mode & 0o777, 0o644); // 预置确认（RED 的前置）

  const sample = fs.readFileSync(path.join(REPO, 'tests', 'quota-sample.json'), 'utf8');
  const post = await fetch(`http://127.0.0.1:${PORT}/ingest/quota`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-qm-token': token },
    body: sample,
  });
  assert.equal(post.status, 202); // 落盘成功路径仍是 202（carry-in 1 只改失败路径）

  const st = await (await fetch(`http://127.0.0.1:${PORT}/state`, { headers: { 'x-qm-token': token } })).json();
  assert.equal(st.account.source, 'widget');
  assert.equal(typeof st.account.fetchedAt, 'number');
  assert.equal(st.account.raw.usage.qoderUsage.addOnQuota.remaining, 450); // raw 全量保留（T12 真机形态）
  assert.equal(st.account.raw.plan.planTierName, 'Free');
  assert.equal(st.account.planRem, 0);   // userQuota.remaining（0 是读数不是缺失）
  assert.equal(st.account.packRem, 450); // addOnQuota.remaining
  assert.equal(st.account.nextRefresh, null); // expiresAt 哨兵年 9999 → 无倒计时（诚实降级）
  assert.deepEqual(st.account.packs, []); // dedicatedResourcePackages 空 + orgResourcePackage null
  // T13：bridge 扩展两源——heatmap/metrics 解析字段并列于 account（raw 仍全量保留）
  assert.equal(st.account.raw.heatmap.days.length, 4);
  assert.equal(st.account.raw.metrics.totalCredits, 1280.4);
  assert.equal(st.account.metrics.totalCredits, 1280.4);
  assert.equal(st.account.metrics.peakCredits, 86.4);
  assert.equal(st.account.metrics.currentStreakDays, 4);
  assert.equal(st.account.metrics.longestStreakDays, 9);
  assert.equal(st.account.metrics.totalActiveDays, 23);
  assert.deepEqual(st.account.metrics.failedSources, []);
  assert.equal(st.account.heatmap.source, 'days');
  assert.equal(st.account.heatmap.days.length, 4);
  assert.deepEqual(st.account.heatmap.days[3], { date: '2026-10-10', credits: 52.6 });

  const rows = fs.readFileSync(path.join(HOME, 'quota-history.jsonl'), 'utf8').trim().split('\n');
  assert.equal(rows.length, 1); // 首条
  const row = JSON.parse(rows[0]);
  assert.equal(typeof row.ts, 'number');
  assert.equal(row.raw.usage.qoderUsage.addOnQuota.used, 750);

  const disk = JSON.parse(fs.readFileSync(path.join(HOME, 'state.json'), 'utf8'));
  assert.equal(disk.account.packRem, 450); // 快照落盘同样带解析字段

  // 项目红线：QUM_HOME 内含账户 raw 的文件必须 0600（含预存 0644 的 chmod 收口路径）
  const qhMode = fs.statSync(QH).mode & 0o777;
  assert.equal(qhMode & 0o077, 0, `quota-history.jsonl must be 0600, got 0${qhMode.toString(8)}`);
  assert.equal(fs.statSync(path.join(HOME, 'state.json')).mode & 0o077, 0); // 同锚点：state.json 一直合规

  // 确定性杀进程：SIGTERM → shutdown 钩子退出；pgrep 模板零残留
  await new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.once('close', resolve);
    srv.kill('SIGTERM');
    setTimeout(() => reject(new Error('daemon did not exit on SIGTERM')), 5000);
  });
  let residue = '';
  try {
    residue = execFileSync('pgrep', ['-f', `server\\.mjs.*--port ${PORT}`], { encoding: 'utf8' });
  } catch (e) {
    residue = String(e.stdout || ''); // pgrep 无匹配 → exit 1
  }
  assert.equal(residue.trim(), '', 'zero daemon residue on port ' + PORT);
});
