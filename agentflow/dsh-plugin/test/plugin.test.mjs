import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { apply } from "../lib/index.js";

function fakeChild(output = "") {
  const child = new EventEmitter();
  child.stdin = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  child.stdout = Readable.from([output]);
  child.terminate = () => {};
  child.waitForExit = async () => {};
  child.done = new Promise((resolve) => {
    setTimeout(() => resolve({ exitCode: 0, signal: null }), 10);
  });
  return child;
}

test("registers write and read-only Pi subagent providers", async () => {
  const providers = new Map();
  const output = [
    JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "PI_OK" }] },
    }),
    JSON.stringify({ type: "agent_settled", aborted: false }),
    "",
  ].join("\n");
  const spawned = [];
  const ctx = {
    subagents: {
      registerProvider(provider) {
        providers.set(provider.name, provider);
      },
    },
    subprocess: {
      spawn(spec) {
        spawned.push(spec);
        return fakeChild(output);
      },
    },
    logger: { info() {}, warn() {} },
  };

  apply(ctx);
  assert.deepEqual([...providers.keys()], ["pi-write", "pi-read"]);
  assert.equal(providers.get("pi-write").capabilities.agentOptions, false);

  for (const providerName of ["pi-write", "pi-read"]) {
    const controller = new AbortController();
    const run = providers.get(providerName).start({
      prompt: [{ type: "text", text: "inspect the repository" }],
      parent: { session: { header: { cwd: process.cwd() } } },
      signal: controller.signal,
    });
    const result = await run.result;
    assert.equal(result.stopReason, "completed");
    assert.equal(result.output[0].text, "PI_OK");
    await run.dispose();
  }
  assert.match(
    spawned[0].argv.slice(0, 2).join(" "),
    /node|DeepSeek Harness|electron/i,
  );
  assert.ok(spawned[0].argv.some((arg) => arg.includes("pi-coding-agent")));
  assert.ok(spawned[1].argv.includes("read,grep,find,ls"));
});
