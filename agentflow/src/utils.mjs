import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export function now() {
  return new Date().toISOString();
}

export function parseJsonLoose(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) throw new Error("The agent returned an empty response.");

  try {
    return JSON.parse(trimmed);
  } catch {}

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {}
  }

  const firstObject = trimmed.indexOf("{");
  const lastObject = trimmed.lastIndexOf("}");
  if (firstObject >= 0 && lastObject > firstObject) {
    return JSON.parse(trimmed.slice(firstObject, lastObject + 1));
  }
  throw new Error("The agent response did not contain valid JSON.");
}

export async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

export async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await import("node:fs/promises").then(({ rename }) => rename(temporary, filePath));
}

export function slug(value, length = 42) {
  const normalized = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (normalized || "agentflow-run").slice(0, length).replace(/-+$/g, "");
}

export function trimMiddle(value, limit = 18000) {
  const text = String(value ?? "");
  if (text.length <= limit) return text;
  const side = Math.floor((limit - 40) / 2);
  return `${text.slice(0, side)}\n\n[... middle omitted by AgentFlow ...]\n\n${text.slice(-side)}`;
}

export function safeFileName(value) {
  return path.basename(String(value ?? "artifact")).replace(/[^a-zA-Z0-9._-]+/g, "-");
}

export async function runCommand(command, options = {}) {
  const {
    cwd,
    timeoutMs = 15 * 60 * 1000,
    env = process.env,
    onData,
  } = options;
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(command, {
      cwd,
      env,
      shell: true,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      onData?.("stdout", text);
      if (stdout.length > 400_000) stdout = stdout.slice(-400_000);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      onData?.("stderr", text);
      if (stderr.length > 200_000) stderr = stderr.slice(-200_000);
    });
    child.on("error", (error) => {
      stderr += `\n${error.stack || error.message}`;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        command,
        exitCode: timedOut ? 124 : code ?? 1,
        timedOut,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}
