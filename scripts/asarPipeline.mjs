// scripts/asarPipeline.mjs
// Unpack -> patch -> repack pipeline for the Qoder Usage Monitor installer (Task 6).
//
// Produces a patched app.asar.new from a real client app.asar:
//   * tolerant header extraction (unpacked native files land back on disk in the
//     tree; unpacked header entries whose backing file is missing from
//     app.asar.unpacked become EMPTY placeholders instead of aborting the build —
//     Task 12 rehearsal: the real client ships 31 unpacked entries, 4 of them
//     absent on disk, and asar.extractAll throws ENOENT on each),
//   * patch out/renderer/index.html in place (CSP + loader tag, via Task 5 transforms),//   * copy widget files and GENERATE monitor/loader.js (renderLoader wins over any
//     copied loader.js — see controller ruling),
//   * repack preserving the source's unpacked entries via a DEPTH-1 brace
//     minimatch pattern (one flat group of <= 16 alternatives, each a `dir/**`
//     over a fully-unpacked directory or an exact leaf — NEVER nested braces,
//     which brace-expansion 1.1.x silently truncates) — never a broad
//     `<dir>/*` catch-all — followed by a FAIL-CLOSED unpack-set check: the
//     repacked header's unpacked set must equal the source's exactly, or the
//     build throws. (Task 12 rehearsal: both the flat 31-way pattern and a
//     depth-4 tree-compressed one blew @electron/asar's minimatch brace-
//     expansion budget on the real client; minimatch then silently matched
//     NOTHING and repack shipped a corrupt all-packed 225MB asar. The guard
//     turns any future glob subtlety into a loud build failure instead of
//     silent client corruption.)
//   * repack runs from a DOT-FREE pack root: asar matches `unpack` against the
//     ABSOLUTE file path and minimatch `**` refuses dot-leading segments
//     (dot:false), so an outDir like '~/.qoder-monitor/build/extract' matched
//     NOTHING. buildPatchedAsar now stages extract+patch+pack under
//     os.tmpdir()/qum-pack-<id> whenever outDir has a dot-leading segment,
//     then moves app.asar.new(+.unpacked) back — see the dot-segment block.
//
// This module never writes outside `outDir` and only ever READS the source asar.

import asar from '@electron/asar';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { patchIndexHtml, isPatched, renderLoader } from './patchTransforms.mjs';

// Relative paths (POSIX-style) of every header node flagged `unpacked: true`.
// In the real client asar these are file-level entries (spec: 31, all under
// node_modules/); directory-level unpacked nodes are included if present.
export function listUnpacked(asarPath) {
  const header = asar.getRawHeader(asarPath).header;
  const found = [];
  const walk = (node, prefix) => {
    if (!node || !node.files) return;
    for (const [name, child] of Object.entries(node.files)) {
      const rel = prefix ? `${prefix}/${name}` : name;
      if (child.unpacked === true) found.push(rel);
      if (child.files) walk(child, rel);
    }
  };
  walk(header, '');
  return found;
}

// Budget for the `unpack` pattern. @electron/asar matches it through
// minimatch@3.1.5, whose brace-expansion silently TRUNCATES patterns past its
// budget (older 1.1.x builds cap sub-expansions around 5, maxMB-scale builds 16,
// this host's 1.1.21 100000 — version-dependent, and any truncation drops
// branches from the expansion list so minimatch matches NOTHING). Rehearsal on
// the real client: a flat 31-way pattern AND the depth-4 tree-compressed
// replacement both unpacked ZERO files. RULING: never emit nested braces —
// ONE depth-1 brace group over collapsed `dir/**` alternatives + exact leaves,
// total alternatives <= MAX_ALTS_PER_BRACE, verified by assertUnpackSet below.
const MAX_ALTS_PER_BRACE = 16;
// sanity cap only — chars are NOT a brace-expansion risk for a depth-1 group
// (its budget counts expansions, and 16 full relative paths fit well under any
// version's maxLength); keep it bounded so the pattern stays debuggable.
const MAX_UNPACK_PATTERN_LENGTH = 2000;
// characters minimatch treats as glob magic — an unpack path containing them
// cannot be embedded literally, and silently mis-matching is the failure mode
// we are fixing, so refuse loudly.
const GLOB_UNSAFE = /[{}[\]()*?!,|'"\\]/;

const toPosix = (p) => String(p).replace(/\\/g, '/');

// Build ONE minimatch pattern from the unpacked relative paths. Shape is
// enforced by the brace-budget ruling above:
//   **/{ALT1,ALT2,...,ALTN}   with N <= MAX_ALTS_PER_BRACE and depth EXACTLY 1
// (no braces at all when N === 1). Each ALT is either `dir/**` — allowed ONLY
// when the directory's ENTIRE subtree in the pack source (`allFiles`) is
// unpacked — or an exact relative leaf path. Shared prefixes therefore stay
// OUTSIDE as plain path text of each alternative; there is no second brace
// level anywhere, so no brace-expansion version can truncate our list.
// Without allFiles no collapse is attempted (we cannot prove totality) — if the
// leaf count then exceeds the budget we throw loudly instead of nesting.
// asar matches `unpack` against the ABSOLUTE file path (matchBase is a no-op
// for slashed patterns), hence the `**/` root prefix.
// Returns { globList, unpackOption } — unpackOption undefined for an empty list.
export function toUnpackOption(unpackedRelPaths, allFiles) {
  const norm = unpackedRelPaths.map(toPosix);
  const globList = norm.map((p) => `**/${p}`);
  if (norm.length === 0) return { globList, unpackOption: undefined };
  for (const rel of norm) {
    for (const seg of rel.split('/')) {
      if (GLOB_UNSAFE.test(seg)) {
        throw new Error(`repack unpack path contains glob metacharacters: ${rel}`);
      }
    }
  }

  const unpacked = new Set(norm);
  // file count (from allFiles) and unpacked-file count per ancestor directory,
  // for the `dir/**` totality proof.
  let totalUnder = null;
  let unpackedUnder = null;
  const bump = (map, filePath) => {
    const segs = filePath.split('/');
    for (let i = 1; i < segs.length; i++) {
      const dir = segs.slice(0, i).join('/');
      map.set(dir, (map.get(dir) || 0) + 1);
    }
  };
  if (allFiles) {
    totalUnder = new Map();
    for (const f of allFiles.map(toPosix)) bump(totalUnder, f);
    unpackedUnder = new Map();
    for (const f of norm) bump(unpackedUnder, f);
  }
  const canCollapse = (dir) =>
    totalUnder !== null &&
    totalUnder.get(dir) !== undefined &&
    totalUnder.get(dir) > 0 &&
    totalUnder.get(dir) === (unpackedUnder.get(dir) || 0);

  // path trie of the unpacked set
  const tree = { children: new Map(), files: new Set() };
  for (const rel of unpacked) {
    const segs = rel.split('/');
    let node = tree;
    for (let i = 0; i < segs.length - 1; i++) {
      let child = node.children.get(segs[i]);
      if (!child) { child = { children: new Map(), files: new Set() }; node.children.set(segs[i], child); }
      node = child;
    }
    node.files.add(segs[segs.length - 1]);
  }

  // Walk the trie, replacing the SHALLOWEST fully-unpacked directories with a
  // single `dir/**` alternative; every other entry contributes its exact leaf
  // path. All alternatives are FLAT (no braces inside).
  const alts = [];
  const collect = (dirPath, node) => {
    if (dirPath !== '' && canCollapse(dirPath)) {
      alts.push(`${dirPath}/**`);
      return;
    }
    for (const name of [...node.children.keys()].sort()) {
      collect(dirPath ? `${dirPath}/${name}` : name, node.children.get(name));
    }
    for (const name of [...node.files].sort()) {
      alts.push(dirPath ? `${dirPath}/${name}` : name);
    }
  };
  collect('', tree);

  if (alts.length === 0) throw new Error('repack unpack glob: empty alternative set');
  if (alts.length > MAX_ALTS_PER_BRACE) {
    throw new Error(
      `repack unpack glob exceeds brace budget: ${alts.length} alternatives ` +
      `(max ${MAX_ALTS_PER_BRACE}) — refusing nested/oversized braces that ` +
      `brace-expansion may silently truncate; nothing collapsed enough`,
    );
  }
  const body = alts.length === 1 ? alts[0] : `{${alts.join(',')}}`;
  const unpackOption = `**/${body}`;
  if (unpackOption.length > MAX_UNPACK_PATTERN_LENGTH) {
    throw new Error(
      `repack unpack glob exceeds pattern length cap: ${unpackOption.length} chars ` +
      `(max ${MAX_UNPACK_PATTERN_LENGTH})`,
    );
  }
  return { globList, unpackOption };
}

// Fail-closed self-check (the safety net): the repacked archive must carry
// EXACTLY the source's unpacked set. Anything else — zero-unpack glob failures,
// over-eager `**` collapse, dropped entries — aborts the build BEFORE the
// manual sudo block can ever be printed.
export function assertUnpackSet(expected, actual) {
  const e = [...expected].map(toPosix).sort();
  const a = [...actual].map(toPosix).sort();
  if (e.length === a.length && e.every((x, i) => x === a[i])) return;
  const missing = e.filter((x) => !a.includes(x)).slice(0, 8);
  const extra = a.filter((x) => !e.includes(x)).slice(0, 8);
  throw new Error(
    `repack unpack-set mismatch: expected ${e.length}, got ${a.length}` +
    ` (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'})`,
  );
}

// Every file (and symlink) present in the pack source tree, POSIX-relative —
// used by toUnpackOption to prove `dir/**` collapse totality.
function listTreeFiles(root) {
  const out = [];
  const walk = (dir, prefix) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), rel);
      else if (e.isFile() || e.isSymbolicLink()) out.push(rel);
    }
  };
  walk(root, '');
  return out;
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

// ---------------------------------------------------------------------------
// Dot-free staging root (Task 12 rehearsal, round 3 — the REAL root cause).
// @electron/asar (lib/asar.js:147) matches the `unpack` option with
//   minimatch(filename, unpack, { matchBase: true })
// where `filename` is the ABSOLUTE path of each crawled file — the computed
// relativePath is only used for unpackDir. Our `**/{...}` patterns therefore
// require `**` to cross every leading segment of the pack root, and minimatch
// defaults to dot:false: `**` refuses any segment starting with '.'. The
// install outDir '~/.qoder-monitor/build/extract' has the dot-leading segment
// '.qoder-monitor' -> the pattern matches NOTHING -> silent zero unpack on the
// real install while /tmp scratch probes (dot-free) reported 31/31. This
// single mechanism explains both earlier "brace budget" diagnoses.
// FIX (ruling option A): when the pack root would sit under a dot-leading
// segment, run extract+patch+pack under os.tmpdir()/qum-pack-<id> (dot-free —
// probed via the same helper; on this host /tmp has no dot segments) and move
// app.asar.new + app.asar.new.unpacked back into outDir. Patterns stay
// `**/`-prefixed — correct on a dot-free root. The fail-closed
// assertUnpackSet still guards: if staging + patterns mismatch, the build
// throws loudly as before. Disk: staging is transient (~500MB peak) under
// tmpdir — /tmp here is tmpfs on a 32GB-RAM host, acceptable by ruling; the
// install's own diskFree probe covers outDir for the final artifacts.
// ---------------------------------------------------------------------------

// True iff some path segment STARTS with '.' (exact '.'/'..' never count —
// they are navigational, not real dir names, and never appear in an absolute
// pack root anyway).
export function needsDotFreeStaging(p) {
  return toPosix(p).split('/')
    .some((s) => s !== '.' && s !== '..' && s.startsWith('.'));
}

// Pure pack-root selection (no fs): stage under tmpdir only when outDir needs
// a dot-free root AND tmpdir itself is dot-free. If tmpdir also has a dot
// segment, staging cannot help — fall back in place (documented behavior;
// assertUnpackSet stays fail-closed).
export function choosePackRoot({ outDir, tmpdir, stageId }) {
  if (!needsDotFreeStaging(outDir)) return { packRoot: outDir, staged: false };
  if (needsDotFreeStaging(tmpdir)) return { packRoot: outDir, staged: false };
  return { packRoot: path.join(tmpdir, `qum-pack-${stageId}`), staged: true };
}

// Unique id per staged build within this process (pid + monotonic counter).
let stageSeq = 0;

// Move a file or directory across (possibly different) filesystems: rename,
// falling back to recursive copy + remove on EXDEV (tmpdir may be tmpfs while
// outDir lives on the data disk).
function movePath(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.rmSync(dst, { recursive: true, force: true }); // replace stale artifacts
  try {
    fs.renameSync(src, dst);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.cpSync(src, dst, { recursive: true, force: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
}

// Recursively copy the contents of `from` into `to` (files and dirs).
function copyDirContents(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDirContents(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

// Tolerant replacement for `asar.extractAll` (Task 12 rehearsal defect): the real
// client app.asar marks 31 header entries `unpacked:true` but 4 of their backing
// files are absent from app.asar.unpacked (LICENSE / glib build-time headers that
// Electron never reads at runtime). extractAll throws ENOENT per missing file and
// aborts the whole build. Here we walk the RAW HEADER instead:
//   * packed file   -> asar.extractFile into the tree,
//   * unpacked:true -> copy from <asar>.unpacked/<rel> when present; otherwise an
//     EMPTY placeholder (keeps header parity after repack: the entry stays in the
//     header AND gets glob-unpacked on disk, so runtime lookups hit an empty file
//     instead of not-found — safe for LICENSE/build-time headers, and such files
//     being absent already means nothing in the current client reads them),
//   * dirs mirrored, symlink entries recreated best-effort.
// No chmod/exec-bit preservation: matches the extract-then-repack flow (.node
// modules are dlopen'd through the .unpacked dir, which needs read only).
function extractTolerant(asarPath, dest, log) {
  const header = asar.getRawHeader(asarPath).header;
  const unpackedDir = `${asarPath}.unpacked`;
  let missing = 0;
  fs.mkdirSync(dest, { recursive: true });
  const walk = (node, prefix) => {
    for (const [name, child] of Object.entries(node.files || {})) {
      const rel = prefix ? `${prefix}/${name}` : name;
      const destPath = path.join(dest, rel);
      if (child.files !== undefined) {
        fs.mkdirSync(destPath, { recursive: true });
        walk(child, rel);
      } else if (child.unpacked === true) {
        const src = path.join(unpackedDir, rel);
        if (fs.existsSync(src)) fs.copyFileSync(src, destPath);
        else { fs.writeFileSync(destPath, ''); missing += 1; }
      } else if (child.link !== undefined) {
        // mirror extractAll: relative symlink inside the extracted tree
        const target = path.join(dest, ...String(child.link).split('/'));
        try { fs.symlinkSync(path.relative(path.dirname(destPath), target), destPath); }
        catch { fs.writeFileSync(destPath, ''); }
      } else {
        fs.writeFileSync(destPath, asar.extractFile(asarPath, rel));
      }
    }
  };
  walk(header, '');
  if (missing > 0) log(`warn: ${missing} 个 unpacked 条目磁盘缺失，已用空占位`);
  return missing;
}

export async function buildPatchedAsar({
  srcAsar, outDir, widgetFilesDir, port, bootstrapCode, version, implBody,
  log = (m) => console.warn(m), // injectable for tests; backward-compatible
}) {
  // 0. Choose the pack root: in-place when dot-free, else a transient staging
  //    dir under tmpdir (see dot-segment root-cause block above).
  const { packRoot, staged } = choosePackRoot({
    outDir, tmpdir: os.tmpdir(), stageId: `${process.pid}-${stageSeq++}`,
  });
  if (staged) log(`info: repack staged at ${packRoot} (dot-free root workaround)`);
  try {
    // 1. Tolerant header extraction (missing unpacked backing files -> placeholders).
    const extract = path.join(packRoot, 'extract');
    extractTolerant(srcAsar, extract, log);

    // 2. Patch the renderer index.html in place.
    const indexPath = path.join(extract, 'out', 'renderer', 'index.html');
    if (!fs.existsSync(indexPath)) {
      throw new Error(`buildPatchedAsar: index.html not found at ${indexPath} in ${srcAsar}`);
    }
    const patched = patchIndexHtml(fs.readFileSync(indexPath, 'utf8'), { port });
    fs.writeFileSync(indexPath, patched);

    // 3. Widget files -> out/renderer/monitor/, then the GENERATED loader wins.
    const monitorDir = path.join(extract, 'out', 'renderer', 'monitor');
    if (widgetFilesDir) copyDirContents(widgetFilesDir, monitorDir);
    else fs.mkdirSync(monitorDir, { recursive: true });
    const loaderOpts = { bootstrapCode, port, version };
    if (implBody !== undefined) loaderOpts.implBody = implBody;
    fs.writeFileSync(path.join(monitorDir, 'loader.js'), renderLoader(loaderOpts));

    // 4. Repack preserving the source's unpacked set via the depth-1 brace
    //    minimatch pattern (allFiles from the extract tree enables `dir/**`
    //    collapse ONLY where the whole directory is unpacked). The pack root
    //    is guaranteed dot-free when staged, so `**/` matches on this host.
    const srcUnpacked = listUnpacked(srcAsar);
    const { globList, unpackOption } = toUnpackOption(srcUnpacked, listTreeFiles(extract));
    const stagedAsarPath = path.join(packRoot, 'app.asar.new');
    const packOptions = unpackOption ? { unpack: unpackOption } : {};
    await asar.createPackageWithOptions(extract, stagedAsarPath, packOptions);

    // 4b. FAIL-CLOSED self-check: if the glob silently matched nothing (brace
    //     budget or dot-segment minimatch refusal) or over-matched (bad
    //     collapse), abort NOW — never ship a corrupt asar into the manual
    //     install block.
    assertUnpackSet(srcUnpacked, listUnpacked(stagedAsarPath));

    // 4c. Staged build: move the artifacts back into outDir.
    const newAsarPath = path.join(outDir, 'app.asar.new');
    if (staged) {
      movePath(stagedAsarPath, newAsarPath);
      const stagedUnpacked = `${stagedAsarPath}.unpacked`;
      if (fs.existsSync(stagedUnpacked)) {
        movePath(stagedUnpacked, path.join(outDir, 'app.asar.new.unpacked'));
      }
    }
    fs.chmodSync(newAsarPath, 0o600); // 内嵌 bootstrap：构建产物同样仅属主可读

    // 5. Fingerprints of both artifacts.
    return {
      newAsarPath,
      unpackedGlobList: globList,
      sha256Orig: sha256File(srcAsar),
      sha256New: sha256File(newAsarPath),
    };
  } finally {
    // Staging is transient — remove it even when the build failed.
    if (staged) fs.rmSync(packRoot, { recursive: true, force: true });
  }
}

// Verify a built artifact: index.html carries a qum marker and the widget shipped.
export function verifyPatched(newAsar) {
  try {
    const html = asar.extractFile(newAsar, 'out/renderer/index.html').toString('utf8');
    if (!isPatched(html)) return false;
    const widget = asar.extractFile(newAsar, 'out/renderer/monitor/widget.js');
    return widget.length > 0;
  } catch {
    return false;
  }
}
