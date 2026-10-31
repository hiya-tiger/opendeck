@echo off
set ELECTRON_RUN_AS_NODE=
cd /d "C:\Users\Donie\WorkBuddy AI\OpenDecks"
"node_modules\electron\dist\electron.exe" . > "%TEMP%\opendecks-launch.log" 2>&1
echo EXIT_CODE=%ERRORLEVEL% >> "%TEMP%\opendecks-launch.log"
