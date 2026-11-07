/**
 * 把 ctxfold 打包成一个真正的 Windows 桌面程序：dist\ctxfold-app.exe
 *
 * 做法：用 Windows 自带的 C# 编译器（.NET Framework 4.x 的 csc.exe）把 shell\App.cs
 * 编译成 winexe，并把已经做好的单文件后端 dist\ctxfold.exe 作为内嵌资源塞进去。
 * 运行时外壳把后端摊到 %LOCALAPPDATA%\ctxfold\runtime\<version>\ 再调用它。
 *
 * 结果是一个窗口应用：有自己的标题栏、菜单、标签页，不打开浏览器。
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DIST = path.join(ROOT, "dist");
const BUILD = path.join(ROOT, "build");

const BACKEND = path.join(DIST, "ctxfold.exe");
const ICON = path.join(BUILD, "ctxfold.ico");
const ASSETS = path.join(ROOT, "assets");
const SOURCE = path.join(ROOT, "shell", "App.cs");
const OUT = path.join(DIST, "ctxfold-app.exe");

function findCsc() {
  const candidates = [
    path.join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    path.join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error("找不到 csc.exe（需要 .NET Framework 4.x）");
}

function step(label, fn) {
  process.stdout.write(`\n▶ ${label}\n`);
  return fn();
}

function run(cmd, args, options = {}) {
  const res = spawnSync(cmd, args, { stdio: "inherit", cwd: ROOT, ...options });
  if (res.status !== 0) {
    throw new Error(`${path.basename(cmd)} 退出码 ${res.status}`);
  }
  return res;
}

// 1) 后端：没有、或源码比后端新，就重建（否则外壳会内嵌一个不认新 bridge 动作的旧后端）
function newestMtime(dir) {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(full));
    else newest = Math.max(newest, fs.statSync(full).mtimeMs);
  }
  return newest;
}

const sourceDirs = ["lib", "bin", "presets", "patches", "extension", "gui", "skills"]
  .map((d) => path.join(ROOT, d))
  .filter((d) => fs.existsSync(d));
const newestSource = Math.max(...sourceDirs.map(newestMtime), fs.statSync(path.join(ROOT, "package.json")).mtimeMs);
const backendStale = fs.existsSync(BACKEND) && fs.statSync(BACKEND).mtimeMs < newestSource;

if (!fs.existsSync(BACKEND)) {
  step("构建后端 dist\\ctxfold.exe", () => {
    run(process.execPath, [path.join(ROOT, "scripts", "build-exe.mjs")]);
  });
} else if (backendStale) {
  step("源码比后端新，重建 dist\\ctxfold.exe", () => {
    run(process.execPath, [path.join(ROOT, "scripts", "build-exe.mjs")]);
  });
} else {
  const mb = (fs.statSync(BACKEND).size / 1024 / 1024).toFixed(1);
  console.log(`• 复用已有后端 dist\\ctxfold.exe（${mb} MB）`);
}

// 2) 图标：有自定义原图（assets\icon-source.png）就用它生成，否则退回程序化生成的方块图标
const ICON_SOURCE = path.join(ASSETS, "icon-source.png");
const iconStale =
  !fs.existsSync(ICON) ||
  (fs.existsSync(ICON_SOURCE) && fs.statSync(ICON).mtimeMs < fs.statSync(ICON_SOURCE).mtimeMs);

if (fs.existsSync(ICON_SOURCE)) {
  if (iconStale) {
    step("用 assets\\icon-source.png 生成图标 build\\ctxfold.ico", () => {
      run("powershell", [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(ROOT, "scripts", "make-icon.ps1"),
        "-Source",
        ICON_SOURCE,
        "-Out",
        ICON,
      ]);
    });
  } else {
    console.log("• 复用已有图标 build\\ctxfold.ico");
  }
} else {
  step("生成图标 build\\ctxfold.ico（程序化）", () => {
    run(process.execPath, [path.join(ROOT, "scripts", "make-icon.mjs")]);
  });
}

// 3) 编译外壳
step("编译桌面外壳 dist\\ctxfold-app.exe", () => {
  const csc = findCsc();
  console.log(`• 编译器 ${csc}`);
  const args = [
    "/nologo",
    "/target:winexe",
    "/platform:anycpu",
    "/optimize+",
    "/warn:4",
    `/out:${OUT}`,
    `/win32icon:${ICON}`,
    `/resource:${BACKEND},ctxfold.exe`,
    `/resource:${path.join(ASSETS, "avatar.png")},avatar.png`,
    "/r:System.dll",
    "/r:System.Core.dll",
    "/r:System.Drawing.dll",
    "/r:System.Windows.Forms.dll",
    "/r:System.Web.Extensions.dll",
    SOURCE,
  ];
  const res = spawnSync(csc, args, { cwd: ROOT, encoding: "utf8" });
  const out = `${res.stdout || ""}${res.stderr || ""}`.trim();
  if (out) console.log(out);
  if (res.status !== 0) throw new Error(`csc 退出码 ${res.status}`);
});

const size = (fs.statSync(OUT).size / 1024 / 1024).toFixed(1);
console.log(`\n完成 → ${OUT}  (${size} MB)`);
console.log("双击它就是一个窗口程序；也可以跑 `ctxfold app` 打开。");
