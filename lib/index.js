/**
 * 对外核心 API。
 *
 * Pi 没有「装一次就常驻」的东西：每个会话都是新的，提示词也只能由
 * 扩展在运行时拼。所以这里把语义落到一组可重复执行的文件操作上：
 *
 *   apply    → 组装层 → 备份 AGENTS.md → 写受标记保护的区块 → 同步技能 → 存状态
 *   revert   → 摘掉区块（默认）或从备份整份还原（--hard）
 *   status   → 报告当前装了什么、指纹是否漂移、占多少 token
 *   doctor   → 环境自检
 */

import fs from "node:fs";
import path from "node:path";
import { agentsFile, skillsDir, extensionsDir, resolveHome, presetLayersDir } from "./paths.js";
import { assemble, loadLayers, ALWAYS } from "./compose.js";
import { parseLayers, selectLayers } from "./layers.js";
import { classifyTask, describeFamily, pruneForFamily, BASE_LAYERS } from "./router.js";
import { compose, findBlock, readAgents, writeAgents, stripBlock } from "./inject.js";
import { backupFile, latestBackup, listBackups } from "./backup.js";
import { readState, writeState, clearState, hashOf } from "./state.js";
import { report as analyze, summaryLine, estimateTokens } from "./analyzer.js";
import { loadRules } from "./rules.js";
import * as skills from "./skills.js";
import { stripBom } from "./jsonio.js";
import { DIST_PATCHES } from "../patches/manifest.js";

/** 注入正文：full = 所有层；base = 只常驻层；auto = 按给定文本路由。 */
function renderBody(home, { mode = "full", text = "", layers } = {}) {
  if (mode === "auto" && text) {
    return assemble({ home, text, routing: true });
  }
  const sources = loadLayers();
  const extra = [];
  if (mode === "base") {
    const all = assemble({ home, routing: false, sources });
    const parsed = parseLayers(all.text);
    const keep = [...new Set([...ALWAYS, ...BASE_LAYERS])];
    const picked = selectLayers(parsed, keep, { always: keep });
    return { text: picked.text, kept: picked.kept, family: "general", familyLabel: "通用", routed: false, mode };
  }
  if (layers && layers !== "all") {
    const all = assemble({ home, routing: false, sources, layers });
    return { ...all, mode };
  }
  const all = assemble({ home, routing: false, sources });
  return { ...all, mode };
}

/**
 * 应用注入。
 * @param {object} opts
 * @param {string} [opts.home]
 * @param {"full"|"base"|"auto"} [opts.mode]
 * @param {string} [opts.text] auto 模式下的任务文本
 * @param {string[]} [opts.layers] 显式层列表
 * @param {"top"|"bottom"} [opts.position]
 * @param {boolean} [opts.skills=true] 是否同步技能包
 * @param {boolean} [opts.dryRun]
 */
export function apply(opts = {}) {
  const home = resolveHome(opts.home);
  const mode = opts.mode || "full";
  const position = opts.position || "bottom";

  const body = renderBody(home, { mode, text: opts.text, layers: opts.layers });
  if (!body.text || !body.text.trim()) {
    throw new Error("没有可注入的层内容 —— 检查 presets/layers 是否为空。");
  }

  const file = agentsFile(home);
  const original = readAgents(home);
  const hash = hashOf(body.text);
  const meta = {
    version: 1,
    hash,
    layers: body.kept.join(","),
    mode,
    at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
  };
  const next = compose(original, body.text, meta, position);

  const result = {
    home,
    file,
    mode,
    position,
    kept: body.kept,
    family: body.family,
    familyLabel: body.familyLabel,
    routed: body.routed,
    hash,
    chars: body.text.length,
    tokens: estimateTokens(body.text),
    dryRun: Boolean(opts.dryRun),
    backup: null,
    skills: [],
  };

  if (opts.dryRun) {
    result.rendered = next;
    if (opts.out) {
      const target = path.resolve(String(opts.out));
      fs.writeFileSync(target, next, "utf8");
      result.renderedFile = target;
    }
    return result;
  }

  fs.mkdirSync(home, { recursive: true });
  result.backup = backupFile(home, file, "agents");
  writeAgents(home, next);

  if (opts.skills !== false) {
    try {
      result.skills = skills.syncAll(home, opts.skillPacks);
    } catch (error) {
      result.skillsError = String(error && error.message ? error.message : error);
    }
  }

  writeState(home, {
    applied: true,
    appliedAt: meta.at,
    layers: body.kept,
    routing: mode === "auto",
    mode,
    position,
    hash,
    skillPacks: result.skills.map((s) => s.pack),
    uninstallAvailable: true,
  });

  return result;
}

/**
 * 撤销。
 * @param {object} opts
 * @param {string} [opts.home]
 * @param {boolean} [opts.hard] 从最近一次备份整份还原
 * @param {boolean} [opts.skills] 同时卸载受管技能包
 */
export function revert(opts = {}) {
  const home = resolveHome(opts.home);
  const file = agentsFile(home);
  const original = readAgents(home);
  const result = { home, file, mode: opts.hard ? "hard" : "surgical", removedBlock: false, backup: null, skills: null };

  if (!original) {
    result.note = "AGENTS.md 不存在，无需撤销";
    clearState(home);
    return result;
  }

  const block = findBlock(original);
  if (block) result.removedBlock = true;

  if (opts.hard) {
    const snapshot = latestBackup(home, "agents", "AGENTS.md");
    if (!snapshot) throw new Error("没有可用备份，改用普通 revert（只摘区块）");
    result.backup = backupFile(home, file, "agents");
    writeAgents(home, snapshot.content);
    result.restoredFrom = snapshot.path;
  } else if (block) {
    result.backup = backupFile(home, file, "agents");
    writeAgents(home, stripBlock(original));
  }

  if (opts.skills) {
    result.skills = skills.cleanPacks(home);
  }

  clearState(home);
  return result;
}

/** 当前状态。 */
export function status(opts = {}) {
  const home = resolveHome(opts.home);
  const file = agentsFile(home);
  const raw = readAgents(home);
  const block = findBlock(raw);
  const state = readState(home);
  const installed = skills.listInstalled(home);
  const rules = loadRules(home);

  const injected = block ? parseLayers(`<!-- ctxfold:layer x -->\n${block.body}\n<!-- /ctxfold:layer -->`) : null;
  const bodyText = block ? block.body : "";

  const drifted = Boolean(block && state.hash && hashOf(bodyText) !== state.hash);

  return {
    home,
    file,
    fileExists: Boolean(raw),
    applied: Boolean(block),
    mode: state.mode || null,
    position: state.position || null,
    appliedAt: state.appliedAt || null,
    hash: block ? block.meta.hash || null : null,
    stateHash: state.hash || null,
    drifted,
    chars: bodyText.length,
    tokens: estimateTokens(bodyText),
    summary: summaryLine(bodyText),
    layers: state.layers && state.layers.length ? state.layers : [],
    userContentChars: block ? stripBlock(raw).length : raw.length,
    skills: installed,
    rules: { total: rules.length, enabled: rules.filter((r) => r.enabled).length },
    backups: listBackups(home, "agents", "AGENTS.md").length,
  };
}

/** 环境自检。 */
export function doctor(opts = {}) {
  const home = resolveHome(opts.home);
  const checks = [];
  const add = (id, ok, detail) => checks.push({ id, ok: Boolean(ok), detail });

  const [major, minor] = process.versions.node.split(".").map(Number);
  add("node", major > 18 || (major === 18 && minor >= 17), `Node ${process.versions.node}（需要 >= 18.17）`);

  add("presets", fs.existsSync(presetLayersDir()), presetLayersDir());
  const layers = loadLayers();
  add("layers", layers.length > 0, layers.length ? `${layers.length} 层：${layers.map((l) => l.name).join(", ")}` : "没有可用层文件");

  fs.mkdirSync(home, { recursive: true });
  add("home", fs.existsSync(home), home);

  const file = agentsFile(home);
  let writable = false;
  try {
    fs.accessSync(home, fs.constants.W_OK);
    writable = true;
  } catch {
    writable = false;
  }
  add("writable", writable, writable ? `${home} 可写` : `${home} 不可写`);

  const raw = readAgents(home);
  const block = findBlock(raw);

  // 扩展是否已铺到 Pi 的真实加载路径（而不是包里那份源文件）
  const extEntry = path.join(extensionsDir(home), "ctxfold", "index.ts");
  const extInstalled = fs.existsSync(extEntry);

  // 注入有两条通道，任一条通就算健康：扩展（每轮动态）或 AGENTS.md 区块（静态）。
  // 只看 AGENTS.md 会把「装了扩展但没 apply」误判成故障。
  const channel = extInstalled && block ? "扩展 + AGENTS.md" : extInstalled ? "扩展（每轮动态）" : block ? "AGENTS.md（静态）" : null;
  add(
    "inject",
    Boolean(channel),
    channel
      ? `通道：${channel}${block ? `，区块 ${block.body.length} 字符` : ""}`
      : "两条通道都没开（运行 ctxfold install，或 ctxfold apply）",
  );

  if (block) {
    const state = readState(home);
    const drift = state.hash && hashOf(block.body) !== state.hash;
    add("integrity", !drift, drift ? "区块内容与状态记录不一致（可能被手工改过）" : "指纹一致");
  }

  add("skills-dir", fs.existsSync(skillsDir(home)), skillsDir(home));
  const packs = skills.availablePacks();
  add("skill-packs", packs.length > 0, packs.length ? packs.join(", ") : "包内没有技能");

  const patchCount = Array.isArray(DIST_PATCHES) ? DIST_PATCHES.length : 0;
  add("patches", patchCount > 0, patchCount ? `${patchCount} 条可选补丁就绪` : "补丁清单缺失");

  add(
    "extension",
    extInstalled,
    extInstalled ? `已装入 ${extEntry}` : "未安装扩展（运行 ctxfold install；仅用 AGENTS.md 注入时可不装）",
  );

  return { home, checks, ok: checks.every((c) => c.ok) };
}

/** 卸载：撤销注入 + 摘掉受管技能 + 清状态。 */
export function uninstall(opts = {}) {
  const home = resolveHome(opts.home);
  const rev = revert({ home, skills: true });
  clearState(home);
  return { home, ...rev };
}

/** 只渲染不写盘，给脚本与调试用。 */
export function render(opts = {}) {
  const home = resolveHome(opts.home);
  const mode = opts.mode || (opts.text ? "auto" : "full");
  return renderBody(home, { mode, text: opts.text, layers: opts.layers });
}

/** 分层体量报告。 */
export function analyzeLayers(opts = {}) {
  const home = resolveHome(opts.home);
  const all = assemble({ home, routing: false });
  const parsed = parseLayers(all.text);
  return analyze(parsed.layers, { withBars: true });
}

/** 任务族预览。 */
export function routePreview(home, text) {
  const family = classifyTask(text);
  const all = loadLayers();
  const names = all.map((l) => l.name);
  const kept = pruneForFamily(names, family);
  return {
    family,
    label: describeFamily(family),
    all: names,
    kept,
    dropped: names.filter((n) => !kept.includes(n)),
    text: assemble({ home, text, routing: true }).text,
  };
}

export { skills };
