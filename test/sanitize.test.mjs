/**
 * 清洗功能测试：备份 → 清空 → 接管 → 还原。
 *
 * 全部在临时目录里跑，不碰真实 ~/.pi/agent。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  sanitize,
  restore,
  listAgentFiles,
  readSanitizeState,
  readExtensionConfig,
  setOverride,
} from "../lib/sanitize.js";

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctxfold-clean-"));
const home = path.join(tmp, ".pi", "agent");
fs.mkdirSync(home, { recursive: true });

const ORIGINAL = [
  "# 我自己的规矩",
  "",
  "永远用中文回答。",
  "不要动 git。",
  "",
  "<!-- ctxfold:begin mode=full -->",
  "<ctxfold>旧注入</ctxfold>",
  "<!-- ctxfold:end -->",
  "",
].join("\n");

const agentsPath = path.join(home, "AGENTS.md");
fs.writeFileSync(agentsPath, ORIGINAL, "utf8");

console.log("\n列出指令文件");
const listed = listAgentFiles(home, tmp);
check("找到全局 AGENTS.md", listed.some((f) => f.path === agentsPath), JSON.stringify(listed.map((f) => f.path)));
const globalEntry = listed.find((f) => f.path === agentsPath);
check("识别出区块外的用户内容", globalEntry.outsideChars > 0, String(globalEntry.outsideChars));
check("识别出已有区块", globalEntry.hasBlock === true);

console.log("\n预演不写盘");
const preview = sanitize({ home, cwd: tmp, dryRun: true, override: true });
check("预演报告会改动", preview.files.some((f) => f.changed));
check("预演没改文件", fs.readFileSync(agentsPath, "utf8") === ORIGINAL);
check("预演没开接管", readExtensionConfig(home).override !== true);

console.log("\n正式清洗");
const result = sanitize({ home, cwd: tmp, project: false, override: true });
const after = fs.readFileSync(agentsPath, "utf8");
check("用户原文已清除", !after.includes("永远用中文回答"));
check("保留了 ctxfold 区块", after.includes("ctxfold:begin") && after.includes("ctxfold:end"));
check("备份已落盘", result.files.some((f) => f.backup && fs.existsSync(f.backup)));
const backupFile = result.files.find((f) => f.backup)?.backup;
check("备份内容等于原文", backupFile ? fs.readFileSync(backupFile, "utf8") === ORIGINAL : false);
check("打开了完全接管", readExtensionConfig(home).override === true, JSON.stringify(readExtensionConfig(home)));
check("写了清洗记录", Boolean(readSanitizeState(home).at));
check("记录里有备份路径", (readSanitizeState(home).files || []).some((f) => f.backup === backupFile));

console.log("\n重复清洗不覆盖首次备份");
const firstBackup = backupFile;
const again = sanitize({ home, cwd: tmp, override: true });
check("第二次报告无需改动", again.files.every((f) => !f.changed) || fs.readFileSync(agentsPath, "utf8") === after);
check("首次备份仍在", Boolean(firstBackup && fs.existsSync(firstBackup)));
check("备份内容仍是原始全文", firstBackup ? fs.readFileSync(firstBackup, "utf8") === ORIGINAL : false);

console.log("\n还原");
const rest = restore({ home });
check("还原成功", rest.restored.some((f) => f.ok));
check("内容与原文一致", fs.readFileSync(agentsPath, "utf8") === ORIGINAL);
check("清洗记录已清空", !fs.existsSync(path.join(home, ".ctxfold", "sanitize.json")));

console.log("\n不改接管开关 / 连区块一起清");
fs.writeFileSync(agentsPath, ORIGINAL, "utf8");
setOverride(home, false);
const noOverride = sanitize({ home, cwd: tmp, override: false });
check("--no-override 时开关仍为关", readExtensionConfig(home).override === false);
check("文件依旧被清洗", noOverride.files.some((f) => f.changed));
restore({ home });

fs.writeFileSync(agentsPath, ORIGINAL, "utf8");
sanitize({ home, cwd: tmp, keepBlock: false, override: false });
check("keepBlock=false 时区块也被清", fs.readFileSync(agentsPath, "utf8").trim() === "");
restore({ home });
check("还原回原文", fs.readFileSync(agentsPath, "utf8") === ORIGINAL);

console.log("\nconfig 带 BOM 也要读得出来");
const cfgFile = path.join(home, "extensions", "ctxfold", "config.json");
fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
fs.writeFileSync(cfgFile, `\ufeff${JSON.stringify({ enabled: true, override: true })}`, "utf8");
check("readExtensionConfig 剥掉 BOM", readExtensionConfig(home).override === true, JSON.stringify(readExtensionConfig(home)));
setOverride(home, false);
check("setOverride 写出来不带 BOM", fs.readFileSync(cfgFile, "utf8").charCodeAt(0) !== 0xfeff);
check("setOverride 关得掉", readExtensionConfig(home).override === false);

console.log("\n项目目录");const proj = path.join(tmp, "proj");
fs.mkdirSync(proj, { recursive: true });
const projAgents = path.join(proj, "AGENTS.md");
fs.writeFileSync(projAgents, "# 项目规矩\n只准用 tabs\n", "utf8");
const projList = listAgentFiles(home, proj);
check("列出项目 AGENTS.md", projList.some((f) => f.path === projAgents && f.scope === "项目"));
const noProj = sanitize({ home, cwd: proj, project: false, override: false });
check("默认不清项目文件", !noProj.files.some((f) => f.path === projAgents));
const withProj = sanitize({ home, cwd: proj, project: true, override: false });
check("--project 时清项目文件", withProj.files.some((f) => f.path === projAgents && f.changed));
check("项目原文进了备份", fs.readFileSync(projAgents, "utf8").trim() === "");
restore({ home });
check("项目文件已还原", fs.readFileSync(projAgents, "utf8").includes("只准用 tabs"));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "\x1b[32m全部通过" : "\x1b[31m有失败"}：${pass} 通过 / ${fail} 失败\x1b[0m`);
process.exitCode = fail === 0 ? 0 : 1;
