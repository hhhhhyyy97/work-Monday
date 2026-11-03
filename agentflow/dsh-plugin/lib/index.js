import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN = "subagent-pi";
const DEFAULT_DISPOSE_GRACE_MS = 3000;

export const name = "subagent-pi";
export const inject = ["subagents", "subprocess"];

function textTask(prompt) {
  if (!Array.isArray(prompt) || prompt.length === 0) {
    throw new Error(`${PLUGIN}: the task must contain text blocks`);
  }
  const texts = prompt.map((block) => {
    if (block?.type !== "text" || typeof block.text !== "string") {
      throw new Error(`${PLUGIN}: the task must contain only text blocks`);
    }
    return block.text;
  });
  if (texts.every((text) => !text.trim())) {
    throw new Error(`${PLUGIN}: the task must not be empty`);
  }
  return texts.join("\n\n");
}

function resolvePiCli() {
  if (process.env.PI_CLI) return process.env.PI_CLI;
  try {
    const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const cli = resolve(dirname(entry), "bundle", "cli.js");
    if (existsSync(cli)) return cli;
  } catch {}
  return null;
}

function resolveNodeBin() {
  if (process.env.PI_NODE_BIN) {
    return { bin: process.env.PI_NODE_BIN, electronAsNode: false };
  }
  if (!process.versions.electron) {
    return { bin: process.execPath, electronAsNode: false };
  }
  const bundled = resolve(
    dirname(process.execPath),
    "resources",
    "runtime",
    "primary-runtime",
    "dependencies",
    "node",
    "bin",
    process.platform === "win32" ? "node.exe" : "node",
  );
  if (existsSync(bundled)) return { bin: bundled, electronAsNode: false };
  return { bin: process.execPath, electronAsNode: true };
}

function piArgv(readOnly) {
  const cli = resolvePiCli();
  const { bin, electronAsNode } = resolveNodeBin();
  const args = [
    "--print",
    "--mode",
    "json",
    "--no-session",
    "--approve",
  ];
  const model = process.env.AGENTFLOW_PI_MODEL || process.env.PI_MODEL;
  const provider = process.env.AGENTFLOW_PI_PROVIDER || process.env.PI_PROVIDER;
  const thinking = process.env.AGENTFLOW_PI_THINKING;
  if (provider) args.push("--provider", provider);
  if (model) args.push("--model", model);
  if (thinking) args.push("--thinking", thinking);
  if (readOnly) args.push("--tools", "read,grep,find,ls");
  if (cli) return { argv: [bin, cli, ...args], electronAsNode };
  if (process.platform === "win32") {
    return { argv: ["cmd.exe", "/d", "/s", "/c", "pi", ...args], electronAsNode: false };
  }
  return { argv: ["pi", ...args], electronAsNode: false };
}

function taskPrompt(prompt, readOnly) {
  return `You are a Pi coding subagent delegated by DeepSeek Harness.
Work only inside the current workspace. Inspect the repository before acting.
${readOnly ? "This is a read-only review task. Do not modify files." : "Implement and verify the requested work. Do not commit or merge."}
Return a concise final report with files changed, checks run, and residual risks.

Task:
${prompt}`;
}

function messageText(message) {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

function childEnv(electronAsNode) {
  const env = {
    PI_OFFLINE: process.env.PI_OFFLINE || "1",
  };
  if (electronAsNode) env.ELECTRON_RUN_AS_NODE = "1";
  for (const key of [
    "HOME",
    "USERPROFILE",
    "PI_CODING_AGENT_DIR",
    "PI_MODEL",
    "PI_PROVIDER",
    "PI_CLI",
    "AGENTFLOW_PI_MODEL",
    "AGENTFLOW_PI_PROVIDER",
    "AGENTFLOW_PI_THINKING",
    "DEEPSEEK_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENROUTER_API_KEY",
    "KIMI_API_KEY",
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function createPiRun(request, ctx, readOnly) {
  const cwd = request.parent?.session?.header?.cwd;
  if (!cwd) {
    throw new Error(`${PLUGIN}: parent session has no working directory`);
  }
  if (request.signal?.aborted) {
    throw new Error(`${PLUGIN}: request was aborted before startup`);
  }

  const prompt = taskPrompt(textTask(request.prompt), readOnly);
  const { argv, electronAsNode } = piArgv(readOnly);
  const name = readOnly ? "subagent_pi_review" : "subagent_pi";
  const child = ctx.subprocess.spawn({
    argv,
    cwd,
    stdio: {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    },
    graceMs: DEFAULT_DISPOSE_GRACE_MS,
    env: childEnv(electronAsNode),
  });

  let cancelled = false;
  let lastAssistantText = "";
  let stdoutBuffer = "";
  let disposal;

  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    try {
      child.stdin?.end();
    } catch {}
    child.terminate();
  };
  const onAbort = () => cancel();
  request.signal?.addEventListener("abort", onAbort, { once: true });

  const handleLine = (wireLine) => {
    const line = wireLine.replace(/\r$/, "");
    if (!line.trim()) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      ctx.logger?.warn?.(`${PLUGIN}: ignored malformed Pi output`);
      return;
    }
    if (event.type === "tool_execution_start") {
      ctx.logger?.info?.(`${PLUGIN}: ${name} running ${event.toolName || "tool"}`);
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      const text = messageText(event.message);
      if (text.trim()) lastAssistantText = text;
    }
    if (event.type === "auto_retry_end" && event.success === false) {
      ctx.logger?.warn?.(`${PLUGIN}: ${name} retry failed: ${event.finalError || "unknown"}`);
    }
    if (event.type === "agent_settled" && event.aborted === true) {
      cancelled = true;
    }
  };

  const collect = () => {
    stdoutBuffer = "";
    return lastAssistantText.trim()
      ? [{ type: "text", text: lastAssistantText }]
      : [];
  };

  const result = child.done
    .then((outcome) => {
      if (stdoutBuffer) {
        for (const line of stdoutBuffer.split("\n")) handleLine(line);
      }
      if (cancelled || request.signal?.aborted) {
        return { output: collect(), stopReason: "aborted" };
      }
      const exitCode = Number(outcome?.exitCode ?? 0);
      if (exitCode !== 0) {
        return {
          output: collect(),
          diagnostic: `${PLUGIN}: Pi exited with code ${exitCode}`,
          stopReason: "error",
        };
      }
      const output = collect();
      if (output.length === 0) {
        return {
          output,
          diagnostic: `${PLUGIN}: Pi completed without a final assistant response`,
          stopReason: "error",
        };
      }
      return { output, stopReason: "completed" };
    })
    .catch((error) => ({
      output: collect(),
      diagnostic: `${PLUGIN}: ${error.message}`,
      stopReason: cancelled ? "aborted" : "error",
    }))
    .finally(() => {
      request.signal?.removeEventListener("abort", onAbort);
    });

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString("utf8");
    let newline = stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      handleLine(stdoutBuffer.slice(0, newline));
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      newline = stdoutBuffer.indexOf("\n");
    }
  });
  child.stdin.end(prompt);

  return {
    id: randomUUID(),
    result,
    dispose() {
      if (disposal) return disposal;
      request.signal?.removeEventListener("abort", onAbort);
      disposal = (async () => {
        cancel();
        try {
          await child.waitForExit();
        } finally {
          await child.done.catch(() => {});
        }
      })();
      return disposal;
    },
  };
}

class PiProvider {
  constructor(ctx, readOnly) {
    this.ctx = ctx;
    this.readOnly = readOnly;
    this.name = readOnly ? "pi-read" : "pi-write";
    this.capabilities = Object.freeze({
      agentOptions: false,
      agentPreset: false,
      outputSchema: false,
      depthLimit: false,
    });
    this.inheritsParentContext = false;
  }

  start(request) {
    return createPiRun(request, this.ctx, this.readOnly);
  }
}

export function apply(ctx) {
  ctx.subagents.registerProvider(new PiProvider(ctx, false));
  ctx.subagents.registerProvider(new PiProvider(ctx, true));
}
