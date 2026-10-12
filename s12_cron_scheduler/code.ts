/**
 * s12_cron_scheduler.ts - Cron Scheduler
 *
 *     +--------------------------+   09:00   +-----------------------+
 *     | 0 9 * * *               | --------> | [Scheduled] run tests |
 *     | prompt: "run tests"      |           +-----------+-----------+
 *     +--------------------------+                       |
 *           scheduled_jobs                    cron_queue | agent idle
 *                                                         v
 *                                                 +-------------+
 *                                                 | Agent Loop  |
 *                                                 +-------------+
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
import { threadId } from "node:worker_threads";

loadDotenv({ override: true, quiet: true });
if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

export const WORKDIR = process.cwd();
export const DURABLE_PATH = node_path.join(WORKDIR, ".scheduled_tasks.json");
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
  "Use schedule_cron for work that should start at a future local time.";

class SyncLock {
  private depth = 0;
  acquire(): void {
    this.depth += 1;
  }
  release(): void {
    this.depth -= 1;
  }
}

class Mutex {
  private locked = false;
  private waiters: Array<() => void> = [];

  try_acquire(): boolean {
    if (this.locked) return false;
    this.locked = true;
    return true;
  }

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.locked = false;
  }
}

export class ValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValueError";
  }
}

function char_slice(text: string, limit: number): string {
  if (limit <= 0) return "";
  if (text.length <= limit) return text;
  return Array.from(text).slice(0, limit).join("");
}

function char_length(text: string): number {
  return Array.from(text).length;
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

function splitlines(text: string): string[] {
  const lines = text.split(/\r\n|[\n\r\v\f\u0085\u2028\u2029]/);
  if (text.length > 0 && /[\n\r\v\f\u0085\u2028\u2029]$/.test(text)) lines.pop();
  return lines;
}

function py_int(text: string): number {
  if (!/^[+-]?\d+$/.test(text)) {
    throw new ValueError(`invalid literal for int() with base 10: ${py_repr(text)}`);
  }
  return Number(text);
}

function py_ws_split(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  return trimmed.split(/\s+/);
}

function split_once(text: string, separator: string): [string, string] {
  const index = text.indexOf(separator);
  if (index < 0) return [text, ""];
  return [text.slice(0, index), text.slice(index + separator.length)];
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
  if (result.status !== 0) return `Error: command exited with status ${result.status}\n${output}`;
  return output ? char_slice(output, 50000) : "(no output)";
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

export const TOOLS: any[] = [
  { "name": "bash", "description": "Run a shell command.",
    "input_schema": { "type": "object",
      "properties": { "command": { "type": "string" } },
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
  bash: bind_tool(run_bash, ["command"]),
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

let line_reader: ReadlineInterface | null = null;
let scheduler_turn = false;

function input_line(prompt: string): Promise<string> {
  if (!line_reader) line_reader = createInterface({ input: stdin, output: stdout });
  return line_reader.question(prompt);
}

export async function request_permission(block: any, reason: string): Promise<string | null> {
  if (scheduler_turn) {
    return "Permission denied: scheduled turns cannot request interactive approval";
  }

  console.log(`\n\x1b[33m[permission] ${reason}\x1b[0m`);
  console.log(`   Tool: ${block.name}(${py_repr(block.input)})`);
  const choice = (await input_line("   Allow? [y/N] ")).trim().toLowerCase();
  if (choice !== "y" && choice !== "yes") return "Permission denied by user";
  return null;
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
      return request_permission(block, "Potentially destructive command");
    }
  }

  if (block.name === "read_file" || block.name === "write_file" || block.name === "edit_file") {
    const file = block.input?.path ?? "";
    if (!is_relative_to(resolve_path(node_path.resolve(WORKDIR, file)), WORKDIR)) {
      return request_permission(block, "Access outside workspace");
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

// -- New in s12: cron jobs --

export class CronJob {
  id: string;
  cron: string;
  prompt: string;
  recurring: boolean;
  durable: boolean;
  pending_delivery = false;
  last_fired: string | null = null;

  constructor(
    id: string,
    cron: string,
    prompt: string,
    recurring: boolean,
    durable: boolean,
    pending_delivery = false,
    last_fired: string | null = null,
  ) {
    this.id = id;
    this.cron = cron;
    this.prompt = prompt;
    this.recurring = recurring;
    this.durable = durable;
    this.pending_delivery = pending_delivery;
    this.last_fired = last_fired;
  }
}

const CRON_FIELDS = ["id", "cron", "prompt", "recurring", "durable", "pending_delivery", "last_fired"];
const CRON_REQUIRED = ["id", "cron", "prompt", "recurring", "durable"];

function asdict_cron(job: CronJob): Record<string, any> {
  return {
    id: job.id,
    cron: job.cron,
    prompt: job.prompt,
    recurring: job.recurring,
    durable: job.durable,
    pending_delivery: job.pending_delivery,
    last_fired: job.last_fired,
  };
}

function cron_job_from_dict(item: any): CronJob {
  if (item === null || typeof item !== "object" || Array.isArray(item)) {
    throw new TypeError("CronJob.__init__() argument must be a mapping");
  }
  for (const key of Object.keys(item)) {
    if (!CRON_FIELDS.includes(key)) {
      throw new TypeError(`CronJob.__init__() got an unexpected keyword argument '${key}'`);
    }
  }
  for (const key of CRON_REQUIRED) {
    if (!(key in item)) {
      throw new TypeError(`CronJob.__init__() missing 1 required positional argument: '${key}'`);
    }
  }
  return new CronJob(
    item.id,
    item.cron,
    item.prompt,
    item.recurring,
    item.durable,
    "pending_delivery" in item ? item.pending_delivery : false,
    "last_fired" in item ? item.last_fired : null,
  );
}

export const scheduled_jobs: Record<string, CronJob> = {};
export const cron_queue: CronJob[] = [];
export const cron_lock = new SyncLock();

export function _cron_field_matches(field: string, value: number): boolean {
  if (field === "*") return true;
  if (field.startsWith("*/")) {
    const step = py_int(field.slice(2));
    if (step === 0) throw new Error("integer modulo by zero");
    return value % step === 0;
  }
  if (field.includes(",")) {
    return field.split(",").some((part) => _cron_field_matches(part.trim(), value));
  }
  if (field.includes("-")) {
    const [start, end] = split_once(field, "-");
    return py_int(start) <= value && value <= py_int(end);
  }
  return value === py_int(field);
}

export function cron_matches(cron_expr: string, moment: Date): boolean {
  const fields = py_ws_split(cron_expr);
  if (fields.length !== 5) return false;

  const [minute, hour, day, month, weekday] = fields;
  const cron_weekday = moment.getDay();
  if (!(
    _cron_field_matches(minute, moment.getMinutes())
    && _cron_field_matches(hour, moment.getHours())
    && _cron_field_matches(month, moment.getMonth() + 1)
  )) {
    return false;
  }

  const day_matches = _cron_field_matches(day, moment.getDate());
  const weekday_matches = _cron_field_matches(weekday, cron_weekday);
  if (day === "*" && weekday === "*") return true;
  if (day === "*") return weekday_matches;
  if (weekday === "*") return day_matches;
  return day_matches || weekday_matches;
}

export function _validate_cron_field(field: string, minimum: number, maximum: number): string | null {
  if (field === "*") return null;
  if (field.startsWith("*/")) {
    const step = field.slice(2);
    if (!/^\d+$/.test(step) || py_int(step) <= 0) return `Invalid step: ${field}`;
    return null;
  }
  if (field.includes(",")) {
    for (const part of field.split(",")) {
      const error = _validate_cron_field(part.trim(), minimum, maximum);
      if (error) return error;
    }
    return null;
  }
  if (field.includes("-")) {
    const [start, end] = split_once(field, "-");
    if (!/^\d+$/.test(start) || !/^\d+$/.test(end)) return `Invalid range: ${field}`;
    const start_value = py_int(start);
    const end_value = py_int(end);
    if (start_value > end_value) return `Range start is greater than end: ${field}`;
    if (start_value < minimum || end_value > maximum) {
      return `Range ${field} is outside [${minimum}-${maximum}]`;
    }
    return null;
  }
  if (!/^\d+$/.test(field)) return `Invalid field: ${field}`;
  const value = py_int(field);
  if (value < minimum || value > maximum) return `Value ${value} is outside [${minimum}-${maximum}]`;
  return null;
}

export function validate_cron(cron_expr: string): string | null {
  const fields = py_ws_split(cron_expr);
  if (fields.length !== 5) return `Expected 5 fields, got ${fields.length}`;

  const field_rules: Array<[string, number, number]> = [
    ["minute", 0, 59],
    ["hour", 0, 23],
    ["day-of-month", 1, 31],
    ["month", 1, 12],
    ["day-of-week", 0, 6],
  ];
  for (let index = 0; index < fields.length; index++) {
    const [name, minimum, maximum] = field_rules[index];
    const error = _validate_cron_field(fields[index], minimum, maximum);
    if (error) return `${name}: ${error}`;
  }
  return null;
}

export function save_durable_jobs(): void {
  cron_lock.acquire();
  const temporary = node_path.join(
    node_path.dirname(DURABLE_PATH),
    `${node_path.basename(DURABLE_PATH)}.${process.pid}.${threadId}.tmp`,
  );
  try {
    const payload = Object.values(scheduled_jobs).filter((job) => job.durable).map(asdict_cron);
    try {
      fs.writeFileSync(temporary, py_json(payload), "utf-8");
      fs.renameSync(temporary, DURABLE_PATH);
    } finally {
      try {
        fs.unlinkSync(temporary);
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  } finally {
    cron_lock.release();
  }
}

export function load_durable_jobs(): void {
  if (!fs.existsSync(DURABLE_PATH)) return;
  let payload: any;
  try {
    payload = JSON.parse(read_text(DURABLE_PATH));
    if (!Array.isArray(payload)) throw new ValueError("expected a JSON list");
  } catch (error: any) {
    console.log(`  [cron] could not load ${node_path.basename(DURABLE_PATH)}: ${error instanceof Error ? error.message : error}`);
    return;
  }

  let loaded = 0;
  cron_lock.acquire();
  try {
    for (const item of payload) {
      try {
        const job = cron_job_from_dict(item);
        const error = validate_cron(job.cron);
        if (error) throw new ValueError(error);
        if (!String(job.id).startsWith("cron_")) throw new ValueError("invalid job ID");
        if (typeof job.prompt !== "string" || !job.prompt.trim()) {
          throw new ValueError("prompt cannot be empty");
        }
        scheduled_jobs[job.id] = job;
        if (job.pending_delivery) cron_queue.push(job);
        loaded += 1;
      } catch (error) {
        if (error instanceof TypeError || error instanceof ValueError) {
          console.log(`  [cron] skipped invalid saved job: ${error.message}`);
          continue;
        }
        throw error;
      }
    }
  } finally {
    cron_lock.release();
  }
  if (loaded) console.log(`  [cron] loaded ${loaded} durable job(s)`);
}

export function new_cron_id(): string {
  for (let attempt = 0; attempt < 100; attempt++) {
    const job_id = `cron_${randomBytes(4).toString("hex")}`;
    if (!(job_id in scheduled_jobs)) return job_id;
  }
  throw new Error("Could not allocate a cron job ID");
}

export function schedule_job(
  cron: string,
  prompt: string,
  recurring = true,
  durable = true,
): CronJob | string {
  const error = validate_cron(cron);
  if (error) return error;
  if (!prompt.trim()) return "Prompt cannot be empty";

  cron_lock.acquire();
  let job: CronJob;
  try {
    job = new CronJob(new_cron_id(), cron, prompt, recurring, durable);
    scheduled_jobs[job.id] = job;
    try {
      if (durable) save_durable_jobs();
    } catch (save_error) {
      delete scheduled_jobs[job.id];
      throw save_error;
    }
  } finally {
    cron_lock.release();
  }
  console.log(`  [cron] scheduled ${job.id}: ${cron} -> ${char_slice(prompt, 60)}`);
  return job;
}

function replace_queue(next: CronJob[]): void {
  cron_queue.splice(0, cron_queue.length, ...next);
}

export function cancel_job(job_id: string): string {
  cron_lock.acquire();
  try {
    const job = scheduled_jobs[job_id];
    if (job === undefined) return `Job ${job_id} not found`;

    const previous_queue = [...cron_queue];
    delete scheduled_jobs[job_id];
    replace_queue(cron_queue.filter((queued) => queued.id !== job_id));
    try {
      if (job.durable) save_durable_jobs();
    } catch (save_error) {
      scheduled_jobs[job_id] = job;
      replace_queue(previous_queue);
      throw save_error;
    }
  } finally {
    cron_lock.release();
  }
  console.log(`  [cron] cancelled ${job_id}`);
  return `Cancelled ${job_id}`;
}

export function _enqueue_due_job(job: CronJob, minute: string | null = null): void {
  const old_pending = job.pending_delivery;
  const old_last_fired = job.last_fired;
  job.pending_delivery = true;
  if (minute !== null) job.last_fired = minute;
  try {
    if (job.durable) save_durable_jobs();
  } catch (error) {
    job.pending_delivery = old_pending;
    job.last_fired = old_last_fired;
    throw error;
  }
  cron_queue.push(job);
}

function format_minute(moment: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${moment.getFullYear()}-${pad(moment.getMonth() + 1)}-${pad(moment.getDate())} ${pad(moment.getHours())}:${pad(moment.getMinutes())}`;
}

export function poll_due_jobs(moment: Date): void {
  const marker = format_minute(moment);
  cron_lock.acquire();
  try {
    for (const job of Object.values(scheduled_jobs)) {
      try {
        if (job.pending_delivery || job.last_fired === marker) continue;
        if (cron_matches(job.cron, moment)) {
          _enqueue_due_job(job, marker);
          console.log(`  [cron] due ${job.id}: ${char_slice(job.prompt, 60)}`);
        }
      } catch (error: any) {
        console.log(`  [cron] could not enqueue ${job.id}: ${error instanceof Error ? error.message : error}`);
      }
    }
  } finally {
    cron_lock.release();
  }
}

export function consume_cron_queue(): CronJob[] {
  cron_lock.acquire();
  try {
    const jobs = [...cron_queue];
    cron_queue.splice(0, cron_queue.length);
    return jobs;
  } finally {
    cron_lock.release();
  }
}

export function acknowledge_cron_jobs(jobs: CronJob[]): void {
  const changed: Array<[CronJob, boolean]> = [];
  const removed: CronJob[] = [];
  cron_lock.acquire();
  try {
    for (const delivered of jobs) {
      const current = scheduled_jobs[delivered.id];
      if (current === undefined) continue;
      changed.push([current, current.pending_delivery]);
      if (current.recurring) current.pending_delivery = false;
      else {
        removed.push(current);
        delete scheduled_jobs[current.id];
      }
    }

    try {
      if (changed.some(([job]) => job.durable)) save_durable_jobs();
    } catch (error) {
      for (const job of removed) scheduled_jobs[job.id] = job;
      for (const [job, pending] of changed) job.pending_delivery = pending;
      const queued_ids = new Set(cron_queue.map((job) => job.id));
      for (const [job] of changed) {
        if (!queued_ids.has(job.id)) cron_queue.push(job);
      }
      throw error;
    }
  } finally {
    cron_lock.release();
  }
}

export function restore_cron_jobs(jobs: CronJob[]): void {
  cron_lock.acquire();
  try {
    const queued_ids = new Set(cron_queue.map((job) => job.id));
    for (const delivered of jobs) {
      const current = scheduled_jobs[delivered.id];
      if (current === undefined) continue;
      current.pending_delivery = true;
      if (!queued_ids.has(current.id)) {
        cron_queue.push(current);
        queued_ids.add(current.id);
      }
    }
  } finally {
    cron_lock.release();
  }
}

export function has_cron_queue(): boolean {
  cron_lock.acquire();
  try {
    return cron_queue.length > 0;
  } finally {
    cron_lock.release();
  }
}

export function run_schedule_cron(
  cron: string,
  prompt: string,
  recurring = true,
  durable = true,
): string {
  const result = schedule_job(cron, prompt, recurring, durable);
  if (typeof result === "string") return `Error: ${result}`;
  return `Scheduled ${result.id}: ${cron} -> ${prompt}`;
}

export function run_list_crons(): string {
  cron_lock.acquire();
  let jobs: CronJob[];
  try {
    jobs = Object.values(scheduled_jobs);
  } finally {
    cron_lock.release();
  }
  if (!jobs.length) return "No cron jobs.";

  const lines: string[] = [];
  for (const job of jobs) {
    const frequency = job.recurring ? "recurring" : "one-shot";
    const storage = job.durable ? "durable" : "session";
    lines.push(`${job.id}: ${job.cron} -> ${char_slice(job.prompt, 60)} [${frequency}, ${storage}]`);
  }
  return lines.join("\n");
}

export function run_cancel_cron(job_id: string): string {
  return cancel_job(job_id);
}

TOOLS.push(
  { "name": "schedule_cron",
    "description": "Schedule a prompt with a 5-field cron expression.",
    "input_schema": { "type": "object",
      "properties": {
        "cron": { "type": "string" },
        "prompt": { "type": "string" },
        "recurring": { "type": "boolean" },
        "durable": { "type": "boolean" } },
      "required": ["cron", "prompt"] } },
  { "name": "list_crons", "description": "List scheduled cron jobs.",
    "input_schema": { "type": "object", "properties": {}, "required": [] } },
  { "name": "cancel_cron", "description": "Cancel a cron job by ID.",
    "input_schema": { "type": "object",
      "properties": { "job_id": { "type": "string" } },
      "required": ["job_id"] } },
);

Object.assign(TOOL_HANDLERS, {
  schedule_cron: bind_tool(run_schedule_cron, ["cron", "prompt"], ["recurring", "durable"]),
  list_crons: bind_tool(run_list_crons, []),
  cancel_cron: bind_tool(run_cancel_cron, ["job_id"]),
});

export async function execute_tool(block: any): Promise<string> {
  const blocked = await trigger_hooks("PreToolUse", block);
  if (blocked !== null && blocked !== undefined) return String(blocked);

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

// -- Scheduler and agent loop --

class EventFlag {
  private flag = false;
  set(): void {
    this.flag = true;
  }
  clear(): void {
    this.flag = false;
  }
  is_set(): boolean {
    return this.flag;
  }
}

export const RUNTIME_STOP = new EventFlag();
export const runtime_threads: Array<{ name: string }> = [];
export let runtime_started = false;
export const runtime_lock = new SyncLock();
export const agent_lock = new Mutex();
export const session_history: any[] = [];

let scheduler_timer: NodeJS.Timeout | undefined;
let queue_timer: NodeJS.Timeout | undefined;

export function cron_scheduler_loop(): void {
  const tick = () => {
    if (RUNTIME_STOP.is_set()) return;
    poll_due_jobs(new Date());
    scheduler_timer = setTimeout(tick, 1000);
  };
  scheduler_timer = setTimeout(tick, 1000);
}

export async function agent_loop(messages: any[], context: any = null): Promise<any> {
  const fired = consume_cron_queue();
  const scheduled_start = messages.length;
  for (const job of fired) {
    messages.push({ role: "user", content: `[Scheduled] ${job.prompt}` });
    console.log(`  [cron] delivered ${job.id}: ${char_slice(job.prompt, 60)}`);
  }

  let waiting_for_ack = [...fired];
  while (true) {
    let response: any;
    try {
      response = await client.messages.create({
        model: MODEL,
        system: SYSTEM,
        messages,
        tools: TOOLS as any,
        max_tokens: 8000,
      });
    } catch (error: any) {
      if (waiting_for_ack.length) {
        messages.splice(scheduled_start);
        restore_cron_jobs(waiting_for_ack);
      }
      const name = error?.name ?? "Error";
      const message = error instanceof Error ? error.message : error;
      console.log(`  [error] ${name}: ${message}`);
      return context;
    }

    messages.push({ role: "assistant", content: response.content });
    if (waiting_for_ack.length) {
      try {
        acknowledge_cron_jobs(waiting_for_ack);
      } catch (error: any) {
        console.log(`  [cron] acknowledgement failed: ${error instanceof Error ? error.message : error}`);
      }
      waiting_for_ack = [];
    }

    const tool_calls = (response.content as any[]).filter((block) => block.type === "tool_use");
    if (!tool_calls.length) {
      const force = await trigger_hooks("Stop", messages);
      if (force) {
        messages.push({ role: "user", content: force });
        continue;
      }
      return context;
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

export function print_latest_assistant_text(messages: any[]): void {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const content = message.content ?? "";
    if (typeof content === "string") console.log(content);
    else {
      for (const block of content) {
        if (block?.type === "text") console.log(block.text ?? "");
      }
    }
    return;
  }
}

export async function run_agent_turn_locked(user_query: string | null = null): Promise<void> {
  if (user_query !== null) {
    await trigger_hooks("UserPromptSubmit", user_query);
    session_history.push({ role: "user", content: user_query });
  }
  await agent_loop(session_history);
  print_latest_assistant_text(session_history);
  console.log();
}

export function queue_processor_loop(): void {
  const tick = () => {
    if (RUNTIME_STOP.is_set()) return;
    if (!has_cron_queue() || !agent_lock.try_acquire()) {
      queue_timer = setTimeout(tick, 200);
      return;
    }
    scheduler_turn = true;
    void (async () => {
      try {
        if (has_cron_queue()) await run_agent_turn_locked();
      } finally {
        scheduler_turn = false;
        agent_lock.release();
        if (!RUNTIME_STOP.is_set()) queue_timer = setTimeout(tick, 200);
      }
    })();
  };
  queue_timer = setTimeout(tick, 200);
}

export function start_runtime_threads(): void {
  runtime_lock.acquire();
  try {
    if (runtime_started) return;
    load_durable_jobs();
    RUNTIME_STOP.clear();
    runtime_threads.push({ name: "cron-scheduler" }, { name: "cron-queue-processor" });
    cron_scheduler_loop();
    queue_processor_loop();
    runtime_started = true;
  } finally {
    runtime_lock.release();
  }
}

export function stop_runtime_threads(): void {
  runtime_lock.acquire();
  try {
    if (!runtime_started) return;
    RUNTIME_STOP.set();
    if (scheduler_timer) clearTimeout(scheduler_timer);
    if (queue_timer) clearTimeout(queue_timer);
    scheduler_timer = undefined;
    queue_timer = undefined;
    runtime_threads.splice(0, runtime_threads.length);
    runtime_started = false;
  } finally {
    runtime_lock.release();
  }
}

async function main(): Promise<void> {
  console.log("s12: Cron Scheduler - run prompts on a local schedule");
  console.log("Enter a question, press Enter to send. Type q to quit.\n");
  start_runtime_threads();
  const reader = line_reader ?? (line_reader = createInterface({ input: stdin, output: stdout }));
  try {
    while (true) {
      let query: string;
      try {
        query = await reader.question("\x1b[36ms12 >> \x1b[0m");
      } catch {
        break;
      }
      if (["q", "exit", ""].includes(query.trim().toLowerCase())) break;
      await agent_lock.acquire();
      try {
        await run_agent_turn_locked(query);
      } finally {
        agent_lock.release();
      }
    }
  } finally {
    stop_runtime_threads();
    reader.close();
  }
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
