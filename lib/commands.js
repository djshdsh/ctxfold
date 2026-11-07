/**
 * CLI 实现。无依赖，自带参数解析与输出格式化。
 */

import fs from "node:fs";
import path from "node:path";
import {
  apply,
  revert,
  status,
  doctor,
  uninstall,
  render,
  analyzeLayers,
  routePreview,
  skills,
} from "./index.js";
import { loadAllLayers, userLayersDir } from "./compose.js";
import { loadRules, setRule, addRule, removeRule } from "./rules.js";
import { resolveHome, presetLayersDir, extensionsDir } from "./paths.js";
import { listBackups } from "./backup.js";
import { install, uninstallInstalled, inspectInstall } from "./install.js";
import { inspect as inspectDist, apply as applyDist, revert as revertDist, cleanBaks } from "./dist-patch.js";
import { sanitize, restore, listAgentFiles, readSanitizeState, readExtensionConfig } from "./sanitize.js";

const USE_COLOR = process.stdout.isTTY && !process.env.NO_COLOR;

const paint = (code) => (s) => (USE_COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = paint("1");
const dim = paint("2");
const green = paint("32");
const red = paint("31");
const yellow = paint("33");
const cyan = paint("36");

const mark = (ok) => (ok ? green("✓") : red("✗"));

function heading(text) {
  return `\n${bold(text)}`;
}

function kv(key, value, width = 14) {
  return `  ${dim(key.padEnd(width))} ${value}`;
}

function pad(s, n) {
  const str = String(s);
  const len = [...str].reduce((acc, ch) => acc + (ch.codePointAt(0) > 0x2e80 ? 2 : 1), 0);
  return str + " ".repeat(Math.max(0, n - len));
}

/** 极简参数解析：--flag、--key value、--key=value、位置参数。 */
export function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const body = token.slice(2);
      if (body.includes("=")) {
        const [k, ...rest] = body.split("=");
        flags[k] = rest.join("=");
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          flags[body] = next;
          i += 1;
        } else {
          flags[body] = true;
        }
      }
    } else if (token.startsWith("-") && token.length > 1) {
      for (const ch of token.slice(1)) flags[ch] = true;
    } else {
      positionals.push(token);
    }
  }
  return { positionals, flags };
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

function splitList(value) {
  if (value === undefined || value === null || value === true) return undefined;
  return String(value)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// ── 各命令 ────────────────────────────────────────────────────────────

function cmdApply(flags, home) {
  const mode = flags.mode || (flags.text ? "auto" : "full");
  return apply({
    home,
    mode,
    text: typeof flags.text === "string" ? flags.text : "",
    layers: splitList(flags.layers),
    position: flags.position === "top" ? "top" : "bottom",
    skills: flags["no-skills"] ? false : true,
    dryRun: Boolean(flags["dry-run"]),
    out: typeof flags.out === "string" ? flags.out : undefined,
  });
}

function formatApply(result) {
  const lines = [];
  lines.push(heading(result.dryRun ? "预演（未写盘）" : "已应用"));
  lines.push(kv("目标", result.file));
  lines.push(kv("模式", `${result.mode}${result.mode === "auto" ? `（${result.familyLabel}）` : ""}`));
  lines.push(kv("层", result.kept.join(", ")));
  lines.push(kv("体量", `${result.chars} 字符 / ~${result.tokens} token`));
  lines.push(kv("指纹", result.hash));
  if (result.backup) lines.push(kv("备份", result.backup));
  if (result.skills && result.skills.length) {
    lines.push(kv("技能", result.skills.map((s) => `${s.pack}（${s.files} 文件）`).join(", ")));
  }
  if (result.skillsError) lines.push(kv("技能", yellow(`同步失败：${result.skillsError}`)));
  if (result.renderedFile) lines.push(kv("预演写入", result.renderedFile));
  if (!result.dryRun) {
    lines.push("");
    lines.push(dim("  撤销：ctxfold revert"));
  }
  return lines.join("\n");
}

function cmdRevert(flags, home) {
  const result = revert({
    home,
    hard: Boolean(flags.hard),
    skills: Boolean(flags.skills),
  });
  const lines = [heading("已撤销")];
  lines.push(kv("目标", result.file));
  lines.push(kv("方式", result.mode === "hard" ? "从备份整份还原" : "只摘注入区块"));
  lines.push(kv("区块", result.removedBlock ? "已移除" : "本来就不存在"));
  if (result.backup) lines.push(kv("备份", result.backup));
  if (result.restoredFrom) lines.push(kv("还原自", result.restoredFrom));
  if (result.skills) {
    lines.push(kv("技能", result.skills.removed.length ? `已卸载 ${result.skills.removed.join(", ")}` : "无受管技能"));
  }
  if (result.note) lines.push(kv("说明", result.note));
  return lines.join("\n");
}

function cmdStatus(flags, home) {
  const s = status({ home });
  const extFile = path.join(extensionsDir(home), "ctxfold", "index.ts");
  const extInstalled = fs.existsSync(extFile);
  const lines = [];
  lines.push(heading("ctxfold 状态"));
  lines.push(kv("主目录", s.home));
  // 两条通道分开报，不要用一句话糊过去：扩展在跑 ≠ AGENTS.md 写了区块
  if (extInstalled) {
    lines.push(kv("注入通道", green("扩展 · 每轮动态裁剪")));
  } else if (s.applied) {
    lines.push(kv("注入通道", green("AGENTS.md 静态区块")));
  } else {
    lines.push(kv("注入通道", red("没有 · 运行 ctxfold install")));
  }
  lines.push(kv("扩展文件", extInstalled ? extFile : dim("（未装）")));
  lines.push(kv("AGENTS.md", s.fileExists ? s.file : dim("（不存在）")));
  lines.push(kv("静态区块", s.applied ? green("已写入") : dim("未写入（用扩展时不需要）")));
  if (s.applied) {
    lines.push(kv("模式", s.mode || dim("未知")));
    lines.push(kv("层", s.layers.length ? s.layers.join(", ") : dim("未知")));
    lines.push(kv("体量", s.summary));
    lines.push(kv("安装于", s.appliedAt || dim("未知")));
    lines.push(kv("指纹", s.drifted ? yellow(`${s.hash}（与记录不一致）`) : s.hash));
  }
  lines.push(kv("用户自有", `${s.userContentChars} 字符（区块外内容，不受影响）`));
  // override 决定扩展是「只追加」还是「整条替换」，这是用户最需要确认的一件事
  {
    const cfg = readExtensionConfig(home);
    lines.push(
      kv(
        "提示词接管",
        cfg.override
          ? green("完全接管（Pi 内置提示词与 AGENTS.md 都不再注入）")
          : dim("追加（Pi 自己的提示词还在，可与原提示词共存）"),
      ),
    );
    lines.push(
      kv(
        "清洗记录",
        fs.existsSync(path.join(home, ".ctxfold", "sanitize.json"))
          ? yellow("有（ctxfold restore 可还原）")
          : dim("无"),
      ),
    );
  }
  lines.push(kv("规则", `${s.rules.enabled}/${s.rules.total} 启用`));
  lines.push(kv("备份", `${s.backups} 份`));

  lines.push(heading("技能"));
  if (!s.skills.length) {
    lines.push(kv("", dim("暂无。运行 ctxfold skills sync")));
  } else {
    for (const item of s.skills) {
      const tag = item.managed ? cyan("受管") : dim("用户");
      lines.push(kv("", `${pad(item.pack, 22)} ${pad(`${item.files} 文件`, 10)} ${tag}`));
    }
  }
  return lines.join("\n");
}

function cmdDoctor(flags, home) {
  const d = doctor({ home });
  const lines = [heading("环境自检")];
  for (const c of d.checks) {
    lines.push(`  ${mark(c.ok)} ${pad(c.id, 14)} ${dim(c.detail)}`);
  }
  lines.push("");
  lines.push(d.ok ? green("  全部通过") : yellow("  有项目未通过，按上面提示处理"));
  return lines.join("\n");
}

function cmdRender(flags, home) {
  const mode = flags.mode || (flags.text ? "auto" : "full");
  const result = render({ home, mode, text: typeof flags.text === "string" ? flags.text : "", layers: splitList(flags.layers) });
  if (flags.out) {
    fs.writeFileSync(path.resolve(String(flags.out)), result.text, "utf8");
    return `${green("已写")} ${path.resolve(String(flags.out))}`;
  }
  if (flags.stats) {
    return [`层：${result.kept.join(", ")}`, `任务族：${result.familyLabel}`, `字符：${result.text.length}`].join("\n");
  }
  return result.text;
}

function cmdAnalyze(flags, home) {
  const r = analyzeLayers({ home });
  const lines = [heading("分层体量")];
  for (const row of r.rows) {
    const pct = `${(row.share * 100).toFixed(1)}%`.padStart(6);
    lines.push(`  ${pad(row.name, 12)} ${pad(`${row.chars}`, 8)} ${pad(`~${row.tokens}`, 9)} ${pct}  ${dim(row.bar || "")}`);
  }
  lines.push("");
  lines.push(kv("合计", `${r.totalChars} 字符 / ~${r.totalTokens} token`));
  return lines.join("\n");
}

function cmdLayers(positionals, flags, home) {
  const sub = positionals[0] || "list";
  const layers = loadAllLayers(home);

  if (sub === "list") {
    const lines = [heading("可用层")];
    const userDir = userLayersDir(home);
    for (const l of layers) {
      const own = fs.existsSync(path.join(userDir, `${l.name}.md`)) ? cyan("用户") : dim("预设");
      lines.push(`  ${pad(l.name, 14)} ${pad(`${l.chars}`, 7)} ${own}`);
    }
    lines.push("");
    lines.push(kv("预设目录", presetLayersDir()));
    lines.push(kv("用户覆盖", userDir));
    return lines.join("\n");
  }

  if (sub === "show") {
    const name = positionals[1];
    const hit = layers.find((l) => l.name === name);
    if (!hit) throw new Error(`没有层：${name}（可用：${layers.map((l) => l.name).join(", ")}）`);
    return hit.text;
  }

  if (sub === "path") {
    const name = positionals[1];
    const userFile = path.join(userLayersDir(home), `${name}.md`);
    if (fs.existsSync(userFile)) return userFile;
    const preset = path.join(presetLayersDir(), `${name}.md`);
    if (fs.existsSync(preset)) return preset;
    throw new Error(`没有层：${name}`);
  }

  if (sub === "fork") {
    const name = positionals[1];
    if (!name) throw new Error("用法：ctxfold layers fork <layer>");
    const preset = path.join(presetLayersDir(), `${name}.md`);
    if (!fs.existsSync(preset)) throw new Error(`预设里没有层：${name}`);
    const dir = userLayersDir(home);
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `${name}.md`);
    if (fs.existsSync(dest) && !flags.force) throw new Error(`用户层已存在：${dest}（加 --force 覆盖）`);
    fs.writeFileSync(dest, fs.readFileSync(preset, "utf8"), "utf8");
    return `${green("已复制")} ${dest}\n${dim("  改这个文件即可覆盖预设层，不影响包内原件。")}`;
  }

  throw new Error(`未知子命令：layers ${sub}`);
}

function cmdRules(positionals, flags, home) {
  const sub = positionals[0] || "list";

  if (sub === "list") {
    const rules = loadRules(home);
    const lines = [heading("规则集")];
    if (!rules.length) return lines.concat(kv("", dim("没有规则"))).join("\n");
    for (const r of rules) {
      const state = r.enabled ? green("on ") : dim("off");
      const tag = r.custom ? cyan("自定义") : dim("预设  ");
      lines.push(`  ${state} ${pad(r.id, 22)} ${pad(r.label, 24)} ${tag}`);
    }
    lines.push("");
    lines.push(dim("  ctxfold rules on|off <id>"));
    return lines.join("\n");
  }

  if (sub === "on" || sub === "off") {
    const id = positionals[1];
    if (!id) throw new Error(`用法：ctxfold rules ${sub} <id>`);
    const rules = loadRules(home);
    if (!rules.some((r) => r.id === id)) throw new Error(`没有规则：${id}`);
    setRule(home, id, sub === "on");
    return `${green("已设置")} ${id} = ${sub === "on" ? "on" : "off"}\n${dim("  重新 apply 后生效：ctxfold apply")}`;
  }

  if (sub === "show") {
    const id = positionals[1];
    const hit = loadRules(home).find((r) => r.id === id);
    if (!hit) throw new Error(`没有规则：${id}`);
    return [`# ${hit.id} — ${hit.label}`, `层：${hit.layer}`, `状态：${hit.enabled ? "on" : "off"}`, "", hit.body].join("\n");
  }

  if (sub === "add") {
    const id = flags.id || positionals[1];
    const label = flags.label || id;
    let body = typeof flags.body === "string" ? flags.body : "";
    if (!body && flags.file) body = fs.readFileSync(path.resolve(String(flags.file)), "utf8").trim();
    if (!id || !body) throw new Error("用法：ctxfold rules add --id <id> --label <标签> --body <正文> | --file <路径>");
    const entry = addRule(home, { id, label, body });
    return `${green("已添加")} ${entry.id}\n${dim("  重新 apply 后生效")}`;
  }

  if (sub === "rm") {
    const id = positionals[1];
    if (!id) throw new Error("用法：ctxfold rules rm <id>");
    const left = removeRule(home, id);
    return `${green("已删除")} ${id}（剩余自定义 ${left} 条）`;
  }

  throw new Error(`未知子命令：rules ${sub}`);
}

async function cmdRoute(flags, home) {
  let text = typeof flags.text === "string" ? flags.text : "";
  if (!text) text = (await readStdin()).trim();
  if (!text) throw new Error('用法：ctxfold route --text "任务描述" 或从 stdin 传入');
  const r = routePreview(home, text);
  const lines = [heading(`任务族：${r.label}（${r.family}）`)];
  lines.push(kv("保留", r.kept.join(", ") || dim("无")));
  lines.push(kv("裁掉", r.dropped.length ? yellow(r.dropped.join(", ")) : dim("无")));
  lines.push(kv("注入体量", `${r.text.length} 字符`));
  if (flags.verbose) {
    lines.push("");
    lines.push(r.text);
  }
  return lines.join("\n");
}

function cmdSkills(positionals, flags, home) {
  const sub = positionals[0] || "list";

  if (sub === "list") {
    const packs = skills.availablePacks();
    const installed = skills.listInstalled(home);
    const lines = [heading("技能包")];
    for (const pack of packs) {
      const hit = installed.find((i) => i.pack === pack);
      const state = hit ? green("已装") : dim("未装");
      lines.push(`  ${state} ${pad(pack, 22)} ${hit ? dim(`${hit.files} 文件`) : ""}`);
    }
    const extra = installed.filter((i) => !packs.includes(i.pack));
    if (extra.length) {
      lines.push("");
      lines.push(dim("  非本包管理（不会被动）"));
      for (const e of extra) lines.push(`  ${dim("·")} ${pad(e.pack, 22)} ${dim(`${e.files} 文件`)}`);
    }
    return lines.join("\n");
  }

  if (sub === "sync") {
    const targets = positionals.slice(1);
    const results = targets.length ? targets.map((p) => skills.syncPack(home, p)) : skills.syncAll(home);
    const lines = [heading("已同步")];
    for (const r of results) lines.push(kv(r.pack, `${r.files} 文件 → ${r.dest}`));
    return lines.join("\n");
  }

  if (sub === "clean") {
    const targets = positionals.slice(1);
    const r = skills.cleanPacks(home, targets);
    const lines = [heading("已清理")];
    lines.push(kv("删除", r.removed.length ? r.removed.join(", ") : dim("无")));
    if (r.skipped.length) lines.push(kv("跳过", `${r.skipped.join(", ")}（非受管）`));
    return lines.join("\n");
  }

  throw new Error(`未知子命令：skills ${sub}`);
}

function cmdBackups(flags, home) {
  const list = listBackups(home, "agents", "AGENTS.md");
  if (!list.length) return dim("没有备份");
  return [heading(`备份（${list.length}）`), ...list.map((p) => `  ${p}`)].join("\n");
}

function cmdSanitize(flags, home) {
  if (flags.restore) {
    const r = restore({ home, dryRun: Boolean(flags["dry-run"]) });
    if (flags.json) return r;
    if (!r.restored.length) return dim("没有清洗记录，无需还原");
    const lines = [heading(flags["dry-run"] ? "将还原（预演）" : "已还原")];
    for (const f of r.restored) {
      const mark = f.ok ? green("✓") : red("✗");
      lines.push(`  ${mark} ${f.path}  ${f.ok ? `${f.chars} 字符` : f.reason}`);
    }
    return lines.join("\n");
  }

  const r = sanitize({
    home,
    cwd: flags.cwd ? String(flags.cwd) : process.cwd(),
    project: Boolean(flags.project || flags.all),
    dryRun: Boolean(flags["dry-run"]),
    keepBlock: !flags["no-keep-block"],
    override: !flags["no-override"],
  });

  if (flags.json) return r;

  const lines = [heading(r.dryRun ? "清洗（预演，未写盘）" : "清洗完成")];
  lines.push(kv("主目录", r.home));

  if (!r.files.length) {
    lines.push(kv("指令文件", "没找到 AGENTS.md"));
  } else {
    for (const f of r.files) {
      if (!f.changed) {
        lines.push(kv(f.scope, `${f.path}（本来就干净，跳过）`));
        continue;
      }
      lines.push(kv(f.scope, `${f.path}  ${f.before} → ${f.after} 字符`));
      if (f.backup) lines.push(kv("  备份", f.backup));
    }
  }

  if (r.override) {
    lines.push(kv("接管", "已打开 override —— Pi 内置系统提示词也被换掉"));
  } else if (flags["no-override"]) {
    lines.push(kv("接管", "未打开（仍是追加模式，Pi 自己的提示词还在）"));
  }

  if (r.dryRun) lines.push("", dim("去掉 --dry-run 真正执行"));
  else lines.push("", dim("还原：ctxfold restore"));
  return lines.join("\n");
}

function cmdUninstall(flags, home) {
  const r = uninstall({ home });
  const extra = uninstallInstalled(home);
  const lines = [heading("已卸载")];
  lines.push(kv("注入", r.removedBlock ? "已移除" : "本来就不存在"));
  if (r.skills) lines.push(kv("技能", r.skills.removed.length ? r.skills.removed.join(", ") : "无受管技能"));
  if (extra.removed.length) lines.push(kv("扩展", extra.removed.join(", ")));
  for (const kept of extra.kept) lines.push(kv("保留", `${kept.target}（${kept.reason}）`));
  lines.push(kv("状态", "已清空"));
  return lines.join("\n");
}

function cmdInstall(flags, home) {
  const force = Boolean(flags.force || flags.f);
  const result = install({
    home,
    force,
    skill: !flags["no-skill"],
    extension: !flags["no-extension"],
  });

  if (flags.json) return result;

  const lines = [heading("安装到 Pi Agent")];
  lines.push(kv("主目录", result.home));
  lines.push(kv("扩展", result.extensionDir || "跳过"));
  lines.push(kv("技能", result.skillDir || "跳过"));
  lines.push(kv("用户层", result.userLayersDir || "跳过"));
  lines.push(kv("写入", `${result.copied.length} 个文件`));
  if (result.skipped.length) {
    lines.push(kv("已存在", `${result.skipped.length} 个（加 --force 覆盖）`));
    for (const file of result.skipped.slice(0, 6)) lines.push(`    ${dim(file)}`);
    if (result.skipped.length > 6) lines.push(`    ${dim(`…还有 ${result.skipped.length - 6} 个`)}`);
  }
  if (result.missing.length) {
    lines.push(kv("缺源", result.missing.join(", ")));
  }
  if (result.backup.dir) {
    lines.push(kv("备份", result.backup.dir));
  }

  const verify = inspectInstall(home);
  lines.push(heading("自检"));
  lines.push(
    `  ${mark(verify.extension.entryExists)} 扩展入口  ${verify.extension.entry}${
      verify.extension.entryExists ? dim(` (${verify.extension.entryBytes} B)`) : ""
    }`,
  );
  lines.push(`  ${mark(verify.extension.layers.length > 0)} 扩展层    ${verify.extension.layers.join(", ") || "无"}`);
  lines.push(`  ${mark(verify.extension.rulesExists)} 规则集    ${verify.extension.rulesExists ? "已就位" : "缺失"}`);
  lines.push(`  ${mark(verify.userLayers.layers.length > 0)} 用户层    ${verify.userLayers.layers.join(", ") || "无"}`);
  lines.push(`  ${mark(verify.skill.exists)} 技能      ${verify.skill.exists ? verify.skill.file : "缺失"}`);
  lines.push("");
  lines.push(dim("  扩展在下次启动 Pi 时加载；改层后无需重装，扩展每轮重新读盘。"));
  return lines.join("\n");
}

function cmdVerify(flags, home) {
  const v = inspectInstall(home);
  if (flags.json) return v;

  const lines = [heading("Pi 加载面自检")];
  lines.push(kv("主目录", v.home));
  lines.push(kv("扩展目录", `${v.extension.dirExists ? "✓" : "✗"} ${v.extension.dir}`));
  lines.push(
    kv("入口文件", `${v.extension.entryExists ? "✓" : "✗"} ${v.extension.entry}${
      v.extension.entryExists ? dim(` (${v.extension.entryBytes} B)`) : ""
    }`),
  );
  lines.push(kv("扩展层", v.extension.layers.join(", ") || "无"));
  lines.push(kv("规则集", v.extension.rulesExists ? "✓" : "✗"));
  lines.push(kv("config", v.extension.configExists ? "✓" : "✗（用默认，首次运行生成）"));
  lines.push(kv("用户层", v.userLayers.layers.join(", ") || "无"));
  lines.push(kv("技能", v.skill.exists ? `✓ ${v.skill.file}` : "✗"));
  return lines.join("\n");
}

function cmdPatch(positionals, flags, home) {
  const sub = positionals[0] || "list";
  const ids = flags.id ? String(flags.id).split(",").map((s) => s.trim()).filter(Boolean) : null;
  const release = flags.release ? String(flags.release) : undefined;

  if (sub === "list") {
    const info = inspectDist(home, { release });
    if (!info.ok) return red(info.reason);

    const lines = [heading("上游 dist 补丁")];
    lines.push(kv("Pi 版本", info.version));
    lines.push(kv("目标", info.nodeModules));
    if (info.versionChanged) {
      lines.push(`  ${yellow("!")} 上次打补丁时是 ${info.recordedVersion}，现在 dist 已被新版本覆盖，需要 --force 重打`);
    }
    lines.push("");
    for (const patch of info.patches) {
      const tag =
        patch.state === "applied" ? green("已打") : patch.state === "pending" ? yellow("可打") : dim("无锚点");
      lines.push(`  ${tag}  ${bold(patch.id)} ${dim(`(上游 #${patch.upstreamId})`)}`);
      lines.push(`        ${patch.name}`);
      for (const target of patch.targets) {
        lines.push(`        ${dim("·")} ${target.found || target.applied ? "✓" : "✗"} ${target.files.join(", ") || "未找到"}`);
      }
    }
    lines.push("");
    lines.push(heading("不打算补的"));
    for (const skip of info.notPatched) {
      lines.push(`  ${dim("—")} ${bold(skip.id)} ${dim(`(上游 #${skip.upstreamId})`)}`);
      lines.push(`    ${skip.reason}`);
    }
    lines.push("");
    lines.push(dim("  打补丁：ctxfold patch apply [--id A,B] [--force]"));
    lines.push(dim("  撤销：  ctxfold patch revert"));
    return lines.join("\n");
  }

  if (sub === "apply") {
    const result = applyDist(home, { ids, force: Boolean(flags.force || flags.f), release });
    if (!result.ok) return red(result.reason);
    const lines = [heading("打补丁")];
    lines.push(kv("Pi 版本", result.version));
    for (const entry of result.results) {
      const done = entry.files.length > 0;
      lines.push(`  ${done ? green("✓") : yellow("·")} ${bold(entry.id)}`);
      for (const file of entry.files) lines.push(`      ${dim("改")} ${file}`);
      for (const note of entry.skipped) lines.push(`      ${dim("跳过")} ${note}`);
      for (const err of entry.errors) lines.push(`      ${red("失败")} ${err}`);
    }
    lines.push("");
    lines.push(dim("  原件备份在 <文件>.ctxfold.bak。Pi 升级后需 patch apply --force 重打。"));
    return lines.join("\n");
  }

  if (sub === "revert") {
    const result = revertDist(home, { ids, release });
    if (!result.ok) return red(result.reason);
    const lines = [heading("撤销 dist 补丁")];
    lines.push(kv("Pi 版本", result.version));
    if (!result.restored.length) lines.push(`  ${dim("没有需要恢复的文件")}`);
    for (const file of result.restored) lines.push(`  ${green("↩")} ${file}`);
    for (const file of result.missing) lines.push(`  ${yellow("?")} ${file} ${dim("(无备份，可能已被覆盖)")}`);
    return lines.join("\n");
  }

  if (sub === "clean") {
    const result = cleanBaks(home, { release });
    if (!result.ok) return red(result.reason);
    if (!result.removed.length) return dim("没有残留备份");
    return [heading("清理残留 .ctxfold.bak"), ...result.removed.map((f) => `  ${dim("-")} ${f}`)].join("\n");
  }

  if (sub === "status") {
    // 简版状态：只关心"打了没 / 版本对不对 / 有没有残留备份"，不列每个文件。
    const info = inspectDist(home, { release });
    if (!info.ok) return red(info.reason);
    const applied = info.patches.filter((p) => p.state === "applied");
    const pending = info.patches.filter((p) => p.state === "pending");
    const lines = [heading("dist 补丁状态")];
    lines.push(kv("Pi 版本", info.version));
    if (info.recordedVersion) lines.push(kv("记账版本", info.recordedVersion));
    if (info.versionChanged) {
      lines.push(`  ${yellow("!")} 版本变过，旧补丁位置可能已失效，重打前先 patch list`);
    }
    lines.push("");
    lines.push(kv("已打", applied.length ? applied.map((p) => p.id).join(", ") : dim("无")));
    lines.push(kv("未打", pending.length ? pending.map((p) => p.id).join(", ") : dim("无")));
    const stray = info.strayBaks || [];
    if (stray.length) {
      lines.push(kv("残留备份", `${stray.length} 个，patch clean 可清`));
    }
    return lines.join("\n");
  }

  return `未知子命令：${sub}（list | status | apply | revert | clean）`;
}

function help() {
  return `ctxfold — Pi Agent 的分层提示词控制台

用法：ctxfold <命令> [选项]

  install    把扩展、层、规则集、技能铺到 Pi 的加载路径
             --force                 覆盖已存在文件
             --no-skill              不装技能
             --no-extension          不装扩展
  verify     检查 Pi 真正会加载哪些东西（入口/层/规则/技能）
  apply      组装层并写入 AGENTS.md 受标记区块，同时同步技能
             --mode full|base|auto   full=全部层（默认） base=只常驻层 auto=按 --text 路由
             --text "任务描述"        auto 模式的任务文本
             --layers a,b            只注入指定层
             --position top|bottom   无区块时插到哪（默认 bottom）
             --no-skills             不同步技能
             --dry-run               只预演，不写盘
             --out <文件>            预演内容写到文件

  revert     摘掉注入区块（保留你自己写的 AGENTS.md 内容）
             --hard                  从最近备份整份还原
             --skills                同时卸载受管技能

  status     当前注入状态、体量、技能、规则、备份
  doctor     环境自检
  render     只输出组装结果，不写盘      --text / --mode / --layers / --out / --stats
  analyze    分层体量报告
  route      预览某段文本会命中哪个任务族、裁掉哪些层   --text "..." 或 stdin
  layers     列出层   list | show <name> | path <name> | fork <name> [--force]
  rules      规则开关 list | on <id> | off <id> | show <id> | add --id --label --body|--file | rm <id>
  skills     技能包   list | sync [pack...] | clean [pack...]
  patch      上游 dist 补丁（改 Pi 自己的适配器源码，默认零改动）
             list                    看 5 条上游补丁的可打状态
             apply [--id A,B] [--force]   打补丁（首次自动 .ctxfold.bak）
             revert [--id A,B]       从备份恢复
             clean                   清残留备份
  backups    列出备份
  sanitize   清洗原有提示词：备份后清空 AGENTS.md，并打开完全接管（别名 clean）
             --restore               从备份还原（也可直接 ctxfold restore）
             --dry-run               只看会动哪些文件，不写盘
             --project               连当前目录的 AGENTS.md 一起清
             --no-override           只清文件，不接管 Pi 内置提示词
             --no-keep-block         连 ctxfold 自己的区块也清掉
  app        打开桌面程序（原生窗口，注入/裁剪/清洗/接管都在里面）
  gui        打开本地控制台（网页版，一键注入/卸载/预览）
             --port <端口>            默认随机
             --no-open               不自动开浏览器
  uninstall  撤销注入 + 卸载扩展与技能 + 清状态

全局选项：
  --home <目录>      Pi Agent 主目录（默认 ~/.pi/agent，可用 CTXFOLD_HOME / PI_CODING_AGENT_DIR 覆盖）
  --json             以 JSON 输出（apply/status/doctor）
  -h, --help         显示本帮助
`;
}

function emitJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

/** 入口。返回退出码。 */
export async function main(argv) {
  const { positionals, flags } = parseArgs(argv.slice(2));
  const home = resolveHome(flags.home);
  const command = positionals.shift() || (flags.help || flags.h ? "help" : "status");

  if (flags.help || flags.h || command === "help") {
    process.stdout.write(help());
    return 0;
  }

  try {
    switch (command) {
      case "install": {
        const result = cmdInstall(flags, home);
        if (typeof result === "string") process.stdout.write(`${result}\n`);
        else emitJson(result);
        return 0;
      }
      case "verify": {
        const result = cmdVerify(flags, home);
        if (typeof result === "string") process.stdout.write(`${result}\n`);
        else emitJson(result);
        const v = inspectInstall(home);
        return v.extension.entryExists && v.extension.layers.length > 0 ? 0 : 1;
      }
      case "apply": {
        const result = cmdApply(flags, home);
        if (flags.json) emitJson(result);
        else process.stdout.write(`${formatApply(result)}\n`);
        return 0;
      }
      case "revert":
        process.stdout.write(`${cmdRevert(flags, home)}\n`);
        return 0;
      case "status": {
        if (flags.json) emitJson(status({ home }));
        else process.stdout.write(`${cmdStatus(flags, home)}\n`);
        return 0;
      }
      case "doctor": {
        const d = doctor({ home });
        if (flags.json) emitJson(d);
        else process.stdout.write(`${cmdDoctor(flags, home)}\n`);
        return d.ok ? 0 : 1;
      }
      case "render":
        process.stdout.write(`${cmdRender(flags, home)}\n`);
        return 0;
      case "analyze":
        process.stdout.write(`${cmdAnalyze(flags, home)}\n`);
        return 0;
      case "route":
        process.stdout.write(`${await cmdRoute(flags, home)}\n`);
        return 0;
      case "layers":
        process.stdout.write(`${cmdLayers(positionals, flags, home)}\n`);
        return 0;
      case "rules":
        process.stdout.write(`${cmdRules(positionals, flags, home)}\n`);
        return 0;
      case "skills":
        process.stdout.write(`${cmdSkills(positionals, flags, home)}\n`);
        return 0;
      case "patch": {
        if (flags.json) {
          emitJson(inspectDist(home, { release: flags.release ? String(flags.release) : undefined }));
          return 0;
        }
        const out = cmdPatch(positionals, flags, home);
        process.stdout.write(`${out}\n`);
        return out.startsWith("\x1b[31m") ? 1 : 0;
      }
      case "backups":
        process.stdout.write(`${cmdBackups(flags, home)}\n`);
        return 0;
      // clean / restore 是 sanitize 的别名：日常说法更直白
      case "clean":
      case "restore":
      case "sanitize": {
        const eff = command === "restore" ? { ...flags, restore: true } : flags;
        const result = cmdSanitize(eff, home);
        if (eff.json) emitJson(result);
        else process.stdout.write(`${result}\n`);
        return 0;
      }
      case "bridge": {
        const action = positionals.shift() || "status";
        let payload = {};
        const raw = positionals.join(" ");
        if (raw) {
          try {
            payload = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) || {};
          } catch {
            try {
              payload = JSON.parse(raw) || {};
            } catch {
              payload = {};
            }
          }
        }
        const { runBridge } = await import("./bridge.js");
        // 外壳会把当前选中的目标目录放在 payload.home 里；沿用 CLI 的 --home 优先级
        const targetHome = payload.home ? path.resolve(String(payload.home)) : home;
        const out = await runBridge(action, payload, { home: targetHome, cwd: process.cwd() });
        process.stdout.write(`${JSON.stringify(out)}\n`);
        return out.ok ? 0 : 1;
      }
      case "gui": {
        const { startServer } = await import("../gui/server.js");
        const srv = await startServer({
          home,
          port: Number(flags.port) || 0,
          open: !flags["no-open"],
        });
        await new Promise((resolve) => {
          process.once("SIGINT", resolve);
          process.once("SIGTERM", resolve);
        });
        await srv.close();
        return 0;
      }
      case "app": {
        const { spawn } = await import("node:child_process");
        const { fileURLToPath } = await import("node:url");
        const root = fileURLToPath(new URL("..", import.meta.url));
        const exe = path.join(root, "dist", process.platform === "win32" ? "ctxfold-app.exe" : "ctxfold-app");
        if (!fs.existsSync(exe)) {
          process.stderr.write(
            `${red("还没有桌面外壳")} ${exe}\n${dim("先跑 node scripts/build-shell.mjs 生成它")}\n`,
          );
          return 1;
        }
        const child = spawn(exe, [], { detached: true, stdio: "ignore", cwd: root });
        child.unref();
        process.stdout.write(`${green("已启动")} ${exe}\n`);
        return 0;
      }
      case "uninstall":
        process.stdout.write(`${cmdUninstall(flags, home)}\n`);
        return 0;
      default:
        process.stderr.write(`未知命令：${command}\n\n${help()}`);
        return 2;
    }
  } catch (error) {
    process.stderr.write(`${red("错误")} ${error && error.message ? error.message : error}\n`);
    if (process.env.CTXFOLD_DEBUG && error && error.stack) process.stderr.write(`${error.stack}\n`);
    return 1;
  }
}
