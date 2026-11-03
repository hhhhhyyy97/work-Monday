const plan = {
  summary: "Mock plan used to verify orchestration without calling a model.",
  assumptions: ["The target repository is valid."],
  work_items: [
    {
      id: "item-1",
      title: "Implement the requested change",
      acceptance_criteria: ["The requested behavior is covered by a focused test."],
      files_to_touch: ["src", "tests"],
    },
  ],
  risks: ["Mock mode does not validate domain correctness."],
  verification_strategy: ["Run the configured repository checks."],
};

const review = {
  verdict: "pass",
  summary: "Mock review passed.",
  findings: [],
  checks: [
    {
      name: "mock review",
      status: "pass",
      evidence: "Mock provider does not inspect source files.",
    },
  ],
};

export class MockProvider {
  name = "mock";

  async run({ role, onEvent }) {
    onEvent?.({
      type: "agent.progress",
      message: `Mock ${role} is working`,
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    if (role === "planner") return JSON.stringify(plan, null, 2);
    if (role.endsWith("reviewer")) return JSON.stringify(review, null, 2);
    return [
      `# Mock ${role}`,
      "",
      "Completed the mock handoff.",
      "",
      "No files were changed. Use the Codex provider for a real run.",
    ].join("\n");
  }
}
