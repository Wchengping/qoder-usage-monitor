// tests/asarPipeline.test.mjs
// Full closed-loop tests over a FAKE asar — never writes under /opt. The only test
// touching the real client asar (listUnpacked) is READ-ONLY and skipped if absent.
import test from 'node:test'; import assert from 'node:assert/strict';
import asar from '@electron/asar'; import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import { createRequire } from 'node:module';
import { buildPatchedAsar, listUnpacked, verifyPatched, toUnpackOption, assertUnpackSet,
  needsDotFreeStaging, choosePackRoot } from '../scripts/asarPipeline.mjs';
import { appAsarPath } from '../scripts/lib/asarPaths.mjs';

// minimatch EXACTLY as @electron/asar sees it (its own hoisted dependency) —
// this is the matcher the repack `unpack` option is run through.
const nodeRequire = createRequire(import.meta.url);
const asarRequire = createRequire(nodeRequire.resolve('@electron/asar'));
const minimatch = asarRequire('minimatch');
// The SAME brace-expansion minimatch delegates to (resolved through minimatch).
const braceExpandRaw = createRequire(asarRequire.resolve('minimatch'))('brace-expansion');

// Max `{` nesting depth of a glob pattern (depth-1 = a single flat brace group).
const maxBraceDepth = (p) => {
  let d = 0, mx = 0;
  for (const ch of p) { if (ch === '{') mx = Math.max(mx, ++d); else if (ch === '}') d--; }
  return mx;
};

// List every file (relative POSIX path) under a directory tree.
function listTree(root) {
  const out = [];
  const walk = (dir, prefix) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), rel);
      else if (e.isFile()) out.push(rel);
    }
  };
  walk(root, '');
  return out;
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'quma-'));
test.after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

// Source asar mirrors the real client shape: renderer/index.html with a CSP meta +
// </head>, and NATIVE files unpacked at FILE level (the real app.asar's 31 unpacked
// entries are all file-level under node_modules/). `keepme.js` shares the native dir
// but stays packed — the fixture proves the repack glob is precise (no `<dir>/*`).
async function mkFakeAsar(name = 'fake.asar') {
  const src = path.join(TMP, `src-${name}`);
  fs.mkdirSync(path.join(src, 'out/renderer/assets'), { recursive: true });
  fs.writeFileSync(path.join(src, 'out/renderer/index.html'),
    `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self';"/>
<script type="module" src="./assets/main.js"></script></head><body></body>`);
  fs.writeFileSync(path.join(src, 'out/renderer/assets/main.js'), 'console.log(1)');
  fs.mkdirSync(path.join(src, 'node_modules/native'), { recursive: true });
  fs.writeFileSync(path.join(src, 'node_modules/native/binding.node'), 'BIN');
  fs.writeFileSync(path.join(src, 'node_modules/native/helper.js'), 'H');
  fs.writeFileSync(path.join(src, 'node_modules/native/keepme.js'), 'DECOY');
  const a = path.join(TMP, name);
  // @electron/asar@3.4.1 exposes no *Sync packer; await the real async API.
  await asar.createPackageWithOptions(src, a,
    { unpack: '{**/node_modules/native/binding.node,**/node_modules/native/helper.js}' });
  return a;
}

test('listUnpacked returns file-level unpacked paths from the header', async () => {
  const src = await mkFakeAsar();
  assert.deepEqual(listUnpacked(src).sort(),
    ['node_modules/native/binding.node', 'node_modules/native/helper.js']);
});

test('round trip preserves unpacked (precisely) and injects the widget', async () => {
  const src = await mkFakeAsar();
  const widgetDir = path.join(TMP, 'widget');
  fs.mkdirSync(widgetDir, { recursive: true });
  fs.writeFileSync(path.join(widgetDir, 'widget.js'), '/*widget*/');
  fs.writeFileSync(path.join(widgetDir, 'widget.css'), '/*css*/');
  fs.writeFileSync(path.join(widgetDir, 'loader.js'), '/*stale-loader-should-not-survive*/');

  const { newAsarPath, unpackedGlobList, sha256Orig, sha256New } = await buildPatchedAsar({
    srcAsar: src, outDir: path.join(TMP, 'build'), widgetFilesDir: widgetDir,
    port: 49789, bootstrapCode: 'b0t', version: '0.1.0',
  });

  // per-entry unpack globs mention the native files
  assert.ok(unpackedGlobList.some((g) => g.includes('node_modules/native')));

  // verify hook agrees the artifact is patched
  assert.equal(verifyPatched(newAsarPath), true);

  // index.html patched in place: CSP allowance + loader reference
  const html = asar.extractFile(newAsarPath, 'out/renderer/index.html').toString();
  assert.match(html, /connect-src 'self' http:\/\/127\.0\.0\.1:49789/);
  assert.match(html, /monitor\/loader\.js/);

  // widget copied; loader GENERATED (wins over any copied loader.js — controller ruling)
  assert.ok(asar.extractFile(newAsarPath, 'out/renderer/monitor/widget.js').length > 0);
  const loader = asar.extractFile(newAsarPath, 'out/renderer/monitor/loader.js').toString();
  assert.match(loader, /QUM_PORT = 49789/);
  assert.doesNotMatch(loader, /stale-loader-should-not-survive/);

  // .unpacked dir carries the native files, but NOT the packed decoy (precision)
  const unpackDir = path.join(path.dirname(newAsarPath), 'app.asar.new.unpacked', 'node_modules', 'native');
  assert.ok(fs.existsSync(path.join(unpackDir, 'binding.node')));
  assert.ok(!fs.existsSync(path.join(unpackDir, 'keepme.js')));

  // sha256 of both artifacts, and they differ
  assert.match(sha256Orig, /^[0-9a-f]{64}$/);
  assert.match(sha256New, /^[0-9a-f]{64}$/);
  assert.notEqual(sha256Orig, sha256New);
});

test('build tolerates an unpacked entry missing on disk: empty placeholder + warning', async () => {
  const src = await mkFakeAsar('fake-missing.asar');
  // Real-client defect: header marks entries unpacked but their backing files are
  // absent from app.asar.unpacked (Electron never reads them at runtime). Simulate
  // by deleting ONE unpacked file from the archive's .unpacked dir (header intact).
  const gone = path.join(TMP, 'fake-missing.asar.unpacked', 'node_modules', 'native', 'helper.js');
  fs.rmSync(gone);
  assert.ok(!fs.existsSync(gone));

  const logs = [];
  const { newAsarPath } = await buildPatchedAsar({
    srcAsar: src, outDir: path.join(TMP, 'build-missing'), widgetFilesDir: null,
    port: 49789, bootstrapCode: 'b0t', version: '0.1.0',
    log: (m) => logs.push(String(m)),
  });

  // build succeeded; header parity preserved: entry still listed as unpacked
  assert.ok(listUnpacked(newAsarPath).includes('node_modules/native/helper.js'));
  // repacked .unpacked carries a 0-BYTE placeholder for the missing entry,
  // while the present unpacked file was copied through untouched
  const unpackDir = path.join(TMP, 'build-missing', 'app.asar.new.unpacked', 'node_modules', 'native');
  assert.equal(fs.statSync(path.join(unpackDir, 'helper.js')).size, 0);
  assert.equal(fs.readFileSync(path.join(unpackDir, 'binding.node'), 'utf8'), 'BIN');
  // extraction tree itself also has the placeholder (repack source)
  assert.equal(fs.statSync(path.join(TMP, 'build-missing', 'extract',
    'node_modules', 'native', 'helper.js')).size, 0);
  // a warning was emitted (never a throw) — Chinese msg per controller ruling
  assert.ok(logs.some((l) => l.includes('1 个 unpacked 条目磁盘缺失')), `logs: ${logs}`);
});

test('verifyPatched is false for a non-patched asar', async () => {
  const src = await mkFakeAsar(); // source index.html is NOT patched
  assert.equal(verifyPatched(src), false);
});

test('listUnpacked on the real asar finds only node_modules native entries',
  { skip: !fs.existsSync(appAsarPath()) }, () => {
  const u = listUnpacked(appAsarPath());
  assert.ok(u.length > 0 && u.every((p) => p.replace(/\\/g, '/').startsWith('node_modules/')));
});

// ---------------------------------------------------------------------------
// Brace-budget regression (Task 12 rehearsal defect, round 2). History:
//   * flat 31-way brace (1910 chars)          -> silent ZERO unpacked,
//   * tree-compressed NESTED braces (depth 4,  773 chars) -> still silent ZERO
//     on the real client (guard fired: "expected 31, got 0"). brace-expansion
//     1.1.x silently TRUNCATES any pattern whose total expansion crosses its
//     budget (maxMB-scale ~16, older builds ~5 sub-expansions) or whose nesting
//     depth exceeds its cap — the dropped branches simply never enter the
//     expansion list, so minimatch matches NOTHING and repack ships a corrupt
//     all-packed asar. This host resolves brace-expansion@1.1.21 (cap 100000),
//     which is why the round-1 unit probes passed while the real client failed:
//     the probe and the client were not running the same expansion budget.
// RULING: emit ONLY depth-1 brace groups built from collapsed fully-unpacked
// dirs (`dir/**`) plus exact leaf paths, total alternatives <= 16, else throw.
// The probes below call minimatch(absPath, pattern, {matchBase:true}) VERBATIM
// — exactly as @electron/asar does — never a self-built splitter, and also
// re-check the pattern under an explicit budget via brace-expansion directly.
// ---------------------------------------------------------------------------

// The depth-4 tree-compressed pattern shipped at HEAD a506119 for the real
// 31-entry set WITHOUT allFiles (verbatim output of the old toUnpackOption).
// Hardcoded to document the trap and prove the replacement survives it.
const OLD_NESTED_773 =
  '**/node_modules/{@img/{sharp-libvips-linux-x64/{lib/{glib-2.0/include/glibconfig.h,index.js,libvips-cpp.so.8.17.3},package.json,versions.json},sharp-libvips-linuxmusl-x64/{lib/{glib-2.0/include/glibconfig.h,index.js,libvips-cpp.so.8.17.3},package.json,versions.json},sharp-linux-x64/{lib/sharp-linux-x64.node,LICENSE,package.json},sharp-linuxmusl-x64/{lib/sharp-linuxmusl-x64.node,LICENSE,package.json}},@napi-rs/{canvas-linux-x64-gnu/{package.json,skia.linux-x64-gnu.node},canvas-linux-x64-musl/{package.json,skia.linux-x64-musl.node}},node-pty/{build/Release/pty.node,prebuilds/{darwin-arm64/{pty.node,spawn-helper},darwin-x64/{pty.node,spawn-helper},win32-arm64/{conpty.node,conpty_console_list.node,pty.node},win32-x64/{conpty.node,conpty_console_list.node,pty.node}}}}';

test('TRAP regression: the depth-4 nested pattern busts any maxMB-style budget', () => {
  assert.equal(OLD_NESTED_773.length, 773);
  assert.equal(maxBraceDepth(OLD_NESTED_773), 4);
  // 31 total expansions: over minimatch maxMB (16) and far over the ~5
  // sub-expansion budgets of older brace-expansion 1.1.x builds.
  assert.equal(minimatch.braceExpand(OLD_NESTED_773).length, 31);
  // Simulate the budget that made the real client fail: expansion stops at 16,
  // the remaining 15 files (EVERY node-pty entry among them) are silently
  // dropped from the expansion list -> zero matches for them -> 0 unpacked.
  const truncated = braceExpandRaw(OLD_NESTED_773, { max: 16 });
  assert.equal(truncated.length, 16);
  const covered = REAL_31.filter((rel) => truncated.includes(`**/${rel}`));
  assert.equal(covered.length, 16);
  assert.equal(covered.filter((r) => r.startsWith('node_modules/node-pty')).length, 0,
    'all 11 node-pty entries vanish under the budget — the silent-zero class');
});

test('toUnpackOption emits a DEPTH-1 pattern from collapsed dirs; minimatch verbatim matches all 31', () => {
  const { globList, unpackOption } = toUnpackOption(REAL_31, REAL_ALL);
  assert.equal(globList.length, 31); // per-entry manifest unchanged
  assert.ok(unpackOption.startsWith('**/'), 'must match absolute pack paths');
  // RULING: exactly one brace group, nesting depth 1, <= 16 alternatives.
  assert.equal(maxBraceDepth(unpackOption), 1, `nested braces not allowed: ${unpackOption}`);
  assert.equal((unpackOption.match(/\{/g) || []).length, 1, 'single brace group only');
  const expanded = minimatch.braceExpand(unpackOption);
  assert.ok(expanded.length <= 16, `brace expansion over budget: ${expanded.length}`);
  // Collapse ONLY where fully unpacked: 4 @img package dirs (the @img scope
  // carries a packed decoy pkg so it cannot collapse), the whole @napi-rs
  // scope (BOTH packages fully unpacked in this fixture), node-pty/build/**
  // and node-pty/prebuilds/** (node-pty itself stays open — packed
  // package.json/lib) -> 7 flat alternatives.
  assert.equal(expanded.length, 7);
  // survives the SAME budget simulation that killed the nested pattern:
  assert.deepEqual(braceExpandRaw(unpackOption, { max: 16 }), expanded);
  // PROBE VERBATIM as @electron/asar calls it (abs path, matchBase) — the test
  // that would have caught the silent-zero: it must use the ACTUAL generated
  // pattern through minimatch itself, never a hand-rolled splitter.
  for (const rel of REAL_31) {
    const abs = path.join('/home/user/build/extract', rel);
    assert.ok(minimatch(abs, unpackOption, { matchBase: true }), `must match ${rel}`);
  }
  // precision: decoys must NOT match (a `**` alternative may only cover a
  // directory whose ENTIRE subtree is unpacked)
  for (const decoy of [
    'node_modules/other/index.js',
    'node_modules/@img/other-pkg/lib/x.node',
    'node_modules/node-pty/package.json',
    'node_modules/node-pty/lib/index.js',
    'out/renderer/index.html',
  ]) {
    const abs = path.join('/home/user/build/extract', decoy);
    assert.ok(!minimatch(abs, unpackOption, { matchBase: true }), `must reject ${decoy}`);
  }
});

test('toUnpackOption without tree info emits exact leaves only (no ** collapse)', () => {
  const subset = REAL_31.slice(0, 8);
  const { unpackOption } = toUnpackOption(subset);
  assert.equal(maxBraceDepth(unpackOption), 1);
  assert.ok(!unpackOption.includes('/**'), `refusing to collapse without allFiles: ${unpackOption}`);
  for (const rel of subset) {
    assert.ok(minimatch(`/x/${rel}`, unpackOption, { matchBase: true }), rel);
  }
  const notInSet = 'node_modules/@img/sharp-libvips-linux-x64/README.md';
  assert.ok(!minimatch(`/x/${notInSet}`, unpackOption, { matchBase: true }));
});

test('toUnpackOption refuses a flat 31-way brace even without tree info', () => {
  // 31 leaf alternatives > MAX_ALTS_PER_BRACE — the ORIGINAL silent-zero bug
  // class; collapse is impossible without allFiles, so it must throw loudly.
  assert.throws(() => toUnpackOption(REAL_31), /brace budget|exceeds/i);
});

test('toUnpackOption fails loudly when even compression cannot fit the budget', () => {
  const many = [];
  const all = [];
  for (let i = 0; i < 120; i++) {
    const p = `node_modules/pkg-${i}/bin/native-${i}.node`;
    many.push(p);
    all.push(p);
  }
  // one packed file somewhere in node_modules blocks a root-level ** collapse,
  // forcing 120 collapsed-dir alternatives
  all.push('node_modules/zz-keep/index.js');
  assert.throws(() => toUnpackOption(many, all), /brace|budget/i);
});

// Representative REAL 31-entry shape (verbatim from /opt/Qoder CN app.asar).
const REAL_31 = [
  'node_modules/@img/sharp-libvips-linux-x64/lib/glib-2.0/include/glibconfig.h',
  'node_modules/@img/sharp-libvips-linux-x64/lib/index.js',
  'node_modules/@img/sharp-libvips-linux-x64/lib/libvips-cpp.so.8.17.3',
  'node_modules/@img/sharp-libvips-linux-x64/package.json',
  'node_modules/@img/sharp-libvips-linux-x64/versions.json',
  'node_modules/@img/sharp-libvips-linuxmusl-x64/lib/glib-2.0/include/glibconfig.h',
  'node_modules/@img/sharp-libvips-linuxmusl-x64/lib/index.js',
  'node_modules/@img/sharp-libvips-linuxmusl-x64/lib/libvips-cpp.so.8.17.3',
  'node_modules/@img/sharp-libvips-linuxmusl-x64/package.json',
  'node_modules/@img/sharp-libvips-linuxmusl-x64/versions.json',
  'node_modules/@img/sharp-linux-x64/LICENSE',
  'node_modules/@img/sharp-linux-x64/lib/sharp-linux-x64.node',
  'node_modules/@img/sharp-linux-x64/package.json',
  'node_modules/@img/sharp-linuxmusl-x64/LICENSE',
  'node_modules/@img/sharp-linuxmusl-x64/lib/sharp-linuxmusl-x64.node',
  'node_modules/@img/sharp-linuxmusl-x64/package.json',
  'node_modules/@napi-rs/canvas-linux-x64-gnu/package.json',
  'node_modules/@napi-rs/canvas-linux-x64-gnu/skia.linux-x64-gnu.node',
  'node_modules/@napi-rs/canvas-linux-x64-musl/package.json',
  'node_modules/@napi-rs/canvas-linux-x64-musl/skia.linux-x64-musl.node',
  'node_modules/node-pty/build/Release/pty.node',
  'node_modules/node-pty/prebuilds/darwin-arm64/pty.node',
  'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper',
  'node_modules/node-pty/prebuilds/darwin-x64/pty.node',
  'node_modules/node-pty/prebuilds/darwin-x64/spawn-helper',
  'node_modules/node-pty/prebuilds/win32-arm64/conpty.node',
  'node_modules/node-pty/prebuilds/win32-arm64/conpty_console_list.node',
  'node_modules/node-pty/prebuilds/win32-arm64/pty.node',
  'node_modules/node-pty/prebuilds/win32-x64/conpty.node',
  'node_modules/node-pty/prebuilds/win32-x64/conpty_console_list.node',
  'node_modules/node-pty/prebuilds/win32-x64/pty.node',
];
// Everything packed in the extract tree besides the 31 (decopies stay packed;
// their presence must PREVENT `**` collapse at their ancestor dirs).
const REAL_ALL = [
  ...REAL_31,
  'node_modules/node-pty/package.json',
  'node_modules/node-pty/lib/index.js',
  'node_modules/@img/other-pkg/lib/x.node',
  'node_modules/other/index.js',
  'out/renderer/index.html',
];

test('assertUnpackSet throws the fail-closed mismatch error (loud, exact counts)', () => {
  assert.doesNotThrow(() => assertUnpackSet(['a/b.node', 'c/d.node'], ['c/d.node', 'a/b.node']));
  assert.throws(
    () => assertUnpackSet(['a/b.node', 'c/d.node'], ['a/b.node']),
    /repack unpack-set mismatch: expected 2, got 1/,
  );
  // silent over-unpack (the 225MB corruption class) is a mismatch too
  assert.throws(
    () => assertUnpackSet(['a/b.node'], ['a/b.node', 'a/c.node']),
    /repack unpack-set mismatch: expected 1, got 2/,
  );
});

// 40-way stress: >16-alternative source set. fullA/fullB collapse to **
// (fully-unpacked dirs), mixed/ stays at exact leaves (keepme.js packed).
const STRESS_40 = [
  ...['fullA', 'fullB'].flatMap((d) => Array.from({ length: 10 }, (_, i) => `node_modules/${d}/f${i}.node`)),
  ...Array.from({ length: 10 }, (_, i) => `node_modules/mixed/u${i}.node`),
];
test('round trip over a 40-unpacked-file fake asar keeps the unpack set exact', async () => {
  const src = path.join(TMP, 'src-40');
  fs.mkdirSync(path.join(src, 'out/renderer'), { recursive: true });
  fs.writeFileSync(path.join(src, 'out/renderer/index.html'),
    `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self';"/>
<script type="module" src="./assets/main.js"></script></head><body></body>`);
  for (const rel of STRESS_40) {
    const p = path.join(src, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `X-${rel}`);
  }
  // packed decoys: keepme.js shares mixed/ and MUST block its ** collapse
  for (const decoy of ['node_modules/mixed/keepme.js', 'node_modules/other/index.js']) {
    const p = path.join(src, ...decoy.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'DECOY');
  }
  const a40 = path.join(TMP, 'fake40.asar');
  await asar.createPackageWithOptions(src, a40,
    { unpack: toUnpackOption(STRESS_40, listTree(src)).unpackOption });
  assert.deepEqual(listUnpacked(a40).slice().sort(), STRESS_40.slice().sort());

  const widgetDir = path.join(TMP, 'widget40');
  fs.mkdirSync(widgetDir, { recursive: true });
  fs.writeFileSync(path.join(widgetDir, 'widget.js'), '/*widget*/');
  const outDir = path.join(TMP, 'build40');
  const { newAsarPath } = await buildPatchedAsar({
    srcAsar: a40, outDir, widgetFilesDir: widgetDir,
    port: 49789, bootstrapCode: 'b0t', version: '0.1.0',
  });

  // fail-closed guard already ran inside the build; assert set equality anyway
  assert.deepEqual(listUnpacked(newAsarPath).slice().sort(), STRESS_40.slice().sort());
  // .unpacked dir carries EXACTLY the 40 files (collapsed ** did not over-unpack)
  assert.deepEqual(listTree(path.join(outDir, 'app.asar.new.unpacked')).sort(), STRESS_40.slice().sort());
  // decoys stayed packed: absent from .unpacked, still readable from the archive
  assert.ok(!fs.existsSync(path.join(outDir, 'app.asar.new.unpacked',
    'node_modules/mixed/keepme.js'.split('/').join(path.sep))));
  assert.equal(asar.extractFile(newAsarPath, 'node_modules/mixed/keepme.js').toString(), 'DECOY');
  assert.equal(asar.extractFile(newAsarPath, 'node_modules/other/index.js').toString(), 'DECOY');
});

// ---------------------------------------------------------------------------
// Dot-segment root cause (Task 12 rehearsal, round 3 — the REAL mechanism).
// @electron/asar lib/asar.js:147 runs `minimatch(filename, unpack, ...)` where
// `filename` is the ABSOLUTE path of each crawled file (the computed
// `relativePath` is only used for unpackDir). Our emitted `**/{...}` patterns
// therefore need `**` to cross every leading path segment of the pack root.
// minimatch defaults to dot:false: `**` refuses any segment starting with '.'.
// The install outDir '~/.qoder-monitor/build/extract' contains the dot-leading
// segment '.qoder-monitor' → the pattern matches NOTHING → silent zero unpack
// on the real install, while /tmp scratch probes (no dot segment) said 31/31.
// This single mechanism explains BOTH prior "brace budget" diagnoses.
// FIX (option A): when the pack root would contain a dot-leading segment,
// stage extract+patch+pack under os.tmpdir()/qum-pack-<id> (dot-free), then
// move app.asar.new + app.asar.new.unpacked into outDir.
// ---------------------------------------------------------------------------

test('minimatch probe: dot-leading parent segment kills the **/ pattern (root cause)', () => {
  const pattern = '**/{node_modules/@img/sharp-linux-x64/**,node_modules/node-pty/build/**}';
  const leaf = 'node_modules/node-pty/build/Release/pty.node';
  // dot-free root: matches (this is what scratch probes saw)
  assert.equal(minimatch(`/tmp/x/build/extract/${leaf}`, pattern, { matchBase: true }), true);
  // dot-leading segment anywhere in the absolute prefix: ZERO match, dot:false
  assert.equal(minimatch(`/home/user/.qoder-monitor/build/extract/${leaf}`,
    pattern, { matchBase: true }), false);
  // ...and the same path WOULD match with dot:true — proving the refusal is
  // purely the dot rule, not the brace shape. asar never passes dot:true.
  assert.equal(minimatch(`/home/user/.qoder-monitor/build/extract/${leaf}`,
    pattern, { matchBase: true, dot: true }), true);
});

test('needsDotFreeStaging: true iff some segment starts with "." (excluding . and ..)', () => {
  assert.equal(needsDotFreeStaging('/home/user/.qoder-monitor/build/extract'), true);
  assert.equal(needsDotFreeStaging('/tmp/qum-pack-123/extract'), false);
  assert.equal(needsDotFreeStaging('/var/tmp/a.b/c'), false); // dot INSIDE a segment is fine
  assert.equal(needsDotFreeStaging('/srv/build/.hidden/x'), true);
  // '.' and '..' exact segments never count
  assert.equal(needsDotFreeStaging('/srv/./build/../x'), false);
  assert.equal(needsDotFreeStaging('relative/.dir'), true);
  assert.equal(needsDotFreeStaging('/home/root'), false);
});

test('choosePackRoot: stages only when outDir has a dot segment and tmpdir is clean', () => {
  // dot-free outDir -> in place, no staging
  assert.deepEqual(
    choosePackRoot({ outDir: '/tmp/quma-abc/build', tmpdir: '/tmp', stageId: '7-0' }),
    { packRoot: '/tmp/quma-abc/build', staged: false });
  // dot-leading outDir + dot-free tmpdir -> stage under tmpdir
  assert.deepEqual(
    choosePackRoot({ outDir: '/home/u/.qoder-monitor/build', tmpdir: '/tmp', stageId: '7-0' }),
    { packRoot: path.join('/tmp', 'qum-pack-7-0'), staged: true });
  // tmpdir itself has a dot segment -> staging cannot help -> in place (fail-closed
  // assertUnpackSet still guards; documented behavior)
  assert.deepEqual(
    choosePackRoot({ outDir: '/home/u/.qoder-monitor/build', tmpdir: '/mnt/.tmp', stageId: '7-0' }),
    { packRoot: '/home/u/.qoder-monitor/build', staged: false });
});

test('REGRESSION: buildPatchedAsar with a dot-leading outDir succeeds via dot-free staging', async () => {
  const src = await mkFakeAsar('fake-dotparent.asar');
  // reproduce the install layout: a dot-leading segment ANCESTRAL to the pack
  // root (outDir/extract). mkdtempSync cannot make hidden dirs — mkdir manually.
  const dotParent = path.join(TMP, '.dotparent-qum');
  fs.mkdirSync(dotParent, { recursive: true });
  const outDir = path.join(dotParent, 'build');

  const logs = [];
  const { newAsarPath, unpackedGlobList } = await buildPatchedAsar({
    srcAsar: src, outDir, widgetFilesDir: null,
    port: 49789, bootstrapCode: 'b0t', version: '0.1.0',
    log: (m) => logs.push(String(m)),
  });

  // artifacts land in the REAL outDir, not the staging dir
  assert.equal(newAsarPath, path.join(outDir, 'app.asar.new'));
  assert.ok(fs.existsSync(newAsarPath));
  assert.ok(fs.existsSync(path.join(outDir, 'app.asar.new.unpacked',
    'node_modules/native/binding.node')));
  // fail-closed guard passed: repacked unpack set == source's exactly
  assert.deepEqual(listUnpacked(newAsarPath).slice().sort(),
    ['node_modules/native/binding.node', 'node_modules/native/helper.js']);
  // patterns stay **/-prefixed (correct on a dot-free pack root)
  assert.ok(unpackedGlobList.every((g) => g.startsWith('**/')));
  // a staging build was logged; the staging dir was removed on exit (even the
  // per-build extract tree must be gone)
  const stageMsg = logs.find((l) => l.includes('staged'));
  assert.ok(stageMsg, `expected staging log line, got: ${logs}`);
  const staged = /staged at (\S+)/.exec(stageMsg);
  if (staged) assert.ok(!fs.existsSync(staged[1]), `staging dir leaked: ${staged[1]}`);
});

test('staging is cleaned up even when the build fails inside the staging path', async () => {
  // no index.html in the source -> buildPatchedAsar throws after staging began
  const badSrcDir = path.join(TMP, 'src-noindex-dot');
  fs.mkdirSync(path.join(badSrcDir, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(badSrcDir, 'node_modules/x.node'), 'X');
  const badAsar = path.join(TMP, 'fake-noindex.asar');
  await asar.createPackageWithOptions(badSrcDir, badAsar, { unpack: '**/node_modules/x.node' });

  const outDir = path.join(TMP, '.dotparent-qum', 'build-fail');
  const logs = [];
  await assert.rejects(buildPatchedAsar({
    srcAsar: badAsar, outDir, widgetFilesDir: null,
    port: 49789, bootstrapCode: 'b0t', version: '0.1.0',
    log: (m) => logs.push(String(m)),
  }), /index\.html not found/);
  const stageMsg = logs.find((l) => l.includes('staged'));
  assert.ok(stageMsg, `expected staging log line, got: ${logs}`);
  const staged = /staged at (\S+)/.exec(stageMsg);
  if (staged) assert.ok(!fs.existsSync(staged[1]), `staging dir leaked: ${staged[1]}`);
});
