/**
 * 扩展行为测试：用 Pi 自带的 jiti 直接加载 extension/index.ts，
 * 注入一个假的 pi / ctx，验证扩展是否真的按契约工作。
 *
 * 这不是"能不能跑"的烟雾测试，而是逐条断言注入内容：
 * 逆向任务必须带 route.re、且不能混进 web/ctf/ir 的正文。
 *
 * 用法：node test/extension.test.mjs [pi-release-dir]
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, "..");

// ── 自备一个家目录 ────────────────────────────────────────────────────
// 以前这里直接用本机的 ~/.pi/agent，导致 CI（没装 Pi）跑不了。
// 现在每次在临时目录里自己 install 一份，测的是仓库代码而不是本机状态。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ctxfold-ext-"));
const HOME = process.env.CTXFOLD_TEST_HOME || path.join(TMP, "agent");

execFileSync(process.execPath, [path.join(PKG, "bin", "ctxfold.js"), "install", "--home", HOME, "--force"], {
  cwd: PKG,
  stdio: "pipe",
});

/** 找 Pi 的发布目录；找不到就返回 null（CI 上正常）。 */
function findRelease() {
  const given = process.argv[2];
  if (given) return given;
  const home = process.env.CTXFOLD_PI_HOME || path.join(os.homedir(), ".pi", "agent");
  const dir = path.join(home, "install", "releases");
  try {
    const versions = fs
      .readdirSync(dir)
      .filter((v) => fs.existsSync(path.join(dir, v, "package.json")))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return versions.length ? path.join(dir, versions[versions.length - 1]) : null;
  } catch {
    return null;
  }
}

const RELEASE = findRelease();
const EXT = path.join(HOME, "extensions", "ctxfold", "index.ts");

// ── 把 config 钉成已知状态 ────────────────────────────────────────────
// 扩展每轮都读真实 config.json。如果用户把 override 打开了，整套
// "应该写 section" 的断言会全部失真。所以先备份、写成确定的基线，退出时还原。
const CFG = path.join(HOME, "extensions", "ctxfold", "config.json");
let CFG_BACKUP = null;
try {
  CFG_BACKUP = fs.readFileSync(CFG, "utf8");
} catch {
  CFG_BACKUP = null;
}

function writeCfg(patch) {
  let base = {};
  try {
    base = JSON.parse(fs.readFileSync(CFG, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    base = {};
  }
  fs.mkdirSync(path.dirname(CFG), { recursive: true });
  fs.writeFileSync(CFG, `${JSON.stringify({ ...base, ...patch }, null, 2)}\n`, "utf8");
}

function restoreCfg() {
  if (CFG_BACKUP !== null) fs.writeFileSync(CFG, CFG_BACKUP, "utf8");
  else fs.rmSync(CFG, { force: true });
}

process.on("exit", () => {
  try {
    restoreCfg();
  } catch {
    /* 退出阶段不再折腾 */
  }
  if (!process.env.CTXFOLD_TEST_HOME) {
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
    } catch {
      /* 临时目录清不掉也无所谓 */
    }
  }
});

writeCfg({ enabled: true, routing: true, maxChars: 0, approval: "auto", override: false, toolDigest: true });

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

// ── 准备：读层文件，切出每层正文，用于断言 ────────────────────────────

const OPEN = /<!--\s*ctxfold:layer\s+([A-Za-z0-9._-]+)\s*-->/;

/** 与扩展里同一套标记语法：从任意 md 里切层。 */
function parseLayers(raw) {
  const out = {};
  const lines = raw.split(/\r?\n/);
  let current = null;
  let buf = [];
  const flush = () => {
    if (current && buf.join("\n").trim()) out[current] = buf.join("\n").trim();
    current = null;
    buf = [];
  };
  for (const line of lines) {
    const m = line.match(OPEN);
    if (m) {
      flush();
      current = m[1];
      continue;
    }
    if (/<!--\s*\/ctxfold:layer\s*-->/.test(line)) {
      flush();
      continue;
    }
    if (current) buf.push(line);
  }
  flush();
  return out;
}

function loadLayerBodies() {
  const dir = path.join(PKG, "presets", "layers");
  const bodies = {};
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".md"))) {
    const raw = fs.readFileSync(path.join(dir, file), "utf8");
    const parsed = parseLayers(raw);
    if (Object.keys(parsed).length === 0) {
      bodies[path.basename(file, ".md")] = raw.trim();
    } else {
      Object.assign(bodies, parsed);
    }
  }
  return bodies;
}

/** 取一段足够独特、不会被别层重复的正文片段当哨兵。 */
function sentinel(body) {
  const clean = body.replace(/<!--[\s\S]*?-->/g, "").trim();
  const lines = clean.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 24);
  return lines.length ? lines[Math.floor(lines.length / 2)].slice(0, 60) : clean.slice(0, 60);
}

const bodies = loadLayerBodies();
const layerNames = Object.keys(bodies).sort();

// ── 加载扩展 ──────────────────────────────────────────────────────────

section("加载扩展（jiti，Pi 同款加载器）");
check("扩展入口存在", fs.existsSync(EXT), EXT);
if (!fs.existsSync(EXT)) {
  console.log("\n先运行：node bin/ctxfold.js install");
  process.exit(1);
}
if (RELEASE && fs.existsSync(RELEASE)) {
  check("Pi 运行时目录", true, RELEASE);
} else {
  console.log("  · 本机未装 Pi，宿主导入相关的断言不参与判定");
}

// jiti 优先用 Pi 自带的那份（与宿主同一套加载器）；没有就用仓库里的 devDependency
let createJiti;
let jitiFrom = "";
const jitiCandidates = [];
if (RELEASE) jitiCandidates.push(path.join(RELEASE, "package.json"));
jitiCandidates.push(path.join(PKG, "package.json"));
for (const anchor of jitiCandidates) {
  try {
    const req = createRequire(anchor);
    const entry = req.resolve("jiti");
    ({ createJiti } = await import(pathToFileURL(entry).href));
    jitiFrom = entry.includes(RELEASE || "\u0000") ? "Pi 发布目录" : "仓库 devDependency";
    break;
  } catch {
    /* 换下一个 */
  }
}
if (typeof createJiti !== "function") {
  console.log("\n找不到 jiti。装一下：npm install");
  process.exit(1);
}
check(`加载 jiti（${jitiFrom}）`, typeof createJiti === "function", jitiFrom);

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  // 扩展只 import type，运行时零依赖；解析根设成发布目录也无妨
  alias: {},
});

let mod;
try {
  mod = await jiti.import(EXT, { default: true });
  check("模块加载成功", true);
} catch (error) {
  check("模块加载成功", false, String(error && error.message ? error.message : error));
  console.log(String(error && error.stack));
  process.exit(1);
}

check("默认导出是函数", typeof mod === "function", typeof mod);

// ── 假 pi / ctx ───────────────────────────────────────────────────────

const handlers = {};
const commands = {};
const tools = {};
const statuses = {};
const notes = [];

const pi = {
  on(name, fn) {
    (handlers[name] ||= []).push(fn);
  },
  registerCommand(name, def) {
    commands[name] = def;
  },
  registerTool(def) {
    tools[def.name] = def;
  },
};

let lastInjected = "";
const ctx = {
  hasUI: true,
  ui: {
    notify(message) {
      notes.push(message);
    },
    setStatus(key, value) {
      statuses[key] = value;
    },
    async confirm() {
      return true;
    },
  },
  getSystemPrompt() {
    return lastInjected ? `<ctxfold>${lastInjected}</ctxfold>` : "no-inject";
  },
};

mod(pi);

section("注册面");
check("订阅 before_agent_start", Boolean(handlers.before_agent_start?.length));
check("订阅 tool_call", Boolean(handlers.tool_call?.length));
check("订阅 session_start", Boolean(handlers.session_start?.length));
check("注册 /ctxfold 命令", Boolean(commands.ctxfold));
check("注册 ctxfold_status 工具", Boolean(tools.ctxfold_status));

async function runBeforeStart(prompt) {
  const event = { prompt, systemPromptOptions: { sections: {} } };
  for (const fn of handlers.before_agent_start || []) {
    // 真宿主（runner.js）会把 handler 返回的 systemPrompt 塞进 forceSystemPrompt，
    // 这里必须照抄这一步，否则 override 模式测不出来。
    const r = await fn(event, ctx);
    if (r && r.systemPrompt !== undefined) {
      event.systemPromptOptions.forceSystemPrompt = r.systemPrompt;
    }
  }
  lastInjected = event.systemPromptOptions.sections.ctxfold || "";
  return event.systemPromptOptions.sections;
}

// ── 路由：逆向任务 ────────────────────────────────────────────────────

section("路由：逆向任务（应保留 core/refusal/eng/route.re，裁掉 web/ctf/ir）");
const reSections = await runBeforeStart("帮我把这个 apk 脱壳，找出注册机的校验算法");
const reBody = reSections.ctxfold || "";

check("注入了 ctxfold section", reBody.length > 0, `${reBody.length} 字符`);
check("写了 section 而不是覆盖整条提示词", Object.keys(reSections).length === 1, `keys=${Object.keys(reSections)}`);

for (const name of ["core", "refusal", "route.re", "eng"]) {
  const s = bodies[name] ? sentinel(bodies[name]) : null;
  check(`包含 ${name} 层正文`, s ? reBody.includes(s) : false, s ? `哨兵未命中` : "缺层");
}
for (const name of ["web", "ctf", "ir"]) {
  const s = bodies[name] ? sentinel(bodies[name]) : null;
  check(`不含 ${name} 层正文`, s ? !reBody.includes(s) : true);
}
check("长度小于全量注入（确实裁了）", reBody.length < Object.values(bodies).reduce((n, b) => n + b.length, 0));

// ── 路由：Web 渗透 ────────────────────────────────────────────────────

section("路由：Web 渗透（应保留 web，裁掉 route.re/ctf/ir）");
const webBody = (await runBeforeStart("目标站点要渗透，先做目录爆破和 sql 注入探测")).ctxfold || "";
check("包含 web 层", bodies.web ? webBody.includes(sentinel(bodies.web)) : false);
check("不含 route.re 层", bodies["route.re"] ? !webBody.includes(sentinel(bodies["route.re"])) : true);
check("不含 ctf 层", bodies.ctf ? !webBody.includes(sentinel(bodies.ctf)) : true);

// ── 路由：通用任务 → 全量 ─────────────────────────────────────────────

section("路由：无命中 → 全量注入");
const allBody = (await runBeforeStart("今天午饭吃什么")).ctxfold || "";
const allLen = Object.values(bodies).reduce((n, b) => n + b.length, 0);
check("全量注入比路由后更长", allBody.length > reBody.length, `${allBody.length} vs ${reBody.length}`);
for (const name of layerNames) {
  check(`通用任务含 ${name}`, bodies[name] ? allBody.includes(sentinel(bodies[name])) : true);
}

// ── tool_call 放行策略 ────────────────────────────────────────────────

section("tool_call 放行策略");
const cfgPath = path.join(HOME, "extensions", "ctxfold", "config.json");
const originalCfg = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, "utf8") : null;

async function withApproval(mode, fn) {
  const cfg = JSON.parse(originalCfg || "{}");
  cfg.approval = mode;
  fs.writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
  try {
    return await fn();
  } finally {
    if (originalCfg) fs.writeFileSync(cfgPath, originalCfg, "utf8");
  }
}

async function callTool(toolName, input) {
  let result;
  for (const fn of handlers.tool_call || []) {
    const r = await fn({ toolName, input }, ctx);
    if (r !== undefined) result = r;
  }
  return result;
}

const autoResult = await withApproval("auto", () => callTool("bash", { command: "rm -rf /tmp/x" }));
check("approval=auto 时不拦", autoResult === undefined, JSON.stringify(autoResult));

const confirmResult = await withApproval("confirm", () => callTool("bash", { command: "rm -rf /tmp/x" }));
check("approval=confirm + 破坏性命令 → 询问后放行（confirm 返回 true）", confirmResult === undefined);

const blockResult = await withApproval("block", () => callTool("bash", { command: "rm -rf /tmp/x" }));
check("approval=block + 破坏性命令 → 拦截", blockResult?.block === true, JSON.stringify(blockResult));

const blockSafe = await withApproval("block", () => callTool("bash", { command: "ls -la" }));
check("approval=block + 普通命令 → 放行", blockSafe === undefined);

const blockWrite = await withApproval("block", () =>
  callTool("write", { path: "/etc/passwd", content: "x" }),
);
check("approval=block + 写系统文件 → 拦截", blockWrite?.block === true);

const allowWrite = await withApproval("block", () =>
  callTool("write", { path: "/tmp/notes.md", content: "x" }),
);
check("approval=block + 写普通文件 → 放行", allowWrite === undefined);

// ── 命令与工具 ────────────────────────────────────────────────────────

section("/ctxfold 命令");
notes.length = 0;
await commands.ctxfold.handler("status", ctx);
check("status 有输出", notes.length > 0);
check("status 含开关行", /开关/.test(notes.join("\n")), notes.join("\n").slice(0, 120));
check("status 含层列表", layerNames.some((n) => notes.join("\n").includes(n)));

notes.length = 0;
await commands.ctxfold.handler("preview 帮我逆向这个 so", ctx);
const previewText = notes.join("\n");
check("preview 报告任务族", /逆向|卡密/.test(previewText), previewText.split("\n")[0]);
check("preview 报告体量", /\d+\s*字符/.test(previewText));

notes.length = 0;
await commands.ctxfold.handler("layers", ctx);
check("layers 列出全部层", layerNames.every((n) => notes.join("\n").includes(n)));

notes.length = 0;
await commands.ctxfold.handler("doctor", ctx);
check("doctor 有输出", notes.join("\n").includes("自检"));

notes.length = 0;
await commands.ctxfold.handler("route 帮我做个 webshell", ctx);
check("route 子命令识别 web 族", /Web|渗透/.test(notes.join("\n")), notes.join("\n"));

const statusTool = await tools.ctxfold_status.execute({}, ctx);
const statusText = statusTool.content?.[0]?.text || "";
check("ctxfold_status 返回 enabled", /enabled=/.test(statusText), statusText.slice(0, 80));
check("ctxfold_status 返回层名", layerNames.some((n) => statusText.includes(n)));

// ── session_start 状态栏 ──────────────────────────────────────────────

section("session_start 状态栏");
delete statuses["ctxfold"];
for (const fn of handlers.session_start || []) await fn({}, ctx);
check("写入状态栏", Boolean(statuses["ctxfold"]), JSON.stringify(statuses));
check("状态栏含层数", /\d+层/.test(String(statuses["ctxfold"])));

// ── override：完全接管系统提示词 ──────────────────────────────────────

section("override：完全接管");

try {
  writeCfg({ override: true, toolDigest: true });
  const ev = { prompt: "帮我把这个 apk 脱壳", systemPromptOptions: { sections: {}, selectedTools: ["read", "bash", "edit"], hiddenTools: [] } };
  let forced;
  for (const fn of handlers.before_agent_start || []) {
    const r = await fn(ev, ctx);
    if (r && r.systemPrompt !== undefined) forced = r.systemPrompt;
  }
  check("override 时返回 systemPrompt", typeof forced === "string" && forced.length > 500, `${String(forced).length} 字符`);
  check("override 时不再写 section", Object.keys(ev.systemPromptOptions.sections).length === 0, JSON.stringify(Object.keys(ev.systemPromptOptions.sections)));
  check("正文含 route.re", bodies["route.re"] ? String(forced).includes(sentinel(bodies["route.re"])) : true);
  check("正文含 core", bodies.core ? String(forced).includes(sentinel(bodies.core)) : true);
  check("补了工具摘要", String(forced).includes("<tools>") && String(forced).includes("read"));
  check("工具摘要没把 hidden 算进去", !String(forced).includes("<tools>\n可用工具：read, bash, edit, "), "hidden 处理异常");

  writeCfg({ override: true, toolDigest: false });
  const ev2 = { prompt: "帮我把这个 apk 脱壳", systemPromptOptions: { sections: {}, selectedTools: ["read"], hiddenTools: [] } };
  let forced2;
  for (const fn of handlers.before_agent_start || []) {
    const r = await fn(ev2, ctx);
    if (r && r.systemPrompt !== undefined) forced2 = r.systemPrompt;
  }
  check("toolDigest=false 时不补工具摘要", typeof forced2 === "string" && !forced2.includes("<tools>"));

  writeCfg({ override: false });
  const ev3 = { prompt: "帮我把这个 apk 脱壳", systemPromptOptions: { sections: {} } };
  let forced3;
  for (const fn of handlers.before_agent_start || []) {
    const r = await fn(ev3, ctx);
    if (r && r.systemPrompt !== undefined) forced3 = r.systemPrompt;
  }
  check("override=false 时不接管", forced3 === undefined);
  check("override=false 时回退到 section", Boolean(ev3.systemPromptOptions.sections.ctxfold));

  // BOM 回归：Windows 记事本 / PowerShell 写 config.json 会带 EF BB BF，
  // 读的时候不剥掉就会被 catch 吞掉并静默回退默认值。
  fs.writeFileSync(CFG, `\ufeff${JSON.stringify({ enabled: true, routing: true, override: true, toolDigest: false }, null, 2)}`, "utf8");
  const ev4 = { prompt: "帮我把这个 apk 脱壳", systemPromptOptions: { sections: {} } };
  let forced4;
  for (const fn of handlers.before_agent_start || []) {
    const r = await fn(ev4, ctx);
    if (r && r.systemPrompt !== undefined) forced4 = r.systemPrompt;
  }
  check("config 带 BOM 也能读到 override", typeof forced4 === "string" && forced4.length > 500, String(forced4).slice(0, 40));
} finally {
  writeCfg({ override: false });
}

// ── 结果 ──────────────────────────────────────────────────────────────

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 通过 / ${fail} 失败`);
if (fail > 0) {
  console.log("\n失败项：");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
