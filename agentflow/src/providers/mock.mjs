const plan = {
  summary: "用于验证编排流程的模拟规划，不调用真实模型。",
  assumptions: ["目标仓库有效。"],
  work_items: [
    {
      id: "item-1",
      title: "实现请求的改动",
      acceptance_criteria: ["请求的行为由聚焦测试覆盖。"],
      files_to_touch: ["src", "tests"],
    },
  ],
  risks: ["模拟模式不会验证领域正确性。"],
  verification_strategy: ["运行仓库配置的检查命令。"],
};

const review = {
  verdict: "pass",
  summary: "模拟评审通过。",
  findings: [],
  checks: [
    {
      name: "模拟评审",
      status: "pass",
      evidence: "模拟 Provider 不检查源代码。",
    },
  ],
};

export class MockProvider {
  name = "mock";

  async run({ role, onEvent }) {
    const roleText =
      {
        planner: "规划者",
        scout: "仓库侦察者",
        architect: "架构师",
        builder: "构建者",
        fixer: "修复者",
        "software-reviewer": "软件评审者",
        "methodology-reviewer": "方法论评审者",
        "security-reviewer": "安全评审者",
        verifier: "验证者",
      }[role] || role;
    onEvent?.({
      type: "agent.progress",
      message: `模拟 ${roleText} 正在工作`,
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    if (role === "planner") return JSON.stringify(plan, null, 2);
    if (role.endsWith("reviewer")) return JSON.stringify(review, null, 2);
    return [
      `# 模拟 ${roleText}`,
      "",
      "已完成模拟交接。",
      "",
      "未修改任何文件。真实运行请选择 Codex 或 Pi Provider。",
    ].join("\n");
  }
}
