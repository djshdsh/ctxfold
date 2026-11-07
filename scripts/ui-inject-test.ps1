# 端到端：真窗口点「一键注入」把插件装进一个空目录
$OutputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8
$root = (Split-Path -Parent $PSScriptRoot)
$targetHome = Join-Path $root '.tmp-home'
Remove-Item $targetHome -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $targetHome -Force | Out-Null

Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class W32 {
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc cb, IntPtr p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  public static List<IntPtr> Kids(IntPtr root) {
    List<IntPtr> all = new List<IntPtr>();
    EnumChildWindows(root, delegate(IntPtr h, IntPtr p) { all.Add(h); return true; }, IntPtr.Zero);
    return all;
  }
  public static string Text(IntPtr h) { StringBuilder sb = new StringBuilder(512); GetWindowTextW(h, sb, 512); return sb.ToString(); }
  public static string Cls(IntPtr h) { StringBuilder sb = new StringBuilder(256); GetClassNameW(h, sb, 256); return sb.ToString(); }
}
"@

Get-Process ctxfold-app -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 600
$p = Start-Process -FilePath (Join-Path $root 'dist\ctxfold-app.exe') -ArgumentList @('--home', $targetHome) -PassThru
for ($i = 0; $i -lt 60; $i++) { Start-Sleep -Milliseconds 500; $p.Refresh(); if ($p.MainWindowHandle -ne 0) { break } }
Start-Sleep -Seconds 5
"窗口句柄 = $($p.MainWindowHandle)"

$kids = [W32]::Kids($p.MainWindowHandle)
"子窗口 $($kids.Count) 个"
$btn = [IntPtr]::Zero
foreach ($h in $kids) { if ([W32]::Text($h) -eq '一键注入' -and [W32]::Cls($h) -like '*BUTTON*') { $btn = $h; break } }
if ($btn -eq [IntPtr]::Zero) {
  '没找到「一键注入」按钮，按钮清单：'
  foreach ($h in $kids) { $t = [W32]::Text($h); if ($t) { "  [$( [W32]::Cls($h) )] $t" } }
  exit 1
}
"点按钮：$btn"
[W32]::PostMessage($btn, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null

Start-Sleep -Seconds 15
& (Join-Path $root 'scripts\shot.ps1') -Out (Join-Path $root 'build') | Out-Null
Copy-Item (Join-Path $root 'build\shot.png') (Join-Path $root 'build\s0-inject.png') -Force

'--- 目标目录内容 ---'
Get-ChildItem $targetHome -Recurse -File -ErrorAction SilentlyContinue |
  ForEach-Object { $_.FullName.Replace($targetHome, '') } | Sort-Object
