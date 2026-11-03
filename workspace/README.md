# 多 Agent 桌面工作区

把「会话 / 并行分支 / 运行过程 / 交付文件」放在同一个界面里，光线从执行方与气泡连到同色的工作树节点，方便追溯一次任务从开始到结束。

基于 [Lancer](https://github.com/raylee-ai/lancer) 的 **Light UI**（MIT）忠实移植为无构建的纯 JS，并接入我们的多 Agent 工作流（WorkBuddy 构建 → Codex 评审 → GitHub Actions 编排 → 合并）。

当前界面同时接入本地 `agentflow` 编排器：Planner / Scout / Architect / Builder /
三类 Reviewer / Verifier 的真实运行事件会直接映射为 Lancer 工作树节点。执行器可选
Pi 或 Codex；DSH 侧的 Pi subagent provider 位于 `agentflow/dsh-plugin`。

## 打开

演示和 GitHub 实时模式可以静态打开；`AgentFlow` 模式需要本地 API，推荐双击
`launch.cmd`，或在本目录执行：

```powershell
node serve.js
```

然后打开 <http://localhost:4178>。

## 文件

- `index.html` —— 页面骨架
- `style.css` —— 布局与样式（沿用 Light UI 的视觉）
- `running-border.css` —— 运行中的流动边框
- `light-ui.js` —— Lancer Light UI 的无构建移植（`createLightLayer` / `svgElement`）
- `app.js` —— 本工作流的数据与交互
- `../agentflow/` —— 多 Agent 编排器、Pi/Codex Provider、运行状态与隔离 worktree
- `../agentflow/dsh-plugin/` —— DeepSeek Harness 的 Pi subagent bundle

## 数据来源

- `演示`：Lancer Light UI 的固定演示数据，不冒充真实执行。
- `AgentFlow`：从 `/api/agentflow/runs` 读取真实状态和事件，可启动、续看和批准运行。
- `GitHub 实时`：读取指定公开仓库的 branches、commits、PR 与 Actions 摘要。

AgentFlow 的事件以稳定 `stepId`、`parentIds` 和 `role` 关联，不按坐标猜测上游。
历史运行只重建节点，不重播旧光线；新事件才触发 Lancer Light UI 动画。

## 说明

光线、分叉合并、多会话并行、流动边框、暂停/重置、`prefers-reduced-motion` 等能力均来自 Lancer Light UI；本目录只做数据映射与少量文案调整，未另写一套动效。
