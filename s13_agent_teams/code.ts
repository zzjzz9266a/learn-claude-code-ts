#!/usr/bin/env npx tsx
/**
 * s13: Agent Teams - persistent teammates with shared tasks and mailboxes.
 *
 * Run:  npx tsx s13_agent_teams/code.ts
 * Need: npm install @anthropic-ai/sdk dotenv + .env with ANTHROPIC_API_KEY
 *
 *     +------+  spawn(task_id)  +----------+  result  +------+
 *     | Lead | ---------------> |   WORK   | -------> | IDLE |
 *     +--+---+                  +----+-----+          +--+---+
 *        ^                           |                   |
 *        | team events               | tools             | wait
 *        |                           v                   v
 *     +--+-----------+          +----------+        +----------+
 *     | MessageBus   |          | Task cwd | <----- | Mailbox  |
 *     +--------------+          +----------+  claim +----------+
 *
 *     .tasks/       shared task records and dependencies
 *     .mailboxes/   messages, results, and protocol responses
 *     .worktrees/   optional task-bound working directories
 */

import { spawnSync } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type Dirent,
} from "node:fs";
import path from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { threadId } from "node:worker_threads";
import Anthropic from "@anthropic-ai/sdk";
import { config as loadDotenv } from "dotenv";

loadDotenv({ override: true, quiet: true });
if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

const modelId = process.env.MODEL_ID;
if (!modelId) {
  throw new Error("MODEL_ID");
}

export const WORKDIR = process.cwd();
export const client = new Anthropic({
  baseURL: process.env.ANTHROPIC_BASE_URL ?? null,
});
export const MODEL = modelId;

// -- Task System --

export const TASKS_DIR = path.join(WORKDIR, ".tasks");
export const TASKS_ROOT = resolvePath(TASKS_DIR);
export const TASK_ID_PATTERN = /^task_[0-9a-f]{8}$/;
export const task_lock = createReentrantLock();
export const TASK_LOCK_PATH = path.join(TASKS_DIR, ".lock");

// owner -> {"task_id": str, "cwd": path}. A teammate gets one assignment at
// a time, and every filesystem tool resolves its cwd through this registry.
export const teammate_assignments: Record<string, Record<string, any>> = {};
export const assignment_versions: Record<string, number> = {};

let taskStoreDepth = 0;
let taskStoreLockFd: number | null = null;

export let plan_gates: Record<string, string> = {};
export let plan_request_ids: Record<string, string> = {};
export const team_lock = createReentrantLock();

class ValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValueError";
  }
}

class RuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeError";
  }
}

function createReentrantLock() {
  let depth = 0;
  return {
    acquire() {
      depth += 1;
    },
    release() {
      if (depth === 0) {
        const error = new Error("cannot release un-acquired lock");
        error.name = "RuntimeError";
        throw error;
      }
      depth -= 1;
    },
  };
}

function withLock<T>(lock: { acquire(): void; release(): void }, fn: () => T): T {
  lock.acquire();
  try {
    return fn();
  } finally {
    lock.release();
  }
}

function errnoCode(exc: unknown): string | undefined {
  if (exc && typeof exc === "object" && "code" in exc) {
    const code = (exc as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function errorText(exc: unknown): string {
  if (exc instanceof Error) return exc.message;
  return String(exc);
}

function errorName(exc: unknown): string {
  if (exc instanceof Error && exc.name) return exc.name;
  return "Error";
}

function isEnoent(exc: unknown): boolean {
  return errnoCode(exc) === "ENOENT";
}

function pyRepr(value: unknown): string {
  if (typeof value === "string") {
    return `'${value
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "\\'")
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t")}'`;
  }
  if (typeof value === "boolean") return value ? "True" : "False";
  if (value === null || value === undefined) return "None";
  if (typeof value === "number") return Object.is(value, -0) ? "-0" : String(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => pyRepr(item)).join(", ")}]`;
  }
  if (isPlainObject(value)) {
    const body = Object.entries(value)
      .map(([key, item]) => `${pyRepr(key)}: ${pyRepr(item)}`)
      .join(", ");
    return `{${body}}`;
  }
  return String(value);
}

function isPlainObject(value: any): value is Record<string, any> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function ensureAscii(text: string): string {
  return text.replace(/[^\x00-\x7F]/gu, (ch) => {
    const code = ch.codePointAt(0)!;
    if (code <= 0xffff) {
      return `\\u${code.toString(16).padStart(4, "0")}`;
    }
    const shifted = code - 0x10000;
    const high = 0xd800 + (shifted >> 10);
    const low = 0xdc00 + (shifted & 0x3ff);
    return `\\u${high.toString(16).padStart(4, "0")}\\u${low.toString(16).padStart(4, "0")}`;
  });
}

function jsonDumps(value: unknown, indent?: number): string {
  const text = indent === undefined ? JSON.stringify(value) : JSON.stringify(value, null, indent);
  return ensureAscii(text);
}

function splitlines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r\n|[\n\r\v\f\u001c\u001d\u001e\u0085\u2028\u2029]/);
  if (/(?:\r\n|[\n\r\v\f\u001c\u001d\u001e\u0085\u2028\u2029])$/.test(text)) {
    lines.pop();
  }
  return lines;
}

function pyLen(text: string): number {
  return Array.from(text).length;
}

function pyCount(haystack: string, needle: string): number {
  if (needle === "") return pyLen(haystack) + 1;
  let count = 0;
  let start = 0;
  while (start <= haystack.length) {
    const index = haystack.indexOf(needle, start);
    if (index < 0) return count;
    count += 1;
    start = index + needle.length;
  }
  return count;
}

function readText(filePath: string): string {
  const bytes = readFileSync(filePath);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function isRelativeTo(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  if (relative === "") return true;
  if (path.isAbsolute(relative)) return false;
  return !relative.split(path.sep).includes("..");
}

function resolvePath(input: string): string {
  const absolute = path.isAbsolute(input) ? input : path.join(process.cwd(), input);
  const root = path.parse(absolute).root;
  const pieces = absolute.slice(root.length).split(/[\\/]+/);
  let current = root || absolute;
  let lexical = false;
  for (const piece of pieces) {
    if (!piece || piece === ".") continue;
    if (piece === "..") {
      if (current !== root && path.dirname(current) !== current) {
        current = path.dirname(current);
      }
      continue;
    }
    const next = current === root ? path.join(root, piece) : path.join(current, piece);
    if (lexical) {
      current = next;
      continue;
    }
    try {
      const stat = lstatSync(next);
      if (stat.isSymbolicLink()) {
        try {
          current = realpathSync(next);
        } catch (exc) {
          if (errnoCode(exc) !== "ENOENT") throw exc;
          const link = readlinkSync(next);
          const target = path.isAbsolute(link) ? link : path.join(current, link);
          current = resolvePath(target);
        }
        continue;
      }
      current = next;
    } catch (exc) {
      if (errnoCode(exc) === "ENOENT" || errnoCode(exc) === "ENOTDIR") {
        current = next;
        lexical = true;
        continue;
      }
      throw exc;
    }
  }
  return current;
}

function isFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isDir(filePath: string): boolean {
  try {
    return statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function sleepSync(ms: number): void {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

function acquireExclusiveLock(lockPath: string): number {
  while (true) {
    try {
      // Exclusive create stands in for fcntl.flock.
      return openSync(lockPath, "wx");
    } catch (exc) {
      if (errnoCode(exc) !== "EEXIST") throw exc;
      sleepSync(20);
    }
  }
}

/** Serialize task mutations across threads and host processes. */
export function task_store_lock<T>(fn: () => T): T {
  return withLock(task_lock, () => {
    if (taskStoreDepth === 0) {
      mkdirSync(TASKS_DIR, { recursive: true });
      taskStoreLockFd = acquireExclusiveLock(TASK_LOCK_PATH);
    }
    taskStoreDepth += 1;
    try {
      return fn();
    } finally {
      taskStoreDepth -= 1;
      if (taskStoreDepth === 0 && taskStoreLockFd !== null) {
        const fd = taskStoreLockFd;
        taskStoreLockFd = null;
        closeSync(fd);
        try {
          unlinkSync(TASK_LOCK_PATH);
        } catch (exc) {
          if (errnoCode(exc) !== "ENOENT") throw exc;
        }
      }
    }
  });
}

/** Invalidate old approvals without clearing an explicit plan requirement. */
export function advance_assignment_version(owner: string): void {
  withLock(task_lock, () => {
    assignment_versions[owner] = (assignment_versions[owner] ?? 0) + 1;
    const gates = plan_gates;
    const requestIds = plan_request_ids;
    const team = team_lock;
    if (team != null) {
      team.acquire();
    }
    try {
      if (gates && typeof gates === "object" && Object.prototype.hasOwnProperty.call(gates, owner)
          && gates[owner] !== "not_required") {
        gates[owner] = "required";
      }
      if (requestIds && typeof requestIds === "object") {
        delete requestIds[owner];
      }
    } finally {
      if (team != null) {
        team.release();
      }
    }
  });
}

export class Task {
  id: string;
  subject: string;
  description: string;
  status: string;
  owner: string | null;
  blockedBy: string[];
  worktree: string | null;

  constructor(fields: {
    id: string;
    subject: string;
    description: string;
    status: string;
    owner: string | null;
    blockedBy: string[];
    worktree?: string | null;
  }) {
    this.id = fields.id;
    this.subject = fields.subject;
    this.description = fields.description;
    this.status = fields.status;
    this.owner = fields.owner;
    this.blockedBy = fields.blockedBy;
    this.worktree = fields.worktree ?? null;
  }

  asdict(): Record<string, any> {
    return {
      id: this.id,
      subject: this.subject,
      description: this.description,
      status: this.status,
      owner: this.owner,
      blockedBy: this.blockedBy,
      worktree: this.worktree,
    };
  }
}

function taskFromData(data: any): Task {
  if (!isPlainObject(data)) {
    const error = new TypeError("Task() argument must be a mapping");
    throw error;
  }
  const allowed = new Set(["id", "subject", "description", "status", "owner", "blockedBy", "worktree"]);
  for (const key of Object.keys(data)) {
    if (!allowed.has(key)) {
      throw new TypeError(`Task() got an unexpected keyword argument '${key}'`);
    }
  }
  for (const key of ["id", "subject", "description", "status", "owner", "blockedBy"]) {
    if (!Object.prototype.hasOwnProperty.call(data, key)) {
      throw new TypeError(`Task() missing 1 required positional argument: '${key}'`);
    }
  }
  return new Task({
    id: data.id,
    subject: data.subject,
    description: data.description,
    status: data.status,
    owner: data.owner,
    blockedBy: data.blockedBy,
    worktree: Object.prototype.hasOwnProperty.call(data, "worktree") ? data.worktree : null,
  });
}

export function _task_path(task_id: string): string {
  if (typeof task_id !== "string" || !TASK_ID_PATTERN.test(task_id)) {
    throw new ValueError(`Invalid task ID: ${pyRepr(task_id)}`);
  }
  const filePath = resolvePath(path.join(TASKS_DIR, `${task_id}.json`));
  if (!isRelativeTo(TASKS_ROOT, resolvePath(WORKDIR)) || !isRelativeTo(filePath, TASKS_ROOT)) {
    throw new ValueError(`Invalid task ID: ${pyRepr(task_id)}`);
  }
  return filePath;
}

export function create_task(subject: string, description = ""): Task {
  subject = subject.trim();
  if (!subject) {
    throw new ValueError("Task subject cannot be empty");
  }
  const created = task_store_lock(() => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const task = new Task({
        id: `task_${randomBytes(4).toString("hex")}`,
        subject,
        description,
        status: "pending",
        owner: null,
        blockedBy: [],
      });
      const filePath = _task_path(task.id);
      try {
        writeFileSync(filePath, jsonDumps(task.asdict(), 2), { encoding: "utf-8", flag: "wx" });
        return task;
      } catch (exc) {
        if (errnoCode(exc) === "EEXIST") continue;
        throw exc;
      }
    }
    return null;
  });
  if (!created) {
    throw new RuntimeError("Could not allocate a unique task ID");
  }
  return created;
}

/** Return whether task_id transitively depends on target_id. */
export function _task_depends_on(task_id: string, target_id: string): boolean {
  const pending = [task_id];
  const visited = new Set<string>();
  while (pending.length) {
    const current = pending.pop()!;
    if (current === target_id) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...load_task(current).blockedBy);
  }
  return false;
}

/** Add dependency edges after create_task has returned real task IDs. */
export function update_task(task_id: string, addBlockedBy: string[]): Task {
  if (!Array.isArray(addBlockedBy)) {
    throw new ValueError("addBlockedBy must be a list of task IDs");
  }
  return task_store_lock(() => {
    const task = load_task(task_id);
    if (task.status !== "pending" || task.owner !== null) {
      throw new ValueError(
        `Task ${task_id} dependencies can only be updated while pending and unowned`,
      );
    }
    const dependencies = [...new Set(addBlockedBy)];
    for (const dependency of dependencies) {
      if (dependency === task_id) {
        throw new ValueError("Task cannot depend on itself");
      }
      if (!isFile(_task_path(dependency))) {
        throw new ValueError(`Dependency not found: ${dependency}`);
      }
      if (!task.blockedBy.includes(dependency) && _task_depends_on(dependency, task_id)) {
        throw new ValueError(`Dependency cycle detected: ${task_id} -> ${dependency}`);
      }
    }
    task.blockedBy.push(
      ...dependencies.filter((dependency) => !task.blockedBy.includes(dependency)),
    );
    save_task(task);
    return task;
  });
}

export function save_task(task: Task): void {
  task_store_lock(() => {
    const filePath = _task_path(task.id);
    const temporary = path.join(
      path.dirname(filePath),
      `.${path.basename(filePath)}.${process.pid}.${threadId}.tmp`,
    );
    try {
      writeFileSync(temporary, jsonDumps(task.asdict(), 2), "utf-8");
      renameSync(temporary, filePath);
    } finally {
      try {
        unlinkSync(temporary);
      } catch (exc) {
        if (errnoCode(exc) !== "ENOENT") throw exc;
      }
    }
  });
}

export function load_task(task_id: string): Task {
  return withLock(task_lock, () => {
    const data = JSON.parse(readText(_task_path(task_id)));
    const task = taskFromData(data);
    if (task.id !== task_id) {
      throw new ValueError(`Task file ID does not match ${task_id}`);
    }
    if (!["pending", "in_progress", "completed"].includes(task.status)) {
      throw new ValueError(`Invalid task status: ${task.status}`);
    }
    return task;
  });
}

export function list_tasks(): Task[] {
  return withLock(task_lock, () => {
    if (!existsSync(TASKS_DIR)) return [];
    if (!isRelativeTo(TASKS_ROOT, resolvePath(WORKDIR))) {
      throw new ValueError("Tasks directory escapes workspace");
    }
    const names = pathlibGlob(TASKS_DIR, "task_*.json").sort(comparePathParts);
    return names.map((name) => load_task(path.basename(name, ".json")));
  });
}

/** Return full task details as JSON. */
export function get_task(task_id: string): string {
  const task = load_task(task_id);
  return jsonDumps(task.asdict(), 2);
}

/** Check if all blockedBy dependencies are completed.
 * Missing dependencies are treated as blocked. */
export function can_start(task_id: string): boolean {
  const task = load_task(task_id);
  for (const dep_id of task.blockedBy) {
    let dep_path: string;
    try {
      dep_path = _task_path(dep_id);
    } catch (exc) {
      if (exc instanceof ValueError) return false;
      throw exc;
    }
    if (!existsSync(dep_path)) return false;
    if (load_task(dep_id).status !== "completed") return false;
  }
  return true;
}

export function _owner_in_progress(owner: string): Task | null {
  return list_tasks().find((task) => task.status === "in_progress" && task.owner === owner) ?? null;
}

export function _incomplete_dependencies(task: Task): string[] {
  const incomplete: string[] = [];
  for (const dep_id of task.blockedBy) {
    let dep_path: string;
    try {
      dep_path = _task_path(dep_id);
    } catch (exc) {
      if (exc instanceof ValueError) {
        incomplete.push(dep_id);
        continue;
      }
      throw exc;
    }
    if (!existsSync(dep_path) || load_task(dep_id).status !== "completed") {
      incomplete.push(dep_id);
    }
  }
  return incomplete;
}

/** Atomically claim one task and bind the owner's filesystem cwd. */
export function claim_task(task_id: string, owner = "agent"): string {
  let claimed: Task | null = null;
  const early = task_store_lock(() => {
    const task = load_task(task_id);
    if (task.status !== "pending") {
      return `Task ${task_id} is ${task.status}, cannot claim`;
    }
    if (task.owner) {
      return `Task ${task_id} is already owned by ${task.owner}`;
    }
    const assignment = teammate_assignments[owner];
    if (assignment) {
      return `Owner ${owner} must finish the current work turn for ${assignment["task_id"]} before claiming another task`;
    }
    const current = _owner_in_progress(owner);
    if (current) {
      return `Owner ${owner} must complete ${current.id} before claiming another task`;
    }
    if (!can_start(task_id)) {
      return `Blocked by: ${pyRepr(_incomplete_dependencies(task))}`;
    }
    const [cwd, error] = task_worktree_cwd(task);
    if (error) {
      return `Cannot claim ${task_id}: ${error}`;
    }
    task.owner = owner;
    task.status = "in_progress";
    save_task(task);
    teammate_assignments[owner] = { task_id: task.id, cwd };
    advance_assignment_version(owner);
    claimed = task;
    return null;
  });
  if (early !== null || !claimed) return early ?? "";
  const task = claimed as Task;
  console.log(`  [claim] ${task.subject} -> in_progress (owner: ${owner})`);
  return `Claimed ${task.id} (${task.subject})`;
}

/** Complete an assignment only when the caller owns it. */
export function complete_task(task_id: string, owner = "agent"): string {
  let subject = "";
  let unblocked: string[] = [];
  const early = task_store_lock(() => {
    const task = load_task(task_id);
    if (task.status !== "in_progress") {
      return `Task ${task_id} is ${task.status}, cannot complete`;
    }
    if (task.owner !== owner) {
      return `Task ${task_id} is owned by ${task.owner}, not ${owner}; cannot complete`;
    }
    const gate = (plan_gates ?? {})[owner] ?? "not_required";
    if (["required", "pending", "rejected"].includes(gate)) {
      return `Task ${task_id} cannot complete while plan status is ${gate}`;
    }
    const assignment = teammate_assignments[owner];
    if (!assignment || assignment["task_id"] !== task.id) {
      const [cwd, error] = task_worktree_cwd(task);
      if (error) {
        return `Task ${task_id} cannot complete: ${error}`;
      }
      teammate_assignments[owner] = { task_id: task.id, cwd };
    }
    task.status = "completed";
    save_task(task);
    unblocked = list_tasks()
      .filter((item) => item.status === "pending" && item.blockedBy.length && can_start(item.id))
      .map((item) => item.subject);
    subject = task.subject;
    return null;
  });
  if (early !== null) return early;
  console.log(`  [complete] ${subject}`);
  let msg = `Completed ${task_id} (${subject})`;
  if (unblocked.length) {
    msg += `\nUnblocked: ${unblocked.join(", ")}`;
    console.log(`  [unblocked] ${unblocked.join(", ")}`);
  }
  return msg;
}

// -- Task-bound Worktrees --

export const WORKTREES_DIR = path.join(WORKDIR, ".worktrees");
export const WORKTREES_ROOT = resolvePath(WORKTREES_DIR);
export const VALID_WORKTREE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function validate_worktree_name(name: string): string | null {
  if (typeof name !== "string" || !VALID_WORKTREE_NAME.test(name)) {
    return "worktree name must be 1-64 letters, digits, dots, underscores, or dashes, and start with a letter or digit";
  }
  if (name === "." || name === ".." || name.includes("..")) {
    return "worktree name cannot contain '..'";
  }
  return null;
}

export function _worktree_path(name: string): string {
  const filePath = resolvePath(path.join(WORKTREES_DIR, name));
  if (!isRelativeTo(WORKTREES_ROOT, resolvePath(WORKDIR))
      || !isRelativeTo(filePath, WORKTREES_ROOT)
      || filePath === WORKTREES_ROOT) {
    throw new ValueError(`Worktree path escapes directory: ${pyRepr(name)}`);
  }
  return filePath;
}

export function _worktree_branch(name: string): string {
  return `wt/${name}`;
}

function universalNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function spawnErrorName(err: NodeJS.ErrnoException): string {
  if (err.code === "ETIMEDOUT") return "TimeoutExpired";
  if (err.code === "ENOENT") return "FileNotFoundError";
  return "OSError";
}

/** Run Git without shell interpolation and preserve machine output. */
export function _run_git(args: string[], cwd: string | null = null): [boolean, string] {
  const result = spawnSync("git", args, {
    cwd: cwd || WORKDIR,
    encoding: "utf-8",
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) {
    const err = result.error as NodeJS.ErrnoException;
    return [false, `${spawnErrorName(err)}: ${err.message}`];
  }
  const stdout = typeof result.stdout === "string" ? universalNewlines(result.stdout) : "";
  const stderr = typeof result.stderr === "string" ? universalNewlines(result.stderr) : "";
  const output = (stdout + stderr).trim();
  return [result.status === 0, output || "(no output)"];
}

/** Run Git and bound only the text returned to the model. */
export function run_git(args: string[], cwd: string | null = null): [boolean, string] {
  const [ok, output] = _run_git(args, cwd);
  return [ok, output.slice(0, 5000)];
}

export function _registered_worktrees(): [Record<string, Record<string, string>>, string | null] {
  const [ok, output] = _run_git(["worktree", "list", "--porcelain"]);
  if (!ok) {
    return [{}, `cannot read Git worktree registry: ${output}`];
  }
  const entries: Record<string, Record<string, string>> = {};
  let current: Record<string, string> = {};
  for (const line of splitlines(output).concat([""])) {
    if (!line) {
      const raw_path = current["worktree"];
      if (raw_path) {
        entries[resolvePath(raw_path)] = current;
      }
      current = {};
      continue;
    }
    const splitAt = line.indexOf(" ");
    const key = splitAt < 0 ? line : line.slice(0, splitAt);
    const value = splitAt < 0 ? "" : line.slice(splitAt + 1);
    current[key] = value;
  }
  return [entries, null];
}

export function _registered_worktree(name: string): [string | null, string | null] {
  let filePath: string;
  try {
    filePath = _worktree_path(name);
  } catch (exc) {
    if (exc instanceof ValueError) return [null, errorText(exc)];
    throw exc;
  }
  const [entries, error] = _registered_worktrees();
  if (error) return [null, error];
  if (!(filePath in entries)) {
    return [null, `worktree '${name}' is not registered with Git`];
  }
  if (!isDir(filePath)) {
    return [null, `worktree '${name}' is missing at ${filePath}`];
  }
  const expected_branch = `refs/heads/${_worktree_branch(name)}`;
  if (entries[filePath]?.["branch"] !== expected_branch) {
    return [null, `worktree '${name}' is not registered on expected branch '${_worktree_branch(name)}'`];
  }
  return [filePath, null];
}

/** Resolve a task cwd, failing closed for broken worktree bindings. */
export function task_worktree_cwd(task: Task): [string, string | null] {
  if (!task.worktree) return [WORKDIR, null];
  const [filePath, error] = _registered_worktree(task.worktree);
  return [filePath || WORKDIR, error];
}

export function assignment_cwd(owner: string): string {
  return withLock(task_lock, () => {
    let assignment = teammate_assignments[owner];
    let task = _owner_in_progress(owner);
    if (task && (!assignment || assignment["task_id"] !== task.id)) {
      const [cwd, error] = task_worktree_cwd(task);
      if (error) throw new ValueError(error);
      assignment = { task_id: task.id, cwd };
      teammate_assignments[owner] = assignment;
    } else if (!assignment) {
      return WORKDIR;
    }
    task = load_task(String(assignment["task_id"]));
    if (!["in_progress", "completed"].includes(task.status) || task.owner !== owner) {
      throw new ValueError(`Assignment for ${owner} is no longer active`);
    }
    const [cwd, error] = task_worktree_cwd(task);
    if (error) throw new ValueError(error);
    if (resolvePath(cwd) !== resolvePath(String(assignment["cwd"]))) {
      throw new ValueError(`Assignment cwd changed for task ${task.id}`);
    }
    return cwd;
  });
}

/** Release a completed cwd lease only at a model turn boundary. */
export function release_completed_assignment(owner: string): boolean {
  return withLock(task_lock, () => {
    const assignment = teammate_assignments[owner];
    if (!assignment) return false;
    const task = load_task(String(assignment["task_id"]));
    if (task.status !== "completed" || task.owner !== owner) return false;
    delete teammate_assignments[owner];
    advance_assignment_version(owner);
    if (Object.prototype.hasOwnProperty.call(plan_gates, owner)) {
      plan_gates[owner] = "not_required";
    }
    return true;
  });
}

/** Return abandoned teammate work to the task board on thread exit. */
export function release_teammate_assignment(owner: string): void {
  withLock(task_lock, () => {
    try {
      const task = _owner_in_progress(owner);
      if (task) {
        task.status = "pending";
        task.owner = null;
        save_task(task);
      }
    } finally {
      delete teammate_assignments[owner];
      advance_assignment_version(owner);
      if (Object.prototype.hasOwnProperty.call(plan_gates, owner)) {
        plan_gates[owner] = "not_required";
      }
    }
  });
}

/** Create and bind a dedicated worktree after all inputs validate. */
export function create_worktree(name: string, task_id: string): string {
  const error = validate_worktree_name(name);
  if (error) return `Error: ${error}`;
  let worktreePath: string;
  let taskPath: string;
  try {
    worktreePath = _worktree_path(name);
    taskPath = _task_path(task_id);
  } catch (exc) {
    if (exc instanceof ValueError) return `Error: ${errorText(exc)}`;
    throw exc;
  }
  const branch = _worktree_branch(name);
  const early = withLock(task_lock, () => {
    if (!existsSync(taskPath)) {
      return `Error: Task ${task_id} not found`;
    }
    const task = load_task(task_id);
    if (task.status !== "pending" || task.owner !== null) {
      return `Error: Task ${task_id} must be pending and unowned`;
    }
    if (task.worktree) {
      return `Error: Task ${task_id} already uses worktree '${task.worktree}'`;
    }
    if (list_tasks().some((item) => item.worktree === name && item.id !== task_id)) {
      return `Error: Worktree '${name}' is already bound to another task`;
    }
    if (existsSync(worktreePath)) {
      return `Error: Worktree path already exists: ${worktreePath}`;
    }
    const [okRoot, root] = run_git(["rev-parse", "--show-toplevel"]);
    if (!okRoot || resolvePath(root) !== resolvePath(WORKDIR)) {
      return "Error: Working directory must be the root of a Git repository";
    }
    const [okBranch, branch_check] = run_git(["check-ref-format", "--branch", branch]);
    if (!okBranch) {
      return `Error: Invalid worktree branch '${branch}': ${branch_check}`;
    }
    const [exists] = run_git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    if (exists) {
      return `Error: Branch '${branch}' already exists`;
    }
    let [entries, registry_error] = _registered_worktrees();
    if (registry_error) {
      return `Error: ${registry_error}`;
    }
    if (worktreePath in entries) {
      return `Error: Worktree path is already registered: ${worktreePath}`;
    }
    mkdirSync(WORKTREES_DIR, { recursive: true });
    const [ok, result] = run_git(["worktree", "add", "-b", branch, worktreePath, "HEAD"]);
    if (!ok) {
      [entries, registry_error] = _registered_worktrees();
      const [branch_exists] = run_git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
      const artifacts: string[] = [];
      if (existsSync(worktreePath)) artifacts.push(`checkout path '${worktreePath}'`);
      if (registry_error === null && worktreePath in entries) artifacts.push("registered Git worktree");
      if (branch_exists) artifacts.push(`branch '${branch}'`);
      if (artifacts.length) {
        return "Partial operation: git worktree add reported an error "
          + `after leaving ${artifacts.join(", ")}. Task ${task_id} `
          + "remains unbound and no Git data was deleted. Run "
          + `\`git worktree list\`, inspect '${worktreePath}' and '${branch}', `
          + "then keep or remove those artifacts manually after "
          + `preserving any work. Git error: ${result}`;
      }
      return `Git error: ${result}`;
    }
    try {
      task.worktree = name;
      save_task(task);
    } catch (exc) {
      return `Partial success: Worktree '${name}' was created at ${worktreePath} on branch '${branch}', but task binding failed: ${errorText(exc)}. Git data was retained for manual recovery.`;
    }
    return null;
  });
  if (early !== null) return early;
  console.log(`  \x1b[33m[worktree] created: ${name} at ${worktreePath}\x1b[0m`);
  return `Worktree '${name}' created at ${worktreePath} for task ${task_id}`;
}

/** Remove a registered checkout while always retaining its branch. */
export function remove_worktree(name: string, discard_changes = false): string {
  const error = validate_worktree_name(name);
  if (error) return `Error: ${error}`;
  const early = withLock(task_lock, () => {
    const [filePath, registeredError] = _registered_worktree(name);
    if (registeredError || !filePath) return `Error: ${registeredError}`;
    const bound = list_tasks().filter((task) => task.worktree === name);
    if (!bound.length) {
      return `Error: Worktree '${name}' is not bound to a task`;
    }
    const active = bound.filter((task) => task.status !== "completed");
    if (active.length) {
      return `Error: Worktree '${name}' is bound to active task ${active[0]!.id}; complete it before removal`;
    }
    const leased = Object.entries(teammate_assignments)
      .filter(([, assignment]) => resolvePath(String(assignment["cwd"])) === resolvePath(filePath))
      .map(([owner]) => owner)
      .sort();
    if (leased.length) {
      return `Error: Worktree '${name}' is still in use by ${leased.join(", ")}; wait for the turn to end`;
    }
    const [ok, status] = run_git(["status", "--porcelain", "--ignored"], filePath);
    if (!ok) {
      return `Error: Cannot verify worktree '${name}' status: ${status}`;
    }
    if (status !== "(no output)" && !discard_changes) {
      const changed = status.split(/\r?\n/).filter((line) => line.trim()).length;
      return `Error: Worktree '${name}' has ${changed} uncommitted change(s); preserve or discard them manually`;
    }
    const args = ["worktree", "remove"];
    if (discard_changes) args.push("--force");
    args.push(filePath);
    const [removed, result] = run_git(args);
    if (!removed) return `Git error: ${result}`;
    try {
      for (const task of bound) {
        task.worktree = null;
        save_task(task);
      }
    } catch (exc) {
      return `Partial success: Worktree '${name}' was removed and branch '${_worktree_branch(name)}' retained, but task unbinding failed: ${errorText(exc)}. Manual recovery is required.`;
    }
    return null;
  });
  if (early !== null) return early;
  console.log(`  [worktree] removed: ${name}; branch retained`);
  return `Worktree '${name}' removed; branch '${_worktree_branch(name)}' retained`;
}

// -- System Prompt --

export const ENVIRONMENT_PROMPT = process.platform === "win32"
  ? "Windows: the bash tool runs through cmd.exe; use cmd.exe syntax, not Unix Bash or PowerShell syntax, and prefer dedicated file tools for file operations"
  : "Unix-like: the bash tool runs the system shell";

export const PROMPT_SECTIONS = {
  identity: `You are a coding agent. Act, don't explain. Environment: ${ENVIRONMENT_PROMPT}.`,
  tools: "Available tools: bash, read_file, write_file, edit_file, glob, "
    + "create_task, update_task, list_tasks, get_task, claim_task, "
    + "complete_task, "
    + "spawn_teammate, list_teammates, send_message, request_shutdown, "
    + "request_plan, review_plan, create_worktree.",
  tasks: "Create all task nodes first. Only after create_task returns "
    + "runtime-generated IDs, use update_task with those exact IDs to add "
    + "dependencies. Only the Lead changes task dependencies.",
  teams: "When parallel work would help, first propose a small team with clear "
    + "responsibilities and wait for the user's confirmation. Do not call "
    + "spawn_teammate before the user confirms. After confirmation, delegate "
    + "independent work by creating a Task for each parallel change. Pass "
    + "task_id to spawn_teammate when assigning ready work, then "
    + "create a task-bound worktree only when a separate working directory "
    + "would prevent conflicting edits. A teammate must complete its current "
    + "Task before claiming another. A worktree changes tool default cwd "
    + "only; it is not a sandbox. Worktree removal stays with the host or "
    + "user. After spawning a teammate, end the current turn instead of "
    + "polling its status; the runtime will deliver team events and wake the "
    + "Lead. React to those events, and shut teammates down when "
    + "coordination is complete.",
  workspace: `Working directory: ${WORKDIR}`,
};

export const SYSTEM = Object.values(PROMPT_SECTIONS).join("\n\n");

// -- Base Tools --

export function safe_path(p: string, cwd: string | null = null): string {
  const base = resolvePath(cwd || WORKDIR);
  const resolved = resolvePath(path.resolve(base, p));
  if (!isRelativeTo(resolved, base)) {
    throw new ValueError(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

export function run_bash(command: string, cwd: string | null = null): string {
  const result = spawnSync(command, {
    shell: true,
    cwd: cwd || WORKDIR,
    encoding: "utf-8",
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) {
    const err = result.error as NodeJS.ErrnoException;
    if (err.code === "ETIMEDOUT") return "Error: Timeout (120s)";
    return `Error: ${spawnErrorName(err)}: ${err.message}`;
  }
  const stdout = typeof result.stdout === "string" ? universalNewlines(result.stdout) : "";
  const stderr = typeof result.stderr === "string" ? universalNewlines(result.stderr) : "";
  const raw = (stdout + stderr).trim();
  const output = raw ? raw.slice(0, 50000) : "(no output)";
  if (result.status !== 0) {
    const code = result.status === null ? result.signal : result.status;
    return `Error: command exited with status ${code}\n${output}`;
  }
  return output;
}

export function run_read(filePath: string, limit: number | null = null, cwd: string | null = null): string {
  try {
    let lines = splitlines(readText(safe_path(filePath, cwd)));
    if (limit && limit < lines.length) {
      const hidden = lines.length - limit;
      lines = lines.slice(0, limit).concat([`... (${hidden} more lines)`]);
    }
    return lines.join("\n");
  } catch (exc) {
    return `Error: ${errorText(exc)}`;
  }
}

export function run_write(filePath: string, content: string, cwd: string | null = null): string {
  try {
    const fp = safe_path(filePath, cwd);
    mkdirSync(path.dirname(fp), { recursive: true });
    writeFileSync(fp, content, "utf-8");
    return `Wrote ${pyLen(content)} bytes to ${filePath}`;
  } catch (exc) {
    return `Error: ${errorText(exc)}`;
  }
}

export function run_edit(
  filePath: string,
  old_text: string,
  new_text: string,
  cwd: string | null = null,
): string {
  try {
    const target = safe_path(filePath, cwd);
    const content = readText(target);
    const count = pyCount(content, old_text);
    if (count !== 1) {
      return `Error: Expected 1 occurrence, found ${count}`;
    }
    writeFileSync(target, content.split(old_text).join(new_text), "utf-8");
    return `Edited ${filePath}`;
  } catch (exc) {
    return `Error: ${errorText(exc)}`;
  }
}

function fnmatchToRegExp(pat: string, caseSensitive: boolean): RegExp {
  let body = "";
  let index = 0;
  while (index < pat.length) {
    const ch = pat[index]!;
    if (ch === "*") {
      body += "[^\\n]*";
      index += 1;
      continue;
    }
    if (ch === "?") {
      body += "[^\\n]";
      index += 1;
      continue;
    }
    if (ch === "[") {
      let end = index + 1;
      if (end < pat.length && pat[end] === "!") end += 1;
      if (end < pat.length && pat[end] === "]") end += 1;
      while (end < pat.length && pat[end] !== "]") end += 1;
      if (end >= pat.length) {
        body += "\\[";
        index += 1;
        continue;
      }
      let stuff = pat.slice(index + 1, end);
      if (stuff.startsWith("!")) stuff = `^${stuff.slice(1)}`;
      stuff = stuff.replace(/\\/g, "\\\\");
      body += `[${stuff}]`;
      index = end + 1;
      continue;
    }
    body += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    index += 1;
  }
  return new RegExp(`^${body}$`, caseSensitive ? "" : "i");
}

interface GlobSelector {
  selectFrom(parent: string): string[];
  selectInner(parent: string): string[];
}

function makeGlobSelector(parts: string[]): GlobSelector {
  if (parts.length === 0 || parts[0] === "") {
    return {
      selectFrom: (parent) => [parent],
      selectInner: (parent) => [parent],
    };
  }
  const pat = parts[0]!;
  if (pat === "**") {
    let index = 1;
    while (index < parts.length && parts[index] === "**") index += 1;
    const child = parts.slice(index);
    const successor = makeGlobSelector(child);
    const dedupe = child.includes("**");
    const selectInner = (parent: string) => {
      const yielded = new Set<string>();
      const out: string[] = [];
      for (const start of iterateDirectories(parent)) {
        for (const match of successor.selectInner(start)) {
          if (dedupe) {
            if (yielded.has(match)) continue;
            yielded.add(match);
          }
          out.push(match);
        }
      }
      return out;
    };
    return {
      selectFrom(parent) {
        if (!isDir(parent)) return [];
        return selectInner(parent);
      },
      selectInner,
    };
  }
  if (pat.includes("**")) {
    throw new ValueError("Invalid pattern: '**' can only be an entire path component");
  }
  const child = parts.slice(1);
  const successor = makeGlobSelector(child);
  const dironly = child.length > 0;
  const match = fnmatchToRegExp(pat, process.platform !== "win32");
  if (pat === "..") {
    const selectInner = (parent: string) => successor.selectInner(path.resolve(parent, ".."));
    return {
      selectFrom(parent) {
        if (!isDir(parent)) return [];
        return selectInner(parent);
      },
      selectInner,
    };
  }
  const selectInner = (parent: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(parent, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const entry of entries) {
      const childPath = path.join(parent, entry.name);
      if (dironly) {
        let directory = false;
        try {
          directory = entry.isDirectory() || (entry.isSymbolicLink() && statSync(childPath).isDirectory());
        } catch {
          continue;
        }
        if (!directory) continue;
      }
      if (!match.test(entry.name)) continue;
      out.push(...successor.selectInner(childPath));
    }
    return out;
  };
  return {
    selectFrom(parent) {
      if (!isDir(parent)) return [];
      return selectInner(parent);
    },
    selectInner,
  };
}

function iterateDirectories(parent: string): string[] {
  const out = [parent];
  const stack = [parent];
  while (stack.length) {
    const current = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = path.join(current, entry.name);
      out.push(child);
      stack.push(child);
    }
  }
  return out;
}

function pathlibGlob(base: string, pattern: string): string[] {
  if (!pattern) {
    throw new ValueError(`Unacceptable pattern: ${pyRepr(pattern)}`);
  }
  if (path.isAbsolute(pattern)) {
    const error = new Error("Non-relative patterns are unsupported");
    error.name = "NotImplementedError";
    throw error;
  }
  const parts = pattern.split(/[\\/]/);
  if (pattern.endsWith("/") || pattern.endsWith("\\")) parts.push("");
  return makeGlobSelector(parts).selectFrom(base);
}

function comparePathParts(left: string, right: string): number {
  const a = left.split(path.sep);
  const b = right.split(path.sep);
  const count = Math.min(a.length, b.length);
  for (let index = 0; index < count; index += 1) {
    if (a[index]! < b[index]!) return -1;
    if (a[index]! > b[index]!) return 1;
  }
  return a.length - b.length;
}

export function run_glob(pattern: string, cwd: string | null = null): string {
  try {
    const base = resolvePath(cwd || WORKDIR);
    const matches = pathlibGlob(base, pattern)
      .filter((match) => {
        try {
          return isRelativeTo(resolvePath(match), base);
        } catch {
          return false;
        }
      })
      .sort(comparePathParts)
      .map((match) => {
        const relative = path.relative(base, match);
        return relative === "" ? "." : relative;
      });
    const shown = matches.slice(0, 200);
    if (matches.length > 200) {
      shown.push("... (more matches omitted; narrow the pattern)");
    }
    return shown.join("\n") || "No files found";
  } catch (exc) {
    return `Error: ${errorText(exc)}`;
  }
}

export function _agent_cwd(): [string | null, string | null] {
  try {
    return [assignment_cwd("agent"), null];
  } catch (exc) {
    if (exc instanceof ValueError || isEnoent(exc)) {
      return [null, `Error: Invalid task assignment: ${errorText(exc)}`];
    }
    throw exc;
  }
}

export function run_agent_bash(command: string): string {
  const [cwd, error] = _agent_cwd();
  return error || run_bash(command, cwd);
}

export function run_agent_read(filePath: string, limit: number | null = null): string {
  const [cwd, error] = _agent_cwd();
  return error || run_read(filePath, limit, cwd);
}

export function run_agent_write(filePath: string, content: string): string {
  const [cwd, error] = _agent_cwd();
  return error || run_write(filePath, content, cwd);
}

export function run_agent_edit(filePath: string, old_text: string, new_text: string): string {
  const [cwd, error] = _agent_cwd();
  return error || run_edit(filePath, old_text, new_text, cwd);
}

export function run_agent_glob(pattern: string): string {
  const [cwd, error] = _agent_cwd();
  return error || run_glob(pattern, cwd);
}

// -- Task Tools --

export function run_create_task(subject: string, description = ""): string {
  const task = create_task(subject, description);
  console.log(`  \x1b[34m[create] ${task.subject}\x1b[0m`);
  return `Created ${task.id}: ${task.subject}`;
}

export function run_update_task(task_id: string, addBlockedBy: string[]): string {
  try {
    const task = update_task(task_id, addBlockedBy);
    const dependencies = task.blockedBy.join(", ") || "(none)";
    console.log(`  \x1b[34m[update] ${task.subject} blockedBy: ${dependencies}\x1b[0m`);
    return `Updated ${task.id} blockedBy: ${dependencies}`;
  } catch (exc) {
    if (exc instanceof ValueError) return `Error: ${errorText(exc)}`;
    if (isEnoent(exc)) return `Error: Task ${task_id} not found`;
    throw exc;
  }
}

export function run_list_tasks(): string {
  const tasks = list_tasks();
  if (!tasks.length) return "No tasks. Use create_task to add some.";
  const lines: string[] = [];
  for (const task of tasks) {
    const icon = ({ pending: "[ ]", in_progress: "[~]", completed: "[x]" } as Record<string, string>)[task.status] ?? "[?]";
    const deps = task.blockedBy.length ? ` (blockedBy: ${task.blockedBy.join(", ")})` : "";
    const owner = task.owner ? ` [${task.owner}]` : "";
    const worktree = task.worktree ? ` (worktree: ${task.worktree})` : "";
    lines.push(`  ${icon} ${task.id}: ${task.subject} [${task.status}]${owner}${deps}${worktree}`);
  }
  return lines.join("\n");
}

export function run_get_task(task_id: string): string {
  try {
    return get_task(task_id);
  } catch (exc) {
    if (exc instanceof ValueError) return `Error: ${errorText(exc)}`;
    if (isEnoent(exc)) return `Error: Task ${task_id} not found`;
    throw exc;
  }
}

export function run_claim_task(task_id: string): string {
  try {
    return claim_task(task_id, "agent");
  } catch (exc) {
    if (exc instanceof ValueError) return `Error: ${errorText(exc)}`;
    if (isEnoent(exc)) return `Error: Task ${task_id} not found`;
    throw exc;
  }
}

export function run_complete_task(task_id: string): string {
  try {
    return complete_task(task_id, "agent");
  } catch (exc) {
    if (exc instanceof ValueError) return `Error: ${errorText(exc)}`;
    if (isEnoent(exc)) return `Error: Task ${task_id} not found`;
    throw exc;
  }
}

// -- MessageBus and Team Protocols --

export const MAILBOX_DIR = path.join(WORKDIR, ".mailboxes");
export const MAILBOX_ROOT = resolvePath(MAILBOX_DIR);
export const VALID_AGENT_NAME = /^[A-Za-z0-9_-]{1,64}$/;
export const RESERVED_TEAMMATE_NAMES = new Set(["lead", "agent"]);

export function is_valid_agent_name(name: string): boolean {
  return VALID_AGENT_NAME.test(name);
}

function monotonic(): number {
  return performance.now() / 1000;
}

/** Thread-safe file mailboxes with destructive reads. */
export class MessageBus {
  private _waiters: Array<() => void> = [];

  _path(agent: string): string {
    if (!is_valid_agent_name(agent)) {
      throw new ValueError(`Invalid mailbox recipient: ${pyRepr(agent)}`);
    }
    const filePath = resolvePath(path.join(MAILBOX_DIR, `${agent}.jsonl`));
    if (!isRelativeTo(filePath, MAILBOX_ROOT)) {
      throw new ValueError(`Mailbox path escapes directory: ${pyRepr(agent)}`);
    }
    return filePath;
  }

  _read_unlocked(agent: string): any[] {
    const inbox = this._path(agent);
    if (!existsSync(inbox)) return [];
    const msgs = splitlines(readText(inbox))
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
    unlinkSync(inbox);
    return msgs;
  }

  send(
    from_agent: string,
    to_agent: string,
    content: string,
    msg_type = "message",
    metadata: Record<string, any> | null = null,
  ): void {
    const msg = {
      from: from_agent,
      to: to_agent,
      content,
      type: msg_type,
      ts: Date.now() / 1000,
      metadata: metadata ?? {},
    };
    mkdirSync(MAILBOX_DIR, { recursive: true });
    appendFileSync(this._path(to_agent), `${jsonDumps(msg)}\n`, "utf-8");
    this._notifyAll();
    console.log(`  [bus] ${from_agent} -> ${to_agent}: (${msg_type}) ${content.slice(0, 50)}`);
  }

  read_inbox(agent: string): any[] {
    return this._read_unlocked(agent);
  }

  peek(agent: string): boolean {
    const inbox = this._path(agent);
    return existsSync(inbox) && statSync(inbox).size > 0;
  }

  /** Block until the agent has messages or timeout expires. */
  async wait_for_messages(agent: string, timeout: number | null = null): Promise<any[]> {
    const deadline = timeout === null ? null : monotonic() + timeout;
    while (!this.peek(agent)) {
      const remaining = deadline === null ? null : deadline - monotonic();
      if (remaining !== null && remaining <= 0) return [];
      await this._wait(remaining);
    }
    return this._read_unlocked(agent);
  }

  private _wait(seconds: number | null): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this._waiters = this._waiters.filter((waiter) => waiter !== finish);
        resolve();
      };
      const timer = seconds === null
        ? null
        : setTimeout(finish, Math.max(0, seconds * 1000));
      timer?.unref?.();
      this._waiters.push(finish);
    });
  }

  private _notifyAll(): void {
    const waiters = this._waiters;
    this._waiters = [];
    for (const waiter of waiters) waiter();
  }
}

export const BUS = new MessageBus();

// working | waiting_approval | idle | stopping
export const active_teammates: Record<string, string> = {};

export class ProtocolState {
  request_id: string;
  type: string;
  sender: string;
  target: string;
  status: string;
  payload: string;
  work_version: number | null;
  task_id: string | null;
  created_at: number;

  constructor(fields: {
    request_id: string;
    type: string;
    sender: string;
    target: string;
    status: string;
    payload: string;
    work_version?: number | null;
    task_id?: string | null;
    created_at?: number;
  }) {
    this.request_id = fields.request_id;
    this.type = fields.type;
    this.sender = fields.sender;
    this.target = fields.target;
    this.status = fields.status;
    this.payload = fields.payload;
    this.work_version = fields.work_version ?? null;
    this.task_id = fields.task_id ?? null;
    this.created_at = fields.created_at ?? Date.now() / 1000;
  }

  asdict(): Record<string, any> {
    return {
      request_id: this.request_id,
      type: this.type,
      sender: this.sender,
      target: this.target,
      status: this.status,
      payload: this.payload,
      work_version: this.work_version,
      task_id: this.task_id,
      created_at: this.created_at,
    };
  }
}

export const pending_requests: Record<string, ProtocolState> = {};

export function new_request_id(): string {
  while (true) {
    const request_id = `req_${String(randomInt(0, 1_000_000)).padStart(6, "0")}`;
    if (!(request_id in pending_requests)) return request_id;
  }
}

/** Match one protocol response to one pending request. */
export function match_response(
  response_type: string,
  request_id: string,
  approve: boolean,
  from_agent: string,
  to_agent: string,
): boolean {
  let status = "";
  const matched = withLock(team_lock, () => {
    const state = pending_requests[request_id];
    if (!state) {
      console.log(`  [protocol] unknown request_id: ${request_id}`);
      return false;
    }
    const expected = ({
      shutdown: "shutdown_response",
      plan_approval: "plan_approval_response",
    } as Record<string, string>)[state.type];
    if (expected === undefined) {
      const error = new Error(state.type);
      error.name = "KeyError";
      throw error;
    }
    if (response_type !== expected) {
      console.log(`  [protocol] expected ${expected}, got ${response_type}`);
      return false;
    }
    if (from_agent !== state.target || to_agent !== state.sender) {
      console.log(`  [protocol] ${request_id} responder mismatch`);
      return false;
    }
    if (state.status !== "pending") {
      console.log(`  [protocol] ${request_id} already ${state.status}`);
      return false;
    }
    state.status = approve ? "approved" : "rejected";
    status = state.status;
    return true;
  });
  if (!matched) return false;
  console.log(`  [protocol] ${request_id} -> ${status}`);
  return true;
}

/** Consume Lead events and update protocol state before model delivery. */
export function consume_lead_inbox(): any[] {
  const msgs = BUS.read_inbox("lead");
  for (const msg of msgs) {
    const metadata = msg?.metadata ?? {};
    const request_id = metadata.request_id ?? "";
    if (request_id && String(msg?.type ?? "").endsWith("_response")) {
      match_response(
        msg.type,
        request_id,
        metadata.approve ?? false,
        msg.from ?? "",
        msg.to ?? "",
      );
    }
  }
  return msgs;
}

export function format_team_events(msgs: any[]): string {
  const lines: string[] = [];
  for (const msg of msgs) {
    const metadata = msg.metadata ?? {};
    const request_id = metadata.request_id;
    const suffix = request_id ? ` request_id=${request_id}` : "";
    lines.push(`[${msg.type}${suffix}] ${msg.from}: ${msg.content}`);
  }
  return `[Team events]\n${lines.join("\n")}`;
}

export function _last_assistant_text(content: any): string {
  for (const block of content) {
    if (block && typeof block === "object" && block.type === "text"
        && typeof block.text === "string" && !isPlainObject(block)) {
      return block.text.trim();
    }
    if (isPlainObject(block) && block.type === "text") {
      return String(block.text ?? "").trim();
    }
  }
  return "";
}

export function current_work_identity(owner: string): [number, string | null] {
  return withLock(task_lock, () => {
    const assignment = teammate_assignments[owner];
    const task_id = assignment ? String(assignment["task_id"]) : null;
    return [assignment_versions[owner] ?? 0, task_id];
  });
}

export function _teammate_submit_plan(from_name: string, plan: string): string {
  let request_id = "";
  let waiting = false;
  withLock(task_lock, () => {
    const assignment = teammate_assignments[from_name];
    const task_id = assignment ? String(assignment["task_id"]) : null;
    const work_version = assignment_versions[from_name] ?? 0;
    withLock(team_lock, () => {
      if (plan_gates[from_name] === "pending") {
        waiting = true;
        return;
      }
      request_id = new_request_id();
      pending_requests[request_id] = new ProtocolState({
        request_id,
        type: "plan_approval",
        sender: from_name,
        target: "lead",
        status: "pending",
        payload: plan,
        work_version,
        task_id,
      });
      plan_gates[from_name] = "pending";
      plan_request_ids[from_name] = request_id;
      active_teammates[from_name] = "waiting_approval";
    });
  });
  if (waiting) return "A plan is already waiting for review.";
  BUS.send(from_name, "lead", plan, "plan_approval_request", { request_id });
  return `Plan submitted (${request_id}). Wait for Lead's decision.`;
}

export async function _run_teammate_tool(
  name: string,
  block: any,
  handlers: Record<string, (input: any) => any>,
): Promise<string> {
  const gate = plan_gates[name] ?? "not_required";
  if (["bash", "write_file", "edit_file"].includes(block.name)) {
    if (gate !== "approved") {
      if (gate !== "not_required") {
        return `Blocked: plan status is ${gate}. Submit or revise the plan and wait for approval before changing the workspace.`;
      }
    }
    const blocked = await check_permission(block, false);
    if (blocked) return blocked;
  }
  const handler = handlers[block.name];
  if (!handler) return `Unknown tool: ${block.name}`;
  await trigger_hooks("PreToolUse", block, undefined, true);
  let output: string;
  try {
    output = String(handler(block.input));
  } catch (exc) {
    output = `Error: ${errorName(exc)}: ${errorText(exc)}`;
  }
  await trigger_hooks("PostToolUse", block, output);
  return output;
}

/** Apply only the Lead response for this teammate's current plan. */
export function apply_plan_response(name: string, msg: any): [boolean, string] {
  const metadata = msg.metadata ?? {};
  const request_id = metadata.request_id ?? "";
  const [work_version, task_id] = current_work_identity(name);
  let outcome = "";
  const valid = withLock(team_lock, () => {
    const state = pending_requests[request_id];
    const expected_id = plan_request_ids[name];
    const ok = msg.from === "lead"
      && msg.to === name
      && request_id === expected_id
      && state != null
      && state.type === "plan_approval"
      && state.sender === name
      && state.target === "lead"
      && state.work_version === work_version
      && state.task_id === task_id
      && ["approved", "rejected"].includes(state.status)
      && (metadata.approve ?? false) === (state.status === "approved");
    if (!ok || !state) return false;
    plan_gates[name] = state.status;
    active_teammates[name] = "working";
    delete plan_request_ids[name];
    outcome = state.status;
    return true;
  });
  if (!valid) return [false, "[Ignored plan response: request mismatch]"];
  return [true, `[Plan ${outcome}] ${msg.content}`];
}

/** Accept only a pending shutdown request sent by Lead to this teammate. */
export function apply_shutdown_request(name: string, msg: any): [boolean, string] {
  const request_id = msg.metadata?.request_id ?? "";
  const valid = withLock(team_lock, () => {
    const state = pending_requests[request_id];
    const ok = msg.from === "lead"
      && msg.to === name
      && state != null
      && state.type === "shutdown"
      && state.sender === "lead"
      && state.target === name
      && state.status === "pending"
      && active_teammates[name] !== "stopping";
    if (!ok) return false;
    active_teammates[name] = "stopping";
    return true;
  });
  if (!valid) return [false, "[Ignored shutdown request: request mismatch]"];
  return [true, request_id];
}

export function _teammate_send_message(from_name: string, to: string, content: string): string {
  const inactive = withLock(team_lock, () => to !== "lead" && !(to in active_teammates));
  if (inactive) return `Agent '${to}' is not active`;
  BUS.send(from_name, to, content);
  return `Sent to ${to}`;
}

// -- Idle Task Discovery --

export const IDLE_SCAN_INTERVAL = 2.0;

/** Return ready tasks whose optional worktree binding is usable. */
export function scan_unclaimed_tasks(): Task[] {
  return withLock(task_lock, () => {
    const ready: Task[] = [];
    for (const task of list_tasks()) {
      if (task.status !== "pending" || task.owner !== null || !can_start(task.id)) continue;
      const [, error] = task_worktree_cwd(task);
      if (!error) ready.push(task);
    }
    return ready;
  });
}

/** Claim the first still-available task, never a second assignment. */
export function claim_next_task(name: string): Task | null {
  const busy = withLock(task_lock, () => Boolean(teammate_assignments[name] || _owner_in_progress(name)));
  if (busy) return null;
  for (const task of scan_unclaimed_tasks()) {
    const result = claim_task(task.id, name);
    if (result.startsWith("Claimed ")) return load_task(task.id);
  }
  return null;
}

// -- Teammate Runtime --

/** One persistent teammate with separate messages and WORK/IDLE phases. */
export class TeammateRuntime {
  name: string;
  system: string;
  messages: any[];
  handlers: Record<string, (input: any) => any>;

  constructor(name: string, role: string, prompt: string, task_id: string | null, require_plan: boolean) {
    this.name = name;
    this.system = `You are '${name}', a ${role}. Use tools to complete the assigned `
      + "Task, then call complete_task and report a concise result. "
      + "If the first user message contains [Assigned task], that Task is "
      + "already claimed; do not call claim_task for it again. "
      + "When asked for a plan, call submit_plan and wait for approval "
      + "before bash or file changes. File and shell tools use the Task's "
      + "working directory; that directory is not a sandbox. The runtime "
      + "delivers your final text to Lead. Use send_message only for "
      + "intermediate coordination, and address the coordinator as 'lead'.";
    this.messages = [{ role: "user", content: prompt }];
    if (task_id) {
      const task = load_task(task_id);
      const cwd = assignment_cwd(name);
      this.messages[0].content += `\n\n[Assigned task ${task.id}] ${task.subject}\n${task.description}\nWork directory: ${cwd}`;
    }
    if (require_plan) {
      this.messages[0].content += "\n\n[Plan required] Submit a plan and wait for Lead approval before changing files or using bash.";
    }
    this.handlers = {
      bash: (input) => this.bash(input.command),
      read_file: (input) => this.read(input.path, input.limit ?? null),
      write_file: (input) => this.write(input.path, input.content),
      edit_file: (input) => this.edit(input.path, input.old_text, input.new_text),
      glob: (input) => this.glob(input.pattern),
      send_message: (input) => _teammate_send_message(name, input.to, input.content),
      submit_plan: (input) => _teammate_submit_plan(name, input.plan),
      list_tasks: () => run_list_tasks(),
      claim_task: (input) => this.claim(input.task_id),
      complete_task: (input) => this.complete(input.task_id),
    };
  }

  current_cwd(): [string | null, string | null] {
    if (!(this.name in teammate_assignments)) {
      return [null, "Error: Claim a Task before using workspace tools."];
    }
    try {
      return [assignment_cwd(this.name), null];
    } catch (exc) {
      if (exc instanceof ValueError || isEnoent(exc)) {
        return [null, `Error: Invalid task assignment: ${errorText(exc)}`];
      }
      throw exc;
    }
  }

  bash(command: string): string {
    const [cwd, error] = this.current_cwd();
    return error || run_bash(command, cwd);
  }

  read(filePath: string, limit: number | null = null): string {
    const [cwd, error] = this.current_cwd();
    return error || run_read(filePath, limit, cwd);
  }

  write(filePath: string, content: string): string {
    const [cwd, error] = this.current_cwd();
    return error || run_write(filePath, content, cwd);
  }

  edit(filePath: string, old_text: string, new_text: string): string {
    const [cwd, error] = this.current_cwd();
    return error || run_edit(filePath, old_text, new_text, cwd);
  }

  glob(pattern: string): string {
    const [cwd, error] = this.current_cwd();
    return error || run_glob(pattern, cwd);
  }

  claim(task_id: string): string {
    try {
      return claim_task(task_id, this.name);
    } catch (exc) {
      if (exc instanceof ValueError) return `Error: ${errorText(exc)}`;
      if (isEnoent(exc)) return `Error: Task ${task_id} not found`;
      throw exc;
    }
  }

  complete(task_id: string): string {
    try {
      return complete_task(task_id, this.name);
    } catch (exc) {
      if (exc instanceof ValueError) return `Error: ${errorText(exc)}`;
      if (isEnoent(exc)) return `Error: Task ${task_id} not found`;
      throw exc;
    }
  }

  /** Append work messages and return True for a valid shutdown. */
  handle_inbox(inbox: any[]): boolean {
    const work_messages: string[] = [];
    for (const msg of inbox) {
      const msg_type = msg.type ?? "message";
      if (msg_type === "shutdown_request") {
        const [accepted, notice] = apply_shutdown_request(this.name, msg);
        if (!accepted) {
          work_messages.push(notice);
          continue;
        }
        BUS.send(this.name, "lead", "Shutdown acknowledged.", "shutdown_response", {
          request_id: notice,
          approve: true,
        });
        return true;
      }
      if (msg_type === "plan_approval_response") {
        const [, notice] = apply_plan_response(this.name, msg);
        work_messages.push(notice);
        continue;
      }
      if (msg_type === "plan_request") {
        work_messages.push(`[Plan required] ${msg.content}`);
        continue;
      }
      work_messages.push(`[Message from ${msg.from}] ${msg.content}`);
    }
    if (work_messages.length) {
      this.messages.push({ role: "user", content: work_messages.join("\n") });
    }
    return false;
  }

  /** Run one model turn. Return continue, idle, or stop. */
  async work(): Promise<string> {
    if (this.handle_inbox(BUS.read_inbox(this.name))) return "stop";
    withLock(team_lock, () => {
      active_teammates[this.name] = "working";
    });
    let response: any;
    try {
      response = await client.messages.create({
        model: MODEL,
        system: this.system,
        messages: this.messages,
        tools: TEAMMATE_TOOLS as any,
        max_tokens: 8000,
      });
    } catch (exc) {
      BUS.send(this.name, "lead", `${errorName(exc)}: ${errorText(exc)}`, "error");
      return "stop";
    }
    this.messages.push({ role: "assistant", content: response.content });
    const tool_calls: any[] = (response.content as any[]).filter((block: any) => block.type === "tool_use");
    if (tool_calls.length) {
      const results: any[] = [];
      for (const block of tool_calls) {
        const output = await _run_teammate_tool(this.name, block, this.handlers);
        results.push({ type: "tool_result", tool_use_id: block.id, content: output });
      }
      this.messages.push({ role: "user", content: results });
      return "continue";
    }
    const summary = _last_assistant_text(response.content);
    const gate = plan_gates[this.name] ?? "not_required";
    if (gate !== "pending" && summary) {
      BUS.send(this.name, "lead", summary, "result");
    }
    if (gate === "pending") {
      withLock(team_lock, () => {
        active_teammates[this.name] = "waiting_approval";
      });
    } else {
      release_completed_assignment(this.name);
      withLock(team_lock, () => {
        active_teammates[this.name] = "idle";
      });
      BUS.send(this.name, "lead", "Waiting for more work.", "idle_notification");
    }
    return "idle";
  }

  /** Wait for a message or atomically claim the next ready Task. */
  async wait_for_work(): Promise<boolean> {
    while (true) {
      const inbox = await BUS.wait_for_messages(this.name, IDLE_SCAN_INTERVAL);
      if (inbox.length) {
        const before = this.messages.length;
        if (this.handle_inbox(inbox)) return false;
        if (this.messages.length > before) return true;
        continue;
      }
      const task = claim_next_task(this.name);
      if (!task) continue;
      const cwd = assignment_cwd(this.name);
      this.messages.push({
        role: "user",
        content: `[Auto-claimed task ${task.id}] ${task.subject}\n${task.description}\nWork directory: ${cwd}`,
      });
      console.log(`  [idle] ${this.name} claimed ${task.id}: ${task.subject}`);
      return true;
    }
  }

  async run(): Promise<void> {
    try {
      let state = "continue";
      while (state !== "stop") {
        if (state === "idle" && !(await this.wait_for_work())) break;
        state = await this.work();
      }
    } catch (exc) {
      try {
        BUS.send(this.name, "lead", `${errorName(exc)}: ${errorText(exc)}`, "error");
      } catch {
        // The lead mailbox may already be unusable.
      }
    } finally {
      try {
        release_teammate_assignment(this.name);
      } catch (exc) {
        try {
          BUS.send(
            this.name,
            "lead",
            `Assignment cleanup failed: ${errorName(exc)}: ${errorText(exc)}`,
            "error",
          );
        } catch {
          // Ignore a second failure while reporting cleanup.
        }
      }
      withLock(team_lock, () => {
        delete active_teammates[this.name];
        delete plan_gates[this.name];
        delete plan_request_ids[this.name];
        delete teammate_threads[this.name];
      });
      console.log(`  [teammate] ${this.name} finished`);
    }
  }
}

export const teammate_threads: Record<string, Promise<void>> = {};

/** Claim an initial Task, then start one persistent teammate. */
export function spawn_teammate_thread(
  name: string,
  role: string,
  prompt: string,
  task_id: string | null = null,
  require_plan = false,
): string {
  if (!is_valid_agent_name(name)) {
    return "Invalid teammate name: use 1-64 letters, digits, underscores, or dashes";
  }
  if (RESERVED_TEAMMATE_NAMES.has(name.toLowerCase())) {
    return `Invalid teammate name: '${name}' is reserved by the runtime`;
  }
  const duplicate = withLock(team_lock, () => {
    if (Object.keys(active_teammates).some((existing) => existing.toLowerCase() === name.toLowerCase())) {
      return `Teammate '${name}' already exists`;
    }
    active_teammates[name] = "working";
    plan_gates[name] = require_plan ? "required" : "not_required";
    assignment_versions[name] = 0;
    return null;
  });
  if (duplicate) return duplicate;
  if (task_id) {
    let claimed: string;
    try {
      claimed = claim_task(task_id, name);
    } catch (exc) {
      if (exc instanceof ValueError || isEnoent(exc)) claimed = `Error: ${errorText(exc)}`;
      else throw exc;
    }
    if (!claimed.startsWith("Claimed ")) {
      withLock(team_lock, () => {
        delete active_teammates[name];
        delete plan_gates[name];
        delete assignment_versions[name];
      });
      return `Cannot spawn teammate '${name}': ${claimed}`;
    }
  }
  const runtime = new TeammateRuntime(name, role, prompt, task_id, require_plan);
  const running = runtime.run();
  withLock(team_lock, () => {
    teammate_threads[name] = running;
  });
  console.log(`  [teammate] ${name} spawned as ${role}`);
  const assigned = task_id ? ` for ${task_id}` : " without an initial Task";
  return `Teammate '${name}' spawned as ${role}${assigned}. End this turn; the runtime will deliver its events.`;
}

// -- Lead Team Tools --

export function run_spawn_teammate(
  name: string,
  role: string,
  prompt: string,
  task_id: string | null = null,
  require_plan = false,
): string {
  return spawn_teammate_thread(name, role, prompt, task_id, require_plan);
}

export function run_list_teammates(): string {
  return withLock(team_lock, () => {
    const names = Object.keys(active_teammates).sort();
    if (!names.length) return "No active teammates.";
    return names.map((name) => `${name}: ${active_teammates[name]}`).join("\n");
  });
}

export function run_send_message(to: string, content: string): string {
  if (!(to in active_teammates)) return `Teammate '${to}' is not active`;
  BUS.send("lead", to, content);
  return `Sent to ${to}`;
}

export function run_request_shutdown(teammate: string): string {
  if (!(teammate in active_teammates)) return `Teammate '${teammate}' is not active`;
  const request_id = withLock(team_lock, () => {
    const id = new_request_id();
    pending_requests[id] = new ProtocolState({
      request_id: id,
      type: "shutdown",
      sender: "lead",
      target: teammate,
      status: "pending",
      payload: "",
    });
    return id;
  });
  BUS.send("lead", teammate, "Finish the current step and shut down.", "shutdown_request", { request_id });
  return `Shutdown requested from ${teammate} (${request_id})`;
}

export function run_request_plan(teammate: string, task: string): string {
  if (!(teammate in active_teammates)) return `Teammate '${teammate}' is not active`;
  withLock(team_lock, () => {
    plan_gates[teammate] = "required";
  });
  BUS.send("lead", teammate, task, "plan_request");
  return `Plan requested from ${teammate}`;
}

export function run_review_plan(request_id: string, approve: boolean, feedback = ""): string {
  let state = pending_requests[request_id];
  if (!state) return `Request ${request_id} not found`;
  const [work_version, task_id] = current_work_identity(state.sender);
  const early = withLock(team_lock, () => {
    state = pending_requests[request_id]!;
    if (!state) return `Request ${request_id} not found`;
    if (state.type !== "plan_approval") return `Request ${request_id} is not a plan`;
    if (state.status !== "pending") return `Request ${request_id} already ${state.status}`;
    if (state.work_version !== work_version || state.task_id !== task_id) {
      return `Request ${request_id} belongs to an earlier assignment`;
    }
    if (plan_request_ids[state.sender] !== request_id) {
      return `Request ${request_id} is not the current plan`;
    }
    state.status = approve ? "approved" : "rejected";
    return null;
  });
  if (early !== null) return early;
  const content = feedback || (approve ? "Plan approved." : "Revise the plan and submit it again.");
  BUS.send("lead", state.sender, content, "plan_approval_response", { request_id, approve });
  return `Plan ${state.status} (${request_id})`;
}

export function run_create_worktree(name: string, task_id: string): string {
  return create_worktree(name, task_id);
}

// -- Tool Definitions --

export const BASE_TOOLS = [
  {"name": "bash", "description": "Run a shell command.",
   "input_schema": {"type": "object",
                    "properties": {"command": {"type": "string"}},
                    "required": ["command"]}},
  {"name": "read_file", "description": "Read file contents.",
   "input_schema": {"type": "object",
                    "properties": {"path": {"type": "string"},
                                   "limit": {"type": "integer"}},
                    "required": ["path"]}},
  {"name": "write_file", "description": "Write content to a file.",
   "input_schema": {"type": "object",
                    "properties": {"path": {"type": "string"},
                                   "content": {"type": "string"}},
                    "required": ["path", "content"]}},
  {"name": "edit_file", "description": "Replace exact text once.",
   "input_schema": {"type": "object",
                    "properties": {"path": {"type": "string"},
                                   "old_text": {"type": "string"},
                                   "new_text": {"type": "string"}},
                    "required": ["path", "old_text", "new_text"]}},
  {"name": "glob", "description": "Find files by glob pattern; ** matches recursively.",
   "input_schema": {"type": "object",
                    "properties": {"pattern": {"type": "string"}},
                    "required": ["pattern"]}},
];

export const TASK_TOOLS = [
  {"name": "create_task",
   "description": "Create a task and return its runtime-generated ID.",
   "input_schema": {"type": "object",
                    "properties": {
                        "subject": {"type": "string"},
                        "description": {"type": "string"}},
                    "required": ["subject"],
                    "additionalProperties": false}},
  {"name": "update_task",
   "description": "Add dependencies using IDs returned by create_task.",
   "input_schema": {"type": "object",
                    "properties": {
                        "task_id": {"type": "string",
                                    "pattern": "^task_[0-9a-f]{8}$"},
                        "addBlockedBy": {
                            "type": "array",
                            "items": {"type": "string",
                                      "pattern": "^task_[0-9a-f]{8}$"},
                            "minItems": 1}},
                    "required": ["task_id", "addBlockedBy"],
                    "additionalProperties": false}},
  {"name": "list_tasks", "description": "List shared tasks.",
   "input_schema": {"type": "object", "properties": {}}},
  {"name": "get_task", "description": "Get one task by ID.",
   "input_schema": {"type": "object",
                    "properties": {"task_id": {"type": "string"}},
                    "required": ["task_id"]}},
  {"name": "claim_task", "description": "Claim a ready task.",
   "input_schema": {"type": "object",
                    "properties": {"task_id": {"type": "string"}},
                    "required": ["task_id"]}},
  {"name": "complete_task", "description": "Complete an owned task.",
   "input_schema": {"type": "object",
                    "properties": {"task_id": {"type": "string"}},
                    "required": ["task_id"]}},
];

function toolByName(tools: any[], name: string): any {
  const tool = tools.find((item) => item["name"] === name);
  if (!tool) {
    const error = new Error(name);
    error.name = "StopIteration";
    throw error;
  }
  return tool;
}

export const TEAMMATE_TOOLS = [
  ...BASE_TOOLS,
  {"name": "send_message",
   "description": "Send an intermediate message to 'lead' or an active teammate.",
   "input_schema": {"type": "object",
                    "properties": {"to": {"type": "string"},
                                   "content": {"type": "string"}},
                    "required": ["to", "content"]}},
  {"name": "submit_plan",
   "description": "Submit a work plan for Lead approval.",
   "input_schema": {"type": "object",
                    "properties": {"plan": {"type": "string"}},
                    "required": ["plan"]}},
  toolByName(TASK_TOOLS, "list_tasks"),
  toolByName(TASK_TOOLS, "claim_task"),
  toolByName(TASK_TOOLS, "complete_task"),
];

export const TEAM_TOOLS = [
  {"name": "spawn_teammate",
   "description": "Spawn a persistent teammate.",
   "input_schema": {"type": "object",
                    "properties": {
                        "name": {"type": "string",
                                 "pattern": "^[A-Za-z0-9_-]{1,64}$"},
                        "role": {"type": "string"},
                        "prompt": {"type": "string"},
                        "task_id": {"type": "string",
                                    "pattern": "^task_[0-9a-f]{8}$"},
                        "require_plan": {"type": "boolean"}},
                    "required": ["name", "role", "prompt"]}},
  {"name": "list_teammates", "description": "List active teammates.",
   "input_schema": {"type": "object", "properties": {}}},
  {"name": "send_message", "description": "Message a teammate.",
   "input_schema": {"type": "object",
                    "properties": {"to": {"type": "string"},
                                   "content": {"type": "string"}},
                    "required": ["to", "content"]}},
  {"name": "request_shutdown",
   "description": "Ask a teammate to shut down.",
   "input_schema": {"type": "object",
                    "properties": {"teammate": {"type": "string"}},
                    "required": ["teammate"]}},
  {"name": "request_plan",
   "description": "Require a teammate plan before workspace changes.",
   "input_schema": {"type": "object",
                    "properties": {"teammate": {"type": "string"},
                                   "task": {"type": "string"}},
                    "required": ["teammate", "task"]}},
  {"name": "review_plan", "description": "Approve or reject a plan.",
   "input_schema": {"type": "object",
                    "properties": {
                        "request_id": {"type": "string"},
                        "approve": {"type": "boolean"},
                        "feedback": {"type": "string"}},
                    "required": ["request_id", "approve"]}},
  {"name": "create_worktree",
   "description": "Create and bind a task worktree.",
   "input_schema": {
       "type": "object",
       "properties": {
           "name": {"type": "string",
                    "pattern": "^(?!.*\\.\\.)[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
                    "maxLength": 64},
           "task_id": {"type": "string"}},
       "required": ["name", "task_id"],
       "additionalProperties": false}},
];

export const TOOLS = [...BASE_TOOLS, ...TASK_TOOLS, ...TEAM_TOOLS];

export const TOOL_HANDLERS: Record<string, (input: any) => any> = {
  "bash": (input) => run_agent_bash(input.command),
  "read_file": (input) => run_agent_read(input.path, input.limit ?? null),
  "write_file": (input) => run_agent_write(input.path, input.content),
  "edit_file": (input) => run_agent_edit(input.path, input.old_text, input.new_text),
  "glob": (input) => run_agent_glob(input.pattern),
  "create_task": (input) => run_create_task(input.subject, input.description ?? ""),
  "update_task": (input) => run_update_task(input.task_id, input.addBlockedBy),
  "list_tasks": () => run_list_tasks(),
  "get_task": (input) => run_get_task(input.task_id),
  "claim_task": (input) => run_claim_task(input.task_id),
  "complete_task": (input) => run_complete_task(input.task_id),
  "spawn_teammate": (input) => run_spawn_teammate(
    input.name,
    input.role,
    input.prompt,
    input.task_id ?? null,
    input.require_plan ?? false,
  ),
  "list_teammates": () => run_list_teammates(),
  "send_message": (input) => run_send_message(input.to, input.content),
  "request_shutdown": (input) => run_request_shutdown(input.teammate),
  "request_plan": (input) => run_request_plan(input.teammate, input.task),
  "review_plan": (input) => run_review_plan(input.request_id, input.approve, input.feedback ?? ""),
  "create_worktree": (input) => run_create_worktree(input.name, input.task_id),
};

// -- Hooks and Permission Checks --

export const HOOKS: Record<string, Array<(...args: any[]) => any>> = {
  UserPromptSubmit: [],
  PreToolUse: [],
  PostToolUse: [],
  Stop: [],
};
export const DENY_LIST = ["rm -rf /", "sudo", "shutdown", "reboot", "mkfs", "dd if="];
export const DESTRUCTIVE_COMMAND_WORD = /(?:^|[;&|()\n])\s*(?:rm|del)(?=\s|$|[;&|()])/i;
export const DESTRUCTIVE = ["rm ", "> /etc/", "chmod 777"];

export function contains_destructive_command(command: string): boolean {
  return DESTRUCTIVE_COMMAND_WORD.test(command);
}

export function register_hook(event: string, callback: (...args: any[]) => any): void {
  HOOKS[event]!.push(callback);
}

export async function trigger_hooks(
  event: string,
  arg1?: any,
  arg2?: any,
  skip_permission = false,
): Promise<any> {
  const args = arg2 === undefined ? (arg1 === undefined ? [] : [arg1]) : [arg1, arg2];
  for (const callback of HOOKS[event] ?? []) {
    if (skip_permission && callback === permission_hook) continue;
    const result = await callback(...args);
    if (result !== null && result !== undefined) return result;
  }
  return null;
}

export async function check_permission(block: any, prompt_user = true): Promise<string | null> {
  if (block.name === "bash") {
    const command = block.input?.command ?? "";
    for (const pattern of DENY_LIST) {
      if (command.includes(pattern)) {
        return `Permission denied by deny list: ${pattern}`;
      }
    }
    if (contains_destructive_command(command) || DESTRUCTIVE.some((keyword) => command.includes(keyword))) {
      if (!prompt_user) return "Permission required: ask Lead to run this command.";
      console.log(`\n[permission] ${block.name}(${pyRepr(block.input)})`);
      const answer = (await promptLine("Allow? [y/N] ")).trim().toLowerCase();
      if (!["y", "yes"].includes(answer)) return "Permission denied by user";
    }
  }
  if (["read_file", "write_file", "edit_file"].includes(block.name)) {
    const raw_path = block.input?.path ?? "";
    if (!isRelativeTo(resolvePath(path.resolve(WORKDIR, raw_path)), resolvePath(WORKDIR))) {
      if (!prompt_user) return "Permission required: path is outside the workspace.";
      console.log(`\n[permission] ${block.name}(${pyRepr(block.input)})`);
      const answer = (await promptLine("Allow? [y/N] ")).trim().toLowerCase();
      if (!["y", "yes"].includes(answer)) return "Permission denied by user";
    }
  }
  return null;
}

export async function permission_hook(block: any): Promise<string | null> {
  return check_permission(block, true);
}

export function log_hook(block: any): null {
  const preview = pyRepr(Object.values(block.input ?? {}).slice(0, 2)).slice(0, 60);
  console.log(`[hook] ${block.name}(${preview})`);
  return null;
}

export function large_output_hook(block: any, output: any): null {
  if (String(output).length > 100000) {
    console.log(`[hook] Large output from ${block.name}: ${String(output).length} chars`);
  }
  return null;
}

export function context_hook(_query: string): null {
  console.log(`[hook] UserPromptSubmit: working in ${WORKDIR}`);
  return null;
}

export function summary_hook(messages: any[]): null {
  let tool_count = 0;
  for (const message of messages) {
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const block of content) {
      if (isPlainObject(block) && block.type === "tool_result") tool_count += 1;
    }
  }
  console.log(`[hook] Stop: session used ${tool_count} tool calls`);
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
  if (!handler) return `Unknown tool: ${block.name}`;
  let output: string;
  try {
    output = String(handler(block.input));
  } catch (exc) {
    output = `Error: ${errorName(exc)}: ${errorText(exc)}`;
  }
  await trigger_hooks("PostToolUse", block, output);
  return output;
}

// -- Agent Loop --

export async function agent_loop(messages: any[]): Promise<void> {
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
    } catch (exc) {
      messages.push({
        role: "assistant",
        content: [{
          type: "text",
          text: `[Error] ${errorName(exc)}: ${errorText(exc)}`,
        }],
      });
      release_completed_assignment("agent");
      await trigger_hooks("Stop", messages);
      return;
    }
    messages.push({ role: "assistant", content: response.content });
    const tool_calls: any[] = (response.content as any[]).filter((block: any) => block.type === "tool_use");
    if (!tool_calls.length) {
      release_completed_assignment("agent");
      await trigger_hooks("Stop", messages);
      return;
    }
    const results: any[] = [];
    for (const block of tool_calls) {
      console.log(`> ${block.name}`);
      const output = await execute_tool(block);
      console.log(output.slice(0, 300));
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: output,
      });
    }
    messages.push({ role: "user", content: results });
  }
}

export function print_last_assistant_message(history: any[]): void {
  if (!history.length) return;
  const content = history[history.length - 1]?.content ?? [];
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block && typeof block === "object" && block.type === "text"
        && typeof block.text === "string" && !isPlainObject(block)) {
      console.log(block.text);
    } else if (isPlainObject(block) && block.type === "text") {
      console.log(block.text ?? "");
    }
  }
}

let cliReadline: Interface | null = null;

function getReadline(): Interface {
  if (!cliReadline) {
    cliReadline = createInterface({ input: process.stdin, output: process.stdout });
  }
  return cliReadline;
}

function isAbortError(exc: unknown): boolean {
  return exc instanceof Error && (exc.name === "AbortError" || errnoCode(exc) === "ABORT_ERR");
}

function promptLine(prompt: string): Promise<string> {
  const rl = getReadline();
  return new Promise((resolve, reject) => {
    const onClose = () => {
      cleanup();
      const error = new Error("EOF when reading a line");
      error.name = "EOFError";
      reject(error);
    };
    const cleanup = () => rl.off("close", onClose);
    rl.once("close", onClose);
    rl.question(prompt).then(
      (line) => {
        cleanup();
        resolve(line);
      },
      (exc) => {
        cleanup();
        reject(exc);
      },
    );
  });
}

function delay(ms: number): { promise: Promise<void>; cancel: () => void } {
  let timer: NodeJS.Timeout;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

export async function wait_for_cli_event(): Promise<[string, string | null]> {
  const rl = getReadline();
  const prompt: {
    visible: boolean;
    abort: AbortController | null;
    pending: Promise<{ eof: boolean; aborted: boolean; line: string }> | null;
  } = { visible: false, abort: null, pending: null };

  const startQuestion = () => {
    const abort = new AbortController();
    prompt.abort = abort;
    prompt.pending = new Promise((resolve, reject) => {
      const onClose = () => {
        cleanup();
        resolve({ eof: true, aborted: false, line: "" });
      };
      const cleanup = () => rl.off("close", onClose);
      rl.once("close", onClose);
      rl.question("s13 >> ", { signal: abort.signal }).then(
        (line) => {
          cleanup();
          resolve({ eof: false, aborted: false, line });
        },
        (exc) => {
          cleanup();
          if (isAbortError(exc)) resolve({ eof: false, aborted: true, line: "" });
          else reject(exc);
        },
      );
    });
    prompt.visible = true;
  };

  while (true) {
    if (BUS.peek("lead")) {
      if (prompt.visible) {
        prompt.abort?.abort();
        await prompt.pending?.catch(() => undefined);
        console.log();
      }
      return ["wake", null];
    }
    if (!prompt.visible) startQuestion();
    const sleeper = delay(250);
    const winner = await Promise.race([
      prompt.pending!.then((value) => ({ kind: "line" as const, value })),
      sleeper.promise.then(() => ({ kind: "tick" as const, value: null })),
    ]);
    sleeper.cancel();
    if (winner.kind === "tick") continue;
    if (winner.value?.aborted) {
      prompt.visible = false;
      prompt.pending = null;
      continue;
    }
    if (winner.value?.eof) return ["quit", null];
    return ["user", winner.value?.line ?? ""];
  }
}

async function main(): Promise<void> {
  console.log("s13: agent teams");
  console.log("Enter a question, press Enter to send. Type q to quit.\n");
  const history: any[] = [];
  let had_teammates = false;

  while (true) {
    const [kind, payload] = await wait_for_cli_event();
    if (kind === "quit") break;
    if (kind === "user") {
      if (payload === null || ["q", "exit", ""].includes(payload.trim().toLowerCase())) break;
      await trigger_hooks("UserPromptSubmit", payload);
      history.push({ role: "user", content: payload });
    } else {
      const inbox = consume_lead_inbox();
      if (!inbox.length) continue;
      history.push({ role: "user", content: format_team_events(inbox) });
      console.log(`[wake: ${inbox.length} team event(s) -> new turn]`);
    }

    await agent_loop(history);
    print_last_assistant_message(history);

    if (Object.keys(active_teammates).length) {
      had_teammates = true;
    } else if (had_teammates && !BUS.peek("lead")) {
      console.log("[all teammates shut down]");
      had_teammates = false;
    }
    console.log();
  }
  cliReadline?.close();
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  await main();
}
