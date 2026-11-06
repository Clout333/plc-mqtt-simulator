@echo off
setlocal EnableExtensions DisableDelayedExpansion
"%SystemRoot%\System32\chcp.com" 65001 >nul
title 工业设备联调台
echo 正在启动工业设备联调台，请稍候...
set "BENCH_STATUS=1"
pushd "%~dp0" || goto :bad_folder
if not exist "tools\control.cjs" goto :incomplete
set "BENCH_NODE=runtime\node.exe"
if exist "%BENCH_NODE%" goto :run
"%SystemRoot%\System32\where.exe" node.exe >nul 2>&1 || goto :incomplete
set "BENCH_NODE=node.exe"
:run
"%BENCH_NODE%" "tools\control.cjs" start --open %*
set "BENCH_STATUS=%errorlevel%"
goto :leave
:incomplete
echo 缺少启动文件或 Node.js。请将 Windows x64 离线包完整解压到可写文件夹，再双击启动。
:leave
popd
goto :finish
:bad_folder
echo 无法进入程序目录。请将离线包完整解压到本机可写文件夹，再双击启动。
:finish
if "%BENCH_STATUS%"=="1" echo 如需排查，请运行 04_导出诊断.cmd。
if defined BENCH_NO_PAUSE exit /b %BENCH_STATUS%
if not "%~1"=="" exit /b %BENCH_STATUS%
echo(
echo 按任意键关闭这个提示窗口。
pause >nul
exit /b %BENCH_STATUS%
