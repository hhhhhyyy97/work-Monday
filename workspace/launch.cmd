@echo off
rem Ensure the local workspace server is running, then open it in an app window.
echo [%date% %time%] %~f0 > "%TEMP%\agentflow-launcher.cmd.log"
whoami >> "%TEMP%\agentflow-launcher.cmd.log"
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0launch-server.ps1"
start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --app=http://127.0.0.1:4178/?mode=flow
