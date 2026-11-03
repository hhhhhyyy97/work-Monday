# AGENTS.md - 多 Agent 协作契约

本文件适用于仓库内的 Codex、Pi、DeepSeek Harness、WorkBuddy 和未来新增的 Agent。

## 角色边界

- Planner / Coordinator：负责拆解、验收条件和统筹，不直接给自己或 Builder 发通过结论。
- Builder：唯一允许实现产品代码的角色。默认使用 Pi；旧版云端链路可使用 WorkBuddy。
- Reviewer：只读检查，必须引用文件、行号、测试或命令证据。
- Verifier：运行真实命令，不把模型判断当作测试结果。
- Human：决定是否批准、合并和发布。
- Orchestrator：负责状态和触发，不做内容判断。

## 不可违反的规则

1. 不自我评审。
2. 每条 finding 必须有证据，格式为
   `[P0-P3] 文件:行 | 问题 | 证据 | 建议`。
3. Builder 必须逐条回应评审：同意并修复、反对并举证、或延期并说明。
4. 未配置验证命令时，不得宣称改动已通过测试。
5. CI 和必要评审未通过时不得合并。
6. 不提交模型 key、GitHub token、会话日志、运行缓存或 `node_modules`。
7. 不覆盖或清理与当前任务无关的用户修改。

## 本地 Pi x DSH 工作流

- Parent DSH 使用 `subagent_pi_review` 做只读侦查与审查。
- Parent DSH 使用 `subagent_pi` 做实现。
- 每次 Pi 子 Agent 调用必须自带任务、文件路径、验收条件和审查证据。
- DSH 团队协议见 `.dsh/skills/pi-dsh-team/SKILL.md`。
- DSH bundle 见 `agentflow/dsh-plugin/`。

## AgentFlow

- 入口：`agentflow/src/cli.mjs`
- Provider：`pi`、`codex`、`mock`
- 默认从目标仓库 `HEAD` 创建独立 worktree。
- 运行记录位于 `agentflow/runs/`，该目录不提交。
- 只有 Builder/Fixer 步骤可写；Reviewer 和 Verifier 必须保持只读。

## GitHub 云端链路

- `codex-software-review`：所有代码改动必打。
- `codex-methodology-review`：算法、模型、统计、评估或业务规则改动时添加。
- `@codex review` 触发评审。
- WorkBuddy 不自行合并 PR。

## 验证命令

```powershell
cd agentflow
node --test

cd ../examples/inventory-tool
node --test

cd ../..
python -m unittest discover -s tests -v
```

## Code Review Rules

- 数值计算必须有明确的数值稳定性和边界测试。
- 测试必须真实有效，禁止跳过断言或只修改测试掩盖实现问题。
- 新行为必须覆盖错误路径、空值、重复数据和外部存储失败（适用时）。
- UI 改动必须在桌面和移动视口下验证，不允许文本重叠或页面横向溢出。
- 路径校验、命令执行、凭据处理和文件写入必须考虑注入与路径穿越。
