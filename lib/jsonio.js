/**
 * 读 JSON 时统一剥掉 BOM。
 *
 * Windows 上讲过的坑：记事本 / PowerShell 的 `-Encoding utf8` 会给文件加
 * EF BB BF。`JSON.parse` 遇到 BOM 直接抛，很多地方 catch 掉之后会**静默回退成默认值**，
 * 表现就是「明明改了 config，程序当没改」。
 */

import fs from "node:fs";
import path from "node:path";

/** 去掉开头的 UTF-8 BOM。 */
export function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * 读 JSON 文件。
 * @param {string} file
 * @param {unknown} [fallback] 给了就不抛异常，返回 fallback
 */
export function readJsonFile(file, fallback) {
  const raw = fs.readFileSync(file, "utf8");
  try {
    return JSON.parse(stripBom(raw));
  } catch (err) {
    if (arguments.length > 1) return fallback;
    throw err;
  }
}

/** 写 JSON 文件，永远不带 BOM。 */
export function writeJsonFile(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}
