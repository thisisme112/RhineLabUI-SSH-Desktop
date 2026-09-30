@echo off
set "RHINE_UNREAL_REPO=%~dp0..\RhineLab-Unreal"
if not exist "%RHINE_UNREAL_REPO%\package.json" (
  echo RhineLab-Unreal repository is missing.
  exit /b 1
)
cd /d "%RHINE_UNREAL_REPO%"
call npm run start:dlss5
