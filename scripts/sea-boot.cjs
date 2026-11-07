/**
 * SEA 引导器（CommonJS）。
 *
 * 单文件 exe 里带着整套源码；运行时先摊到 %LOCALAPPDATA%\ctxfold\runtime\<版本>，
 * 再从那里 import 真正的 CLI。摊开一次后复用，避免每次启动都写盘。
 *
 * 无参数双击启动 = 直接开图形控制台。
 */

const { getAsset, getAssetKeys } = require("node:sea");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { pathToFileURL } = require("node:url");

const APP = "ctxfold";

function runtimeRoot() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(local, APP, "runtime");
}

function versionTag() {
  try {
    const buf = getAsset("VERSION.txt");
    return Buffer.from(buf).toString("utf8").trim().replace(/[^0-9a-zA-Z._-]/g, "_") || "dev";
  } catch {
    return "dev";
  }
}

function materialize() {
  const dir = path.join(runtimeRoot(), versionTag());
  const marker = path.join(dir, ".ready");
  if (fs.existsSync(marker)) return dir;

  for (const key of getAssetKeys()) {
    if (key === "VERSION.txt") continue;
    const dest = path.join(dir, key.split("/").join(path.sep));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, Buffer.from(getAsset(key)));
  }
  fs.writeFileSync(marker, `${new Date().toISOString()}\n`);
  return dir;
}

/** SEA 下 argv[0] 是可执行文件本身，没有脚本路径。 */
function userArgs() {
  const raw = process.argv.slice(1);
  return raw[0] && /\.exe$/i.test(raw[0]) ? raw.slice(1) : raw;
}

(async () => {
  let dir;
  try {
    dir = materialize();
  } catch (err) {
    process.stderr.write(`ctxfold: 解包失败 ${err && err.message ? err.message : err}\n`);
    process.exitCode = 1;
    return;
  }

  const args = userArgs();
  const argv = ["ctxfold", "sea", ...(args.length ? args : ["gui"])];

  const entry = path.join(dir, "lib", "commands.js");
  if (!fs.existsSync(entry)) {
    process.stderr.write(`ctxfold: 运行时文件缺失 ${entry}\n`);
    process.exitCode = 1;
    return;
  }

  try {
    const mod = await import(pathToFileURL(entry).href);
    process.exitCode = await mod.main(argv);
  } catch (err) {
    process.stderr.write(`${err && err.stack ? err.stack : err}\n`);
    process.exitCode = 1;
  }
})();
