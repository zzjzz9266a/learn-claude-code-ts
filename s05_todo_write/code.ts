/**
 * s05_todo_write.ts - TodoWrite
 *
 * The model tracks its progress through a TodoManager. After three rounds
 * without an update, the harness adds a reminder alongside the tool results.
 *
 *     +----------+      +-------+      +--------------+
 *     |   User   | ---> |  LLM  | ---> | Tools        |
 *     |  prompt  |      |       |      | + todo_write |
 *     +----------+      +---^---+      +------+-------+
 *                           |                 | update
 *                           |          +------v----------+
 *                           |          | TodoManager     |
 *                           |          | [ ] pending     |
 *                           |          | [>] in progress |
 *                           |          | [x] completed   |
 *                           |          +------+----------+
 *                           | tool_result     |
 *                           +-----------------+
 *
 *               rounds_since_todo >= 3 -> add <reminder>
 *
 * Run: npx tsx s05_todo_write/code.ts
 */

import { spawnSync } from "node:child_process";
import { globSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { pathToFileURL } from "node:url";

import Anthropic from "@anthropic-ai/sdk";
import { config as loadDotenv } from "dotenv";

loadDotenv({ override: true });
if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

export const WORKDIR = process.cwd();
export const client = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL });
const modelId = process.env.MODEL_ID;
if (!modelId) {
  throw new Error("MODEL_ID is required");
}
export const MODEL = modelId;

// s05 change: SYSTEM prompt adds planning guidance
export const ENVIRONMENT_PROMPT =
  process.platform === "win32"
    ? "Windows: the bash tool runs through cmd.exe; use cmd.exe syntax, not Unix " +
      "Bash or PowerShell syntax, and prefer dedicated file tools for file operations"
    : "Unix-like: the bash tool runs the system shell";
export const SYSTEM =
  `You are a coding agent at ${WORKDIR}. Environment: ${ENVIRONMENT_PROMPT}. ` +
  "Before starting any multi-step task, use todo_write to plan your steps. " +
  "Update status as you go.";

let rl: Interface | null = null;

function input(prompt = ""): Promise<string> {
  if (!rl) {
    rl = createInterface({ input: process.stdin, output: process.stdout });
  }
  const reader = rl;
  return new Promise((resolve, reject) => {
    const onClose = () => reject(new Error("EOF"));
    reader.once("close", onClose);
    reader.question(prompt).then(
      (answer) => {
        reader.off("close", onClose);
        resolve(answer);
      },
      (error) => {
        reader.off("close", onClose);
        reject(error);
      },
    );
  });
}

export class ValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValueError";
  }
}

class PyTuple {
  constructor(public items: any[]) {}
}

class PySet {
  constructor(public items: any[]) {}
}

function is_plain_object(value: any): boolean {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}

function is_relative_to(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  if (rel === "") return true;
  if (isAbsolute(rel)) return false;
  return !rel.split(sep).includes("..");
}

function error_text(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function py_repr(value: any): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return Object.is(value, -0) ? "-0.0" : String(value);
  if (typeof value === "string") {
    return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  }
  if (Array.isArray(value)) return `[${value.map(py_repr).join(", ")}]`;
  if (value instanceof PyTuple) {
    const inner = value.items.map(py_repr).join(", ");
    return value.items.length === 1 ? `(${inner},)` : `(${inner})`;
  }
  if (value instanceof PySet) return `{${value.items.map(py_repr).join(", ")}}`;
  if (is_plain_object(value)) {
    const parts = Object.entries(value).map(([key, item]) => `${py_repr(key)}: ${py_repr(item)}`);
    return `{${parts.join(", ")}}`;
  }
  return String(value);
}

function py_str(value: any): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value) || value instanceof PyTuple || value instanceof PySet || is_plain_object(value)) {
    return py_repr(value);
  }
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return Object.is(value, -0) ? "-0.0" : String(value);
  return String(value);
}

function splitlines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r\n|\r|\n|\v|\f|\u001c|\u001d|\u001e|\u0085|\u2028|\u2029/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function param_list(fn: Function): { name: string; required: boolean }[] {
  const src = fn.toString();
  const open = src.indexOf("(");
  if (open < 0) throw new TypeError(`Cannot parse parameters for ${fn.name}`);
  let depth = 0;
  let close = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  const raw = src.slice(open + 1, close).trim();
  if (!raw) return [];
  return raw.split(",").map((part) => {
    const eq = part.indexOf("=");
    const name = (eq === -1 ? part : part.slice(0, eq)).trim();
    return { name, required: eq === -1 };
  });
}

async function call_kwargs(fn: Function, kwargs: any): Promise<any> {
  const params = param_list(fn);
  const known = new Set(params.map((param) => param.name));
  for (const key of Object.keys(kwargs ?? {})) {
    if (!known.has(key)) {
      throw new TypeError(`${fn.name || "function"}() got an unexpected keyword argument '${key}'`);
    }
  }
  for (const param of params) {
    if (param.required && (kwargs == null || !Object.prototype.hasOwnProperty.call(kwargs, param.name))) {
      throw new TypeError(`${fn.name || "function"}() missing 1 required positional argument: '${param.name}'`);
    }
  }
  return await fn(...params.map((param) => kwargs?.[param.name]));
}

class LiteralParser {
  private i = 0;

  constructor(private s: string) {}

  parse(): any {
    const value = this.parse_value();
    this.skip();
    if (!this.eof()) throw new SyntaxError("invalid syntax");
    return value;
  }

  private eof(): boolean {
    return this.i >= this.s.length;
  }

  private peek(): string {
    return this.s[this.i] ?? "";
  }

  private skip(): void {
    while (!this.eof() && /\s/.test(this.peek())) this.i++;
  }

  private expect(ch: string): void {
    if (this.peek() !== ch) throw new SyntaxError("invalid syntax");
    this.i++;
  }

  private parse_value(): any {
    this.skip();
    if (this.eof()) throw new SyntaxError("invalid syntax");
    const c = this.peek();
    if (c === "[") return this.parse_list();
    if (c === "(") return this.parse_paren();
    if (c === "{") return this.parse_brace();
    if (c === "'" || c === '"') return this.parse_joined_string();
    if (c === "+" || c === "-") {
      const sign = c;
      this.i++;
      const num = this.parse_number();
      return sign === "-" ? -num : +num;
    }
    if (c === "." || (c >= "0" && c <= "9")) return this.parse_number();
    return this.parse_ident();
  }

  private parse_list(): any[] {
    this.expect("[");
    const items: any[] = [];
    this.skip();
    if (this.peek() === "]") {
      this.i++;
      return items;
    }
    while (true) {
      items.push(this.parse_value());
      this.skip();
      if (this.peek() === ",") {
        this.i++;
        this.skip();
        if (this.peek() === "]") break;
        continue;
      }
      break;
    }
    this.expect("]");
    return items;
  }

  private parse_paren(): any {
    this.expect("(");
    this.skip();
    if (this.peek() === ")") {
      this.i++;
      return new PyTuple([]);
    }
    const first = this.parse_value();
    this.skip();
    if (this.peek() !== ",") {
      this.expect(")");
      return first;
    }
    const items = [first];
    while (this.peek() === ",") {
      this.i++;
      this.skip();
      if (this.peek() === ")") break;
      items.push(this.parse_value());
      this.skip();
    }
    this.expect(")");
    return new PyTuple(items);
  }

  private parse_brace(): any {
    this.expect("{");
    this.skip();
    if (this.peek() === "}") {
      this.i++;
      return {};
    }
    const first = this.parse_value();
    this.skip();
    if (this.peek() === ":") {
      const obj: Record<string, any> = {};
      const add = (key: any, item: any) => {
        obj[typeof key === "string" ? key : py_str(key)] = item;
      };
      this.i++;
      add(first, this.parse_value());
      this.skip();
      while (this.peek() === ",") {
        this.i++;
        this.skip();
        if (this.peek() === "}") break;
        const key = this.parse_value();
        this.skip();
        this.expect(":");
        add(key, this.parse_value());
        this.skip();
      }
      this.expect("}");
      return obj;
    }
    const items = [first];
    while (this.peek() === ",") {
      this.i++;
      this.skip();
      if (this.peek() === "}") break;
      items.push(this.parse_value());
      this.skip();
    }
    this.expect("}");
    return new PySet(items);
  }

  private parse_joined_string(): string {
    let out = this.parse_string();
    while (true) {
      this.skip();
      if (this.peek() !== "'" && this.peek() !== '"') break;
      out += this.parse_string();
    }
    return out;
  }

  private parse_string(): string {
    const quote = this.peek();
    const triple = this.s.startsWith(quote.repeat(3), this.i);
    this.i += triple ? 3 : 1;
    let out = "";
    while (!this.eof()) {
      if (triple && this.s.startsWith(quote.repeat(3), this.i)) {
        this.i += 3;
        return out;
      }
      if (!triple && this.peek() === quote) {
        this.i++;
        return out;
      }
      if (!triple && (this.peek() === "\n" || this.peek() === "\r")) {
        throw new SyntaxError("unterminated string");
      }
      if (this.peek() === "\\") {
        out += this.parse_escape();
        continue;
      }
      out += this.peek();
      this.i++;
    }
    throw new SyntaxError("unterminated string");
  }

  private parse_escape(): string {
    this.i++;
    if (this.eof()) throw new SyntaxError("unterminated string");
    const ch = this.peek();
    const simple: Record<string, string> = {
      n: "\n",
      r: "\r",
      t: "\t",
      b: "\b",
      f: "\f",
      v: "\v",
      a: "\u0007",
      "\\": "\\",
      "'": "'",
      '"': '"',
      "\n": "",
    };
    if (ch === "\r") {
      this.i++;
      if (this.peek() === "\n") this.i++;
      return "";
    }
    if (Object.prototype.hasOwnProperty.call(simple, ch)) {
      this.i++;
      return simple[ch];
    }
    if (ch === "x") {
      const hex = this.s.slice(this.i + 1, this.i + 3);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new SyntaxError("invalid syntax");
      this.i += 3;
      return String.fromCharCode(parseInt(hex, 16));
    }
    if (ch === "u" || ch === "U") {
      const size = ch === "u" ? 4 : 8;
      const hex = this.s.slice(this.i + 1, this.i + 1 + size);
      if (!new RegExp(`^[0-9a-fA-F]{${size}}$`).test(hex)) throw new SyntaxError("invalid syntax");
      this.i += 1 + size;
      return String.fromCodePoint(parseInt(hex, 16));
    }
    if (ch >= "0" && ch <= "7") {
      let oct = "";
      while (oct.length < 3 && this.i < this.s.length && this.s[this.i] >= "0" && this.s[this.i] <= "7") {
        oct += this.s[this.i];
        this.i++;
      }
      return String.fromCharCode(parseInt(oct, 8));
    }
    this.i++;
    return `\\${ch}`;
  }

  private parse_number(): number {
    const start = this.i;
    if (this.peek() === "+" || this.peek() === "-") this.i++;
    const rest = this.s.slice(this.i);
    const match = /^(?:0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d[\d_]*)?|\.\d[\d_]*(?:[eE][+-]?\d[\d_]*)?)/.exec(rest);
    if (!match) throw new SyntaxError("invalid syntax");
    this.i += match[0].length;
    const token = this.s.slice(start, this.i).replace(/_/g, "");
    if (/^0[xX]/.test(token)) return parseInt(token.slice(2), 16);
    if (/^0[oO]/.test(token)) return parseInt(token.slice(2), 8);
    if (/^0[bB]/.test(token)) return parseInt(token.slice(2), 2);
    if (/^-?0[xX]/.test(token)) return parseInt(token.replace(/^(-?)0[xX]/, "$1"), 16);
    return Number(token);
  }

  private parse_ident(): any {
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.s.slice(this.i));
    if (!match) throw new SyntaxError("invalid syntax");
    this.i += match[0].length;
    if (match[0] === "True") return true;
    if (match[0] === "False") return false;
    if (match[0] === "None") return null;
    throw new ValueError("malformed node or string");
  }
}

function literal_eval(source: string): any {
  return new LiteralParser(source).parse();
}

function dict_get(todo: any, key: string, fallback: any): any {
  if (todo !== null && typeof todo === "object" && Object.prototype.hasOwnProperty.call(todo, key)) {
    return todo[key];
  }
  return fallback;
}

// -- Tool implementations from s02-s04 --

export function run_bash(command: string): string {
  const r = spawnSync(command, {
    shell: true,
    cwd: WORKDIR,
    encoding: "utf8",
    timeout: 120000,
  });
  if (r.error) {
    if ((r.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      return "Error: Timeout (120s)";
    }
    throw r.error;
  }
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  return out ? out.slice(0, 50000) : "(no output)";
}

export function run_read(path: string, limit: number | null = null): string {
  try {
    const lines = splitlines(readFileSync(resolve(WORKDIR, path), "utf8"));
    if (limit && limit < lines.length) {
      lines.splice(limit, lines.length, `... (${lines.length - limit} more lines)`);
    }
    return lines.join("\n");
  } catch (e) {
    return `Error: ${error_text(e)}`;
  }
}

export function run_write(path: string, content: string): string {
  try {
    const file_path = resolve(WORKDIR, path);
    mkdirSync(dirname(file_path), { recursive: true });
    writeFileSync(file_path, content, "utf8");
    return `Wrote ${content.length} bytes to ${path}`;
  } catch (e) {
    return `Error: ${error_text(e)}`;
  }
}

export function run_edit(path: string, old_text: string, new_text: string): string {
  try {
    const file_path = resolve(WORKDIR, path);
    const text = readFileSync(file_path, "utf8");
    if (!text.includes(old_text)) {
      return `Error: text not found in ${path}`;
    }
    writeFileSync(file_path, text.replace(old_text, () => new_text), "utf8");
    return `Edited ${path}`;
  } catch (e) {
    return `Error: ${error_text(e)}`;
  }
}

export function run_glob(pattern: string): string {
  try {
    const matches = [...new Set(
      globSync(pattern, { cwd: WORKDIR }).filter((match) => is_relative_to(WORKDIR, resolve(WORKDIR, match))),
    )].sort();
    const shown = matches.slice(0, 200);
    if (matches.length > 200) {
      shown.push("... (more matches omitted; narrow the pattern)");
    }
    return shown.length ? shown.join("\n") : "(no matches)";
  } catch (e) {
    return `Error: ${error_text(e)}`;
  }
}

// -- New in s05: structured state the model updates --

export class TodoManager {
  items: any[] = [];

  update(todos: any): string {
    if (typeof todos === "string") {
      try {
        todos = JSON.parse(todos);
      } catch {
        try {
          todos = literal_eval(todos);
        } catch {
          throw new ValueError("todos must be a list or JSON array string");
        }
      }
    }

    if (!Array.isArray(todos)) {
      throw new ValueError("todos must be a list");
    }
    if (todos.length > 20) {
      throw new ValueError("Max 20 todos allowed");
    }

    const validated: any[] = [];
    let in_progress_count = 0;
    for (let index = 0; index < todos.length; index++) {
      const todo = todos[index];
      if (!is_plain_object(todo)) {
        throw new ValueError(`todos[${index}] must be an object`);
      }

      const content = py_str(dict_get(todo, "content", "")).trim();
      const status = py_str(dict_get(todo, "status", "pending")).toLowerCase();
      if (!content) {
        throw new ValueError(`todos[${index}] requires content`);
      }
      if (!["pending", "in_progress", "completed"].includes(status)) {
        throw new ValueError(`todos[${index}] has invalid status '${status}'`);
      }
      if (status === "in_progress") {
        in_progress_count += 1;
      }
      validated.push({ content, status });
    }

    if (in_progress_count > 1) {
      throw new ValueError("Only one todo can be in_progress at a time");
    }

    this.items = validated;
    return this.render();
  }

  render(): string {
    if (this.items.length === 0) {
      return "No todos.";
    }

    const lines: string[] = [];
    for (const todo of this.items) {
      const marker = {
        pending: "[ ]",
        in_progress: "[>]",
        completed: "[x]",
      }[todo["status"] as string];
      lines.push(`${marker} ${todo["content"]}`);
    }

    const done = this.items.filter((todo) => todo["status"] === "completed").length;
    lines.push(`\n(${done}/${this.items.length} completed)`);
    return lines.join("\n");
  }
}

export const TODO = new TodoManager();

export function run_todo_write(todos: any): string {
  let output: string;
  try {
    output = TODO.update(todos);
  } catch (e) {
    if (e instanceof ValueError) return `Error: ${e.message}`;
    throw e;
  }
  console.log(`\n\x1b[33m## Current Tasks\x1b[0m\n${output}`);
  return output;
}

export const TOOLS: any[] = [
  {"name": "bash", "description": "Run a shell command.",
   "input_schema": {"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]}},
  {"name": "read_file", "description": "Read file contents.",
   "input_schema": {"type": "object", "properties": {"path": {"type": "string"}, "limit": {"type": "integer"}}, "required": ["path"]}},
  {"name": "write_file", "description": "Write content to a file.",
   "input_schema": {"type": "object", "properties": {"path": {"type": "string"}, "content": {"type": "string"}}, "required": ["path", "content"]}},
  {"name": "edit_file", "description": "Replace exact text in a file once.",
   "input_schema": {"type": "object", "properties": {"path": {"type": "string"}, "old_text": {"type": "string"}, "new_text": {"type": "string"}}, "required": ["path", "old_text", "new_text"]}},
  {"name": "glob", "description": "Find files matching a glob pattern; ** matches recursively.",
   "input_schema": {"type": "object", "properties": {"pattern": {"type": "string"}}, "required": ["pattern"]}},
  // s05: new tool
  {"name": "todo_write", "description": "Create and manage a task list for your current coding session.",
   "input_schema": {"type": "object", "properties": {"todos": {"type": "array", "maxItems": 20, "items": {"type": "object", "properties": {"content": {"type": "string", "minLength": 1}, "status": {"type": "string", "enum": ["pending", "in_progress", "completed"]}}, "required": ["content", "status"]}}}, "required": ["todos"]}},
];

export const TOOL_HANDLERS: Record<string, Function> = {
  "bash": run_bash, "read_file": run_read, "write_file": run_write,
  "edit_file": run_edit, "glob": run_glob, "todo_write": run_todo_write,
};

// -- Hook system from s04 --

export const HOOKS: Record<string, Function[]> = {"UserPromptSubmit": [], "PreToolUse": [], "PostToolUse": [], "Stop": []};

export function register_hook(event: string, callback: Function): void {
  HOOKS[event].push(callback);
}

export async function trigger_hooks(event: string, ...args: any[]): Promise<any> {
  for (const callback of HOOKS[event]) {
    const result = await callback(...args);
    if (result != null) {
      return result;
    }
  }
  return null;
}

export const DENY_LIST = ["rm -rf /", "sudo", "shutdown", "reboot", "mkfs", "dd if="];
export const DESTRUCTIVE_COMMAND_WORD = /(?:^|[;&|()\n])\s*(?:rm|del)(?=\s|$|[;&|()])/i;
export const DESTRUCTIVE = ["rm ", "> /etc/", "chmod 777"];

export function contains_destructive_command(command: string): boolean {
  return DESTRUCTIVE_COMMAND_WORD.test(command);
}

export async function permission_hook(block: any): Promise<string | null> {
  /** PreToolUse: s03 permission logic, registered as an s04 hook. */
  if (block.name === "bash") {
    const command = block.input?.command ?? "";
    for (const pattern of DENY_LIST) {
      if (String(command).includes(pattern)) {
        console.log(`\n\x1b[31m[blocked] '${pattern}'\x1b[0m`);
        return "Permission denied by deny list";
      }
    }
    if (contains_destructive_command(String(command)) || DESTRUCTIVE.some((keyword) => String(command).includes(keyword))) {
      console.log(`\n\x1b[33m[permission] Potentially destructive command\x1b[0m`);
      console.log(`   Tool: ${block.name}(${py_repr(block.input)})`);
      const choice = (await input("   Allow? [y/N] ")).trim().toLowerCase();
      if (choice !== "y" && choice !== "yes") {
        return "Permission denied by user";
      }
    }
  }
  if (["read_file", "write_file", "edit_file"].includes(block.name)) {
    const path = block.input?.path ?? "";
    if (!is_relative_to(WORKDIR, resolve(WORKDIR, path))) {
      console.log(`\n\x1b[33m[permission] Access outside workspace\x1b[0m`);
      console.log(`   Tool: ${block.name}(${py_repr(block.input)})`);
      const choice = (await input("   Allow? [y/N] ")).trim().toLowerCase();
      if (choice !== "y" && choice !== "yes") {
        return "Permission denied by user";
      }
    }
  }
  return null;
}

export function log_hook(block: any): null {
  /** PreToolUse: log every tool call. */
  const args_preview = py_repr(Object.values(block.input ?? {}).slice(0, 2)).slice(0, 60);
  console.log(`\x1b[90m[HOOK] ${block.name}(${args_preview})\x1b[0m`);
  return null;
}

export function large_output_hook(block: any, output: any): null {
  /** PostToolUse: warn on large output. */
  const text = py_str(output);
  if (text.length > 100000) {
    console.log(`\x1b[33m[HOOK] Large output from ${block.name}: ${text.length} chars\x1b[0m`);
  }
  return null;
}

export function context_inject_hook(query: string): null {
  /** UserPromptSubmit: log working directory. */
  console.log(`\x1b[90m[HOOK] UserPromptSubmit: working in ${WORKDIR}\x1b[0m`);
  return null;
}

export function summary_hook(messages: any[]): null {
  /** Stop: print tool call count. */
  let tool_count = 0;
  for (const m of messages) {
    const content = Array.isArray(m?.content) ? m.content : [];
    for (const b of content) {
      if (is_plain_object(b) && b.type === "tool_result") tool_count += 1;
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

// -- Agent loop with the reminder counter --

export async function agent_loop(messages: any[]): Promise<void> {
  let rounds_since_todo = 0;
  while (true) {
    const response = await client.messages.create({
      model: MODEL, system: SYSTEM, messages: messages,
      tools: TOOLS, max_tokens: 8000,
    });
    messages.push({"role": "assistant", "content": response.content});

    const tool_calls = (response.content as any[]).filter((block) => block.type === "tool_use");
    if (tool_calls.length === 0) {
      const force = await trigger_hooks("Stop", messages);
      if (force) {
        messages.push({"role": "user", "content": force});
        continue;
      }
      return;
    }

    const results: any[] = [];
    let used_todo = false;
    for (const block of tool_calls) {
      const blocked = await trigger_hooks("PreToolUse", block);
      if (blocked) {
        results.push({"type": "tool_result", "tool_use_id": block.id,
                      "content": String(blocked)});
        continue;
      }

      const handler = TOOL_HANDLERS[block.name];
      let output: any;
      try {
        output = handler ? await call_kwargs(handler, block.input ?? {}) : `Unknown: ${block.name}`;
      } catch (e) {
        output = `Error: ${error_text(e)}`;
      }

      await trigger_hooks("PostToolUse", block, output);

      if (block.name === "todo_write") {
        used_todo = true;
      }

      results.push({"type": "tool_result", "tool_use_id": block.id,
                    "content": String(output)});
    }

    rounds_since_todo = used_todo ? 0 : rounds_since_todo + 1;
    if (rounds_since_todo >= 3) {
      results.push({"type": "text",
                    "text": "<reminder>Update your todos.</reminder>"});
      rounds_since_todo = 0;
    }

    messages.push({"role": "user", "content": results});
  }
}

export async function main(): Promise<void> {
  console.log("s05: TodoWrite - plan before execution");
  console.log("Enter a question, press Enter to send. Type q to quit.\n");

  const history: any[] = [];
  while (true) {
    let query: string;
    try {
      // Visible ANSI prompt. node:readline does not use zero-width markers.
      query = await input("\x1b[36ms05 >> \x1b[0m");
    } catch {
      break;
    }
    if (["q", "exit", ""].includes(query.trim().toLowerCase())) {
      break;
    }
    await trigger_hooks("UserPromptSubmit", query);
    history.push({"role": "user", "content": query});
    await agent_loop(history);
    for (const block of history[history.length - 1]["content"]) {
      if (block?.type === "text") {
        console.log(block.text);
      }
    }
    console.log();
  }
  rl?.close();
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  await main();
}
