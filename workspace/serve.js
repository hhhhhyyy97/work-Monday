const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const { execFile, spawn } = require("child_process");
const { randomUUID } = require("crypto");

const root = __dirname;
const agentflowRoot = path.resolve(root, "..", "agentflow");
const legacyRunsRoot = path.join(agentflowRoot, "runs");
const fallbackRunsBase = path.join(os.tmpdir(), "agentflow");
const fallbackRunsRoot = path.join(fallbackRunsBase, "runs");

function prependExecutablePath(directories) {
  const pathEntries = String(process.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean);
  const seen = new Set(pathEntries.map((entry) => path.resolve(entry).toLowerCase()));
  for (const directory of directories) {
    if (!directory || !fs.existsSync(directory)) continue;
    const resolved = path.resolve(directory);
    if (seen.has(resolved.toLowerCase())) continue;
    pathEntries.unshift(resolved);
    seen.add(resolved.toLowerCase());
  }
  process.env.PATH = pathEntries.join(path.delimiter);
}

function configureExecutablePaths() {
  const home = os.homedir();
  const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const gitDirectories = [
    path.join(
      home,
      ".cache",
      "codex-runtimes",
      "codex-primary-runtime",
      "dependencies",
      "native",
      "git",
      "cmd",
    ),
    "C:\\Program Files\\Git\\cmd",
    "C:\\Program Files (x86)\\Git\\cmd",
  ];
  const codexRoot = path.join(localAppData, "OpenAI", "Codex", "bin");
  const codexCandidates = [];
  try {
    for (const entry of fs.readdirSync(codexRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const executable = path.join(codexRoot, entry.name, "codex.exe");
      if (fs.existsSync(executable)) {
        codexCandidates.push({ executable, modifiedAt: fs.statSync(executable).mtimeMs });
      }
    }
  } catch {}
  codexCandidates.sort((left, right) => right.modifiedAt - left.modifiedAt);
  prependExecutablePath([...gitDirectories, ...codexCandidates.map((entry) => path.dirname(entry.executable))]);
  if (!process.env.AGENTFLOW_CODEX_BIN && codexCandidates[0]) {
    process.env.AGENTFLOW_CODEX_BIN = codexCandidates[0].executable;
  }
}

configureExecutablePaths();

function canWriteDirectory(directory) {
  try {
    fs.mkdirSync(directory, { recursive: true });
    const probe = path.join(directory, `.write-probe-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probe, "");
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function resolveRunsStorage() {
  const configured = String(process.env.AGENTFLOW_RUNS_ROOT || "").trim();
  if (configured) {
    const base = path.resolve(configured);
    const runs = path.join(base, "runs");
    fs.mkdirSync(runs, { recursive: true });
    return { base, runs };
  }
  if (canWriteDirectory(legacyRunsRoot)) {
    return { base: path.resolve(agentflowRoot), runs: path.resolve(legacyRunsRoot) };
  }

  fs.mkdirSync(fallbackRunsRoot, { recursive: true });
  return { base: fallbackRunsBase, runs: fallbackRunsRoot };
}

const runsStorage = resolveRunsStorage();
const runsRoot = runsStorage.runs;
const readableRunsRoots = [
  ...new Set([runsRoot, path.resolve(legacyRunsRoot), path.resolve(fallbackRunsRoot)]),
];
process.env.AGENTFLOW_RUNS_ROOT = runsStorage.base;
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
function runFile(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        ...options,
      },
      (error, stdout, stderr) => {
        if (error) {
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
      },
    );
  });
}

async function validateWorkspace(inputPath) {
  const rawPath = String(inputPath || "").trim();
  if (!rawPath) throw new Error("请选择目标仓库。");
  const requestedPath = path.resolve(rawPath);
  const workspaceStat = await fsp.stat(requestedPath).catch(() => null);
  if (!workspaceStat?.isDirectory()) {
    throw new Error(`目标目录不存在：${requestedPath}`);
  }

  let root;
  try {
    ({ stdout: root } = await runFile("git", ["rev-parse", "--show-toplevel"], {
      cwd: requestedPath,
    }));
  } catch {
    throw new Error(`目标目录不是 Git 仓库：${requestedPath}`);
  }
  root = path.resolve(root.trim());

  try {
    await runFile("git", ["rev-parse", "--verify", "HEAD"], { cwd: root });
  } catch {
    throw new Error(`Git 仓库还没有任何提交：${root}`);
  }

  const [{ stdout: branch }, statusResult] = await Promise.all([
    runFile("git", ["branch", "--show-current"], { cwd: root }),
    runFile("git", ["status", "--porcelain"], { cwd: root }).catch(() => ({ stdout: "" })),
  ]);
  const dirtyCount = statusResult.stdout.trim()
    ? statusResult.stdout.trim().split(/\r?\n/).length
    : 0;
  return {
    valid: true,
    path: root,
    name: path.basename(root),
    branch: branch.trim() || "detached",
    dirtyCount,
  };
}

async function recentWorkspaces() {
  const runs = await listRuns(100);
  const seen = new Set();
  const workspaces = [];
  for (const run of runs) {
    if (!run.sourceWorkspace || seen.has(run.sourceWorkspace)) continue;
    seen.add(run.sourceWorkspace);
    try {
      workspaces.push({
        ...(await validateWorkspace(run.sourceWorkspace)),
        lastUsedAt: run.updatedAt,
      });
    } catch {}
  }
  return workspaces.slice(0, 12);
}

function isRepositoryDirectory(directory) {
  try {
    return fs.existsSync(path.join(directory, ".git"));
  } catch {
    return false;
  }
}

async function listFilesystemDirectory(inputPath = "") {
  const rawPath = String(inputPath || "").trim();
  if (!rawPath) {
    const home = os.homedir();
    const candidates = [
      { name: "用户目录", path: home },
      { name: "桌面", path: path.join(home, "Desktop") },
      { name: "文档", path: path.join(home, "Documents") },
      { name: "当前项目", path: path.resolve(root, "..") },
    ];
    for (const drive of ["C", "D", "E", "F"]) {
      candidates.push({ name: `${drive} 盘`, path: `${drive}:\\` });
    }
    const seen = new Set();
    const entries = [];
    for (const candidate of candidates) {
      if (!candidate.path || seen.has(candidate.path) || !fs.existsSync(candidate.path)) continue;
      seen.add(candidate.path);
      entries.push({
        name: candidate.name,
        path: candidate.path,
        isRepository: isRepositoryDirectory(candidate.path),
      });
    }
    return {
      path: "",
      parent: null,
      entries,
      workspace: null,
      rootsMode: true,
    };
  }

  const directory = path.resolve(rawPath);
  const directoryStat = await fsp.stat(directory).catch(() => null);
  if (!directoryStat?.isDirectory()) {
    throw new Error(`目录不存在或无法访问：${directory}`);
  }

  let directoryEntries;
  try {
    directoryEntries = await fsp.readdir(directory, { withFileTypes: true });
  } catch {
    throw new Error(`没有权限读取目录：${directory}`);
  }

  const entries = directoryEntries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .slice(0, 500)
    .map((entry) => {
      const childPath = path.join(directory, entry.name);
      return {
        name: entry.name,
        path: childPath,
        isRepository: isRepositoryDirectory(childPath),
      };
    })
    .sort((left, right) => {
      if (left.isRepository !== right.isRepository) return left.isRepository ? -1 : 1;
      return left.name.localeCompare(right.name, "zh-CN");
    });

  let workspace = null;
  if (isRepositoryDirectory(directory)) {
    try {
      workspace = await validateWorkspace(directory);
    } catch {}
  }
  const parent = path.dirname(directory);
  return {
    path: directory,
    parent: parent === directory ? null : parent,
    entries,
    workspace,
    rootsMode: false,
    truncated: directoryEntries.length > entries.length,
  };
}

function sendJson(res, status, value) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
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

async function findRunFile(runId, relativePath) {
  let lastError;
  for (const candidateRoot of readableRunsRoots) {
    try {
      const filePath = path.join(candidateRoot, runId, relativePath);
      return { root: candidateRoot, path: filePath, data: await fsp.readFile(filePath) };
    } catch (error) {
      lastError = error;
      if (error.code !== "ENOENT") throw error;
    }
  }
  throw lastError || Object.assign(new Error("Run file not found."), { code: "ENOENT" });
}

async function findRunDirectory(runId) {
  const state = await findRunFile(runId, "state.json");
  return path.join(state.root, runId);
}

async function loadRun(runId) {
  if (!safeRunId(runId)) throw new Error("Invalid run id.");
  const state = await findRunFile(runId, "state.json");
  return JSON.parse(state.data.toString("utf8"));
}

async function loadEvents(runId, after) {
  if (!safeRunId(runId)) throw new Error("Invalid run id.");
  try {
    const eventsFile = await findRunFile(runId, "events.jsonl");
    const text = eventsFile.data.toString("utf8");
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
  const runsById = new Map();
  for (const candidateRoot of readableRunsRoots) {
    let entries = [];
    try {
      entries = await fsp.readdir(candidateRoot, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !safeRunId(entry.name)) continue;
      try {
        const data = await fsp.readFile(path.join(candidateRoot, entry.name, "state.json"), "utf8");
        const run = JSON.parse(data);
        if (!runsById.has(run.id)) {
          runsById.set(run.id, {
            id: run.id,
            task: run.task,
            status: run.status,
            phase: run.phase,
            provider: run.provider,
            sourceWorkspace: run.sourceWorkspace,
            createdAt: run.createdAt,
            updatedAt: run.updatedAt,
          });
        }
      } catch {}
    }
  }
  return [...runsById.values()]
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, limit);
}

async function startAgentFlow(body) {
  const task = String(body.task || "").trim();
  if (!task) throw new Error("请填写任务内容。");
  const workspaceInput = String(body.workspace || "").trim();
  if (!workspaceInput) throw new Error("请选择目标仓库。");
  const workspace = (await validateWorkspace(workspaceInput)).path;

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

    if (urlPath === "/api/agentflow/workspaces" && req.method === "GET") {
      try {
        sendJson(res, 200, { workspaces: await recentWorkspaces() });
      } catch (error) {
        sendJson(res, 500, { error: error.message });
      }
      return;
    }

    if (urlPath === "/api/agentflow/storage" && req.method === "GET") {
      sendJson(res, 200, { runsRoot, readableRunsRoots });
      return;
    }

    if (urlPath === "/api/agentflow/workspaces/validate" && req.method === "POST") {
      try {
        const body = await readBody(req);
        sendJson(res, 200, await validateWorkspace(body.path));
      } catch (error) {
        sendJson(res, 400, { error: error.message });
      }
      return;
    }

    if (urlPath === "/api/agentflow/fs" && req.method === "GET") {
      try {
        sendJson(res, 200, await listFilesystemDirectory(queryParams.get("path") || ""));
      } catch (error) {
        sendJson(res, 400, { error: error.message });
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
          path.join(await findRunDirectory(runId), "approval.json"),
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
        const artifact = await findRunFile(runId, path.join("artifacts", artifactMatch[2]));
        res.writeHead(200, {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(artifact.data);
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
    console.log(`runs: ${runsRoot}`);
  });
