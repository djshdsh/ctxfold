/**
 * 桌面外壳（ctxfold-app.exe）的机器接口。
 *
 * 外壳是纯 C# WinForms，不解释任何人类可读文本，只吃一个 JSON 对象。
 * 所以这里所有 action 都返回 `{ok, data}` / `{ok:false, error}`，
 * 由 CLI 的 `bridge <action> <base64-json>` 原样打印出去。
 *
 * 约定：不做交互、不读 stdin、不打印进度；一次性算完就返回。
 */

import fs from "node:fs";
import path from "node:path";
import { resolveHome, agentsFile, backupDir, skillsDir, extensionsDir, stateDir, presetLayersDir } from "./paths.js";
import { loadAllLayers, userLayersDir, assemble } from "./compose.js";
import { listBackups } from "./backup.js";
import { readJsonFile, writeJsonFile } from "./jsonio.js";
import { estimateTokens } from "./analyzer.js";
import * as core from "./index.js";
import {
  sanitize,
  restore,
  readSanitizeState,
  readExtensionConfig,
  extensionConfigFile,
} from "./sanitize.js";
import { inspect as inspectDist, apply as applyDist, revert as revertDist } from "./dist-patch.js";
import { DIST_PATCHES } from "../patches/manifest.js";

/** 清洗状态的扁平视图：外壳只关心「洗过没有 / 何时 / 清掉多少 / 备份几份」。 */
function summarizeSanitize(state) {
  const files = Array.isArray(state && state.files) ? state.files : [];
  const cleared = files.reduce((n, f) => n + Math.max(0, (f.charsBefore || 0) - (f.charsAfter || 0)), 0);
  return {
    sanitized: files.length > 0,
    at: state && state.at ? String(state.at) : null,
    clearedChars: cleared,
    files: files.length,
    items: files.map((f) => ({
      file: f.path || f.file || "",
      before: f.charsBefore || 0,
      after: f.charsAfter || 0,
      backup: f.backup || "",
    })),
  };
}

/** 清洗 / 还原的返回值扁平化。 */
function flattenFiles(result) {
  const list = Array.isArray(result && result.files)
    ? result.files
    : Array.isArray(result && result.restored)
      ? result.restored
      : [];
  return {
    ...result,
    files: list.map((f) => ({
      file: f.path || f.file || "",
      before: f.before ?? f.charsBefore ?? 0,
      after: f.after ?? f.charsAfter ?? 0,
      backup: f.backup || "",
    })),
  };
}

/** 外壳读的那份扩展配置（可能不存在）。 */
function configOf(home) {
  const base = { enabled: true, routing: true, maxChars: 0, approval: "auto", override: false };
  try {
    return { ...base, ...readExtensionConfig(home) };
  } catch {
    return base;
  }
}

function writeConfig(home, patch) {
  const next = { ...configOf(home), ...patch };
  writeJsonFile(extensionConfigFile(home), next);
  return next;
}

function layerPath(home, name) {
  const safe = path.basename(String(name)).replace(/\.md$/i, "");
  const user = path.join(userLayersDir(home), `${safe}.md`);
  if (fs.existsSync(user)) return { file: user, source: "用户" };
  const preset = path.join(presetLayersDir(), `${safe}.md`);
  if (fs.existsSync(preset)) return { file: preset, source: "预设" };
  return { file: user, source: "未创建" };
}

/** 所有 action 的实现。键就是外壳传进来的 action 名。 */
const ACTIONS = {
  /** 总览：状态 + 接管开关 + 安装情况。 */
  status({ home }) {
    const base = core.status({ home });
    const cfg = configOf(home);
    const ext = path.join(extensionsDir(home), "ctxfold", "index.ts");
    return {
      ...base,
      override: Boolean(cfg.override),
      enabled: cfg.enabled !== false,
      routing: cfg.routing !== false,
      approval: cfg.approval || "auto",
      extensionInstalled: fs.existsSync(ext),
      extensionFile: ext,
      sanitized: summarizeSanitize(readSanitizeState(home)),
      fullChars: assemble({ home, routing: false }).text.length,
      agentsChars: base.fileExists ? base.userContentChars + base.chars : 0,
    };
  },

  /** 自检。 */
  doctor({ home }) {
    return core.doctor({ home });
  },

  /** 层清单 + 每层字符数。 */
  layers({ home }) {
    const all = loadAllLayers(home);
    const list = all.map((l) => {
      const name = String(l.name);
      const { source, file } = layerPath(home, name);
      return { name, chars: String(l.text || "").length, source, file };
    });
    return { layers: list, presetDir: presetLayersDir(), userDir: userLayersDir(home) };
  },

  /** 读一层正文。 */
  "layer-read"({ home }, args) {
    const { file, source } = layerPath(home, args.name);
    const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    return { name: String(args.name), file, source, text };
  },

  /** 写一层正文（永远写用户覆盖目录，不动预设）。 */
  "layer-write"({ home }, args) {
    const name = path.basename(String(args.name)).replace(/\.md$/i, "");
    if (!name) throw new Error("层名不能为空");
    const file = path.join(userLayersDir(home), `${name}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, String(args.text ?? ""), "utf8");
    return { name, file, chars: String(args.text ?? "").length };
  },

  /** 删掉用户覆盖层，回落到预设。 */
  "layer-reset"({ home }, args) {
    const name = path.basename(String(args.name)).replace(/\.md$/i, "");
    const file = path.join(userLayersDir(home), `${name}.md`);
    const existed = fs.existsSync(file);
    if (existed) fs.unlinkSync(file);
    return { name, removed: existed, file };
  },

  /** 按任务文本预览裁剪结果。 */
  preview({ home }, args) {
    const text = String(args.text || "");
    const route = core.routePreview(home, text);
    const body = core.render({ home, mode: "auto", text });
    return {
      family: route.family,
      familyLabel: route.familyLabel,
      matched: route.matched || [],
      layers: body.kept || [],
      chars: String(body.text || "").length,
      tokens: estimateTokens(String(body.text || "")),
      text: String(body.text || ""),
    };
  },

  /** 清洗提示词文件并接管。 */
  clean({ home, cwd }, args) {
    return flattenFiles(
      sanitize({
        home,
        cwd,
        project: Boolean(args.project),
        dryRun: Boolean(args.dryRun),
        keepBlock: args.keepBlock !== false,
        override: args.override !== false,
      })
    );
  },

  /** 还原提示词文件。 */
  restore({ home }, args) {
    return flattenFiles(restore({ home, dryRun: Boolean(args.dryRun) }));
  },

  /** 重装/更新扩展。 */
  install({ home }, args) {
    return installNow(home, args);
  },

  /** 卸载扩展（保留用户层与备份）。 */
  uninstall({ home }) {
    return core.uninstall({ home });
  },

  /** 补丁清单与状态。 */
  patches({ home }) {
    const info = inspectDist(home);
    const list = (info.patches || []).map((p) => ({
      id: p.id,
      name: p.name || "",
      effect: p.effect || "",
      risk: p.risk || "",
      applied: Boolean(p.applied),
      pending: Boolean(p.pending),
      found: Boolean(p.found),
    }));
    return {
      ok: Boolean(info.ok),
      reason: info.reason || "",
      release: info.release ? info.release.version || info.release.root : null,
      patches: list,
    };
  },

  /** 打补丁 / 撤补丁。 */
  patch({ home }, args) {
    const ids = args.id ? [String(args.id)] : undefined;
    if (args.action === "revert") return revertDist(home, { ids });
    return applyDist(home, { ids, force: Boolean(args.force) });
  },

  /** 备份清单。 */
  backups({ home }) {
    const dir = backupDir(home);
    const items = listBackups(home, "agents", "AGENTS.md").map((file) => {
      let size = 0;
      try {
        size = fs.statSync(file).size;
      } catch {
        size = 0;
      }
      return { file, name: path.basename(file), size };
    });
    const sanitizeBaks = [];
    const sdir = path.join(stateDir(home), "backups");
    try {
      for (const entry of fs.readdirSync(sdir)) {
        if (!/AGENTS\.md$/i.test(entry)) continue;
        const file = path.join(sdir, entry);
        let size = 0;
        try {
          size = fs.statSync(file).size;
        } catch {
          size = 0;
        }
        sanitizeBaks.push({ file, name: entry, size });
      }
    } catch {
      /* 没有清洗备份目录 */
    }
    return { dir, items, sanitizeDir: sdir, sanitizeItems: sanitizeBaks };
  },

  /** 读写扩展配置（enabled / routing / approval / override / maxChars）。 */
  options({ home }, args) {
    if (!args.patch) return configOf(home);
    const patch = {};
    for (const key of ["enabled", "routing", "override"]) {
      if (args.patch[key] !== undefined) patch[key] = Boolean(args.patch[key]);
    }
    if (args.patch.approval !== undefined) patch.approval = String(args.patch.approval);
    if (args.patch.maxChars !== undefined) patch.maxChars = Number(args.patch.maxChars) || 0;
    return writeConfig(home, patch);
  },

  /** 外壳要用到的路径（打开文件夹用）。 */
  paths({ home }) {
    return {
      home,
      agents: agentsFile(home),
      layers: userLayersDir(home),
      backups: backupDir(home),
      skills: skillsDir(home),
      extensions: extensionsDir(home),
      state: stateDir(home),
    };
  },

  /** 概览页顶部的一行摘要。 */
  summary({ home }) {
    const cfg = configOf(home);
    const all = loadAllLayers(home);
    const total = all.reduce((n, l) => n + String(l.text || "").length, 0);
    return {
      layers: all.length,
      chars: total,
      tokens: estimateTokens(all.map((l) => String(l.text || "")).join("\n")),
      override: Boolean(cfg.override),
      routing: cfg.routing !== false,
    };
  },
  /** 候选 Pi Agent 目录。 */
  targets() {
    return { targets: candidateTargets(), defaultHome: resolveHome() };
  },

  /** 一键注入：装扩展 + 层 + 规则 + 技能，可选清洗接管，最后自检。 */
  async inject({ home, cwd }, args) {
    const target = args.home ? path.resolve(String(args.home)) : home;
    const inst = await installNow(target, { force: args.force !== false });
    let cleaned = null;
    if (args.clean) {
      cleaned = flattenFiles(sanitize({ home: target, cwd, override: true }));
    }
    if (args.override !== undefined) writeConfig(target, { override: Boolean(args.override) });
    const st = ACTIONS.status({ home: target });
    const doc = core.doctor({ home: target });
    const checks = Array.isArray(doc && doc.checks) ? doc.checks : [];
    const failed = checks.filter((c) => !c.ok);
    return {
      home: target,
      copied: (inst && inst.copied) || [],
      skipped: (inst && inst.skipped) || [],
      cleaned,
      status: st,
      checks,
      failed: failed.length,
      channel: st.extensionInstalled ? "扩展" : st.applied ? "AGENTS.md" : "无",
      override: Boolean(st.override),
      layers: st.mode || "",
      fullChars: st.fullChars || 0,
    };
  },
};

/** install 走的是 install.js，单独包一层，避免循环 import 到 CLI。 */
async function installNow(home, args) {
  const mod = await import("./install.js");
  return mod.install({ home, force: Boolean(args.force) });
}

/** 候选 Pi Agent 目录。 */
function candidateTargets() {
  const found = new Map();
  const push = (dir, source) => {
    if (!dir) return;
    let abs;
    try {
      abs = path.resolve(dir);
    } catch {
      return;
    }
    if (found.has(abs)) return;
    const ext = path.join(abs, "extensions", "ctxfold", "index.ts");
    found.set(abs, {
      path: abs,
      source,
      exists: fs.existsSync(abs),
      installed: fs.existsSync(ext),
      isDefault: false,
    });
  };

  push(process.env.CTXFOLD_HOME, "环境变量");
  push(process.env.PI_AGENT_HOME, "PI_AGENT_HOME");
  push(process.env.PI_CODING_AGENT_DIR, "PI_CODING_AGENT_DIR");
  const current = resolveHome();
  push(current, "当前用户");
  for (const base of userRoots()) {
    let entries = [];
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const cand = path.join(base, e.name, ".pi", "agent");
      if (fs.existsSync(cand)) push(cand, `用户 ${e.name}`);
    }
  }

  const list = [...found.values()];
  const def = list.find((t) => t.path.toLowerCase() === current.toLowerCase());
  if (def) def.isDefault = true;
  return list.sort(
    (a, b) => Number(b.isDefault) - Number(a.isDefault) || a.path.localeCompare(b.path),
  );
}

function userRoots() {
  if (process.platform !== "win32") return ["/home"];
  const drive = process.env.SystemDrive || "C:";
  return [`${drive}\\Users`];
}

/**
 * 执行一次外壳调用。
 * @param {string} action
 * @param {Record<string, unknown>} [args]
 * @param {{home?: string, cwd?: string}} [env]
 */
export async function runBridge(action, args = {}, env = {}) {
  const home = resolveHome(env.home);
  const ctx = { home, cwd: env.cwd || process.cwd() };
  const fn = ACTIONS[action];
  if (!fn) {
    return { ok: false, error: `未知的 bridge action: ${action}` };
  }
  try {
    const data = await fn(ctx, args || {});
    return { ok: true, action, data };
  } catch (error) {
    return {
      ok: false,
      action,
      error: String(error && error.message ? error.message : error),
      stack: error && error.stack ? String(error.stack).split("\n").slice(0, 6).join("\n") : undefined,
    };
  }
}

export const BRIDGE_ACTIONS = Object.keys(ACTIONS).concat(["install"]);
