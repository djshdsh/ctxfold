/**
 * ctxfold 本地控制台。
 *
 * 只绑 127.0.0.1，POST 要带启动时生成的 token，
 * 这样浏览器里其它网页没法对着这个端口发注入请求。
 */

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { exec } from "node:child_process";
import { fileURLToPath } from "node:url";

import { status, doctor, render } from "../lib/index.js";
import { install, uninstallInstalled, inspectInstall } from "../lib/install.js";
import { resolveHome, extensionsDir } from "../lib/paths.js";
import { loadAllLayers } from "../lib/compose.js";
import { stripBom } from "../lib/jsonio.js";
import {
  sanitize,
  restore,
  listAgentFiles,
  readExtensionConfig,
  readSanitizeState,
} from "../lib/sanitize.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, "..");

/** 找机器上所有可能的 Pi Agent 主目录。 */
export function detectTargets() {
  const found = new Map();
  const push = (dir, source) => {
    if (!dir) return;
    const abs = path.resolve(dir);
    if (found.has(abs)) return;
    const installed = fs.existsSync(path.join(abs, "extensions", "ctxfold", "index.ts"));
    found.set(abs, {
      path: abs,
      source,
      exists: fs.existsSync(abs),
      isDefault: false,
      installed,
      version: readPiVersion(abs),
    });
  };

  // 1. 显式指定 / 当前进程环境
  push(process.env.CTXFOLD_HOME, "环境变量");
  push(process.env.PI_AGENT_HOME, "PI_AGENT_HOME");
  push(process.env.PI_CODING_AGENT_DIR, "PI_CODING_AGENT_DIR");
  // 2. 当前用户默认位置
  const current = resolveHome();
  push(current, "当前用户");
  // 3. 同一台机器上其它 Windows 用户
  for (const base of userRoots()) {
    let entries = [];
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const cand = path.join(base, e.name, ".pi", "agent");
      if (fs.existsSync(cand)) push(cand, `用户 ${e.name}`);
    }
  }

  const list = [...found.values()];
  const def = list.find((t) => t.path.toLowerCase() === current.toLowerCase());
  if (def) def.isDefault = true;
  return list.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.path.localeCompare(b.path));
}

function userRoots() {
  const roots = [];
  const home = os.homedir();
  roots.push(path.dirname(home)); // C:\Users
  if (process.env.SystemDrive) roots.push(path.join(process.env.SystemDrive, "Users"));
  return [...new Set(roots.filter((p) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  }))];
}

function readPiVersion(home) {
  try {
    const rel = path.join(home, "install", "releases");
    const list = fs
      .readdirSync(rel, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return list.at(-1) || null;
  } catch {
    return null;
  }
}

function summaryOf(home) {
  try {
    const s = status({ home });
    const ext = fs.existsSync(path.join(extensionsDir(home), "ctxfold", "index.ts"));
    // 扩展通道不写 AGENTS.md，所以 status().layers 会是空的；
    // 面板上要显示真正会被注入的层，得自己读一遍。
    const all = loadAllLayers(home);
    const layers = ext ? all.map((l) => l.name) : s.layers;
    const chars = ext ? all.reduce((n, l) => n + (l.text || "").length, 0) : s.chars;
    const cfg = readExtensionConfig(home);
    const agentFiles = listAgentFiles(home);
    const leftover = agentFiles.reduce((n, f) => n + f.outsideChars, 0);
    return {
      ok: true,
      home: s.home,
      channel: ext ? "extension" : s.applied ? "agents-md" : "none",
      override: Boolean(cfg.override),
      sanitized: Boolean(readSanitizeState(home).at),
      leftoverChars: leftover,
      agentFiles: agentFiles.map((f) => ({ path: f.path, scope: f.scope, chars: f.chars, outsideChars: f.outsideChars })),
      applied: s.applied,
      drifted: s.drifted,
      layers,
      chars,
      tokens: s.tokens,
      rules: s.rules,
      backups: s.backups,
      userContentChars: s.userContentChars,
      installed: inspectInstall(home),
    };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

function openBrowser(url) {
  const cmd =
    process.platform === "win32"
      ? `start "" "${url}"`
      : process.platform === "darwin"
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, { shell: true, windowsHide: true }, () => {});
}

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(data);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(stripBom(raw)));
      } catch {
        reject(new Error("JSON 解析失败"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * 启动控制台。
 * @returns {Promise<{port:number,url:string,close:()=>Promise<void>}>}
 */
export async function startServer({ home, port = 0, open = true, quiet = false } = {}) {
  const token = crypto.randomBytes(16).toString("hex");
  const htmlPath = path.join(PKG, "gui", "index.html");

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const p = url.pathname;

    try {
      if (req.method === "GET" && (p === "/" || p === "/index.html")) {
        const html = fs.readFileSync(htmlPath, "utf8").replace("__CTXFOLD_TOKEN__", token);
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(html);
        return;
      }

      if (p.startsWith("/api/")) {
        if (req.method === "POST" && req.headers["x-ctxfold-token"] !== token) {
          return json(res, 403, { ok: false, error: "token 不匹配" });
        }
        return await handleApi(p, req, res, url, { home, token });
      }

      json(res, 404, { ok: false, error: "没有这个路径" });
    } catch (err) {
      json(res, 500, { ok: false, error: String(err?.message || err) });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  const actual = server.address().port;
  const link = `http://127.0.0.1:${actual}/`;

  if (!quiet) {
    console.log("");
    console.log("  ctxfold 控制台已启动");
    console.log(`  ${link}`);
    console.log("  关掉这个窗口即停止。");
    console.log("");
  }
  if (open) openBrowser(link);

  return {
    port: actual,
    url: link,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function handleApi(p, req, res, url, ctx) {
  const q = url.searchParams;

  if (p === "/api/targets" && req.method === "GET") {
    return json(res, 200, { ok: true, targets: detectTargets(), defaultHome: ctx.home });
  }

  if (p === "/api/status" && req.method === "GET") {
    const home = q.get("home") || ctx.home;
    return json(res, 200, summaryOf(home));
  }

  if (p === "/api/layers" && req.method === "GET") {
    const home = q.get("home") || ctx.home;
    const layers = loadAllLayers(home);
    return json(res, 200, {
      ok: true,
      layers: layers.map((l) => ({ name: l.name, chars: (l.text || "").length, source: l.source || "preset" })),
    });
  }

  if (p === "/api/preview" && req.method === "POST") {
    const body = await readBody(req);
    const home = body.home || ctx.home;
    const text = String(body.text || "").trim();
    const result = render({ home, text: text || undefined });
    return json(res, 200, {
      ok: true,
      family: result.family,
      familyLabel: result.familyLabel,
      kept: result.kept,
      chars: (result.text || "").length,
      head: (result.text || "").slice(0, 4000),
      filtered: result.unmatched === false,
    });
  }

  if (p === "/api/doctor" && req.method === "GET") {
    const home = q.get("home") || ctx.home;
    const d = doctor({ home });
    return json(res, 200, { ok: d.ok, checks: d.checks, home: d.home });
  }

  if (p === "/api/sanitize" && req.method === "POST") {
    const body = await readBody(req);
    const target = body.home || ctx.home;
    if (body.restore) {
      const r = restore({ home: target, dryRun: Boolean(body.dryRun) });
      return json(res, 200, { ok: true, restored: r.restored, state: summaryOf(target) });
    }
    const r = sanitize({
      home: target,
      project: Boolean(body.project),
      dryRun: Boolean(body.dryRun),
      keepBlock: body.keepBlock !== false,
      override: body.override !== false,
    });
    return json(res, 200, { ok: true, files: r.files, override: r.override, state: summaryOf(target) });
  }

  if (p === "/api/install" && req.method === "POST") {    const body = await readBody(req);
    const target = body.home || ctx.home;
    const result = install({ home: target, force: body.force !== false });
    return json(res, 200, {
      ok: true,
      result: { ...result, written: (result.copied || []).length },
      state: summaryOf(target),
    });
  }

  if (p === "/api/uninstall" && req.method === "POST") {
    const body = await readBody(req);
    const target = body.home || ctx.home;
    uninstallInstalled(target);
    return json(res, 200, { ok: true, state: summaryOf(target) });
  }

  json(res, 404, { ok: false, error: "没有这个接口" });
}
