@echo off
setlocal EnableExtensions DisableDelayedExpansion
pushd "%~dp0" || exit /b 1
chcp 65001 >nul
set "BENCH_NODE=runtime\node.exe"
if not exist "%BENCH_NODE%" set "BENCH_NODE=node.exe"
"%BENCH_NODE%" "tools\control.cjs" start --open %*
set "BENCH_STATUS=%errorlevel%"
popd
if defined BENCH_NO_PAUSE exit /b %BENCH_STATUS%
if not "%BENCH_STATUS%"=="0" pause
exit /b %BENCH_STATUS%
