---
name: pi-dsh-team
description: Run a multi-agent software workflow where DeepSeek Harness plans and judges while Pi implements and performs independent read-only reviews.
whenToUse: Use for nontrivial repository changes that benefit from planning, an isolated builder, parallel reviews, and a human merge gate.
---

# Pi + DeepSeek Harness Team

Use the DSH parent as coordinator. Do not edit product files from the parent when the
Pi subagent tools are available.

## Required tools

- `subagent_pi`: one-shot Pi agent with write tools.
- `subagent_pi_review`: one-shot Pi agent restricted to `read`, `grep`, `find`, and `ls`.

If either tool is unavailable, stop and explain that the `@local/dsh-pi-agent-team`
bundle is not loaded.

## Workflow

1. Read the task and repository instructions. Decide whether a dedicated Git worktree
   is needed. Never work directly on a dirty default branch.
2. Write a compact plan with observable acceptance criteria and a list of likely files.
3. Start two `subagent_pi_review` tasks in parallel:
   - Repository scout: relevant modules, tests, commands, invariants, and unrelated files.
   - Solution architect: file-level design, failure modes, compatibility, and test plan.
4. Wait for both results. Resolve contradictions before implementation.
5. Call `subagent_pi` with a self-contained implementation brief containing:
   - the original task and acceptance criteria;
   - both read-only handoffs;
   - the worktree path and base commit;
   - commands to run;
   - the requirement to avoid commit, merge, rebase, reset, and unrelated edits.
6. Run the repository's verification commands from the DSH parent. Record exact output.
7. Start three `subagent_pi_review` tasks in parallel:
   - software correctness, edge cases, contracts, regression risk, and tests;
   - methodology, algorithms, statistics, metrics, and reproducibility when relevant;
   - security, command injection, path traversal, secrets, and destructive operations.
   Give each reviewer the base commit, task, builder summary, verification output, and
   instructions to inspect `git diff <base>`.
8. Require every finding in this format:
   `[P0-P3] file:line | problem | evidence | recommendation`.
9. If any P0/P1 finding or failed verification remains, call `subagent_pi` again with
   the complete findings and require a finding-by-finding response.
10. Do not declare success from model opinion alone. Stop only when all configured
    commands pass and all required reviews have a pass verdict or a written rebuttal.
11. Present the diff, files changed, commands run, review verdicts, residual risks, and
    a human merge decision. Do not commit, push, or merge.

## Evidence rules

- Never invent command output.
- Never let the builder review its own work.
- Keep review artifacts unchanged.
- Prefer no change over speculative refactoring.
- If the workflow cannot run due to Pi authentication or missing tools, report the
  exact failed prerequisite instead of simulating a successful run.
