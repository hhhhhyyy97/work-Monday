# Pi subagent providers for DeepSeek Harness

This DSH bundle registers two `ctx.subagents` providers:

- `pi-write` / `subagent_pi`: Pi coding agent with its normal file and shell tools.
- `pi-read` / `subagent_pi_review`: Pi with only `read`, `grep`, `find`, and `ls`.

The parent DSH session keeps planning, coordination, and final judgment. It delegates
implementation to Pi, and can launch several read-only Pi reviews in parallel.

## Prerequisites

1. DeepSeek Harness 0.2.1-rc.5 or a compatible build.
2. Pi 1.5.0, installed as this bundle's dependency.
3. Pi authentication configured once:

```powershell
pi auth check --provider deepseek
```

Or provide a provider key in the DSH process environment, for example
`DEEPSEEK_API_KEY` or `OPENAI_API_KEY`.

Optional environment variables:

```text
AGENTFLOW_PI_PROVIDER=deepseek
AGENTFLOW_PI_MODEL=deepseek-chat
AGENTFLOW_PI_THINKING=high
PI_CLI=C:\absolute\path\to\pi.exe
PI_NODE_BIN=C:\absolute\path\to\node.exe
```

## Install

Install this directory as a local DeepSeek Harness bundle from **插件** in the DSH
desktop app. The bundle declares `dsh.bundle` and adds both subagent tools.

After installation, restart DSH if the profile does not hot-reload. The parent agent
can then call `subagent_pi` and `subagent_pi_review`.

Install the workflow skill into the user-level DSH skill directory:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-skill.ps1
```

Then open a repository in DSH and run `/pi-dsh-team` or ask for a nontrivial code change.

## Workflow

1. DSH Planner identifies the goal and acceptance criteria.
2. DSH Scout and Reviewer inspect in parallel with `subagent_pi_review`.
3. DSH calls `subagent_pi` for the implementation.
4. DSH launches independent software, methodology, and security reviews.
5. DSH sends concrete findings back to `subagent_pi` until the checks pass.
6. A human reviews the worktree and merges.

The provider is one-shot: each call starts a fresh Pi process and returns only the
final assistant text. Parent conversation history is not inherited, so every task
must be self-contained.
