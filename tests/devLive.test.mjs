// tests/devLive.test.mjs
// dev-live（保存即生效，2026-10-15 需求）：daemon 侧 /dev/manifest 指纹 + 模块图 ?v= 传播。
// widget 跨实例回收与样式表版本在 tests/widgetDom.test.mjs（需要 fake DOM 工厂）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { devManifest } from '../daemon/server.mjs';

const FILES = ['widget.js', 'modules.js', 'format.js', 'widget.css'];

function tmpApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qum-dev-'));
  for (const f of FILES) fs.writeFileSync(path.join(dir, f), '/*x*/\n');
  return dir;
}

test('devManifest: rev 随文件 mtime/size 变化；widget.js 缺失 → disabled', () => {
  const dir = tmpApp();
  try {
    const a = devManifest(dir);
    assert.equal(a.enabled, true);
    assert.equal(a.dir, dir);
    assert.match(a.rev, /^[0-9a-f]{12}$/);
    assert.deepEqual(devManifest(dir), a, '无改动时 rev 必须稳定（否则每 2s 空转重挂载）');
    fs.writeFileSync(path.join(dir, 'modules.js'), '/*xx*/\n');
    assert.notEqual(devManifest(dir).rev, a.rev, '内容/大小变化必须换 rev');
    fs.rmSync(path.join(dir, 'widget.js'));
    assert.deepEqual(devManifest(dir), { enabled: false });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('dev 热换：modules.js 继承自身 ?v=，注册落到同 rev 的 widget 实例（否则渲染空转）', async () => {
  const rev = 'test-rev-1';
  const w = await import(`../app/widget.js?v=${rev}`);
  await import(`../app/modules.js?v=${rev}`);
  assert.ok(w.getModules().length > 0, 'registerModule 必须命中同一 rev 的 widget 实例');
});
