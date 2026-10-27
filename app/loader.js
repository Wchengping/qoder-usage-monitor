// app/loader.js — QUM loader 实现体（模板风格文件，Task 8）。
// 本文件不会被浏览器直接加载，也不是 ES module：安装时 install.mjs 读取本文件
// 全文，作为 `implBody` 传给 scripts/patchTransforms.mjs 的 renderLoader()，
// 注入其 IIFE 模板的占位区（常量 QUM_BOOTSTRAP/QUM_PORT/QUM_VERSION 由模板给出），
// 生成的 loader.js 覆盖 monitor/loader.js。因此这里：禁止静态 import/export；
// 允许函数顶层 return。
// 冒烟对账：tests/widgetDom.test.mjs 断言下方三个守卫存在；tests/install.test.mjs
// 断言本文件内容经 runInstall 进入产物 loader.js。
//
// dev-live（2026-10-15「保存即生效」）：daemon 从仓库 app/ 出 stat 指纹，
// 这里优先 import 仓库源码（file:// 绝对 URL + ?v=rev）；失败一律回落 asar 内
// 的 './widget.js'，正式安装不因 dev 通道受损。rev 变化 → import 新 URL（新模块
// 实例）+ mount（旧实例由 win.__QUM_INSTANCE__ 自行回收）。detached 只给 html
// 书签一个 data-qum-dev 标记，便于肉眼确认当前是否走了热更通道。

if (window.location.search.includes('surface=')) return; // onboarding/pet overlay 等副窗口不注入

(async function boot() {
  // 1) 等 document.body
  while (!document.body) {
    await new Promise((r) => setTimeout(r, 50));
  }
  // 2) 轮询锚点（≤3s；超时不再等——widget.mount 自带 fixed 降级，与 loader 语义一致）
  const deadline = Date.now() + 3000;
  while (!document.querySelector('[data-chat-composer], [data-turn-status-bar]') && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }

  const baseUrl = 'http://127.0.0.1:' + QUM_PORT;
  const DEV_POLL_MS = 2000;

  // 3) 探测 dev 指纹：1s 超时；daemon 未起/旧版本 → null（静默回落 asar）。
  const probe = async () => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 1000);
    try {
      const res = await fetch(baseUrl + '/dev/manifest', { signal: ctl.signal, cache: 'no-store' });
      const m = await res.json();
      if (m && m.enabled === true && typeof m.dir === 'string' && /^[0-9a-f]{6,}$/.test(m.rev)) return m;
      return null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  // 绝对 file:// URL（pathname 赋值负责转义空格/非 ASCII；searchParams 负责 ?v=）。
  const devUrl = (m) => {
    const u = new URL('file:///');
    u.pathname = m.dir.replace(/\\/g, '/').replace(/^\/?/, '/') + '/widget.js';
    u.searchParams.set('v', m.rev);
    return u.href;
  };

  let appliedRev = ''; // 最后一次成功挂载的 dev rev；'' = 当前为 asar 产物

  async function mountFrom(m) {
    const widget = m ? await import(devUrl(m)) : await import('./widget.js');
    widget.__QUM__.mount(document.body, {
      baseUrl: baseUrl,
      bootstrapCode: QUM_BOOTSTRAP,
      rev: m ? m.rev : '',
    });
    appliedRev = m ? m.rev : '';
    if (m) {
      try { document.documentElement.setAttribute('data-qum-dev', m.rev); } catch { /* 标记非致命 */ }
    }
  }

  const first = await probe();
  if (first) {
    try {
      await mountFrom(first);
    } catch {
      await mountFrom(null); // 首次 dev import 失败（CSP/路径）→ 回落 asar 产物
    }
  } else {
    await mountFrom(null);
  }

  // 4) 前台每 2s 探测；rev 变化 → 新 URL import + mount（mount 回收旧实例）。
  //    hidden 跳过；失败保留旧实例，下轮再看（rev 未变时 import 失败会被 ESM 缓存，
  //    再次保存文件产生新 rev 即恢复，与本通道「保存即生效」一致）。
  async function watch() {
    try {
      if (document.visibilityState !== 'hidden') {
        const m = await probe();
        if (m && m.rev !== appliedRev) {
          try {
            await mountFrom(m);
          } catch { /* 旧实例继续工作 */ }
        }
      }
    } finally {
      setTimeout(watch, DEV_POLL_MS);
    }
  }
  setTimeout(watch, DEV_POLL_MS);
})().catch(() => {
  // 注入失败绝不影响宿主应用；自检技能/doctor 经 data-qum-* 与补丁标记判断降级。
});
