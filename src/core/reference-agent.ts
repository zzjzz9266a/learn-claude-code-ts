import Anthropic from "@anthropic-ai/sdk";
import { config as loadDotenv } from "dotenv";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { cwd } from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

loadDotenv({ override: true, quiet: true });

if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type Message =
  | { role: "user"; content: string | JsonValue[] }
  | { role: "assistant"; content: any };

export type ToolSchema = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export type ToolHandler = (input: Record<string, any>) => Promise<string> | string;

export type BackgroundTask = {
  status: string;
  command: string;
  result: string | null;
};

export type TaskRecord = {
  id: number;
  subject: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "deleted";
  owner?: string | null;
  worktree?: string;
  blockedBy?: number[];
  created_at?: number;
  updated_at?: number;
};

export type WorktreeRecord = {
  name: string;
  path: string;
  branch: string;
  task_id?: number | null;
  status: string;
  created_at?: number;
  removed_at?: number;
  kept_at?: number;
};

export const WORKDIR = process.cwd();
export const MODEL = process.env.MODEL_ID ?? "claude-sonnet-4-6";
export const TOKEN_THRESHOLD = 50_000;
export const FULL_TOKEN_THRESHOLD = 100_000;
export const KEEP_RECENT_TOOL_RESULTS = 3;
export const PRESERVE_RESULT_TOOLS = new Set(["read_file"]);
export const POLL_INTERVAL = 5;
export const IDLE_TIMEOUT = 60;
export const VALID_MSG_TYPES = new Set([
  "message",
  "broadcast",
  "shutdown_request",
  "shutdown_response",
  "plan_approval_response"
]);

export const TEAM_DIR = join(WORKDIR, ".team");
export const INBOX_DIR = join(TEAM_DIR, "inbox");
export const TASKS_DIR = join(WORKDIR, ".tasks");
export const SKILLS_DIR = join(WORKDIR, "skills");
export const TRANSCRIPT_DIR = join(WORKDIR, ".transcripts");

export function createClient() {
  return new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL });
}

export function createSystemPrompt(instructions: string) {
  return `You are a coding agent at ${WORKDIR}. ${instructions}`;
}

export function safePath(relativePath: string) {
  const fullPath = resolve(WORKDIR, relativePath);
  const root = resolve(WORKDIR);
  const fromRoot = relative(root, fullPath);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || resolve(fromRoot) === fromRoot) {
    throw new Error(`Path escapes workspace: ${relativePath}`);
  }
  return fullPath;
}

function isDangerousCommand(command: string) {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  return dangerous.some((pattern) => command.includes(pattern));
}

export async function runCommand(command: string, commandCwd = WORKDIR, timeoutMs = 120_000) {
  if (isDangerousCommand(command)) {
    return "Error: Dangerous command blocked";
  }

  return new Promise<string>((resolvePromise) => {
    const child = spawn(command, {
      cwd: commandCwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let output = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGTERM");
        resolvePromise(`Error: Timeout (${Math.round(timeoutMs / 1000)}s)`);
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });
    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolvePromise(`Error: ${String(error)}`);
      }
    });
    child.on("close", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        const text = output.trim();
        resolvePromise(text ? text.slice(0, 50_000) : "(no output)");
      }
    });
  });
}

export async function readWorkspaceFile(path: string, limit?: number) {
  try {
    const content = await fs.readFile(safePath(path), "utf8");
    const lines = content.split(/\r?\n/);
    if (limit && limit < lines.length) {
      return `${lines.slice(0, limit).join("\n")}\n... (${lines.length - limit} more)`;
    }
    return content.slice(0, 50_000);
  } catch (error) {
    return `Error: ${String(error)}`;
  }
}

export async function writeWorkspaceFile(path: string, content: string) {
  try {
    const fullPath = safePath(path);
    mkdirSync(resolve(fullPath, ".."), { recursive: true });
    await fs.mkdir(resolve(fullPath, ".."), { recursive: true });
    await fs.writeFile(fullPath, content, "utf8");
    return `Wrote ${content.length} bytes to ${path}`;
  } catch (error) {
    return `Error: ${String(error)}`;
  }
}

export async function editWorkspaceFile(path: string, oldText: string, newText: string) {
  try {
    const fullPath = safePath(path);
    const content = await fs.readFile(fullPath, "utf8");
    if (!content.includes(oldText)) {
      return `Error: Text not found in ${path}`;
    }
    await fs.writeFile(fullPath, content.replace(oldText, newText), "utf8");
    return `Edited ${path}`;
  } catch (error) {
    return `Error: ${String(error)}`;
  }
}

export class TodoManager {
  items: Array<{ content: string; status: string; activeForm: string }> = [];

  update(items: Array<{ content?: string; status?: string; activeForm?: string }>) {
    if (items.length > 20) throw new Error("Max 20 todos");
    let inProgress = 0;
    const normalized = items.map((item, index) => {
      const content = String(item.content ?? "").trim();
      const status = String(item.status ?? "pending").toLowerCase();
      const activeForm = String(item.activeForm ?? "").trim();
      if (!content) throw new Error(`Item ${index}: content required`);
      if (!["pending", "in_progress", "completed"].includes(status)) {
        throw new Error(`Item ${index}: invalid status '${status}'`);
      }
      if (!activeForm) throw new Error(`Item ${index}: activeForm required`);
      if (status === "in_progress") inProgress += 1;
      return { content, status, activeForm };
    });
    if (inProgress > 1) throw new Error("Only one in_progress allowed");
    this.items = normalized;
    return this.render();
  }

  render() {
    if (this.items.length === 0) return "No todos.";
    const done = this.items.filter((item) => item.status === "completed").length;
    return [
      ...this.items.map((item) => {
        const marker =
          item.status === "completed"
            ? "[x]"
            : item.status === "in_progress"
              ? "[>]"
              : "[ ]";
        const suffix = item.status === "in_progress" ? ` <- ${item.activeForm}` : "";
        return `${marker} ${item.content}${suffix}`;
      }),
      "",
      `(${done}/${this.items.length} completed)`
    ].join("\n");
  }

  hasOpenItems() {
    return this.items.some((item) => item.status !== "completed");
  }
}

export class SessionTodoManager {
  items: Array<{ id: string; text: string; status: string }> = [];

  update(items: Array<{ id?: string; text?: string; status?: string }>) {
    if (items.length > 20) throw new Error("Max 20 todos allowed");
    const validated: Array<{ id: string; text: string; status: string }> = [];
    let inProgress = 0;
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const text = String(item.text ?? "").trim();
      const status = String(item.status ?? "pending").toLowerCase();
      const id = String(item.id ?? index + 1);
      if (!text) throw new Error(`Item ${id}: text required`);
      if (!["pending", "in_progress", "completed"].includes(status)) {
        throw new Error(`Item ${id}: invalid status '${status}'`);
      }
      if (status === "in_progress") inProgress += 1;
      validated.push({ id, text, status });
    }
    if (inProgress > 1) throw new Error("Only one task can be in_progress at a time");
    this.items = validated;
    return this.render();
  }

  render() {
    if (this.items.length === 0) return "No todos.";
    const done = this.items.filter((item) => item.status === "completed").length;
    return [
      ...this.items.map((item) => {
        const marker =
          item.status === "completed"
            ? "[x]"
            : item.status === "in_progress"
              ? "[>]"
              : "[ ]";
        return `${marker} #${item.id}: ${item.text}`;
      }),
      "",
      `(${done}/${this.items.length} completed)`
    ].join("\n");
  }
}

export class SkillLoader {
  skills = new Map<string, { meta: Record<string, string>; body: string }>();

  constructor(private readonly skillsDir: string) {
    if (!existsSync(skillsDir)) return;
    const visit = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) visit(full);
        if (entry.isFile() && entry.name === "SKILL.md") {
          const text = readFileSync(full, "utf8");
          const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
          const meta: Record<string, string> = {};
          let body = text;
          if (match) {
            for (const line of match[1].split(/\r?\n/)) {
              const idx = line.indexOf(":");
              if (idx >= 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
            }
            body = match[2].trim();
          }
          const name = meta.name ?? basename(resolve(full, ".."));
          this.skills.set(name, { meta, body });
        }
      }
    };
    visit(skillsDir);
  }

  descriptions() {
    if (this.skills.size === 0) return "(no skills)";
    return [...this.skills.entries()]
      .map(([name, skill]) => {
        const tags = skill.meta.tags ? ` [${skill.meta.tags}]` : "";
        return `  - ${name}: ${skill.meta.description ?? "-"}${tags}`;
      })
      .join("\n");
  }

  load(name: string) {
    const skill = this.skills.get(name);
    if (!skill) {
      return `Error: Unknown skill '${name}'. Available: ${[...this.skills.keys()].join(", ")}`;
    }
    return `<skill name="${name}">\n${skill.body}\n</skill>`;
  }
}

export function estimateTokens(messages: Message[]) {
  return Math.floor(JSON.stringify(messages).length / 4);
}

export function microcompact(messages: Message[]) {
  const toolResults: Array<{ content?: unknown; tool_use_id?: string }> = [];
  const toolNameById = new Map<string, string>();
  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block?.type === "tool_use" && block.id && block.name) {
          toolNameById.set(block.id, block.name);
        }
      }
    }
    if (message.role === "user" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (typeof part === "object" && part !== null && (part as any).type === "tool_result") {
          toolResults.push(part as any);
        }
      }
    }
  }
  if (toolResults.length <= KEEP_RECENT_TOOL_RESULTS) return;
  for (const part of toolResults.slice(0, -KEEP_RECENT_TOOL_RESULTS)) {
    if (typeof part.content === "string" && part.content.length > 100) {
      const toolName = toolNameById.get(part.tool_use_id ?? "") ?? "unknown";
      if (PRESERVE_RESULT_TOOLS.has(toolName)) continue;
      part.content = `[Previous: used ${toolName}]`;
    }
  }
}

export async function autoCompact(
  messages: Message[],
  client = createClient(),
  prefix = "Conversation compressed"
) {
  mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  const transcriptPath = join(TRANSCRIPT_DIR, `transcript_${Date.now()}.jsonl`);
  writeFileSync(
    transcriptPath,
    messages.map((message) => JSON.stringify(message)).join("\n"),
    "utf8"
  );
  const convText = JSON.stringify(messages).slice(-80_000);
  const response = await client.messages.create({
    model: MODEL,
    messages: [{
      role: "user",
      content:
        "Summarize this conversation for continuity. Include: 1) What was accomplished, " +
        "2) Current state, 3) Key decisions made. Be concise but preserve critical details.\n\n" +
        convText
    }],
    max_tokens: 2000
  } as any);
  const summary = response.content
    .filter((block: any) => block.type === "text")
    .map((block: any) => block.text)
    .join("\n") || "No summary generated.";
  return [
    {
      role: "user" as const,
      content: `[${prefix}. Transcript: ${transcriptPath}]\n\n${summary}`
    }
  ];
}

export class TaskManager {
  constructor(private readonly tasksDir = TASKS_DIR) {
    mkdirSync(this.tasksDir, { recursive: true });
  }

  private nextId() {
    const ids = readdirSync(this.tasksDir)
      .filter((name) => /^task_\d+\.json$/.test(name))
      .map((name) => Number(name.match(/\d+/)?.[0] ?? "0"));
    return (ids.length === 0 ? 0 : Math.max(...ids)) + 1;
  }

  private path(taskId: number) {
    return join(this.tasksDir, `task_${taskId}.json`);
  }

  private load(taskId: number): TaskRecord {
    const path = this.path(taskId);
    if (!existsSync(path)) {
      throw new Error(`Task ${taskId} not found`);
    }
    return JSON.parse(readFileSync(path, "utf8"));
  }

  private save(task: TaskRecord) {
    writeFileSync(this.path(task.id), `${JSON.stringify(task, null, 2)}\n`, "utf8");
  }

  create(subject: string, description = "") {
    const task: TaskRecord = {
      id: this.nextId(),
      subject,
      description,
      status: "pending",
      owner: null,
      blockedBy: []
    };
    this.save(task);
    return JSON.stringify(task, null, 2);
  }

  get(taskId: number) {
    return JSON.stringify(this.load(taskId), null, 2);
  }

  exists(taskId: number) {
    return existsSync(this.path(taskId));
  }

  update(
    taskId: number,
    status?: TaskRecord["status"],
    addBlockedBy?: number[],
    removeBlockedBy?: number[],
    owner?: string
  ) {
    const task = this.load(taskId);
    if (status) {
      if (!["pending", "in_progress", "completed", "deleted"].includes(status)) {
        throw new Error(`Invalid status: ${status}`);
      }
      task.status = status;
      if (status === "completed") {
        for (const name of readdirSync(this.tasksDir).filter((entry) => /^task_\d+\.json$/.test(entry))) {
          const dependent = JSON.parse(readFileSync(join(this.tasksDir, name), "utf8")) as TaskRecord;
          dependent.blockedBy = (dependent.blockedBy ?? []).filter((id) => id !== taskId);
          this.save(dependent);
        }
      }
      if (status === "deleted") {
        if (existsSync(this.path(taskId))) unlinkSync(this.path(taskId));
        return `Task ${taskId} deleted`;
      }
    }
    if (owner !== undefined) task.owner = owner;
    if (addBlockedBy) task.blockedBy = [...new Set([...(task.blockedBy ?? []), ...addBlockedBy])];
    if (removeBlockedBy) task.blockedBy = (task.blockedBy ?? []).filter((id) => !removeBlockedBy.includes(id));
    task.updated_at = Date.now() / 1000;
    this.save(task);
    return JSON.stringify(task, null, 2);
  }

  claim(taskId: number, owner: string) {
    const task = this.load(taskId);
    if (task.owner) return `Error: Task ${taskId} has already been claimed by ${task.owner}`;
    if (task.status !== "pending") return `Error: Task ${taskId} cannot be claimed because its status is '${task.status}'`;
    if (task.blockedBy && task.blockedBy.length > 0) return `Error: Task ${taskId} is blocked by other task(s) and cannot be claimed yet`;
    task.owner = owner;
    task.status = "in_progress";
    task.updated_at = Date.now() / 1000;
    this.save(task);
    return `Claimed task #${taskId} for ${owner}`;
  }

  bindWorktree(taskId: number, worktree: string, owner = "") {
    const task = this.load(taskId);
    task.worktree = worktree;
    if (owner) task.owner = owner;
    if (task.status === "pending") task.status = "in_progress";
    this.save(task);
    return JSON.stringify(task, null, 2);
  }

  unbindWorktree(taskId: number) {
    const task = this.load(taskId);
    task.worktree = "";
    this.save(task);
    return JSON.stringify(task, null, 2);
  }

  listAll() {
    const files = readdirSync(this.tasksDir).filter((name) => /^task_\d+\.json$/.test(name)).sort();
    if (files.length === 0) return "No tasks.";
    return files
      .map((name) => JSON.parse(readFileSync(join(this.tasksDir, name), "utf8")) as TaskRecord)
      .sort((a, b) => a.id - b.id)
      .map((task) => {
        const marker =
          task.status === "completed"
            ? "[x]"
            : task.status === "in_progress"
              ? "[>]"
              : "[ ]";
        const owner = task.owner ? ` @${task.owner}` : "";
        const blocked = task.blockedBy && task.blockedBy.length > 0 ? ` (blocked by: ${JSON.stringify(task.blockedBy)})` : "";
        const worktree = task.worktree ? ` wt=${task.worktree}` : "";
        return `${marker} #${task.id}: ${task.subject}${owner}${blocked}${worktree}`;
      })
      .join("\n");
  }
}

export class BackgroundManager {
  tasks = new Map<string, BackgroundTask>();
  notifications: Array<{ task_id: string; status: string; result: string }> = [];

  run(command: string, timeout = 300) {
    if (isDangerousCommand(command)) {
      return "Error: Dangerous command blocked";
    }
    const taskId = randomUUID().slice(0, 8);
    this.tasks.set(taskId, { status: "running", command, result: null });
    const child = spawn(command, {
      cwd: WORKDIR,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    let settled = false;
    const finish = (status: string, result: string) => {
      if (settled) return;
      settled = true;
      const text = result || "(no output)";
      this.tasks.set(taskId, { status, command, result: text });
      this.notifications.push({ task_id: taskId, status, result: text.slice(0, 500) });
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish("timeout", `Error: Timeout (${timeout}s)`);
    }, timeout * 1000);
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      finish("error", `Error: ${String(error)}`);
    });
    child.on("close", () => {
      clearTimeout(timer);
      finish("completed", output.trim().slice(0, 50_000));
    });
    return `Background task ${taskId} started: ${command.slice(0, 80)}`;
  }

  check(taskId?: string) {
    if (taskId) {
      const task = this.tasks.get(taskId);
      if (!task) return `Error: Unknown task ${taskId}`;
      return `[${task.status}] ${task.command.slice(0, 60)}\n${task.result ?? "(running)"}`;
    }
    if (this.tasks.size === 0) return "No bg tasks.";
    return [...this.tasks.entries()]
      .map(([id, task]) => `${id}: [${task.status}] ${task.command.slice(0, 60)}`)
      .join("\n");
  }

  drain() {
    const notifications = [...this.notifications];
    this.notifications = [];
    return notifications;
  }
}

export class MessageBus {
  constructor(private readonly inboxDir = INBOX_DIR) {
    mkdirSync(this.inboxDir, { recursive: true });
  }

  send(sender: string, to: string, content: string, msgType = "message", extra?: Record<string, unknown>) {
    if (!VALID_MSG_TYPES.has(msgType)) {
      return `Error: Invalid type '${msgType}'. Valid: ${JSON.stringify([...VALID_MSG_TYPES])}`;
    }
    const payload = JSON.stringify({
      type: msgType,
      from: sender,
      content,
      timestamp: Date.now() / 1000,
      ...(extra ?? {})
    });
    appendFileSync(join(this.inboxDir, `${to}.jsonl`), `${payload}\n`, "utf8");
    return `Sent ${msgType} to ${to}`;
  }

  readInbox(name: string) {
    const path = join(this.inboxDir, `${name}.jsonl`);
    if (!existsSync(path)) return [];
    const messages = readFileSync(path, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    writeFileSync(path, "", "utf8");
    return messages;
  }

  broadcast(sender: string, content: string, names: string[]) {
    let count = 0;
    for (const name of names) {
      if (name === sender) continue;
      this.send(sender, name, content, "broadcast");
      count += 1;
    }
    return `Broadcast to ${count} teammates`;
  }
}

const sleep = (ms: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

export function scanUnclaimedTasks(tasksDir = TASKS_DIR) {
  mkdirSync(tasksDir, { recursive: true });
  return readdirSync(tasksDir)
    .filter((name) => /^task_\d+\.json$/.test(name))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(tasksDir, name), "utf8")) as TaskRecord)
    .filter((task) => task.status === "pending" && !task.owner && (!task.blockedBy || task.blockedBy.length === 0));
}

export function makeIdentityBlock(name: string, role: string, teamName: string): Message {
  return {
    role: "user",
    content: `<identity>You are '${name}', role: ${role}, team: ${teamName}. Continue your work.</identity>`
  };
}

export class ProtocolState {
  shutdownRequests = new Map<string, { target: string; status: string }>();
  planRequests = new Map<string, { from: string; plan: string; status: string }>();

  requestShutdown(bus: MessageBus, teammate: string) {
    const requestId = randomUUID().slice(0, 8);
    this.shutdownRequests.set(requestId, { target: teammate, status: "pending" });
    bus.send("lead", teammate, "Please shut down gracefully.", "shutdown_request", { request_id: requestId });
    return `Shutdown request ${requestId} sent to '${teammate}' (status: pending)`;
  }

  recordShutdownResponse(requestId: string, approve: boolean) {
    const request = this.shutdownRequests.get(requestId);
    if (request) request.status = approve ? "approved" : "rejected";
  }

  checkShutdown(requestId: string) {
    return JSON.stringify(this.shutdownRequests.get(requestId) ?? { error: "not found" });
  }

  submitPlan(bus: MessageBus, sender: string, plan: string) {
    const requestId = randomUUID().slice(0, 8);
    this.planRequests.set(requestId, { from: sender, plan, status: "pending" });
    bus.send(sender, "lead", plan, "plan_approval_response", { request_id: requestId, plan });
    return `Plan submitted (request_id=${requestId}). Waiting for lead approval.`;
  }

  reviewPlan(bus: MessageBus, requestId: string, approve: boolean, feedback = "") {
    const request = this.planRequests.get(requestId);
    if (!request) return `Error: Unknown plan request_id '${requestId}'`;
    request.status = approve ? "approved" : "rejected";
    bus.send("lead", request.from, feedback, "plan_approval_response", {
      request_id: requestId,
      approve,
      feedback
    });
    return `Plan ${request.status} for '${request.from}'`;
  }
}

type TeamMode = "basic" | "protocols" | "autonomous";

export class TeammateManager {
  configPath: string;
  config: { team_name: string; members: Array<{ name: string; role: string; status: string }> };
  running = new Map<string, Promise<void>>();

  constructor(
    private readonly teamDir = TEAM_DIR,
    private readonly bus = new MessageBus(),
    private readonly mode: TeamMode = "basic",
    private readonly protocols = new ProtocolState(),
    private readonly taskManager = new TaskManager()
  ) {
    mkdirSync(teamDir, { recursive: true });
    this.configPath = join(teamDir, "config.json");
    this.config = existsSync(this.configPath)
      ? JSON.parse(readFileSync(this.configPath, "utf8"))
      : { team_name: "default", members: [] };
  }

  private saveConfig() {
    writeFileSync(this.configPath, `${JSON.stringify(this.config, null, 2)}\n`, "utf8");
  }

  private findMember(name: string) {
    return this.config.members.find((member) => member.name === name);
  }

  private setStatus(name: string, status: string) {
    const member = this.findMember(name);
    if (member) {
      member.status = status;
      this.saveConfig();
    }
  }

  spawn(name: string, role: string, prompt: string) {
    let member = this.findMember(name);
    if (member) {
      if (!["idle", "shutdown"].includes(member.status)) return `Error: '${name}' is currently ${member.status}`;
      member.status = "working";
      member.role = role;
    } else {
      member = { name, role, status: "working" };
      this.config.members.push(member);
    }
    this.saveConfig();
    const task = this.loop(name, role, prompt).catch(() => {
      this.setStatus(name, "idle");
    });
    this.running.set(name, task);
    return `Spawned '${name}' (role: ${role})`;
  }

  private teammateTools(): ToolSchema[] {
    const tools: ToolSchema[] = [
      { name: "bash", description: "Run a shell command.", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
      { name: "read_file", description: "Read file contents.", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
      { name: "write_file", description: "Write content to file.", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
      { name: "edit_file", description: "Replace exact text in file.", input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
      { name: "send_message", description: "Send message to a teammate.", input_schema: { type: "object", properties: { to: { type: "string" }, content: { type: "string" }, msg_type: { type: "string", enum: [...VALID_MSG_TYPES] } }, required: ["to", "content"] } },
      { name: "read_inbox", description: "Read and drain your inbox.", input_schema: { type: "object", properties: {} } }
    ];
    if (this.mode === "protocols" || this.mode === "autonomous") {
      tools.push(
        { name: "shutdown_response", description: "Respond to a shutdown request. Approve to shut down, reject to keep working.", input_schema: { type: "object", properties: { request_id: { type: "string" }, approve: { type: "boolean" }, reason: { type: "string" } }, required: ["request_id", "approve"] } },
        { name: "plan_approval", description: "Submit a plan for lead approval. Provide plan text.", input_schema: { type: "object", properties: { plan: { type: "string" } }, required: ["plan"] } }
      );
    }
    if (this.mode === "autonomous") {
      tools.push(
        { name: "idle", description: "Signal that you have no more work. Enters idle polling phase.", input_schema: { type: "object", properties: {} } },
        { name: "claim_task", description: "Claim a task from the task board by ID.", input_schema: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] } }
      );
    }
    return tools;
  }

  private async exec(sender: string, toolName: string, args: Record<string, any>) {
    if (toolName === "bash") return runCommand(args.command);
    if (toolName === "read_file") return readWorkspaceFile(args.path, args.limit);
    if (toolName === "write_file") return writeWorkspaceFile(args.path, args.content);
    if (toolName === "edit_file") return editWorkspaceFile(args.path, args.old_text, args.new_text);
    if (toolName === "send_message") return this.bus.send(sender, args.to, args.content, args.msg_type ?? "message");
    if (toolName === "read_inbox") return JSON.stringify(this.bus.readInbox(sender), null, 2);
    if (toolName === "shutdown_response") {
      this.protocols.recordShutdownResponse(args.request_id, Boolean(args.approve));
      this.bus.send(sender, "lead", args.reason ?? "", "shutdown_response", {
        request_id: args.request_id,
        approve: Boolean(args.approve)
      });
      return `Shutdown ${args.approve ? "approved" : "rejected"}`;
    }
    if (toolName === "plan_approval") return this.protocols.submitPlan(this.bus, sender, args.plan ?? "");
    if (toolName === "claim_task") return this.taskManager.claim(args.task_id, sender);
    return `Unknown tool: ${toolName}`;
  }

  private async loop(name: string, role: string, prompt: string) {
    const client = createClient();
    const teamName = this.config.team_name;
    const messages: Message[] = [{ role: "user", content: prompt }];
    const tools = this.teammateTools();
    const system =
      this.mode === "autonomous"
        ? `You are '${name}', role: ${role}, team: ${teamName}, at ${WORKDIR}. Use idle tool when you have no more work. You will auto-claim new tasks.`
        : this.mode === "protocols"
          ? `You are '${name}', role: ${role}, at ${WORKDIR}. Submit plans via plan_approval before major work. Respond to shutdown_request with shutdown_response.`
          : `You are '${name}', role: ${role}, at ${WORKDIR}. Use send_message to communicate. Complete your task.`;

    while (true) {
      for (let turn = 0; turn < 50; turn += 1) {
        const inbox = this.bus.readInbox(name);
        for (const message of inbox) {
          if (this.mode === "autonomous" && message.type === "shutdown_request") {
            this.setStatus(name, "shutdown");
            return;
          }
          messages.push({ role: "user", content: JSON.stringify(message) });
        }
        const response = await client.messages.create({ model: MODEL, system, messages, tools, max_tokens: 8000 } as any);
        messages.push({ role: "assistant", content: response.content });
        if (response.stop_reason !== "tool_use") break;
        let idleRequested = false;
        let shouldExit = false;
        const results: JsonValue[] = [];
        for (const block of response.content) {
          if (block.type !== "tool_use") continue;
          let output: string;
          if (block.name === "idle") {
            idleRequested = true;
            output = "Entering idle phase. Will poll for new tasks.";
          } else {
            const input = block.input as Record<string, any>;
            output = String(await this.exec(name, block.name, input));
            if (block.name === "shutdown_response" && input.approve) shouldExit = true;
          }
          console.log(`  [${name}] ${block.name}: ${output.slice(0, 120)}`);
          results.push({ type: "tool_result", tool_use_id: block.id, content: output });
        }
        messages.push({ role: "user", content: results });
        if (shouldExit) {
          this.setStatus(name, "shutdown");
          return;
        }
        if (idleRequested) break;
      }

      if (this.mode !== "autonomous") break;
      this.setStatus(name, "idle");
      let resume = false;
      const polls = Math.floor(IDLE_TIMEOUT / Math.max(POLL_INTERVAL, 1));
      for (let i = 0; i < polls; i += 1) {
        await sleep(POLL_INTERVAL * 1000);
        const inbox = this.bus.readInbox(name);
        if (inbox.length > 0) {
          for (const message of inbox) {
            if (message.type === "shutdown_request") {
              this.setStatus(name, "shutdown");
              return;
            }
            messages.push({ role: "user", content: JSON.stringify(message) });
          }
          resume = true;
          break;
        }
        const unclaimed = scanUnclaimedTasks();
        if (unclaimed.length > 0) {
          const task = unclaimed[0];
          const result = this.taskManager.claim(task.id, name);
          if (result.startsWith("Error:")) continue;
          if (messages.length <= 3) {
            messages.unshift({ role: "assistant", content: `I am ${name}. Continuing.` } as Message);
            messages.unshift(makeIdentityBlock(name, role, teamName));
          }
          messages.push({ role: "user", content: `<auto-claimed>Task #${task.id}: ${task.subject}\n${task.description ?? ""}</auto-claimed>` });
          messages.push({ role: "assistant", content: `Claimed task #${task.id}. Working on it.` });
          resume = true;
          break;
        }
      }
      if (!resume) {
        this.setStatus(name, "shutdown");
        return;
      }
      this.setStatus(name, "working");
    }

    const member = this.findMember(name);
    if (member && member.status !== "shutdown") {
      member.status = "idle";
      this.saveConfig();
    }
  }

  listAll() {
    if (this.config.members.length === 0) return "No teammates.";
    return [`Team: ${this.config.team_name}`, ...this.config.members.map((member) => `  ${member.name} (${member.role}): ${member.status}`)].join("\n");
  }

  memberNames() {
    return this.config.members.map((member) => member.name);
  }
}

export class EventBus {
  constructor(private readonly logPath: string) {
    mkdirSync(resolve(logPath, ".."), { recursive: true });
    if (!existsSync(logPath)) writeFileSync(logPath, "", "utf8");
  }

  emit(event: string, task: Record<string, unknown> = {}, worktree: Record<string, unknown> = {}, error?: string) {
    const payload = { event, ts: Date.now() / 1000, task, worktree, ...(error ? { error } : {}) };
    appendFileSync(this.logPath, `${JSON.stringify(payload)}\n`, "utf8");
  }

  listRecent(limit = 20) {
    const lines = readFileSync(this.logPath, "utf8").split(/\r?\n/).filter(Boolean);
    return JSON.stringify(
      lines.slice(-Math.max(1, Math.min(limit, 200))).map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { event: "parse_error", raw: line };
        }
      }),
      null,
      2
    );
  }
}

export function detectRepoRoot(start = WORKDIR) {
  try {
    const output = spawnSyncText("git rev-parse --show-toplevel", start, 10_000);
    const root = output.trim();
    return root && existsSync(root) ? root : null;
  } catch {
    let current = resolve(start);
    while (true) {
      if (existsSync(join(current, ".git"))) return current;
      const parent = resolve(current, "..");
      if (parent === current) return null;
      current = parent;
    }
  }
}

function spawnSyncText(command: string, commandCwd = WORKDIR, timeoutMs = 120_000) {
  const result = spawnSync(command, {
    cwd: commandCwd,
    shell: true,
    encoding: "utf8",
    timeout: timeoutMs
  });
  if (result.status !== 0) throw new Error((result.stdout + result.stderr).trim());
  return (result.stdout + result.stderr).trim();
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export class WorktreeManager {
  dir: string;
  indexPath: string;
  gitAvailable: boolean;

  constructor(
    private readonly repoRoot: string,
    private readonly tasks: TaskManager,
    private readonly events: EventBus
  ) {
    this.dir = join(repoRoot, ".worktrees");
    mkdirSync(this.dir, { recursive: true });
    this.indexPath = join(this.dir, "index.json");
    if (!existsSync(this.indexPath)) {
      writeFileSync(this.indexPath, `${JSON.stringify({ worktrees: [] }, null, 2)}\n`, "utf8");
    }
    this.gitAvailable = this.isGitRepo();
  }

  private isGitRepo() {
    try {
      spawnSyncText("git rev-parse --is-inside-work-tree", this.repoRoot, 10_000);
      return true;
    } catch {
      return false;
    }
  }

  private loadIndex(): { worktrees: WorktreeRecord[] } {
    return JSON.parse(readFileSync(this.indexPath, "utf8"));
  }

  private saveIndex(index: { worktrees: WorktreeRecord[] }) {
    writeFileSync(this.indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  }

  private find(name: string) {
    return this.loadIndex().worktrees.find((entry) => entry.name === name);
  }

  private validateName(name: string) {
    if (!/^[A-Za-z0-9._-]{1,40}$/.test(name)) {
      throw new Error("Invalid worktree name. Use 1-40 chars: letters, numbers, ., _, -");
    }
  }

  async create(name: string, taskId?: number, baseRef = "HEAD") {
    this.validateName(name);
    if (!this.gitAvailable) throw new Error("Not in a git repository. worktree tools require git.");
    if (this.find(name)) throw new Error(`Worktree '${name}' already exists in index`);
    if (taskId != null && !this.tasks.exists(taskId)) throw new Error(`Task ${taskId} not found`);
    const path = join(this.dir, name);
    const branch = `wt/${name}`;
    this.events.emit("worktree.create.before", taskId != null ? { id: taskId } : {}, { name, baseRef });
    const output = await runCommand(
      `git worktree add -b ${shellQuote(branch)} ${shellQuote(path)} ${shellQuote(baseRef)}`,
      this.repoRoot
    );
    if (output.startsWith("Error:")) {
      this.events.emit("worktree.create.failed", taskId != null ? { id: taskId } : {}, { name, baseRef }, output);
      throw new Error(output);
    }
    const record: WorktreeRecord = {
      name,
      path,
      branch,
      task_id: taskId,
      status: "active",
      created_at: Date.now() / 1000
    };
    const index = this.loadIndex();
    index.worktrees.push(record);
    this.saveIndex(index);
    if (taskId != null) this.tasks.bindWorktree(taskId, name);
    this.events.emit("worktree.create.after", taskId != null ? { id: taskId } : {}, record);
    return JSON.stringify(record, null, 2);
  }

  listAll() {
    const worktrees = this.loadIndex().worktrees;
    if (worktrees.length === 0) return "No worktrees in index.";
    return worktrees
      .map((worktree) => {
        const suffix = worktree.task_id != null ? ` task=${worktree.task_id}` : "";
        return `[${worktree.status}] ${worktree.name} -> ${worktree.path} (${worktree.branch})${suffix}`;
      })
      .join("\n");
  }

  async status(name: string) {
    const worktree = this.find(name);
    if (!worktree) return `Error: Unknown worktree '${name}'`;
    if (!existsSync(worktree.path)) return `Error: Worktree path missing: ${worktree.path}`;
    const output = await runCommand("git status --short --branch", worktree.path, 60_000);
    return output === "(no output)" ? "Clean worktree" : output;
  }

  async run(name: string, command: string) {
    const worktree = this.find(name);
    if (!worktree) return `Error: Unknown worktree '${name}'`;
    if (!existsSync(worktree.path)) return `Error: Worktree path missing: ${worktree.path}`;
    return runCommand(command, worktree.path, 300_000);
  }

  async remove(name: string, force = false, completeTask = false) {
    const worktree = this.find(name);
    if (!worktree) return `Error: Unknown worktree '${name}'`;
    this.events.emit(
      "worktree.remove.before",
      worktree.task_id != null ? { id: worktree.task_id } : {},
      { name, path: worktree.path }
    );
    const output = await runCommand(
      `git worktree remove ${force ? "--force " : ""}${shellQuote(worktree.path)}`,
      this.repoRoot
    );
    if (output.startsWith("Error:")) {
      this.events.emit(
        "worktree.remove.failed",
        worktree.task_id != null ? { id: worktree.task_id } : {},
        { name, path: worktree.path },
        output
      );
      throw new Error(output);
    }
    if (completeTask && worktree.task_id != null) {
      this.tasks.update(worktree.task_id, "completed");
      this.tasks.unbindWorktree(worktree.task_id);
      this.events.emit("task.completed", { id: worktree.task_id, status: "completed" }, { name });
    }
    const index = this.loadIndex();
    for (const entry of index.worktrees) {
      if (entry.name === name) {
        entry.status = "removed";
        entry.removed_at = Date.now() / 1000;
      }
    }
    this.saveIndex(index);
    this.events.emit(
      "worktree.remove.after",
      worktree.task_id != null ? { id: worktree.task_id } : {},
      { name, path: worktree.path, status: "removed" }
    );
    return `Removed worktree '${name}'`;
  }

  keep(name: string) {
    const index = this.loadIndex();
    const worktree = index.worktrees.find((entry) => entry.name === name);
    if (!worktree) return `Error: Unknown worktree '${name}'`;
    worktree.status = "kept";
    worktree.kept_at = Date.now() / 1000;
    this.saveIndex(index);
    this.events.emit(
      "worktree.keep",
      worktree.task_id != null ? { id: worktree.task_id } : {},
      { name, path: worktree.path, status: "kept" }
    );
    return JSON.stringify(worktree, null, 2);
  }
}

export function extractText(responseContent: any[]) {
  return responseContent
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export async function runSubagent(prompt: string, agentType = "Explore") {
  const client = createClient();
  const tools: ToolSchema[] = [
    {
      name: "bash",
      description: "Run command.",
      input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] }
    },
    {
      name: "read_file",
      description: "Read file.",
      input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
    }
  ];
  if (agentType !== "Explore") {
    tools.push(
      {
        name: "write_file",
        description: "Write file.",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
          required: ["path", "content"]
        }
      },
      {
        name: "edit_file",
        description: "Edit file.",
        input_schema: {
          type: "object",
          properties: {
            path: { type: "string" },
            old_text: { type: "string" },
            new_text: { type: "string" }
          },
          required: ["path", "old_text", "new_text"]
        }
      }
    );
  }

  const handlers: Record<string, ToolHandler> = {
    bash: ({ command }) => runCommand(command),
    read_file: ({ path }) => readWorkspaceFile(path),
    write_file: ({ path, content }) => writeWorkspaceFile(path, content),
    edit_file: ({ path, old_text, new_text }) => editWorkspaceFile(path, old_text, new_text)
  };

  const messages: Message[] = [{ role: "user", content: prompt }];
  let response: any = null;
  for (let i = 0; i < 30; i += 1) {
    response = await client.messages.create({
      model: MODEL,
      messages,
      tools,
      max_tokens: 8000
    } as any);
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") break;
    const results: Array<{ type: string; tool_use_id: string; content: string }> = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const handler = handlers[block.name];
      const content = handler ? await handler(block.input) : "Unknown tool";
      results.push({ type: "tool_result", tool_use_id: block.id, content: String(content).slice(0, 50_000) });
    }
    messages.push({ role: "user", content: results });
  }
  return response ? extractText(response.content) || "(no summary)" : "(subagent failed)";
}

export async function runAgentLoop(options: {
  system: string;
  tools: ToolSchema[];
  handlers: Record<string, ToolHandler>;
  messages: Message[];
  todoManager?: TodoManager;
  backgroundManager?: BackgroundManager;
  messageBus?: MessageBus;
  compressClient?: Anthropic;
  compact?: boolean;
  compactPrefix?: string;
  tokenThreshold?: number;
  nagTodo?: false | "always" | "open";
}) {
  const client = options.compressClient ?? createClient();
  let roundsWithoutTodo = 0;
  while (true) {
    if (options.compact) {
      microcompact(options.messages);
      if (estimateTokens(options.messages) > (options.tokenThreshold ?? TOKEN_THRESHOLD)) {
        const compacted = await autoCompact(options.messages, client, options.compactPrefix ?? "Conversation compressed");
        options.messages.splice(0, options.messages.length, ...compacted);
      }
    }
    if (options.backgroundManager) {
      const notifications = options.backgroundManager.drain();
      if (notifications.length > 0) {
        const text = notifications
          .map((item) => `[bg:${item.task_id}] ${item.status}: ${item.result}`)
          .join("\n");
        options.messages.push({
          role: "user",
          content: `<background-results>\n${text}\n</background-results>`
        });
      }
    }
    if (options.messageBus) {
      const inbox = options.messageBus.readInbox("lead");
      if (inbox.length > 0) {
        options.messages.push({ role: "user", content: `<inbox>${JSON.stringify(inbox, null, 2)}</inbox>` });
      }
    }
    const response = await client.messages.create({
      model: MODEL,
      system: options.system,
      messages: options.messages,
      tools: options.tools,
      max_tokens: 8000
    } as any);
    options.messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") return response;
    const results: JsonValue[] = [];
    let usedTodo = false;
    let manualCompress = false;
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      if (block.name === "compress" || block.name === "compact") manualCompress = true;
      const handler = options.handlers[block.name];
      let content: string;
      try {
        content = handler ? await handler(block.input as Record<string, any>) : `Unknown tool: ${block.name}`;
      } catch (error) {
        content = `Error: ${String(error)}`;
      }
      results.push({ type: "tool_result", tool_use_id: block.id, content });
      if (block.name === "TodoWrite" || block.name === "todo") {
        usedTodo = true;
      }
    }
    roundsWithoutTodo = usedTodo ? 0 : roundsWithoutTodo + 1;
    const shouldNag =
      options.nagTodo === "always" ||
      (options.nagTodo === "open" && options.todoManager?.hasOpenItems());
    if (shouldNag && roundsWithoutTodo >= 3) {
      results.push({ type: "text", text: "<reminder>Update your todos.</reminder>" });
    }
    options.messages.push({ role: "user", content: results });
    if (manualCompress && options.compact) {
      const compacted = await autoCompact(options.messages, client, options.compactPrefix ?? "Conversation compressed");
      options.messages.splice(0, options.messages.length, ...compacted);
      return response;
    }
  }
}
