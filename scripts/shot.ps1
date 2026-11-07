# capture + ui automation helper (local verification only, ASCII source)
param(
  [string]$Out = (Join-Path (Split-Path -Parent $PSScriptRoot) "build"),
  [switch]$All
)
$ErrorActionPreference = "Stop"
$OutputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing, System.Windows.Forms, UIAutomationClient, UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class ShotApi {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$proc = Get-Process ctxfold-app -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $proc) { throw "ctxfold-app not running" }
$proc.Refresh()
$h = $proc.MainWindowHandle
if ($h -eq [IntPtr]::Zero) { throw "no main window handle" }
[void][ShotApi]::ShowWindow($h, 9)
[void][ShotApi]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 600

function Save-Shot([string]$name) {
  $r = New-Object ShotApi+RECT
  [void][ShotApi]::GetWindowRect($h, [ref]$r)
  $bmp = New-Object System.Drawing.Bitmap ($r.Right - $r.Left), ($r.Bottom - $r.Top)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  [void][ShotApi]::PrintWindow($h, $hdc, 2)
  $g.ReleaseHdc($hdc); $g.Dispose()
  $path = Join-Path $Out "$name.png"
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output $path
}

function Click-Name([string]$name) {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($h)
  $c = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::NameProperty, $name)
  $el = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $c)
  if (-not $el) { Write-Output "missing:$name"; return }
  $r = $el.Current.BoundingRectangle
  $x = [int]($r.Left + $r.Width / 2)
  $y = [int]($r.Top + $r.Height / 2)
  [void][ShotApi]::SetCursorPos($x, $y)
  Start-Sleep -Milliseconds 120
  [ShotApi]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 60
  [ShotApi]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  Write-Output "clicked:$name@$x,$y"
}
function Click-ButtonUnused([string]$name) {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($h)
  $c1 = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Button)
  $c2 = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::NameProperty, $name)
  $and = New-Object System.Windows.Automation.AndCondition($c1, $c2)
  $el = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $and)
  if (-not $el) { Write-Output "missing:$name"; return }
  $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
  Write-Output "clicked:$name"
}

function Click-Tab([int]$index) {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($h)
  $c = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::NameProperty, "概览")
  $el = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $c)
  if (-not $el) { Write-Output "missing:tabbar"; return }
  $b = $el.Current.BoundingRectangle
  $x = [int]($b.Left + 52 + $index * 104)
  $y = [int]($b.Top + $b.Height / 2)
  [void][ShotApi]::SetCursorPos($x, $y)
  Start-Sleep -Milliseconds 120
  [ShotApi]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 60
  [ShotApi]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  Write-Output "tab$index@$x,$y"
}
if ($All) {
  Save-Shot "s1-overview"
  Click-Tab 1; Start-Sleep -Milliseconds 1500
  Save-Shot "s2-layers"
  Click-Tab 2; Start-Sleep -Milliseconds 1000
  Click-Name "预览裁剪"; Start-Sleep -Milliseconds 2200
  Save-Shot "s3-preview"
  Click-Tab 3; Start-Sleep -Milliseconds 1500
  Save-Shot "s4-maintenance"
} else {
  Save-Shot "shot"
}
