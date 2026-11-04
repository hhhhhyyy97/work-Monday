import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
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
  maxRounds: 3,
  autoContinueRounds: 3,
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
  config.autoContinueRounds = Math.max(
    0,
    Math.min(5, Number(config.autoContinueRounds) || 0),
  );
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
      isolation: "in-place",
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
  try {
    await execFileAsync("git", ["worktree", "add", "-b", branch, worktreePath, baseSha], {
      cwd: root,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    const details = [error?.stderr, error?.stdout, error?.message].filter(Boolean).join("\n");
    if (!/permission denied|access is denied|EPERM|EACCES|cannot lock ref/i.test(details)) {
      throw error;
    }
    await rm(worktreePath, { recursive: true, force: true });
    await execFileAsync(
      "git",
      ["clone", "--no-hardlinks", "--no-checkout", "--", root, worktreePath],
      {
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    await execFileAsync("git", ["checkout", "-B", branch, baseSha], {
      cwd: worktreePath,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });
    await execFileAsync("git", ["remote", "remove", "origin"], {
      cwd: worktreePath,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });
    return {
      path: worktreePath,
      baseSha,
      branch,
      isolated: true,
      isolation: "clone",
      sourceRoot: root,
    };
  }
  return {
    path: worktreePath,
    baseSha,
    branch,
    isolated: true,
    isolation: "worktree",
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

async function waitForHumanDecision(store, runId, requestId, timeoutMs = 30 * 60 * 1000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const decision = await store.humanDecision(runId);
    if (decision?.requestId === requestId) return decision;
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
  throw new Error("等待人工处理超时。");
}

function isAuthorizationError(error) {
  const details = [error?.stderr, error?.stdout, error?.message].filter(Boolean).join("\n");
  return /permission denied|access is denied|not permitted|requires? approval|approval required|unauthorized|forbidden|EACCES|EPERM|command not found|not recognized|tool[^\n]*(unavailable|not available)/i.test(
    details,
  );
}

export async function runWorkflow(options) {
  const workspace = path.resolve(options.workspace || process.cwd());
  const config = await loadWorkflowConfig(workspace, {
    maxRounds: options.maxRounds,
    autoContinueRounds: options.autoContinueRounds,
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
    autoContinueRounds: config.autoContinueRounds,
    automaticExtensionsUsed: 0,
    reviewers: config.reviewers,
    approval: config.approval,
    steps: [],
    reviews: [],
    verification: [],
    error: null,
    finalVerdict: null,
    artifacts: [],
    humanRequest: null,
    humanDecisions: [],
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

  const writeReport = async (verdict, reason = "") => {
    const statusText = {
      pass: "通过",
      accepted: "人工接受（仍有未关闭意见）",
      changes: "需要修改",
      blocked: "需要人工处理",
    }[verdict] || verdict;
    const latestRoundReviews = state.reviews.filter((review) => review.round === state.rounds);
    const latestRound = state.verification.find((entry) => entry.round === state.rounds);
    const latestChecks = latestRound?.checks || [];
    const decisions = (state.humanDecisions || []).map(
      (decision) =>
        `- ${decision.title}：${
          { extend: "追加一轮", accept: "接受当前结果", stop: "结束并生成报告", retry: "已处理并重试" }[
            decision.actionId
          ] || decision.actionId
        }${decision.note ? `；备注：${decision.note}` : ""}`,
    );
    const report = [
      `# AgentFlow 运行报告 ${runId}`,
      "",
      `状态：${statusText}`,
      `任务：${options.task}`,
      `执行器：${provider.name}`,
      `源工作区：${workspace}`,
      `执行工作区：${state.executionWorkspace || "尚未创建"}`,
      `分支：${state.branch || "（原地运行）"}`,
      `基线提交：${state.baseSha || "（尚未读取）"}`,
      `轮次：${state.rounds}`,
      `自动追加修复：${state.automaticExtensionsUsed || 0} 轮`,
      ...(reason ? ["", "## 当前说明", reason] : []),
      "",
      "## 评审结论",
      ...(latestRoundReviews.length
        ? latestRoundReviews.map(
            (review) =>
              `- ${review.label}：**${{ pass: "通过", changes: "需修改", block: "阻塞" }[review.verdict] || review.verdict}** — ${review.summary}`,
          )
        : ["尚无评审结论。"]),
      "",
      "## 验证结果",
      latestChecks.length
        ? checksSummary(latestChecks)
        : "当前轮次尚未产生确定性验证结果。",
      "",
      "## 人工交互记录",
      decisions.length ? decisions.join("\n") : "无。",
      "",
      "## 交付说明",
      state.isolated
        ? state.isolation === "clone"
          ? `改动保留在隔离仓库副本中。请人工复核并合并分支：${state.branch}`
          : `改动保留在隔离 worktree 中。请人工复核并合并分支：${state.branch}`
        : "工作流在源工作区中运行。提交前请人工复核未提交的 diff。",
    ].join("\n");
    await store.artifact(runId, "final-report.md", report);
    if (!state.artifacts.includes("artifacts/final-report.md")) {
      state.artifacts.push("artifacts/final-report.md");
    }
    await update({});
    return "artifacts/final-report.md";
  };

  const askHuman = async (request) => {
    const humanRequest = {
      id: `${request.kind}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      createdAt: now(),
      ...request,
    };
    await update({
      status: "waiting_human",
      phase: "human_input",
      humanRequest,
    });
    await emit({
      type: "run.waiting_human",
      role: "human",
      label: humanRequest.title,
      message: humanRequest.message,
      data: humanRequest,
    });
    const decision = await waitForHumanDecision(store, runId, humanRequest.id);
    if (!humanRequest.options.some((option) => option.id === decision.actionId)) {
      throw new Error(`人工操作无效：${decision.actionId}`);
    }
    state.humanDecisions.push({
      requestId: humanRequest.id,
      kind: humanRequest.kind,
      title: humanRequest.title,
      actionId: decision.actionId,
      note: String(decision.note || ""),
      decidedAt: decision.decidedAt || now(),
    });
    await update({
      status: "running",
      phase: request.resumePhase || "reviewing",
      humanRequest: null,
    });
    await emit({
      type: "run.human_decided",
      role: "human",
      label: humanRequest.title,
      message: `人工选择：${
        humanRequest.options.find((option) => option.id === decision.actionId)?.label || decision.actionId
      }`,
      data: {
        requestId: humanRequest.id,
        actionId: decision.actionId,
        note: String(decision.note || ""),
      },
    });
    return decision;
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
    while (true) {
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
        if (!isAuthorizationError(error)) {
          await failStep(step, error);
          throw error;
        }
        Object.assign(step, {
          status: "blocked",
          finishedAt: null,
          summary: `需要人工处理：${error.message}`,
        });
        await update({});
        await emit({
          type: "step.blocked",
          role,
          stepId: id,
          label,
          message: `步骤暂停，需要人工处理权限或工具问题：${error.message}`,
        });
        const reportArtifact = await writeReport(
          "blocked",
          `步骤“${label}”需要新的工具授权或人工处理。\n\n${error.message}`,
        );
        const decision = await askHuman({
          kind: "authorization",
          title: "需要人工处理工具或权限",
          message: `“${label}”无法继续：${error.message}`,
          details: error.message,
          reportArtifact,
          resumePhase: state.phase,
          options: [
            {
              id: "retry",
              label: "已处理，重试",
              description: "完成登录、安装工具或授权后，重新执行当前步骤。",
              tone: "primary",
            },
            {
              id: "stop",
              label: "结束并生成报告",
              description: "保留当前工作区并结束本次运行。",
              tone: "secondary",
            },
          ],
        });
        if (decision.actionId === "retry") {
          Object.assign(step, {
            status: "running",
            startedAt: now(),
            finishedAt: null,
            summary: "",
            artifact: null,
          });
          await update({});
          await emit({
            type: "step.retry",
            role,
            stepId: id,
            label,
            message: `已获得人工确认，重新执行：${label}`,
          });
          continue;
        }
        Object.assign(step, {
          status: "changes",
          finishedAt: now(),
          summary: "人工决定结束本次运行。",
        });
        await update({});
        const stopped = new Error("人工决定结束本次运行并生成报告。");
        stopped.code = "HUMAN_STOPPED";
        throw stopped;
      }
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
      isolation: execution.isolation,
      phase: "planning",
    });
    await emit({
      type: "workspace.ready",
      role: "orchestrator",
      message: execution.isolated
        ? `${execution.isolation === "clone" ? "隔离仓库副本" : "隔离 worktree"}已就绪：${execution.branch}`
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
    let reviewRound = 1;

    while (reviewRound <= config.maxRounds) {
      const round = reviewRound;
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
      if (round < config.maxRounds) {
        reviewRound += 1;
        continue;
      }

      if (state.automaticExtensionsUsed < config.autoContinueRounds) {
        config.maxRounds += 1;
        state.maxRounds = config.maxRounds;
        state.automaticExtensionsUsed += 1;
        await update({
          maxRounds: config.maxRounds,
          automaticExtensionsUsed: state.automaticExtensionsUsed,
        });
        await emit({
          type: "run.auto_continue",
          role: "orchestrator",
          message: `评审仍有未关闭意见，自动追加第 ${config.maxRounds} 轮修复与评审（${state.automaticExtensionsUsed}/${config.autoContinueRounds}）。`,
        });
        reviewRound += 1;
        continue;
      }

      const reportArtifact = await writeReport(
        "changes",
        `已完成 ${config.maxRounds} 轮（含 ${state.automaticExtensionsUsed} 轮自动修复），但仍有评审意见或验证失败，等待人工决定下一步。`,
      );
      const decision = await askHuman({
        kind: "review_limit",
        title: "评审已达到上限",
        message: `已完成 ${config.maxRounds} 轮评审，其中自动追加 ${state.automaticExtensionsUsed} 轮，但仍有未通过的检查。请选择下一步。`,
        details: previousReviewText,
        reportArtifact,
        resumePhase: "reviewing",
        options: [
          {
            id: "extend",
            label: "追加一轮评审",
            description: "增加一轮修复、验证和独立评审。",
            tone: "primary",
          },
          {
            id: "accept",
            label: "接受当前结果",
            description: "保留当前改动和未关闭意见，完成运行并生成报告。",
            tone: "secondary",
          },
          {
            id: "stop",
            label: "结束并生成报告",
            description: "停止继续执行，保留当前工作区供人工复核。",
            tone: "danger",
          },
        ],
      });
      if (decision.actionId === "extend") {
        config.maxRounds = Math.min(10, config.maxRounds + 1);
        await update({ maxRounds: config.maxRounds });
        reviewRound += 1;
        continue;
      }
      if (decision.actionId === "accept") {
        finalVerdict = "accepted";
      }
      break;
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

    await writeReport(
      finalVerdict,
      finalVerdict === "accepted"
        ? "人工选择接受当前结果。仍有评审意见未关闭，请在合并前复核报告。"
        : "",
    );
    const patchArtifact = `artifacts/round-${state.rounds}.patch`;
    if (!state.artifacts.includes(patchArtifact)) state.artifacts.push(patchArtifact);
    const finalStatus = ["pass", "accepted"].includes(finalVerdict)
      ? "completed"
      : "changes_required";
    await update({
      status: finalStatus,
      phase: "delivered",
      finalVerdict,
      humanRequest: null,
      completedAt: now(),
    });
    await emit({
      type: "run.finished",
      role: "coordinator",
      status: finalStatus,
      message:
        finalVerdict === "pass"
          ? "工作流已完成，仍需人工合并。"
          : finalVerdict === "accepted"
            ? "工作流已按人工决定结束，当前结果仍需复核后合并。"
          : `已达到评审轮次上限，共收到 ${latestReviews.length} 条评审结论，仍需修改。`,
    });
    return state;
  } catch (error) {
    if (error.code === "HUMAN_STOPPED") {
      await writeReport("blocked", error.message);
      await update({
        status: "changes_required",
        phase: "delivered",
        finalVerdict: "blocked",
        humanRequest: null,
        error: null,
        completedAt: now(),
      });
      await emit({
        type: "run.finished",
        role: "human",
        status: "changes_required",
        message: "人工结束当前运行，报告已生成。",
      });
      return state;
    }
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
