import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PiProvider } from "../src/providers/pi.mjs";

test("Pi provider parses JSONL output and applies read-only tools", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agentflow-pi-"));
  const fakeCli = path.join(root, "fake-pi.mjs");
  await writeFile(
    fakeCli,
    [
      'const text = JSON.stringify(process.argv.slice(2));',
      'console.log(JSON.stringify({ type: "tool_execution_start", toolName: "read" }));',
      'console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } }));',
      'console.log(JSON.stringify({ type: "agent_settled", aborted: false }));',
    ].join("\n"),
    "utf8",
  );
  const previous = process.env.AGENTFLOW_PI_CLI;
  process.env.AGENTFLOW_PI_CLI = fakeCli;
  try {
    const progress = [];
    const text = await new PiProvider().run({
      role: "reviewer",
      prompt: "Review the change.",
      cwd: root,
      writeAccess: false,
      logPath: path.join(root, "pi.log"),
      onEvent: (event) => progress.push(event),
    });
    assert.match(text, /--tools/);
    assert.match(text, /read,grep,find,ls/);
    assert.doesNotMatch(text, /write,powershell/);
    assert.ok(progress.some((event) => event.type === "agent.progress"));
  } finally {
    if (previous === undefined) delete process.env.AGENTFLOW_PI_CLI;
    else process.env.AGENTFLOW_PI_CLI = previous;
  }
});
