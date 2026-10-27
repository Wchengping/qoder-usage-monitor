// tests/scaffold.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import asar from '@electron/asar';
import fs from 'node:fs';
import { appAsarPath } from '../scripts/lib/asarPaths.mjs';
const ASAR = process.env.QUM_APP_ASAR ?? appAsarPath();

test('real app.asar header exposes renderer index.html', { skip: !fs.existsSync(ASAR) }, () => {
  const arch = asar.statFile(ASAR, 'out/renderer/index.html');
  assert.ok(arch.size > 0 && arch.size < 100_000);
  const html = asar.extractFile(ASAR, 'out/renderer/index.html').toString('utf8');
  assert.match(html, /Content-Security-Policy/);
});
