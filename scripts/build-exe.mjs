/**
 * 打单文件 exe。
 *
 * 步骤：收集资产 → sea-config.json → sea-prep.blob → 复制 node.exe → postject 注入。
 * 产物：dist/ctxfold.exe（约 100+ MB，内含 Node 运行时，目标机不用装 Node）。
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, "..");
const DIST = path.join(PKG, "dist");
const BUILD = path.join(PKG, ".sea-build");

// 进 exe 的目录：只带运行时需要的
const INCLUDE_DIRS = ["lib", "gui", "presets", "patches", "skills", "extension"];
const INCLUDE_FILES = ["package.json", "README.md", "scripts/sea-boot.cjs"];
const SKIP = /\.(bak|log)$|__pycache__|\.DS_Store/;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (!SKIP.test(e.name)) out.push(full);
  }
  return out;
}

function collectAssets() {
  const files = [];
  for (const d of INCLUDE_DIRS) {
    const abs = path.join(PKG, d);
    if (fs.existsSync(abs)) files.push(...walk(abs));
  }
  for (const f of INCLUDE_FILES) {
    const abs = path.join(PKG, f);
    if (fs.existsSync(abs)) files.push(abs);
  }
  return files;
}

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: "inherit", cwd: PKG, ...opts });
}

// ── 1. 准备
fs.rmSync(BUILD, { recursive: true, force: true });
fs.mkdirSync(BUILD, { recursive: true });
fs.mkdirSync(DIST, { recursive: true });

const pkg = JSON.parse(fs.readFileSync(path.join(PKG, "package.json"), "utf8"));
const assets = collectAssets();

// 版本文件用于决定解包目录，改动会自动换新目录
fs.writeFileSync(
  path.join(BUILD, "VERSION.txt"),
  `${pkg.version}-${Date.now().toString(36)}\n`,
  "utf8",
);

const assetMap = { "VERSION.txt": path.join(BUILD, "VERSION.txt") };
for (const abs of assets) {
  const key = path.relative(PKG, abs).split(path.sep).join("/");
  assetMap[key] = abs;
}

const seaConfig = {
  main: path.join(BUILD, "sea-boot.cjs"),
  output: path.join(BUILD, "sea-prep.blob"),
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  assets: assetMap,
};

// sea-boot 需要拷到 build 目录，避免 main 指向被 assets 收集的源文件
fs.copyFileSync(path.join(PKG, "scripts", "sea-boot.cjs"), seaConfig.main);

const configPath = path.join(BUILD, "sea-config.json");
fs.writeFileSync(configPath, JSON.stringify(seaConfig, null, 2), "utf8");

console.log(`资产 ${Object.keys(assetMap).length} 个`);
console.log("生成 blob …");
sh(process.execPath, ["--experimental-sea-config", configPath]);

// ── 2. 复制 node 可执行文件
const exe = path.join(DIST, "ctxfold.exe");
fs.copyFileSync(process.execPath, exe);
console.log(`已复制 ${path.basename(process.execPath)} → ${path.relative(PKG, exe)}`);

// ── 3. postject 注入
const sentinel = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const postjectBin = path.join(PKG, "node_modules", "postject", "dist", "cli.js");
if (!fs.existsSync(postjectBin)) {
  console.error("缺少 postject，先运行：npm i -D postject");
  process.exit(1);
}
console.log("注入 blob …");
sh(process.execPath, [
  postjectBin,
  exe,
  "NODE_SEA_BLOB",
  seaConfig.output,
  "--sentinel-fuse",
  sentinel,
]);

const size = fs.statSync(exe).size;
console.log(`\n完成：${path.relative(PKG, exe)}  ${(size / 1024 / 1024).toFixed(1)} MB`);
