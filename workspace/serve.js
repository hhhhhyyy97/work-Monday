const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { execFile, spawn } = require("child_process");
const { randomUUID } = require("crypto");

const root = __dirname;
const agentflowRoot = path.resolve(root, "..", "agentflow");
const runsRoot = path.join(agentflowRoot, "runs");
const cliPath = path.join(agentflowRoot, "src", "cli.mjs");
const port = 4178;
const host = process.env.AGENTFLOW_HOST || "127.0.0.1";
const runningJobs = new Map();
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function sendJson(res, status, value) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(value));
}

async function readBody(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function safeRunId(value) {
  return /^[a-zA-Z0-9._-]+$/.test(value) && value !== "." && value !== ".." && !value.includes("..")
    ? value
    : null;
}

async function loadRun(runId) {
  if (!safeRunId(runId)) throw new Error("Invalid run id.");
  return JSON.parse(await fsp.readFile(path.join(runsRoot, runId, "state.json"), "utf8"));
}

async function loadEvents(runId, after) {
  if (!safeRunId(runId)) throw new Error("Invalid run id.");
  try {
    const text = await fsp.readFile(path.join(runsRoot, runId, "events.jsonl"), "utf8");
    return text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((event) => event.seq > after);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function listRuns(limit = 30) {
  let entries = [];
  try {
    entries = await fsp.readdir(runsRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const runs = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !safeRunId(entry.name)) continue;
    try {
      const run = await loadRun(entry.name);
      runs.push({
        id: run.id,
        task: run.task,
        status: run.status,
        phase: run.phase,
        provider: run.provider,
        sourceWorkspace: run.sourceWorkspace,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
      });
    } catch {}
  }
  return runs
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, limit);
}

async function startAgentFlow(body) {
  const task = String(body.task || "").trim();
  if (!task) throw new Error("Task is required.");
  const workspaceInput = String(body.workspace || "").trim();
  if (!workspaceInput) throw new Error("Workspace is required.");
  const workspace = path.resolve(workspaceInput);
  const workspaceStat = await fsp.stat(workspace).catch(() => null);
  if (!workspaceStat?.isDirectory()) throw new Error("Workspace directory does not exist.");
  await new Promise((resolve, reject) => {
    execFile(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd: workspace, windowsHide: true },
      (error) => {
        if (error) {
          reject(
            new Error(
              `目标目录不是 Git 仓库：${workspace}。请选择已有仓库，或新建项目目录并执行 git init。`,
            ),
          );
        } else {
          resolve();
        }
      },
    );
  });

  const runId = `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  const runDir = path.join(runsRoot, runId);
  await fsp.mkdir(path.join(runDir, "logs"), { recursive: true });
  const logPath = path.join(runDir, "logs", "orchestrator.log");
  const logStream = fs.createWriteStream(logPath, { flags: "a" });
  const args = [
    cliPath,
    "run",
    "--task",
    "-",
    "--workspace",
    workspace,
    "--run-id",
    runId,
    "--provider",
    ["mock", "pi"].includes(body.provider) ? body.provider : "codex",
    "--approval",
    body.approval === "auto" ? "auto" : "required",
    "--max-rounds",
    String(Math.max(1, Math.min(5, Number(body.maxRounds) || 2))),
  ];
  const commands = Array.isArray(body.verifyCommands)
    ? body.verifyCommands
    : String(body.verifyCommands || "")
        .split(/\r?\n/)
        .filter(Boolean);
  commands.forEach((command) => args.push("--verify", String(command).trim()));
  if (Array.isArray(body.reviewers) && body.reviewers.length) {
    args.push("--reviewers", body.reviewers.join(","));
  }
  if (body.inPlace === true) args.push("--in-place");

  const child = spawn(process.execPath, args, {
    cwd: agentflowRoot,
    env: process.env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  runningJobs.set(runId, child);
  child.stdout.pipe(logStream, { end: false });
  child.stderr.pipe(logStream, { end: false });
  child.stdin.end(task);
  child.on("close", (code) => {
    runningJobs.delete(runId);
    logStream.write(`\n[orchestrator exited ${code}]\n`);
    logStream.end();
  });
  child.on("error", (error) => {
    runningJobs.delete(runId);
    logStream.write(`\n[orchestrator error] ${error.stack || error.message}\n`);
    logStream.end();
  });
  return { runId };
}

http
  .createServer(async (req, res) => {
    const rawUrl = req.url || "/";
    const urlPath = decodeURIComponent(rawUrl.split("?")[0]);
    const query = rawUrl.includes("?") ? rawUrl.slice(rawUrl.indexOf("?")) : "";
    const queryParams = new URLSearchParams(query);

    if (urlPath === "/api/agentflow/runs" && req.method === "GET") {
      try {
        sendJson(res, 200, { runs: await listRuns(Number(queryParams.get("limit")) || 30) });
      } catch (error) {
        sendJson(res, 500, { error: error.message });
      }
      return;
    }

    if (urlPath === "/api/agentflow/runs" && req.method === "POST") {
      try {
        sendJson(res, 202, await startAgentFlow(await readBody(req)));
      } catch (error) {
        sendJson(res, 400, { error: error.message });
      }
      return;
    }

    const runMatch = urlPath.match(/^\/api\/agentflow\/runs\/([^/]+)$/);
    if (runMatch && req.method === "GET") {
      try {
        const runId = runMatch[1];
        const [run, events] = await Promise.all([
          loadRun(runId),
          loadEvents(runId, Number(queryParams.get("after")) || 0),
        ]);
        sendJson(res, 200, { run, events });
      } catch (error) {
        sendJson(res, error.code === "ENOENT" ? 404 : 400, { error: error.message });
      }
      return;
    }

    const approveMatch = urlPath.match(/^\/api\/agentflow\/runs\/([^/]+)\/approve$/);
    if (approveMatch && req.method === "POST") {
      try {
        const runId = approveMatch[1];
        const run = await loadRun(runId);
        if (run.status !== "waiting_approval") {
          throw new Error(`Run is not waiting for approval (${run.status}).`);
        }
        const body = await readBody(req);
        await fsp.writeFile(
          path.join(runsRoot, runId, "approval.json"),
          JSON.stringify(
            {
              approved: true,
              note: String(body.note || ""),
              approvedAt: new Date().toISOString(),
            },
            null,
            2,
          ),
        );
        sendJson(res, 200, { approved: true });
      } catch (error) {
        sendJson(res, 400, { error: error.message });
      }
      return;
    }

    const artifactMatch = urlPath.match(
      /^\/api\/agentflow\/runs\/([^/]+)\/artifacts\/([^/]+)$/,
    );
    if (artifactMatch && req.method === "GET") {
      try {
        const runId = artifactMatch[1];
        if (!safeRunId(runId) || !safeRunId(artifactMatch[2])) throw new Error("Invalid path.");
        const filePath = path.join(runsRoot, runId, "artifacts", artifactMatch[2]);
        const data = await fsp.readFile(filePath);
        res.writeHead(200, {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(data);
      } catch (error) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("artifact not found");
      }
      return;
    }

    // 代理 GitHub API，绕开本机到 api.github.com 的网络问题。
    if (urlPath.startsWith("/api/github/")) {
      const ghPath = urlPath.slice("/api/github".length) + query;
      const headers = {
        "User-Agent": "workspace-proxy",
        Accept: "application/vnd.github+json",
      };
      if (req.headers.authorization) headers.Authorization = req.headers.authorization;
      try {
        const upstream = await fetch("https://api.github.com" + ghPath, { headers });
        const body = Buffer.from(await upstream.arrayBuffer());
        res.writeHead(upstream.status, {
          "Content-Type": upstream.headers.get("content-type") || "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(body);
      } catch (e) {
        res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("proxy error: " + e.message);
      }
      return;
    }

    let file = path.join(root, urlPath === "/" ? "index.html" : urlPath);
    if (!file.startsWith(root)) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }
    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("not found");
        return;
      }
      res.writeHead(200, {
        "Content-Type": types[path.extname(file).toLowerCase()] || "application/octet-stream",
      });
      fs.createReadStream(file).pipe(res);
    });
  })
  .listen(port, host, () => {
    console.log(`workspace: http://${host}:${port}`);
  });
