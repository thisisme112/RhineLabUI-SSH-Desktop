# Capture the desktop window, OS-drawn caption included.
#
#   powershell -ExecutionPolicy Bypass -File scripts/capture-desktop-window.ps1
#
# The smoke run's shots come from `capturePage()`, which is the web contents
# only — the title bar overlay Windows draws is never in them, so a change to
# the window's chrome cannot be reviewed from those screenshots alone.
#
# `PrintWindow` with PW_RENDERFULLCONTENT asks DWM to render the window, frame
# and all, into a bitmap. Unlike a screen grab it works without raising the
# window and cannot pick up whatever else the user has open — which a plain
# CopyFromScreen does, and did.
#
# It runs against a throwaway profile unless told otherwise, so a capture meant
# for the repository never contains the user's own saved hosts.
param(
  [string]$Out = "verification/desktop-window/window.png",
  [int]$WaitSeconds = 35,
  [int]$SettleSeconds = 20,
  [string]$ProfileDir = "",
  [switch]$UseRealProfile,
  # Point at a packaged build to capture that instead of the dev runtime.
  [string]$Executable = "",
  [string[]]$ExtraArguments = @()
)

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Pw {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$root = Split-Path -Parent $PSScriptRoot
$packaged = [bool]$Executable
if (-not $packaged) {
  $Executable = Join-Path $root "node_modules\electron\dist\electron.exe"
  if (-not (Test-Path $Executable)) { Write-Output "electron not installed"; exit 1 }
}
if (-not [System.IO.Path]::IsPathRooted($Out)) { $Out = Join-Path $root $Out }
New-Item -ItemType Directory -Force (Split-Path -Parent $Out) | Out-Null

# A packaged build is its own app root; the dev runtime needs the project path.
$entry = if ($packaged) { @() } else { @(".") }
$arguments = $entry + $ExtraArguments
if (-not $UseRealProfile) {
  if (-not $ProfileDir) { $ProfileDir = Join-Path $env:TEMP "rhine-chrome-capture-$PID" }
  New-Item -ItemType Directory -Force $ProfileDir | Out-Null
  $arguments += "--user-data-dir=$ProfileDir"
}
Write-Output "profile=$(if ($UseRealProfile) { 'default' } else { $ProfileDir })"
Write-Output "exe=$Executable"
$proc = Start-Process -FilePath $Executable -ArgumentList $arguments -WorkingDirectory $root -PassThru
try {
  $handle = [IntPtr]::Zero
  for ($i = 0; $i -lt ($WaitSeconds * 2); $i++) {
    Start-Sleep -Milliseconds 500
    $proc.Refresh()
    if ($proc.MainWindowHandle -ne [IntPtr]::Zero) { $handle = $proc.MainWindowHandle; break }
  }
  if ($handle -eq [IntPtr]::Zero) { Write-Output "NO_WINDOW_HANDLE"; exit 1 }

  # The app boots through a cinematic; give it long enough to reach the archive.
  Start-Sleep -Seconds $SettleSeconds

  $rect = New-Object Pw+RECT
  [void][Pw]::GetWindowRect($handle, [ref]$rect)
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  Write-Output "rect=${width}x${height} visible=$([Pw]::IsWindowVisible($handle))"
  if ($width -le 0 -or $height -le 0) { Write-Output "BAD_RECT"; exit 1 }

  $bmp = New-Object System.Drawing.Bitmap($width, $height)
  $gfx = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $gfx.GetHdc()
  # 2 = PW_RENDERFULLCONTENT, which is what makes DWM-composited content render.
  $ok = [Pw]::PrintWindow($handle, $hdc, 2)
  $gfx.ReleaseHdc($hdc)
  $gfx.Dispose()
  Write-Output "PrintWindow=$ok"
  $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output "saved=$Out"
} finally {
  if (-not $proc.HasExited) { $proc.Kill() }
}
