@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set "PICTURE_NODE=node"
where node >nul 2>nul
if errorlevel 1 (
  set "PICTURE_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
)
if not exist "node_modules\tsx\dist\loader.mjs" (
  echo 请先在本目录运行 pnpm install 安装依赖。
  pause
  exit /b 1
)
if not exist "dist\index.html" (
  echo 请先在本目录运行 pnpm build 生成页面。
  pause
  exit /b 1
)
echo 正在启动 AI-picture。
echo 管理员请使用本机地址；员工请使用下方显示的局域网地址。
echo 使用期间保留此窗口，按 Ctrl+C 停止服务。
"%PICTURE_NODE%" --import tsx server/index.ts --open
pause
