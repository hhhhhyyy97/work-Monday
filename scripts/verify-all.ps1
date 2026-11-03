$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot

Push-Location (Join-Path $root "agentflow")
try {
  if (-not (Test-Path -LiteralPath "node_modules")) {
    pnpm install --frozen-lockfile --ignore-scripts
  }
  node --test
} finally {
  Pop-Location
}

Push-Location (Join-Path $root "examples\inventory-tool")
try {
  node --test
} finally {
  Pop-Location
}

Push-Location $root
try {
  python -m unittest discover -s tests -v
} finally {
  Pop-Location
}

Write-Output "All checks passed."
