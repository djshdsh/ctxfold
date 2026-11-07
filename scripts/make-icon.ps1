# 把一张 PNG 转成多尺寸 .ico（GDI+ 缩放 + PNG 压缩帧）
param(
  [Parameter(Mandatory = $true)][string]$Source,
  [Parameter(Mandatory = $true)][string]$Out,
  [int[]]$Sizes = @(16, 24, 32, 48, 64, 128, 256),
  [double]$Radius = 0.22
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$src = [System.Drawing.Image]::FromFile($Source)
try {
  # 居中裁成正方形
  $side = [Math]::Min($src.Width, $src.Height)
  $sx = [int](($src.Width - $side) / 2)
  $sy = [int](($src.Height - $side) / 2)
  $square = New-Object System.Drawing.Bitmap $side, $side, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g0 = [System.Drawing.Graphics]::FromImage($square)
  $g0.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g0.DrawImage($src, (New-Object System.Drawing.Rectangle 0, 0, $side, $side), (New-Object System.Drawing.Rectangle $sx, $sy, $side, $side), [System.Drawing.GraphicsUnit]::Pixel)
  $g0.Dispose()

  $frames = @()
  foreach ($size in $Sizes) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)

    # 圆角遮罩
    $r = [int]($size * $Radius)
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $path.AddArc(0, 0, $d, $d, 180, 90)
    $path.AddArc($size - $d, 0, $d, $d, 270, 90)
    $path.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
    $path.AddArc(0, $size - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    $g.SetClip($path)
    $g.DrawImage($square, (New-Object System.Drawing.Rectangle 0, 0, $size, $size))
    $g.ResetClip()

    # 细边框，缩到 16px 也不糊
    if ($size -ge 32) {
      $penW = [Math]::Max(1.0, $size / 64.0)
      $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(60, 255, 255, 255)), $penW
      $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
      $inset = $penW / 2.0
      $path2 = New-Object System.Drawing.Drawing2D.GraphicsPath
      $d2 = $r * 2
      $path2.AddArc($inset, $inset, $d2, $d2, 180, 90)
      $path2.AddArc($size - $d2 - $inset, $inset, $d2, $d2, 270, 90)
      $path2.AddArc($size - $d2 - $inset, $size - $d2 - $inset, $d2, $d2, 0, 90)
      $path2.AddArc($inset, $size - $d2 - $inset, $d2, $d2, 90, 90)
      $path2.CloseFigure()
      $g.DrawPath($pen, $path2)
      $pen.Dispose()
      $path2.Dispose()
    }
    $g.Dispose()
    $path.Dispose()

    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $frames += , @{ Size = $size; Bytes = $ms.ToArray() }
    $ms.Dispose()
    $bmp.Dispose()
  }

  # 组装 ICO
  $outDir = Split-Path -Parent $Out
  if ($outDir -and -not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }
  $fs = [System.IO.File]::Create($Out)
  $bw = New-Object System.IO.BinaryWriter $fs
  $bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$frames.Count)
  $offset = 6 + 16 * $frames.Count
  foreach ($f in $frames) {
    $dim = if ($f.Size -ge 256) { 0 } else { $f.Size }
    $bw.Write([Byte]$dim); $bw.Write([Byte]$dim)
    $bw.Write([Byte]0); $bw.Write([Byte]0)
    $bw.Write([UInt16]1); $bw.Write([UInt16]32)
    $bw.Write([UInt32]$f.Bytes.Length); $bw.Write([UInt32]$offset)
    $offset += $f.Bytes.Length
  }
  foreach ($f in $frames) { $bw.Write($f.Bytes) }
  $bw.Flush(); $bw.Dispose(); $fs.Dispose()

  $kb = [Math]::Round((Get-Item $Out).Length / 1KB, 1)
  "icon -> $Out  ($($Sizes -join '/') px, $kb KB)"
} finally {
  $src.Dispose()
}
