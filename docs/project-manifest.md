# Project Manifest

## Components

| Component | Path | Status |
| --- | --- | --- |
| AgentFlow orchestrator | `agentflow/` | Working |
| Pi provider | `agentflow/src/providers/pi.mjs` | Implementation complete; Pi login required |
| Codex provider | `agentflow/src/providers/codex.mjs` | Working |
| Mock provider | `agentflow/src/providers/mock.mjs` | Working |
| DSH Pi subagent bundle | `agentflow/dsh-plugin/` | Bundle and config validation passed |
| DSH team skill | `.dsh/skills/pi-dsh-team/` | Installed locally; portable copy included |
| Lancer Light UI dashboard | `workspace/` | Working |
| GitHub PR review workflow | `.github/` | Included |
| Inventory example | `examples/inventory-tool/` | 19 tests passing |
| Moving-average Python example | `src/`, `tests/` | 7 tests passing |

## Local Endpoints

| Service | URL |
| --- | --- |
| AgentFlow dashboard | `http://127.0.0.1:4178/?mode=flow` |
| Inventory example | `http://127.0.0.1:4179/` |

Both services bind to the loopback interface.

## Verified Commands

```powershell
cd agentflow
pnpm install --frozen-lockfile --ignore-scripts
node --test

cd ../examples/inventory-tool
node --test

cd ../..
python -m unittest discover -s tests -v
```

## Generated Runtime Data

AgentFlow writes local runs to `agentflow/runs/`. Run data is intentionally excluded
from Git because it contains provider logs, local paths, and isolated worktrees.

The repository includes a sanitized run summary instead:
[`run-reports/inventory-tool.md`](run-reports/inventory-tool.md).

## Excluded From Git

- model credentials and OAuth tokens
- GitHub personal access tokens
- `node_modules`
- pnpm store and caches
- local worktrees
- provider JSONL logs
- temporary browser profiles and screenshots generated during smoke tests
