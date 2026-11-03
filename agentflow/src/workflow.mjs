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
    label: "Software Review",
    prompt: "software-review.md",
    color: "#0f766e",
  },
  methodology: {
    role: "methodology-reviewer",
    label: "Methodology Review",
    prompt: "methodology-review.md",
    color: "#8b5e34",
  },
  security: {
    role: "security-reviewer",
    label: "Security Review",
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
    error.message = `git ${args.join(" ")} failed in ${cwd}\n${error.message}`;
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
  return `Review round ${context.round}
Base commit: ${context.baseSha}
Worktree: ${context.workspace}

Task:
${context.task}

Inspect the current worktree and \`git diff ${context.baseSha}\`. Review the task diff, not unrelated pre-existing history.

Builder summary:
${trimMiddle(context.builderOutput, 12000)}

Verification:
${trimMiddle(context.verificationSummary, 12000)}

Previous review findings:
${names || "None"}

Review focus for this role: ${review.label}.
Return only JSON matching the supplied schema.`;
}

function parseReview(text, role) {
  try {
    const parsed = parseJsonLoose(text);
    if (!["pass", "changes", "block"].includes(parsed.verdict)) {
      throw new Error("Invalid verdict.");
    }
    if (!Array.isArray(parsed.findings) || !Array.isArray(parsed.checks)) {
      throw new Error("findings and checks must be arrays.");
    }
    return parsed;
  } catch (error) {
    return {
      verdict: "changes",
      summary: `${role} returned an unparseable review: ${error.message}`,
      findings: [
        {
          severity: "P1",
          file: "(review artifact)",
          line: 1,
          title: "Review output did not match the required schema",
          evidence: trimMiddle(text, 2500),
          recommendation: "Re-run the review with a valid JSON response.",
        },
      ],
      checks: [
        {
          name: "review protocol",
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
        `${(check.exitCode === 0 ? "PASS" : "FAIL")} ${check.command} (exit ${check.exitCode}, ${check.durationMs}ms)\n${trimMiddle(
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
  throw new Error("Timed out waiting for human approval.");
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
      message: `${step.label} started`,
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
      message: patch.summary || `${step.label} finished`,
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
      message: error.message,
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
        ? `Isolated worktree ready on ${execution.branch}`
        : "Running in the source workspace",
      data: execution,
    });

    const planner = await executeAgentStep({
      id: "plan",
      role: "planner",
      label: "Plan & acceptance criteria",
      prompt: `${await readPrompt("planner.md")}

User task:
${options.task}

Repository: ${execution.path}
Base commit: ${execution.baseSha}`,
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
        risks: [`Planner output was not structured: ${error.message}`],
        verification_strategy: [],
      };
    }
    await store.artifact(runId, "plan.json", `${JSON.stringify(plan, null, 2)}\n`);

    const [scout, architect] = await Promise.all([
      executeAgentStep({
        id: "scout",
        role: "scout",
        label: "Repository scan",
        parentIds: ["plan"],
        prompt: `${await readPrompt("scout.md")}

User task:
${options.task}

Plan:
${jsonBlock(plan)}`,
      }),
      executeAgentStep({
        id: "architect",
        role: "architect",
        label: "Implementation design",
        parentIds: ["plan"],
        prompt: `${await readPrompt("architect.md")}

User task:
${options.task}

Plan:
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

User task:
${options.task}

Planner:
${jsonBlock(plan)}

Repository Scout:
${scout.text}

Architect:
${architect.text}`
          : `${await readPrompt("fixer.md")}

User task:
${options.task}

Plan:
${jsonBlock(plan)}

Previous builder summary:
${trimMiddle(latestBuilderText, 12000)}

Review findings:
${previousReviewText}

Verification failures:
${trimMiddle(checksSummary(latestChecks), 12000)}`;
      const built = await executeAgentStep({
        id: buildId,
        role: round === 1 ? "builder" : "fixer",
        label: round === 1 ? "Build implementation" : `Fix review round ${round - 1}`,
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
        diff = `Unable to read task diff: ${error.message}`;
      }
      await store.artifact(runId, `round-${round}.patch`, diff);

      await update({ phase: "verifying" });
      latestChecks = [];
      for (let index = 0; index < config.verifyCommands.length; index += 1) {
        const command = config.verifyCommands[index];
        const verificationStep = await addStep({
          id: `verify-${round}-${index + 1}`,
          role: "verifier",
          label: `Verify: ${command}`,
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
          `$ ${command}\n\nSTDOUT\n${result.stdout}\n\nSTDERR\n${result.stderr}\n\nEXIT ${result.exitCode}\n`,
        );
        if (result.exitCode === 0) {
          await finishStep(verificationStep, {
            summary: `Passed in ${result.durationMs}ms`,
          });
        } else {
          await failStep(verificationStep, new Error(`Exit code ${result.exitCode}`));
        }
      }
      state.verification.push({ round, checks: latestChecks });

      await update({ phase: "reviewing" });
      const verificationSummary = latestChecks.length
        ? checksSummary(latestChecks)
        : "No deterministic commands were configured.";
      const reviewJobs = config.reviewers.map(async (reviewName) => {
        const meta = REVIEW_META[reviewName];
        const reviewStepId = `review-${round}-${reviewName}`;
        const reviewed = await executeAgentStep({
          id: reviewStepId,
          role: meta.role,
          label: `${meta.label} · round ${round}`,
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
        label: `Quality gate · round ${round}`,
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
                  `- [${finding.severity}] ${finding.file}:${finding.line} ${finding.title}\n  Evidence: ${finding.evidence}\n  Recommendation: ${finding.recommendation}`,
              )
              .join("\n")}`,
        )
        .join("\n\n");
      await finishStep(reviewSummaryStep, {
        status: needsFix ? "changes" : "done",
        summary: needsFix
          ? "Changes requested by at least one reviewer or verification command."
          : "All required review and verification gates passed.",
      });
      if (!needsFix) break;
      if (round === config.maxRounds) break;
    }

    await update({ phase: "approval", finalVerdict });
    if (finalVerdict === "pass" && config.approval === "required") {
      const approvalStep = await addStep({
        id: "approval",
        role: "human",
        label: "Human approval",
        parentIds: [`review-${state.rounds}`],
      });
      await update({ status: "waiting_approval" });
      await emit({
        type: "run.waiting_approval",
        role: "human",
        stepId: "approval",
        label: "Human approval",
        message: "All checks passed. Approve the isolated worktree to finish delivery.",
      });
      const approval = await waitForApproval(store, runId);
      await finishStep(approvalStep, {
        summary: approval.note ? `Approved: ${approval.note}` : "Approved by human.",
      });
    }

    const report = [
      `# AgentFlow run ${runId}`,
      "",
      `Status: ${finalVerdict === "pass" ? "PASS" : "CHANGES REQUIRED"}`,
      `Task: ${options.task}`,
      `Provider: ${provider.name}`,
      `Source workspace: ${workspace}`,
      `Execution workspace: ${state.executionWorkspace}`,
      `Branch: ${state.branch || "(in-place)"}`,
      `Base: ${state.baseSha}`,
      `Rounds: ${state.rounds}`,
      "",
      "## Review verdicts",
      ...latestReviews.map(
        (review) => `- ${review.label}: **${review.verdict}** — ${review.summary}`,
      ),
      "",
      "## Verification",
      latestChecks.length
        ? checksSummary(latestChecks)
        : "No verification commands were configured. Configure `verifyCommands` before treating this as a release-quality run.",
      "",
      "## Delivery",
      state.isolated
        ? `Changes remain in the isolated worktree. Review and merge the branch manually: ${state.branch}`
        : "The workflow ran in place. Review the uncommitted diff before committing.",
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
          ? "Workflow completed. Human merge is still required."
          : `Review limit reached with ${latestReviews.length} verdicts. Changes are required.`,
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
      message: error.message,
    });
    throw error;
  }
}

export function isGitAvailable() {
  return pathExists(".git");
}
