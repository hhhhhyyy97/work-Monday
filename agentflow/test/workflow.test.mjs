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

async function waitForStatus(store, runId, status) {
  let state;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    state = await store.load(runId);
    if (state?.status === status) return state;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${runId} to reach ${status}; current=${state?.status}`);
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
      autoContinueRounds: 0,
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

test("review limit requests a human decision and supports accepting the result", async () => {
  const source = await createRepository();
  const runsRoot = await mkdtemp(path.join(tmpdir(), "agentflow-runs-"));
  const previousRoot = process.env.AGENTFLOW_RUNS_ROOT;
  process.env.AGENTFLOW_RUNS_ROOT = runsRoot;
  try {
    const running = runWorkflow({
      task: "验证评审上限人工闸门。",
      workspace: source,
      provider: "mock",
      maxRounds: 1,
      autoContinueRounds: 0,
      reviewers: ["software"],
      verifyCommands: ['node -e "process.exit(1)"'],
      approval: "auto",
      isolateWithWorktree: true,
      runId: "review-limit-test",
    });
    const store = new RunStore(runsRoot);
    const waiting = await waitForStatus(store, "review-limit-test", "waiting_human");
    assert.equal(waiting.humanRequest.kind, "review_limit");
    assert.deepEqual(
      waiting.humanRequest.options.map((option) => option.id),
      ["extend", "accept", "stop"],
    );
    assert.ok(waiting.artifacts.includes("artifacts/final-report.md"));

    const reportBeforeDecision = await readFile(
      path.join(store.runDir("review-limit-test"), "artifacts", "final-report.md"),
      "utf8",
    );
    assert.match(reportBeforeDecision, /等待人工决定下一步/);

    await store.decide("review-limit-test", {
      requestId: waiting.humanRequest.id,
      actionId: "accept",
      note: "接受当前风险，后续人工复核。",
    });
    const completed = await running;
    assert.equal(completed.status, "completed");
    assert.equal(completed.finalVerdict, "accepted");
    assert.equal(completed.humanDecisions.length, 1);
    const finalReport = await readFile(
      path.join(store.runDir("review-limit-test"), "artifacts", "final-report.md"),
      "utf8",
    );
    assert.match(finalReport, /人工接受/);
    assert.match(finalReport, /接受当前结果/);
  } finally {
    if (previousRoot === undefined) delete process.env.AGENTFLOW_RUNS_ROOT;
    else process.env.AGENTFLOW_RUNS_ROOT = previousRoot;
  }
});

test("automatically continues fixing after the nominal review limit", async () => {
  const source = await createRepository();
  const runsRoot = await mkdtemp(path.join(tmpdir(), "agentflow-runs-"));
  const previousRoot = process.env.AGENTFLOW_RUNS_ROOT;
  process.env.AGENTFLOW_RUNS_ROOT = runsRoot;
  try {
    const state = await runWorkflow({
      task: "[MOCK_CHANGES_ROUNDS=1] 验证自动追加修复。",
      workspace: source,
      provider: "mock",
      maxRounds: 1,
      autoContinueRounds: 2,
      reviewers: ["software"],
      verifyCommands: [],
      approval: "auto",
      isolateWithWorktree: true,
      runId: "auto-continue-test",
    });
    assert.equal(state.status, "completed");
    assert.equal(state.finalVerdict, "pass");
    assert.equal(state.rounds, 2);
    assert.equal(state.maxRounds, 2);
    assert.equal(state.automaticExtensionsUsed, 1);
    assert.ok(state.steps.some((step) => step.id === "build-2"));
    const store = new RunStore(runsRoot);
    const events = await store.events("auto-continue-test");
    assert.ok(events.some((event) => event.type === "run.auto_continue"));
    const report = await readFile(
      path.join(store.runDir("auto-continue-test"), "artifacts", "final-report.md"),
      "utf8",
    );
    assert.match(report, /自动追加修复：1 轮/);
  } finally {
    if (previousRoot === undefined) delete process.env.AGENTFLOW_RUNS_ROOT;
    else process.env.AGENTFLOW_RUNS_ROOT = previousRoot;
  }
});

test("authorization errors pause for human retry or report generation", async () => {
  const source = await createRepository();
  const runsRoot = await mkdtemp(path.join(tmpdir(), "agentflow-runs-"));
  const previousRoot = process.env.AGENTFLOW_RUNS_ROOT;
  process.env.AGENTFLOW_RUNS_ROOT = runsRoot;
  try {
    const running = runWorkflow({
      task: "[MOCK_AUTH_REQUIRED] 验证工具授权人工闸门。",
      workspace: source,
      provider: "mock",
      maxRounds: 1,
      reviewers: ["software"],
      verifyCommands: [],
      approval: "auto",
      isolateWithWorktree: true,
      runId: "authorization-test",
    });
    const store = new RunStore(runsRoot);
    const waiting = await waitForStatus(store, "authorization-test", "waiting_human");
    assert.equal(waiting.humanRequest.kind, "authorization");
    assert.deepEqual(
      waiting.humanRequest.options.map((option) => option.id),
      ["retry", "stop"],
    );
    assert.ok(waiting.artifacts.includes("artifacts/final-report.md"));

    await store.decide("authorization-test", {
      requestId: waiting.humanRequest.id,
      actionId: "stop",
      note: "无法提供该工具。",
    });
    const stopped = await running;
    assert.equal(stopped.status, "changes_required");
    assert.equal(stopped.finalVerdict, "blocked");
    const report = await readFile(
      path.join(store.runDir("authorization-test"), "artifacts", "final-report.md"),
      "utf8",
    );
    assert.match(report, /需要人工处理/);
    assert.match(report, /结束并生成报告/);
  } finally {
    if (previousRoot === undefined) delete process.env.AGENTFLOW_RUNS_ROOT;
    else process.env.AGENTFLOW_RUNS_ROOT = previousRoot;
  }
});
