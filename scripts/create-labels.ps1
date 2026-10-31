param(
  [Parameter(Mandatory = $true)]
  [string]$Repo
)

$labels = @(
  @{ name = "codex-software-review";    color = "0E8A16"; description = "Codex software review trigger" },
  @{ name = "codex-methodology-review"; color = "1D76DB"; description = "Codex methodology review trigger" }
)

foreach ($label in $labels) {
  gh label create $label.name `
    --repo $Repo `
    --color $label.color `
    --description $label.description `
    --force
}
