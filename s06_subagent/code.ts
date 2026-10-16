/**
 * s06_subagent.ts - Subagents
 *
 * The task tool runs a second agent loop with a fresh message list. Both
 * loops share the working directory, but only the final text returns to
 * the parent conversation.
 *
 *     Parent agent                    Subagent
 *     +------------------+            +------------------+
 *     | messages=[...]   |            | messages=[prompt]|
 *     |                  |   task     |                  |
 *     | tool: task       | ---------> | own agent loop   |
 *     |                  |            | base tools only  |
 *     | tool_result      | <--------- | final text       |
 *     +------------------+            +------------------+
 *
 * The subagent has no task tool, so it cannot delegate again.
 *
 * Run: npx tsx s06_subagent/code.ts
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

export const ENVIRONMENT_PROMPT =
  process.platform === "win32"
    ? "Windows: the bash tool runs through cmd.exe; use cmd.exe syntax, not Unix " +
      "Bash or PowerShell syntax, and prefer dedicated file tools for file operations"
    : "Unix-like: the bash tool runs the system shell";
export const SYSTEM =
  `You are a coding agent at ${WORKDIR}. Environment: ${ENVIRONMENT_PROMPT}. ` +
  "Use task for focused exploration or a self-contained subtask.";
export const SUB_SYSTEM =
  `You are a coding agent at ${WORKDIR}. Environment: ${ENVIRONMENT_PROMPT}. ` +
  "Complete the given task, then return a concise final answer.";

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
  if (is_plain_object(value)) {
    const parts = Object.entries(value).map(([key, item]) => `${py_repr(key)}: ${py_repr(item)}`);
    return `{${parts.join(", ")}}`;
  }
  return String(value);
}

function py_str(value: any): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value) || is_plain_object(value)) return py_repr(value);
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

// -- Base tools --

export function run_bash(command: string): string {
  const result = spawnSync(command, {
    shell: true,
    cwd: WORKDIR,
    encoding: "utf8",
    timeout: 120000,
  });
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      return "Error: Timeout (120s)";
    }
    throw result.error;
  }
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return output ? output.slice(0, 50000) : "(no output)";
}

export function run_read(path: string, limit: number | null = null): string {
  try {
    const lines = splitlines(readFileSync(resolve(WORKDIR, path), "utf8"));
    if (limit && limit < lines.length) {
      const omitted = lines.length - limit;
      lines.splice(limit, lines.length, `... (${omitted} more lines)`);
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

export const BASE_TOOLS: any[] = [
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
];

export const BASE_HANDLERS: Record<string, Function> = {
  "bash": run_bash,
  "read_file": run_read,
  "write_file": run_write,
  "edit_file": run_edit,
  "glob": run_glob,
};

// -- Hooks --

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
  /** PreToolUse: block denied operations and ask about risky ones. */
  if (block.name === "bash") {
    const command = block.input?.command ?? "";
    for (const pattern of DENY_LIST) {
      if (String(command).includes(pattern)) {
        console.log(`\n\x1b[31m[blocked] '${pattern}'\x1b[0m`);
        return "Permission denied by deny list";
      }
    }
    if (contains_destructive_command(String(command)) || DESTRUCTIVE.some((keyword) => String(command).includes(keyword))) {
      console.log("\n\x1b[33m[permission] Potentially destructive command\x1b[0m");
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
      console.log("\n\x1b[33m[permission] Access outside workspace\x1b[0m");
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
  /** UserPromptSubmit: log the working directory. */
  console.log(`\x1b[90m[HOOK] UserPromptSubmit: working in ${WORKDIR}\x1b[0m`);
  return null;
}

export function summary_hook(messages: any[]): null {
  /** Stop: print the number of tool results in this message list. */
  let tool_count = 0;
  for (const message of messages) {
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const block of content) {
      if (is_plain_object(block) && block.type === "tool_result") tool_count += 1;
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

export async function execute_tool(block: any, handlers: Record<string, Function>): Promise<string> {
  const blocked = await trigger_hooks("PreToolUse", block);
  if (blocked) {
    return String(blocked);
  }

  const handler = handlers[block.name];
  let output: any;
  try {
    output = handler ? await call_kwargs(handler, block.input ?? {}) : `Unknown: ${block.name}`;
  } catch (e) {
    output = `Error: ${error_text(e)}`;
  }

  await trigger_hooks("PostToolUse", block, output);
  return String(output);
}

// -- New in s06: a nested agent loop with fresh messages --

export const SUB_TOOLS = [...BASE_TOOLS];
export const SUB_HANDLERS = { ...BASE_HANDLERS };

export function extract_text(content: any): string {
  if (!Array.isArray(content)) {
    return py_str(content);
  }
  return content
    .filter((block) => (block?.type ?? null) === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

export async function run_subagent(prompt: string): Promise<string> {
  console.log("\n\x1b[35m[Subagent started]\x1b[0m");
  const messages: any[] = [{"role": "user", "content": prompt}];

  for (let _ = 0; _ < 30; _++) {
    const response = await client.messages.create({
      model: MODEL,
      system: SUB_SYSTEM,
      messages: messages,
      tools: SUB_TOOLS,
      max_tokens: 8000,
    });
    messages.push({"role": "assistant", "content": response.content});

    const tool_calls = (response.content as any[]).filter((block) => block.type === "tool_use");
    if (tool_calls.length === 0) {
      const force = await trigger_hooks("Stop", messages);
      if (force) {
        messages.push({"role": "user", "content": force});
        continue;
      }
      console.log("\x1b[35m[Subagent done]\x1b[0m");
      return extract_text(response.content) || "(no summary)";
    }

    const results: any[] = [];
    for (const block of tool_calls) {
      const output = await execute_tool(block, SUB_HANDLERS);
      console.log(`  \x1b[90m[sub] ${block.name}: ${output.slice(0, 100)}\x1b[0m`);
      results.push({
        "type": "tool_result",
        "tool_use_id": block.id,
        "content": output,
      });
    }
    messages.push({"role": "user", "content": results});
  }

  console.log("\x1b[35m[Subagent stopped]\x1b[0m");
  return "Subagent stopped after 30 turns without a final answer.";
}

export const TASK_TOOL = {
  "name": "task",
  "description": "Run a subagent with fresh conversation context and return its final text.",
  "input_schema": {
    "type": "object",
    "properties": {"prompt": {"type": "string", "minLength": 1}},
    "required": ["prompt"],
  },
};

export const TOOLS = [...BASE_TOOLS, TASK_TOOL];
export const TOOL_HANDLERS: Record<string, Function> = { ...BASE_HANDLERS, "task": run_subagent };

// -- Parent agent loop --

export async function agent_loop(messages: any[]): Promise<void> {
  while (true) {
    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages: messages,
      tools: TOOLS,
      max_tokens: 8000,
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
    for (const block of tool_calls) {
      const output = await execute_tool(block, TOOL_HANDLERS);
      results.push({
        "type": "tool_result",
        "tool_use_id": block.id,
        "content": output,
      });
    }
    messages.push({"role": "user", "content": results});
  }
}

export async function main(): Promise<void> {
  console.log("s06: Subagent - fresh messages, final text returns");
  console.log("Enter a question, press Enter to send. Type q to quit.\n");

  const history: any[] = [];
  while (true) {
    let query: string;
    try {
      // Visible ANSI prompt. node:readline does not use zero-width markers.
      query = await input("\x1b[36ms06 >> \x1b[0m");
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
