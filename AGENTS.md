# AGENTS.md - 多 Agent 协作契约

本文件是所有进入本仓库的编码 Agent（Codex、WorkBuddy 及未来新 Agent）必须遵守的总契约。

## 角色

- Builder = WorkBuddy（Kimi 3.1 Pro，通过 API 驱动）。唯一允许写产品代码、提交、开 PR 的角色。
- Reviewer / 统筹 = Codex。唯一允许给出 通过/需修改/阻塞 判定和最终质量结论的角色。
- Orchestrator = GitHub Actions。只负责触发与状态，不做内容判断。

## 铁律

1. 不自我评审：Builder 不给自己打「通过」；Reviewer 不写产品代码。
2. 强制回应：Builder 必须逐条回应评审意见（同意修复 / 反对举证 / 延期说明），不得静默忽略。
3. 引用证据：任何评审结论必须指向具体文件/函数/测试；Builder 的反对也必须引用代码或设计依据。
4. 合并门槛：所有必要评审均为「通过」且 CI 通过后才能合并；Builder 不自行合并。
5. 每次 push 都需要明确授权，一次授权不延续到下一次。

## 标签协议

- `codex-software-review`：任何改动必打。
- `codex-methodology-review`：涉及算法、模型、统计口径、评估、业务规则时打。

可选扩展：`codex-red-team-review`。

## 命令协议

- `/workbuddy build <任务描述>`：调用 WorkBuddy API 开始构建，WorkBuddy 完成后开 PR 并打标签。
- `/workbuddy respond`：调用 WorkBuddy API，让 Builder 读取当前 PR 的新评审并逐条回应。
- 命令由人发布，或由 Codex（统筹）在评审结束后作为收尾信号发布。

## 评审输出格式

每条 finding：

```text
[严重度] 文件:行 | 问题 | 证据 | 建议
```

结尾 verdict：`通过` / `需修改` / `阻塞` + 一句话理由。
