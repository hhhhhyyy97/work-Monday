#!/usr/bin/env node
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RunStore } from "./store.mjs";
import { runWorkflow } from "./workflow.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(moduleDir, "..");
const store = new RunStore(process.env.AGENTFLOW_RUNS_ROOT || root);

function usage() {
  return `AgentFlow - 本地多 Agent 协作编排器

用法：
  node src/cli.mjs run --task <任务文本|-> [选项]
  node src/cli.mjs list
  node src/cli.mjs show <运行ID>
  node src/cli.mjs approve <运行ID> [备注]

运行选项：
  --workspace <路径>         目标仓库（默认：当前目录）
  --task-file <路径>         从文件读取任务，替代 --task
  --provider <codex|pi|mock> 执行器（默认：codex）
  --model <名称>             Codex 模型覆盖
  --verify <命令>            验证命令，可重复
  --reviewers <列表>         software,methodology,security
  --max-rounds <数字>        评审与修复轮次上限，1-5（默认：2）
  --approval <auto|required> 人工闸门（默认：auto）
  --in-place                 直接在源工作区运行，不创建 worktree
  --run-id <ID>              指定运行 ID
  --json                     以 JSON 输出最终状态

环境变量：
  AGENTFLOW_CODEX_BIN        Codex 可执行文件（默认：codex）
  AGENTFLOW_CODEX_MODEL      Codex 模型覆盖
  AGENTFLOW_PI_CLI           Pi CLI 入口覆盖
  AGENTFLOW_PI_MODEL         Pi 模型覆盖
  AGENTFLOW_PI_PROVIDER      Pi Provider 覆盖
`;
}

function parseArgs(argv) {
  const result = { verifyCommands: [], _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      result._.push(...argv.slice(index + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      result._.push(arg);
      continue;
    }
    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const key = rawKey.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    if (["json", "inPlace"].includes(key)) {
      result[key] = true;
      continue;
    }
    const value = inlineValue ?? argv[++index];
    if (value === undefined) throw new Error(`--${rawKey} 缺少参数值。`);
    if (key === "verify") result.verifyCommands.push(value);
    else result[key] = value;
  }
  return result;
}

async function readTask(value) {
  if (value !== "-") return value;
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").trim();
}

function printRun(run) {
  const statuses = {
    running: "运行中",
    waiting_approval: "等待人工批准",
    completed: "已通过",
    changes_required: "需要修改",
    failed: "运行失败",
  };
  console.log(`${run.id}  ${(statuses[run.status] || run.status).padEnd(12)}  ${run.task}`);
}

function roleText(role) {
  return {
    planner: "规划者",
    scout: "仓库侦察者",
    architect: "架构师",
    builder: "构建者",
    fixer: "修复者",
    "software-reviewer": "软件评审者",
    "methodology-reviewer": "方法论评审者",
    "security-reviewer": "安全评审者",
    verifier: "验证者",
    coordinator: "协调者",
    orchestrator: "编排器",
    human: "人工",
  }[role] || role;
}

async function main() {
  const [command = "help", ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (command === "help" || command === "--help" || command === "-h") {
    console.log(usage());
    return;
  }
  if (command === "list") {
    const runs = await store.list();
    if (!runs.length) {
      console.log("暂无 AgentFlow 运行记录。");
      return;
    }
    runs.forEach(printRun);
    return;
  }
  if (command === "show") {
    const runId = args._[0];
    if (!runId) throw new Error("缺少运行 ID。");
    const run = await store.load(runId);
    if (!run) throw new Error(`未找到运行：${runId}`);
    console.log(JSON.stringify(run, null, 2));
    return;
  }
  if (command === "approve") {
    const runId = args._[0];
    if (!runId) throw new Error("缺少运行 ID。");
    const run = await store.load(runId);
    if (!run) throw new Error(`未找到运行：${runId}`);
    if (run.status !== "waiting_approval") {
      throw new Error(`该运行不在等待批准状态（当前：${run.status}）。`);
    }
    await store.approve(runId, args._.slice(1).join(" "));
    console.log(`已批准 ${runId}。编排进程将继续执行。`);
    return;
  }
  if (command !== "run") throw new Error(`未知命令：${command}`);

  if (args.taskFile) {
    if (args.task) throw new Error("--task 和 --task-file 只能使用一个。");
    args.task = (await readFile(path.resolve(args.taskFile), "utf8")).trim();
  }
  if (!args.task) throw new Error("缺少 --task 或 --task-file。");
  if (args.task === "-") args.task = await readTask(args.task);
  if (!args.task.trim()) throw new Error("任务内容不能为空。");
  if (args.model) process.env.AGENTFLOW_CODEX_MODEL = args.model;

  const reviewers =
    typeof args.reviewers === "string"
      ? args.reviewers
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
      : undefined;
  const state = await runWorkflow({
    task: args.task.trim(),
    workspace: path.resolve(args.workspace || process.cwd()),
    provider: args.provider || "codex",
    maxRounds: args.maxRounds ? Number(args.maxRounds) : undefined,
    reviewers,
    verifyCommands: args.verifyCommands.length ? args.verifyCommands : undefined,
    approval: args.approval,
    isolateWithWorktree: args.inPlace ? false : undefined,
    runId: args.runId,
    onEvent: (event) => {
      if (!args.json && event.type !== "agent.progress") {
        const prefix = event.role ? `[${roleText(event.role)}] ` : "";
        console.log(`${prefix}${event.message || event.type}`);
      }
    },
  });
  if (args.json) {
    console.log(JSON.stringify(state, null, 2));
  } else {
    const statuses = {
      completed: "已通过",
      changes_required: "需要修改",
      failed: "运行失败",
    };
    console.log(`\n运行：${state.id}`);
    console.log(`状态：${statuses[state.status] || state.status}`);
    console.log(`工作区：${state.executionWorkspace}`);
    console.log(`报告：${path.join(store.runDir(state.id), "artifacts", "final-report.md")}`);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
