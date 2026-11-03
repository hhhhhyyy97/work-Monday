$ErrorActionPreference = "Stop"

$source = Join-Path $PSScriptRoot "..\skills\pi-dsh-team"
$skillsRoot = Join-Path $HOME ".dsh\skills"
$target = Join-Path $skillsRoot "pi-dsh-team"

if (-not (Test-Path -LiteralPath $source)) {
  throw "Skill source not found: $source"
}

New-Item -ItemType Directory -Force -Path $skillsRoot | Out-Null
Copy-Item -LiteralPath $source -Destination $target -Recurse -Force
Write-Output "Installed Pi x DSH skill: $target"
