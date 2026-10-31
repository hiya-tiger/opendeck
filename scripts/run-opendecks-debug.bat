@echo off
set ELECTRON_RUN_AS_NODE=
set ELECTRON_ENABLE_LOGGING=1
set ELECTRON_ENABLE_STACK_DUMPING=1
"C:\Users\Donie\WorkBuddy AI\OpenDecks\node_modules\electron\dist\electron.exe" --enable-logging . > "C:\Users\Donie\WorkBuddy AI\OpenDecks\scripts\opendecks-crash.log" 2>&1
echo EXIT_CODE=%ERRORLEVEL% >> "C:\Users\Donie\WorkBuddy AI\OpenDecks\scripts\opendecks-crash.log"
