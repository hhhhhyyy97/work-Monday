# Model Configuration

This page records the model identities used by the local setup. Model aliases can change
when the local provider proxy or DSH account catalog changes.

## Active Routes

| Route | Model | Reasoning | Status |
| --- | --- | --- | --- |
| Codex CLI / AgentFlow `codex` | `deepseek-v4-flash` | `high` | Active |
| DSH parent Agent | `deepseek-flash` | `high` | Active |
| DSH allowed subagent model | `deepseek-flash` | inherited/configured | Active |
| Pi / AgentFlow `pi` | not configured | — | Installed, login required |

The Codex route uses a local OpenAI-compatible proxy. Its token and endpoint belong to
the local user configuration and must not be committed.

The DSH route uses provider `deepseek-account`. The desktop profile allows
`deepseek-account/deepseek-flash` for subagents.

## Configure Pi

Pi resolves models from its own authentication and model configuration:

```powershell
cd agentflow
node_modules\.bin\pi.cmd
# Run /login in the Pi TUI
```

Optional AgentFlow overrides:

```powershell
$env:AGENTFLOW_PI_PROVIDER = "deepseek"
$env:AGENTFLOW_PI_MODEL = "deepseek-chat"
$env:AGENTFLOW_PI_THINKING = "high"
```

Optional DSH plugin overrides use the same variables. `AGENTFLOW_PI_CLI` can point at a
specific Pi executable.

## Legacy

`Kimi 3.1 Pro` appears only in the optional WorkBuddy/GitHub Actions integration. It is
not the default local provider and is not required for AgentFlow.
