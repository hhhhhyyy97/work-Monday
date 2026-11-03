import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { RunStore } from "../src/store.mjs";
import { runWorkflow } from "../src/workflow.mjs";

const execFileAsync = promisify(execFile);

async function createRepository() {
  const root = await mkdtemp(path.join(tmpdir(), "agentflow-test-"));
  await writeFile(path.join(root, "README.md"), "# Test repository\n", "utf8");
  await execFileAsync("git", ["init", "-b", "main"], { cwd: root });
  await execFileAsync(
    "git",
    ["-c", "user.name=AgentFlow Test", "-c", "user.email=test@example.invalid", "add", "."],
    { cwd: root },
  );
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=AgentFlow Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "initial",
    ],
    { cwd: root },
  );
  return root;
}

test("runs planning, parallel review, verification, and delivery in an isolated worktree", async () => {
  const source = await createRepository();
  const runsRoot = await mkdtemp(path.join(tmpdir(), "agentflow-runs-"));
  const previousRoot = process.env.AGENTFLOW_RUNS_ROOT;
  process.env.AGENTFLOW_RUNS_ROOT = runsRoot;
  try {
    const state = await runWorkflow({
      task: "记录测试仓库的说明。",
      workspace: source,
      provider: "mock",
      maxRounds: 1,
      reviewers: ["software", "methodology", "security"],
      verifyCommands: ['node -e "console.log(\'verified\')"'],
      approval: "auto",
      isolateWithWorktree: true,
    });

    assert.equal(state.status, "completed");
    assert.equal(state.finalVerdict, "pass");
    assert.equal(state.rounds, 1);
    assert.equal(state.reviews.length, 3);
    assert.ok(state.steps.some((step) => step.id === "scout"));
    assert.ok(state.steps.some((step) => step.id === "architect"));
    assert.ok(state.steps.some((step) => step.id === "build-1"));
    assert.ok(state.steps.some((step) => step.id === "review-1-security"));
    assert.ok(state.steps.some((step) => step.id === "verify-1-1"));

    const worktreeStats = await stat(state.executionWorkspace);
    assert.equal(worktreeStats.isDirectory(), true);
    assert.notEqual(state.executionWorkspace, source);

    const store = new RunStore(runsRoot);
    const events = await store.events(state.id);
    assert.ok(events.length > 10);
    for (let index = 0; index < events.length; index += 1) {
      assert.equal(events[index].seq, index + 1);
    }

    const report = await readFile(
      path.join(store.runDir(state.id), "artifacts", "final-report.md"),
      "utf8",
    );
    assert.match(report, /状态：通过/);
    assert.match(report, /评审结论/);
    assert.match(report, /verified/);
  } finally {
    if (previousRoot === undefined) delete process.env.AGENTFLOW_RUNS_ROOT;
    else process.env.AGENTFLOW_RUNS_ROOT = previousRoot;
  }
});

test("waits for human approval before completing", async () => {
  const source = await createRepository();
  const runsRoot = await mkdtemp(path.join(tmpdir(), "agentflow-runs-"));
  const previousRoot = process.env.AGENTFLOW_RUNS_ROOT;
  process.env.AGENTFLOW_RUNS_ROOT = runsRoot;
  try {
    const running = runWorkflow({
      task: "验证人工批准闸门。",
      workspace: source,
      provider: "mock",
      maxRounds: 1,
      reviewers: ["software"],
      verifyCommands: [],
      approval: "required",
      isolateWithWorktree: true,
      runId: "approval-test",
    });

    const store = new RunStore(runsRoot);
    let state;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      state = await store.load("approval-test");
      if (state?.status === "waiting_approval") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(state.status, "waiting_approval");
    await store.approve("approval-test", "测试批准");
    const completed = await running;
    assert.equal(completed.status, "completed");
    assert.ok(completed.steps.some((step) => step.id === "approval" && step.status === "done"));
  } finally {
    if (previousRoot === undefined) delete process.env.AGENTFLOW_RUNS_ROOT;
    else process.env.AGENTFLOW_RUNS_ROOT = previousRoot;
  }
});
