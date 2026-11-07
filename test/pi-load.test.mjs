/**
 * 真机加载测试：调 Pi 自己的 discoverAndLoadExtensions()，
 * 走的是 Pi 启动时一模一样的发现 + jiti 加载流程，但不发任何模型请求。
 *
 * 这是「Pi 会不会加载它」的唯一可信答案：
 *   - 目录发现对不对（extensions/ctxfold/index.ts）
 *   - TypeScript 能否被 jiti 加载
 *   - 扩展注册面在真实 ExtensionRunner 的数据结构里长什么样
 *
 * 用法：node test/pi-load.test.mjs [agentDir] [releaseDir]
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, "..");

// 这个测试必须有真实的 Pi 才能跑（它调 Pi 自己的加载器）。没有就明确跳过，
// 不当失败——CI 上没装 Pi 是常态。
const PI_HOME = process.env.CTXFOLD_PI_HOME || path.join(os.homedir(), ".pi", "agent");
const RELEASE = process.argv[3] || findRelease();
const LOADER = RELEASE
  ? path.join(RELEASE, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "extensions", "index.js")
  : "";

/** 取 Pi 最新一个发布目录；没有返回 null。 */
function findRelease() {
  const dir = path.join(PI_HOME, "install", "releases");
  let versions = [];
  try {
    versions = fs
      .readdirSync(dir)
      .filter((v) => fs.existsSync(path.join(dir, v, "package.json")))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  } catch {
    return null;
  }
  return versions.length ? path.join(dir, versions[versions.length - 1]) : null;
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ctxfold-load-"));
const AGENT_DIR = process.argv[2] || process.env.CTXFOLD_TEST_HOME || path.join(TMP, "agent");

if (!RELEASE || !fs.existsSync(LOADER)) {
  console.log("跳过：本机没有装 Pi Agent（找不到 install/releases/*/node_modules/@earendil-works/pi-coding-agent）。");
  console.log("这条测试要调 Pi 自己的 discoverAndLoadExtensions，没宿主就没法跑。装好 Pi 后重跑即可。");
  process.exit(0);
}

execFileSync(process.execPath, [path.join(PKG, "bin", "ctxfold.js"), "install", "--home", AGENT_DIR, "--force"], {
  cwd: PKG,
  stdio: "pipe",
});

process.on("exit", () => {
  if (process.env.CTXFOLD_TEST_HOME) return;
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* 临时目录 */
  }
});

let pass = 0;
let fail = 0;
const failures = [];

function check(label, condition, detail = "") {
  if (condition) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

console.log(`agent dir:   ${AGENT_DIR}`);
console.log(`pi release:  ${RELEASE}`);

section("前置");
check("Pi 已安装", fs.existsSync(RELEASE), RELEASE);
check("加载器存在", fs.existsSync(LOADER), LOADER);
check(
  "扩展已安装",
  fs.existsSync(path.join(AGENT_DIR, "extensions", "ctxfold", "index.ts")),
  "先跑 node bin/ctxfold.js install",
);
if (!fs.existsSync(LOADER) || !fs.existsSync(path.join(AGENT_DIR, "extensions", "ctxfold", "index.ts"))) {
  console.log(`\n失败：${pass} 通过 / ${fail + 1} 失败`);
  process.exit(1);
}

// ── 用 Pi 自己的发现+加载流程 ─────────────────────────────────────────

section("discoverAndLoadExtensions（Pi 启动时走的同一条路）");

let loader;
try {
  loader = await import(pathToFileURL(LOADER).href);
  check("导入 Pi 加载器", typeof loader.discoverAndLoadExtensions === "function");
} catch (error) {
  check("导入 Pi 加载器", false, String(error && error.message ? error.message : error));
  process.exit(1);
}

let result;
try {
  result = await loader.discoverAndLoadExtensions([], PKG, AGENT_DIR);
  check("发现并加载成功", true);
} catch (error) {
  check("发现并加载成功", false, String(error && error.message ? error.message : error));
  console.log(String(error && error.stack));
  process.exit(1);
}

const ours = result.extensions.find((ext) =>
  String(ext.path || ext.resolvedPath || "")
    .replace(/\\/g, "/")
    .includes("extensions/ctxfold"),
);

check("没有加载错误", (result.errors || []).length === 0, JSON.stringify(result.errors));
check("发现 ctxfold 扩展", Boolean(ours), (result.extensions || []).map((e) => e.path).join(", "));

if (ours) {
  section("真实注册面（来自 ExtensionRunner 的数据结构）");
  check("before_agent_start 已注册", (ours.handlers.get("before_agent_start") || []).length > 0);
  check("tool_call 已注册", (ours.handlers.get("tool_call") || []).length > 0);
  check("session_start 已注册", (ours.handlers.get("session_start") || []).length > 0);
  check("session_shutdown 已注册", (ours.handlers.get("session_shutdown") || []).length > 0);
  check("ctxfold 命令已注册", ours.commands.has("ctxfold"), [...ours.commands.keys()].join(", "));
  check("ctxfold_status 工具已注册", ours.tools.has("ctxfold_status"), [...ours.tools.keys()].join(", "));

  const cmd = ours.commands.get("ctxfold");
  check("命令带 description", Boolean(cmd?.description), JSON.stringify(cmd?.description));

  const tool = ours.tools.get("ctxfold_status");
  // RegisteredTool 的形态是 { definition, sourceInfo }，参数模式在 definition 里
  const def = tool?.definition || tool;
  check("工具带 description", Boolean(def?.description), def?.description);
  check(
    "工具带 parameters 模式",
    Boolean(def?.parameters || def?.inputSchema || def?.schema),
    Object.keys(def || {}).join(", "),
  );
}

// ── 面板/技能发现面 ───────────────────────────────────────────────────

section("资源发现面");
const skillFile = path.join(AGENT_DIR, "skills", "ctxfold", "SKILL.md");
check("技能文件就位", fs.existsSync(skillFile), skillFile);
if (fs.existsSync(skillFile)) {
  const raw = fs.readFileSync(skillFile, "utf8");
  check("技能有 frontmatter", raw.startsWith("---"), raw.slice(0, 20));
  check("技能声明 name", /^name:\s*ctxfold/m.test(raw));
  check("技能声明 description", /^description:/m.test(raw));
}

// ── 结果 ──────────────────────────────────────────────────────────────

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 通过 / ${fail} 失败`);
if (fail > 0) {
  console.log("\n失败项：");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
