#!/usr/bin/env bash
set -euo pipefail

REPO="${1:?usage: create-labels.sh owner/repo}"

create() {
  gh label create "$1" --repo "$REPO" --color "$2" --description "$3" --force
}

create codex-software-review 0E8A16 "Codex software review trigger"
create codex-methodology-review 1D76DB "Codex methodology review trigger"
