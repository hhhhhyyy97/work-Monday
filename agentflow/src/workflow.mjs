import { execFile } from "node:child_process";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { RunStore } from "./store.mjs";
import { createProvider } from "./providers/index.mjs";
import {
  now,
  parseJsonLoose,
  readJson,
  runCommand,
  slug,
  trimMiddle,
} from "./utils.mjs";

const execFileAsync = promisify(execFile);
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const agentflowRoot = path.resolve(moduleDir, "..");
const promptRoot = path.join(agentflowRoot, "prompts");
const schemaRoot = path.join(agentflowRoot, "schemas");

const DEFAULT_CONFIG = {
  maxRounds: 2,
  reviewers: ["software", "methodology", "security"],
  verifyCommands: [],
  approval: "auto",
  isolateWithWorktree: true,
};

const REVIEW_META = {
  software: {
    role: "software-reviewer",
    label: "软件评审",
    prompt: "software-review.md",
    color: "#0f766e",
  },
  methodology: {
    role: "methodology-reviewer",
    label: "方法论评审",
    prompt: "methodology-review.md",
    color: "#8b5e34",
  },
  security: {
    role: "security-reviewer",
    label: "安全评审",
    prompt: "security-review.md",
    color: "#9f3b45",
  },
};

export async function readPrompt(name) {
  return readFile(path.join(promptRoot, name), "utf8");
}

export function schemaPath(name) {
  return path.join(schemaRoot, `${name}.schema.json`);
}

export async function loadWorkflowConfig(workspace, overrides = {}) {
  const fromFile = await readJson(path.join(workspace, "agentflow.config.json"), {});
  const config = {
    ...DEFAULT_CONFIG,
    ...fromFile,
    ...Object.fromEntries(
      Object.entries(overrides).filter(([, value]) => value !== undefined),
    ),
  };
  config.maxRounds = Math.max(1, Math.min(5, Number(config.maxRounds) || 2));
  config.reviewers = [...new Set(config.reviewers)].filter((name) => REVIEW_META[name]);
  if (!config.reviewers.length) config.reviewers = [...DEFAULT_CONFIG.reviewers];
  config.verifyCommands = Array.isArray(config.verifyCommands) ? config.verifyCommands : [];
  return config;
}

function newRunId(task) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${stamp}-${slug(task, 30)}-${suffix}`;
}

async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function gitOutput(cwd, args) {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    error.message = `在 ${cwd} 执行 git ${args.join(" ")} 失败\n${error.message}`;
    throw error;
  }
}

async function prepareExecutionWorkspace(options, store, runId) {
  if (!options.isolateWithWorktree) {
    return {
      path: options.workspace,
      baseSha: await gitOutput(options.workspace, ["rev-parse", "HEAD"]),
      branch: await gitOutput(options.workspace, ["branch", "--show-current"]),
      isolated: false,
    };
  }

  const root = await gitOutput(options.workspace, ["rev-parse", "--show-toplevel"]);
  const baseSha = await gitOutput(root, ["rev-parse", "HEAD"]);
  const branch = `agentflow/${runId.slice(0, 44)}`;
  const worktreePath = path.join(store.runDir(runId), "repo");
  if (await pathExists(worktreePath)) {
    throw new Error(`Worktree path already exists: ${worktreePath}`);
  }
  await mkdir(path.dirname(worktreePath), { recursive: true });
  await execFileAsync("git", ["worktree", "add", "-b", branch, worktreePath, baseSha], {
    cwd: root,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    path: worktreePath,
    baseSha,
    branch,
    isolated: true,
    sourceRoot: root,
  };
}

function jsonBlock(value) {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function reviewerPrompt(review, context) {
  const names = review.findings
    .map((finding) => `[${finding.severity}] ${finding.file}:${finding.line} ${finding.title}`)
    .join("\n");
  return `评审轮次：第 ${context.round} 轮
基线提交：${context.baseSha}
工作树：${context.workspace}

任务：
${context.task}

检查当前工作树和 \`git diff ${context.baseSha}\`。只评审本次任务 diff，不评审无关的历史改动。

构建者摘要：
${trimMiddle(context.builderOutput, 12000)}

验证结果：
${trimMiddle(context.verificationSummary, 12000)}

之前的评审意见：
${names || "无"}

本角色评审重点：${review.label}。
所有面向用户的文本必须使用简体中文；verdict 和 severity 保持 Schema 要求。
只返回符合指定 JSON Schema 的 JSON。`;
}

function parseReview(text, role) {
  try {
    const parsed = parseJsonLoose(text);
    if (!["pass", "changes", "block"].includes(parsed.verdict)) {
      throw new Error("verdict 枚举无效。");
    }
    if (!Array.isArray(parsed.findings) || !Array.isArray(parsed.checks)) {
      throw new Error("findings 和 checks 必须是数组。");
    }
    return parsed;
  } catch (error) {
    return {
      verdict: "changes",
      summary: `${role} 返回了无法解析的评审结果：${error.message}`,
      findings: [
        {
          severity: "P1",
          file: "（评审产物）",
          line: 1,
          title: "评审输出不符合要求的 Schema",
          evidence: trimMiddle(text, 2500),
          recommendation: "使用有效的 JSON 输出重新执行评审。",
        },
      ],
      checks: [
        {
          name: "评审协议",
          status: "fail",
          evidence: error.message,
        },
      ],
    };
  }
}

function hasRequiredFix(reviews) {
  return reviews.some(
    (review) =>
      review.verdict !== "pass" ||
      review.findings.some((finding) => finding.severity === "P0" || finding.severity === "P1"),
  );
}

function checksSummary(checks) {
  return checks
    .map(
      (check) =>
        `${(check.exitCode === 0 ? "通过" : "失败")} ${check.command}（退出码 ${check.exitCode}，耗时 ${check.durationMs}ms）\n${trimMiddle(
          `${check.stdout}\n${check.stderr}`.trim(),
          5500,
        )}`,
    )
    .join("\n\n");
}

async function waitForApproval(store, runId, timeoutMs = 30 * 60 * 1000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const approval = await store.approval(runId);
    if (approval?.approved) return approval;
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
  throw new Error("等待人工批准超时。");
}

export async function runWorkflow(options) {
  const workspace = path.resolve(options.workspace || process.cwd());
  const config = await loadWorkflowConfig(workspace, {
    maxRounds: options.maxRounds,
    reviewers: options.reviewers,
    verifyCommands: options.verifyCommands,
    approval: options.approval,
    isolateWithWorktree: options.isolateWithWorktree,
  });
  const provider = createProvider(options.provider || "codex");
  const runId = options.runId || newRunId(options.task);
  const store = new RunStore(process.env.AGENTFLOW_RUNS_ROOT || agentflowRoot);
  await store.init(runId);

  const state = {
    id: runId,
    task: options.task,
    sourceWorkspace: workspace,
    executionWorkspace: null,
    provider: provider.name,
    status: "running",
    phase: "preparing",
    createdAt: now(),
    updatedAt: now(),
    lastSeq: 0,
    rounds: 0,
    maxRounds: config.maxRounds,
    reviewers: config.reviewers,
    approval: config.approval,
    steps: [],
    reviews: [],
    verification: [],
    error: null,
    finalVerdict: null,
    artifacts: [],
  };
  await store.save(runId, state);

  const emit = async (event) => {
    try {
      const written = await store.event(runId, event);
      state.lastSeq = written.seq;
      return written;
    } catch (error) {
      options.onEvent?.({ type: "log.error", message: error.message });
      return null;
    }
  };

  const update = async (patch) => {
    Object.assign(state, patch);
    await store.save(runId, state);
  };

  const addStep = async (step) => {
    state.steps.push({
      startedAt: now(),
      finishedAt: null,
      status: "running",
      summary: "",
      artifact: null,
      ...step,
    });
    await update({});
    await emit({
      type: "step.started",
      role: step.role,
      stepId: step.id,
      label: step.label,
      parentIds: step.parentIds || [],
      message: `开始执行：${step.label}`,
    });
    return state.steps.find((item) => item.id === step.id);
  };

  const finishStep = async (step, patch) => {
    Object.assign(step, {
      status: "done",
      finishedAt: now(),
      ...patch,
    });
    await update({});
    await emit({
      type: "step.finished",
      role: step.role,
      stepId: step.id,
      label: step.label,
      status: step.status,
      message: patch.summary || `已完成：${step.label}`,
    });
  };

  const failStep = async (step, error) => {
    Object.assign(step, {
      status: "failed",
      finishedAt: now(),
      summary: error.message,
    });
    await update({});
    await emit({
      type: "step.failed",
      role: step.role,
      stepId: step.id,
      label: step.label,
      message: `执行失败：${error.message}`,
    });
  };

  const executeAgentStep = async ({
    id,
    role,
    label,
    parentIds = [],
    prompt,
    schema,
    writeAccess = false,
  }) => {
    const step = await addStep({ id, role, label, parentIds, writeAccess });
    try {
      const lastMessagePath = await store.log(runId, `${id}.last-message.txt`);
      const logPath = await store.log(runId, `${id}.jsonl`);
      const text = await provider.run({
        role,
        prompt,
        cwd: state.executionWorkspace,
        schemaPath: schema ? schemaPath(schema) : undefined,
        writeAccess,
        lastMessagePath,
        logPath,
        onEvent: (event) =>
          emit({
            ...event,
            role,
            stepId: id,
            label,
          }),
      });
      const artifact = await store.artifact(runId, `${id}.md`, text);
      const relativeArtifact = path
        .relative(store.runDir(runId), artifact)
        .split(path.sep)
        .join("/");
      if (!state.artifacts.includes(relativeArtifact)) state.artifacts.push(relativeArtifact);
      let summary = text.split(/\r?\n/).find((line) => line.trim())?.slice(0, 240) || label;
      if (schema) {
        try {
          summary = parseJsonLoose(text).summary || summary;
        } catch {}
      }
      await finishStep(step, {
        summary,
        artifact: relativeArtifact,
      });
      return { text, step };
    } catch (error) {
      await failStep(step, error);
      throw error;
    }
  };

  try {
    await emit({
      type: "run.started",
      message: options.task,
      data: {
        provider: provider.name,
        maxRounds: config.maxRounds,
        reviewers: config.reviewers,
      },
    });

    const execution = await prepareExecutionWorkspace(
      { ...config, workspace },
      store,
      runId,
    );
    await update({
      executionWorkspace: execution.path,
      baseSha: execution.baseSha,
      branch: execution.branch,
      isolated: execution.isolated,
      phase: "planning",
    });
    await emit({
      type: "workspace.ready",
      role: "orchestrator",
      message: execution.isolated
        ? `隔离 worktree 已就绪：${execution.branch}`
        : "正在源工作区中运行",
      data: execution,
    });

    const planner = await executeAgentStep({
      id: "plan",
      role: "planner",
      label: "规划与验收标准",
      prompt: `${await readPrompt("planner.md")}

用户任务：
${options.task}

仓库：${execution.path}
基线提交：${execution.baseSha}`,
      schema: "plan",
    });
    let plan;
    try {
      plan = parseJsonLoose(planner.text);
    } catch (error) {
      plan = {
        summary: planner.text,
        assumptions: [],
        work_items: [],
        risks: [`规划者输出不是有效结构化结果：${error.message}`],
        verification_strategy: [],
      };
    }
    await store.artifact(runId, "plan.json", `${JSON.stringify(plan, null, 2)}\n`);

    const [scout, architect] = await Promise.all([
      executeAgentStep({
        id: "scout",
        role: "scout",
        label: "仓库扫描",
        parentIds: ["plan"],
        prompt: `${await readPrompt("scout.md")}

用户任务：
${options.task}

规划：
${jsonBlock(plan)}`,
      }),
      executeAgentStep({
        id: "architect",
        role: "architect",
        label: "实现方案设计",
        parentIds: ["plan"],
        prompt: `${await readPrompt("architect.md")}

用户任务：
${options.task}

规划：
${jsonBlock(plan)}`,
      }),
    ]);

    let builderArtifact = null;
    let latestReviews = [];
    let latestChecks = [];
    let latestBuilderText = "";
    let previousReviewText = "";
    let finalVerdict = "changes";

    for (let round = 1; round <= config.maxRounds; round += 1) {
      state.rounds = round;
      await update({ phase: round === 1 ? "building" : "fixing" });
      const buildId = `build-${round}`;
      const parentIds = round === 1 ? ["plan", "scout", "architect"] : [`review-${round - 1}`];
      const buildPrompt =
        round === 1
          ? `${await readPrompt("builder.md")}

用户任务：
${options.task}

规划者：
${jsonBlock(plan)}

仓库侦察者：
${scout.text}

架构师：
${architect.text}`
          : `${await readPrompt("fixer.md")}

用户任务：
${options.task}

规划：
${jsonBlock(plan)}

上一轮构建者摘要：
${trimMiddle(latestBuilderText, 12000)}

评审意见：
${previousReviewText}

验证失败：
${trimMiddle(checksSummary(latestChecks), 12000)}`;
      const built = await executeAgentStep({
        id: buildId,
        role: round === 1 ? "builder" : "fixer",
        label: round === 1 ? "实现构建" : `第 ${round - 1} 轮评审修复`,
        parentIds,
        prompt: buildPrompt,
        writeAccess: true,
      });
      latestBuilderText = built.text;
      builderArtifact = built.step.artifact;

      let diff = "";
      try {
        diff = await gitOutput(state.executionWorkspace, ["diff", execution.baseSha]);
      } catch (error) {
        diff = `无法读取任务 diff：${error.message}`;
      }
      await store.artifact(runId, `round-${round}.patch`, diff);

      await update({ phase: "verifying" });
      latestChecks = [];
      for (let index = 0; index < config.verifyCommands.length; index += 1) {
        const command = config.verifyCommands[index];
        const verificationStep = await addStep({
          id: `verify-${round}-${index + 1}`,
          role: "verifier",
          label: `运行验证：${command}`,
          parentIds: [buildId],
        });
        const result = await runCommand(command, {
          cwd: state.executionWorkspace,
          timeoutMs: 15 * 60 * 1000,
          onData: () => {},
        });
        latestChecks.push(result);
        await store.artifact(
          runId,
          `verify-${round}-${index + 1}.log`,
          `$ ${command}\n\n标准输出\n${result.stdout}\n\n标准错误\n${result.stderr}\n\n退出码 ${result.exitCode}\n`,
        );
        if (result.exitCode === 0) {
          await finishStep(verificationStep, {
            summary: `验证通过，耗时 ${result.durationMs}ms`,
          });
        } else {
          await failStep(verificationStep, new Error(`退出码 ${result.exitCode}`));
        }
      }
      state.verification.push({ round, checks: latestChecks });

      await update({ phase: "reviewing" });
      const verificationSummary = latestChecks.length
        ? checksSummary(latestChecks)
        : "未配置确定性验证命令。";
      const reviewJobs = config.reviewers.map(async (reviewName) => {
        const meta = REVIEW_META[reviewName];
        const reviewStepId = `review-${round}-${reviewName}`;
        const reviewed = await executeAgentStep({
          id: reviewStepId,
          role: meta.role,
          label: `${meta.label} · 第 ${round} 轮`,
          parentIds: [buildId],
          prompt: `${await readPrompt(meta.prompt)}

${reviewerPrompt(
  { label: meta.label, findings: [] },
  {
    round,
    task: options.task,
    baseSha: execution.baseSha,
    workspace: state.executionWorkspace,
    builderOutput: latestBuilderText,
    verificationSummary,
  },
)}`,
          schema: "review",
        });
        const parsed = parseReview(reviewed.text, meta.role);
        await store.artifact(
          runId,
          `${reviewStepId}.json`,
          `${JSON.stringify(parsed, null, 2)}\n`,
        );
        return {
          round,
          name: reviewName,
          role: meta.role,
          label: meta.label,
          artifact: reviewed.step.artifact,
          ...parsed,
        };
      });
      latestReviews = await Promise.all(reviewJobs);
      state.reviews.push(...latestReviews);

      const reviewSummaryStep = await addStep({
        id: `review-${round}`,
        role: "coordinator",
        label: `质量闸门 · 第 ${round} 轮`,
        parentIds: latestReviews.map((_, index) => `review-${round}-${config.reviewers[index]}`),
      });
      const verificationFailed = latestChecks.some((check) => check.exitCode !== 0);
      const needsFix = hasRequiredFix(latestReviews) || verificationFailed;
      finalVerdict = needsFix ? "changes" : "pass";
      previousReviewText = latestReviews
        .map(
          (review) =>
            `## ${review.label}: ${review.verdict}\n${review.summary}\n${review.findings
              .map(
                (finding) =>
                  `- [${finding.severity}] ${finding.file}:${finding.line} ${finding.title}\n  证据：${finding.evidence}\n  建议：${finding.recommendation}`,
              )
              .join("\n")}`,
        )
        .join("\n\n");
      await finishStep(reviewSummaryStep, {
        status: needsFix ? "changes" : "done",
        summary: needsFix
          ? "至少一个评审者或验证命令要求修改。"
          : "所有必需的评审和验证闸门均已通过。",
      });
      if (!needsFix) break;
      if (round === config.maxRounds) break;
    }

    await update({ phase: "approval", finalVerdict });
    if (finalVerdict === "pass" && config.approval === "required") {
      const approvalStep = await addStep({
        id: "approval",
        role: "human",
        label: "人工批准",
        parentIds: [`review-${state.rounds}`],
      });
      await update({ status: "waiting_approval" });
      await emit({
        type: "run.waiting_approval",
        role: "human",
        stepId: "approval",
        label: "人工批准",
        message: "所有检查均已通过。批准隔离 worktree 后完成交付。",
      });
      const approval = await waitForApproval(store, runId);
      await finishStep(approvalStep, {
        summary: approval.note ? `人工批准：${approval.note}` : "已由人工批准。",
      });
    }

    const report = [
      `# AgentFlow 运行报告 ${runId}`,
      "",
      `状态：${finalVerdict === "pass" ? "通过" : "需要修改"}`,
      `任务：${options.task}`,
      `执行器：${provider.name}`,
      `源工作区：${workspace}`,
      `执行工作区：${state.executionWorkspace}`,
      `分支：${state.branch || "（原地运行）"}`,
      `基线提交：${state.baseSha}`,
      `轮次：${state.rounds}`,
      "",
      "## 评审结论",
      ...latestReviews.map(
        (review) =>
          `- ${review.label}：**${{ pass: "通过", changes: "需修改", block: "阻塞" }[review.verdict] || review.verdict}** — ${review.summary}`,
      ),
      "",
      "## 验证结果",
      latestChecks.length
        ? checksSummary(latestChecks)
        : "未配置验证命令。在将此结果视为可发布质量前，请先配置 `verifyCommands`。",
      "",
      "## 交付说明",
      state.isolated
        ? `改动保留在隔离 worktree 中。请人工复核并合并分支：${state.branch}`
        : "工作流在源工作区中运行。提交前请人工复核未提交的 diff。",
    ].join("\n");
    await store.artifact(runId, "final-report.md", report);
    if (!state.artifacts.includes("artifacts/final-report.md")) {
      state.artifacts.push("artifacts/final-report.md");
    }
    const patchArtifact = `artifacts/round-${state.rounds}.patch`;
    if (!state.artifacts.includes(patchArtifact)) state.artifacts.push(patchArtifact);
    const finalStatus = finalVerdict === "pass" ? "completed" : "changes_required";
    await update({
      status: finalStatus,
      phase: "delivered",
      finalVerdict,
      completedAt: now(),
    });
    await emit({
      type: "run.finished",
      role: "coordinator",
      status: finalStatus,
      message:
        finalVerdict === "pass"
          ? "工作流已完成，仍需人工合并。"
          : `已达到评审轮次上限，共收到 ${latestReviews.length} 条评审结论，仍需修改。`,
    });
    return state;
  } catch (error) {
    await update({
      status: "failed",
      phase: "failed",
      error: error.stack || error.message,
    });
    await emit({
      type: "run.failed",
      role: "orchestrator",
      message: `运行失败：${error.message}`,
    });
    throw error;
  }
}

export function isGitAvailable() {
  return pathExists(".git");
}
