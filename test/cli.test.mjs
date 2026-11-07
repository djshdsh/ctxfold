/**
 * CLI 测试：在临时 home 里跑完整闭环，不碰真实 Pi 环境。
 *
 * 覆盖：install → verify → status → render → apply → revert → uninstall → doctor
 * 每一步都断言退出码和关键输出，避免"跑完没报错就算过"。
 *
 * 用法：node test/cli.test.mjs
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, "..");
const BIN = path.join(PKG, "bin", "ctxfold.js");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pipurge-cli-"));

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

async function cli(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [BIN, ...args, "--home", HOME], {
      cwd: PKG,
      env: { ...process.env, NO_COLOR: "1" },
    });
    return { code: 0, out: stdout + stderr };
  } catch (error) {
    return { code: error.code ?? 1, out: `${error.stdout || ""}${error.stderr || ""}` };
  }
}

const exists = (rel) => fs.existsSync(path.join(HOME, rel));

console.log(`临时 home：${HOME}`);

// ── install ───────────────────────────────────────────────────────────

section("install");
{
  const r = await cli(["install"]);
  check("退出码 0", r.code === 0, `code=${r.code}`);
  check("扩展入口就位", exists("extensions/ctxfold/index.ts"));
  check("规则集就位", exists("extensions/ctxfold/rules.json"));
  check("config 生成", exists("extensions/ctxfold/config.json"));
  check("预设层落盘", fs.readdirSync(path.join(HOME, "extensions", "ctxfold", "layers")).length === 7);
  check("用户层落盘", fs.readdirSync(path.join(HOME, ".ctxfold", "layers")).length === 7);
  check("技能落盘", exists("skills/ctxfold/SKILL.md"));
  check("入口非空", fs.statSync(path.join(HOME, "extensions", "ctxfold", "index.ts")).size > 10000);

  const cfg = JSON.parse(fs.readFileSync(path.join(HOME, "extensions", "ctxfold", "config.json"), "utf8"));
  check("config 默认字段齐全", ["enabled", "routing", "maxChars", "approval"].every((k) => k in cfg), JSON.stringify(cfg));
}

// 重装不会覆盖 config（运行期开关要保住）
{
  const cfgPath = path.join(HOME, "extensions", "ctxfold", "config.json");
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  cfg.approval = "block";
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  const r = await cli(["install", "--force"]);
  const after = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  check("--force 重装保留 config 开关", r.code === 0 && after.approval === "block", after.approval);
}

// ── verify ────────────────────────────────────────────────────────────

section("verify");
{
  const r = await cli(["verify"]);
  check("退出码 0", r.code === 0, `code=${r.code}`);
  check("报告入口", /入口文件/.test(r.out));
  check("报七层", /core/.test(r.out) && /route\.re/.test(r.out));
  check("报告技能", /SKILL\.md/.test(r.out));
}

// ── render ────────────────────────────────────────────────────────────

section("render");
{
  const full = await cli(["render"]);
  check("全量渲染退出码 0", full.code === 0);
  check("全量含 route.re 正文", /逆向|脱壳|卡密/.test(full.out));

  const re = await cli(["render", "--text", "帮我逆向这个 apk 脱壳找注册机"]);
  check("路由后更短", re.out.length > 0 && re.out.length < full.out.length, `${re.out.length} vs ${full.out.length}`);

  const web = await cli(["render", "--text", "渗透这个站，做 sql 注入探测"]);
  check("web 任务渲染出 web 正文", /渗透|注入|WAF|waf/i.test(web.out));

  // 光看关键词会被 eng 层的词表误导：必须确认这一族真的被判成了 web。
  const webRoute = await cli(["route", "--text", "渗透这个站，做 sql 注入探测"]);
  check("该文本判定为 web 族", /web/.test(webRoute.out), webRoute.out.split("\n")[1]);
  check("web 族保留 web 层", /保留.*\bweb\b/.test(webRoute.out), webRoute.out.trim());

  // 哨兵必须只属于 route.re 层本身：eng 层里也有"脱壳"，规则层则每族都进，
  // 所以先从层文件里算出「只出现在 route.re.md 的长行」，再拿它判断。
  const presetDir = path.join(PKG, "presets", "layers");
  const layerFiles = fs.readdirSync(presetDir).filter((f) => f.endsWith(".md"));
  const linesOf = (file) =>
    fs
      .readFileSync(path.join(presetDir, file), "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 30 && !l.startsWith("#") && !l.startsWith("<!--"));
  const reLines = linesOf("route.re.md");
  const others = layerFiles.filter((f) => f !== "route.re.md").flatMap(linesOf);
  const reSentinel = reLines.find((l) => !others.some((o) => o.includes(l)));
  check("取到 route.re 独占哨兵", Boolean(reSentinel), reSentinel ? reSentinel.slice(0, 40) : "无独占行");
  check("web 任务不含 route.re 正文", reSentinel ? !web.out.includes(reSentinel) : false);

  const sel = await cli(["render", "--layers", "core"]);
  check("--layers 只渲染指定层", sel.code === 0 && sel.out.length < full.out.length);
}

// ── apply / status / revert ───────────────────────────────────────────

section("apply → status → revert");
{
  const a = await cli(["apply"]);
  check("apply 退出码 0", a.code === 0, `code=${a.code}`);
  check("AGENTS.md 已生成", exists("AGENTS.md"));

  const agents = fs.readFileSync(path.join(HOME, "AGENTS.md"), "utf8");
  check("写入受标记区块", /ctxfold:layer|ctxfold:begin|ctxfold:start/i.test(agents), agents.slice(0, 120));

  const s = await cli(["status"]);
  check("status 退出码 0", s.code === 0);
  check("status 报告已注入", /注入|区块/.test(s.out));

  // 用户自己的内容必须在 revert 后活下来
  const mine = `${agents}\n\n## 我自己的说明\n这段不能丢\n`;
  fs.writeFileSync(path.join(HOME, "AGENTS.md"), mine, "utf8");

  const rv = await cli(["revert"]);
  check("revert 退出码 0", rv.code === 0, `code=${rv.code}`);
  const afterRevert = fs.readFileSync(path.join(HOME, "AGENTS.md"), "utf8");
  check("revert 保留用户内容", afterRevert.includes("这段不能丢"), afterRevert.slice(0, 120));
  check("revert 摘掉注入", !/ctxfold:layer/i.test(afterRevert));

  // 此时扩展还装着，撤掉 AGENTS.md 区块不该被当成故障——
  // 两条注入通道任一条通就是健康的。
  const d = await cli(["doctor"]);
  check("revert 后 doctor 报告扩展通道", /扩展/.test(d.out), d.out.split("\n").find((l) => /inject|通道/.test(l)));
  check("revert 后 doctor 仍通过（扩展还在）", d.code === 0, `code=${d.code}`);
}

// ── 路由与规则 ────────────────────────────────────────────────────────

section("route / rules / analyze");
{
  const r = await cli(["route", "--text", "应急响应，排查这台机器有没有被挖矿"]);
  check("route 识别应急族", /应急/.test(r.out), r.out.split("\n")[0]);
  check("route 裁掉 web", /裁掉/.test(r.out));

  const r2 = await cli(["route", "--text", "帮我写个部署脚本"]);
  check("route 识别工程族", /工程/.test(r2.out), r2.out.split("\n")[0]);

  const r3 = await cli(["route", "--text", "今天天气"]);
  check("route 无命中走通用", /通用/.test(r3.out), r3.out.split("\n")[0]);

  const rules = await cli(["rules"]);
  check("rules 列出规则", /first-line-deliverable/.test(rules.out));

  const off = await cli(["rules", "off", "no-ask-back"]);
  check("rules off 成功", off.code === 0, `code=${off.code}`);
  const rulesAfter = await cli(["rules"]);
  check("off 后该条显示 off", /off\s+no-ask-back/.test(rulesAfter.out), rulesAfter.out.slice(0, 200));

  const a = await cli(["analyze"]);
  check("analyze 给分层字符数", /字符|char/.test(a.out));
}

// ── layers ────────────────────────────────────────────────────────────

section("layers");
{
  const list = await cli(["layers", "list"]);
  check("layers list 有输出", /core/.test(list.out));

  const show = await cli(["layers", "show", "eng"]);
  check("layers show 出正文", show.code === 0 && show.out.length > 200);

  // install 已经把预设铺进用户层目录了，所以先摘掉副本再验 fork 的创建路径
  const userEng = path.join(HOME, ".ctxfold", "layers", "eng.md");
  fs.rmSync(userEng, { force: true });
  const fork = await cli(["layers", "fork", "eng"]);
  check("layers fork 成功", fork.code === 0, `code=${fork.code}`);
  check("用户层出现副本", fs.existsSync(userEng));

  // 已存在时不加 --force 应当拒绝覆盖，退出码 1
  const forkAgain = await cli(["layers", "fork", "eng"]);
  check("重复 fork 不加 --force 被拒", forkAgain.code === 1, `code=${forkAgain.code}`);
  const forkForce = await cli(["layers", "fork", "eng", "--force"]);
  check("--force 覆盖成功", forkForce.code === 0, `code=${forkForce.code}`);

  const p = await cli(["layers", "path", "eng"]);
  check("layers path 指向用户层", /\.ctxfold/.test(p.out), p.out.trim());
}

// ── uninstall ─────────────────────────────────────────────────────────

section("uninstall");
{
  const r = await cli(["uninstall"]);
  check("uninstall 退出码 0", r.code === 0, `code=${r.code}`);
  check("扩展目录已移除", !exists("extensions/ctxfold"));
  check("技能目录已移除", !exists("skills/ctxfold"));
  check("用户层保留（防误删手改内容）", exists(".ctxfold/layers"));

  const v = await cli(["verify"]);
  check("verify 在缺失时退出码 1", v.code === 1, `code=${v.code}`);

  const d = await cli(["doctor"]);
  check("doctor 在缺失时报错", d.code === 1);
}

// ── 边界 ──────────────────────────────────────────────────────────────

section("边界");
{
  const bad = await cli(["no-such-command"]);
  check("未知命令退出码 2", bad.code === 2, `code=${bad.code}`);

  const help = await cli(["--help"]);
  check("--help 退出码 0", help.code === 0);
  check("help 含 install", /install/.test(help.out));
  check("help 含 uninstall", /uninstall/.test(help.out));

  const empty = path.join(HOME, "empty-render");
  const r = await cli(["render", "--layers", "no-such-layer"]);
  check("选不存在的层不崩", r.code === 0 || r.code === 1, `code=${r.code}`);
}

// ── 结果 ──────────────────────────────────────────────────────────────

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 通过 / ${fail} 失败`);
if (fail > 0) {
  console.log("\n失败项：");
  for (const f of failures) console.log(`  - ${f}`);
}
console.log(`\n清理 ${HOME}`);
fs.rmSync(HOME, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
