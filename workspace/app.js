const { createLightLayer, svgElement } = window.LightUI;
const $ = (selector) => document.querySelector(selector);
const layer = createLightLayer();

const REPO = { owner: "hhhhhhyyy97", name: "work-Monday" };
const GITHUB_BASE = `https://github.com/${REPO.owner}/${REPO.name}`;
const BLOB_BASE = `${GITHUB_BASE}/blob/main`;

const agents = {
  workbuddy: { id: "workbuddy", name: "WorkBuddy", role: "构建者 · Kimi 3.1 Pro", color: "#2789c3" },
  codex: { id: "codex", name: "Codex", role: "统筹 + 评审", color: "#0f766e" },
  actions: { id: "actions", name: "GitHub Actions", role: "编排器", color: "#b45309" },
  human: { id: "human", name: "人工", role: "拍板 / 合并", color: "#64748b" },
  planner: { id: "planner", name: "规划者", role: "任务拆解", color: "#3b6ea5" },
  scout: { id: "scout", name: "仓库侦察", role: "代码与约束检查", color: "#7b61a8" },
  architect: { id: "architect", name: "架构师", role: "方案设计", color: "#4b7c66" },
  builder: { id: "builder", name: "构建者", role: "唯一写入者", color: "#2f76a8" },
  fixer: { id: "fixer", name: "修复者", role: "评审修复", color: "#2f76a8" },
  softwareReviewer: { id: "softwareReviewer", name: "软件评审", role: "正确性审查", color: "#0f766e" },
  methodologyReviewer: { id: "methodologyReviewer", name: "方法论评审", role: "方法与口径审查", color: "#8b5e34" },
  securityReviewer: { id: "securityReviewer", name: "安全评审", role: "安全审查", color: "#9f3b45" },
  verifier: { id: "verifier", name: "验证者", role: "命令验证", color: "#b45309" },
  coordinator: { id: "coordinator", name: "协调者", role: "质量闸门", color: "#465465" },
  orchestrator: { id: "orchestrator", name: "编排器", role: "流程控制", color: "#465465" },
};

const flowRoleAgent = {
  planner: "planner",
  scout: "scout",
  architect: "architect",
  builder: "builder",
  fixer: "fixer",
  "software-reviewer": "softwareReviewer",
  "methodology-reviewer": "methodologyReviewer",
  "security-reviewer": "securityReviewer",
  verifier: "verifier",
  coordinator: "coordinator",
  orchestrator: "orchestrator",
  human: "human",
};

const task = {
  title: "moving_average 数值模块",
  repo: `${REPO.owner}/${REPO.name}`,
  files: [
    { name: "src/series.py", url: `${BLOB_BASE}/src/series.py` },
    { name: "tests/test_series.py", url: `${BLOB_BASE}/tests/test_series.py` },
    { name: "AGENTS.md", url: `${BLOB_BASE}/AGENTS.md` },
  ],
  steps: [
    { key: "build", agent: "workbuddy", row: 0, text: "写 moving_average 模块 + 单元测试 + CI。" },
    { key: "pr", agent: "workbuddy", row: 1, parents: ["build"], text: "开 PR，打 codex-software-review 与 codex-methodology-review。" },
    { key: "label", agent: "actions", row: 2, parents: ["pr"], text: "捕获 labeled 事件，发布 @codex review。" },
    { key: "review", agent: "codex", row: 3, parents: ["label"], text: "开始评审：软件视角 + 方法论视角。" },
    { key: "sw", agent: "codex", row: 4, branch: 1, parents: ["review"], text: "软件评审：边界、测试、API 一致性。" },
    { key: "mth", agent: "codex", row: 4, branch: 2, parents: ["review"], text: "方法论评审：发现 P1 浮点漂移。" },
    { key: "fix", agent: "codex", row: 5, parents: ["sw", "mth"], kind: "merge", label: "两视角已汇合", text: "改用 math.fsum，补大数值回归测试。" },
    { key: "ci", agent: "actions", row: 6, parents: ["fix"], text: "CI：unittest Python 3.11 / 3.13 全部通过。" },
    { key: "merge", agent: "human", row: 7, parents: ["ci"], text: "合并入 main。" },
    { key: "deliver", agent: "human", row: 8, parents: ["merge"], kind: "delivery", label: "交付已保存", text: "交付：src/series.py、tests/test_series.py、AGENTS.md" },
  ],
};

const requestedMode = new URLSearchParams(location.search).get("mode");
let mode = requestedMode === "flow" ? "flow" : "demo";
let epoch = 0;
let running = false;
let index = 0;
const nodes = new Map();
const links = [];
const flights = new Set();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let token = localStorage.getItem("gh_token") || "";

// 顶部执行方按钮
const nav = $("nav");
const navAgents = {
  demo: ["workbuddy", "codex", "actions", "human"],
  live: ["workbuddy", "codex", "actions", "human"],
  flow: [
    "planner",
    "scout",
    "architect",
    "builder",
    "softwareReviewer",
    "methodologyReviewer",
    "securityReviewer",
    "verifier",
    "human",
  ],
};
function renderNav(activeMode = mode) {
  nav.replaceChildren();
  (navAgents[activeMode] || navAgents.demo).forEach((id) => {
  const a = agents[id];
  const b = document.createElement("button");
  b.dataset.agent = a.id;
  b.setAttribute("aria-pressed", "false");
  b.title = a.role;
  b.style.setProperty("--light-color", a.color);
  const dot = document.createElement("span");
  dot.className = "agent-dot";
  b.append(dot, document.createTextNode(a.name));
  nav.append(b);
  });
}

function runningBorder(bubble) {
  const svg = svgElement("svg", { class: "light-running-border", "aria-hidden": "true" });
  svg.append(
    svgElement("rect", {
      x: 1,
      y: 1,
      width: "calc(100% - 2px)",
      height: "calc(100% - 2px)",
      rx: 12,
      pathLength: 100,
    }),
  );
  bubble.append(svg);
  return () => svg.remove();
}

function clearMessages() {
  $("#messages").replaceChildren();
}
function clearTree() {
  $("#tree").querySelectorAll(".node,.node-label,.live-sub,.live-row,.live-empty").forEach((n) => n.remove());
  $("#edges").replaceChildren();
  $("#tree").style.width = "";
  $("#tree").style.height = "";
}

function renderTree() {
  const tree = $("#tree");
  const scroll = $("#tree-scroll");
  const width = Math.max(scroll.clientWidth, 260);
  const maxRow = Math.max(0, ...[...nodes.values()].map((n) => n.row));
  tree.style.width = `${width}px`;
  tree.style.height = `${Math.max(scroll.clientHeight, 120 + maxRow * 56)}px`;
  tree.querySelectorAll(".node-label").forEach((n) => n.remove());
  for (const n of nodes.values()) {
    n.x = width / 2 + (Number(n.branch) || 0) * 54;
    n.y = 64 + n.row * 56;
    Object.assign(n.element.style, { left: `${n.x}px`, top: `${n.y}px` });
    if (n.kind === "delivery" || n.kind === "merge") {
      const label = document.createElement("span");
      label.className = "node-label";
      label.textContent = n.label;
      Object.assign(label.style, { left: `${n.x + 14}px`, top: `${n.y - 6}px`, width: "110px" });
      tree.append(label);
    }
  }
  $("#edges").replaceChildren();
  for (const [from, to] of links) {
    const a = nodes.get(from);
    const b = nodes.get(to);
    if (!a || !b) continue;
    $("#edges").append(
      svgElement("path", {
        d: `M ${a.x} ${a.y} C ${a.x} ${a.y + 26} ${b.x} ${b.y - 26} ${b.x} ${b.y}`,
        fill: "none",
        stroke: b.color,
        "stroke-width": 1.2,
        "stroke-dasharray": a.branch === b.branch ? "" : "3 4",
      }),
    );
  }
  $("#counts").textContent = `${nodes.size} 个节点`;
}

function message(agent, text, user = false) {
  const bubble = document.createElement("article");
  bubble.className = `message${user ? " user" : ""}`;
  bubble.style.setProperty("--light-color", agent.color);
  if (!user) {
    const meta = document.createElement("div");
    meta.className = "meta";
    const name = document.createElement("strong");
    name.textContent = agent.name;
    const role = document.createElement("span");
    role.textContent = agent.role;
    meta.append(name, role);
    bubble.append(meta);
  }
  const p = document.createElement("p");
  p.textContent = text;
  bubble.append(p);
  $("#messages").append(bubble);
  $("#messages").scrollTop = $("#messages").scrollHeight;
  return bubble;
}

function addNode(agent, event, bubble) {
  const id = event.id ?? `${task.repo}:${event.key}`;
  const element = document.createElement("button");
  element.className = "node";
  element.dataset.state = "pending";
  element.dataset.kind = event.kind ?? "step";
  element.style.setProperty("--light-color", agent.color);
  element.setAttribute("aria-label", `${agent.name}：${event.text}`);
  element.title = event.text;
  element.addEventListener("click", () => bubble.scrollIntoView({ block: "center", behavior: "smooth" }));
  const n = { id, agent, color: agent.color, element, row: event.row, branch: event.branch ?? 0, kind: event.kind, label: event.label ?? event.text };
  nodes.set(id, n);
  $("#tree").append(element);
  for (const parent of event.parents ?? []) {
    links.push([event.parentPrefix ? `${event.parentPrefix}:${parent}` : `${task.repo}:${parent}`, id]);
  }
  renderTree();
  const scroll = $("#tree-scroll");
  scroll.scrollTop = Math.max(0, n.y - scroll.clientHeight + 95);
  return element;
}

async function step(agent, event, ownEpoch) {
  if (ownEpoch !== epoch) return;
  document.querySelectorAll("[data-agent]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.agent === agent.id)));
  const bubble = message(agent, event.text);
  const stopBorder = runningBorder(bubble);
  const target = addNode(agent, event, bubble);
  const duration = 1100;
  const handles = [bubble, $(`[data-agent="${agent.id}"]`)].map((source, i) =>
    layer.emit({ id: `event-${++index}`, source, target, color: agent.color, duration, sourceKind: i ? "model" : "message" }),
  );
  handles.forEach((h) => flights.add(h));
  const results = await Promise.all(handles.map((h) => h.finished));
  stopBorder();
  if (ownEpoch !== epoch) return;
  target.dataset.state = results.some((r) => r === "cancelled") ? "pending" : "arrived";
  if (event.kind === "delivery") {
    task.files.forEach((f) => {
      const link = document.createElement("a");
      link.className = "delivery";
      link.textContent = `↓ ${f.name}`;
      link.href = f.url;
      link.target = "_blank";
      link.rel = "noopener";
      bubble.append(link);
    });
  }
  await sleep(280);
}

async function runDemo() {
  const ownEpoch = epoch;
  message(agents.human, "需求：实现一个数值稳定的 moving_average，并走通评审闭环。", true);
  for (const s of task.steps) {
    await step(agents[s.agent], s, ownEpoch);
  }
  if (ownEpoch !== epoch) return;
  running = false;
  $("#run").disabled = false;
  $("#pause").disabled = true;
  $("#status").textContent = "交付完成";
  $("#graph-status").textContent = "全部节点已保存";
}

function clear() {
  epoch++;
  running = false;
  flights.forEach((f) => f.cancel());
  flights.clear();
  nodes.clear();
  links.length = 0;
  clearTree();
  clearMessages();
  layer.resume();
  document.body.classList.remove("light-motion-paused");
  $("#pause").textContent = "暂停动效";
  $("#pause").disabled = true;
  $("#run").disabled = false;
  $("#status").textContent = "准备就绪";
  $("#graph-status").textContent = "等待开始";
}

// ---- GitHub 实时数据 ----
async function api(path) {
  const headers = { Accept: "application/vnd.github+json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`/api/github${path}`, { headers });
  if (!res.ok) {
    let msg = `${path} -> ${res.status}`;
    try {
      const body = await res.json();
      if (body && body.message) msg += `：${body.message}`;
    } catch (_) {}
    throw new Error(msg);
  }
  return res.json();
}
async function loadLive() {
  const repo = await api(`/repos/${REPO.owner}/${REPO.name}`);
  const [branches, commits, pulls, runs, tree] = await Promise.all([
    api(`/repos/${REPO.owner}/${REPO.name}/branches`),
    api(`/repos/${REPO.owner}/${REPO.name}/commits?per_page=30`),
    api(`/repos/${REPO.owner}/${REPO.name}/pulls?state=all&per_page=30`),
    api(`/repos/${REPO.owner}/${REPO.name}/actions/runs?per_page=20`),
    api(`/repos/${REPO.owner}/${REPO.name}/git/trees/${repo.default_branch}?recursive=1`),
  ]);
  const files = (tree.tree || []).filter((t) => t.type === "blob").slice(0, 60);
  return { repo, branches, commits, pulls, runs, files };
}
function commitColor(messageText) {
  const m = (messageText || "").toLowerCase();
  if (m.startsWith("test") || m.startsWith("feat") || m.startsWith("ci")) return agents.workbuddy.color;
  if (m.startsWith("fix") || m.startsWith("chore") || m.startsWith("docs")) return agents.codex.color;
  return agents.human.color;
}
function renderLive(data) {
  clearMessages();
  clearTree();
  const head = document.createElement("div");
  head.className = "live-heading";
  const h = document.createElement("h3");
  h.textContent = data.repo.full_name;
  const p = document.createElement("p");
  p.textContent = `默认分支 ${data.repo.default_branch} · ${data.repo.visibility} · 最近 ${data.commits.length} 条提交`;
  head.append(h, p);
  $("#messages").append(head);

  data.commits.slice().reverse().forEach((c) => {
    const row = document.createElement("div");
    row.className = "live-commit";
    row.style.setProperty("--light-color", commitColor(c.commit.message));
    const msg = document.createElement("div");
    msg.className = "lc-msg";
    msg.textContent = c.commit.message.split("\n")[0];
    const meta = document.createElement("div");
    meta.className = "lc-meta";
    meta.textContent = `${c.commit.author.name} · ${c.commit.author.date.slice(0, 10)} · ${c.sha.slice(0, 7)}`;
    const a = document.createElement("a");
    a.href = c.html_url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = "↗";
    row.append(msg, meta, a);
    $("#messages").append(row);
  });

  const treeEl = $("#tree");
  const sub = (t) => {
    const d = document.createElement("div");
    d.className = "live-sub";
    d.textContent = t;
    treeEl.append(d);
  };
  sub("并行分支");
  data.branches.forEach((b) => {
    const r = document.createElement("div");
    r.className = "live-row";
    r.textContent = b.name;
    treeEl.append(r);
  });
  sub("Pull Requests");
  if (!data.pulls.length) {
    const e = document.createElement("div");
    e.className = "live-empty";
    e.textContent = "暂无 PR";
    treeEl.append(e);
  }
  data.pulls.forEach((pr) => {
    const r = document.createElement("a");
    r.className = "live-row link";
    r.href = pr.html_url;
    r.target = "_blank";
    r.rel = "noopener";
    r.textContent = `#${pr.number} ${pr.state}${pr.merged_at ? " · merged" : ""} — ${pr.title}`;
    treeEl.append(r);
  });
  sub("交付文件");
  data.files.forEach((f) => {
    const r = document.createElement("a");
    r.className = "live-row link";
    r.href = `${GITHUB_BASE}/blob/${data.repo.default_branch}/${f.path}`;
    r.target = "_blank";
    r.rel = "noopener";
    r.textContent = f.path;
    treeEl.append(r);
  });

  $("#counts").textContent = `${data.branches.length} 分支 · ${data.files.length} 文件`;
  $("#status").textContent = "GitHub 实时数据";
  $("#graph-status").textContent = `最近 ${(data.runs.workflow_runs || []).length} 次 workflow`;
}

async function refreshLive() {
  $("#run").disabled = true;
  $("#status").textContent = "拉取 GitHub 数据…";
  try {
    const data = await loadLive();
    renderLive(data);
  } catch (e) {
    clearMessages();
    const err = document.createElement("div");
    err.className = "live-empty";
    err.textContent = "拉取 GitHub 失败：" + e.message;
    $("#messages").append(err);
    $("#status").textContent = "拉取失败";
  } finally {
    $("#run").disabled = false;
  }
}

// ---- AgentFlow 实时数据 ----
let flowRunId = null;
let flowLastSeq = 0;
let flowPollTimer = null;
let flowRenderedSteps = new Set();
let flowRequestInFlight = false;
let flowLastStatus = null;
let workspaceValidationTimer = null;
let currentArtifact = null;
let directoryState = null;
let directoryRequestId = 0;

const flowStatusText = {
  running: "团队执行中",
  done: "已完成",
  changes: "需要修改",
  waiting_approval: "等待人工批准",
  completed: "已通过，待合并",
  changes_required: "仍需修改",
  failed: "运行失败",
};
const flowReviewNames = {
  software: "软件评审",
  methodology: "方法论评审",
  security: "安全评审",
};

const flowPhaseNames = {
  preparing: "准备中",
  planning: "规划中",
  building: "构建中",
  fixing: "修复中",
  verifying: "验证中",
  reviewing: "评审中",
  approval: "等待人工批准",
  delivered: "已交付",
  failed: "运行失败",
};

const legacyStepLabels = {
  "Plan & acceptance criteria": "规划与验收标准",
  "Repository scan": "仓库扫描",
  "Implementation design": "实现方案设计",
  "Build implementation": "实现构建",
  "Human approval": "人工批准",
};

function flowPhaseText(phase) {
  return flowPhaseNames[phase] || phase || "运行中";
}

function flowStepLabel(label) {
  if (!label) return "";
  if (legacyStepLabels[label]) return legacyStepLabels[label];
  return label
    .replace(/^Fix review round (\d+)$/i, "第 $1 轮评审修复")
    .replace(/^Verify:\s*/i, "运行验证：")
    .replace(/^(Software Review|Methodology Review|Security Review) · round (\d+)$/i, (_, name, round) => {
      const local = {
        "Software Review": "软件评审",
        "Methodology Review": "方法论评审",
        "Security Review": "安全评审",
      }[name];
      return `${local} · 第 ${round} 轮`;
    })
    .replace(/^Quality gate · round (\d+)$/i, "质量闸门 · 第 $1 轮");
}

function flowAgent(event) {
  return agents[flowRoleAgent[event.role]] || agents.orchestrator;
}

function flowStepLayout(step) {
  const id = step.id;
  if (id === "plan") return { row: 0, branch: 0 };
  if (id === "scout") return { row: 1, branch: -1.35 };
  if (id === "architect") return { row: 1, branch: 1.35 };
  if (id === "approval") return { row: 11, branch: 0, kind: "delivery", label: "人工批准" };

  const build = id.match(/^build-(\d+)$/);
  if (build) return { row: 2 + (Number(build[1]) - 1) * 5, branch: 0 };
  const review = id.match(/^review-(\d+)-(.+)$/);
  if (review) {
    const order = ["software", "methodology", "security"];
    return {
      row: 3 + (Number(review[1]) - 1) * 5,
      branch: (order.indexOf(review[2]) - 1) * 1.35,
    };
  }
  const verify = id.match(/^verify-(\d+)-(\d+)$/);
  if (verify) {
    return {
      row: 3 + (Number(verify[1]) - 1) * 5,
      branch: 2.4 + (Number(verify[2]) - 1) * 0.8,
    };
  }
  const gate = id.match(/^review-(\d+)$/);
  if (gate) return { row: 4 + (Number(gate[1]) - 1) * 5, branch: 0, kind: "merge", label: "质量闸门" };
  return { row: 1, branch: 0 };
}

function flowNodeFromStep(step, animateBubble = false) {
  if (flowRenderedSteps.has(step.id)) {
    const existing = nodes.get(`${flowRunId}:${step.id}`);
    if (existing) return existing.element;
    flowRenderedSteps.delete(step.id);
  }
  const agent = agents[flowRoleAgent[step.role]] || agents.orchestrator;
  const layout = flowStepLayout(step);
  const displayLabel = flowStepLabel(step.label);
  const bubble = animateBubble ? message(agent, displayLabel) : null;
  const n = addNode(agent, {
    id: `${flowRunId}:${step.id}`,
    key: step.id,
    parentIds: step.parentIds || [],
    parents: step.parentIds || [],
    parentPrefix: flowRunId,
    row: layout.row,
    branch: layout.branch,
    kind: layout.kind,
    label: layout.label || displayLabel,
    text: displayLabel,
  }, bubble || document.createElement("div"));
  if (step.status === "done") n.dataset.state = "arrived";
  if (step.status === "failed" || step.status === "changes") n.dataset.state = "pending";
  flowRenderedSteps.add(step.id);
  return n;
}

async function flowApi(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `${url} -> ${response.status}`);
  return body;
}

function setWorkspaceStatus(message, state = "") {
  const element = $("#flow-workspace-status");
  element.textContent = message;
  element.dataset.state = state;
}

function applyWorkspaceValidation(workspace) {
  $("#flow-workspace").value = workspace.path;
  const dirty = workspace.dirtyCount
    ? ` · ${workspace.dirtyCount} 个未提交改动`
    : " · 工作区干净";
  setWorkspaceStatus(`${workspace.name} · 分支 ${workspace.branch}${dirty}`, "valid");
}

async function validateWorkspaceInput(value, options = {}) {
  const workspacePath = String(value ?? $("#flow-workspace").value).trim();
  if (!workspacePath) {
    setWorkspaceStatus("请选择包含 .git 的仓库目录");
    return null;
  }
  setWorkspaceStatus("正在检查 Git 仓库…", "loading");
  try {
    const workspace = await flowApi("/api/agentflow/workspaces/validate", {
      method: "POST",
      body: JSON.stringify({ path: workspacePath }),
    });
    applyWorkspaceValidation(workspace);
    localStorage.setItem("agentflow_workspace", workspace.path);
    return workspace;
  } catch (error) {
    setWorkspaceStatus(error.message, "error");
    if (!options.quiet) $("#flow-launch-status").textContent = "";
    return null;
  }
}

async function loadRecentWorkspaces() {
  const select = $("#flow-recent-workspaces");
  const previous = select.value;
  try {
    const { workspaces } = await flowApi("/api/agentflow/workspaces");
    select.replaceChildren();
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = workspaces.length ? "最近仓库" : "暂无可用仓库";
    select.append(placeholder);
    workspaces.forEach((workspace) => {
      const option = document.createElement("option");
      option.value = workspace.path;
      option.textContent = `${workspace.name} · ${workspace.branch}`;
      option.title = workspace.path;
      select.append(option);
    });
    if (previous && workspaces.some((workspace) => workspace.path === previous)) {
      select.value = previous;
    }
  } catch (error) {
    setWorkspaceStatus(error.message, "error");
  }
}

function setDirectoryStatus(text, state = "") {
  const status = $("#directory-status");
  status.textContent = text;
  status.dataset.state = state;
}

function renderDirectory(data) {
  directoryState = data;
  $("#directory-path").value = data.path || "";
  $("#directory-up").disabled = !data.parent;
  $("#directory-current").textContent = data.path
    ? `当前目录：${data.path}`
    : "请选择快捷位置或输入目录路径";

  const selectButton = $("#directory-select-current");
  selectButton.disabled = !data.workspace;
  selectButton.textContent = data.workspace
    ? `选择 ${data.workspace.name}`
    : "选择当前仓库";

  const list = $("#directory-list");
  list.replaceChildren();
  if (!data.entries.length) {
    const empty = document.createElement("p");
    empty.className = "directory-empty";
    empty.textContent = "此目录下没有可继续浏览的子目录。";
    list.append(empty);
  } else {
    for (const entry of data.entries) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "directory-entry";
      button.title = entry.path;

      const name = document.createElement("span");
      name.className = "directory-entry-name";
      name.textContent = entry.name;
      button.append(name);

      if (entry.isRepository) {
        const badge = document.createElement("span");
        badge.className = "directory-entry-badge";
        badge.textContent = "Git 仓库";
        button.append(badge);
      }
      button.addEventListener("click", () => loadDirectory(entry.path));
      list.append(button);
    }
  }

  if (data.workspace) {
    const dirty = data.workspace.dirtyCount
      ? `，${data.workspace.dirtyCount} 个未提交改动`
      : "，工作区干净";
    setDirectoryStatus(
      `已找到 Git 仓库：${data.workspace.name} · 分支 ${data.workspace.branch}${dirty}`,
      "valid",
    );
  } else if (data.rootsMode) {
    setDirectoryStatus("从常用位置开始，进入包含 .git 的目录后即可选择。");
  } else if (data.truncated) {
    setDirectoryStatus("当前目录子项较多，仅显示前 500 个文件夹。");
  } else {
    setDirectoryStatus("当前目录不是 Git 仓库，可继续进入子目录。");
  }
}

async function loadDirectory(targetPath = "", options = {}) {
  const requestId = ++directoryRequestId;
  const list = $("#directory-list");
  const choose = $("#directory-select-current");
  choose.disabled = true;
  list.setAttribute("aria-busy", "true");
  if (!options.keepStatus) setDirectoryStatus("正在读取目录…", "loading");
  try {
    const data = await flowApi(`/api/agentflow/fs?path=${encodeURIComponent(targetPath)}`);
    if (requestId !== directoryRequestId) return;
    renderDirectory(data);
  } catch (error) {
    if (requestId !== directoryRequestId) return;
    if (targetPath && !options.fallbackToRoot) {
      setDirectoryStatus(`${error.message}，已返回快捷位置。`, "error");
      await loadDirectory("", { fallbackToRoot: true, keepStatus: true });
      return;
    }
    list.replaceChildren();
    const empty = document.createElement("p");
    empty.className = "directory-empty";
    empty.textContent = "无法读取目录，请尝试其他路径。";
    list.append(empty);
    setDirectoryStatus(error.message, "error");
  } finally {
    if (requestId === directoryRequestId) list.removeAttribute("aria-busy");
  }
}

async function openDirectoryBrowser() {
  const dialog = $("#directory-modal");
  if (!dialog.open) dialog.showModal();
  const currentPath = $("#flow-workspace").value.trim();
  await loadDirectory(currentPath);
  $("#directory-path").focus();
  $("#directory-path").select();
}

function closeDirectoryBrowser() {
  directoryRequestId++;
  $("#directory-modal").close();
}

async function selectCurrentDirectory() {
  const workspace = directoryState?.workspace;
  if (!workspace) return;
  applyWorkspaceValidation(workspace);
  localStorage.setItem("agentflow_workspace", workspace.path);
  $("#flow-launch-status").textContent = "";
  closeDirectoryBrowser();
  await loadRecentWorkspaces();
  $("#flow-recent-workspaces").value = workspace.path;
}

function artifactUrl(name) {
  return `/api/agentflow/runs/${flowRunId}/artifacts/${encodeURIComponent(name)}`;
}

function createArtifactButton(name, className = "artifact-button") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = `查看 ${name}`;
  button.addEventListener("click", () => openArtifact(name));
  return button;
}

async function openArtifact(name) {
  const dialog = $("#artifact-modal");
  const content = $("#artifact-content");
  const error = $("#artifact-error");
  const url = artifactUrl(name);
  currentArtifact = { name, url };
  $("#artifact-title").textContent = name;
  content.textContent = "正在读取产出物…";
  error.hidden = true;
  if (!dialog.open) dialog.showModal();
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`读取失败（HTTP ${response.status}）`);
    content.textContent = await response.text();
    content.scrollTop = 0;
  } catch (cause) {
    content.textContent = "无法显示该产出物。";
    error.textContent = cause.message;
    error.hidden = false;
  }
}

function appendArtifactSection(run) {
  if (!(run.artifacts || []).length) return;
  const section = document.createElement("section");
  section.className = "artifact-section";
  const title = document.createElement("h3");
  title.textContent = `产出物 · ${run.artifacts.length} 个`;
  const list = document.createElement("div");
  list.className = "artifact-list";
  const ordered = [...run.artifacts].sort((left, right) => {
    const rank = (value) => value.endsWith("final-report.md") ? 0 : value.endsWith(".patch") ? 1 : 2;
    return rank(left) - rank(right) || left.localeCompare(right, "zh-CN");
  });
  ordered.forEach((artifact) => {
    const name = artifact.split(/[\\/]/).pop();
    list.append(createArtifactButton(name));
  });
  section.append(title, list);
  $("#messages").append(section);
}

async function loadFlowRuns() {
  try {
    const { runs } = await flowApi("/api/agentflow/runs");
    const select = $("#flow-history");
    const previous = select.value || flowRunId;
    select.replaceChildren();
    if (!runs.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "暂无运行";
      select.append(option);
      return;
    }
    runs.forEach((run) => {
      const option = document.createElement("option");
      option.value = run.id;
      option.textContent = `${run.task.slice(0, 34)} · ${flowStatusText[run.status] || run.status}`;
      select.append(option);
    });
    if (previous && runs.some((run) => run.id === previous)) select.value = previous;
  } catch (error) {
    $("#flow-launch-status").textContent = error.message;
  }
}

function clearFlowView(run) {
  flowLastSeq = 0;
  flowRenderedSteps = new Set();
  nodes.clear();
  links.length = 0;
  clearMessages();
  clearTree();
  if (run) {
    message(agents.human, run.task, true);
    const note = document.createElement("div");
    note.className = "flow-note";
    note.textContent = `执行器：${run.provider} · 目标仓库：${run.sourceWorkspace}`;
    $("#messages").append(note);
    if ((run.steps || []).length > 1) {
      const recap = document.createElement("section");
      recap.className = "run-recap";
      const title = document.createElement("h3");
      title.textContent = `运行摘要 · ${run.rounds || 0} 轮`;
      const list = document.createElement("ol");
      for (const step of run.steps.slice(-12)) {
        const row = document.createElement("li");
        const label = document.createElement("strong");
        label.textContent = flowStepLabel(step.label);
        const summary = document.createElement("span");
        summary.textContent = step.summary || flowStatusText[step.status] || step.status;
        row.append(label, summary);
        list.append(row);
      }
      recap.append(title, list);
      $("#messages").append(recap);
    }
    if (["completed", "changes_required", "failed"].includes(run.status)) {
      appendArtifactSection(run);
    }
    for (const step of run.steps || []) flowNodeFromStep(step);
  }
}

async function animateFlowEvent(event, run) {
  if (!["step.started", "step.finished", "step.failed", "step.changes", "workspace.ready", "run.waiting_approval", "run.finished", "run.failed"].includes(event.type)) {
    return;
  }
  const agent = flowAgent(event);
  const text =
    event.type === "run.waiting_approval"
      ? "所有质量闸门已通过，等待人工批准后交付。"
      : event.type === "run.finished"
        ? event.message
        : event.message || event.label || event.type;
  const bubble = message(agent, text);
  const stopBorder = runningBorder(bubble);
  if (event.type === "run.finished") {
    for (const artifact of run.artifacts || []) {
      const name = artifact.split(/[\\/]/).pop();
      if (name !== "final-report.md" && !artifact.endsWith(".patch")) continue;
      bubble.append(createArtifactButton(name, "delivery artifact-button"));
    }
  }

  let step = null;
  if (event.stepId && flowRunId) {
    step = (run.steps || []).find((item) => item.id === event.stepId);
  }
  if (step) {
    const node = flowNodeFromStep(step, true);
    const handles = [bubble, $(`[data-agent="${agent.id}"]`)].filter(Boolean).map((source, index) =>
      layer.emit({
        id: `flow-${event.seq}-${index}`,
        source,
        target: node,
        color: agent.color,
        duration: 900,
        sourceKind: index ? "model" : "message",
      }),
    );
    handles.forEach((handle) => flights.add(handle));
    await Promise.all(handles.map((handle) => handle.finished));
    handles.forEach((handle) => flights.delete(handle));
    if (node && step.status === "done") node.dataset.state = "arrived";
  }
  stopBorder();
}

async function pollFlow() {
  if (mode !== "flow" || !flowRunId || flowRequestInFlight) return;
  flowRequestInFlight = true;
  try {
    const { run, events } = await flowApi(
      `/api/agentflow/runs/${flowRunId}?after=${flowLastSeq}`,
    );
    flowLastSeq = Math.max(flowLastSeq, ...events.map((event) => event.seq), 0);
    for (const event of events.sort((a, b) => a.seq - b.seq)) {
      await animateFlowEvent(event, run);
    }
    flowLastStatus = run.status;
    $("#task-title").textContent = run.task;
    $("#footer-help").textContent = `规划者拆任务，仓库侦察与架构师并行调研，构建者唯一写入，${(run.reviewers || []).map((name) => flowReviewNames[name] || name).join(" / ") || "独立评审者"} 独立审查。`;
    $("#status").textContent = flowStatusText[run.status] || run.status;
    $("#graph-status").textContent =
      run.status === "waiting_approval"
        ? "待人工批准"
        : run.status === "completed"
          ? "交付已保存"
          : run.status === "changes_required"
            ? "仍需修改"
            : run.status === "failed"
              ? "运行失败"
              : run.phase === "reviewing"
                ? "评审并行分叉中"
                : flowPhaseText(run.phase);
    $("#approve").hidden = run.status !== "waiting_approval";
    $("#counts").textContent = `${(run.steps || []).length} 个节点`;
    if (run.status === "failed") $("#status").title = run.error || "";
    if (["completed", "changes_required", "failed"].includes(run.status)) loadFlowRuns();
  } catch (error) {
    $("#flow-launch-status").textContent = error.message;
  } finally {
    flowRequestInFlight = false;
    clearTimeout(flowPollTimer);
    const finished = ["completed", "changes_required", "failed"].includes(flowLastStatus);
    if (mode === "flow" && flowRunId && !finished) {
      flowPollTimer = setTimeout(pollFlow, 900);
    }
  }
}

async function selectFlowRun(runId) {
  clearTimeout(flowPollTimer);
  flowRunId = runId;
  flowLastSeq = 0;
  $("#approve").hidden = true;
  try {
    let result;
    let lastError;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        result = await flowApi(`/api/agentflow/runs/${runId}?after=0`);
        break;
      } catch (error) {
        lastError = error;
        await sleep(120);
      }
    }
    if (!result) throw lastError;
    const { run, events } = result;
    clearFlowView(run);
    flowLastStatus = run.status;
    flowLastSeq = Math.max(0, ...events.map((event) => event.seq));
    $("#task-title").textContent = run.task;
    $("#footer-help").textContent = `规划者拆任务，仓库侦察与架构师并行调研，构建者唯一写入，${(run.reviewers || []).map((name) => flowReviewNames[name] || name).join(" / ") || "独立评审者"} 独立审查。`;
    if (run.sourceWorkspace) {
      $("#flow-workspace").value = run.sourceWorkspace;
      localStorage.setItem("agentflow_workspace", run.sourceWorkspace);
      validateWorkspaceInput(run.sourceWorkspace, { quiet: true });
    }
    $("#status").textContent = flowStatusText[run.status] || run.status;
    $("#graph-status").textContent = flowPhaseText(run.phase);
    $("#approve").hidden = run.status !== "waiting_approval";
    $("#flow-history").value = runId;
    loadFlowRuns();
    pollFlow();
  } catch (error) {
    $("#flow-launch-status").textContent = error.message;
  }
}

async function startFlow(event) {
  event.preventDefault();
  const task = $("#flow-task").value.trim();
  const workspace = $("#flow-workspace").value.trim();
  if (!task) {
    $("#flow-launch-status").textContent = "请填写任务内容。";
    $("#flow-task").focus();
    return;
  }
  if (!workspace) {
    $("#flow-launch-status").textContent = "请选择目标仓库。";
    $("#flow-choose-workspace").focus();
    return;
  }
  $("#flow-start").disabled = true;
  $("#flow-launch-status").textContent = "正在检查目标仓库…";
  try {
    const validatedWorkspace = await validateWorkspaceInput(workspace);
    if (!validatedWorkspace) {
      $("#flow-launch-status").textContent = "请先选择有效的 Git 仓库。";
      return;
    }
    $("#flow-launch-status").textContent = "正在准备隔离工作区…";
    const body = {
      task,
      workspace: validatedWorkspace.path,
      provider: $("#flow-provider").value,
      verifyCommands: $("#flow-commands").value
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
      approval: $("#flow-approval").checked ? "required" : "auto",
      reviewers: ["software", "methodology", "security"],
      maxRounds: 2,
    };
    const result = await flowApi("/api/agentflow/runs", {
      method: "POST",
      body: JSON.stringify(body),
    });
    localStorage.setItem("agentflow_workspace", validatedWorkspace.path);
    localStorage.setItem("agentflow_provider", body.provider);
    $("#flow-launch-status").textContent = `已启动：${result.runId}`;
    await loadFlowRuns();
    await loadRecentWorkspaces();
    await selectFlowRun(result.runId);
    if (window.matchMedia("(max-width: 760px)").matches) {
      $("main").scrollIntoView({ behavior: "smooth", block: "start" });
    }
  } catch (error) {
    $("#flow-launch-status").textContent = error.message;
  } finally {
    $("#flow-start").disabled = false;
  }
}

function setMode(m) {
  mode = m;
  clear();
  clearTimeout(flowPollTimer);
  renderNav(m);
  document.body.classList.toggle("mode-flow", m === "flow");
  document.querySelectorAll("[data-mode]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === m)));
  $("#flow-launch").hidden = m !== "flow";
  $("#flow-history-box").hidden = m !== "flow";
  $(".token-box").hidden = m === "flow";
  $("#approve").hidden = true;
  if (m === "live") {
    $("#run").textContent = "刷新";
    $("#pause").disabled = true;
    $("#reset").disabled = true;
    $("#status").textContent = "GitHub 实时";
    $("#graph-status").textContent = "等待拉取";
    refreshLive();
  } else if (m === "flow") {
    $("#aside-title").innerHTML = "Agent 团队<br />任务控制台";
    $("#run").textContent = "刷新";
    $("#pause").disabled = true;
    $("#reset").disabled = true;
    $("#status").textContent = "AgentFlow";
    $("#graph-status").textContent = flowRunId ? "载入运行" : "等待任务";
    $("#task-title").textContent = "多 Agent 协作运行";
    $("#footer-help").textContent = "规划者拆任务，仓库侦察与架构师并行调研，构建者唯一写入，三类评审者并行审查。";
    const welcome = document.createElement("div");
    welcome.className = "welcome";
    welcome.innerHTML = "<span>↗</span><h3>从左侧启动一个 Agent 团队</h3><p>默认在隔离工作区中运行；全绿后再由人决定是否合并。</p>";
    $("#messages").append(welcome);
    loadRecentWorkspaces();
    if ($("#flow-workspace").value.trim()) {
      validateWorkspaceInput($("#flow-workspace").value, { quiet: true });
    }
    loadFlowRuns().then(() => {
      const historyValue = $("#flow-history").value;
      if (flowRunId) selectFlowRun(flowRunId);
      else if (historyValue) selectFlowRun(historyValue);
    });
  } else {
    $("#aside-title").innerHTML = "一次任务，<br />从头到尾可追溯。";
    $("#run").textContent = "开始运行 →";
    $("#reset").disabled = false;
    $("#status").textContent = "准备就绪";
    $("#graph-status").textContent = "等待开始";
    $("#task-title").textContent = "moving_average 数值模块（走通闭环）";
    $("#footer-help").textContent = "软件评审与方法论评审并行分叉，修复时汇合；交付节点可点回对应气泡。";
    $("#messages").replaceChildren();
    const w = document.createElement("div");
    w.className = "welcome";
    w.innerHTML = "<span>↗</span><h3>点「开始运行」</h3><p>观察执行方的光线怎样落到工作树节点。</p>";
    $("#messages").append(w);
    renderTree();
  }
}

$("#run").addEventListener("click", async () => {
  if (mode === "live") {
    await refreshLive();
    return;
  }
  if (mode === "flow") {
    if (flowRunId) await selectFlowRun(flowRunId);
    return;
  }
  if (running) return;
  clear();
  running = true;
  $("#run").disabled = true;
  $("#pause").disabled = false;
  $("#status").textContent = "运行中";
  $("#graph-status").textContent = "跟随新节点";
  await runDemo();
});
$("#pause").addEventListener("click", () => {
  if (layer.paused) layer.resume();
  else layer.pause();
  document.body.classList.toggle("light-motion-paused", layer.paused);
  $("#pause").textContent = layer.paused ? "继续动效" : "暂停动效";
});
$("#reset").addEventListener("click", () => {
  if (mode === "demo") setMode("demo");
});
document.querySelectorAll("[data-mode]").forEach((b) =>
  b.addEventListener("click", () => setMode(b.dataset.mode)),
);
$("#flow-launch").addEventListener("submit", startFlow);
$("#flow-history").addEventListener("change", (event) => {
  if (event.target.value) selectFlowRun(event.target.value);
});
$("#flow-recent-workspaces").addEventListener("change", (event) => {
  if (!event.target.value) return;
  $("#flow-workspace").value = event.target.value;
  validateWorkspaceInput(event.target.value);
});
$("#flow-choose-workspace").addEventListener("click", openDirectoryBrowser);
$("#directory-close").addEventListener("click", closeDirectoryBrowser);
$("#directory-up").addEventListener("click", () => {
  if (directoryState?.parent) loadDirectory(directoryState.parent);
});
$("#directory-go").addEventListener("click", () => {
  loadDirectory($("#directory-path").value.trim());
});
$("#directory-path").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    loadDirectory(event.currentTarget.value.trim());
  }
});
$("#directory-select-current").addEventListener("click", selectCurrentDirectory);
$("#directory-modal").addEventListener("click", (event) => {
  if (event.target === event.currentTarget) closeDirectoryBrowser();
});
$("#flow-workspace").addEventListener("change", (event) => {
  validateWorkspaceInput(event.target.value);
});
$("#flow-workspace").addEventListener("input", (event) => {
  clearTimeout(workspaceValidationTimer);
  workspaceValidationTimer = setTimeout(() => {
    if (event.target.value.trim()) validateWorkspaceInput(event.target.value, { quiet: true });
  }, 500);
});
$("#artifact-close").addEventListener("click", () => $("#artifact-modal").close());
$("#artifact-new-tab").addEventListener("click", () => {
  if (currentArtifact) window.open(currentArtifact.url, "_blank", "noopener,noreferrer");
});
$("#artifact-download").addEventListener("click", () => {
  if (!currentArtifact) return;
  const link = document.createElement("a");
  link.href = currentArtifact.url;
  link.download = currentArtifact.name;
  document.body.append(link);
  link.click();
  link.remove();
});
$("#artifact-modal").addEventListener("click", (event) => {
  if (event.target === event.currentTarget) event.currentTarget.close();
});
$("#approve").addEventListener("click", async () => {
  if (!flowRunId) return;
  $("#approve").disabled = true;
  try {
    await flowApi(`/api/agentflow/runs/${flowRunId}/approve`, {
      method: "POST",
      body: JSON.stringify({ note: "已从 Lancer 工作台批准" }),
    });
    $("#status").textContent = "已批准，正在交付";
    await selectFlowRun(flowRunId);
  } catch (error) {
    $("#flow-launch-status").textContent = error.message;
  } finally {
    $("#approve").disabled = false;
  }
});

const savedFlowWorkspace = localStorage.getItem("agentflow_workspace");
if (savedFlowWorkspace) $("#flow-workspace").value = savedFlowWorkspace;
const savedFlowProvider = localStorage.getItem("agentflow_provider");
if (savedFlowProvider) $("#flow-provider").value = savedFlowProvider;
renderNav(mode);
if (mode === "flow") setMode("flow");

// 只读 GitHub Token（存在浏览器本地，避免私有仓库 404 / 匿名限流）
const tokenInput = $("#gh-token");
if (token) tokenInput.value = token;
$("#save-token").addEventListener("click", () => {
  token = tokenInput.value.trim();
  if (token) localStorage.setItem("gh_token", token);
  else localStorage.removeItem("gh_token");
  $("#status").textContent = token ? "已保存 token" : "已清除 token";
  if (mode === "live") refreshLive();
});

const resize = new ResizeObserver(renderTree);
resize.observe($("#tree-scroll"));
window.addEventListener("pagehide", () => {
  epoch++;
  clearTimeout(flowPollTimer);
  clearTimeout(workspaceValidationTimer);
  flights.forEach((f) => f.cancel());
  flights.clear();
  layer.destroy();
  resize.disconnect();
});
