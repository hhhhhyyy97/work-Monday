import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function resolvePiCli() {
  if (process.env.AGENTFLOW_PI_CLI) return process.env.AGENTFLOW_PI_CLI;
  const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  return resolve(dirname(entry), "bundle", "cli.js");
}

function messageText(message) {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

export class PiProvider {
  name = "pi";

  async run({
    role,
    prompt,
    cwd,
    schemaPath,
    writeAccess = false,
    logPath,
    onEvent,
    timeoutMs = 30 * 60 * 1000,
  }) {
    let requestPrompt = prompt;
    if (schemaPath) {
      requestPrompt += `\n\nYour final response must follow this JSON Schema:\n${await readFile(
        schemaPath,
        "utf8",
      )}`;
    }
    const promptPath = `${logPath}.prompt.md`;
    await mkdir(dirname(promptPath), { recursive: true });
    await writeFile(promptPath, requestPrompt, "utf8");

    const args = [
      "--print",
      "--mode",
      "json",
      "--no-session",
      "--no-extensions",
      "--no-mcp",
      "--approve",
    ];
    const provider = process.env.AGENTFLOW_PI_PROVIDER;
    const model = process.env.AGENTFLOW_PI_MODEL;
    const thinking = process.env.AGENTFLOW_PI_THINKING;
    if (provider) args.push("--provider", provider);
    if (model) args.push("--model", model);
    if (thinking) args.push("--thinking", thinking);
    if (writeAccess) {
      args.push("--tools", "read,bash,powershell,edit,write,grep,find,ls");
    } else {
      args.push("--tools", "read,grep,find,ls");
    }
    args.push(`@${promptPath}`);

    onEvent?.({ type: "agent.started", message: `${role} 已由 Pi 启动` });
    const child = spawn(process.execPath, [resolvePiCli(), ...args], {
      cwd,
      env: { ...process.env, PI_OFFLINE: process.env.PI_OFFLINE || "1" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const log = createWriteStream(logPath, { flags: "a" });
    let stderr = "";
    let stdoutBuffer = "";
    let lastAssistantText = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    const handleLine = (line) => {
      if (!line.trim()) return;
      log.write(`${line}\n`);
      try {
        const event = JSON.parse(line);
        if (event.type === "tool_execution_start") {
          onEvent?.({
            type: "agent.progress",
            message: `Pi：开始执行 ${event.toolName || "工具"}`,
          });
        }
        if (event.type === "message_end" && event.message?.role === "assistant") {
          const text = messageText(event.message);
          if (text.trim()) lastAssistantText = text;
        }
        if (event.type === "auto_retry_end" && event.success === false) {
          onEvent?.({
            type: "agent.progress",
            message: `Pi 重试失败：${event.finalError || "未知错误"}`,
          });
        }
      } catch {
        onEvent?.({
          type: "agent.progress",
          message: line.slice(0, 500),
        });
      }
    };

    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString("utf8");
      let newline = stdoutBuffer.indexOf("\n");
      while (newline >= 0) {
        handleLine(stdoutBuffer.slice(0, newline));
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        newline = stdoutBuffer.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      log.write(`[stderr] ${text}`);
      if (stderr.length > 100_000) stderr = stderr.slice(-100_000);
    });

    try {
      const [code] = await once(child, "close");
      clearTimeout(timer);
      if (stdoutBuffer.trim()) handleLine(stdoutBuffer);
      if (timedOut) throw new Error(`${role} 在 ${timeoutMs}ms 后超时。`);
      if (code !== 0) {
        throw new Error(
          `${role} 执行失败，Pi 退出码 ${code}。${stderr ? `\n${stderr.slice(-4000)}` : ""}`,
        );
      }
      if (!lastAssistantText.trim()) {
        throw new Error(`${role} 已完成 Pi 执行，但没有返回助手文本。`);
      }
      return lastAssistantText;
    } finally {
      clearTimeout(timer);
      log.end();
    }
  }
}
