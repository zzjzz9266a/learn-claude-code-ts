/**
 * s11_background_tasks.ts - Background Tasks
 *
 *     Main thread                              Background thread
 *     +------------------------------+         +----------------------+
 *     | bash(run_in_background=True) | ------> | run command          |
 *     | return bg_id                 |         | queue result         |
 *     | continue agent loop          | <------ +----------------------+
 *     | next turn: collect           |
 *     +------------------------------+
 */

import Anthropic from "@anthropic-ai/sdk";
import { spawn, type ChildProcess } from "node:child_process";
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
  "Use tools to solve tasks. " +
  "Set run_in_background to true only for independent Bash commands.";

// -- From s04: tool implementations --

const _shell_processes = new Set<ChildProcess>();

class SyncLock {
  private depth = 0;
  acquire(): void {
    this.depth += 1;
  }
  release(): void {
    this.depth -= 1;
  }
}

const _shell_process_lock = new SyncLock();

function sleep_ms(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function _stop_process_group(child: ChildProcess): void {
  // Stop a shell process and its children (cross-platform).
  // POSIX uses process-group signals (SIGTERM then SIGKILL). Windows has
  // neither process-group kill nor SIGKILL, so it falls back to
  // terminate / kill.
  if (!child.pid) return;
  if (process.platform === "win32") {
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        child.kill(signal);
      } catch {
        return;
      }
      sleep_ms(50);
    }
    return;
  }

  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    try {
      process.kill(-child.pid, signal);
    } catch {
      return;
    }
    sleep_ms(50);
  }
}

export function _stop_all_shell_processes(): void {
  _shell_process_lock.acquire();
  const processes = [..._shell_processes];
  _shell_process_lock.release();
  for (const child of processes) _stop_process_group(child);
}

function _handle_termination_signal(signum: number): void {
  _stop_all_shell_processes();
  process.exit(128 + signum);
}

process.on("exit", () => {
  _stop_all_shell_processes();
});
process.on("SIGTERM", () => _handle_termination_signal(15));
process.on("SIGINT", () => _handle_termination_signal(2));

function char_slice(text: string, limit: number): string {
  if (limit <= 0) return "";
  if (text.length <= limit) return text;
  return Array.from(text).slice(0, limit).join("");
}

function char_length(text: string): number {
  return Array.from(text).length;
}

export function _run_bash_process(command: string): Promise<[string, number | null]> {
  return new Promise((resolve) => {
    let child: ChildProcess | null = null;
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (output: string, code: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (child !== null) {
        _stop_process_group(child);
        if (child.exitCode === null && child.signalCode === null) sleep_ms(200);
        _shell_process_lock.acquire();
        _shell_processes.delete(child);
        _shell_process_lock.release();
      }
      resolve([output, code]);
    };

    try {
      child = spawn(command, {
        shell: true,
        cwd: WORKDIR,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      _shell_process_lock.acquire();
      _shell_processes.add(child);
      _shell_process_lock.release();
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk;
      });
      timer = setTimeout(() => finish("Error: Timeout (120s)", null), 120_000);
      child.on("error", (error) => {
        finish(`Error: ${error.name}: ${error.message}`, null);
      });
      child.on("close", (code) => {
        const output = (stdout + stderr).trim();
        finish(output ? char_slice(output, 50000) : "(no output)", code);
      });
    } catch (error: any) {
      finish(`Error: ${error?.name ?? "Error"}: ${error instanceof Error ? error.message : error}`, null);
    }
  });
}

export function _format_bash_result(output: string, exit_code: number | null): string {
  if (exit_code === 0 || exit_code === null) return output;
  return `Error: command exited with status ${exit_code}\n${output}`;
}

export async function run_bash(command: string, run_in_background = false): Promise<string> {
  const [output, exit_code] = await _run_bash_process(command);
  return _format_bash_result(output, exit_code);
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
  return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
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

export const TOOLS = [
  { "name": "bash", "description": "Run a shell command.",
    "input_schema": { "type": "object",
      "properties": {
        "command": { "type": "string" },
        "run_in_background": { "type": "boolean" } },
      "required": ["command"] } },
  { "name": "read_file", "description": "Read file contents.",
    "input_schema": { "type": "object",
      "properties": { "path": { "type": "string" },
        "limit": { "type": "integer" } },
      "required": ["path"] } },
  { "name": "write_file", "description": "Write content to a file.",
    "input_schema": { "type": "object",
      "properties": { "path": { "type": "string" },
        "content": { "type": "string" } },
      "required": ["path", "content"] } },
  { "name": "edit_file", "description": "Replace exact text in a file once.",
    "input_schema": { "type": "object",
      "properties": { "path": { "type": "string" },
        "old_text": { "type": "string" },
        "new_text": { "type": "string" } },
      "required": ["path", "old_text", "new_text"] } },
  { "name": "glob", "description": "Find files matching a glob pattern; ** matches recursively.",
    "input_schema": { "type": "object",
      "properties": { "pattern": { "type": "string" } },
      "required": ["pattern"] } },
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
  bash: bind_tool(run_bash, ["command"], ["run_in_background"]),
  read_file: bind_tool(run_read, ["path"], ["limit"]),
  write_file: bind_tool(run_write, ["path", "content"]),
  edit_file: bind_tool(run_edit, ["path", "old_text", "new_text"]),
  glob: bind_tool(run_glob, ["pattern"]),
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
    console.log(
      `\x1b[33m[HOOK] Large output from ${block.name}: ` +
      `${String(output).length} chars\x1b[0m`,
    );
  }
  return null;
}

export function context_inject_hook(query: string): null {
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

register_hook("UserPromptSubmit", context_inject_hook);
register_hook("PreToolUse", permission_hook);
register_hook("PreToolUse", log_hook);
register_hook("PostToolUse", large_output_hook);
register_hook("Stop", summary_hook);

export async function call_tool(block: any): Promise<string> {
  const handler = TOOL_HANDLERS[block.name];
  try {
    const output = handler ? await handler(block.input) : `Unknown: ${block.name}`;
    return String(output);
  } catch (error: any) {
    return `Error: ${error instanceof Error ? error.message : error}`;
  }
}

// -- New in s11: background execution --

export class BackgroundManager {
  tasks: Record<string, any> = {};
  results: Record<string, string> = {};
  _ready: string[] = [];
  _counter = 0;
  _lock = new SyncLock();

  start(block: any): string {
    if (block.name !== "bash") {
      throw new Error("Only Bash commands can run in the background");
    }
    const command = block.input?.command;
    if (typeof command !== "string" || !command.trim()) {
      throw new Error("Bash command cannot be empty");
    }

    this._lock.acquire();
    let task_id: string;
    try {
      this._counter += 1;
      task_id = `bg_${String(this._counter).padStart(4, "0")}`;
      this.tasks[task_id] = {
        tool_use_id: block.id,
        command,
        status: "running",
      };
    } finally {
      this._lock.release();
    }

    try {
      void this._run(task_id, command);
    } catch (error) {
      this._lock.acquire();
      try {
        delete this.tasks[task_id];
      } finally {
        this._lock.release();
      }
      throw error;
    }
    console.log(`  [background] started ${task_id}: ${command.slice(0, 60)}`);
    return task_id;
  }

  async _run(task_id: string, command: string): Promise<void> {
    let result: string;
    let status: string;
    try {
      const [output, exit_code] = await _run_bash_process(command);
      result = _format_bash_result(output, exit_code);
      status = exit_code === 0 ? "completed" : "failed";
    } catch (error: any) {
      result = `Error: ${error?.name ?? "Error"}: ${error instanceof Error ? error.message : error}`;
      status = "failed";
    }

    this._lock.acquire();
    try {
      const task = this.tasks[task_id];
      if (task === undefined) return;
      task.status = status;
      this.results[task_id] = result;
      this._ready.push(task_id);
    } finally {
      this._lock.release();
    }
  }

  collect(): string[] {
    this._lock.acquire();
    const ready: Array<[string, any, string]> = [];
    try {
      for (const task_id of this._ready) {
        const task = this.tasks[task_id];
        const result = this.results[task_id] ?? "";
        delete this.tasks[task_id];
        delete this.results[task_id];
        if (task !== undefined) ready.push([task_id, task, result]);
      }
      this._ready.splice(0, this._ready.length);
    } finally {
      this._lock.release();
    }

    const notifications: string[] = [];
    for (const [task_id, task, result] of ready) {
      notifications.push(
        "<task_notification>\n" +
        `  <task_id>${task_id}</task_id>\n` +
        `  <status>${task.status}</status>\n` +
        `  <command>${task.command}</command>\n` +
        `  <summary>${char_slice(result, 500)}</summary>\n` +
        "</task_notification>",
      );
      console.log(`  [background] collected ${task_id}: ${task.status}`);
    }
    return notifications;
  }
}

export const BACKGROUND = new BackgroundManager();
export const background_tasks = BACKGROUND.tasks;
export const background_results = BACKGROUND.results;

export function should_run_background(tool_name: string, tool_input: any): boolean {
  return tool_name === "bash" && tool_input?.run_in_background === true;
}

export function start_background_task(block: any): string {
  return BACKGROUND.start(block);
}

export function collect_background_results(): string[] {
  return BACKGROUND.collect();
}

export function inject_background_results(messages: any[]): number {
  const notifications = collect_background_results();
  if (!notifications.length) return 0;

  const blocks = notifications.map((item) => ({ type: "text", text: item }));
  if (messages.length && messages[messages.length - 1]?.role === "user") {
    const content = messages[messages.length - 1].content ?? "";
    if (Array.isArray(content)) content.push(...blocks);
    else {
      messages[messages.length - 1].content = [
        { type: "text", text: String(content) },
        ...blocks,
      ];
    }
  } else {
    messages.push({ role: "user", content: blocks });
  }
  return notifications.length;
}

export async function execute_tool(block: any): Promise<string> {
  const blocked = await trigger_hooks("PreToolUse", block);
  if (blocked !== null && blocked !== undefined) return String(blocked);

  let output: string;
  if (should_run_background(block.name, block.input)) {
    try {
      const task_id = start_background_task(block);
      output = `[Background task ${task_id} started] The result will be collected on a later turn.`;
    } catch (error: any) {
      output = `Error: ${error instanceof Error ? error.message : error}`;
    }
  } else {
    output = await call_tool(block);
  }

  await trigger_hooks("PostToolUse", block, output);
  return output;
}

// -- Agent loop --

export async function agent_loop(messages: any[]): Promise<void> {
  while (true) {
    inject_background_results(messages);
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
  console.log("s11: Background Tasks - explicit background Bash execution");
  console.log("Enter a question, press Enter to send. Type q to quit.\n");

  const history: any[] = [];
  const reader = line_reader ?? (line_reader = createInterface({ input: stdin, output: stdout }));
  try {
    while (true) {
      let query: string;
      try {
        query = await reader.question("\x1b[36ms11 >> \x1b[0m");
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
  } finally {
    _stop_all_shell_processes();
    reader.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
