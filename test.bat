@echo off
pushd "%~dp0"
where bun >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Bun not found. Install: https://bun.com/docs/installation
  exit /b 1
)
bun test --parallel --max-concurrency=4 tests/unit tests/integration %*
popd
