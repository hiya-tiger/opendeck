@echo off
set ELECTRON_RUN_AS_NODE=
"C:\Users\Donie\WorkBuddy AI\OpenDecks\node_modules\electron\dist\electron.exe" "C:\Users\Donie\WorkBuddy AI\OpenDecks\scripts\diag-real-app.cjs" > "C:\Users\Donie\WorkBuddy AI\OpenDecks\scripts\diag-real-app-out.log" 2>&1
echo EXIT_CODE=%ERRORLEVEL% >> "C:\Users\Donie\WorkBuddy AI\OpenDecks\scripts\diag-real-app-out.log"
