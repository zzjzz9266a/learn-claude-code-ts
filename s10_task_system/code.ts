/**
 * s10_task_system.ts - Task System
 *
 *     .tasks/
 *       task_a1b2c3d4.json  {status: completed, blockedBy: []}
 *       task_e5f6a7b8.json  {status: pending, blockedBy: [task_a1b2c3d4]}
 *       task_11223344.json  {status: pending, blockedBy: [task_e5f6a7b8]}
 *
 *     Dependency graph:
 *
 *     +-----------+      +-----------+      +-----------+
 *     | schema    | ---> | API       | ---> | tests     |
 *     | completed |      | pending   |      | pending   |
 *     +-----------+      +-----------+      +-----------+
 *
 *     can_start(API) is true because schema is completed.
 *
 *     Task lifecycle:
 *
 *     pending --claim_task--> in_progress --complete_task--> completed
 */

import Anthropic from "@anthropic-ai/sdk";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { config as loadDotenv } from "dotenv";
import * as fs from "node:fs";
import * as node_path from "node:path";
import { createInterface, type Interface as ReadlineInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { pathToFileURL } from "node:url";

loadDotenv({ override: true, quiet: true });
if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

export const WORKDIR = process.cwd();
export const client = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL });
if (process.env.MODEL_ID === undefined) throw new Error("MODEL_ID is required");
export const MODEL = process.env.MODEL_ID;

export const ENVIRONMENT_PROMPT =
  process.platform === "win32"
    ? "Windows: the bash tool runs through cmd.exe; use cmd.exe syntax, not Unix Bash or PowerShell syntax, and prefer dedicated file tools for file operations"
    : "Unix-like: the bash tool runs the system shell";
export const SYSTEM =
  `You are a coding agent at ${WORKDIR}. Environment: ${ENVIRONMENT_PROMPT}. ` +
  "Use task tools to track dependencies and progress. Create all task nodes " +
  "first. After create_task returns runtime-generated IDs, use update_task " +
  "with those exact IDs to add dependencies.";

// -- New in s10: persistent task records --

export const TASKS_DIR = node_path.join(WORKDIR, ".tasks");
export const TASK_ID_PATTERN = /^task_[0-9a-f]{8}$/;

export class ValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValueError";
  }
}

export class Task {
  id: string;
  subject: string;
  description: string;
  status: string;
  owner: string | null;
  blockedBy: string[];

  constructor(
    id: string,
    subject: string,
    description: string,
    status: string,
    owner: string | null,
    blockedBy: string[],
  ) {
    this.id = id;
    this.subject = subject;
    this.description = description;
    this.status = status;
    this.owner = owner;
    this.blockedBy = blockedBy;
  }
}

const TASK_FIELDS = ["id", "subject", "description", "status", "owner", "blockedBy"];

export function asdict(task: Task): Record<string, any> {
  return {
    id: task.id,
    subject: task.subject,
    description: task.description,
    status: task.status,
    owner: task.owner,
    blockedBy: [...task.blockedBy],
  };
}

function py_json(value: any): string {
  return JSON.stringify(value, null, 2).replace(/[^\x00-\x7f]/g, (char) => (
    `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`
  ));
}

function py_repr(value: any): string {
  if (typeof value === "string") {
    return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}'`;
  }
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "True" : "False";
  if (value === null || value === undefined) return "None";
  if (Array.isArray(value)) return `[${value.map(py_repr).join(", ")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value).map(([key, item]) => `${py_repr(key)}: ${py_repr(item)}`).join(", ")}}`;
  }
  return String(value);
}

function char_length(text: string): number {
  return Array.from(text).length;
}

function char_slice(text: string, limit: number): string {
  if (limit <= 0) return "";
  if (text.length <= limit) return text;
  return Array.from(text).slice(0, limit).join("");
}

function resolve_path(target: string): string {
  const absolute = node_path.resolve(target);
  const root = node_path.parse(absolute).root;
  const rest = absolute.slice(root.length).split(node_path.sep).filter(Boolean);
  let current = root;
  let index = 0;
  for (; index < rest.length; index++) {
    const next = node_path.join(current, rest[index]);
    try {
      current = fs.realpathSync(next);
    } catch {
      break;
    }
  }
  return node_path.join(current, ...rest.slice(index));
}

function is_relative_to(child: string, parent: string): boolean {
  const relative = node_path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !node_path.isAbsolute(relative));
}

function read_text(file_path: string): string {
  const buffer = fs.readFileSync(file_path);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (error: any) {
    throw new ValueError(error instanceof Error ? error.message : String(error));
  }
}

function path_stem(file_path: string): string {
  const base = node_path.basename(file_path);
  const extension = node_path.extname(base);
  return extension ? base.slice(0, -extension.length) : base;
}

function task_from_dict(data: any): Task {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new TypeError("Task.__init__() argument must be a mapping");
  }
  for (const key of Object.keys(data)) {
    if (!TASK_FIELDS.includes(key)) {
      throw new TypeError(`Task.__init__() got an unexpected keyword argument '${key}'`);
    }
  }
  for (const key of TASK_FIELDS) {
    if (!(key in data)) {
      throw new TypeError(`Task.__init__() missing 1 required positional argument: '${key}'`);
    }
  }
  return new Task(data.id, data.subject, data.description, data.status, data.owner, data.blockedBy);
}

export class TaskStore {
  directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  _root(create = false): string {
    if (create) fs.mkdirSync(this.directory, { recursive: true });
    const root = resolve_path(this.directory);
    if (!is_relative_to(root, resolve_path(WORKDIR))) {
      throw new ValueError("Task store escapes the workspace");
    }
    return root;
  }

  _path(task_id: string, create_root = false): string {
    if (typeof task_id !== "string" || !TASK_ID_PATTERN.test(task_id)) {
      throw new ValueError(`Invalid task ID: ${py_repr(task_id)}`);
    }
    const root = this._root(create_root);
    const file_path = resolve_path(node_path.resolve(root, `${task_id}.json`));
    if (!is_relative_to(file_path, root)) {
      throw new ValueError(`Invalid task ID: ${py_repr(task_id)}`);
    }
    return file_path;
  }

  exists(task_id: string): boolean {
    try {
      return fs.statSync(this._path(task_id)).isFile();
    } catch (error: any) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }

  create(subject: string, description = ""): Task {
    subject = subject.trim();
    if (!subject) throw new ValueError("Task subject cannot be empty");

    this._root(true);
    for (let attempt = 0; attempt < 100; attempt++) {
      const task = new Task(
        `task_${randomBytes(4).toString("hex")}`,
        subject,
        description,
        "pending",
        null,
        [],
      );
      const file_path = this._path(task.id, true);
      let fd: number;
      try {
        fd = fs.openSync(file_path, "wx");
      } catch (error: any) {
        if (error?.code === "EEXIST") continue;
        throw error;
      }
      try {
        fs.writeFileSync(fd, py_json(asdict(task)), "utf-8");
      } finally {
        fs.closeSync(fd);
      }
      return task;
    }
    throw new Error("Could not allocate a unique task ID");
  }

  _depends_on(task_id: string, target_id: string): boolean {
    // Return whether task_id transitively depends on target_id.
    const pending = [task_id];
    const visited = new Set<string>();
    while (pending.length) {
      const current = pending.pop() as string;
      if (current === target_id) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      pending.push(...this.load(current).blockedBy);
    }
    return false;
  }

  update_dependencies(task_id: string, add_blocked_by: string[]): Task {
    if (!Array.isArray(add_blocked_by)) {
      throw new ValueError("addBlockedBy must be a list of task IDs");
    }

    const task = this.load(task_id);
    if (task.status !== "pending" || task.owner !== null) {
      throw new ValueError(
        `Task ${task_id} dependencies can only be updated while pending and unowned`,
      );
    }

    const dependencies = [...new Set(add_blocked_by)];
    for (const dependency of dependencies) {
      if (dependency === task_id) throw new ValueError("Task cannot depend on itself");
      if (!this.exists(dependency)) throw new ValueError(`Dependency not found: ${dependency}`);
      if (!task.blockedBy.includes(dependency) && this._depends_on(dependency, task_id)) {
        throw new ValueError(`Dependency cycle detected: ${task_id} -> ${dependency}`);
      }
    }

    for (const dependency of dependencies) {
      if (!task.blockedBy.includes(dependency)) task.blockedBy.push(dependency);
    }
    this.save(task);
    return task;
  }

  save(task: Task): void {
    fs.writeFileSync(this._path(task.id, true), py_json(asdict(task)), "utf-8");
  }

  load(task_id: string): Task {
    let data: any;
    try {
      data = JSON.parse(read_text(this._path(task_id)));
    } catch (error) {
      if (error instanceof ValueError) throw error;
      if (error instanceof SyntaxError) throw new ValueError(error.message);
      throw error;
    }
    const task = task_from_dict(data);
    if (task.id !== task_id) throw new ValueError(`Task file ID does not match ${task_id}`);
    if (!["pending", "in_progress", "completed"].includes(task.status)) {
      throw new ValueError(`Invalid task status: ${task.status}`);
    }
    return task;
  }

  list(): Task[] {
    if (!fs.existsSync(this.directory)) return [];
    const root = this._root();
    return fs.globSync("task_*.json", { cwd: root }).sort().map((filename) => this.load(path_stem(filename)));
  }
}

export const TASKS = new TaskStore(TASKS_DIR);

export function create_task(subject: string, description = ""): Task {
  return TASKS.create(subject, description);
}

export function update_task(task_id: string, addBlockedBy: string[]): Task {
  return TASKS.update_dependencies(task_id, addBlockedBy);
}

export function load_task(task_id: string): Task {
  return TASKS.load(task_id);
}

export function list_tasks(): Task[] {
  return TASKS.list();
}

export function get_task(task_id: string): string {
  return py_json(asdict(load_task(task_id)));
}

export function incomplete_dependencies(task: Task): string[] {
  const incomplete: string[] = [];
  for (const dependency of task.blockedBy) {
    try {
      if (load_task(dependency).status !== "completed") incomplete.push(dependency);
    } catch (error: any) {
      if (error instanceof ValueError || error?.code === "ENOENT") incomplete.push(dependency);
      else throw error;
    }
  }
  return incomplete;
}

export function can_start(task_id: string): boolean {
  return !incomplete_dependencies(load_task(task_id)).length;
}

export function claim_task(task_id: string, owner = "agent"): string {
  const task = load_task(task_id);
  if (task.status !== "pending") return `Task ${task_id} is ${task.status}, cannot claim`;
  const dependencies = incomplete_dependencies(task);
  if (dependencies.length) return `Blocked by: ${py_repr(dependencies)}`;
  task.owner = owner;
  task.status = "in_progress";
  TASKS.save(task);
  console.log(`  [claim] ${task.subject} -> in_progress (owner: ${owner})`);
  return `Claimed ${task.id} (${task.subject})`;
}

export function complete_task(task_id: string, owner = "agent"): string {
  const task = load_task(task_id);
  if (task.status !== "in_progress") return `Task ${task_id} is ${task.status}, cannot complete`;
  if (task.owner !== owner) return `Task ${task_id} is owned by ${task.owner}, not ${owner}`;
  const ready_before = new Set(
    list_tasks()
      .filter((candidate) => candidate.status === "pending" && candidate.blockedBy.length && can_start(candidate.id))
      .map((candidate) => candidate.id),
  );
  task.status = "completed";
  TASKS.save(task);
  const unblocked = list_tasks()
    .filter((candidate) => (
      candidate.status === "pending"
      && candidate.blockedBy.length
      && !ready_before.has(candidate.id)
      && can_start(candidate.id)
    ))
    .map((candidate) => candidate.subject);
  console.log(`  [complete] ${task.subject}`);
  let message = `Completed ${task.id} (${task.subject})`;
  if (unblocked.length) {
    message += `\nUnblocked: ${unblocked.join(", ")}`;
    console.log(`  [unblocked] ${unblocked.join(", ")}`);
  }
  return message;
}

// -- From s04: tool implementations --

export function run_bash(command: string): string {
  const result = spawnSync(command, {
    shell: true,
    encoding: "utf8",
    timeout: 120_000,
    cwd: WORKDIR,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") return "Error: Timeout (120s)";
    throw result.error;
  }
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return output ? char_slice(output, 50000) : "(no output)";
}

function splitlines(text: string): string[] {
  const lines = text.split(/\r\n|[\n\r\v\f\u0085\u2028\u2029]/);
  if (text.length > 0 && /[\n\r\v\f\u0085\u2028\u2029]$/.test(text)) lines.pop();
  return lines;
}

export function run_read(path: string, limit: number | null = null): string {
  try {
    const lines = splitlines(read_text(resolve_path(node_path.resolve(WORKDIR, path))));
    if (limit && limit < lines.length) {
      return [...lines.slice(0, limit), `... (${lines.length - limit} more lines)`].join("\n");
    }
    return lines.join("\n");
  } catch (error: any) {
    return `Error: ${error instanceof Error ? error.message : error}`;
  }
}

export function run_write(path: string, content: string): string {
  try {
    const file_path = resolve_path(node_path.resolve(WORKDIR, path));
    fs.mkdirSync(node_path.dirname(file_path), { recursive: true });
    fs.writeFileSync(file_path, content, "utf-8");
    return `Wrote ${char_length(content)} bytes to ${path}`;
  } catch (error: any) {
    return `Error: ${error instanceof Error ? error.message : error}`;
  }
}

export function run_edit(path: string, old_text: string, new_text: string): string {
  try {
    const file_path = resolve_path(node_path.resolve(WORKDIR, path));
    const text = read_text(file_path);
    if (!text.includes(old_text)) return `Error: text not found in ${path}`;
    const index = text.indexOf(old_text);
    fs.writeFileSync(file_path, text.slice(0, index) + new_text + text.slice(index + old_text.length), "utf-8");
    return `Edited ${path}`;
  } catch (error: any) {
    return `Error: ${error instanceof Error ? error.message : error}`;
  }
}

export function run_glob(pattern: string): string {
  try {
    const matches = [...new Set(
      fs.globSync(pattern, { cwd: WORKDIR }).filter((match) => (
        is_relative_to(resolve_path(node_path.resolve(WORKDIR, match)), WORKDIR)
      )),
    )].sort();
    const shown = matches.slice(0, 200);
    if (matches.length > 200) shown.push("... (more matches omitted; narrow the pattern)");
    return shown.length ? shown.join("\n") : "(no matches)";
  } catch (error: any) {
    return `Error: ${error instanceof Error ? error.message : error}`;
  }
}

export function run_create_task(subject: string, description = ""): string {
  const task = create_task(subject, description);
  console.log(`  [create] ${task.subject}`);
  return `Created ${task.id}: ${task.subject}`;
}

export function run_update_task(task_id: string, addBlockedBy: string[]): string {
  const task = update_task(task_id, addBlockedBy);
  const dependencies = task.blockedBy.join(", ") || "(none)";
  console.log(`  [update] ${task.subject} blockedBy: ${dependencies}`);
  return `Updated ${task.id} blockedBy: ${dependencies}`;
}

export function run_list_tasks(): string {
  const tasks = list_tasks();
  if (!tasks.length) return "No tasks. Use create_task to add some.";
  const lines: string[] = [];
  for (const task of tasks) {
    const marker = ({ pending: "[ ]", in_progress: "[>]", completed: "[x]" } as Record<string, string>)[task.status] ?? "[?]";
    const dependencies = task.blockedBy.length ? ` (blockedBy: ${task.blockedBy.join(", ")})` : "";
    const owner = task.owner ? ` [${task.owner}]` : "";
    lines.push(`${marker} ${task.id}: ${task.subject} [${task.status}]${owner}${dependencies}`);
  }
  return lines.join("\n");
}

export function run_get_task(task_id: string): string {
  return get_task(task_id);
}

export function run_claim_task(task_id: string): string {
  return claim_task(task_id, "agent");
}

export function run_complete_task(task_id: string): string {
  return complete_task(task_id, "agent");
}

export const TOOLS = [
  { "name": "bash", "description": "Run a shell command.",
    "input_schema": { "type": "object", "properties": { "command": { "type": "string" } }, "required": ["command"] } },
  { "name": "read_file", "description": "Read file contents.",
    "input_schema": { "type": "object", "properties": { "path": { "type": "string" }, "limit": { "type": "integer" } }, "required": ["path"] } },
  { "name": "write_file", "description": "Write content to a file.",
    "input_schema": { "type": "object", "properties": { "path": { "type": "string" }, "content": { "type": "string" } }, "required": ["path", "content"] } },
  { "name": "edit_file", "description": "Replace exact text in a file once.",
    "input_schema": { "type": "object", "properties": { "path": { "type": "string" }, "old_text": { "type": "string" }, "new_text": { "type": "string" } }, "required": ["path", "old_text", "new_text"] } },
  { "name": "glob", "description": "Find files matching a glob pattern; ** matches recursively.",
    "input_schema": { "type": "object", "properties": { "pattern": { "type": "string" } }, "required": ["pattern"] } },
  { "name": "create_task", "description": "Create a task and return its runtime-generated ID.",
    "input_schema": { "type": "object", "properties": { "subject": { "type": "string" }, "description": { "type": "string" } }, "required": ["subject"], "additionalProperties": false } },
  { "name": "update_task", "description": "Add dependencies using IDs returned by create_task.",
    "input_schema": { "type": "object", "properties": { "task_id": { "type": "string", "pattern": "^task_[0-9a-f]{8}$" }, "addBlockedBy": { "type": "array", "items": { "type": "string", "pattern": "^task_[0-9a-f]{8}$" }, "minItems": 1 } }, "required": ["task_id", "addBlockedBy"], "additionalProperties": false } },
  { "name": "list_tasks", "description": "List tasks with status, owner, and dependencies.",
    "input_schema": { "type": "object", "properties": {} } },
  { "name": "get_task", "description": "Get a task by ID.",
    "input_schema": { "type": "object", "properties": { "task_id": { "type": "string" } }, "required": ["task_id"] } },
  { "name": "claim_task", "description": "Claim a pending task whose dependencies are complete.",
    "input_schema": { "type": "object", "properties": { "task_id": { "type": "string" } }, "required": ["task_id"] } },
  { "name": "complete_task", "description": "Complete the task claimed by this agent.",
    "input_schema": { "type": "object", "properties": { "task_id": { "type": "string" } }, "required": ["task_id"] } },
];

function bind_tool(fn: Function, required: string[], optional: string[] = []): (input: any) => any {
  const allowed = new Set([...required, ...optional]);
  return (input: any) => {
    const data = input ?? {};
    for (const key of required) {
      if (!(key in data)) throw new TypeError(`${fn.name}() missing 1 required positional argument: '${key}'`);
    }
    for (const key of Object.keys(data)) {
      if (!allowed.has(key)) throw new TypeError(`${fn.name}() got an unexpected keyword argument '${key}'`);
    }
    const args = [...required, ...optional].map((key) => data[key]);
    while (args.length > required.length && args[args.length - 1] === undefined) args.pop();
    return fn(...args);
  };
}

export const TOOL_HANDLERS: Record<string, (input: any) => any> = {
  bash: bind_tool(run_bash, ["command"]),
  read_file: bind_tool(run_read, ["path"], ["limit"]),
  write_file: bind_tool(run_write, ["path", "content"]),
  edit_file: bind_tool(run_edit, ["path", "old_text", "new_text"]),
  glob: bind_tool(run_glob, ["pattern"]),
  create_task: bind_tool(run_create_task, ["subject"], ["description"]),
  update_task: bind_tool(run_update_task, ["task_id", "addBlockedBy"]),
  list_tasks: bind_tool(run_list_tasks, []),
  get_task: bind_tool(run_get_task, ["task_id"]),
  claim_task: bind_tool(run_claim_task, ["task_id"]),
  complete_task: bind_tool(run_complete_task, ["task_id"]),
};

// -- From s04: hooks and permission checks --

export const HOOKS: Record<string, Array<(...args: any[]) => any>> = {
  UserPromptSubmit: [],
  PreToolUse: [],
  PostToolUse: [],
  Stop: [],
};

export function register_hook(event: string, callback: (...args: any[]) => any): void {
  HOOKS[event].push(callback);
}

export async function trigger_hooks(event: string, ...args: any[]): Promise<any> {
  for (const callback of HOOKS[event]) {
    const result = await callback(...args);
    if (result !== null && result !== undefined) return result;
  }
  return null;
}

export const DENY_LIST = ["rm -rf /", "sudo", "shutdown", "reboot", "mkfs", "dd if="];
export const DESTRUCTIVE_COMMAND_WORD = /(?:^|[;&|()\n])\s*(?:rm|del)(?=\s|$|[;&|()])/i;
export const DESTRUCTIVE = ["rm ", "> /etc/", "chmod 777"];

export function contains_destructive_command(command: string): boolean {
  return DESTRUCTIVE_COMMAND_WORD.test(command);
}

let line_reader: ReadlineInterface | null = null;

function input_line(prompt: string): Promise<string> {
  if (!line_reader) line_reader = createInterface({ input: stdin, output: stdout });
  return line_reader.question(prompt);
}

export async function permission_hook(block: any): Promise<string | null> {
  if (block.name === "bash") {
    const command = block.input?.command ?? "";
    for (const pattern of DENY_LIST) {
      if (command.includes(pattern)) {
        console.log(`\n\x1b[31m[blocked] '${pattern}'\x1b[0m`);
        return "Permission denied by deny list";
      }
    }
    if (contains_destructive_command(command) || DESTRUCTIVE.some((keyword) => command.includes(keyword))) {
      console.log("\n\x1b[33m[permission] Potentially destructive command\x1b[0m");
      console.log(`   Tool: ${block.name}(${py_repr(block.input)})`);
      const choice = (await input_line("   Allow? [y/N] ")).trim().toLowerCase();
      if (choice !== "y" && choice !== "yes") return "Permission denied by user";
    }
  }

  if (block.name === "read_file" || block.name === "write_file" || block.name === "edit_file") {
    const file = block.input?.path ?? "";
    if (!is_relative_to(resolve_path(node_path.resolve(WORKDIR, file)), WORKDIR)) {
      console.log("\n\x1b[33m[permission] Access outside workspace\x1b[0m");
      console.log(`   Tool: ${block.name}(${py_repr(block.input)})`);
      const choice = (await input_line("   Allow? [y/N] ")).trim().toLowerCase();
      if (choice !== "y" && choice !== "yes") return "Permission denied by user";
    }
  }
  return null;
}

export function log_hook(block: any): null {
  const preview = char_slice(py_repr(Object.values(block.input ?? {}).slice(0, 2)), 60);
  console.log(`\x1b[90m[HOOK] ${block.name}(${preview})\x1b[0m`);
  return null;
}

export function large_output_hook(block: any, output: any): null {
  if (String(output).length > 100000) {
    console.log(`\x1b[33m[HOOK] Large output from ${block.name}: ${String(output).length} chars\x1b[0m`);
  }
  return null;
}

export function context_hook(query: string): null {
  console.log(`\x1b[90m[HOOK] UserPromptSubmit: working in ${WORKDIR}\x1b[0m`);
  return null;
}

export function summary_hook(messages: any[]): null {
  let tool_count = 0;
  for (const message of messages) {
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const block of content) {
      if (block !== null && typeof block === "object" && block.type === "tool_result") tool_count += 1;
    }
  }
  console.log(`\x1b[90m[HOOK] Stop: session used ${tool_count} tool calls\x1b[0m`);
  return null;
}

register_hook("UserPromptSubmit", context_hook);
register_hook("PreToolUse", permission_hook);
register_hook("PreToolUse", log_hook);
register_hook("PostToolUse", large_output_hook);
register_hook("Stop", summary_hook);

export async function execute_tool(block: any): Promise<string> {
  const blocked = await trigger_hooks("PreToolUse", block);
  if (blocked) return String(blocked);

  const handler = TOOL_HANDLERS[block.name];
  let output: any;
  try {
    output = handler ? await handler(block.input) : `Unknown: ${block.name}`;
  } catch (error: any) {
    output = `Error: ${error instanceof Error ? error.message : error}`;
  }

  await trigger_hooks("PostToolUse", block, output);
  return String(output);
}

// -- Agent loop --

export async function agent_loop(messages: any[]): Promise<void> {
  while (true) {
    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages,
      tools: TOOLS as any,
      max_tokens: 8000,
    });
    messages.push({ role: "assistant", content: response.content });

    const tool_calls = (response.content as any[]).filter((block) => block.type === "tool_use");
    if (!tool_calls.length) {
      const force = await trigger_hooks("Stop", messages);
      if (force) {
        messages.push({ role: "user", content: force });
        continue;
      }
      return;
    }

    const results: any[] = [];
    for (const block of tool_calls) {
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: await execute_tool(block),
      });
    }
    messages.push({ role: "user", content: results });
  }
}

async function main(): Promise<void> {
  console.log("s10: Task System - dependencies and task state");
  console.log("Enter a question, press Enter to send. Type q to quit.\n");

  const history: any[] = [];
  const reader = line_reader ?? (line_reader = createInterface({ input: stdin, output: stdout }));
  while (true) {
    let query: string;
    try {
      query = await reader.question("\x1b[36ms10 >> \x1b[0m");
    } catch {
      break;
    }
    if (["q", "exit", ""].includes(query.trim().toLowerCase())) break;
    await trigger_hooks("UserPromptSubmit", query);
    history.push({ role: "user", content: query });
    await agent_loop(history);
    for (const block of history[history.length - 1].content) {
      if (block?.type === "text") console.log(block.text);
    }
    console.log();
  }
  reader.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
