@echo off
set ELECTRON_RUN_AS_NODE=
cd /d "C:\Users\Donie\WorkBuddy AI\OpenDecks"
rem Rebuild renderer/app.js from src/ so the launch always runs the current code.
call npm run build > "%TEMP%\opendecks-launch.log" 2>&1
if errorlevel 1 (
  echo BUILD_FAILED=%ERRORLEVEL% >> "%TEMP%\opendecks-launch.log"
  echo Build failed. See %TEMP%\opendecks-launch.log
  pause
  exit /b 1
)
"node_modules\electron\dist\electron.exe" . >> "%TEMP%\opendecks-launch.log" 2>&1
echo EXIT_CODE=%ERRORLEVEL% >> "%TEMP%\opendecks-launch.log"
