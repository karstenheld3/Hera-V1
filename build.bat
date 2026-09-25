@echo off
setlocal EnableExtensions

REM Hera V1 build pipeline launcher (HERAV1DIST-SP01 FR-03). Logic lives in build.ps1.
where pwsh >nul 2>nul
if errorlevel 1 (
  echo [ERROR] PowerShell 7 'pwsh' not found. Install: winget install Microsoft.PowerShell
  pause
  exit /b 1
)

pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0build.ps1" %*
if errorlevel 1 (
  echo.
  echo [ERROR] Build pipeline failed. See output above.
  pause
  exit /b 1
)

pause
exit /b 0
