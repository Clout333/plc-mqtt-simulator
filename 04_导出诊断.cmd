@echo off
setlocal EnableExtensions DisableDelayedExpansion
"%SystemRoot%\System32\chcp.com" 65001 >nul
pushd "%~dp0" || exit /b 1
set "BENCH_NODE=runtime\node.exe"
if not exist "%BENCH_NODE%" set "BENCH_NODE=node.exe"
"%BENCH_NODE%" "tools\export-diagnostics.cjs" %*
set "BENCH_STATUS=%errorlevel%"
popd
if defined BENCH_NO_PAUSE exit /b %BENCH_STATUS%
pause
exit /b %BENCH_STATUS%
