import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { now, readJson, safeFileName, writeJson } from "./utils.mjs";

export class RunStore {
  constructor(root) {
    this.root = root;
    this.runsRoot = path.join(root, "runs");
    this.writeQueues = new Map();
  }

  enqueue(runId, operation) {
    const previous = this.writeQueues.get(runId) || Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    this.writeQueues.set(runId, next);
    const cleanup = () => {
      if (this.writeQueues.get(runId) === next) this.writeQueues.delete(runId);
    };
    next.then(cleanup, cleanup);
    return next;
  }

  runDir(runId) {
    return path.join(this.runsRoot, runId);
  }

  statePath(runId) {
    return path.join(this.runDir(runId), "state.json");
  }

  eventPath(runId) {
    return path.join(this.runDir(runId), "events.jsonl");
  }

  async init(runId) {
    await mkdir(path.join(this.runDir(runId), "artifacts"), { recursive: true });
    await mkdir(path.join(this.runDir(runId), "logs"), { recursive: true });
  }

  async load(runId) {
    return readJson(this.statePath(runId));
  }

  async save(runId, state) {
    return this.enqueue(runId, async () => {
      state.updatedAt = now();
      await writeJson(this.statePath(runId), state);
      return state;
    });
  }

  async event(runId, event) {
    return this.enqueue(runId, async () => {
      const current = await this.load(runId);
      const seq = (current?.lastSeq ?? 0) + 1;
      const payload = {
        seq,
        time: now(),
        runId,
        ...event,
      };
      await appendFile(this.eventPath(runId), `${JSON.stringify(payload)}\n`, "utf8");
      if (current) {
        current.lastSeq = seq;
        await writeJson(this.statePath(runId), current);
      }
      return payload;
    });
  }

  async events(runId, after = 0) {
    try {
      const content = await readFile(this.eventPath(runId), "utf8");
      return content
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((event) => event.seq > after);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  async artifact(runId, name, content) {
    const fileName = safeFileName(name);
    const filePath = path.join(this.runDir(runId), "artifacts", fileName);
    await writeFile(filePath, content, "utf8");
    return filePath;
  }

  async log(runId, name) {
    return path.join(this.runDir(runId), "logs", safeFileName(name));
  }

  async list() {
    let entries = [];
    try {
      entries = await readdir(this.runsRoot, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    const runs = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const state = await this.load(entry.name);
      if (state) runs.push(state);
    }
    return runs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  async approve(runId, note = "") {
    await writeJson(path.join(this.runDir(runId), "approval.json"), {
      approved: true,
      note,
      approvedAt: now(),
    });
  }

  async approval(runId) {
    return readJson(path.join(this.runDir(runId), "approval.json"));
  }

  async decide(runId, decision) {
    await writeJson(path.join(this.runDir(runId), "human-decision.json"), {
      ...decision,
      decidedAt: now(),
    });
  }

  async humanDecision(runId) {
    return readJson(path.join(this.runDir(runId), "human-decision.json"));
  }
}
