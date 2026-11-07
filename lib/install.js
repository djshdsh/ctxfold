/**
 * 安装器：把包内资产铺到 Pi Agent 的真实加载路径上。
 *
 * Pi 的加载契约（1.0.4 实测）：
 *   <agent-dir>/extensions/<name>/index.ts   → 扩展入口，jiti 直接加载，无需编译
 *   <agent-dir>/skills/<name>/SKILL.md       → 技能，目录形式是可移植形式
 *   <agent-dir>/AGENTS.md                    → 全局指令，由 compose/apply 负责
 *
 * 所以 install 只做一件事：把 presets 与 skills 复制到上面三处，
 * 其中 layers 同时留一份到 <agent-dir>/.ctxfold/layers/ 供用户直接改。
 */

import fs from "node:fs";
import path from "node:path";
import {
  PKG_ROOT,
  presetLayersDir,
  presetRulesFile,
  packagedSkillsDir,
  stateDir,
} from "./paths.js";

const EXT_NAME = "ctxfold";
const SKILL_NAME = "ctxfold";

/** 扩展运行时需要的文件（相对包根）。 */
function extensionSources() {
  return {
    entry: path.join(PKG_ROOT, "extension", "index.ts"),
    layers: presetLayersDir(),
    rules: presetRulesFile(),
  };
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function listFiles(dir, ext = ".md") {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(ext))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

/** 覆盖前先留底，避免用户的改动被静默冲掉。 */
function makeBackup(home, targets) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dir = path.join(stateDir(home), "backups", `install-${stamp}`);
  const saved = [];
  for (const target of targets) {
    if (!fs.existsSync(target)) continue;
    const rel = path.relative(home, target).replace(/[\\/]/g, "__");
    const dest = path.join(dir, `${rel}.bak`);
    try {
      ensureDir(path.dirname(dest));
      fs.copyFileSync(target, dest);
      saved.push(target);
    } catch {
      /* 单个文件备份失败不阻断安装 */
    }
  }
  return { dir: saved.length ? dir : null, files: saved };
}

function copyFile(from, to, force) {
  if (!fs.existsSync(from)) return { to, status: "missing-source" };
  if (fs.existsSync(to) && !force) return { to, status: "exists" };
  ensureDir(path.dirname(to));
  fs.copyFileSync(from, to);
  return { to, status: "copied" };
}

function copyTree(from, to, force) {
  const results = [];
  for (const file of listFiles(from)) {
    results.push(copyFile(file, path.join(to, path.basename(file)), force));
  }
  return results;
}

/**
 * 安装。
 *
 * @param {object} options
 * @param {string} options.home      Pi agent 主目录
 * @param {boolean} [options.force]  覆盖已存在的文件
 * @param {boolean} [options.skill]  是否安装技能包，默认 true
 * @param {boolean} [options.extension] 是否安装扩展，默认 true
 */
export function install(options = {}) {
  const { home, force = false, skill = true, extension = true } = options;
  const sources = extensionSources();
  const extDest = path.join(home, "extensions", EXT_NAME);
  const userLayers = path.join(stateDir(home), "layers");
  const skillDest = path.join(home, "skills", SKILL_NAME);

  // 规划目标清单，先备份再写
  const planned = [];
  if (extension) {
    planned.push(path.join(extDest, "index.ts"));
    planned.push(path.join(extDest, "rules.json"));
    for (const file of listFiles(sources.layers)) {
      planned.push(path.join(extDest, "layers", path.basename(file)));
      planned.push(path.join(userLayers, path.basename(file)));
    }
  }
  const backup = makeBackup(home, planned);

  const steps = [];

  if (extension) {
    steps.push(copyFile(sources.entry, path.join(extDest, "index.ts"), force));
    steps.push(copyFile(sources.rules, path.join(extDest, "rules.json"), force));

    for (const item of copyTree(sources.layers, path.join(extDest, "layers"), force)) steps.push(item);
    // 用户层目录同样铺一份：扩展优先读这里，改这里等于改注入，不用碰包
    for (const item of copyTree(sources.layers, userLayers, force)) steps.push(item);

    // config.json 永不覆盖，它承载运行期开关
    const configFile = path.join(extDest, "config.json");
    if (!fs.existsSync(configFile)) {
      ensureDir(extDest);
      fs.writeFileSync(
        configFile,
        `${JSON.stringify({ enabled: true, routing: true, maxChars: 0, approval: "auto" }, null, 2)}\n`,
        "utf8",
      );
      steps.push({ to: configFile, status: "created" });
    } else {
      steps.push({ to: configFile, status: "kept" });
    }
  }

  if (skill) {
    const src = path.join(packagedSkillsDir(), SKILL_NAME);
    if (fs.existsSync(src)) {
      const files = fs.readdirSync(src, { withFileTypes: true });
      for (const entry of files) {
        if (entry.isFile()) {
          steps.push(copyFile(path.join(src, entry.name), path.join(skillDest, entry.name), force));
        } else if (entry.isDirectory()) {
          for (const item of copyTree(path.join(src, entry.name), path.join(skillDest, entry.name), force)) {
            steps.push(item);
          }
        }
      }
    }
  }

  const copied = steps.filter((s) => s.status === "copied" || s.status === "created");
  const skipped = steps.filter((s) => s.status === "exists");
  const missing = steps.filter((s) => s.status === "missing-source");

  return {
    home,
    extensionDir: extension ? extDest : null,
    skillDir: skill && fs.existsSync(path.join(home, "skills", SKILL_NAME)) ? skillDest : null,
    userLayersDir: extension ? userLayers : null,
    backup,
    copied: copied.map((s) => s.to),
    skipped: skipped.map((s) => s.to),
    missing: missing.map((s) => s.to),
    total: steps.length,
  };
}

/** 移除已安装的扩展与技能（不碰 AGENTS.md，那由 revert 负责）。 */
export function uninstallInstalled(home) {
  const extDest = path.join(home, "extensions", EXT_NAME);
  const skillDest = path.join(home, "skills", SKILL_NAME);
  const removed = [];
  const kept = [];

  for (const target of [extDest, skillDest]) {
    if (!fs.existsSync(target)) continue;
    try {
      fs.rmSync(target, { recursive: true, force: true });
      removed.push(target);
    } catch (error) {
      kept.push({ target, reason: String(error && error.message ? error.message : error) });
    }
  }

  // 用户层目录保留：里面可能是用户手改过的内容，删掉无法恢复
  const layerDir = path.join(stateDir(home), "layers");
  if (fs.existsSync(layerDir)) kept.push({ target: layerDir, reason: "用户层目录保留，需要时手动删" });

  return { removed, kept };
}

/** 安装状态自检：Pi 真的会加载它吗？ */
export function inspectInstall(home) {
  const extDir = path.join(home, "extensions", EXT_NAME);
  const entry = path.join(extDir, "index.ts");
  const layers = listFiles(path.join(extDir, "layers"));
  const userLayers = listFiles(path.join(stateDir(home), "layers"));
  const rules = path.join(extDir, "rules.json");
  const config = path.join(extDir, "config.json");
  const skill = path.join(home, "skills", SKILL_NAME, "SKILL.md");

  return {
    home,
    extension: {
      dir: extDir,
      dirExists: fs.existsSync(extDir),
      entry,
      entryExists: fs.existsSync(entry),
      entryBytes: fs.existsSync(entry) ? fs.statSync(entry).size : 0,
      layers: layers.map((f) => path.basename(f, ".md")),
      rulesExists: fs.existsSync(rules),
      configExists: fs.existsSync(config),
    },
    userLayers: {
      dir: path.join(stateDir(home), "layers"),
      layers: userLayers.map((f) => path.basename(f, ".md")),
    },
    skill: { file: skill, exists: fs.existsSync(skill) },
  };
}
