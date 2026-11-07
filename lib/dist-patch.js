/**
 * dist 补丁引擎 —— 直接改 Pi 安装目录下的上游 JS。
 *
 * 这是 ctxfold 原始手法的 Pi 版：当扩展 API 够不着某个行为时，
 * 改磁盘上的文件。只在用户显式 `patch apply` 时才动，默认零改动。
 *
 * 三条铁律：
 *   1. 改前必须留 .ctxfold.bak，且只留第一次的原件（幂等）。
 *   2. 打之前记下 Pi 版本；版本变了要提示重打，不能假装还生效。
 *   3. revert 只从 bak 恢复，绝不做"反向字符串替换"。
 */

import fs from "node:fs";
import path from "node:path";
import { DIST_PATCHES, NOT_PATCHED } from "../patches/manifest.js";
import { stripBom } from "./jsonio.js";

const BAK_SUFFIX = ".ctxfold.bak";
const SCOPE = "@earendil-works";

export function statePath(home) {
  return path.join(home, ".ctxfold", "dist-state.json");
}

export function readState(home) {
  try {
    return JSON.parse(stripBom(fs.readFileSync(statePath(home), "utf8")));
  } catch {
    return { piVersion: null, applied: {}, updatedAt: null };
  }
}

function writeState(home, state) {
  const file = statePath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return state;
}

/** 按 semver 大小排，取最高；也可以用 release 参数钉死。 */
export function resolveRelease(home, wanted) {
  const releasesDir = path.join(home, "install", "releases");
  let names = [];
  try {
    names = fs.readdirSync(releasesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return null;
  }
  const pick = (name) => {
    const nodeModules = path.join(releasesDir, name, "node_modules");
    return fs.existsSync(nodeModules) ? { version: name, nodeModules, root: path.join(releasesDir, name) } : null;
  };
  if (wanted) return pick(wanted);
  const sorted = names.sort((a, b) => {
    const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
    const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
      if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
    }
    return 0;
  });
  return pick(sorted.pop());
}

function* walkJs(dir, depth = 0) {
  if (depth > 8) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      yield* walkJs(full, depth + 1);
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      yield full;
    }
  }
}

/** 在 release 里找出所有含这个片段的文件（含 bundle 里的重复副本）。 */
export function locate(release, find, hints = []) {
  const hits = [];
  const seen = new Set();
  for (const hint of hints) {
    const abs = path.join(release.nodeModules, hint.replace(/\//g, path.sep));
    if (!fs.existsSync(abs)) continue;
    const text = fs.readFileSync(abs, "utf8");
    if (text.includes(find)) {
      hits.push({ file: abs, where: "declared" });
      seen.add(path.resolve(abs));
    }
  }
  const scopeDir = path.join(release.nodeModules, SCOPE);
  if (fs.existsSync(scopeDir)) {
    for (const file of walkJs(scopeDir)) {
      const resolved = path.resolve(file);
      if (seen.has(resolved)) continue;
      let text;
      try {
        if (fs.statSync(file).size > 12 * 1024 * 1024) continue;
        text = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      if (text.includes(find)) {
        hits.push({ file, where: "copy" });
        seen.add(resolved);
      }
    }
  }
  return hits;
}

function replaceAll(text, find, replace) {
  return text.split(find).join(replace);
}

/** 判断某条补丁在每个目标文件上的状态。 */
export function inspect(home, { release: wanted } = {}) {
  const release = resolveRelease(home, wanted);
  if (!release) return { ok: false, reason: "找不到 Pi 安装目录（<home>/install/releases/*/node_modules）" };

  const patches = DIST_PATCHES.map((patch) => {
    const markHits = locate(release, patch.marker, patch.files);
    const targets = patch.targets.map((target) => {
      const findHits = locate(release, target.find, patch.files);
      // 打过补丁后 find 片段不复存在、marker 出现，这是唯一可靠的判据
      const applied = findHits.length === 0 && markHits.length > 0;
      const shown = markHits.length ? markHits : findHits;
      return {
        find: target.find.slice(0, 60),
        files: shown.map((h) => path.relative(release.root, h.file)),
        applied,
        pending: findHits.length > 0,
        found: findHits.length > 0 || markHits.length > 0,
      };
    });
    const applied = targets.length > 0 && targets.every((t) => t.applied);
    const pending = targets.some((t) => t.pending);
    return {
      id: patch.id,
      upstreamId: patch.upstreamId,
      name: patch.name,
      effect: patch.effect,
      risk: patch.risk,
      marker: patch.marker,
      found: targets.some((t) => t.found),
      applied,
      targets,
      state: applied ? "applied" : pending ? "pending" : "unavailable",
    };
  });

  const state = readState(home);
  // 残留备份 = dist 里存在 .bak 但对应补丁已不在"已打"状态
  const strayBaks = [];
  for (const patch of patches) {
    for (const target of patch.targets) {
      for (const rel of target.files || []) {
        const bak = `${path.join(release.root, rel)}${BAK_SUFFIX}`;
        if (fs.existsSync(bak)) strayBaks.push(rel);
      }
    }
  }
  return {
    ok: true,
    home,
    version: release.version,
    nodeModules: release.nodeModules,
    versionChanged: Boolean(state.piVersion && state.piVersion !== release.version),
    recordedVersion: state.piVersion,
    patches,
    strayBaks: [...new Set(strayBaks)],
    notPatched: NOT_PATCHED,
  };
}

/** 打补丁。progressive：逐条 apply 或一次全打。 */
export function apply(home, { ids, force = false, release: wanted } = {}) {
  const release = resolveRelease(home, wanted);
  if (!release) return { ok: false, reason: "找不到 Pi 安装目录" };
  const state = readState(home);
  if (state.piVersion && state.piVersion !== release.version && !force) {
    return {
      ok: false,
      reason: `Pi 版本从 ${state.piVersion} 变成 ${release.version}，dist 已被覆盖。确认要用 --force 重打。`,
    };
  }

  const wantedIds = ids && ids.length ? ids : DIST_PATCHES.map((p) => p.id);
  const results = [];

  for (const patch of DIST_PATCHES) {
    if (!wantedIds.includes(patch.id)) continue;
    const entry = { id: patch.id, upstreamId: patch.upstreamId, name: patch.name, files: [], skipped: [], errors: [] };

    for (const target of patch.targets) {
      const hits = locate(release, target.find, patch.files);
      if (!hits.length) {
        // find 不在：要么已经打过（marker 在），要么锚点真的变了
        const already = locate(release, patch.marker, patch.files);
        if (already.length) {
          entry.skipped.push(`已在位：${already.map((h) => path.relative(release.root, h.file)).join(", ")}`);
        } else {
          entry.errors.push(`锚点不存在：${target.find.trim().slice(0, 70)}`);
        }
        continue;
      }
      for (const hit of hits) {
        try {
          const text = fs.readFileSync(hit.file, "utf8");
          const bak = `${hit.file}${BAK_SUFFIX}`;
          if (!fs.existsSync(bak)) fs.copyFileSync(hit.file, bak);
          fs.writeFileSync(hit.file, replaceAll(text, target.find, target.replace), "utf8");
          entry.files.push(path.relative(release.root, hit.file));
        } catch (error) {
          entry.errors.push(`${path.relative(release.root, hit.file)}: ${error.message}`);
        }
      }
    }

    if (entry.files.length) {
      state.applied[patch.id] = { files: entry.files, at: new Date().toISOString() };
    }
    results.push(entry);
  }

  state.piVersion = release.version;
  writeState(home, state);
  return { ok: true, version: release.version, results, state: statePath(home) };
}

/** 从 .bak 恢复。找不到 bak 的文件说明本来就没打过。 */
export function revert(home, { ids, release: wanted } = {}) {
  const release = resolveRelease(home, wanted);
  if (!release) return { ok: false, reason: "找不到 Pi 安装目录" };
  const state = readState(home);
  const wantedIds = ids && ids.length ? ids : Object.keys(state.applied);
  const restored = [];
  const missing = [];

  // 多条补丁可能改同一个文件（47/49 都动 anthropic-messages.js），
  // 所以先按路径去重，再统一恢复，否则第二条会把"已恢复"误报成"缺备份"。
  const targets = new Set();
  for (const patch of DIST_PATCHES) {
    if (!wantedIds.includes(patch.id)) continue;
    for (const rel of state.applied[patch.id]?.files || []) targets.add(rel);
  }

  for (const rel of targets) {
    const file = path.join(release.root, rel);
    const bak = `${file}${BAK_SUFFIX}`;
    if (fs.existsSync(bak)) {
      fs.copyFileSync(bak, file);
      restored.push(rel);
    } else {
      missing.push(rel);
    }
  }

  // 全部恢复完再删备份，避免共享文件时相互踩掉
  for (const rel of restored) {
    const bak = `${path.join(release.root, rel)}${BAK_SUFFIX}`;
    if (fs.existsSync(bak)) fs.unlinkSync(bak);
  }

  for (const id of wantedIds) delete state.applied[id];
  writeState(home, state);
  return { ok: true, version: release.version, restored, missing };
}

/** 补齐：把 .bak 残留也清掉（比如手工改坏了）。 */
export function cleanBaks(home, { release: wanted } = {}) {
  const release = resolveRelease(home, wanted);
  if (!release) return { ok: false, reason: "找不到 Pi 安装目录" };
  const removed = [];
  const scopeDir = path.join(release.nodeModules, SCOPE);
  if (fs.existsSync(scopeDir)) {
    for (const file of walkJs(scopeDir)) {
      const bak = `${file}${BAK_SUFFIX}`;
      if (fs.existsSync(bak)) {
        fs.unlinkSync(bak);
        removed.push(path.relative(release.root, bak));
      }
    }
  }
  return { ok: true, removed };
}
