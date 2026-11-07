/**
 * 控制台冒烟测试：启动本地服务 → 取 token → 打各接口。
 * 安装目标用临时目录，不碰真实 ~/.pi/agent。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { startServer, detectTargets } from "../gui/server.js";

let pass = 0;
let fail = 0;

function check(name, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `  ${detail}` : ""}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctxfold-gui-"));
const home = path.join(tmp, ".pi", "agent");
fs.mkdirSync(home, { recursive: true });

console.log("\n目标检测");
const targets = detectTargets();
check("返回数组", Array.isArray(targets), typeof targets);
check("至少一个目标", targets.length > 0, `got ${targets.length}`);
check("每项有必需字段", targets.every((t) => "path" in t && "source" in t && "installed" in t));

const srv = await startServer({ home, port: 0, open: false, quiet: true });
const base = `http://127.0.0.1:${srv.port}`;

try {
  console.log("\n页面与鉴权");
  const html = await fetch(`${base}/`).then((r) => r.text());
  check("首页返回 HTML", html.includes("<title>ctxfold"), html.slice(0, 40));
  check("token 已注入页面", !html.includes("__CTXFOLD_TOKEN__"));

  const token = (html.match(/const TOKEN = "([a-f0-9]+)"/) || [])[1];
  check("能取出 token", Boolean(token && token.length === 32), token);

  const noToken = await fetch(`${base}/api/install`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ home }),
  });
  check("无 token 的写请求被拒", noToken.status === 403, String(noToken.status));

  console.log("\n读接口");
  const tg = await fetch(`${base}/api/targets`).then((r) => r.json());
  check("targets 接口可用", tg.ok && Array.isArray(tg.targets));

  const st = await fetch(`${base}/api/status?home=${encodeURIComponent(home)}`).then((r) => r.json());
  check("status 接口可用", st.ok === true, JSON.stringify(st).slice(0, 80));
  check("未注入时通道为 none", st.channel === "none", st.channel);

  const lay = await fetch(`${base}/api/layers?home=${encodeURIComponent(home)}`).then((r) => r.json());
  check("layers 接口列出层", lay.ok && lay.layers.length >= 5, `got ${lay.layers?.length}`);
  check("层带字符数", lay.layers.every((l) => typeof l.chars === "number" && l.chars > 0));

  console.log("\n一键注入");
  const ins = await fetch(`${base}/api/install`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ctxfold-token": token },
    body: JSON.stringify({ home, force: true }),
  }).then((r) => r.json());
  check("install 返回成功", ins.ok === true, JSON.stringify(ins).slice(0, 120));
  check("写入了文件", (ins.result?.written ?? 0) > 0, String(ins.result?.written));
  check("注入了扩展", fs.existsSync(path.join(home, "extensions", "ctxfold", "index.ts")));
  check("注入了技能", fs.existsSync(path.join(home, "skills", "ctxfold", "SKILL.md")));
  check("注入了用户层", fs.existsSync(path.join(home, ".ctxfold", "layers")));
  check("安装后通道变 extension", ins.state?.channel === "extension", ins.state?.channel);

  const st2 = await fetch(`${base}/api/status?home=${encodeURIComponent(home)}`).then((r) => r.json());
  check("重复查询仍为 extension", st2.channel === "extension", st2.channel);
  check("层数与注入一致", st2.layers.length >= 5, `got ${st2.layers?.length}`);

  console.log("\n预览路由");
  const pv = await fetch(`${base}/api/preview`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ctxfold-token": token },
    body: JSON.stringify({ home, text: "帮我逆向这个 apk 脱壳" }),
  }).then((r) => r.json());
  check("preview 返回正文", pv.ok && pv.head.length > 500, String(pv.chars));
  check("识别出逆向族", pv.family === "re", pv.family);
  check("只保留相关层", pv.kept.includes("route.re") && !pv.kept.includes("web"), pv.kept.join(","));

  console.log("\n卸载");
  const un = await fetch(`${base}/api/uninstall`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ctxfold-token": token },
    body: JSON.stringify({ home }),
  }).then((r) => r.json());
  check("uninstall 成功", un.ok === true);
  check("扩展已移除", !fs.existsSync(path.join(home, "extensions", "ctxfold")));
  check("通道回到 none", un.state?.channel === "none", un.state?.channel);
} finally {
  await srv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "\x1b[32m全部通过" : "\x1b[31m有失败"}：${pass} 通过 / ${fail} 失败\x1b[0m`);
process.exitCode = fail === 0 ? 0 : 1;
