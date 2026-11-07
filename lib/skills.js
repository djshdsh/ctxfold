/**
 * 技能包同步。
 *
 * ctxfold 的技能装在 $HOST_HOME/skills，本机工具路径写死在 $HOST_HOME/redteam/toolkit。
 * Pi 的技能目录换成了 <home>/skills，工具路径也不该再指 上游。所以同步时做一次
 * 路径改写：把 上游变量换成 Pi 侧变量，其余正文原样保留。
 *
 * 改写只碰变量引用，不改任何命令、参数和示例值 —— 那些是技能的核心内容。
 */

import fs from "node:fs";
import path from "node:path";
import { skillsDir, packagedSkillsDir, stateDir } from "./paths.js";
import { stripBom } from "./jsonio.js";

const MANIFEST = "skill-manifest.json";

const REWRITES = [
  [/\$HOST_HOME\/redteam\/toolkit/g, "$CTXFOLD_TOOLKIT"],
  [/\$HOST_HOME/g, "$CTXFOLD_HOME"],
  [/~\/\.upstream\//g, "~/.pi/agent/"],
  [/%HOST_HOME%/g, "%CTXFOLD_HOME%"],
];

export function rewriteForPi(text) {
  let out = String(text || "");
  for (const [re, to] of REWRITES) out = out.replace(re, to);
  return out;
}

function walk(dir, base = dir, acc = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, acc);
    else acc.push(path.relative(base, full));
  }
  return acc;
}

function manifestFile(home) {
  return path.join(stateDir(home), MANIFEST);
}

function readManifest(home) {
  try {
    const data = JSON.parse(stripBom(fs.readFileSync(manifestFile(home), "utf8")));
    return data && typeof data === "object" ? data : { packs: {} };
  } catch {
    return { packs: {} };
  }
}

function writeManifest(home, data) {
  const dir = stateDir(home);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(manifestFile(home), `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

/** 包内有哪些技能包。 */
export function availablePacks() {
  const root = packagedSkillsDir();
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * 同步一个技能包。返回 { pack, files, dest }。
 * @param {string} home
 * @param {string} pack 包目录名
 */
export function syncPack(home, pack) {
  const src = path.join(packagedSkillsDir(), pack);
  if (!fs.existsSync(src)) throw new Error(`技能包不存在：${pack}`);
  const dest = path.join(skillsDir(home), pack);
  const files = walk(src);

  for (const rel of files) {
    const from = path.join(src, rel);
    const to = path.join(dest, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    const raw = fs.readFileSync(from, "utf8");
    fs.writeFileSync(to, rewriteForPi(raw), "utf8");
  }

  const manifest = readManifest(home);
  manifest.packs[pack] = { dest, files, at: new Date().toISOString() };
  writeManifest(home, manifest);
  return { pack, files: files.length, dest };
}

/** 同步全部（或指定）技能包。 */
export function syncAll(home, packs) {
  const list = packs && packs.length ? packs : availablePacks();
  const results = [];
  for (const pack of list) {
    results.push(syncPack(home, pack));
  }
  return results;
}

/** 列出本机已安装的技能（按目录扫，不看 manifest）。 */
export function listInstalled(home) {
  const root = skillsDir(home);
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const manifest = readManifest(home);
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => {
      const record = manifest.packs[e.name];
      const count = walk(path.join(root, e.name)).length;
      return {
        pack: e.name,
        files: count,
        managed: Boolean(record),
        at: record ? record.at : null,
      };
    });
}

/**
 * 卸载受管的技能包。只删 manifest 记录过的，用户自己放的技能一律不碰。
 * @returns {{removed:string[], skipped:string[]}}
 */
export function cleanPacks(home, packs) {
  const manifest = readManifest(home);
  const wanted = packs && packs.length ? packs : Object.keys(manifest.packs);
  const removed = [];
  const skipped = [];
  for (const pack of wanted) {
    if (!manifest.packs[pack]) {
      skipped.push(pack);
      continue;
    }
    const dest = path.join(skillsDir(home), pack);
    try {
      fs.rmSync(dest, { recursive: true, force: true });
      delete manifest.packs[pack];
      removed.push(pack);
    } catch {
      skipped.push(pack);
    }
  }
  writeManifest(home, manifest);
  return { removed, skipped };
}

/** 单个技能文件的路径，给 `skills show` 用。 */
export function packFiles(home, pack) {
  const dir = path.join(skillsDir(home), pack);
  return walk(dir).sort().map((rel) => path.join(dir, rel));
}
