/**
 * ctxfold — Pi Agent 原生扩展（ctxfold 移植版）
 *
 * 装载位置：<agent-dir>/extensions/ctxfold/index.ts
 * 目录结构：
 *   index.ts                 本文件
 *   layers/*.md              预设层（由 ctxfold install 拷入）
 *   rules.json               规则集
 *   config.json              运行时开关
 *
 * 注入通道：before_agent_start → systemPromptOptions.sections.ctxfold
 * 该通道是 Pi 的结构化提示词分段，改动只影响本次 run，且 Pi 能按 section 做增量对比，
 * 不会把整条缓存前缀打掉。
 *
 * 本文件刻意零外部依赖（除类型），因为 Pi 用 jiti 加载 TS，
 * 安装后只剩这一个目录，不能依赖包内 lib/ 的相对路径。
 */

import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── 常量 ──────────────────────────────────────────────────────────────

const SECTION_KEY = "ctxfold";

/** 层在最终注入体里的先后顺序。不在表里的自定义层按文件名字母序追加。 */
const LAYER_ORDER = ["core", "refusal", "eng", "rules", "route.re", "web", "ctf", "ir"];

/** 常驻层：无论任务族怎么裁，这几层不裁。与 lib/router.js 的 BASE_LAYERS 保持一致。 */
const ALWAYS = ["core", "refusal", "eng"];

/** 所有领域层。用于 enable/disable 与预览。 */
const DOMAIN_LAYERS = ["route.re", "web", "ctf", "ir"];

// ── 类型 ──────────────────────────────────────────────────────────────

interface Layer {
  name: string;
  text: string;
  file?: string;
}

interface PurgeConfig {
  /** 总开关。false 时扩展完全不注入。 */
  enabled: boolean;
  /** 是否按当轮任务裁剪非领域层。false = 全量注入。 */
  routing: boolean;
  /** 注入体字符上限，超了按层顺序截断并留标记。0 = 不限。 */
  maxChars: number;
  /** 工具调用放行策略。auto = 全放；confirm = 破坏性操作问一次；block = 破坏性操作直接拦。 */
  approval: "auto" | "confirm" | "block";
  /**
   * 完全接管系统提示词。
   * false = 只追加一个 section，Pi 自己的提示词和 AGENTS.md 都还在（默认）。
   * true  = 整条系统提示词换成 ctxfold 的正文，Pi 内置说明、AGENTS.md、技能目录全部不出现。
   */
  override: boolean;
  /**
   * override 打开时，是否附一小段工具摘要。
   * Pi 的工具定义走 API 的 tools 字段，不写进提示词也能调用；
   * 但完全接管后模型不知道有哪些工具，容易漏用，所以默认补一行清单。
   */
  toolDigest: boolean;
}

interface RuleSet {
  rules: Array<{ id: string; label: string; enabled: boolean; body: string }>;
}

const DEFAULT_CONFIG: PurgeConfig = {
  enabled: true,
  routing: true,
  maxChars: 0,
  approval: "auto",
  override: false,
  toolDigest: true,
};

// ── 磁盘 ──────────────────────────────────────────────────────────────

/** 扩展自身目录。 */
function extDir(): string {
  return import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);
}

/** agent 主目录：扩展位于 <agent>/extensions/<name>，上两级即是。 */
function agentDir(): string {
  return path.resolve(extDir(), "..", "..");
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function readJson<T>(file: string, fallback: T): T {
  const raw = readText(file);
  if (!raw) return fallback;
  // Windows 上编辑 config.json 极易带上 UTF-8 BOM（记事本 / PowerShell）。
  // 不剥掉的话 JSON.parse 会抛，下面 catch 一吞就静默回退成默认值——
  // 表现就是「明明把 override 改成 true，扩展当没看见」。
  const clean = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  try {
    return { ...fallback, ...(JSON.parse(clean) as object) } as T;
  } catch {
    return fallback;
  }
}

function config(): PurgeConfig {
  return readJson<PurgeConfig>(path.join(extDir(), "config.json"), DEFAULT_CONFIG);
}

// ── 层解析 ────────────────────────────────────────────────────────────

const LAYER_OPEN = /<!--\s*ctxfold:layer\s+([A-Za-z0-9._-]+)\s*-->/;
const LAYER_CLOSE = /<!--\s*\/ctxfold:layer\s*-->/;

/**
 * 从 markdown 里切层。
 * 没有标记的文件整份算一层，层名取文件名 —— 让用户随手丢一个 .md 进来就能用。
 */
function parseLayers(raw: string, fallbackName: string): Layer[] {
  const hasMarker = LAYER_OPEN.test(raw);
  if (!hasMarker) {
    const text = raw.trim();
    return text ? [{ name: fallbackName, text }] : [];
  }

  const out: Layer[] = [];
  const lines = raw.split(/\r?\n/);
  let current: string | null = null;
  let buffer: string[] = [];

  const flush = () => {
    if (current) {
      const text = buffer.join("\n").trim();
      if (text) out.push({ name: current, text });
    }
    current = null;
    buffer = [];
  };

  for (const line of lines) {
    const open = line.match(LAYER_OPEN);
    if (open) {
      flush();
      current = open[1];
      continue;
    }
    if (LAYER_CLOSE.test(line)) {
      flush();
      continue;
    }
    // 标记外的内容丢弃：它属于文件的说明，不该进提示词
    if (current) buffer.push(line);
  }
  // 未闭合的开标记：余下全文归该层，宁多勿丢
  flush();
  return out;
}

function readLayerDir(dir: string): Layer[] {
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const out: Layer[] = [];
  for (const file of files.sort()) {
    const raw = readText(path.join(dir, file));
    if (!raw) continue;
    for (const layer of parseLayers(raw, path.basename(file, ".md"))) {
      out.push({ ...layer, file: path.join(dir, file) });
    }
  }
  return out;
}

/**
 * 预设层 + 用户层。同名层由用户层覆盖 —— 无需改包内文件就能改注入。
 * 用户层放在 <agent-dir>/.ctxfold/layers/，与 CLI 用的是同一处。
 */
function loadAllLayers(): Layer[] {
  const bundled = readLayerDir(path.join(extDir(), "layers"));
  const user = readLayerDir(path.join(agentDir(), ".ctxfold", "layers"));

  const byName = new Map<string, Layer>();
  for (const layer of bundled) byName.set(layer.name, layer);
  for (const layer of user) byName.set(layer.name, layer);

  const rank = (name: string) => {
    const i = LAYER_ORDER.indexOf(name);
    return i === -1 ? LAYER_ORDER.length : i;
  };
  return [...byName.values()].sort((a, b) => rank(a.name) - rank(b.name));
}

function rulesText(): string {
  const set = readJson<RuleSet>(path.join(extDir(), "rules.json"), { rules: [] });
  const on = (set.rules || []).filter((r) => r.enabled && r.body);
  if (!on.length) return "";
  return ["## 交付纪律（可逐条开关）", ...on.map((r) => `- **${r.label}**：${r.body}`)].join("\n");
}

// ── 任务族识别 ────────────────────────────────────────────────────────

type Family = "re" | "web" | "ctf" | "ir" | "eng" | "general";

const FAMILY_RULES: Array<{ family: Family; label: string; layers: string[]; test: RegExp }> = [
  {
    family: "re",
    label: "逆向 / 卡密",
    layers: ["eng", "route.re"],
    test: /逆向|反编译|脱壳|加壳|破解|卡密|注册机|序列号|keygen|crack|reverse|decompil|unpack|serial|licen[cs]e|frida|smali|apk|ipa|dll|so文件|二进制|签名算法|hook/i,
  },
  {
    family: "web",
    label: "Web 渗透",
    layers: ["eng", "web"],
    test: /渗透|打点|拿站|日站|webshell|sql\s*注入|sqli|xss|ssrf|csrf|xxe|越权|idor|文件上传|rce|命令注入|反序列化|waf|旁站|子域名|目录爆破|指纹|burp|nuclei|漏洞/i,
  },
  {
    family: "ctf",
    label: "CTF 赛题",
    layers: ["eng", "ctf"],
    test: /\bctf\b|flag\{|赛题|比赛|靶场|夺旗|pwn|赛棍|writeup|crypto题|misc题/i,
  },
  {
    family: "ir",
    label: "应急响应 / 排查",
    layers: ["ir"],
    test: /应急|排查|溯源|入侵检测|中招|被黑|webshell排查|日志分析|取证|木马清理|加固|基线|ioc|失陷|被挖矿/i,
  },
  {
    family: "eng",
    label: "工程 / 改代码",
    // eng 已在 ALWAYS 里，这一族存在的意义是「明确识别成工程任务，好把领域层裁掉」
    layers: [],
    test: /实现|重构|修\s*bug|报错|异常|编译|构建|部署|写个|写一个|加个|改成|优化|测试|脚本|函数|模块|接口|\bapi\b|数据库|性能|依赖|单元测试|\bci\b|docker|k8s|kubernetes|typescript|python|rust|golang/i,
  },
];

function classify(text: string): { family: Family; label: string; layers: string[] } {
  const hit = FAMILY_RULES.find((r) => r.test.test(text));
  if (hit) return { family: hit.family, label: hit.label, layers: hit.layers };
  return { family: "general", label: "通用", layers: [] };
}

// ── 组装 ──────────────────────────────────────────────────────────────

interface Assembled {
  text: string;
  kept: string[];
  dropped: string[];
  family: string;
  familyLabel: string;
  chars: number;
  truncated: boolean;
}

function assemble(prompt: string): Assembled {
  const cfg = config();
  const layers = loadAllLayers();
  const ruleBody = rulesText();
  const all: Layer[] = ruleBody
    ? [...layers, { name: "rules", text: ruleBody }]
    : layers;

  const route = classify(prompt || "");
  // 只要识别出明确的任务族就裁；general 表示识别不出来，此时全量注入更安全。
  // 注意不能拿 route.layers.length 做条件 —— eng 族本身没有专属层，但依然该裁领域层。
  const routed = cfg.routing && route.family !== "general";

  const keep = new Set<string>(ALWAYS);
  if (routed) for (const name of route.layers) keep.add(name);
  // 规则层永远进，它是用户自己开的能力
  keep.add("rules");

  const selected = routed ? all.filter((l) => keep.has(l.name)) : all;
  const dropped = routed ? all.filter((l) => !keep.has(l.name)).map((l) => l.name) : [];

  let text = selected.map((l) => l.text).filter(Boolean).join("\n\n").trim();
  let truncated = false;
  if (cfg.maxChars > 0 && text.length > cfg.maxChars) {
    const cut = text.slice(0, cfg.maxChars);
    const lastBreak = cut.lastIndexOf("\n\n");
    text = `${lastBreak > cfg.maxChars * 0.6 ? cut.slice(0, lastBreak) : cut}\n\n<!-- ctxfold: 注入体已按 maxChars 截断 -->`;
    truncated = true;
  }

  return {
    text,
    kept: selected.map((l) => l.name),
    dropped,
    family: route.family,
    familyLabel: route.label,
    chars: text.length,
    truncated,
  };
}

// ── 破坏性操作判定（approval 用） ────────────────────────────────────

const DESTRUCTIVE: RegExp[] = [
  /\brm\s+(-[a-z]*[rf]|--recursive|--force)/i,
  /\bmkfs(\.|\s)/i,
  /\bdd\s+.*\bof=\/dev\//i,
  /\bshutdown\b|\breboot\b/i,
  /\bformat\s+[a-z]:/i,
  /\bgit\s+push\b.*--force|\bgit\s+reset\s+--hard/i,
  /\bdrop\s+(table|database)\b/i,
  /\btruncate\s+table\b/i,
  /\bdel\s+\/[sq]\b|\brmdir\s+\/s\b/i,
  />\s*\/etc\/(passwd|shadow|sudoers)/i,
];

function looksDestructive(toolName: string, input: Record<string, unknown>): boolean {
  if (toolName === "write" || toolName === "edit") {
    const target = String(input.path ?? input.file_path ?? "");
    return /\/(etc|boot|System)\/|\\Windows\\System32\\/i.test(target);
  }
  const command = String(input.command ?? input.script ?? "");
  return DESTRUCTIVE.some((p) => p.test(command));
}

// ── 扩展主体 ──────────────────────────────────────────────────────────

/**
 * override 模式下补的一小段工具清单。
 *
 * 完全接管提示词后，Pi 原本那段「有哪些工具、怎么用」的说明会一起消失。
 * 工具本身仍然通过 API 的 tools 字段可用，但模型不知道存在，就会退化成纯聊天。
 * 这里只报名字和一句用法，几十个字符，比整段内置说明便宜得多。
 */
function toolDigestText(selected?: string[], hidden?: string[]): string {
  const hiddenSet = new Set(hidden ?? []);
  const names = (selected ?? []).filter((n) => !hiddenSet.has(n));
  if (names.length === 0) return "";
  return [
    "<tools>",
    `可用工具：${names.join(", ")}`,
    "用法：读文件 read；写文件 write；改文件先 read 再 edit；找文件 find / ls；搜内容 grep；执行命令 bash（Windows 下 powershell）。",
    "能直接回答的问题不要调工具。",
    "</tools>",
  ].join("\n");
}

export default function piPurge(pi: ExtensionAPI) {
  let last: Assembled | null = null;

  // 1 注入：每轮按任务族组装
  //   override=false → 写进结构化 section（Pi 自己的提示词还在）
  //   override=true  → 设 forceSystemPrompt，整条按本体重写（Pi 内置说明 + AGENTS.md 全部不出现）
  pi.on("before_agent_start", (event) => {
    const cfg = config();
    if (!cfg.enabled) return;
    const result = assemble(event.prompt ?? "");
    last = result;
    if (!result.text) return;

    if (!cfg.override) {
      event.systemPromptOptions.sections[SECTION_KEY] = result.text;
      return undefined;
    }

    const parts = [result.text];
    if (cfg.toolDigest) {
      const digest = toolDigestText(event.systemPromptOptions.selectedTools, event.systemPromptOptions.hiddenTools);
      if (digest) parts.push(digest);
    }
    // 直接改 options 与 return { systemPrompt } 等价，这里用 return 更明确
    return { systemPrompt: parts.join("\n\n") };
  });

  // 2 状态栏：让注入是否生效一眼可见
  pi.on("session_start", (_event, ctx) => {
    const cfg = config();
    if (!ctx.hasUI) return;
    if (!cfg.enabled) {
      ctx.ui.setStatus("ctxfold", "ctxfold:off");
      return;
    }
    const layers = loadAllLayers().length;
    ctx.ui.setStatus("ctxfold", `ctxfold:${layers}层${cfg.routing ? "" : "/全量"}`);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus("ctxfold", undefined);
  });

  // 3 放行策略：把 上游的审批门移植到 Pi 的 tool_call 边界
  pi.on("tool_call", async (event, ctx) => {
    const cfg = config();
    if (cfg.approval === "auto") return undefined;
    if (!looksDestructive(event.toolName, event.input as Record<string, unknown>)) return undefined;

    if (cfg.approval === "block") {
      return { block: true, reason: `ctxfold: ${event.toolName} 命中破坏性操作策略（approval=block）` };
    }
    if (!ctx.hasUI) return undefined;
    const ok = await ctx.ui.confirm("ctxfold：破坏性操作", `${event.toolName}\n\n放行本次调用？`);
    return ok ? undefined : { block: true, reason: "ctxfold: 操作者拒绝该调用" };
  });

  // 4 /ctxfold 命令
  pi.registerCommand("ctxfold", {
    description: "ctxfold 管理：status / preview / layers / rules / route / override / enable / disable / doctor",
    getArgumentCompletions: (prefix) => {
      const subs = ["status", "preview", "layers", "rules", "route", "override", "enable", "disable", "doctor"];
      const hit = subs.filter((s) => s.startsWith(prefix.trim()));
      return hit.length ? hit.map((s) => ({ value: s, label: s })) : null;
    },
    handler: async (rawArgs, ctx) => {
      const argv = rawArgs.trim().split(/\s+/).filter(Boolean);
      const sub = argv[0] || "status";
      const rest = argv.slice(1).join(" ");

      const notify = (msg: string) => ctx.ui.notify(msg, "info");

      switch (sub) {
        case "status": {
          const cfg = config();
          const layers = loadAllLayers();
          const prompt = ctx.getSystemPrompt();
          const inPrompt = cfg.override
            ? Boolean(last?.text) && prompt.includes(last!.text.slice(0, 40))
            : prompt.includes(`<${SECTION_KEY}>`);
          const injected = inPrompt || (last?.chars ?? 0) > 0;

          // 注入发生在"发消息那一刻"（before_agent_start），不是启动时。
          // 所以刚进会话查状态必然还没注入 —— 要把这三种情况分开说，
          // 否则用户会以为装坏了。
          let injectLine: string;
          if (!cfg.enabled) {
            injectLine = "已关闭（/ctxfold enable 打开）";
          } else if (injected) {
            injectLine = `已生效（${last?.chars ?? "?"} 字符）`;
          } else if (!last) {
            injectLine = "还没发送过消息 —— 正常，发一条就会注入";
          } else {
            injectLine = "发过消息但注入体为空 —— 跑 ctxfold doctor";
          }

          notify(
            [
              `ctxfold 状态`,
              `  开关        ${cfg.enabled ? "开" : "关"}`,
              `  模式        ${cfg.override ? "完全接管（Pi 内置提示词与 AGENTS.md 都不注入）" : "追加（Pi 自己的提示词仍在）"}`,
              `  路由        ${cfg.routing ? "按任务族裁剪" : "全量注入"}`,
              `  放行        ${cfg.approval}`,
              `  上限        ${cfg.maxChars > 0 ? `${cfg.maxChars} 字符` : "不限"}`,
              `  已装层      ${layers.map((l) => l.name).join(", ") || "无"}`,
              `  当前注入    ${injectLine}`,
              `  上一轮族    ${last ? `${last.familyLabel}（保留 ${last.kept.join(", ")}）` : "—"}`,
              `  目录        ${extDir()}`,
            ].join("\n"),
          );
          return;
        }

        case "preview": {
          const result = assemble(rest);
          if (!result.text) {
            notify("没有可注入的内容：先跑 ctxfold install，或检查 layers 目录");
            return;
          }
          const head = result.text.slice(0, 1200);
          notify(
            [
              `任务族 ${result.familyLabel}｜保留 ${result.kept.join(", ")}`,
              result.dropped.length ? `裁掉 ${result.dropped.join(", ")}` : "未裁剪",
              `体量 ${result.chars} 字符${result.truncated ? "（已截断）" : ""}`,
              "─────",
              head,
              result.text.length > 1200 ? "\n…（预览截断，完整内容见 CLI：ctxfold render）" : "",
            ].join("\n"),
          );
          return;
        }

        case "layers": {
          const layers = loadAllLayers();
          notify(
            [
              `已装层 ${layers.length}`,
              ...layers.map((l) => `  ${l.name.padEnd(10)} ${String(l.text.length).padStart(6)} 字符  ${l.file ?? ""}`),
            ].join("\n"),
          );
          return;
        }

        case "rules": {
          const set = readJson<RuleSet>(path.join(extDir(), "rules.json"), { rules: [] });
          notify(
            [
              `规则 ${set.rules.filter((r) => r.enabled).length}/${set.rules.length} 启用`,
              ...set.rules.map((r) => `  ${r.enabled ? "on " : "off"} ${r.id}  ${r.label}`),
              "",
              "改开关：ctxfold rules on|off <id>",
            ].join("\n"),
          );
          return;
        }

        case "route": {
          const probe = rest || last?.family || "";
          if (!probe) {
            notify("用法：/ctxfold route <任务文本>");
            return;
          }
          const route = classify(probe);
          notify(`任务族 ${route.label}\n保留 ${[...ALWAYS, ...route.layers, "rules"].join(", ")}`);
          return;
        }

        case "override": {
          const cfg = config();
          const want = rest.trim();
          if (!want) {
            notify(
              [
                `完全接管：${cfg.override ? "开（整条系统提示词 = ctxfold 正文）" : "关（只追加 section，Pi 自己的提示词还在）"}`,
                "用法：/ctxfold override on   /ctxfold override off",
                cfg.override ? "" : "想彻底盖掉 Pi 内置说明和 AGENTS.md 时打开它。",
              ]
                .filter(Boolean)
                .join("\n"),
            );
            return;
          }
          cfg.override = want === "on" || want === "true" || want === "1";
          writeConfig(cfg);
          notify(
            cfg.override
              ? "ctxfold 已接管整条系统提示词；下一轮生效。想盖掉 AGENTS.md 还要跑：ctxfold sanitize"
              : "ctxfold 恢复为追加模式；Pi 自己的提示词重新出现",
          );
          return;
        }

        case "enable":
        case "disable": {
          const cfg = config();
          cfg.enabled = sub === "enable";
          writeConfig(cfg);
          notify(`ctxfold 已${cfg.enabled ? "启用" : "停用"}；下一轮生效（本轮已注入的内容不会撤回）`);
          return;
        }

        case "doctor": {
          const report = doctorReport();
          notify(report.join("\n"));
          return;
        }

        default:
          notify(`未知子命令 ${sub}\n可用：status preview layers rules route enable disable doctor`);
      }
    },
  });

  // 5 让模型自己能查注入状态，省得靠猜
  pi.registerTool({
    name: "ctxfold_status",
    label: "ctxfold 状态",
    description:
      "读取 ctxfold 的当前注入状态：开关、任务族、已装层、上一轮实际注入的层与体量。排障时先用它。",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    } as never,
    async execute() {
      const cfg = config();
      const layers = loadAllLayers();
      const text = [
        `enabled=${cfg.enabled}`,
        `routing=${cfg.routing}`,
        `approval=${cfg.approval}`,
        `layers=${layers.map((l) => l.name).join(",")}`,
        `lastFamily=${last?.family ?? "—"}`,
        `lastKept=${last?.kept.join(",") ?? "—"}`,
        `lastChars=${last?.chars ?? 0}`,
      ].join("\n");
      return {
        content: [{ type: "text" as const, text }],
        details: { layers: layers.map((l) => l.name), family: last?.family ?? null },
      };
    },
  });
}

// ── 辅助 ──────────────────────────────────────────────────────────────

function writeConfig(cfg: PurgeConfig): void {
  try {
    fs.writeFileSync(path.join(extDir(), "config.json"), `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
  } catch {
    /* 只读安装时静默失败，命令里已经提示过了 */
  }
}

function doctorReport(): string[] {
  const lines: string[] = ["ctxfold 自检"];
  const dir = extDir();
  const layersDir = path.join(dir, "layers");
  const layers = loadAllLayers();
  const cfg = config();

  lines.push(`  扩展目录    ${dir}`);
  lines.push(`  层目录      ${layersDir}  ${fs.existsSync(layersDir) ? "存在" : "缺失"}`);
  lines.push(`  层数量      ${layers.length}`);
  lines.push(`  空层        ${layers.filter((l) => !l.text.trim()).map((l) => l.name).join(", ") || "无"}`);
  lines.push(`  规则        ${path.join(dir, "rules.json")}  ${fs.existsSync(path.join(dir, "rules.json")) ? "存在" : "缺失"}`);
  lines.push(`  config      ${path.join(dir, "config.json")}  ${fs.existsSync(path.join(dir, "config.json")) ? "存在" : "缺失（用默认）"}`);
  lines.push(`  用户层      ${path.join(agentDir(), ".ctxfold", "layers")}`);
  lines.push(`  开关        ${cfg.enabled ? "开" : "关"} / 路由 ${cfg.routing ? "开" : "关"} / 放行 ${cfg.approval}`);

  const total = assemble("").chars;
  lines.push(`  空任务全量  ${total} 字符`);
  if (total === 0) lines.push("  ⚠ 注入体为空：检查 layers 目录是否已由 ctxfold install 填充");
  return lines;
}
