/**
 * dist 补丁引擎测试。全部在临时 home 上跑，不碰真实 Pi 安装。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { inspect, apply, revert, cleanBaks, resolveRelease, readState } from "../lib/dist-patch.js";
import { DIST_PATCHES, NOT_PATCHED } from "../patches/manifest.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0;
let fail = 0;

function ok(name, cond, extra = "") {
  if (cond) {
    pass += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}${extra ? ` ${extra}` : ""}`);
  }
}

function eq(name, actual, expected) {
  ok(name, actual === expected, `(实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)})`);
}

/** 建一个假 home，铺出 Pi 的目录形状，文件内容用真实 dist 的片段裁出来。 */
function makeFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ctxfold-dist-"));
  const api = path.join(home, "install", "releases", "1.0.4", "node_modules", "@earendil-works", "pi-ai", "dist", "api");
  fs.mkdirSync(api, { recursive: true });

  fs.writeFileSync(
    path.join(api, "openai-completions.js"),
    [
      "function buildParams() {",
      '    if (model.provider === "openai") return id;',
      '    const instructionRole = model.reasoning && compat.supportsDeveloperRole ? "developer" : "system";',
      "}",
      "",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(api, "openai-responses-shared.js"),
    [
      "function buildResponses() {",
      '    const instructionRole = model.reasoning && compat?.supportsDeveloperRole !== false ? "developer" : "system";',
      "}",
      "",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(api, "anthropic-messages.js"),
    [
      'import { getPiUserAgent } from "../utils/pi-user-agent.js";',
      "const claudeCodeVersion = \"2.1.280\";",
      "function createClient() {",
      "    return make({",
      "        defaultHeaders: mergeClientHeaders({",
      '                "user-agent": `claude-cli/${claudeCodeVersion}`,',
      '            "x-app": "cli",',
      "        }),",
      "    });",
      "}",
      "function buildParams() {",
      "    // For OAuth tokens, we MUST include Claude Code identity",
      "    if (isOAuthToken) {",
      "        params.system = [{",
      '            text: "You are Claude Code, Anthropic\'s official CLI for Claude.",',
      "        }];",
      "    }",
      "    else if (initialSystemText) {",
      "        params.system = [{ text: initialSystemText }];",
      "    }",
      "}",
      "",
    ].join("\n"),
  );

  // bundle 里的重复副本，引擎应一并处理
  const chunk = path.join(home, "install", "releases", "1.0.4", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "chunks");
  fs.mkdirSync(chunk, { recursive: true });
  fs.writeFileSync(
    path.join(chunk, "openai-completions-OSRCWAAA.js"),
    'var x = 1;\n    const instructionRole = model.reasoning && compat.supportsDeveloperRole ? "developer" : "system";\n',
  );

  return home;
}

function cleanup(home) {
  try {
    fs.rmSync(home, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
}

async function main() {
  console.log("\ndist 补丁引擎\n");

  // ---- 清单本身 ----
  eq("清单有 3 条 dist 补丁", DIST_PATCHES.length, 3);
  eq("另外 2 条记录为不补", NOT_PATCHED.length, 2);
  ok(
    "每条补丁都有 marker",
    DIST_PATCHES.every((p) => typeof p.marker === "string" && p.marker.length > 3),
  );
  ok(
    "marker 各不相同",
    new Set(DIST_PATCHES.map((p) => p.marker)).size === DIST_PATCHES.length,
  );
  ok(
    "每条 replace 都带自己的 marker",
    DIST_PATCHES.every((p) => p.targets.every((t) => t.replace.includes(p.marker))),
  );
  ok(
    "find 与 replace 不相等",
    DIST_PATCHES.every((p) => p.targets.every((t) => t.find !== t.replace)),
  );
  eq("上游编号覆盖 57/49/47", DIST_PATCHES.map((p) => p.upstreamId).sort((a, b) => a - b).join(","), "47,49,57");

  // ---- 没有安装目录 ----
  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ctxfold-nodist-"));
    const info = inspect(home);
    ok("无安装目录时 inspect 返回失败", info.ok === false);
    ok("失败原因说明清楚", /找不到 Pi 安装目录/.test(info.reason || ""));
    ok("无安装目录时 apply 也失败", apply(home).ok === false);
    cleanup(home);
  }

  // ---- 正式流程 ----
  const home = makeFixture();
  try {
    const release = resolveRelease(home);
    eq("能定位 release", release && release.version, "1.0.4");
    ok("release 指向 node_modules", /node_modules$/.test(release.nodeModules));

    // 打之前
    let info = inspect(home);
    eq("三条都处于可打状态", info.patches.filter((p) => p.state === "pending").length, 3);
    eq("没有已打状态", info.patches.filter((p) => p.state === "applied").length, 0);
    ok("未变更版本", info.versionChanged === false);
    ok("读到两条不补的记录", info.notPatched.length === 2);

    // 只打 57
    const r57 = apply(home, { ids: ["DEEPSEEK_SYSTEM_ROLE"] });
    ok("apply 57 成功", r57.ok === true);
    const e57 = r57.results.find((r) => r.id === "DEEPSEEK_SYSTEM_ROLE");
    eq("57 改了 3 个文件（2 声明 + 1 bundle 副本）", e57.files.length, 3);
    eq("57 无错误", e57.errors.length, 0);
    ok("备份已生成", fs.existsSync(path.join(release.nodeModules, "@earendil-works", "pi-ai", "dist", "api", "openai-completions.js.ctxfold.bak")));

    // 内容正确性
    const completions = fs.readFileSync(path.join(release.nodeModules, "@earendil-works", "pi-ai", "dist", "api", "openai-completions.js"), "utf8");
    ok("57 加了 provider 白名单", completions.includes("/^(openai|azure)/.test(String(model.provider))"));
    ok("57 打了 marker", completions.includes("[ctxfold:57]"));
    ok("57 原逻辑已不在", !completions.includes('compat.supportsDeveloperRole ? "developer"'));
    ok("57 保留了同文件的其它代码", completions.includes('if (model.provider === "openai") return id;'));

    const responses = fs.readFileSync(path.join(release.nodeModules, "@earendil-works", "pi-ai", "dist", "api", "openai-responses-shared.js"), "utf8");
    ok("57 也改了 responses 分支", responses.includes("/^(openai|azure)/.test(String(model.provider))"));
    ok("57 保留了 !== false 的原始语义", responses.includes("compat?.supportsDeveloperRole !== false"));

    // 状态更新
    info = inspect(home);
    eq("57 变成已打", info.patches.find((p) => p.id === "DEEPSEEK_SYSTEM_ROLE").state, "applied");
    eq("剩下两条仍可打", info.patches.filter((p) => p.state === "pending").length, 2);
    eq("状态文件记了版本", readState(home).piVersion, "1.0.4");

    // 幂等
    const again = apply(home, { ids: ["DEEPSEEK_SYSTEM_ROLE"] });
    const againEntry = again.results.find((r) => r.id === "DEEPSEEK_SYSTEM_ROLE");
    eq("重复 apply 不再改文件", againEntry.files.length, 0);
    ok("重复 apply 明确说已在位", againEntry.skipped.some((s) => /已在位/.test(s)));
    ok("重复 apply 不报错", againEntry.errors.length === 0);

    // 打 47 + 49
    const rest = apply(home, { ids: ["ANTHROPIC_OAUTH_CLI_NEUTRAL", "ANTHROPIC_OAUTH_NO_CLAUDE_IDENTITY"] });
    ok("打完 47/49 成功", rest.ok === true);
    const anth = fs.readFileSync(path.join(release.nodeModules, "@earendil-works", "pi-ai", "dist", "api", "anthropic-messages.js"), "utf8");
    ok("49 换成 getPiUserAgent", anth.includes("getPiUserAgent(), // [ctxfold:49]"));
    ok("49 保留 env 逃生口", anth.includes('CTXFOLD_CLAUDE_UA === "1"'));
    ok("49 原 claude-cli UA 不再直接出现", !anth.includes('"user-agent": `claude-cli/'));
    ok("47 的 if 加了条件", anth.includes('if (isOAuthToken && process.env.CTXFOLD_CLAUDE_IDENTITY === "1")'));
    ok("47 打了 marker", anth.includes("[ctxfold:47]"));
    ok("47 没删掉 else 分支", anth.includes("else if (initialSystemText)"));
    ok("47 原身份文案还在（可恢复）", anth.includes("You are Claude Code"));

    // 语法有效性：改完的 JS 必须能被解析
    for (const file of ["openai-completions.js", "openai-responses-shared.js", "anthropic-messages.js"]) {
      const abs = path.join(release.nodeModules, "@earendil-works", "pi-ai", "dist", "api", file);
      const src = fs.readFileSync(abs, "utf8");
      // 语法检查用 Function 包裹，先摘掉 ESM import 行（Function 不认 import）
      const body = src
        .split("\n")
        .filter((line) => !/^\s*import\s/.test(line))
        .join("\n");
      let okSyntax = true;
      try {
        new Function(`return () => { ${body} }`);
      } catch (error) {
        okSyntax = false;
        ok(`补丁后语法有效 ${file}`, false, error.message);
      }
      if (okSyntax) ok(`补丁后语法有效 ${file}`, true);
    }

    // 全打完之后
    info = inspect(home);
    eq("三条全部已打", info.patches.filter((p) => p.state === "applied").length, 3);

    // revert 全部
    const rv = revert(home);
    ok("revert 成功", rv.ok === true);
    eq("revert 恢复了 4 个文件", rv.restored.length, 4);
    eq("revert 没有缺备份", rv.missing.length, 0);
    ok("备份已清掉", !fs.existsSync(path.join(release.nodeModules, "@earendil-works", "pi-ai", "dist", "api", "openai-completions.js.ctxfold.bak")));

    const back = fs.readFileSync(path.join(release.nodeModules, "@earendil-works", "pi-ai", "dist", "api", "openai-completions.js"), "utf8");
    ok("原文恢复", back.includes('compat.supportsDeveloperRole ? "developer"'));
    ok("marker 已消失", !back.includes("[ctxfold:57]"));

    info = inspect(home);
    eq("revert 后回到可打", info.patches.filter((p) => p.state === "pending").length, 3);

    // 版本变化守卫
    const state = readState(home);
    state.piVersion = "0.9.0";
    fs.writeFileSync(path.join(home, ".ctxfold", "dist-state.json"), JSON.stringify(state), "utf8");
    const guarded = apply(home, { ids: ["DEEPSEEK_SYSTEM_ROLE"] });
    ok("版本变化时拒绝直接打", guarded.ok === false);
    ok("拒绝理由提到 --force", /--force/.test(guarded.reason || ""));
    ok("inspect 报告版本变化", inspect(home).versionChanged === true);
    const forced = apply(home, { ids: ["DEEPSEEK_SYSTEM_ROLE"], force: true });
    ok("--force 可以重打", forced.ok === true);
    ok("重打后不再报版本变化", inspect(home).versionChanged === false);
    revert(home, { ids: ["DEEPSEEK_SYSTEM_ROLE"] });

    // clean 残留
    const bakFile = path.join(release.nodeModules, "@earendil-works", "pi-ai", "dist", "api", "openai-completions.js.ctxfold.bak");
    fs.writeFileSync(bakFile, "junk", "utf8");
    const cleaned = cleanBaks(home);
    eq("clean 清掉残留", cleaned.removed.length, 1);
    ok("残留文件已删", !fs.existsSync(bakFile));
  } finally {
    cleanup(home);
  }

  console.log(`\n${fail === 0 ? "\x1b[32m全部通过" : "\x1b[31m有失败"}：${pass} 通过 / ${fail} 失败\x1b[0m\n`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
