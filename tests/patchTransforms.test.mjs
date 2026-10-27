// tests/patchTransforms.test.mjs
import test from 'node:test'; import assert from 'node:assert/strict';
import { patchIndexHtml, unpatchIndexHtml, isPatched, renderLoader } from '../scripts/patchTransforms.mjs';
const SAMPLE = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; frame-src http://127.0.0.1:*;"/>
<script type="module" crossorigin src="./assets/index-nRmb_3VI.js"></script></head><body><div id="root"></div></body>`;

test('patch adds connect-src + loader tag, idempotent', ()=>{
  const p1 = patchIndexHtml(SAMPLE,{port:49789});
  assert.match(p1, /connect-src 'self' http:\/\/127\.0\.0\.1:49789;/);
  assert.match(p1, /src="\.\/monitor\/loader\.js"/);
  assert.equal(patchIndexHtml(p1,{port:49789}), p1);          // 幂等
  assert.equal(isPatched(p1), true);
  const p2 = patchIndexHtml(p1,{port:49810});                 // 换端口重打
  assert.match(p2, /http:\/\/127\.0\.0\.1:49810/);
  assert.doesNotMatch(p2, /49789/);
});
test('unpatch restores', ()=>{ const p=patchIndexHtml(SAMPLE,{port:49789}); const u=unpatchIndexHtml(p);
  assert.doesNotMatch(u, /qum|49789|loader\.js/); assert.equal(isPatched(u), false); });
test('loader embeds bootstrap not token', ()=>{
  const l = renderLoader({bootstrapCode:'b0c7', port:49789, version:'0.1.0'});
  assert.match(l, /QUM_BOOTSTRAP\s*=\s*"b0c7"/); assert.doesNotMatch(l, /daemon\.token/);
});

// --- additional required coverage (context task 5) ---

const WITH_CONNECT_SRC = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'self' https://img.example.com; script-src 'self'"/></head><body></body>`;

test('patch appends port to an existing connect-src directive', ()=>{
  const p1 = patchIndexHtml(WITH_CONNECT_SRC,{port:49789});
  assert.match(p1, /connect-src 'self' https:\/\/img\.example\.com http:\/\/127\.0\.0\.1:49789;/);
  assert.equal(patchIndexHtml(p1,{port:49789}), p1);            // 幂等（追加形）
  const p2 = patchIndexHtml(p1,{port:49999});                   // 换端口
  assert.doesNotMatch(p2, /49789/);
  assert.match(p2, /connect-src 'self' https:\/\/img\.example\.com http:\/\/127\.0\.0\.1:49999;/);
  assert.equal(unpatchIndexHtml(p2), WITH_CONNECT_SRC);         // 字节级还原
});

test('port swap leaves no stale port digits and unpatch restores bytes', ()=>{
  let p = patchIndexHtml(SAMPLE,{port:49789});
  p = patchIndexHtml(p,{port:49810});
  p = patchIndexHtml(p,{port:49811});
  assert.doesNotMatch(p, /49789|49810/);
  assert.equal(unpatchIndexHtml(p), SAMPLE);
});

test('isPatched false on original html', ()=>{
  assert.equal(isPatched(SAMPLE), false);
  assert.equal(isPatched(WITH_CONNECT_SRC), false);
});

// Degenerate append shape: a pre-existing connect-src whose value is just `'self'`
// produces (after append) a directive byte-identical to the freshly injected form,
// so unpatch must not mistake it for an injection and delete the client's own entry.
const DEGENERATE_SELF_ONLY = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'self';"/></head><body></body>`;

test('degenerate merged connect-src (just \'self\') unpatches byte-exactly', ()=>{
  const p1 = patchIndexHtml(DEGENERATE_SELF_ONLY,{port:49789});
  assert.match(p1, /connect-src 'self' http:\/\/127\.0\.0\.1:49789;/);
  assert.equal(p1.includes(`default-src 'self'; connect-src 'self';`), false); // patched, not untouched
  assert.equal(patchIndexHtml(p1,{port:49789}), p1);                            // 幂等
  assert.equal(patchIndexHtml(p1,{port:49999}), patchIndexHtml(DEGENERATE_SELF_ONLY,{port:49999})); // 换端口无残留
  assert.doesNotMatch(patchIndexHtml(p1,{port:49999}), /49789/);
  assert.equal(unpatchIndexHtml(p1), DEGENERATE_SELF_ONLY);                     // 字节级还原
  assert.equal(isPatched(unpatchIndexHtml(p1)), false);
});
