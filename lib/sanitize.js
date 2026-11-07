/**
 * 提示词清洗。
 *
 * 解决的问题：装了 ctxfold 之后，Pi 依然会把你原本的 AGENTS.md 一起送进系统提示词。
 * 追加模式（默认）下这是叠加；你想要的「完全覆盖」还差两步：
 *
 *   1. 把 AGENTS.md 里你自己写的指令清掉（本文件负责）
 *   2. 把 Pi 内置系统提示词也换掉（扩展 config.json 的 override，本文件一并打开）
 *
 * 清洗一律先备份，restore 一键还原。清洗不等于删除：原文完整躺在 .ctxfold/backups 里。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { agentsFile, backupDir, extensionsDir, stateDir } from "./paths.js";
import { findBlock } from "./inject.js";
import { stripBom } from "./jsonio.js";

/** 清洗记录：哪个文件被清过、原文备份在哪。 */
export function sanitizeStateFile(home) {
  return path.join(stateDir(home), "sanitize.json");
}

export function readSanitizeState(home) {
  try {
    return JSON.parse(stripBom(fs.readFileSync(sanitizeStateFile(home), "utf8")));
  } catch {
    return { at: null, files: [] };
  }
}

/** 扩展的运行时配置（override 开关就在这）。 */
export function extensionConfigFile(home) {
  return path.join(extensionsDir(home), "ctxfold", "config.json");
}

export function readExtensionConfig(home) {
  try {
    return JSON.parse(stripBom(fs.readFileSync(extensionConfigFile(home), "utf8")));
  } catch {
    return {};
  }
}

/** 打开/关闭「完全接管系统提示词」。 */
export function setOverride(home, on) {
  const file = extensionConfigFile(home);
  const cfg = readExtensionConfig(home);
  cfg.override = Boolean(on);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
  return { file, override: cfg.override };
}

/**
 * 列出 Pi 会读的指令文件。
 *
 * Pi 从 agent 主目录和当前工作目录逐级向上找 AGENTS.md，
 * 这里把两边的都列出来，让你看见"到底还有哪些提示词在生效"。
 */
export function listAgentFiles(home, cwd = process.cwd()) {
  const seen = new Set();
  const out = [];

  const push = (file, scope) => {
    const abs = path.resolve(file);
    if (seen.has(abs)) return;
    seen.add(abs);
    let raw = null;
    try {
      raw = fs.readFileSync(abs, "utf8");
    } catch {
      raw = null;
    }
    if (raw === null) return;
    const block = findBlock(raw);
    out.push({
      path: abs,
      scope,
      chars: raw.length,
      outsideChars: block ? raw.slice(0, block.start).length + raw.slice(block.end).length : raw.length,
      hasBlock: Boolean(block),
    });
  };

  push(agentsFile(home), "全局");

  let dir = path.resolve(cwd);
  for (let i = 0; i < 12; i += 1) {
    push(path.join(dir, "AGENTS.md"), dir === path.resolve(cwd) ? "项目" : "上级目录");
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return out;
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * 清洗 AGENTS.md。
 *
 * @param {object} opts
 * @param {string} opts.home
 * @param {string} [opts.cwd]
 * @param {boolean} [opts.project] 连当前项目目录的 AGENTS.md 一起清
 * @param {boolean} [opts.dryRun]
 * @param {boolean} [opts.keepBlock=true] 保留 ctxfold 自己的区块
 * @param {boolean} [opts.override=true] 同时打开扩展的完全接管
 */
export function sanitize({
  home,
  cwd = process.cwd(),
  project = false,
  dryRun = false,
  keepBlock = true,
  override = true,
} = {}) {
  const files = listAgentFiles(home, cwd).filter((f) => f.scope === "全局" || project);
  const dir = backupDir(home);
  const ts = stamp();
  const done = [];
  const state = readSanitizeState(home);
  const known = new Map((state.files || []).map((f) => [f.path, f]));

  for (const entry of files) {
    const raw = fs.readFileSync(entry.path, "utf8");
    const block = findBlock(raw);
    const kept = keepBlock && block ? raw.slice(block.start, block.end) : "";
    const next = kept ? `${kept}\n` : "";

    if (next === raw) {
      done.push({ ...entry, changed: false });
      continue;
    }

    // 同一个文件重复清洗时，别用空的当前内容覆盖掉第一次的备份
    const previous = known.get(entry.path);
    let backup = previous?.backup ?? null;
    if (!backup) {
      const safe = `${path.basename(path.dirname(entry.path)) || "root"}-${crypto
        .createHash("sha1")
        .update(entry.path)
        .digest("hex")
        .slice(0, 8)}`;
      backup = path.join(dir, `${ts}-${safe}-AGENTS.md`);
    }

    if (!dryRun) {
      if (!previous?.backup) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(backup, raw, "utf8");
      }
      fs.writeFileSync(entry.path, next, "utf8");
      known.set(entry.path, {
        path: entry.path,
        scope: entry.scope,
        backup,
        charsBefore: raw.length,
        charsAfter: next.length,
        at: new Date().toISOString(),
      });
    }

    done.push({
      ...entry,
      changed: true,
      before: raw.length,
      after: next.length,
      backup: previous?.backup ? previous.backup : backup,
    });
  }

  let overrideResult = null;
  if (override && !dryRun) overrideResult = setOverride(home, true);

  if (!dryRun) {
    fs.mkdirSync(stateDir(home), { recursive: true });
    fs.writeFileSync(
      sanitizeStateFile(home),
      `${JSON.stringify({ at: new Date().toISOString(), files: [...known.values()] }, null, 2)}\n`,
      "utf8",
    );
  }

  return { home, dryRun, files: done, override: overrideResult, stateFile: sanitizeStateFile(home) };
}

/** 从备份还原被清洗过的 AGENTS.md。 */
export function restore({ home, dryRun = false } = {}) {
  const state = readSanitizeState(home);
  const restored = [];

  for (const entry of state.files || []) {
    let raw;
    try {
      raw = fs.readFileSync(entry.backup, "utf8");
    } catch {
      restored.push({ ...entry, ok: false, reason: "备份不存在" });
      continue;
    }
    if (!dryRun) {
      fs.mkdirSync(path.dirname(entry.path), { recursive: true });
      fs.writeFileSync(entry.path, raw, "utf8");
    }
    restored.push({ ...entry, ok: true, chars: raw.length });
  }

  if (!dryRun) {
    try {
      fs.rmSync(sanitizeStateFile(home));
    } catch {
      /* 没记录也无所谓 */
    }
  }

  return { home, dryRun, restored };
}
