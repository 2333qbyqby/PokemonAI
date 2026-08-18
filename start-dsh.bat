@echo off
chcp 65001 >nul 2>&1
title DeepSeek Harness

echo ========================================
echo   DeepSeek Harness - 一键启动
echo ========================================
echo.

REM Kill existing process on port 3080
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3080 ^| findstr LISTENING') do (
    echo [提示] 检测到端口 3080 被占用, 正在释放...
    taskkill /PID %%a /F >nul 2>&1
    timeout /t 1 /nobreak >nul
)

REM Set PATH to ensure Node.js is found
set "PATH=E:\Web\JSdevelopTools;%PATH%"

REM Check Node.js
node --version >nul 2>&1
if errorlevel 1 (
    echo [错误] 未检测到 Node.js, 请先安装 Node.js 22+
    pause
    exit /b 1
)

for /f "delims=" %%v in ('node -e "console.log(process.versions.node.split('.')[0])"') do set "NODE_MAJOR=%%v"
if %NODE_MAJOR% LSS 22 (
    echo [错误] Node.js 版本过低, 当前为 v%%v, 需要 22 或更高版本
    node --version
    pause
    exit /b 1
)

echo [信息] Node.js 版本: 
node --version
echo.

echo [信息] 正在启动 DeepSeek Harness...
echo [信息] 启动成功后将自动打开浏览器
echo.

start "" cmd /c "timeout /t 8 /nobreak >nul && start http://127.0.0.1:3080"

npx @deepseek-ai/dsh web

if errorlevel 1 (
    echo.
    echo [错误] DeepSeek Harness 启动失败
    pause
)
