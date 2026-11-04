$logPath = Join-Path $env:TEMP "agentflow-launcher.log"
$stdoutPath = Join-Path $env:TEMP "agentflow-service.stdout.log"
$stderrPath = Join-Path $env:TEMP "agentflow-service.stderr.log"

$listener = Get-NetTCPConnection -LocalPort 4178 -State Listen -ErrorAction SilentlyContinue
if ($listener) {
  try {
    $activeRuns = (Invoke-RestMethod -Uri "http://127.0.0.1:4178/api/agentflow/runs?limit=100" -TimeoutSec 3).runs |
      Where-Object { $_.status -eq "running" -or $_.status -like "waiting_*" }
    if ($activeRuns) {
      "Service has active or waiting runs; restart skipped." | Out-File -LiteralPath $logPath -Encoding utf8 -Append
      exit 0
    }
  } catch {
  }
  $existingPid = $listener[0].OwningProcess
  Stop-Process -Id $existingPid -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
}

$node = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if (-not (Test-Path -LiteralPath $node)) {
  "Node.js not found: $node" | Out-File -LiteralPath $logPath -Encoding utf8 -Append
  exit 1
}

"Starting service as $(whoami): $PSScriptRoot" | Out-File -LiteralPath $logPath -Encoding utf8 -Append
$process = Start-Process -FilePath $node -ArgumentList "serve.js" -WorkingDirectory $PSScriptRoot -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -WindowStyle Hidden -PassThru
$started = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
  Start-Sleep -Milliseconds 500
  if ($process.HasExited) { break }
  if (Get-NetTCPConnection -LocalPort 4178 -State Listen -ErrorAction SilentlyContinue) {
    $started = $true
    break
  }
}
if (-not $started) {
  if ($process.HasExited) {
    "Service exited with code $($process.ExitCode). See $stderrPath" | Out-File -LiteralPath $logPath -Encoding utf8 -Append
  } else {
    "Service did not listen on 4178 within 15 seconds. See $stderrPath" | Out-File -LiteralPath $logPath -Encoding utf8 -Append
  }
  exit 1
}
if (-not (Get-NetTCPConnection -LocalPort 4178 -State Listen -ErrorAction SilentlyContinue)) {
  "Service is not listening on 4178. See $stderrPath" | Out-File -LiteralPath $logPath -Encoding utf8 -Append
  exit 1
}
"Service started with PID $($process.Id)." | Out-File -LiteralPath $logPath -Encoding utf8 -Append
