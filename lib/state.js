/**
 * 插件状态持久化。<home>/.ctxfold/state.json
 *
 * 只记「装了什么、什么时候装的、内容指纹」这类元数据，不存正文 ——
 * 正文真源永远是 AGENTS.md 里那个 block，避免两份内容互相漂移。
 */

import fs from "node:fs";
import crypto from "node:crypto";
import { stateDir, stateFile } from "./paths.js";
import { stripBom } from "./jsonio.js";

export const STATE_VERSION = 1;

export function emptyState() {
  return {
    version: STATE_VERSION,
    applied: false,
    appliedAt: null,
    layers: [],
    routing: true,
    position: "bottom",
    hash: null,
    skillPacks: [],
    uninstallAvailable: false,
  };
}

export function readState(home) {
  const file = stateFile(home);
  try {
    const raw = fs.readFileSync(file, "utf8");
    const data = JSON.parse(stripBom(raw));
    if (!data || typeof data !== "object") return emptyState();
    return { ...emptyState(), ...data };
  } catch {
    return emptyState();
  }
}

export function writeState(home, state) {
  const dir = stateDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const next = { ...emptyState(), ...state, version: STATE_VERSION };
  fs.writeFileSync(stateFile(home), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

export function clearState(home) {
  const file = stateFile(home);
  try {
    fs.unlinkSync(file);
  } catch {
    /* 本来就没有 */
  }
}

/** 内容指纹，用来判断 AGENTS.md 里的 block 是否被外部改过。 */
export function hashOf(text) {
  return crypto.createHash("sha256").update(String(text || ""), "utf8").digest("hex").slice(0, 12);
}
