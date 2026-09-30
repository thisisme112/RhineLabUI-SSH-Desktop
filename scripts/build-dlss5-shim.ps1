# Builds Plugins/DLSS5ForUE5/Binaries/ThirdParty/Win64/RhineDLSS5_nvngx.dll, the
# caller shim that lets a packaged (monolithic) build pass the DLSS-NR runtime's
# caller check (see RhineDLSS5_nvngx.c). /Od keeps every forwarder a real call.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$plugin = Join-Path $root "prototypes/unreal/Plugins/DLSS5ForUE5"
$source = Join-Path $plugin "Source/ThirdParty/RhineDLSS5Shim/RhineDLSS5_nvngx.c"
$out = Join-Path $plugin "Binaries/ThirdParty/Win64"
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
$vcvars = Join-Path $vs "VC/Auxiliary/Build/vcvars64.bat"
New-Item -ItemType Directory -Force $out | Out-Null
$obj = Join-Path $env:TEMP "RhineDLSS5_nvngx.obj"
cmd /c "`"$vcvars`" >nul && cl /nologo /LD /Od /W3 /Fo`"$obj`" `"$source`" /Fe`"$out\RhineDLSS5_nvngx.dll`" /link /NOIMPLIB /NOEXP"
if ($LASTEXITCODE -ne 0) { throw "cl failed ($LASTEXITCODE)" }
Get-Item (Join-Path $out "RhineDLSS5_nvngx.dll") | Select-Object FullName, Length
