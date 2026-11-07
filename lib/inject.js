/**
 * AGENTS.md 区块管理。
 *
 * Pi 没有 上游那种「往 systemPrompt 组装管线里塞 section」的接口，
 * 全局指令就是一个 Markdown 文件。所以注入 = 在文件里维护一个受标记保护的区块：
 *
 *   <!-- ctxfold:begin ... -->
 *   …注入正文…
 *   <!-- ctxfold:end -->
 *
 * 区块外的内容永远原样保留，这是不破坏用户自有 AGENTS.md 的底线。
 */

import fs from "node:fs";
import path from "node:path";
import { agentsFile } from "./paths.js";

const BEGIN_RE = /<!--\s*ctxfold:begin\b([^>]*?)-->/;
const END_RE = /<!--\s*ctxfold:end\s*-->/;

function parseMeta(raw) {
  const meta = {};
  const text = String(raw || "");
  const re = /([A-Za-z_][\w-]*)=("[^"]*"|\S+)/g;
  let m;
  while ((m = re.exec(text))) {
    meta[m[1]] = m[2].replace(/^"|"$/g, "");
  }
  return meta;
}

/** 找到区块。返回 { start, end, body, meta } 或 null。 */
export function findBlock(text) {
  const source = String(text || "");
  const b = BEGIN_RE.exec(source);
  if (!b) return null;
  const afterBegin = b.index + b[0].length;
  END_RE.lastIndex = afterBegin;
  const e = END_RE.exec(source);
  if (!e) {
    // 只有开标记：把余下全文视为区块，重写时整体替换，不丢用户写在前面的内容。
    return {
      start: b.index,
      end: source.length,
      body: source.slice(afterBegin).replace(/^\r?\n/, ""),
      meta: parseMeta(b[1]),
      unterminated: true,
    };
  }
  return {
    start: b.index,
    end: e.index + e[0].length,
    body: source.slice(afterBegin, e.index).replace(/^\r?\n/, "").replace(/\r?\n$/, ""),
    meta: parseMeta(b[1]),
    unterminated: false,
  };
}

/** 去掉区块，留下用户自己的内容（首尾空行归一）。 */
export function stripBlock(text) {
  const source = String(text || "");
  const block = findBlock(source);
  if (!block) return source;
  const head = source.slice(0, block.start).replace(/\s+$/, "");
  const tail = source.slice(block.end).replace(/^\s+/, "");
  if (!head && !tail) return "";
  if (!head) return `${tail}\n`;
  if (!tail) return `${head}\n`;
  return `${head}\n\n${tail}\n`;
}

function beginMarker(meta) {
  const attrs = Object.entries(meta)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ");
  return `<!-- ctxfold:begin ${attrs} -->`;
}

/**
 * 合成最终文件内容。
 * @param {string} original 现有文件内容（可为空）
 * @param {string} body 注入正文
 * @param {object} meta { version, hash, layers, at }
 * @param {"top"|"bottom"} position 无区块时插到哪
 */
export function compose(original, body, meta = {}, position = "bottom") {
  const source = String(original || "");
  const block = findBlock(source);
  const rendered = `${beginMarker(meta)}\n${String(body || "").trim()}\n<!-- ctxfold:end -->`;

  if (block) {
    const head = source.slice(0, block.start).replace(/\s+$/, "");
    const tail = source.slice(block.end).replace(/^\s+/, "");
    const parts = [];
    if (head) parts.push(head);
    parts.push(rendered);
    if (tail) parts.push(tail.replace(/\s+$/, ""));
    return `${parts.join("\n\n")}\n`;
  }

  const base = source.replace(/\s+$/, "");
  if (!base) return `${rendered}\n`;
  if (position === "top") return `${rendered}\n\n${base}\n`;
  return `${base}\n\n${rendered}\n`;
}

export function readAgents(home) {
  const file = agentsFile(home);
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

export function writeAgents(home, content) {
  const file = agentsFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
  return file;
}

/** 只取区块正文（不含标记），用于 status / 分析。 */
export function blockBody(home) {
  const block = findBlock(readAgents(home));
  return block ? block.body : "";
}
