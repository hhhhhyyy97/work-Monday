@echo off
rem Ensure the local workspace server is running, then open it in an app window.
powershell -NoProfile -WindowStyle Hidden -Command "if (-not (Get-NetTCPConnection -LocalPort 4178 -State Listen -ErrorAction SilentlyContinue)) { Start-Process -FilePath 'C:\Users\Owner\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' -ArgumentList 'serve.js' -WorkingDirectory 'C:\Users\Owner\Documents\New project\workspace' -WindowStyle Hidden; Start-Sleep -Seconds 1 }"
start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --app=http://127.0.0.1:4178/?mode=flow
