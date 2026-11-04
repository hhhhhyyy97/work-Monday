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

## 选择目标仓库

目标仓库可以直接从最近使用列表选择，也可以点击「浏览目录」在页面内查看用户目录、
桌面、文档、当前项目和磁盘入口。含 `.git` 的目录会标记为「Git 仓库」，选中后会显示
仓库名、当前分支和未提交改动数。

## 产出物预览

运行完成后，左侧会话中的产出物按钮会在页面内打开预览，可直接查看 Markdown、patch
和评审记录，也可在新标签打开或下载文件。

## 运行目录与隔离

服务优先把运行记录写入 `../agentflow/runs`。如果当前启动上下文无权写该目录，会自动
改用 `%TEMP%\agentflow\runs`，界面仍会合并展示旧目录和新目录中的历史运行。

隔离执行优先创建 Git worktree；如果服务进程无权写源仓库的 `.git` 元数据，则会在运行
目录中创建独立仓库副本并继续执行。源仓库不会被修改。

如服务未启动，请检查 `%TEMP%\agentflow-launcher.log`、
`%TEMP%\agentflow-service.stdout.log` 和 `%TEMP%\agentflow-service.stderr.log`。

## 人工交互

评审达到轮次上限但仍有未关闭意见时，工作流会进入“等待人工处理”并先生成阶段性报告。
可以选择追加一轮评审、接受当前结果，或结束并生成最终报告。

如果执行步骤遇到工具缺失、登录失效或权限拒绝，工作台会暂停对应步骤，并提出“已处理，
重试”或“结束并生成报告”。人工选择会写入运行记录，后续报告会包含处理备注。

## 文件

- `index.html` —— 页面骨架
- `style.css` —— 布局与样式（沿用 Light UI 的视觉）
- `running-border.css` —— 运行中的流动边框
- `light-ui.js` —— Lancer Light UI 的无构建移植（`createLightLayer` / `svgElement`）
- `app.js` —— 本工作流的数据与交互
- `../agentflow/` —— 多 Agent 编排器、Pi/Codex Provider、运行状态与隔离工作区
- `../agentflow/dsh-plugin/` —— DeepSeek Harness 的 Pi subagent bundle

## 数据来源

- `演示`：Lancer Light UI 的固定演示数据，不冒充真实执行。
- `AgentFlow`：从 `/api/agentflow/runs` 读取真实状态和事件，可启动、续看和批准运行。
- `GitHub 实时`：读取指定公开仓库的 branches、commits、PR 与 Actions 摘要。

AgentFlow 的事件以稳定 `stepId`、`parentIds` 和 `role` 关联，不按坐标猜测上游。
历史运行只重建节点，不重播旧光线；新事件才触发 Lancer Light UI 动画。

## 说明

光线、分叉合并、多会话并行、流动边框、暂停/重置、`prefers-reduced-motion` 等能力均来自 Lancer Light UI；本目录只做数据映射与少量文案调整，未另写一套动效。
