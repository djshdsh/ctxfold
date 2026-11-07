/**
 * 路径解析。
 *
 * Pi Agent 没有 上游的 profile / pnpm bundle 概念，一切落到一个目录：
 *   <HOME>/AGENTS.md          全局指令
 *   <HOME>/skills/            技能目录
 *   <HOME>/.ctxfold/         插件自身状态、备份、缓存
 *
 * 默认 HOME = ~/.pi/agent，可用 --home 或以下环境变量覆盖（优先级从高到低）：
 *   CTXFOLD_HOME > PI_AGENT_HOME > PI_CODING_AGENT_DIR
 * 其中 PI_CODING_AGENT_DIR 是 Pi 自己的 agent dir 变量，装了 Pi 的机器上通常已有。
 */

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 包根目录（含 presets / skills / extension）。 */
export const PKG_ROOT = path.resolve(HERE, "..");

export function expandHome(input) {
  const raw = String(input || "").trim();
  if (!raw) return raw;
  if (raw === "~") return os.homedir();
  if (raw.startsWith("~/") || raw.startsWith("~\\")) {
    return path.join(os.homedir(), raw.slice(2));
  }
  return raw;
}

/** 目标 Pi Agent 主目录。 */
export function resolveHome(explicit) {
  const fromCli = explicit && String(explicit).trim();
  const fromEnv =
    process.env.CTXFOLD_HOME ||
    process.env.PI_AGENT_HOME ||
    process.env.PI_CODING_AGENT_DIR;
  if (fromCli) return path.resolve(expandHome(fromCli));
  if (fromEnv) return path.resolve(expandHome(fromEnv));
  return path.join(os.homedir(), ".pi", "agent");
}

/** 插件私有状态目录。 */
export function stateDir(home) {
  return path.join(home, ".ctxfold");
}

export function stateFile(home) {
  return path.join(stateDir(home), "state.json");
}

export function backupDir(home) {
  return path.join(stateDir(home), "backups");
}

export function cacheDir(home) {
  return path.join(stateDir(home), "cache");
}

/** 全局指令文件。Pi 也认 AGENTS.md 之外的若干名字，这里以主文件为准。 */
export function agentsFile(home) {
  return path.join(home, "AGENTS.md");
}

/** 技能根目录。 */
export function skillsDir(home) {
  return path.join(home, "skills");
}

/** Pi 的用户扩展目录：子目录含 index.ts 即被加载。 */
export function extensionsDir(home) {
  return path.join(home, "extensions");
}

export function presetLayersDir() {
  return path.join(PKG_ROOT, "presets", "layers");
}

export function presetRulesFile() {
  return path.join(PKG_ROOT, "presets", "rules", "default.json");
}

export function packagedSkillsDir() {
  return path.join(PKG_ROOT, "skills");
}
