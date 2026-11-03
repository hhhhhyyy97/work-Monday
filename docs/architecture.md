# Architecture

## Design Goals

The project keeps four concerns separate:

1. Model execution
2. Role and permission boundaries
3. Deterministic verification
4. Human approval and delivery

No single model is trusted to implement, review, verify, and merge the same change.

## DeepSeek Harness Path

DeepSeek Harness is the host and coordinator. Its profile loads the local bundle from
`agentflow/dsh-plugin/`, which registers two `ctx.subagents` providers:

| Provider | DSH tool | Permission |
| --- | --- | --- |
| `pi-write` | `subagent_pi` | Pi read, shell, edit, write |
| `pi-read` | `subagent_pi_review` | Pi read, grep, find, ls |

The parent Agent uses `subagent_pi_review` for planning support and independent review,
and `subagent_pi` for implementation. Pi processes are one-shot and receive a
self-contained task. DSH owns the parent session, children, cancellation, and completion
notifications.

The workflow protocol is installed as `.dsh/skills/pi-dsh-team/SKILL.md`.

## AgentFlow Path

AgentFlow is the standalone state machine used by the CLI and local dashboard.

```text
preparing
  -> planning
  -> building
  -> verifying + reviewing
  -> quality gate
       -> pass -> approval -> delivered
       -> changes -> fixing -> verifying + reviewing
       -> max rounds -> changes_required
```

Roles:

| Role | Responsibility | Write |
| --- | --- | --- |
| Planner | Task contract and acceptance criteria | No |
| Scout | Relevant modules, constraints, tests | No |
| Architect | File-level design and failure modes | No |
| Builder / Fixer | Implementation and focused tests | Yes |
| Software Reviewer | Correctness, regressions, test quality | No |
| Methodology Reviewer | Algorithms, statistics, metrics, reproducibility | No |
| Security Reviewer | Injection, secrets, path safety, destructive operations | No |
| Verifier | Configured shell commands | No |
| Coordinator | Deterministic quality gate | No |
| Human | Approval and merge | Yes |

## Isolation

By default AgentFlow requires a Git repository and creates:

```text
runs/<run-id>/repo
branch agentflow/<run-id>
base <source HEAD>
```

Reviews inspect `git diff <base>`. The final patch is written to
`artifacts/round-<n>.patch`. The source checkout is not modified.

## Event and Artifact Model

- `state.json`: current run state and accumulated reviews
- `events.jsonl`: ordered event stream consumed by the Lancer UI
- `artifacts/`: plans, role outputs, review JSON, patches, verification logs, final report
- `logs/`: provider JSONL and orchestrator errors

The UI uses stable `stepId` and `parentIds`; it never infers graph edges from coordinates.

## Providers

- `pi`: local Pi CLI, JSONL output, read-only and write tool sets
- `codex`: local Codex CLI, read-only reviewers and workspace-write builder
- `mock`: deterministic orchestration test provider

Provider credentials are never stored in run artifacts.
