# AgentFlow

本地多 Agent 编排器。输入一个任务和一个 Git 仓库，输出一条可追溯、可复审、
停留在人工批准闸门前的隔离分支。它既可以直接驱动 Pi / Codex，也可以作为
DeepSeek Harness 中 Pi subagent 工作流的独立可视化执行器。

## 为什么这样分工

来自 Agentic Dev Framework 的核心约束不是“多开几个模型”，而是让不同角色拥有
不同的证据和权限：

1. Planner 只定义验收条件，不能写代码。
2. Scout 和 Architect 并行读取仓库，减少单一路径误判。
3. Builder 是唯一写权限角色，并且不能给自己的实现下 verdict。
4. Reviewer 在只读沙箱里独立检查，结论必须引用文件、行号或测试。
5. Verifier 只执行配置好的确定性命令，不把模型判断冒充实测。
6. Coordinator 只根据 review 和命令结果驱动修复，最后一律交给 Human。

## 状态流

```text
preparing
  -> planning
  -> building
  -> verifying + reviewing (parallel)
  -> quality gate
       | pass -> approval -> delivered
       | changes -> fixing -> verifying + reviewing
       | max rounds -> changes_required
```

每次运行写入 `runs/<run-id>/events.jsonl`。Lancer 界面按 `stepId` 和 `parentIds`
绘制分叉与汇合，不通过动画坐标推断业务关系。

## 快速开始

```powershell
node src/cli.mjs run `
  --provider pi `
  --workspace "C:\path\to\repo" `
  --task "实现 X 并补充回归测试" `
  --verify "npm test" `
  --verify "npm run lint"
```

Pi provider 需要先完成一次模型登录：

```powershell
node_modules\.bin\pi.cmd
# 在 Pi TUI 中执行 /login
```

默认行为：

- 从目标仓库当前 `HEAD` 创建 `agentflow/<run-id>` 分支和独立 worktree。
- 使用 Pi 或 Codex CLI 运行各角色。
- 最多两轮实现与复审。
- 三类 Reviewer 全部默认启用。
- 全绿后自动结束，但不会 commit、merge 或 push。

需要人工闸门时：

```powershell
node src/cli.mjs run --approval required --task-file task.md --workspace .
node src/cli.mjs list
node src/cli.mjs approve <run-id> "已复核"
```

## 配置

目标仓库可以使用 `agentflow.config.json`：

```json
{
  "maxRounds": 2,
  "reviewers": ["software", "methodology", "security"],
  "verifyCommands": ["npm test", "npm run lint"],
  "approval": "required",
  "isolateWithWorktree": true
}
```

CLI 参数优先于配置文件。完整参数：

```powershell
node src/cli.mjs help
```

## Provider

- `pi`：调用随项目安装的 Pi 1.5.0。Builder 使用写工具，其他角色使用只读工具；
  需要先在 Pi 中配置模型凭据。
- `codex`：调用 `codex exec`。Builder 使用 `workspace-write`，其他角色使用
  `read-only`；所有角色都禁止审批交互并保存 JSONL 过程日志。
- `mock`：只用于验证状态机、界面和 API，不检查代码，也不会修改仓库。

DSH 内的对应实现见 [`dsh-plugin`](dsh-plugin/README.md)：DSH 父 Agent 使用
`subagent_pi` 委派实现，使用 `subagent_pi_review` 并行执行只读侦查与审查。

如果需要接入其他模型服务，在 `src/providers/` 增加一个实现
`run({ prompt, cwd, writeAccess, ... })` 的提供器即可。角色边界和验证逻辑不需要改。

## 产物

```text
runs/<run-id>/
  state.json
  events.jsonl
  artifacts/
    plan.json
    plan.md
    scout.md
    architect.md
    build-1.md
    review-1-software.json
    round-1.patch
    verify-1-1.log
    final-report.md
  logs/
  repo/                 # isolated Git worktree
```

`final-report.md` 是交付入口；`round-<n>.patch` 是从运行基线计算的代码差异。
即使 Builder 意外创建了 commit，review 和 patch 仍以记录的 `baseSha` 为基准。

## 清理

完成后先审阅 worktree。确认不需要后，从源仓库移除：

```powershell
git worktree list
git worktree remove "C:\path\to\agentflow\runs\<run-id>\repo"
```

运行记录不会自动删除，便于审计和复盘。
