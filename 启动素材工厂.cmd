@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set "FACTORY_NODE=node"
where node >nul 2>nul
if errorlevel 1 (
  set "FACTORY_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
)
if not exist "node_modules\vite\bin\vite.js" (
  echo 请先在本目录运行 npm install 安装依赖，再重新双击启动。
  pause
  exit /b 1
)
echo 正在启动 AI 素材工厂，浏览器将自动打开。
echo 使用期间请保留此窗口。按 Ctrl+C 可以停止服务。
"%FACTORY_NODE%" "node_modules\vite\bin\vite.js" --host 127.0.0.1 --open
pause
