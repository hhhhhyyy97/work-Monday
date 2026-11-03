import { createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";

function codexBinary() {
  return process.env.AGENTFLOW_CODEX_BIN || process.env.CODEX_BIN || "codex";
}

export class CodexProvider {
  name = "codex";

  async run({
    role,
    prompt,
    cwd,
    schemaPath,
    writeAccess = false,
    lastMessagePath,
    logPath,
    onEvent,
    timeoutMs = 30 * 60 * 1000,
  }) {
    let requestPrompt = prompt;
    if (schemaPath) {
      const schema = await readFile(schemaPath, "utf8");
      requestPrompt += `\n\nYour final response must follow this JSON Schema:\n${schema}`;
    }
    const args = [
      "exec",
      "--ephemeral",
      "--json",
      "--sandbox",
      writeAccess ? "workspace-write" : "read-only",
      "-C",
      cwd,
      "-o",
      lastMessagePath,
    ];
    if (schemaPath) args.push("--output-schema", schemaPath);
    if (process.env.AGENTFLOW_CODEX_MODEL) {
      args.push("-m", process.env.AGENTFLOW_CODEX_MODEL);
    }
    args.push("-");

    onEvent?.({ type: "agent.started", message: `${role} 已启动` });
    const child = spawn(codexBinary(), args, {
      cwd,
      env: { ...process.env, NO_COLOR: "1" },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const logStream = createWriteStream(logPath, { flags: "a" });
    let stderr = "";
    let timedOut = false;
    let stdoutBuffer = "";
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    const handleLine = (line) => {
      if (!line.trim()) return;
      logStream.write(`${line}\n`);
      try {
        const event = JSON.parse(line);
        const message =
          event.message ||
          event.text ||
          event.item?.text ||
          event.item?.message ||
          event.type;
        if (message && event.type !== "token_count") {
          onEvent?.({
            type: "agent.progress",
            message: String(message).slice(0, 500),
            data: event.type ? { eventType: event.type } : undefined,
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
      stdoutBuffer += chunk.toString();
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
      logStream.write(`[stderr] ${text}`);
      if (stderr.length > 100_000) stderr = stderr.slice(-100_000);
    });
    child.stdin.end(requestPrompt);

    try {
      const [code] = await once(child, "close");
      clearTimeout(timer);
      if (stdoutBuffer.trim()) handleLine(stdoutBuffer);
      if (timedOut) throw new Error(`${role} 在 ${timeoutMs}ms 后超时。`);
      if (code !== 0) {
        throw new Error(
          `${role} 执行失败，退出码 ${code}。${stderr ? `\n${stderr.slice(-4000)}` : ""}`,
        );
      }
      try {
        return await readFile(lastMessagePath, "utf8");
      } catch (error) {
        throw new Error(`${role} 已完成，但没有最终消息：${error.message}`);
      }
    } finally {
      clearTimeout(timer);
      logStream.end();
    }
  }
}
