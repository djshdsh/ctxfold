/**
 * 注入体组装。
 *
 * 顺序就是层在最终提示词里的出现顺序。core 一定在最前（人设与交付纪律），
 * 领域层在后（越靠后的具体指令对当轮行为影响越大，但也不该压掉底线）。
 */

import fs from "node:fs";
import path from "node:path";
import { presetLayersDir } from "./paths.js";
import { parseLayers, selectLayers, DEFAULT_ALWAYS } from "./layers.js";
import { BASE_LAYERS, classifyTask, pruneForFamily, routeLayers, describeFamily, GENERAL } from "./router.js";
import { rulesText } from "./rules.js";

/** 层文件顺序。不在表里的自定义层按文件名字母序追加在后面。 */
export const LAYER_ORDER = ["core", "refusal", "eng", "rules", "route.re", "web", "ctf", "ir"];

/** 常驻层。`rules` 也在里面：它是用户自己开的能力，不该被路由裁掉。 */
export const ALWAYS = [...BASE_LAYERS, "rules"].filter((v, i, a) => a.indexOf(v) === i);

function readLayerFile(file) {
  const text = fs.readFileSync(file, "utf8");
  const parsed = parseLayers(text);
  // 文件里没有任何标记时，整个文件算一层，层名取文件名。
  if (parsed.layers.length === 1 && parsed.names[0] === "core" && !/<!--\s*ctxfold:layer/.test(text)) {
    const name = path.basename(file, ".md");
    return [{ name, text: parsed.clean, chars: parsed.clean.length, startLine: 1 }];
  }
  return parsed.layers;
}

/**
 * 读取所有层。返回按 LAYER_ORDER 排好序的数组，
 * 同名层合并（先出现的在前），未知层排在已知层之后。
 */
export function loadLayers(dir = presetLayersDir()) {
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }

  const collected = [];
  for (const file of files) {
    try {
      collected.push(...readLayerFile(path.join(dir, file)));
    } catch {
      /* 单个层文件读坏了不该拖垮整体注入 */
    }
  }

  const rank = (name) => {
    const i = LAYER_ORDER.indexOf(name);
    return i === -1 ? LAYER_ORDER.length : i;
  };
  collected.sort((a, b) => rank(a.name) - rank(b.name));

  // 同名合并，保序去重
  const merged = [];
  const index = new Map();
  for (const l of collected) {
    if (index.has(l.name)) {
      const prev = merged[index.get(l.name)];
      prev.text = `${prev.text}\n\n${l.text}`.trim();
      prev.chars = prev.text.length;
    } else {
      index.set(l.name, merged.length);
      merged.push({ ...l });
    }
  }
  return merged;
}

/** 用户自建/覆盖层目录：<home>/.ctxfold/layers/。 */
export function userLayersDir(home) {
  return path.join(home, ".ctxfold", "layers");
}

/** 读取用户层。文件里没有标记时整份算一层，层名取文件名。 */
export function loadUserLayers(home) {
  if (!home) return [];
  const dir = userLayersDir(home);
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const out = [];
  for (const file of files) {
    try {
      out.push(...readLayerFile(path.join(dir, file)));
    } catch {
      /* 坏文件跳过 */
    }
  }
  return out;
}

function sortByOrder(list) {
  const rank = (name) => {
    const i = LAYER_ORDER.indexOf(name);
    return i === -1 ? LAYER_ORDER.length : i;
  };
  return [...list].sort((a, b) => rank(a.name) - rank(b.name));
}

/**
 * 预设层 + 用户层合并。同名层由用户层覆盖 —— 这是「不改包内文件也能改注入」的入口。
 */
export function loadAllLayers(home) {
  const byName = new Map();
  for (const l of loadLayers()) byName.set(l.name, l);
  for (const l of loadUserLayers(home)) byName.set(l.name, l);
  return sortByOrder([...byName.values()]);
}

/**
 * 组装注入正文。
 *
 * @param {object} opts
 * @param {string} opts.home 用于读取规则集与用户层
 * @param {string} [opts.text] 当轮任务文本，用于任务族识别
 * @param {boolean} [opts.routing=true] 是否按任务族裁剪
 * @param {string[]|"all"} [opts.layers] 显式指定启用的层（跳过路由）
 * @param {Array} [opts.sources] 预加载的层（测试用）
 */
export function assemble(opts = {}) {
  const home = opts.home;
  const routing = opts.routing !== false;
  const sources = opts.sources || loadAllLayers(home);

  // 规则集作为一层接进来：用户可以在不碰层文件的情况下开关行为。
  const extra = [];
  if (home) {
    const body = rulesText(home);
    if (body) extra.push({ name: "rules", text: body, chars: body.length, startLine: 1 });
  }
  const all = [...sources, ...extra];
  const parsed = {
    layers: all,
    names: [...new Set(all.map((l) => l.name))],
    clean: all.map((l) => l.text).filter(Boolean).join("\n\n"),
  };

  const family = routing && opts.text ? classifyTask(opts.text) : GENERAL;
  let wanted;
  if (opts.layers && opts.layers !== "all") {
    wanted = Array.isArray(opts.layers) ? opts.layers : [opts.layers];
  } else if (routing && family !== GENERAL) {
    wanted = pruneForFamily(parsed.names, family);
  } else {
    wanted = "all";
  }

  const selected = selectLayers(parsed, wanted, { always: ALWAYS });
  return {
    text: selected.text,
    kept: selected.kept,
    names: parsed.names,
    family,
    familyLabel: describeFamily(family),
    routed: wanted !== "all",
    fallback: selected.fallback,
    unmatched: selected.unmatched,
    allowedForFamily: routeLayers(family),
  };
}

export { DEFAULT_ALWAYS };
