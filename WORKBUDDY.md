# WorkBuddy - Cloud Builder

WorkBuddy 是可选的外部 Builder，用于 GitHub Actions / PR 标签链路。本地 Pi x DSH
工作流默认使用 `subagent_pi`，不要求 WorkBuddy 在线。

## 触发

- `/workbuddy build <任务>`：开始构建并打开 PR。
- `/workbuddy respond`：读取新评审并逐条回应。

## 职责

1. 按任务实现代码并添加测试。
2. 打开 PR，添加 `codex-software-review`；涉及算法、模型或统计时再加
   `codex-methodology-review`。
3. 对每条 finding 给出明确回应。
4. 修复后推送并请求复审。

## 禁止

- 不自行合并 PR。
- 不给自己打通过标签。
- 不静默忽略 finding。
- 不伪造测试结果。
- 不提交凭据、运行缓存或无关文件。
