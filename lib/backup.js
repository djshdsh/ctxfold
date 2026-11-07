/**
 * 备份与回滚。
 *
 * 上游版的回滚靠「原始文件快照 + 补丁表」，Pi 这边只需要管一个 AGENTS.md，
 * 所以规则简单：写之前一定先备份，保留最近 N 份，revert 直接取最新一份。
 */

import fs from "node:fs";
import path from "node:path";
import { backupDir } from "./paths.js";

const KEEP = 10;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** 时间戳，文件名安全（Windows 不允许冒号）。 */
function stamp(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}` +
    `${p(date.getMilliseconds(), 3)}`
  );
}

/**
 * 备份一个文件。返回备份路径（文件不存在则返回 null）。
 * @param {string} home
 * @param {string} file
 * @param {string} tag 文件名前缀，便于人眼区分
 */
export function backupFile(home, file, tag = "file") {
  if (!fs.existsSync(file)) return null;
  const dir = backupDir(home);
  ensureDir(dir);
  const base = path.basename(file);
  const dest = path.join(dir, `${tag}-${base}.${stamp()}.bak`);
  fs.copyFileSync(file, dest);
  prune(home, tag, base);
  return dest;
}

function prune(home, tag, base) {
  const dir = backupDir(home);
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const prefix = `${tag}-${base}.`;
  const mine = names
    .filter((n) => n.startsWith(prefix) && n.endsWith(".bak"))
    .sort();
  while (mine.length > KEEP) {
    const victim = mine.shift();
    try {
      fs.unlinkSync(path.join(dir, victim));
    } catch {
      /* 备份清理失败不影响主流程 */
    }
  }
}

/** 列出某个文件的备份，最新在前。 */
export function listBackups(home, tag, base) {
  const dir = backupDir(home);
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const prefix = `${tag}-${base}.`;
  return names
    .filter((n) => n.startsWith(prefix) && n.endsWith(".bak"))
    .sort()
    .reverse()
    .map((n) => path.join(dir, n));
}

/** 取最新备份内容。 */
export function latestBackup(home, tag, base) {
  const [first] = listBackups(home, tag, base);
  if (!first) return null;
  return { path: first, content: fs.readFileSync(first, "utf8") };
}
