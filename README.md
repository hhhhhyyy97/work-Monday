# Multi-Agent Team Framework

一个以 GitHub 为中心、让多个 AI Agent 相互协作的开发工作流骨架，改编自
[`jaharris87/agentic-dev-framework`](https://github.com/jaharris87/agentic-dev-framework)。

## 角色分工

| 角色 | 承担者 | 职责 | 调用 AI |
| --- | --- | --- | --- |
| 统筹 / 质量裁判 | Codex | 汇总软件评审 + 方法论评审，给出 通过/需修改/阻塞 判定，追踪闭环 | 是 |
| 软件评审 | Codex | bug、边界条件、测试缺口、API 一致性、文档与实现一致 | 是 |
| 方法论评审 | Codex | 领域正确性、算法/模型/统计口径、指标对齐、可复现性 | 是 |
| 构建者 Builder | WorkBuddy（Kimi 3.1 Pro） | 写代码、开 PR、打 review 标签、逐条回应评审 | 是 |
| 编排器 Orchestrator | GitHub Actions | 监听标签、分发评审触发、维护状态；不做 AI 推理 | 否 |

## 一句话架构

WorkBuddy 写代码 → 开 PR 并打标签 → GitHub Actions 检测标签发 `@codex review` →
Codex 以「软件评审 + 方法论评审」两个视角审查并给 verdict → WorkBuddy 逐条回应并修改 →
循环直到 Codex 判定「通过」。

## 架构图

```text
┌───────────────────────────┐
│ WorkBuddy（Kimi 3.1 Pro） │  builder
│ 写代码 / 开 PR / 打标签 / 回应评审 │
└────────────┬──────────────┘
             │ open PR + labels
             ▼
      ┌────────────┐
      │  GitHub PR  │
      └──────┬─────┘
             │ labeled event
             ▼
  ┌──────────────────────────┐
  │  GitHub Actions           │  编排器（机械触发，不调 AI）
  │  按标签发 @codex review    │
  └────────────┬─────────────┘
               │
               ▼
  ┌──────────────────────────┐
  │  Codex                    │  统筹 + 评审团
  │  软件评审 / 方法论评审      │
  │  给 verdict               │
  └────────────┬─────────────┘
               │ 评审意见
               ▼
  WorkBuddy 逐条回应 → 修复 → push → 循环
```

## PR 评审闭环

1. WorkBuddy 打开 PR，按改动内容打标签：`codex-software-review` 必打；涉及算法/模型/统计/评估/业务规则时加打 `codex-methodology-review`。
2. GitHub Actions 捕获 `labeled` 事件，按标签发布对应的 `@codex review` 评论。
3. Codex 读取 `.github/prompts/detailed/` 中的 rubric，完成两个视角的评审，给 verdict。
4. WorkBuddy 逐条回应每个 finding：同意并修复 / 反对并给证据 / 延期并说明原因。
5. 未回应的 finding 一律按「需修改」处理，循环直到 verdict 为「通过」。
6. CI 通过且全部必要评审通过后，由人或合并权限方合并；WorkBuddy 不自行合并。

## 目录结构

```text
multi-agent-team/
├── README.md                          # 本文件：架构、角色、快速开始
├── AGENTS.md                          # 所有 Agent 的总契约
├── WORKBUDDY.md                       # Builder 行动手册
├── .codex/
│   └── instructions.md                # Codex 的统筹 + 评审说明
├── .github/
│   ├── workflows/
│   │   ├── orchestrator.yml           # 编排器：标签触发评审
│   │   └── workbuddy-dispatch.yml     # 编排器：API 触发 Builder
│   └── prompts/
│       ├── software-review.md         # 发到评论里的一行触发词
│       ├── methodology-review.md
│       └── detailed/
│           ├── software-review.md     # 软件评审完整 rubric
│           └── methodology-review.md  # 方法论评审完整 rubric
├── docs/
│   └── workbuddy-api.md               # WorkBuddy API 契约
└── scripts/
    ├── create-labels.ps1              # Windows 创建标签
    └── create-labels.sh               # macOS/Linux 创建标签
```

## 命令协议

- `/workbuddy build <任务描述>`：让 WorkBuddy 开始构建，完成后开 PR 并打标签。
- `/workbuddy respond`：让 WorkBuddy 读取当前 PR 的新评审并逐条回应。
- 命令由人发布，或由 Codex（统筹）在评审结束后作为收尾信号发布。

## 快速开始

1. 把 `multi-agent-team/` 的内容作为项目根目录（或复制进已有仓库）。
2. 在 GitHub 创建仓库，新增 secret `CODEX_TRIGGER_PAT`：
   - 生成 fine-grained PAT，授权 `Pull requests: Read and write` 和 `Issues: Read and write`。
   - 原因：Codex 会忽略 `github-actions[bot]` 发布的评论，必须用真实用户身份发评论。
3. 配置 WorkBuddy API：
   - repo variable `WORKBUDDY_API_URL` = WorkBuddy 的 API 根地址。
   - repo secret `WORKBUDDY_API_TOKEN` = Bearer token。
4. 安装 GitHub CLI 后执行 `scripts/create-labels.ps1 owner/repo`（或 `.sh` 版本）创建标签。
5. 用 `/workbuddy build <任务>` 评论触发首个改动，WorkBuddy 完成后开 PR。
6. 到 Actions 和 PR 页面观察评审触发与闭环。

## 待确认 / 假设

- **WorkBuddy API 契约需对齐**：骨架按 `docs/workbuddy-api.md` 定义的 `POST /dispatch` 形状调用；如果你的 API 不同，改 `workbuddy-dispatch.yml` 的 `curl` 一步即可。
- **Codex 触发依赖 PAT**：这是本骨架里唯一必须配置的 secret。
- **Kimi 3.1 Pro 经 WorkBuddy 接入的授权方式**：API key / 企业授权需确认。
- **是否保留红队评审**：原框架还有 `codex-red-team-review`（对抗式证伪），可作为第三视角后续加。
- **仓库公开/私有**：决定 secret 管理和评审时的上下文可见性。

## 设计取舍

- 为什么 Codex 既统筹又评审：评审输出就是统筹的输入；Codex 不写产品代码，独立于 Builder，不存在「自己写自己审」。
- 为什么 GitHub Actions 不做 AI：把「机械编排」和「智能统筹」分开，避免在 Actions 里藏 prompt，降低密钥与 token 风险。
- 为什么强制 Builder 逐条回应：防止评审变成装饰，这是原框架里最有效的一条经验。
