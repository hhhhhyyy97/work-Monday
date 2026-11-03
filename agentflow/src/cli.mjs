#!/usr/bin/env node
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RunStore } from "./store.mjs";
import { runWorkflow } from "./workflow.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(moduleDir, "..");
const store = new RunStore(root);

function usage() {
  return `AgentFlow - local multi-agent orchestration

Usage:
  node src/cli.mjs run --task <text|-> [options]
  node src/cli.mjs list
  node src/cli.mjs show <run-id>
  node src/cli.mjs approve <run-id> [note]

Run options:
  --workspace <path>         Repository to work on (default: current directory)
  --task-file <path>         Read the task from a file instead of --task
  --provider <codex|pi|mock> Agent provider (default: codex)
  --model <name>             Codex model override
  --verify <command>         Verification command; repeatable
  --reviewers <list>         software,methodology,security
  --max-rounds <number>      Review/fix limit from 1 to 5 (default: 2)
  --approval <auto|required> Human gate (default: auto)
  --in-place                 Run in the source checkout instead of a worktree
  --run-id <id>              Explicit run id
  --json                     Print the final state as JSON

Environment:
  AGENTFLOW_CODEX_BIN        Codex executable (default: codex)
  AGENTFLOW_CODEX_MODEL      Codex model override
  AGENTFLOW_PI_CLI           Pi CLI entry override
  AGENTFLOW_PI_MODEL         Pi model override
  AGENTFLOW_PI_PROVIDER      Pi provider override
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
    if (value === undefined) throw new Error(`Missing value for --${rawKey}`);
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
  console.log(`${run.id}  ${run.status.padEnd(18)}  ${run.task}`);
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
      console.log("No AgentFlow runs yet.");
      return;
    }
    runs.forEach(printRun);
    return;
  }
  if (command === "show") {
    const runId = args._[0];
    if (!runId) throw new Error("Missing run id.");
    const run = await store.load(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    console.log(JSON.stringify(run, null, 2));
    return;
  }
  if (command === "approve") {
    const runId = args._[0];
    if (!runId) throw new Error("Missing run id.");
    const run = await store.load(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    if (run.status !== "waiting_approval") {
      throw new Error(`Run is not waiting for approval (status: ${run.status}).`);
    }
    await store.approve(runId, args._.slice(1).join(" "));
    console.log(`Approved ${runId}. The orchestration process will continue.`);
    return;
  }
  if (command !== "run") throw new Error(`Unknown command: ${command}`);

  if (args.taskFile) {
    if (args.task) throw new Error("Use either --task or --task-file, not both.");
    args.task = (await readFile(path.resolve(args.taskFile), "utf8")).trim();
  }
  if (!args.task) throw new Error("Missing --task or --task-file.");
  if (args.task === "-") args.task = await readTask(args.task);
  if (!args.task.trim()) throw new Error("Task must not be empty.");
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
        const prefix = event.role ? `[${event.role}] ` : "";
        console.log(`${prefix}${event.message || event.type}`);
      }
    },
  });
  if (args.json) {
    console.log(JSON.stringify(state, null, 2));
  } else {
    console.log(`\nRun: ${state.id}`);
    console.log(`Status: ${state.status}`);
    console.log(`Workspace: ${state.executionWorkspace}`);
    console.log(`Report: ${path.join(store.runDir(state.id), "artifacts", "final-report.md")}`);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
