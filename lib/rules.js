/**
 * 规则集。
 *
 * ctxfold 的规则是「补丁分组开关」，因为它的每条补丁都绑在 上游源码某一行上。
 * Pi 没有可打补丁的源码，所以规则改成「可独立开关的短指令片段」：
 * 默认集随包发运，用户开关存 <home>/.ctxfold/rules.json，也可以自己加条。
 *
 * 好处：调一条行为不用改层文件，也不会把整段 layer 重写一遍。
 */

import fs from "node:fs";
import path from "node:path";
import { presetRulesFile, stateDir } from "./paths.js";
import { stripBom } from "./jsonio.js";

function overridesFile(home) {
  return path.join(stateDir(home), "rules.json");
}

export function loadDefaults() {
  try {
    const data = JSON.parse(stripBom(fs.readFileSync(presetRulesFile(), "utf8")));
    const rules = Array.isArray(data.rules) ? data.rules : [];
    return rules
      .filter((r) => r && typeof r.id === "string" && typeof r.body === "string")
      .map((r) => ({
        id: r.id,
        label: r.label || r.id,
        layer: r.layer || "rules",
        enabled: r.enabled !== false,
        body: r.body.trim(),
      }));
  } catch {
    return [];
  }
}

export function loadOverrides(home) {
  try {
    const data = JSON.parse(stripBom(fs.readFileSync(overridesFile(home), "utf8")));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

function writeOverrides(home, data) {
  const dir = stateDir(home);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(overridesFile(home), `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

/**
 * 合并默认集与用户覆盖。返回值里 enabled 已经结算好。
 * 自定义规则放在 overrides.custom（数组），与默认集同形。
 */
export function loadRules(home) {
  const defaults = loadDefaults();
  const over = loadOverrides(home);
  const toggles = over.toggles && typeof over.toggles === "object" ? over.toggles : {};
  const custom = Array.isArray(over.custom) ? over.custom : [];

  const merged = defaults.map((r) => ({
    ...r,
    custom: false,
    enabled: Object.prototype.hasOwnProperty.call(toggles, r.id) ? Boolean(toggles[r.id]) : r.enabled,
  }));

  for (const c of custom) {
    if (!c || typeof c.id !== "string" || typeof c.body !== "string") continue;
    merged.push({
      id: c.id,
      label: c.label || c.id,
      layer: c.layer || "rules",
      enabled: Object.prototype.hasOwnProperty.call(toggles, c.id) ? Boolean(toggles[c.id]) : c.enabled !== false,
      body: String(c.body).trim(),
      custom: true,
    });
  }
  return merged;
}

export function setRule(home, id, enabled) {
  const over = loadOverrides(home);
  const toggles = over.toggles && typeof over.toggles === "object" ? over.toggles : {};
  toggles[id] = Boolean(enabled);
  over.toggles = toggles;
  writeOverrides(home, over);
  return over;
}

export function addRule(home, rule) {
  if (!rule || typeof rule.id !== "string" || typeof rule.body !== "string") {
    throw new Error("自定义规则需要 id 与 body");
  }
  const over = loadOverrides(home);
  const custom = Array.isArray(over.custom) ? over.custom : [];
  const hit = custom.findIndex((r) => r.id === rule.id);
  const entry = {
    id: rule.id,
    label: rule.label || rule.id,
    layer: rule.layer || "rules",
    enabled: rule.enabled !== false,
    body: rule.body,
  };
  if (hit >= 0) custom[hit] = entry;
  else custom.push(entry);
  over.custom = custom;
  writeOverrides(home, over);
  return entry;
}

export function removeRule(home, id) {
  const over = loadOverrides(home);
  const custom = Array.isArray(over.custom) ? over.custom : [];
  over.custom = custom.filter((r) => r.id !== id);
  writeOverrides(home, over);
  return over.custom.length;
}

/** 把启用的规则拼成一段正文，作为 `rules` 层注入。 */
export function rulesText(home) {
  const rules = loadRules(home).filter((r) => r.enabled);
  if (!rules.length) return "";
  return rules.map((r) => `- **${r.label}**：${r.body}`).join("\n");
}
