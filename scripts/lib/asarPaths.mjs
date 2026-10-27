// scripts/lib/asarPaths.mjs
// Task 7 — 目标客户端资源路径的唯一来源。
// 红线：所有路径都从 env 覆盖派生（测试用 QUM_APP_ASAR + QUM_HOME），默认值指向
// /opt，但本模块只计算路径，从不访问文件系统；/opt 只有在真实安装时才被上层脚本触碰。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// 2026-10-23 客户端 0.4.7→0.4.9 自动更新把安装目录从 "/opt/Qoder CN"（带空格）迁到
// "/opt/Qoder-CN"（无空格），旧目录只剩 app.asar.orig / unpacked 残留。默认取新路径，
// 但按 app.asar 是否存在做一次回退检测——两边都可能出现残留目录，不能只看目录存在。
const PRIMARY_RESOURCES = '/opt/Qoder-CN/resources';
const LEGACY_RESOURCES = '/opt/Qoder CN/resources';

/** 默认真机 resources 目录（无 env 覆盖时）：优先有 app.asar 的新路径，再回退旧路径。 */
export function defaultResourcesDir(exists = fs.existsSync) {
  for (const dir of [PRIMARY_RESOURCES, LEGACY_RESOURCES]) {
    if (exists(path.join(dir, 'app.asar'))) return dir;
  }
  return PRIMARY_RESOURCES;
}

/** resources 目录：QUM_APP_ASAR ? dirname(QUM_APP_ASAR) : defaultResourcesDir()。 */
export function resourcesDir() {
  const override = process.env.QUM_APP_ASAR;
  if (override) return path.dirname(override);
  return defaultResourcesDir();
}

/** app.asar 路径：QUM_APP_ASAR 覆盖或 resourcesDir()/app.asar。 */
export function appAsarPath() {
  return process.env.QUM_APP_ASAR || path.join(resourcesDir(), 'app.asar');
}

/** 派生全套路径；asarPath 可显式覆盖（测试直接传参）。 */
export function targetPaths(asarPath = appAsarPath()) {
  const dir = path.dirname(asarPath);
  return {
    resourcesDir: dir,
    asar: asarPath,
    orig: asarPath + '.orig',
    unpacked: asarPath + '.unpacked',
    appUpdateYml: path.join(dir, 'app-update.yml'),
    productJson: path.join(dir, 'product.json'),
  };
}

export function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/** appVersion：先 resources/app-update.yml 的 version:，再 product.json 的 version，都缺 → "unknown"。 */
export function readAppVersion(paths) {
  try {
    const yml = fs.readFileSync(paths.appUpdateYml, 'utf8');
    const m = yml.match(/^\s*version:\s*['"]?([^'"\s]+)['"]?/m);
    if (m) return m[1];
  } catch { /* fall through */ }
  try {
    const json = JSON.parse(fs.readFileSync(paths.productJson, 'utf8'));
    if (json && typeof json.version === 'string' && json.version) return json.version;
  } catch { /* fall through */ }
  return 'unknown';
}
