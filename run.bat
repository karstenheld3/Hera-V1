@echo off
pushd "%~dp0"
bun run src/index.ts %*
popd
